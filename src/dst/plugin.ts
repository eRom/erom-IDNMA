// Plugin Cordis idnma, chargé dans le process Node de dst. Il se connecte au pont de la doublure
// (socket Unix, une trame JSON par ligne), choisit `followup` ou `steer` sur l'agent du premier plan,
// et rapporte ce qu'il advient de chaque message de pair. Spec : §8. Ce module ne dépend que de
// `node:` et de `../bridge/protocol.ts`, en TypeScript effaçable, pour que Node 24 le charge tel quel.
import { readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BRIDGE_PROTOCOL_VERSION, createLineReader, encodeFrame, parseCourierFrame } from "../bridge/protocol.ts";
import type { DeliverFrame, DeliveryMode, DeliveryPriority, PluginFrame, ResultError, ResultFrame } from "../bridge/protocol.ts";

export const name = "idnma-bridge";
export const inject = ["agents", "shellEnv"];

export interface BridgePluginConfig {
  /** Fichier interne de la TUI qui désigne le premier plan (défaut `~/.dsh-tui/inject/servers.json`). */
  serversFile?: string;
  /** Environnement lu pour le pont et le jeton de contrôle (défaut `process.env`). */
  env?: Record<string, string | undefined>;
  /** Pid du process de dst : entrée de `servers.json` et trame `hello` (défaut `process.pid`). */
  pid?: number;
  /** Période du rafraîchissement du premier plan (défaut 2000 ms). */
  refreshMs?: number;
  /** Délai laissé à `agent/disposed` avant de conclure qu'un message est écarté (défaut 1500 ms). */
  discardGraceMs?: number;
}

type JsonObject = Record<string, unknown>;
type Owner = "peer" | "romain" | "unknown";

// Les formes ci-dessous ne décrivent que ce que le plugin lit de dsh (voir la sonde `idnma-dsh-probe.mjs`).
interface DshMessage {
  id: unknown;
  source?: { kind?: unknown };
}
interface DshAgent {
  id: string;
  status: string;
  session: { id: string };
  inbox: { nextTurn: readonly DshMessage[] };
  followup(message: unknown): void;
  steer(message: unknown): void;
}
interface DshContext {
  on(event: string, handler: (...args: any[]) => unknown): unknown;
  effect(fn: () => () => void): unknown;
  agents: { roots(): readonly DshAgent[]; get(id: string): DshAgent | undefined };
  shellEnv: { register(contributor: unknown): unknown };
}

/** Un message livré par nous, suivi jusqu'à sa réclamation, sa perte ou la fin de son tour. */
interface Delivery {
  agentId: string;
  mode: DeliveryMode;
  claimed: boolean;
  discardTimer?: ReturnType<typeof setTimeout>;
}

/** Un tour ouvert d'une session ; `followupId` désigne le followup des nôtres dont on suit la réponse. */
interface TurnState {
  sessionId: string;
  turn: number;
  owner: Owner;
  mixed: boolean;
  sources: Set<string>;
  followupId?: string;
  text?: string;
}

// Entrées de l'utilisateur : liste fermée (spec §8.4). Les contextes injectés par dsh à chaque tour
// (`runtime-context`, `skill-catalog`...) n'en font pas partie : ils ne mêlent pas le tour.
const ROMAIN_KINDS: ReadonlySet<string> = new Set(["user", "skill-invocation", "dsh-tui-btw", "dsh-tui-recap"]);
const TUI_PACKAGE = "@deepseek-harness-tui/dsh-tui";
const STEP_LINE_MARK = "⏵";
// Raison synthétisée par le plugin quand un tour se termine sans raison lisible ou sans `turn/end` (même sens que le `interrupted` de dsh).
const INTERRUPTED = "interrupted";

const asRecord = (value: unknown): JsonObject | undefined => (value !== null && typeof value === "object" ? (value as JsonObject) : undefined);

/** Texte d'une exception, sans jamais lever (un objet jeté peut avoir un `toString` qui lève). */
const describeError = (error: unknown): string => {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "erreur inconnue";
  }
};

const textOf = (message: unknown): string => {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
};

/** Retire la première ligne `⏵ ...` (titre d'étape de dsh) et les lignes vides qui la suivent. */
const withoutStepLine = (text: string): string => {
  if (!text.startsWith(STEP_LINE_MARK)) return text;
  const lines = text.split("\n");
  let next = 1;
  while (next < lines.length && (lines[next] ?? "").trim() === "") next += 1;
  return lines.slice(next).join("\n");
};

/** Version de dst, au mieux : remonte depuis `process.argv[1]` jusqu'au `package.json` du paquet de la TUI. */
function readTuiVersion(): string | undefined {
  try {
    const entry = process.argv[1];
    if (entry === undefined) return undefined;
    let dir = dirname(realpathSync(entry));
    for (let depth = 0; depth < 16; depth += 1) {
      try {
        const manifest = asRecord(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
        if (manifest?.name === TUI_PACKAGE) return typeof manifest.version === "string" ? manifest.version : undefined;
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

export function apply(rawContext: unknown, config: BridgePluginConfig = {}): void {
  const env = config.env ?? process.env;
  const bridgePath = env.IDNMA_DST_BRIDGE;
  const bridgeToken = env.IDNMA_DST_BRIDGE_TOKEN;
  if (!bridgePath || !bridgeToken) return;

  const ctx = rawContext as DshContext;
  const pid = config.pid ?? process.pid;
  const serversFile = config.serversFile ?? join(homedir(), ".dsh-tui", "inject", "servers.json");
  const refreshMs = config.refreshMs ?? 2000;
  const discardGraceMs = config.discardGraceMs ?? 1500;
  const controlToken = env.IDNMA_CONTROL_TOKEN;

  let socket: Socket | undefined;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const writeFrame = (frame: PluginFrame): void => {
    if (closed || socket === undefined || socket.destroyed) return;
    try {
      socket.write(encodeFrame(frame));
    } catch {
      // l'écouteur `error` du socket couvre les échecs asynchrones ; rien d'autre à faire ici
    }
  };
  // Pendant `followup()`/`steer()`, dsh émet de façon synchrone `agent/status`, `turn/start` et
  // `agent/inbox/claimed` avant de rendre la main : leurs trames attendent ici, pour que `delivered`
  // parte toujours en premier (la doublure doit connaître le mode quand `claimed` arrive).
  let held: PluginFrame[] | undefined;
  const send = (frame: PluginFrame): void => {
    if (held !== undefined) held.push(frame);
    else writeFrame(frame);
  };
  // Code fixe, jamais le message d'une exception : il pourrait citer une entrée (texte de pair, JSON).
  const sendError = (code: string): void => send({ type: "error", code });
  const guarded =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args);
      } catch {
        sendError("listener-failed");
      }
    };

  // --- Premier plan (spec §8.2) ---------------------------------------------------------------

  let serversSessionId: string | undefined; // dernière valeur valide de servers.json
  const createdRoots: string[] = []; // ids des racines, dans l'ordre des `agent/created` vus
  let foreground: DshAgent | undefined;
  let lastState: { session: string | null; status: "idle" | "running" } | undefined;

  const rereadServers = (): void => {
    let raw: string;
    try {
      raw = readFileSync(serversFile, "utf8");
    } catch (error) {
      // Fichier absent : repli. Autre échec de lecture : on garde la dernière valeur valide.
      if ((error as { code?: unknown }).code === "ENOENT") serversSessionId = undefined;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // la TUI écrit sans atomicité : lecture illisible, on garde la dernière valeur valide
    }
    if (!Array.isArray(parsed)) return;
    const entry = parsed.map(asRecord).find((candidate) => candidate?.pid === pid);
    serversSessionId = typeof entry?.sessionId === "string" ? entry.sessionId : undefined;
  };

  const resolveForeground = (): DshAgent | undefined => {
    const roots = ctx.agents.roots();
    if (serversSessionId !== undefined) {
      const wanted = serversSessionId;
      const viaGet = ctx.agents.get(wanted);
      const root = roots.find((candidate) => candidate === viaGet) ?? roots.find((candidate) => String(candidate.id) === wanted || String(candidate.session?.id) === wanted);
      if (root !== undefined) return root;
    }
    if (roots.length === 1) return roots[0];
    for (let index = createdRoots.length - 1; index >= 0; index -= 1) {
      const root = roots.find((candidate) => String(candidate.id) === createdRoots[index]);
      if (root !== undefined) return root;
    }
    return roots[roots.length - 1];
  };

  /** Relit le fichier, recalcule le premier plan, et publie `state` s'il a changé (ou si `force`). */
  const refresh = (force = false): void => {
    rereadServers();
    foreground = resolveForeground();
    const session = foreground === undefined ? null : String(foreground.id);
    const status = foreground?.status === "running" ? "running" : "idle";
    if (force || lastState === undefined || lastState.session !== session || lastState.status !== status) {
      lastState = { session, status };
      send({ type: "state", session, status });
    }
  };

  // --- Suivi des messages et des tours (spec §8.3, §8.4) --------------------------------------

  const deliveries = new Map<string, Delivery>();
  // Tours connus, par (session, tour) ; `currentTurn` désigne le tour ouvert de chaque session.
  const turns = new Map<string, TurnState>();
  const currentTurn = new Map<string, number>();
  const turnKey = (sessionId: string, turn: number): string => `${sessionId}#${turn}`;
  const isOurs = (message: DshMessage | undefined): boolean => message !== undefined && deliveries.has(String(message.id));

  const rootOfSession = (sessionId: string): DshAgent | undefined =>
    ctx.agents.roots().find((candidate) => String(candidate.session?.id) === sessionId || String(candidate.id) === sessionId);

  /** Le tour `turn` de la session, créé (propriétaire inconnu) si `turn/start` n'a pas été vu. */
  const turnOf = (sessionId: string, turn: number): TurnState => {
    const key = turnKey(sessionId, turn);
    let record = turns.get(key);
    if (record === undefined) {
      record = { sessionId, turn, owner: "unknown", mixed: false, sources: new Set() };
      turns.set(key, record);
    }
    const current = currentTurn.get(sessionId);
    if (current === undefined || current < turn) currentTurn.set(sessionId, turn);
    return record;
  };

  const openTurnOf = (sessionId: string): TurnState | undefined => {
    const current = currentTurn.get(sessionId);
    return current === undefined ? undefined : turns.get(turnKey(sessionId, current));
  };

  const closeTurn = (record: TurnState): void => {
    turns.delete(turnKey(record.sessionId, record.turn));
    if (currentTurn.get(record.sessionId) === record.turn) currentTurn.delete(record.sessionId);
  };

  const resultFrame = (id: string, turn: TurnState, reason: string): ResultFrame => {
    const frame: ResultFrame = { type: "result", id, turn: turn.turn, reason, mixed: turn.mixed, sources: [...turn.sources] };
    if (turn.text !== undefined) frame.text = turn.text;
    return frame;
  };

  /** Si le tour suivait un followup des nôtres, envoie son `result` et clôt le suivi. */
  const reportTracked = (record: TurnState, reason: string, decorate?: (frame: ResultFrame) => void): void => {
    if (record.followupId === undefined) return;
    const frame = resultFrame(record.followupId, record, reason);
    decorate?.(frame);
    deliveries.delete(record.followupId);
    send(frame);
  };

  const chooseMode = (agent: DshAgent, priority: DeliveryPriority): DeliveryMode => {
    if (agent.status === "idle") return "followup";
    let owner: Owner;
    const open = openTurnOf(String(agent.session.id));
    if (open !== undefined) {
      owner = open.owner;
    } else {
      // Entre deux tours : le seul message `next-turn` que le prochain tour va réclamer décide.
      const next = agent.inbox.nextTurn[0];
      if (next === undefined) return "followup"; // un `steer` ouvrirait un tour sans suivi
      owner = isOurs(next) ? "peer" : "romain";
    }
    if (owner === "peer") return priority === "now" ? "steer" : "followup";
    return priority === "later" ? "followup" : "steer";
  };

  const handleDeliver = (frame: DeliverFrame): void => {
    refresh();
    const agent = foreground;
    if (agent === undefined) {
      send({ type: "dropped", id: frame.id, why: "no-agent" });
      refresh(true);
      return;
    }
    const mode = chooseMode(agent, frame.priority);
    const text = mode === "steer" && frame.hint !== undefined ? `${frame.text}\n${frame.hint}` : frame.text;
    const message = {
      id: frame.id,
      role: "user",
      content: [
        { type: "text", text: `Team message from ${frame.sender}:` },
        { type: "text", text },
      ],
      source: { kind: "agent-message", form: "relay", senderSessionId: frame.sender },
    };
    // Enregistré avant l'appel : dsh peut émettre `inserted` et `claimed` pendant `followup`/`steer`.
    deliveries.set(frame.id, { agentId: String(agent.id), mode, claimed: false });
    held = [];
    let failure: { error: unknown } | undefined;
    try {
      if (mode === "steer") agent.steer(message);
      else agent.followup(message);
    } catch (error) {
      failure = { error };
    }
    const queued = held;
    held = undefined;
    if (failure === undefined) {
      send({ type: "delivered", id: frame.id, mode, session: String(agent.id) });
    } else {
      deliveries.delete(frame.id);
      send({ type: "dropped", id: frame.id, why: "rejected", error: describeError(failure.error) });
    }
    for (const queuedFrame of queued) send(queuedFrame);
  };

  const onAgentCreated = ({ agent }: { agent: DshAgent }): void => {
    // Un sous-agent émet aussi `agent/created` ; seules les racines comptent pour le repli.
    if (ctx.agents.roots().some((root) => root === agent || String(root.id) === String(agent.id))) {
      const id = String(agent.id);
      const known = createdRoots.indexOf(id);
      if (known !== -1) createdRoots.splice(known, 1);
      createdRoots.push(id);
    }
    refresh();
  };

  const onAgentDisposed = ({ agent }: { agent: DshAgent }): void => {
    const agentId = String(agent.id);
    const sessionId = String(agent.session.id);
    const known = createdRoots.indexOf(agentId);
    if (known !== -1) createdRoots.splice(known, 1);

    for (const record of [...turns.values()]) {
      if (record.sessionId !== sessionId) continue;
      closeTurn(record);
      reportTracked(record, "disposed");
    }
    let dropped = 0;
    for (const [id, delivery] of deliveries) {
      if (delivery.agentId !== agentId || delivery.claimed) continue;
      if (delivery.discardTimer !== undefined) clearTimeout(delivery.discardTimer);
      deliveries.delete(id);
      send({ type: "dropped", id, why: "disposed" });
      dropped += 1;
    }
    // Un `state` suit toujours un `dropped disposed` : la doublure y reprend la livraison.
    refresh(dropped > 0);
  };

  const onInboxClaimed = ({ agent, message, turn }: { agent: DshAgent; message: DshMessage; turn: number }): void => {
    const id = String(message.id);
    const sessionId = String(agent.session.id);
    const delivery = deliveries.get(id);
    if (delivery !== undefined) {
      delivery.claimed = true;
      if (delivery.discardTimer !== undefined) clearTimeout(delivery.discardTimer);
      send({ type: "claimed", id, turn });
      if (delivery.mode === "steer") {
        deliveries.delete(id); // réglé : le rappel de réponse passe par `idnma peer send`
        return;
      }
      // Le suivi s'ouvre même si `turn/start` n'a pas été vu : le `turn/end` rapportera ce followup.
      const tracked = turnOf(sessionId, turn);
      tracked.followupId = id;
      tracked.owner = "peer";
      return;
    }
    const kind = typeof message.source?.kind === "string" ? message.source.kind : "none";
    const foreign = turnOf(sessionId, turn);
    foreign.sources.add(kind);
    if (ROMAIN_KINDS.has(kind)) foreign.mixed = true;
  };

  const onInboxDiscarded = ({ message }: { message: DshMessage }): void => {
    const id = String(message.id);
    const delivery = deliveries.get(id);
    if (delivery === undefined || delivery.claimed || delivery.discardTimer !== undefined) return;
    // On ne sait pas si `/new` écarte la boîte avant de disposer l'agent : décision différée.
    const timeout = setTimeout(
      guarded(() => {
        deliveries.delete(id);
        send({ type: "dropped", id, why: "discarded" });
      }),
      discardGraceMs,
    );
    timeout.unref();
    delivery.discardTimer = timeout;
  };

  const onSessionEvent = (session: { id: string }, event: { type?: unknown; data?: unknown }): void => {
    const sessionId = String(session.id);
    const data = asRecord(event.data);
    const turn = data?.turn;
    if (typeof turn !== "number") return;

    if (event.type === "turn/start") {
      const root = rootOfSession(sessionId);
      if (root === undefined) return; // tour d'un sous-agent
      // Propriétaire fixé ici, par le message que le tour va réclamer (`turn/start` précède la réclamation).
      const first = root.inbox.nextTurn[0];
      const owner: Owner = first === undefined ? "unknown" : isOurs(first) ? "peer" : "romain";
      const previous = openTurnOf(sessionId);
      if (previous !== undefined && previous.turn !== turn) {
        // Le `turn/end` du tour précédent n'est jamais venu : on le clôt, sans raison lisible.
        closeTurn(previous);
        reportTracked(previous, INTERRUPTED);
      }
      const record = turnOf(sessionId, turn);
      currentTurn.set(sessionId, turn);
      record.owner = record.followupId !== undefined ? "peer" : owner;
      return;
    }

    const record = turns.get(turnKey(sessionId, turn));
    if (record === undefined) return;

    if (event.type === "assistant/message") {
      if (record.followupId === undefined) return;
      const text = withoutStepLine(textOf(data?.message));
      if (text.trim() !== "") record.text = text;
      return;
    }

    if (event.type === "turn/end") {
      closeTurn(record);
      const reason = asRecord(data?.reason);
      reportTracked(record, typeof reason?.kind === "string" ? reason.kind : INTERRUPTED, (frame) => {
        const cause = asRecord(reason?.reason)?.kind;
        if (typeof cause === "string") frame.cause = cause;
        const failure = asRecord(reason?.error);
        if (failure !== undefined) {
          const error: ResultError = {};
          if (typeof failure.message === "string") error.message = failure.message;
          if (typeof failure.code === "string") error.code = failure.code;
          frame.error = error;
        }
      });
    }
  };

  // --- Pont et cycle de vie -------------------------------------------------------------------

  const onLine = guarded((line: string): void => {
    const frame = parseCourierFrame(line);
    if (frame === undefined) {
      sendError("bad-frame");
      return;
    }
    handleDeliver(frame);
  });

  ctx.on("agent/created", guarded(onAgentCreated));
  ctx.on("agent/disposed", guarded(onAgentDisposed));
  ctx.on("agent/status", guarded(() => refresh()));
  ctx.on("agent/inbox/claimed", guarded(onInboxClaimed));
  ctx.on("agent/inbox/discarded", guarded(onInboxDiscarded));
  ctx.on("session/event", guarded(onSessionEvent));

  ctx.effect(() => {
    let unregisterShellEnv: unknown;
    let registerFailed = false;
    try {
      // Écouteur `error` posé dans l'instruction qui crée le socket : un `error` sans écouteur
      // ferait planter toute la TUI.
      socket = createConnection(bridgePath).on("error", () => {
        closed = true;
      });
    } catch {
      closed = true;
      return () => {};
    }
    socket.unref();
    socket.on("close", () => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
    });
    socket.on(
      "data",
      guarded(createLineReader(onLine, () => socket?.destroy())),
    );

    const tui = readTuiVersion();
    send({ type: "hello", v: BRIDGE_PROTOCOL_VERSION, token: bridgeToken, pid, versions: tui === undefined ? {} : { tui } });

    if (controlToken !== undefined && controlToken !== "") {
      try {
        unregisterShellEnv = ctx.shellEnv.register({
          name: "idnma",
          variables: { DSH_IDNMA_CONTROL_TOKEN: { description: "Jeton du canal de contrôle idnma (idnma peer send, idnma peer list)." } },
          resolve: () => ({ DSH_IDNMA_CONTROL_TOKEN: controlToken }),
        });
      } catch {
        registerFailed = true;
      }
    }
    if (registerFailed) sendError("register-failed");

    try {
      refresh(true);
    } catch {
      sendError("listener-failed");
    }
    timer = setInterval(
      guarded(() => refresh()),
      refreshMs,
    );
    timer.unref();

    return () => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      for (const delivery of deliveries.values()) {
        if (delivery.discardTimer !== undefined) clearTimeout(delivery.discardTimer);
      }
      if (typeof unregisterShellEnv === "function") {
        try {
          unregisterShellEnv();
        } catch {
          // le contributeur part de toute façon avec le contexte
        }
      }
      socket?.end();
    };
  });
}
