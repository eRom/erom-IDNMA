// Extension idnma pour Pi, passée par `pi -e <ce fichier>` quand `idnma run` lance Pi sous sa doublure.
// Elle rejoint le pont de la doublure (socket Unix, une trame JSON par ligne, protocole de
// `../bridge/protocol.ts`), remet chaque message de pair à Pi (`pi.sendMessage`, en `followUp` ou en
// `steer`) et rapporte ce qu'il en advient. Sans `IDNMA_PI_BRIDGE` et son jeton, elle ne fait rien.
// Spec : docs/superpowers/specs/2026-11-07-idnma-pi-design.md (§1 faits sondés, §2 décisions).
// Pi la charge par jiti : elle n'importe que `node:` et le protocole, et ne lève jamais vers Pi.
import { readFileSync, realpathSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { BRIDGE_PROTOCOL_VERSION, createLineReader, encodeFrame, parseCourierFrame } from "../bridge/protocol.ts";
import type { DeliverFrame, DeliveryMode, DroppedReason, PluginFrame, ResultFrame } from "../bridge/protocol.ts";

/** Type des messages custom que l'extension dépose dans la session (rendus `[idnma]` par Pi). */
export const PEER_MESSAGE_TYPE = "idnma";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

// Les formes ci-dessous ne décrivent que ce que l'extension lit de Pi 1.5.0 (sonde du 07/11).
interface PiMessage {
  role?: unknown;
  customType?: unknown;
  details?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

export interface PiContext {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sessionManager: { getSessionId(): string };
}

export interface PiPeerMessage {
  customType: string;
  content: string;
  display: boolean;
  details: { id: string; sender: string };
}

export interface PiApi {
  on(event: string, handler: (event: any, ctx: PiContext) => unknown): unknown;
  sendMessage(message: PiPeerMessage, options: { deliverAs: "steer" | "followUp"; triggerTurn: boolean }): void;
}

export interface PiBridgeConfig {
  /** Environnement lu pour le pont et son jeton (défaut `process.env`). */
  env?: Record<string, string | undefined>;
  /** Pid annoncé dans `hello` (défaut `process.pid`). */
  pid?: number;
  /** Version de Pi annoncée dans `hello` (défaut : lue au mieux dans le paquet de Pi). */
  version?: string;
}

type Owner = "peer" | "user" | "unknown";

/** Un message livré par nous, suivi jusqu'à sa réclamation ou sa perte. */
interface Delivery {
  mode: DeliveryMode;
  claimed: boolean;
}

/**
 * Un segment de conversation (spec §2, D5) : de la réclamation du message qui ouvre un tour (le nôtre
 * en followUp, ou une entrée de l'utilisateur) jusqu'au segment suivant ou au repos de Pi. Les followUp
 * restent dans le même run que le tour d'avant (F6) : un run ne délimite pas un tour.
 */
interface Segment {
  turn: number;
  owner: Owner;
  /** Id du followUp des nôtres dont la réponse revient à l'expéditeur. */
  trackedId?: string;
  mixed: boolean;
  /** Rôles des entrées étrangères réclamées pendant le segment. */
  sources: Set<string>;
  /** Dernier message assistant du segment. */
  last?: { stopReason: string; text: string; error?: string };
}

// Entrées de l'utilisateur : liste fermée (F9). Les messages custom d'autres extensions et les résumés
// (compaction, branche) n'en sont pas : ils ne mêlent pas le tour.
const USER_ROLES: ReadonlySet<string> = new Set(["user", "bashExecution"]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

/** Texte d'une exception, sans jamais lever (un objet jeté peut avoir un `toString` qui lève). */
const describeError = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "erreur inconnue";
  }
};

/** Texte visible d'un message : ses blocs `text`, sans la réflexion ni les appels d'outils. */
const textOf = (message: PiMessage): string => {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
};

/** Un message assistant qui n'appelle plus d'outil : la réponse du segment est complète (F6). */
const isFinal = (segment: Segment): boolean => segment.last !== undefined && segment.last.stopReason !== "toolUse" && segment.last.stopReason !== "pending";

/** Version de Pi, au mieux : remonte depuis `process.argv[1]` jusqu'au `package.json` du paquet de Pi. */
function readPiVersion(): string | undefined {
  try {
    const entry = process.argv[1];
    if (entry === undefined) return undefined;
    let dir = dirname(realpathSync(entry));
    for (let depth = 0; depth < 16; depth += 1) {
      try {
        const manifest = asRecord(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
        if (manifest?.name === PI_PACKAGE) return typeof manifest.version === "string" ? manifest.version : undefined;
      } catch {
        // pas de package.json lisible ici : on remonte
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // meilleur effort : la version est facultative dans `hello`
  }
  return undefined;
}

/** Branche l'extension sur `pi` ; inerte sans pont dans l'environnement. */
export function createPiBridge(pi: PiApi, config: PiBridgeConfig = {}): void {
  const env = config.env ?? process.env;
  const bridgePath = env.IDNMA_PI_BRIDGE;
  const bridgeToken = env.IDNMA_PI_BRIDGE_TOKEN;
  if (!bridgePath || !bridgeToken) return;
  const pid = config.pid ?? process.pid;

  let socket: Socket | undefined;
  let closed = false;
  let ctx: PiContext | undefined;

  const writeFrame = (frame: PluginFrame): void => {
    if (closed || socket === undefined || socket.destroyed) return;
    try {
      socket.write(encodeFrame(frame));
    } catch {
      // l'écouteur `error` du socket couvre les échecs asynchrones
    }
  };
  // Pendant `sendMessage`, Pi peut émettre des événements de façon synchrone (`before_agent_start`, F5) :
  // leurs trames attendent ici, pour que `delivered` parte toujours en premier.
  let held: PluginFrame[] | undefined;
  const send = (frame: PluginFrame): void => {
    if (held !== undefined) held.push(frame);
    else writeFrame(frame);
  };
  // Code fixe, jamais le message d'une exception : il pourrait citer une entrée (texte de pair).
  const sendError = (code: string): void => send({ type: "error", code });

  // --- État de Pi ------------------------------------------------------------------------------

  let lastState: { session: string; status: "idle" | "running" } | undefined;
  const sessionOf = (context: PiContext): string => String(context.sessionManager.getSessionId());

  /** Publie `state` s'il a changé (ou si `force`). */
  const publishState = (context: PiContext, force = false): void => {
    const session = sessionOf(context);
    const status = context.isIdle() ? "idle" : "running";
    if (!force && lastState !== undefined && lastState.session === session && lastState.status === status) return;
    lastState = { session, status };
    send({ type: "state", session, status });
  };

  // --- Messages et segments --------------------------------------------------------------------

  const deliveries = new Map<string, Delivery>();
  let segment: Segment | undefined;
  let turns = 0;

  const openSegment = (owner: Owner, trackedId?: string): Segment => {
    turns += 1;
    segment = { turn: turns, owner, mixed: false, sources: new Set(), ...(trackedId === undefined ? {} : { trackedId }) };
    return segment;
  };

  /** Si le segment suivait un followUp des nôtres, envoie son `result` (spec §2, D5) et clôt son suivi. */
  const reportSegment = (closing: Segment, aborted: boolean): void => {
    if (closing.trackedId === undefined) return;
    const last = closing.last;
    let reason: string;
    let cause: string | undefined;
    if (aborted) {
      reason = "aborted";
      cause = "user";
    } else {
      switch (last?.stopReason) {
        case "stop":
          reason = "completed";
          break;
        case "length":
          reason = "max-tokens";
          break;
        case "error":
          reason = "error";
          break;
        case "aborted":
          reason = "aborted";
          cause = "user";
          break;
        default:
          reason = "interrupted";
      }
    }
    const frame: ResultFrame = { type: "result", id: closing.trackedId, turn: closing.turn, reason, mixed: closing.mixed, sources: [...closing.sources] };
    if (cause !== undefined) frame.cause = cause;
    if (last !== undefined && last.text.trim() !== "") frame.text = last.text;
    if (reason === "error" && last?.error !== undefined) frame.error = { message: last.error };
    deliveries.delete(closing.trackedId);
    send(frame);
  };

  const closeSegment = (aborted: boolean): void => {
    const closing = segment;
    segment = undefined;
    if (closing !== undefined) reportSegment(closing, aborted);
  };

  /** Chaque message des nôtres jamais réclamé est rendu à la doublure avec `why`. */
  const dropUnclaimed = (why: DroppedReason): void => {
    for (const [id, delivery] of deliveries) {
      if (delivery.claimed) continue;
      deliveries.delete(id);
      send({ type: "dropped", id, why });
    }
  };

  /** Mode de livraison (spec §2, D4) : au repos ou après une réponse complète, un tour à la suite. */
  const chooseMode = (context: PiContext, priority: DeliverFrame["priority"]): DeliveryMode => {
    if (context.isIdle() || segment === undefined || isFinal(segment)) return "followup";
    if (segment.owner === "peer") return priority === "now" ? "steer" : "followup";
    return priority === "later" ? "followup" : "steer";
  };

  const handleDeliver = (frame: DeliverFrame): void => {
    const context = ctx;
    if (context === undefined) {
      send({ type: "dropped", id: frame.id, why: "no-agent" });
      return;
    }
    const mode = chooseMode(context, frame.priority);
    const text = mode === "steer" && frame.hint !== undefined ? `${frame.text}\n${frame.hint}` : frame.text;
    deliveries.set(frame.id, { mode, claimed: false });
    held = [];
    let failure: { error: unknown } | undefined;
    try {
      pi.sendMessage(
        { customType: PEER_MESSAGE_TYPE, content: `Team message from ${frame.sender}:\n${text}`, display: true, details: { id: frame.id, sender: frame.sender } },
        { deliverAs: mode === "steer" ? "steer" : "followUp", triggerTurn: true },
      );
    } catch (error) {
      failure = { error };
    }
    const queued = held;
    held = undefined;
    if (failure === undefined) {
      send({ type: "delivered", id: frame.id, mode, session: sessionOf(context) });
    } else {
      deliveries.delete(frame.id);
      send({ type: "dropped", id: frame.id, why: "rejected", error: describeError(failure.error) });
    }
    for (const queuedFrame of queued) send(queuedFrame);
  };

  /** Un message entre dans le contexte de Pi : réclamation des nôtres, frontière ou mélange de segment. */
  const onMessageStart = (message: PiMessage | undefined): void => {
    if (message === undefined) return;
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "custom" && message.customType === PEER_MESSAGE_TYPE) {
      const id = asRecord(message.details)?.id;
      const delivery = typeof id === "string" ? deliveries.get(id) : undefined;
      if (delivery === undefined || typeof id !== "string") return; // message d'une autre instance de l'extension
      delivery.claimed = true;
      if (delivery.mode === "followup" || segment === undefined || isFinal(segment)) {
        closeSegment(false);
        openSegment("peer", delivery.mode === "followup" ? id : undefined);
      }
      send({ type: "claimed", id, turn: segment!.turn });
      if (delivery.mode === "steer") deliveries.delete(id); // réglé : le rappel de réponse passe par `idnma peer send`
      return;
    }
    if (!USER_ROLES.has(role)) return;
    if (segment === undefined || isFinal(segment)) {
      closeSegment(false);
      openSegment("user");
      return;
    }
    segment.sources.add(role);
    if (segment.owner === "peer") segment.mixed = true;
  };

  const onMessageEnd = (message: PiMessage | undefined): void => {
    if (message?.role !== "assistant" || segment === undefined) return;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
    segment.last = { stopReason, text: textOf(message), ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}) };
  };

  /** Pi au repos (F7) : fin du segment, puis ce qu'Échap a jeté sans le dire (F8). */
  const onSettled = (event: { aborted?: unknown }, context: PiContext): void => {
    const aborted = event.aborted === true;
    closeSegment(aborted);
    if (!context.hasPendingMessages()) dropUnclaimed(aborted ? "discarded" : "no-agent");
    publishState(context, true);
  };

  /** Fin du runtime (`/new`, `/resume`, `/fork`, `/reload`, sortie) : tout ce qui est suivi est rendu (D6). */
  const onShutdown = (): void => {
    const closing = segment;
    segment = undefined;
    if (closing?.trackedId !== undefined) {
      deliveries.delete(closing.trackedId);
      send({ type: "result", id: closing.trackedId, turn: closing.turn, reason: "disposed", mixed: closing.mixed, sources: [...closing.sources] });
    }
    dropUnclaimed("disposed");
    closed = true;
    socket?.end();
  };

  // --- Pont et cycle de vie --------------------------------------------------------------------

  const onLine = (line: string): void => {
    try {
      const frame = parseCourierFrame(line);
      if (frame === undefined) {
        sendError("bad-frame");
        return;
      }
      handleDeliver(frame);
    } catch {
      sendError("listener-failed");
    }
  };

  const connect = (context: PiContext): void => {
    if (socket !== undefined) return;
    try {
      // Écouteur `error` posé dans l'instruction qui crée le socket : un `error` sans écouteur ferait tomber Pi.
      socket = createConnection(bridgePath).on("error", () => {
        closed = true;
      });
    } catch {
      closed = true;
      return;
    }
    socket.unref();
    socket.on("close", () => {
      closed = true;
    });
    const reader = createLineReader(onLine, () => socket?.destroy());
    socket.on("data", (chunk: Buffer) => {
      try {
        reader(chunk);
      } catch {
        sendError("listener-failed");
      }
    });
    const version = config.version ?? readPiVersion();
    send({ type: "hello", v: BRIDGE_PROTOCOL_VERSION, token: bridgeToken, pid, versions: version === undefined ? {} : { tui: version } });
    publishState(context, true);
  };

  /** Chaque gestionnaire garde le dernier contexte et ne lève jamais vers Pi. */
  const on = (event: string, handler: (payload: any, context: PiContext) => void): void => {
    pi.on(event, (payload: unknown, context: PiContext) => {
      try {
        ctx = context;
        handler(payload ?? {}, context);
      } catch {
        sendError("listener-failed");
      }
    });
  };

  // Le socket s'ouvre au `session_start`, pas au chargement : l'usine peut tourner sans session (doc extensions.md).
  on("session_start", (_event, context) => connect(context));
  on("agent_start", (_event, context) => publishState(context));
  on("message_start", (event) => onMessageStart(asRecord(asRecord(event)?.message)));
  on("message_end", (event) => onMessageEnd(asRecord(asRecord(event)?.message)));
  on("agent_settled", (event, context) => onSettled(event, context));
  on("session_shutdown", () => onShutdown());
}

export default function idnma(pi: PiApi): void {
  createPiBridge(pi);
}
