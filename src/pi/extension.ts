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

// `hasPendingMessages()` n'est pas lu : il ne compte que les entrées en file de l'utilisateur, jamais les
// messages d'extension (`agent-session.js` de Pi 1.5.0, `pendingMessageCount`).
export interface PiContext {
  isIdle(): boolean;
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
  /**
   * Délai laissé à `session_shutdown` après un repos interrompu qui suit `session_before_switch` ou
   * `session_before_fork` (défaut 2 000 ms). Passé ce délai, le remplacement a été annulé : c'est un Échap.
   */
  replaceGraceMs?: number;
}

type Owner = "peer" | "user";

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
  /**
   * Ids des followUp des nôtres dont la réponse revient à leur expéditeur. Plusieurs quand Pi en livre
   * plusieurs d'un coup (réglage `followUpMode: "all"`) : une même réponse leur revient à tous.
   */
  trackedIds: string[];
  mixed: boolean;
  /** Rôles des entrées étrangères réclamées pendant le segment. */
  sources: Set<string>;
  /** Dernier message assistant du segment ; `tools` : il appelle des outils, la boucle continue. */
  last?: { stopReason: string; text: string; tools: boolean; error?: string };
}

// Entrées de l'utilisateur : liste fermée (F9), seul `user` passe par `message_start` (un `!cmd` entre dans
// la session sans cet événement). Les messages custom d'autres extensions et les résumés (compaction,
// branche) n'en sont pas : ils ne mêlent pas le tour.
const USER_ROLES: ReadonlySet<string> = new Set(["user"]);

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

/**
 * La réponse du segment est complète (F6) : un message assistant sans appel d'outil, terminé normalement
 * ou coupé par la limite de tokens. Une erreur peut être réessayée et un abandon se lit au repos de Pi :
 * ni l'un ni l'autre ne clôt le segment avant `agent_settled`.
 */
const isFinal = (segment: Segment): boolean =>
  segment.last !== undefined && !segment.last.tools && (segment.last.stopReason === "stop" || segment.last.stopReason === "length");

const hasToolCall = (message: PiMessage): boolean => Array.isArray(message.content) && message.content.some((block) => asRecord(block)?.type === "toolCall");

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
    segment = { turn: turns, owner, trackedIds: trackedId === undefined ? [] : [trackedId], mixed: false, sources: new Set() };
    return segment;
  };

  /** Comment un segment se termine : naturellement (au segment suivant ou au repos), par un abandon, ou avec son runtime. */
  type Ending = "natural" | "aborted" | "disposed";

  /** Raison de fin (spec §2, D5) : l'abandon se lit au repos de Pi (F7), le reste sur le dernier message assistant. */
  const reasonOf = (closing: Segment, ending: Ending): { reason: string; cause?: string } => {
    if (ending === "disposed") return { reason: "disposed" };
    if (ending === "aborted") return { reason: "aborted", cause: "user" };
    switch (closing.last?.stopReason) {
      case "stop":
        return { reason: "completed" };
      case "length":
        return { reason: "max-tokens" };
      case "error":
        return { reason: "error" };
      case "aborted":
        return { reason: "aborted", cause: "user" };
      default:
        return { reason: "interrupted" };
    }
  };

  /** Envoie le `result` de chaque followUp des nôtres que le segment suivait, et clôt leur suivi. */
  const reportSegment = (closing: Segment, ending: Ending): void => {
    const { reason, cause } = reasonOf(closing, ending);
    const last = closing.last;
    for (const id of closing.trackedIds) {
      const frame: ResultFrame = { type: "result", id, turn: closing.turn, reason, mixed: closing.mixed, sources: [...closing.sources] };
      if (cause !== undefined) frame.cause = cause;
      if (ending !== "disposed" && last !== undefined && last.text.trim() !== "") frame.text = last.text;
      if (reason === "error" && last?.error !== undefined) frame.error = { message: last.error };
      deliveries.delete(id);
      send(frame);
    }
  };

  const closeSegment = (ending: Ending): void => {
    const closing = segment;
    segment = undefined;
    if (closing !== undefined) reportSegment(closing, ending);
  };

  /** Rend à la doublure, avec `why`, chaque message des nôtres de `ids` (tous par défaut) encore jamais réclamé. */
  const dropUnclaimed = (why: DroppedReason, ids: Iterable<string> = [...deliveries.keys()]): void => {
    for (const id of ids) {
      const delivery = deliveries.get(id);
      if (delivery === undefined || delivery.claimed) continue;
      deliveries.delete(id);
      send({ type: "dropped", id, why });
    }
  };

  // --- Remplacement de session ------------------------------------------------------------------
  // `/new`, `/resume` et `/fork` émettent `session_before_switch` ou `session_before_fork`, puis Pi avorte le
  // tour en cours (`agent_settled` avec `aborted`) AVANT `session_shutdown` (`agent-session-runtime.js` de
  // Pi 1.5.0, `teardownCurrent`). Ce repos interrompu n'est pas un Échap : le segment et les messages non
  // réclamés sont mis de côté pour `session_shutdown`, qui les rend comme `disposed` (relivrés à la nouvelle
  // session). Si `session_shutdown` ne vient pas (remplacement annulé par une autre extension), c'était un Échap.

  let replacing = false;
  let parked: { segment: Segment | undefined; unclaimed: string[]; timer: ReturnType<typeof setTimeout> } | undefined;
  const replaceGraceMs = config.replaceGraceMs ?? 2000;

  const releaseParked = (ending: "aborted" | "disposed"): void => {
    const aside = parked;
    if (aside === undefined) return;
    parked = undefined;
    clearTimeout(aside.timer);
    if (aside.segment !== undefined) reportSegment(aside.segment, ending);
    dropUnclaimed(ending === "aborted" ? "discarded" : "disposed", aside.unclaimed);
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
      if (delivery.mode === "followup") {
        if (segment !== undefined && segment.last === undefined) {
          // Pi a livré plusieurs entrées d'un coup (`followUpMode: "all"`) : une même réponse pour toutes.
          segment.trackedIds.push(id);
          if (segment.owner === "user") segment.mixed = true;
        } else {
          closeSegment("natural");
          openSegment("peer", id);
        }
      } else if (segment === undefined || isFinal(segment)) {
        closeSegment("natural");
        openSegment("peer");
      }
      send({ type: "claimed", id, turn: segment!.turn });
      if (delivery.mode === "steer") deliveries.delete(id); // réglé : le rappel de réponse passe par `idnma peer send`
      return;
    }
    if (!USER_ROLES.has(role)) return;
    if (segment === undefined || isFinal(segment)) {
      closeSegment("natural");
      openSegment("user");
      return;
    }
    segment.sources.add(role);
    if (segment.owner === "peer") segment.mixed = true;
  };

  const onMessageEnd = (message: PiMessage | undefined): void => {
    if (message?.role !== "assistant" || segment === undefined) return;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
    segment.last = { stopReason, text: textOf(message), tools: hasToolCall(message), ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}) };
  };

  /**
   * Pi au repos (F7) : fin du segment. Après Échap, Pi jette nos messages en file sans le dire (F8) : ils
   * sont rendus `discarded`. Sans abandon, un message non réclamé reste suivi : Pi vide sa file avant de
   * se reposer (F6), et un message arrivé pendant le repos ouvre son tour juste après.
   */
  const onSettled = (event: { aborted?: unknown }, context: PiContext): void => {
    const aborted = event.aborted === true;
    if (aborted && replacing && parked === undefined) {
      const unclaimed = [...deliveries].filter(([, delivery]) => !delivery.claimed).map(([id]) => id);
      const timer = setTimeout(() => {
        try {
          replacing = false;
          releaseParked("aborted");
        } catch {
          sendError("listener-failed");
        }
      }, replaceGraceMs);
      timer.unref();
      parked = { segment, unclaimed, timer };
      segment = undefined;
    } else {
      closeSegment(aborted ? "aborted" : "natural");
      if (aborted) dropUnclaimed("discarded");
    }
    publishState(context, true);
  };

  /** Fin du runtime (`/new`, `/resume`, `/fork`, `/reload`, sortie) : tout ce qui est suivi est rendu (D6). */
  const onShutdown = (): void => {
    releaseParked("disposed");
    closeSegment("disposed");
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
  on("session_before_switch", () => {
    replacing = true;
  });
  on("session_before_fork", () => {
    replacing = true;
  });
  on("session_shutdown", () => onShutdown());
}

export default function idnma(pi: PiApi): void {
  createPiBridge(pi);
}
