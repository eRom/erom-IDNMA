import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { FromMode } from "../bus/envelope.ts";
import type { InboundMessage } from "../bus/inbox.ts";
import { isDescendantOf } from "../bus/peer-pid.ts";
import type { Registration } from "../bus/register.ts";
import { sendPeerMessage } from "../bus/send.ts";
import { errorMessage, logEvent } from "../log.ts";
import { acquireLock } from "../naming/lock.ts";
import {
  CODEX_THREAD_ID_PATTERN,
  controlSocketPath,
  ensureControlDir,
  removeCodexPointer,
  writeCodexPointer,
} from "../understudy/control.ts";
import {
  CourierUnavailableError,
  isAutoReply,
  rejectQueuedMessages,
  sendAutoReply,
  waitBounded,
  withReplyHint,
  type Courier,
} from "../understudy/courier.ts";
import type { MessageQueue } from "../understudy/queue.ts";
import { connectDaemon, daemonPid } from "./daemon.ts";
import type { CodexClient, CodexNotification } from "./rpc.ts";

export interface CodexCourierOptions {
  name: string;
  fromMode: FromMode;
  registration: Registration;
  queue: MessageQueue;
  cwd: string;
  /**
   * Ouvre la connexion au daemon ; défaut `connectDaemon`. `allowStart` dit si le daemon peut être
   * démarré en cas d'échec : oui au lancement, non à la reconnexion (absent, on quitte le bus).
   */
  connect?: (onNotification: (n: CodexNotification) => void, o: { allowStart: boolean }) => Promise<CodexClient>;
  /** Pid du process qui sert le daemon, référence d'ascendance de `verifyCaller` ; défaut `daemonPid`. */
  daemonPid?: () => Promise<number | undefined>;
  /** Envoi d'un message vers un pair (renvoi des réponses) ; défaut `sendPeerMessage`. */
  send?: typeof sendPeerMessage;
  /** Délai pour voir le thread de la TUI apparaître après le lancement (60 s, `thread/started` mesuré à 9 s). */
  adoptionTimeoutMs?: number;
  /** Attente avant la reconnexion au daemon après une coupure (2 s). */
  reconnectDelayMs?: number;
  /** Délai de chaque requête au daemon (15 s, défaut du client). */
  requestTimeoutMs?: number;
}

const DEFAULT_ADOPTION_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;
// Environ 90 s d'attente (3000 essais de 30 ms) : le temps qu'un premier lancement voisin adopte son thread.
const ADOPTION_LOCK_RETRIES = 3000;
const ADOPTION_LOCK_LABEL = "d'adoption Codex";
const STOPPED_MESSAGE = "le livreur Codex est arrêté";
const DAEMON_LOST_MESSAGE = "connexion au daemon Codex perdue avant l'adoption du thread";
// Attente maximale des derniers renvois avant de retirer l'inscription en quittant le bus.
const LEAVE_REPLY_WAIT_MS = 3_000;
// Préfixe des identifiants client de nos `turn/start` : ce qui ne l'a pas vient de la TUI (l'utilisateur).
const CLIENT_MESSAGE_ID_PREFIX = "idnma-";
const NOT_STEERABLE_MARKER = "ActiveTurnNotSteerable";

/** `idle` et `busy` viennent des notifications du thread ; `unknown` tant qu'aucune n'a rien dit de sûr. */
type ThreadState = "idle" | "busy" | "unknown";

/** Expéditeur d'un tour lancé pour un pair : à qui renvoyer la réponse de ce tour. */
interface PeerTurn {
  from: string | undefined;
  msgId: string | undefined;
  /** Tour ouvert par un renvoi automatique : il tient la place d'un tour de pair (un message à la fois) mais ne renvoie rien. */
  silent?: boolean;
}

function resolvedPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Texte du dernier `agentMessage` de phase `final_answer`, sinon du dernier `agentMessage`. */
function answerOf(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  let lastMessage: string | undefined;
  let lastFinal: string | undefined;
  for (const item of items) {
    const record = asRecord(item);
    if (record?.type !== "agentMessage" || typeof record.text !== "string" || record.text === "") continue;
    lastMessage = record.text;
    if (record.phase === "final_answer") lastFinal = record.text;
  }
  return lastFinal ?? lastMessage;
}

function statusTypeOf(status: unknown): string | undefined {
  const type = asRecord(status)?.type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Livreur du harnais Codex : connexion au daemon et verrou d'adoption avant le lancement de la
 * TUI, puis adoption de son thread à partir de la diffusion `thread/started`, état occupé/repos
 * publié dans le registre de Claude, abonnement au thread, pointeur pour les commandes Codex et
 * vérification des appelants. Les messages en file sont livrés au thread par `turn/start` (un
 * nouveau tour au repos, un steer pendant un tour), la réponse finale d'un tour lancé pour un pair
 * lui est renvoyée, et une connexion perdue est rétablie une fois.
 */
export function createCodexCourier(o: CodexCourierOptions): Courier {
  const connect = o.connect ?? ((onNotification, { allowStart }) => connectDaemon({ onNotification, allowStart }));
  const getDaemonPid = o.daemonPid ?? daemonPid;
  const adoptionTimeoutMs = o.adoptionTimeoutMs ?? DEFAULT_ADOPTION_TIMEOUT_MS;
  const requestTimeoutMs = o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reconnectDelayMs = o.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const send = o.send ?? sendPeerMessage;

  const lockWait = new AbortController();
  let client: CodexClient | undefined;
  let releaseLock: (() => void) | undefined;
  let adoptionTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let realCwd: string | undefined;
  let armed = false;
  let stopped = false;
  // Détaché : le délai d'adoption est dépassé, le livreur ne fait plus rien.
  let detached = false;
  let adopted: string | undefined;
  let subscribed = false;
  let subscribing = false;
  // Posé avant toute fermeture voulue (stop, délai d'adoption, abandon) : elle n'est pas prise pour une perte du daemon.
  let deliberateClose = false;
  let connectionLost = false;
  // Une nouvelle demande d'abonnement est arrivée pendant un `thread/resume` en vol : s'il échoue, on réessaie.
  let resumeRetryWanted = false;
  // Connexion coupée, reconnexion en attente ou en cours : rien n'est livré, les notifications sont ignorées.
  let reconnecting = false;

  let state: ThreadState = "unknown";
  // Tour en cours : appris de `turn/started` et des réponses de `turn/start`, oublié à son `turn/completed`.
  let activeTurnId: string | undefined;
  // Tours lancés pour un pair (id du tour -> expéditeur du message qui l'a lancé).
  const peerTurns = new Map<string, PeerTurn>();
  // Tours notés avant une coupure dont la fin a pu tomber pendant elle (état relu `active`).
  const turnsLostIfNotFinished = new Set<string>();
  // Une seule requête `turn/start` à la fois.
  let requestInFlight = false;
  // Après `ActiveTurnNotSteerable`, rien n'est envoyé jusqu'au prochain `idle` reçu.
  let steerBlocked = false;
  // Identifiant client stable d'un message d'une tentative à l'autre (un renvoi après une erreur locale).
  const clientMessageIds = new WeakMap<InboundMessage, string>();

  const inactive = (): boolean => stopped || detached || deliberateClose;

  const releaseAdoptionLock = (): void => {
    const release = releaseLock;
    releaseLock = undefined;
    release?.();
  };

  const closeOnPurpose = (): void => {
    deliberateClose = true;
    client?.close();
  };

  const subscribe = async (): Promise<void> => {
    if (subscribed || adopted === undefined || client === undefined) return;
    if (subscribing) {
      resumeRetryWanted = true;
      return;
    }
    subscribing = true;
    let failed = false;
    try {
      // Paramètres exacts, jamais d'override vers Codex.
      await client.request("thread/resume", { threadId: adopted, excludeTurns: true }, requestTimeoutMs);
      subscribed = true;
    } catch (error) {
      // Un échec (ou une fermeture voulue) ne bloque rien : le prochain `active` réessaie.
      failed = true;
      if (!inactive()) logEvent("codex-resume-error", { message: errorMessage(error) });
    } finally {
      subscribing = false;
    }
    // Un `active` arrivé pendant la requête qui vient d'échouer a été absorbé : il réessaie maintenant.
    const retry = resumeRetryWanted;
    resumeRetryWanted = false;
    if (failed && retry && !inactive()) void subscribe();
  };

  /** Renvoie `body` à l'expéditeur d'un message, sous la marque de renvoi automatique ; jamais d'exception. */
  const sendReply = (to: { from?: string | undefined; msgId?: string | undefined }, body: string): Promise<void> =>
    sendAutoReply({ registration: o.registration, name: o.name, fromMode: o.fromMode, send }, to, body);

  const reply = (to: { from?: string | undefined; msgId?: string | undefined }, body: string): void => {
    void sendReply(to, body);
  };

  const lostLine = `${o.name} : réponse perdue (daemon Codex redémarré)`;

  const replyLost = (turnId: string): void => {
    const noted = peerTurns.get(turnId);
    if (noted === undefined) return;
    peerTurns.delete(turnId);
    if (!noted.silent) reply(noted, lostLine);
  };

  /** Choisit le plus ancien message éligible dans l'état courant et le livre ; une seule requête à la fois. */
  const pump = (): void => {
    if (adopted === undefined || client === undefined || inactive() || reconnecting) return;
    if (state === "unknown" || requestInFlight || steerBlocked) return;
    const atRest = state === "idle";
    const duringPeerTurn = activeTurnId !== undefined && peerTurns.has(activeTurnId);
    const message = o.queue.first(
      atRest ? () => true : duringPeerTurn ? (m) => m.priority === "now" : (m) => m.priority !== "later",
    );
    if (message === undefined) return;
    void deliver(client, adopted, message, atRest);
  };

  const deliver = async (target: CodexClient, threadId: string, message: InboundMessage, atRest: boolean): Promise<void> => {
    requestInFlight = true;
    let clientUserMessageId = clientMessageIds.get(message);
    if (clientUserMessageId === undefined) {
      clientUserMessageId = CLIENT_MESSAGE_ID_PREFIX + (message.msgId ?? randomUUID());
      clientMessageIds.set(message, clientUserMessageId);
    }
    let result: unknown;
    try {
      // Paramètres exacts, jamais d'override vers Codex. Un steer entre dans un tour qui n'est pas le sien : rappel de réponse.
      const text = atRest ? message.content : withReplyHint(message.content);
      result = await target.request(
        "turn/start",
        { threadId, clientUserMessageId, input: [{ type: "text", text, text_elements: [] }] },
        requestTimeoutMs,
      );
    } catch (error) {
      requestInFlight = false;
      onDeliveryFailure(message, error);
      return;
    }
    requestInFlight = false;
    o.queue.remove(message);
    const turnId = asRecord(asRecord(result)?.turn)?.id;
    if (typeof turnId !== "string") {
      logEvent("codex-turn-start-unexpected", { msgId: message.msgId });
    } else if (atRest && turnId !== activeTurnId) {
      // Tour lancé pour un pair ; s'il est déjà noté pour un autre, il garde son expéditeur. Un renvoi
      // automatique ouvre un tour silencieux : sa fin ne renvoie rien (sinon deux doublures se
      // répondraient sans fin), mais il garde l'attente des messages suivants, qui auront leur tour.
      if (!peerTurns.has(turnId)) {
        peerTurns.set(turnId, { from: message.from, msgId: message.msgId, ...(isAutoReply(message.content) ? { silent: true } : {}) });
      }
      activeTurnId = turnId;
    } else if (activeTurnId === undefined) {
      // Steer dans un tour dont le début n'a pas été vu : la réponse apprend son id.
      activeTurnId = turnId;
    }
    if (atRest && state === "idle") state = "busy";
    pump();
  };

  const onDeliveryFailure = (message: InboundMessage, error: unknown): void => {
    if (inactive()) return;
    const text = errorMessage(error);
    const code = (error as { code?: unknown }).code;
    if (text.includes(NOT_STEERABLE_MARKER)) {
      // Le message reste en file : plus rien n'est envoyé avant le prochain `idle` reçu.
      steerBlocked = true;
    } else if (typeof code === "number") {
      o.queue.remove(message);
      logEvent("codex-delivery-error", { msgId: message.msgId, message: text });
      reply(message, `${o.name} : message non livré (${text})`);
      pump();
    } else {
      // Erreur locale (délai, connexion fermée) : la livraison a peut-être eu lieu, un doublon vaut mieux qu'une perte.
      logEvent("codex-delivery-failed", { msgId: message.msgId, message: text });
    }
  };

  const applyStatus = (type: string | undefined): void => {
    if (type === "idle") {
      state = "idle";
      steerBlocked = false;
      o.registration.setStatus("idle");
    } else if (type === "active") {
      state = "busy";
      o.registration.setStatus("busy");
      void subscribe();
    } else {
      // `systemError`, `notLoaded` ou forme inconnue : l'état est inconnu, le registre garde le dernier connu.
      state = "unknown";
      logEvent("codex-thread-status", { status: type });
    }
  };

  const adopt = (params: Record<string, unknown>): void => {
    if (!armed || adopted !== undefined) return;
    const thread = asRecord(params.thread);
    if (thread === undefined) return;
    const { id, cwd } = thread;
    if (typeof id !== "string" || !CODEX_THREAD_ID_PATTERN.test(id) || typeof cwd !== "string") return;
    if (thread.ephemeral !== false || thread.threadSource !== "user" || thread.parentThreadId !== null) return;
    const threadCwd = resolvedPath(cwd);
    if (threadCwd === undefined || threadCwd !== realCwd) return;

    adopted = id;
    if (adoptionTimer !== undefined) clearTimeout(adoptionTimer);
    adoptionTimer = undefined;
    releaseAdoptionLock();
    applyStatus(statusTypeOf(thread.status));
    try {
      writeCodexPointer(id, controlSocketPath());
    } catch (error) {
      logEvent("codex-pointer-error", { threadId: id, message: errorMessage(error) });
      pump();
      return;
    }
    logEvent("codex-adopted", { threadId: id });
    pump();
  };

  const completionLine = (turn: Record<string, unknown>): string => {
    if (turn.status === "failed") {
      const message = asRecord(turn.error)?.message;
      return `${o.name} : tour en échec (${typeof message === "string" && message !== "" ? message : "erreur inconnue"})`;
    }
    if (turn.status === "interrupted") return `${o.name} : tour interrompu`;
    return answerOf(turn.items) ?? `${o.name} : tour terminé sans réponse`;
  };

  const onTurnCompleted = (params: Record<string, unknown>): void => {
    const turn = asRecord(params.turn);
    const turnId = turn?.id;
    if (turn === undefined || typeof turnId !== "string") return;
    if (activeTurnId === turnId) activeTurnId = undefined;
    const noted = peerTurns.get(turnId);
    peerTurns.delete(turnId);
    if (noted !== undefined && !noted.silent) reply(noted, completionLine(turn));
    // Après une coupure, tout tour noté avant elle qui n'est pas celui-ci a perdu sa fin.
    for (const lostId of turnsLostIfNotFinished) replyLost(lostId);
    turnsLostIfNotFinished.clear();
    pump();
  };

  /** Une entrée de l'utilisateur dans un tour lancé pour un pair mélange sa tâche et la demande : plus de renvoi automatique. */
  const onItem = (params: Record<string, unknown>): void => {
    const item = asRecord(params.item);
    const turnId = params.turnId;
    if (item?.type !== "userMessage" || typeof turnId !== "string" || !peerTurns.has(turnId)) return;
    const clientId = item.clientId;
    if (typeof clientId === "string" && clientId.startsWith(CLIENT_MESSAGE_ID_PREFIX)) return;
    peerTurns.delete(turnId);
    logEvent("codex-peer-turn-mixed", { turnId });
  };

  const onNotification = (notification: CodexNotification): void => {
    // Une notification peut encore arriver entre `close()` et l'événement de fermeture.
    if (inactive() || reconnecting) return;
    const { method, params } = notification;
    if (method === "thread/started") {
      adopt(params);
      return;
    }
    if (adopted === undefined || params.threadId !== adopted) return;
    if (method === "thread/status/changed") {
      const type = statusTypeOf(params.status);
      applyStatus(type);
      if (type === "idle") pump();
    } else if (method === "turn/started") {
      const id = asRecord(params.turn)?.id;
      if (typeof id === "string") activeTurnId = id;
    } else if (method === "turn/completed") {
      onTurnCompleted(params);
    } else if (method === "item/started" || method === "item/completed") {
      onItem(params);
    }
  };

  /**
   * Fin de service : le livreur quitte le bus, par délai d'adoption dépassé, perte du daemon avant
   * l'adoption ou reconnexion ratée. Plus de livraison ; chaque tour noté pour un pair reçoit sa ligne
   * d'échec et chaque message encore en file est refusé (le socket d'envoi existe encore, l'attente
   * est bornée) ; puis inscription retirée, verrou rendu, pointeur retiré, connexion fermée, et un
   * seul événement terminal au journal.
   */
  const leaveBus = async (event: "codex-adoption-timeout" | "codex-daemon-lost", fields: Record<string, unknown>): Promise<void> => {
    if (detached) return;
    detached = true;
    if (adoptionTimer !== undefined) clearTimeout(adoptionTimer);
    adoptionTimer = undefined;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const farewells = [...peerTurns.values()].filter((noted) => !noted.silent).map((noted) => sendReply(noted, `${o.name} : réponse perdue (daemon Codex perdu)`));
    peerTurns.clear();
    turnsLostIfNotFinished.clear();
    await Promise.all([
      waitBounded(Promise.all(farewells), LEAVE_REPLY_WAIT_MS),
      rejectQueuedMessages({ queue: o.queue, registration: o.registration, name: o.name, fromMode: o.fromMode, send }),
    ]);
    try {
      o.registration.unregister();
    } catch (error) {
      logEvent("cleanup-error", { step: "unregister", message: errorMessage(error) });
    }
    releaseAdoptionLock();
    lockWait.abort();
    if (adopted !== undefined) {
      try {
        removeCodexPointer(adopted);
      } catch (error) {
        logEvent("cleanup-error", { step: "codex-pointer", message: errorMessage(error) });
      }
    }
    logEvent(event, fields);
    closeOnPurpose();
  };

  const onConnectionClosed = (closedClient: CodexClient): void => {
    // Une connexion remplacée, une fermeture voulue ou une reconnexion en cours (qui rend compte de son échec) ne comptent pas.
    if (closedClient !== client || inactive() || reconnecting) return;
    connectionLost = true;
    if (adopted === undefined) {
      // Avant l'adoption, plus rien ne peut arriver sur cette connexion : le verrou ne doit pas retenir les voisins.
      void leaveBus("codex-daemon-lost", { adopted: false });
      return;
    }
    logEvent("codex-daemon-closed");
    reconnecting = true;
    reconnectTimer = setTimeout(() => void reconnect(), reconnectDelayMs);
  };

  /** Une reconnexion : état relu par `thread/read`, abonnement refait si le thread est actif, livraison relancée. */
  const reconnect = async (): Promise<void> => {
    reconnectTimer = undefined;
    if (inactive()) return;
    try {
      const fresh = await connect(onNotification, { allowStart: false });
      if (inactive()) {
        fresh.close();
        return;
      }
      client = fresh;
      void fresh.closed.then(() => onConnectionClosed(fresh));
      const read = await fresh.request<unknown>("thread/read", { threadId: adopted, includeTurns: false }, requestTimeoutMs);
      if (inactive()) return;
      const statusType = statusTypeOf(asRecord(asRecord(read)?.thread)?.status);

      subscribed = false;
      resumeRetryWanted = false;
      activeTurnId = undefined;
      steerBlocked = false;
      turnsLostIfNotFinished.clear();
      if (statusType === "active") {
        // Le thread travaille : la fin d'un tour noté a pu tomber pendant la coupure, le premier `turn/completed` le dira.
        for (const turnId of peerTurns.keys()) turnsLostIfNotFinished.add(turnId);
      } else {
        // Au repos ou état inconnu (rien n'annonce une fin à venir) : chaque tour noté a perdu sa réponse.
        for (const turnId of [...peerTurns.keys()]) replyLost(turnId);
      }
      reconnecting = false;
      applyStatus(statusType);
      logEvent("codex-daemon-reconnected");
      pump();
    } catch (error) {
      if (inactive()) return;
      logEvent("codex-reconnect-error", { message: errorMessage(error) });
      await leaveBus("codex-daemon-lost", { adopted: adopted !== undefined });
    }
  };

  const onAdoptionTimeout = (): void => {
    adoptionTimer = undefined;
    if (stopped || adopted !== undefined) return;
    void leaveBus("codex-adoption-timeout", { cwd: o.cwd });
  };

  return {
    async beforeSpawn(): Promise<void> {
      if (stopped) throw new CourierUnavailableError(STOPPED_MESSAGE);
      const resolvedCwd = resolvedPath(o.cwd);
      if (resolvedCwd === undefined) throw new CourierUnavailableError(`dossier de travail introuvable : ${o.cwd}`);
      realCwd = resolvedCwd;

      let connected: CodexClient;
      try {
        connected = await connect(onNotification, { allowStart: true });
      } catch (error) {
        throw new CourierUnavailableError(errorMessage(error));
      }
      if (stopped) {
        connected.close();
        throw new CourierUnavailableError(STOPPED_MESSAGE);
      }
      client = connected;
      void connected.closed.then(() => onConnectionClosed(connected));

      let release: () => void;
      try {
        const digest = createHash("sha256").update(resolvedCwd).digest("hex").slice(0, 16);
        release = await acquireLock(join(ensureControlDir(), `codex-adopt-${digest}`), {
          label: ADOPTION_LOCK_LABEL,
          maxRetries: ADOPTION_LOCK_RETRIES,
          signal: lockWait.signal,
        });
      } catch (error) {
        closeOnPurpose();
        throw new CourierUnavailableError(connectionLost && !stopped ? DAEMON_LOST_MESSAGE : errorMessage(error));
      }
      // Le verrou a pu être obtenu au moment même d'un arrêt ou d'une perte du daemon.
      if (stopped || connectionLost) {
        release();
        closeOnPurpose();
        throw new CourierUnavailableError(stopped ? STOPPED_MESSAGE : DAEMON_LOST_MESSAGE);
      }
      releaseLock = release;
    },

    afterSpawn(): void {
      if (stopped || detached || armed || client === undefined) return;
      armed = true;
      adoptionTimer = setTimeout(onAdoptionTimeout, adoptionTimeoutMs);
    },

    onMessage(): void {
      if (detached) {
        // Le livreur a quitté le bus : rien de ce qui arrive encore ne sera livré, l'expéditeur est prévenu.
        void rejectQueuedMessages({ queue: o.queue, registration: o.registration, name: o.name, fromMode: o.fromMode, send });
        return;
      }
      pump();
    },

    // Codex ne passe ni par `idnma read` ni par les hooks : la file est livrée par le daemon.
    read(): null {
      return null;
    },

    async hook(): Promise<Record<string, unknown>> {
      return {};
    },

    async verifyCaller(claim, peerPid): Promise<boolean> {
      if (stopped || detached || adopted === undefined || claim.codexThreadId !== adopted || peerPid === undefined) return false;
      const daemon = await getDaemonPid();
      return daemon !== undefined && isDescendantOf(peerPid, daemon);
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      if (adoptionTimer !== undefined) clearTimeout(adoptionTimer);
      adoptionTimer = undefined;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      lockWait.abort();
      releaseAdoptionLock();
      if (adopted !== undefined) {
        try {
          removeCodexPointer(adopted);
        } catch (error) {
          logEvent("cleanup-error", { step: "codex-pointer", message: errorMessage(error) });
        }
      }
      closeOnPurpose();
    },
  };
}
