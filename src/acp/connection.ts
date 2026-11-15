// Connexion ACP de l'écran unifié (design §6.4) : lance le process de l'agent depuis un `LaunchPlan`, branche le client
// du SDK officiel sur ses tubes, filtre les trames inconnues, traduit les mises à jour en événements du domaine,
// relaie les permissions, ouvre ou recharge une session et applique les réglages de l'engine.
// Seul module de `src/acp/` à lancer un process ; l'écran ne voit que `AgentConnection` et les types de `events.ts`.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
} from "@agentclientprotocol/sdk";
import pkg from "../../package.json";
import { errorMessage, logEvent } from "../log.ts";
import type { AgentEvent, ConfigOption, PermissionAnswer, PermissionRequest, StopReason } from "./events.ts";
import { pickLatestSession, type LaunchPlan } from "./harness.ts";
import { filterUnknownUpdates, silenceConsoleError } from "./stream-filter.ts";
import { toConfigOptions, toPermissionRequest, translateUpdate } from "./translate.ts";

export interface ConnectionHandlers {
  /** Sérialisé : un événement à la fois, dans l'ordre d'arrivée. `replay` pendant `session/load`, `live` ensuite. */
  onEvent(event: AgentEvent, origin: "replay" | "live"): void;
  onPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>;
  /** Sortie du process de l'agent, sauf quand c'est `close()` qui l'a provoquée. */
  onExit(code: number | null, signal: string | null): void;
}

export interface OpenedSession {
  sessionId: string;
  options: ConfigOption[];
  resumed: boolean;
  /** Posé quand une reprise a eu lieu : `load` rejoue la conversation, `resume` ne rejoue rien. */
  resumeMethod?: "load" | "resume";
  /** Nombre d'événements rejoués avant la réponse de `session/load` (toujours 0 pour `session/resume`). */
  replayed: number;
  /** `-c` sans session antérieure dans ce dossier : une session neuve a été ouverte. */
  noPreviousSession: boolean;
  /** `-c` mais l'agent n'annonce pas `session/list` : une session neuve a été ouverte. */
  listUnavailable: boolean;
  /** Un identifiant à reprendre mais l'agent n'annonce ni `loadSession` ni `resume` : une session neuve a été ouverte. */
  resumeUnavailable: boolean;
  /** `origin` des réglages que l'agent a refusés (« --effort turbo ») ; les jetons écartés à la traduction restent dans `LaunchPlan.ignored`. */
  ignored: string[];
}

/** Erreur ACP `-32000` (`authRequired`, « Authentication required ») : l'agent n'est pas connecté. */
export class AgentNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNotConnectedError";
  }
}

/** Erreur ACP `-32002` sur `session/load` ou `session/resume` : la session demandée n'existe pas. */
export class SessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

/** Toute autre erreur d'ouverture, ou agent mort avant la réponse. `code` : code ACP, ou code de sortie du process. */
export class AgentStartError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "AgentStartError";
    this.code = code;
  }
}

export interface AgentConnection {
  /** `initialize` (les capacités annoncées décident), puis `session/new`, ou `session/list` + reprise, ou reprise directe (`session/load` ou `session/resume`), puis les réglages de l'engine. */
  open(cwd: string): Promise<OpenedSession>;
  /** Se résout après que tous les événements du tour ont été livrés. */
  prompt(text: string): Promise<StopReason>;
  /** `session/cancel`, et `cancelled` à chaque permission en attente. */
  cancel(): void;
  setOption(category: string, value: string): Promise<ConfigOption[]>;
  /** Tue le groupe de process (SIGTERM, puis SIGKILL après 1 500 ms) ; idempotent ; se résout quand l'agent est sorti. */
  close(): Promise<void>;
  readonly pid: number;
}

const MAX_LIST_PAGES = 10;
const KILL_GRACE_MS = 1500;
/** Délai laissé au flux de sortie d'un agent mort pour être lu jusqu'au bout avant le rapport de sortie. */
const OUTPUT_FLUSH_MS = 300;
/** Délai laissé au process pour annoncer sa sortie quand la connexion casse avant. */
const EXIT_ANNOUNCE_MS = 500;
const MAX_LOGGED_VARIANT = 64;
const CANCELLED: PermissionAnswer = { outcome: "cancelled" };

type Phase = "start" | "list" | "load" | "resume" | "new" | "options";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function codeOf(error: unknown): number | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" ? code : undefined;
}

/** Classe une erreur d'ouverture par son code ACP (design §6.4). */
function classify(error: unknown, phase: Phase): Error {
  if (error instanceof AgentStartError || error instanceof AgentNotConnectedError || error instanceof SessionNotFoundError) return error;
  const code = codeOf(error);
  const message = errorMessage(error);
  if (code === -32000 || /authentication required/i.test(message)) return new AgentNotConnectedError(message);
  if (code === -32002 && (phase === "load" || phase === "resume")) return new SessionNotFoundError(message);
  return new AgentStartError(message, code ?? null);
}

function describeExit(code: number | null, signal: string | null): string {
  return signal !== null ? `agent killed by signal ${signal}` : `agent exited with code ${code}`;
}

export function connectAgent(plan: LaunchPlan, handlers: ConnectionHandlers): AgentConnection {
  const restoreConsoleError = silenceConsoleError();
  let child: ChildProcess;
  try {
    child = spawn(plan.argv[0]!, plan.argv.slice(1), { env: plan.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (error) {
    // Un lancer synchrone ne doit pas laisser le détournement installé.
    restoreConsoleError();
    throw error;
  }

  let closing = false;
  let exited = false;
  /** Posée dès que l'agent est mort ou n'a pas pu démarrer : toute requête suivante échoue tout de suite avec elle. */
  let failure: AgentStartError | undefined;
  let rejectFailure!: (error: AgentStartError) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  failed.catch(() => {});
  let announceExit!: () => void;
  const exitAnnounced = new Promise<void>((resolve) => {
    announceExit = resolve;
  });
  const exitEvent = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stdoutClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  let activeSessionId: string | undefined;
  let options: ConfigOption[] = [];
  let loading = false;
  let replayed = 0;
  /** Chaîne de livraison : le SDK lance les gestionnaires de notification sans les attendre. */
  let chain: Promise<void> = Promise.resolve();
  const pendingPermissions = new Set<AbortController>();

  const tick = (): Promise<void> => delay(0);
  /** Attend que tout ce que l'agent a déjà écrit soit passé par la chaîne de livraison. */
  async function drain(): Promise<void> {
    await tick();
    await chain;
  }

  function enqueue(events: AgentEvent[], origin: "replay" | "live"): void {
    chain = chain.then(() => {
      for (const event of events) {
        try {
          handlers.onEvent(event, origin);
        } catch (error) {
          logEvent("acp-handler-error", { type: event.type, message: errorMessage(error) });
        }
      }
    });
  }

  function abortPendingPermissions(): void {
    for (const controller of pendingPermissions) controller.abort();
  }

  child.stdin!.on("error", (error: NodeJS.ErrnoException) => logEvent("agent-stdin-error", { code: error.code ?? "unknown" }));
  // Le stderr de l'agent est lu et jeté : seul le volume est consigné, jamais le texte.
  child.stderr!.on("data", (chunk: Buffer) => logEvent("agent-stderr", { bytes: chunk.length }));

  child.on("error", (error) => {
    // `error` annonce aussi les échecs d'un `kill` : seul l'échec du lancement (pas de pid) compte ici.
    if (child.pid !== undefined) return;
    failure = new AgentStartError(`could not start the agent: ${errorMessage(error)}`);
    rejectFailure(failure);
  });

  child.on("exit", (code, signal) => {
    exited = true;
    void (async () => {
      // Ce que l'agent a écrit avant de mourir est livré avant le rapport de sortie.
      await Promise.race([stdoutClosed, delay(OUTPUT_FLUSH_MS)]);
      await drain();
      failure = new AgentStartError(describeExit(code, signal), code);
      rejectFailure(failure);
      abortPendingPermissions();
      if (!closing) {
        try {
          handlers.onExit(code, signal);
        } catch (error) {
          logEvent("acp-handler-error", { type: "exit", message: errorMessage(error) });
        }
      }
      announceExit();
    })();
  });

  const output = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
  const input = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  const transport = ndJsonStream(output, input);
  const stream = {
    writable: transport.writable,
    readable: filterUnknownUpdates(transport.readable, (info) => {
      // Un lancer ici tuerait le côté lecture d'ACP : tout est rattrapé.
      try {
        logEvent("acp-unknown-update", { method: info.method, sessionUpdate: info.sessionUpdate.slice(0, MAX_LOGGED_VARIANT) });
      } catch {
        // rien à faire de plus
      }
    }),
  };

  const connection: ClientConnection = client({ name: "idnma" })
    .onRequest("session/request_permission", (raw) => raw as RequestPermissionRequest, async ({ params, signal }): Promise<RequestPermissionResponse> => {
      // Les événements annoncés avant la demande (la ligne de l'outil) sont livrés avant elle.
      await chain;
      let request: PermissionRequest;
      try {
        request = toPermissionRequest(params);
      } catch {
        logEvent("acp-permission-error", { reason: "malformed request" });
        return { outcome: CANCELLED };
      }
      const controller = new AbortController();
      const aborted = new Promise<PermissionAnswer>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(CANCELLED), { once: true });
      });
      pendingPermissions.add(controller);
      // L'agent retire sa demande (`$/cancel_request`, comme Claude) : même chemin que notre propre annulation.
      const withdraw = (): void => controller.abort();
      if (signal.aborted) withdraw();
      else signal.addEventListener("abort", withdraw, { once: true });
      try {
        const handled = Promise.resolve()
          .then(() => handlers.onPermission(request, controller.signal))
          .catch((error: unknown): PermissionAnswer => {
            logEvent("acp-handler-error", { type: "permission", message: errorMessage(error) });
            return CANCELLED;
          });
        const answer = await Promise.race([handled, aborted]);
        return { outcome: answer.outcome === "selected" ? { outcome: "selected", optionId: answer.optionId } : { outcome: "cancelled" } };
      } finally {
        pendingPermissions.delete(controller);
        signal.removeEventListener("abort", withdraw);
      }
    })
    .onNotification("session/update", ({ params }) => {
      // Les événements reçus pendant `session/load` sont un rejeu ; la marque est posée à l'arrivée, pas à la livraison.
      const origin = loading ? "replay" : "live";
      let events: AgentEvent[];
      try {
        events = translateUpdate(params.update);
      } catch {
        logEvent("acp-translate-error", { sessionUpdate: String(params.update.sessionUpdate).slice(0, MAX_LOGGED_VARIANT) });
        return;
      }
      for (const event of events) if (event.type === "config") options = event.options;
      if (origin === "replay") replayed += events.length;
      enqueue(events, origin);
    })
    .connect(stream);
  connection.closed.catch(() => {});

  /**
   * Une requête à l'agent. Meurt avec lui : si le process sort pendant l'attente, la requête échoue avec sa sortie.
   * Une rupture de la connexion sans code JSON-RPC laisse un instant à la sortie du process pour s'annoncer.
   */
  async function call<T>(request: () => Promise<T>): Promise<T> {
    if (failure) throw failure;
    try {
      return await Promise.race([request(), failed]);
    } catch (error) {
      if (error instanceof AgentStartError || codeOf(error) !== undefined || closing) throw error;
      await Promise.race([exitAnnounced, delay(EXIT_ANNOUNCE_MS)]);
      throw failure ?? error;
    }
  }

  async function applyOption(configId: string, value: string): Promise<ConfigOption[]> {
    const response = await call(() => connection.agent.request(methods.agent.session.setConfigOption, { sessionId: activeSessionId!, configId, value }));
    if (response.configOptions) options = toConfigOptions(response.configOptions);
    return options;
  }

  /** La session la plus récente du dossier : toutes les pages de `session/list` (dix au plus), puis le choix côté client. */
  async function findLatestSession(cwd: string): Promise<string | undefined> {
    const sessions: SessionInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await call(() => connection.agent.request(methods.agent.session.list, cursor === undefined ? { cwd } : { cwd, cursor }));
      sessions.push(...(response.sessions ?? []));
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
    return pickLatestSession(sessions, cwd);
  }

  async function openSession(cwd: string, setPhase: (phase: Phase) => void): Promise<OpenedSession> {
    setPhase("start");
    const init = await call(() =>
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // Ni lecture ni écriture de fichiers, ni terminal : l'agent exécute ses outils lui-même.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "idnma", version: pkg.version },
      }),
    );

    // Les capacités annoncées par l'agent décident de la voie de reprise.
    const agentCapabilities = init.agentCapabilities;
    const canLoad = agentCapabilities?.loadSession === true;
    const canList = agentCapabilities?.sessionCapabilities?.list != null;
    const canResume = agentCapabilities?.sessionCapabilities?.resume != null;

    let loadId = plan.resume.kind === "id" ? plan.resume.id : undefined;
    let noPreviousSession = false;
    let listUnavailable = false;
    let resumeUnavailable = false;
    if (plan.resume.kind === "continue") {
      if (canList) {
        setPhase("list");
        loadId = await findLatestSession(cwd);
        noPreviousSession = loadId === undefined;
      } else {
        listUnavailable = true;
      }
    }
    let resumeMethod: "load" | "resume" | undefined;
    if (loadId !== undefined) {
      if (canLoad) resumeMethod = "load";
      else if (canResume) resumeMethod = "resume";
      else {
        resumeUnavailable = true;
        loadId = undefined;
      }
    }

    let resumed = false;
    let replayedBefore = 0;
    if (loadId !== undefined && resumeMethod !== undefined) {
      setPhase(resumeMethod);
      const sessionId = loadId;
      const method = resumeMethod === "load" ? methods.agent.session.load : methods.agent.session.resume;
      activeSessionId = sessionId;
      // Seul `session/load` rejoue : les événements reçus pendant `session/resume` ne seraient pas un rejeu.
      loading = resumeMethod === "load";
      try {
        const response = await call(() =>
          connection.agent.request(method, {
            sessionId,
            cwd,
            mcpServers: [],
            ...(plan.loadSessionMeta ? { _meta: plan.loadSessionMeta } : {}),
          }),
        );
        // La réponse résout aussitôt : un tour de boucle laisse démarrer les gestionnaires des dernières trames rejouées.
        await tick();
        if (response?.configOptions) options = toConfigOptions(response.configOptions);
      } catch (error) {
        activeSessionId = undefined;
        throw error;
      } finally {
        loading = false;
      }
      await chain;
      resumed = true;
      replayedBefore = replayed;
    } else {
      setPhase("new");
      const response = await call(() =>
        connection.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
          ...(plan.newSessionMeta ? { _meta: plan.newSessionMeta } : {}),
        }),
      );
      activeSessionId = response.sessionId;
      options = toConfigOptions(response.configOptions);
    }

    setPhase("options");
    const ignored: string[] = [];
    for (const step of plan.configSteps) {
      const target = options.find((option) => option.category === step.category);
      if (!target) {
        ignored.push(step.origin);
        continue;
      }
      try {
        await applyOption(target.id, step.value);
      } catch (error) {
        // Toute erreur JSON-RPC rendue par l'agent vivant (`-32602`, mais aussi `-32603` chez pi-acp pour un modèle inconnu) :
        // l'agent refuse la valeur, l'écran l'annonce, l'ouverture continue. `AgentStartError` (agent mort, son `code` est
        // un code de sortie) et les ruptures sans code JSON-RPC font toujours échouer l'ouverture.
        if (!(error instanceof AgentStartError) && codeOf(error) !== undefined) ignored.push(step.origin);
        else throw error;
      }
    }

    return { sessionId: activeSessionId!, options, resumed, ...(resumed ? { resumeMethod } : {}), replayed: replayedBefore, noPreviousSession, listUnavailable, resumeUnavailable, ignored };
  }

  function signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      // groupe déjà vide
    }
  }

  function groupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async function terminate(): Promise<void> {
    abortPendingPermissions();
    try {
      connection.close();
    } catch {
      // déjà fermée
    }
    const pid = child.pid;
    if (pid !== undefined) {
      // Le groupe entier : un simple `child.kill()` laisserait vivre les petits-enfants (outils lancés par l'agent).
      signalGroup(pid, "SIGTERM");
      const deadline = Date.now() + KILL_GRACE_MS;
      while ((!exited || groupAlive(pid)) && Date.now() < deadline) await delay(25);
      if (!exited || groupAlive(pid)) signalGroup(pid, "SIGKILL");
      if (!exited) await exitEvent;
    }
    restoreConsoleError();
  }

  let closePromise: Promise<void> | undefined;

  return {
    async open(cwd) {
      let phase: Phase = "start";
      try {
        return await openSession(cwd, (next) => {
          phase = next;
        });
      } catch (error) {
        throw classify(error, phase);
      }
    },

    async prompt(text) {
      if (activeSessionId === undefined) throw new Error("no open session");
      const sessionId = activeSessionId;
      const response = await call(() => connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] }));
      // Les événements du tour sont livrés avant la raison d'arrêt.
      await drain();
      return response.stopReason;
    },

    cancel() {
      if (activeSessionId !== undefined && !failure) {
        connection.agent.notify(methods.agent.session.cancel, { sessionId: activeSessionId }).catch((error: unknown) => logEvent("acp-cancel-error", { message: errorMessage(error) }));
      }
      abortPendingPermissions();
    },

    async setOption(category, value) {
      const target = options.find((option) => option.category === category);
      if (!target || activeSessionId === undefined) throw new Error(`no option for category ${category}`);
      return applyOption(target.id, value);
    },

    close() {
      closing = true;
      closePromise ??= terminate();
      return closePromise;
    },

    get pid() {
      return child.pid ?? 0;
    },
  };
}
