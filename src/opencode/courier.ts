import { randomUUID } from "node:crypto";
import type { FromMode } from "../bus/envelope.ts";
import type { InboundMessage } from "../bus/inbox.ts";
import type { Registration } from "../bus/register.ts";
import { sendPeerMessage } from "../bus/send.ts";
import { errorMessage, logEvent } from "../log.ts";
import { CourierUnavailableError, isAutoReply, rejectQueuedMessages, sendAutoReply, withReplyHint, type Courier } from "../understudy/courier.ts";
import type { MessageQueue } from "../understudy/queue.ts";
import { COURIER_EVENT_TYPES, openEventStream, type OpencodeEvent } from "./events.ts";
import { createOpencodeClient, isProcessAlive, OpencodeHttpError, readServiceInfo, type OpencodeClient, type ServiceInfo } from "./service.ts";

export interface OpencodeCourierOptions {
  name: string;
  fromMode: FromMode;
  registration: Registration;
  queue: MessageQueue;
  sessionID: string;
  /** Coordonnées du service, relues à chaque connexion (défaut : `service.json`). */
  service?: () => ServiceInfo | undefined;
  client?: (info: ServiceInfo) => OpencodeClient;
  openEvents?: typeof openEventStream;
  send?: typeof sendPeerMessage;
  /** Attente avant de réessayer un `prompt` en échec (défaut 2 000 ms). */
  retryDelayMs?: number;
  /** Attente entre la coupure du flux et la reconnexion (défaut 2 000 ms, spec §7.4). */
  reconnectDelayMs?: number;
  /** Durée pendant laquelle la reconnexion relit `service()` avant de renoncer (défaut 10 000 ms). */
  reconnectWindowMs?: number;
  /** Intervalle de relecture de `service()` pendant la reconnexion (défaut 200 ms). */
  reconnectPollMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;
const DEFAULT_RECONNECT_WINDOW_MS = 10_000;
const DEFAULT_RECONNECT_POLL_MS = 200;
const STOPPED_MESSAGE = "le livreur opencode est arrêté";

/** Ce que le livreur sait de la session : `unknown` avant la lecture initiale et pendant une coupure du flux. */
type SessionState = "idle" | "busy" | "unknown";

/**
 * Auteur du tour en cours, donné par l'élément livré qui l'ouvre : `peer` (un élément de la doublure),
 * `romain` (tout autre élément), `unknown` (avant la première livraison du tour, ou tour déjà en cours
 * à la resynchronisation). `unknown` est traité comme `romain` par la politique.
 */
type TurnOwner = "peer" | "romain" | "unknown";

type Delivery = "queue" | "steer";

/** Un prompt envoyé à opencode par la doublure, de la requête jusqu'à sa livraison ou son annulation. */
interface OwnItem {
  message: InboundMessage;
  /** `metadata.idnma.msgId` : celui du message, ou un identifiant tiré pour un message qui n'en a pas. */
  wireId: string;
  delivery: Delivery;
  /** Connu par l'`inbox.enqueued` portant notre `msgId`, ou par la réponse du `prompt` : le premier arrivé. */
  inboxID?: string;
  /** Livré, annulé ou retiré : l'élément n'est plus suivi. */
  settled: boolean;
  /** Retrait demandé à opencode (`DELETE …/inbox/…`) ; l'`inbox.cancelled` qui suit n'est pas une annulation de l'utilisateur. */
  cancelling: boolean;
  /** Tour interrompu pendant que l'`inboxID` n'était pas encore connu : retrait dès qu'il l'est. */
  cancelWhenKnown: boolean;
}

/**
 * Segment de pair (spec §7.3) : ouvert à la livraison d'un élément `queue` de la doublure, fermé à la
 * livraison d'un autre élément `queue` ou d'un élément de l'utilisateur, ou à la fin de l'exécution.
 */
interface Segment {
  message: InboundMessage;
  wireId: string;
  /** Dernier `session.text.ended` non vide du segment. */
  lastText: string | undefined;
  /** Un `session.step.ended` de `finish: "stop"` est passé dans le segment. */
  stopSeen: boolean;
  /** Le message ouvrant est lui-même un renvoi automatique : rien ne lui est renvoyé (design principal §7.6). */
  muted: boolean;
}

/** Comment un segment se ferme ; l'issue journalisée en découle. */
type SegmentEnd =
  | { kind: "finished" }
  | { kind: "mixed" }
  | { kind: "failed"; message: string }
  | { kind: "interrupted" }
  | { kind: "lost" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Livreur de l'agent opencode : reçoit les messages du bus (file de la doublure), suit le flux
 * d'événements du service et décide quand et comment (`queue` ou `steer`) les remettre à opencode.
 *
 * Machine d'état (spec §7.1 et §7.2) :
 * - `state` : `idle | busy | unknown`, suivi des `session.execution.*` ; relu par `activeSessions` au démarrage ;
 * - `owner` : auteur du tour en cours, fixé par le premier `inbox.delivered` du tour ;
 * - `parked` : l'élément `queue` de la doublure qui attend sa livraison chez opencode (au plus un) ;
 * - `requestInFlight` : une seule requête `prompt` à la fois ;
 * - `segment` : le segment de pair ouvert, dont la fermeture renvoie la réponse à l'expéditeur (spec §7.3) ;
 * - coupure du flux : `onClose` abandonne ce qui était en vol, puis `reconnect` rouvre le flux une fois (spec §7.4).
 */
export function createOpencodeCourier(o: OpencodeCourierOptions): Courier {
  const readService = o.service ?? (() => readServiceInfo());
  const makeClient = o.client ?? ((info: ServiceInfo) => createOpencodeClient(info));
  const openEvents = o.openEvents ?? openEventStream;
  const send = o.send ?? sendPeerMessage;
  const retryDelayMs = o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const reconnectDelayMs = o.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const reconnectWindowMs = o.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS;
  const reconnectPollMs = o.reconnectPollMs ?? DEFAULT_RECONNECT_POLL_MS;

  let api: OpencodeClient | undefined;
  let stream: { close(): void } | undefined;
  // Vrai tant que les événements du flux comptent : posé avant l'ouverture, retiré à toute fermeture
  // (voulue ou subie). Le flux peut encore livrer des trames après `close()` : on les ignore.
  let listening = false;
  let stopped = false;
  // La doublure a quitté le bus : plus rien n'est livré, les messages qui arrivent sont refusés.
  let detached = false;
  // `beforeSpawn` est terminé : la livraison est permise.
  let ready = false;

  let state: SessionState = "unknown";
  let owner: TurnOwner = "unknown";
  // Un `inbox.delivered` a déjà été vu depuis le dernier `execution.started`.
  let turnOpened = false;
  // Dernier statut publié au registre (l'inscription démarre `idle`).
  let published: "idle" | "busy" = "idle";

  let requestInFlight = false;
  let parked: OwnItem | undefined;
  const ownByMsgId = new Map<string, OwnItem>();
  const ownByInbox = new Map<string, OwnItem>();
  // `inboxID` des éléments qui ne sont pas une demande de l'utilisateur appelant sa propre réponse (fin d'une tâche
  // de fond, compaction, déplacement de session) : leur livraison ne mêle pas un tour de pair.
  const nonInputInbox = new Set<string>();
  const wireIds = new WeakMap<InboundMessage, string>();
  const failedAttempts = new WeakMap<InboundMessage, number>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  let segment: Segment | undefined;
  // Une ouverture de flux est en cours (démarrage ou tentative de reconnexion) : elle constate elle-même une fermeture.
  let connecting = false;
  // Une reconnexion est planifiée ou en cours : les `inboxID` abandonnés ne sont retirés qu'à son terme.
  let reconnecting = false;
  // Compte les coupures du flux : une requête `prompt` lancée avant une coupure n'est plus suivie à son retour.
  let epoch = 0;
  // `inboxID` des éléments abandonnés à une coupure : retirés de la boîte d'opencode dès la reconnexion.
  let abandonedInboxIDs: string[] = [];
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  let wakePause: (() => void) | undefined;

  const inactive = (): boolean => stopped || detached;

  const publish = (status: "idle" | "busy"): void => {
    if (published === status) return;
    published = status;
    o.registration.setStatus(status);
  };

  const reply = (to: InboundMessage, body: string): void => {
    void sendAutoReply({ registration: o.registration, name: o.name, fromMode: o.fromMode, send }, to, body);
  };

  const closeStream = (): void => {
    listening = false;
    const open = stream;
    stream = undefined;
    open?.close();
  };

  const clearRetryTimer = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  /** Attente interrompue par `stop()` : la promesse se résout alors tout de suite. */
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      wakePause = resolve;
      pauseTimer = setTimeout(() => {
        wakePause = undefined;
        resolve();
      }, ms);
    });

  const cancelPause = (): void => {
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
    pauseTimer = undefined;
    const wake = wakePause;
    wakePause = undefined;
    wake?.();
  };

  // --- Suivi des éléments de la doublure -----------------------------------------------------

  const bind = (item: OwnItem, inboxID: string): void => {
    if (item.settled || item.inboxID !== undefined) return;
    item.inboxID = inboxID;
    ownByInbox.set(inboxID, item);
    if (item.cancelWhenKnown) void cancelParked(item);
  };

  /** L'élément n'est plus suivi (livré, annulé, retiré ou refusé) ; il libère sa place s'il l'occupait. */
  const settle = (item: OwnItem): void => {
    item.settled = true;
    ownByMsgId.delete(item.wireId);
    if (item.inboxID !== undefined) ownByInbox.delete(item.inboxID);
    if (parked === item) parked = undefined;
  };

  // --- Politique de livraison (spec §7.2) ----------------------------------------------------

  /** Le plus ancien message que la politique autorise dans l'état courant, avec son mode de livraison. */
  const choose = (): { message: InboundMessage; delivery: Delivery } | undefined => {
    if (state === "idle") {
      // Au repos : `queue`, un tour de pair s'ouvre ; jamais deux éléments `queue` en attente chez opencode.
      if (parked !== undefined) return undefined;
      const message = o.queue.first(() => true);
      return message === undefined ? undefined : { message, delivery: "queue" };
    }
    // Tour d'un pair : seul `now` entre dans le tour. Tour de l'utilisateur ou propriétaire inconnu : `now` et `next`.
    const eligible = owner === "peer" ? (m: InboundMessage) => m.priority === "now" : (m: InboundMessage) => m.priority !== "later";
    const message = o.queue.first(eligible);
    return message === undefined ? undefined : { message, delivery: "steer" };
  };

  const pump = (): void => {
    // Pendant une ouverture de flux, `api` désigne encore l'ancien service : rien ne part avant la fin de la connexion.
    if (!ready || inactive() || state === "unknown" || requestInFlight || connecting) return;
    const chosen = choose();
    if (chosen !== undefined) void deliver(chosen.message, chosen.delivery);
  };

  const wireIdOf = (message: InboundMessage): string => {
    let id = wireIds.get(message) ?? message.msgId;
    if (id === undefined) id = randomUUID();
    wireIds.set(message, id);
    return id;
  };

  const deliver = async (message: InboundMessage, delivery: Delivery): Promise<void> => {
    const client = api;
    if (client === undefined) return;
    const item: OwnItem = { message, wireId: wireIdOf(message), delivery, settled: false, cancelling: false, cancelWhenKnown: false };
    const startedAtEpoch = epoch;
    o.queue.remove(message);
    requestInFlight = true;
    ownByMsgId.set(item.wireId, item);
    if (delivery === "queue") parked = item;
    // Un steer entre dans un tour qui n'est pas le sien : rappel de réponse.
    const text = delivery === "steer" ? withReplyHint(message.content) : message.content;
    let inboxID: string;
    try {
      ({ inboxID } = await client.prompt(o.sessionID, { text, delivery, metadata: { idnma: { msgId: item.wireId, from: message.from } } }));
    } catch (error) {
      // Flux coupé pendant la requête : l'élément a déjà été refusé à la coupure, sa réponse tardive ne change rien.
      if (epoch !== startedAtEpoch) return;
      requestInFlight = false;
      onPromptFailure(item, error);
      return;
    }
    if (epoch !== startedAtEpoch) {
      // Époque périmée : l'élément a été refusé à la coupure, mais opencode l'a accepté après coup. Il dormirait
      // dans sa boîte : retrait tout de suite si la reconnexion est faite, à son terme sinon.
      if (reconnecting) abandonedInboxIDs.push(inboxID);
      else if (api !== undefined) dropLateInbox(api, inboxID);
      return;
    }
    requestInFlight = false;
    if (inactive()) return;
    logEvent("opencode-deliver", { msgId: item.wireId, delivery });
    bind(item, inboxID);
    pump();
  };

  /** Retire de la boîte d'opencode un élément accepté trop tard pour être suivi ; l'échec est seulement journalisé. */
  const dropLateInbox = (client: OpencodeClient, inboxID: string): void => {
    if (inactive()) return;
    client.cancelInbox(o.sessionID, inboxID).catch((error: unknown) => logEvent("opencode-cancel-failed", { inboxID, error: errorMessage(error) }));
  };

  /** Raison montrée à l'expéditeur : le message du service seul, jamais méthode, chemin ni identifiant de session. */
  const shownReason = (error: unknown): string => {
    if (!(error instanceof OpencodeHttpError)) return "erreur inconnue";
    if (error.status === 0) return "service opencode injoignable";
    return error.serviceMessage ?? `HTTP ${error.status}`;
  };

  const onPromptFailure = (item: OwnItem, error: unknown): void => {
    settle(item);
    if (inactive()) return;
    const { message } = item;
    if (error instanceof OpencodeHttpError && error.status === 404 && error.tag === "SessionNotFoundError") {
      // Session supprimée par l'utilisateur : le message revient en file pour être refusé avec les autres.
      o.queue.unshift(message);
      void leaveBus("session-not-found");
      return;
    }
    const text = errorMessage(error);
    const attempt = (failedAttempts.get(message) ?? 0) + 1;
    failedAttempts.set(message, attempt);
    logEvent("opencode-deliver-failed", { msgId: item.wireId, attempt, error: text });
    if (attempt >= 2) {
      reply(message, `${o.name} : message non livré (${shownReason(error)})`);
      pump();
      return;
    }
    // Premier échec : le message reprend la tête de file. Au repos aucun événement ne viendrait, un minuteur à un coup rejoue.
    o.queue.unshift(message);
    if (retryTimer === undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        pump();
      }, retryDelayMs);
    }
  };

  /** Retire de la boîte d'opencode l'élément `queue` resté garé après une interruption, libère sa place et prévient son expéditeur. */
  const cancelParked = async (item: OwnItem): Promise<void> => {
    const client = api;
    if (client === undefined || item.inboxID === undefined || item.cancelling || item.settled) return;
    item.cancelling = true;
    try {
      await client.cancelInbox(o.sessionID, item.inboxID);
    } catch (error) {
      // Déjà livré, déjà retiré ou service muet : la place est libérée quand même, sans quoi plus rien ne partirait.
      logEvent("opencode-cancel-failed", { msgId: item.wireId, error: errorMessage(error) });
    }
    if (inactive() || item.settled) return;
    settle(item);
    reply(item.message, `${o.name} : message non livré (tour interrompu)`);
    pump();
  };

  // --- Segments et renvois automatiques (spec §7.3) ------------------------------------------

  const openSegment = (item: OwnItem): void => {
    segment = { message: item.message, wireId: item.wireId, lastText: undefined, stopSeen: false, muted: isAutoReply(item.message.content) };
  };

  /** Ferme le segment ouvert (s'il y en a un), journalise l'issue et renvoie la réponse à l'expéditeur. */
  const endSegment = (end: SegmentEnd): void => {
    const current = segment;
    if (current === undefined) return;
    segment = undefined;
    let outcome: string;
    let text: string;
    switch (end.kind) {
      case "finished":
        if (current.lastText !== undefined) {
          outcome = "replied";
          text = current.lastText;
        } else {
          outcome = "no-text";
          text = `${o.name} : tour terminé sans réponse`;
        }
        break;
      case "mixed":
        outcome = "mixed";
        text = `${o.name} : tour mêlé à une entrée de l'utilisateur, pas de réponse automatique`;
        break;
      case "failed":
        outcome = "failed";
        text = `${o.name} : tour en échec (${end.message})`;
        break;
      case "interrupted":
        outcome = "interrupted";
        text = `${o.name} : tour interrompu`;
        break;
      case "lost":
        outcome = "lost";
        text = `${o.name} : réponse perdue (service opencode redémarré)`;
        break;
    }
    if (current.muted) outcome = "muted";
    logEvent("opencode-segment-end", { msgId: current.wireId, outcome });
    if (!current.muted) reply(current.message, text);
  };

  // --- Événements du service (spec §7.1) -----------------------------------------------------

  const onStarted = (): void => {
    state = "busy";
    turnOpened = false;
    // Exception : une exécution qui démarre pendant qu'un élément `queue` de la doublure attend sa
    // livraison est un tour de pair jusqu'au premier `inbox.delivered` (un `next` attend).
    owner = parked !== undefined ? "peer" : "unknown";
    publish("busy");
  };

  const onExecutionEnded = (type: string, data: Record<string, unknown>): void => {
    if (type === "session.execution.succeeded") endSegment({ kind: "finished" });
    else if (type === "session.execution.interrupted") endSegment({ kind: "interrupted" });
    else endSegment({ kind: "failed", message: isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : "erreur inconnue" });
    state = "idle";
    owner = "unknown";
    turnOpened = false;
    publish("idle");
    if (type !== "session.execution.interrupted" || parked === undefined) return;
    // Les prompts en file restent garés après une interruption : la doublure retire le sien.
    if (parked.inboxID === undefined) parked.cancelWhenKnown = true;
    else void cancelParked(parked);
  };

  const onEnqueued = (data: Record<string, unknown>): void => {
    const inboxID = data.inboxID;
    if (typeof inboxID !== "string") return;
    // Types de boîte d'opencode 2.2.0 : `user`, `synthetic`, `compaction`, `move`. Une demande de l'utilisateur arrive
    // toujours en `user` ; un `synthetic` est une fin de tâche de fond (capturé : `<shell … state="completed">`,
    // `metadata.source: "shell"`), une sortie de `!cmd` ou un contexte qui précède un `user`. Un type inconnu de
    // cette version compte, par prudence, comme une entrée de l'utilisateur.
    const itemType = isRecord(data.item) ? data.item.type : undefined;
    if (itemType === "synthetic" || itemType === "compaction" || itemType === "move") {
      nonInputInbox.add(inboxID);
      return;
    }
    const idnma = isRecord(data.item) && isRecord(data.item.payload) && isRecord(data.item.payload.metadata) ? data.item.payload.metadata.idnma : undefined;
    const msgId = isRecord(idnma) ? idnma.msgId : undefined;
    if (typeof msgId !== "string") return;
    // Un `msgId` qui n'est pas un des nôtres est un `metadata.idnma` étranger : l'élément compte comme celui de l'utilisateur.
    const own = ownByMsgId.get(msgId);
    if (own !== undefined) bind(own, inboxID);
  };

  const onDelivered = (data: Record<string, unknown>): void => {
    const inboxID = data.inboxID;
    if (typeof inboxID !== "string") return;
    const own = ownByInbox.get(inboxID);
    if (own !== undefined) {
      settle(own);
      // Un élément `queue` de la doublure ouvre un segment de pair (et ferme le précédent). Un `steer` de la
      // doublure livré avant tout `stop` du segment n'y change rien ; livré après, opencode continue sur lui
      // (capturé) : le segment ouvert est clos avec le texte d'avant, sans quoi sa réponse irait au mauvais pair.
      // Posé au repos, un `steer` qui ouvre l'exécution l'a lui-même ouverte (capturé).
      if (own.delivery === "queue") {
        endSegment({ kind: "finished" });
        openSegment(own);
      } else if (segment?.stopSeen) {
        endSegment({ kind: "finished" });
      }
      if (own.delivery === "queue" || !turnOpened) owner = "peer";
    } else if (nonInputInbox.has(inboxID)) {
      // Pas une demande de l'utilisateur : le propriétaire ne change pas. Avant tout `stop` du segment, opencode
      // continue le même tour (capturé, compaction et fin de commande de fond) : le segment reste ouvert.
      // Après, la réponse du pair est complète (capturé : aucune étape ne suit la compaction) : renvoi tout de
      // suite, comme pour les éléments voisins, sans attendre une suite qui peut encore échouer.
      nonInputInbox.delete(inboxID);
      if (segment?.stopSeen) endSegment({ kind: "finished" });
    } else {
      // Élément inconnu des deux voies (`msgId` de l'enqueued, `inboxID` de la réponse) : celui de l'utilisateur.
      // Livré avant tout `stop` du segment, il partage la réponse du pair : pas de renvoi automatique.
      if (segment !== undefined) endSegment(segment.stopSeen ? { kind: "finished" } : { kind: "mixed" });
      if (!turnOpened) owner = "romain";
    }
    turnOpened = true;
  };

  const onCancelled = (data: Record<string, unknown>): void => {
    const inboxID = data.inboxID;
    if (typeof inboxID !== "string") return;
    nonInputInbox.delete(inboxID);
    const own = ownByInbox.get(inboxID);
    // Un retrait demandé par la doublure a sa propre réponse (`cancelParked`).
    if (own === undefined || own.cancelling) return;
    settle(own);
    reply(own.message, `${o.name} : message non livré (annulé dans opencode)`);
  };

  const onTextEnded = (data: Record<string, unknown>): void => {
    if (segment !== undefined && typeof data.text === "string" && data.text.trim() !== "") segment.lastText = data.text;
  };

  const onStepEnded = (data: Record<string, unknown>): void => {
    if (segment !== undefined && data.finish === "stop") segment.stopSeen = true;
  };

  const onEvent = (event: OpencodeEvent): void => {
    if (!listening || inactive()) return;
    if (event.data.sessionID !== o.sessionID) return;
    switch (event.type) {
      case "session.execution.started":
        onStarted();
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        onExecutionEnded(event.type, event.data);
        break;
      case "session.inbox.enqueued":
        onEnqueued(event.data);
        break;
      case "session.inbox.delivered":
        onDelivered(event.data);
        break;
      case "session.inbox.cancelled":
        onCancelled(event.data);
        break;
      case "session.text.ended":
        onTextEnded(event.data);
        break;
      case "session.step.ended":
        onStepEnded(event.data);
        break;
      default:
        break;
    }
    pump();
  };

  // --- Connexion, coupure et reconnexion (spec §7.4) -----------------------------------------

  /** État de départ d'une connexion neuve : `activeSessions` ne fixe l'état que si aucun événement ne l'a déjà fait. */
  const applyActive = (active: Set<string>): void => {
    // Un événement déjà reçu fait foi sur la lecture, qui peut être plus ancienne que lui.
    if (state !== "unknown") return;
    state = active.has(o.sessionID) ? "busy" : "idle";
    // Tour déjà en cours : l'élément qui l'a ouvert est inconnu, `owner` reste `unknown`.
    turnOpened = state === "busy";
    publish(state);
  };

  /**
   * Ouvre le flux sur `info` puis lit `activeSessions` (et `info` au démarrage). Rend le client et la
   * lecture ; en cas d'échec le flux ouvert est refermé et l'erreur remonte.
   */
  const connect = async (info: ServiceInfo, atStartup: boolean): Promise<{ client: OpencodeClient; active: Set<string> }> => {
    let opened: { close(): void } | undefined;
    connecting = true;
    try {
      const client = makeClient(info);
      // Aucun environnement de session n'est posé : la TUI transmet le sien (spec §6, point 8).
      listening = true;
      opened = await openEvents({ info, types: COURIER_EVENT_TYPES, onEvent, onClose });
      stream = opened;
      const active = await client.activeSessions();
      const version = atStartup ? (await client.info()).version : undefined;
      if (stopped) throw new Error(STOPPED_MESSAGE);
      if (!listening) throw new Error("flux opencode fermé pendant la connexion");
      if (version !== undefined) logEvent("opencode-info", { version });
      return { client, active };
    } catch (error) {
      closeStream();
      opened?.close();
      throw error;
    } finally {
      connecting = false;
    }
  };

  /**
   * Ce qui était en vol à la coupure est perdu : le segment ouvert est répondu perdu, chaque élément de
   * la doublure encore attendu (en vol, garé) est refusé. Sans cela une place `parked` ou une requête
   * `prompt` jamais résolue bloquerait toute livraison.
   */
  const abandonInFlight = (): void => {
    epoch++;
    requestInFlight = false;
    endSegment({ kind: "lost" });
    for (const item of [...ownByMsgId.values()]) {
      if (item.inboxID !== undefined) abandonedInboxIDs.push(item.inboxID);
      settle(item);
      reply(item.message, `${o.name} : message non livré (service opencode redémarré)`);
    }
  };

  /** Une seule reconnexion par coupure : relire `service()` jusqu'à un service vivant dont le flux s'ouvre, ou renoncer. */
  const reconnect = async (): Promise<void> => {
    await pause(reconnectDelayMs);
    if (inactive()) return;
    const deadline = Date.now() + reconnectWindowMs;
    for (let attempt = 1; ; attempt++) {
      const info = readService();
      // Le fichier peut désigner un moment l'ancien service : seul un pid vivant dont le flux s'ouvre compte.
      if (info !== undefined && isProcessAlive(info.pid)) {
        try {
          const { client, active } = await connect(info, false);
          api = client;
          applyActive(active);
          logEvent("opencode-reconnect", { attempt, state });
          // Les éléments abandonnés qui dormiraient encore dans la boîte d'opencode n'y seront pas traités après coup.
          reconnecting = false;
          for (const inboxID of abandonedInboxIDs.splice(0)) dropLateInbox(client, inboxID);
          pump();
          return;
        } catch (error) {
          if (inactive()) return;
          logEvent("opencode-reconnect-attempt-failed", { attempt, error: errorMessage(error) });
        }
      }
      if (Date.now() >= deadline) break;
      await pause(reconnectPollMs);
      if (inactive()) return;
    }
    abandonedInboxIDs = [];
    reconnecting = false;
    await leaveBus("reconnect-failed");
  };

  // Ne lève jamais : un échec d'`onClose` serait avalé ou deviendrait un rejet non géré (réserve de `openEventStream`).
  const onClose = (error?: unknown): void => {
    if (!listening) return;
    listening = false;
    stream = undefined;
    state = "unknown";
    owner = "unknown";
    turnOpened = false;
    logEvent("opencode-stream-closed", error === undefined ? {} : { error: errorMessage(error) });
    // Pendant une ouverture, c'est elle qui constate la fermeture (`listening` faux) et décide de la suite.
    if (connecting || inactive()) return;
    abandonInFlight();
    reconnecting = true;
    reconnect().catch((failure: unknown) => {
      logEvent("opencode-reconnect-attempt-failed", { error: errorMessage(failure) });
      void leaveBus("reconnect-failed");
    });
  };

  /**
   * La doublure quitte le bus (session supprimée, ou service perdu) : chaque message en file est refusé,
   * l'inscription est retirée, puis le flux fermé. La TUI continue sans bus.
   */
  const leaveBus = async (reason: "session-not-found" | "reconnect-failed"): Promise<void> => {
    if (detached) return;
    detached = true;
    clearRetryTimer();
    await rejectQueuedMessages({ queue: o.queue, registration: o.registration, name: o.name, fromMode: o.fromMode, send, label: "opencode" });
    try {
      o.registration.unregister();
    } catch (error) {
      logEvent("cleanup-error", { step: "unregister", message: errorMessage(error) });
    }
    logEvent("opencode-lost", { reason });
    closeStream();
  };

  return {
    async beforeSpawn(): Promise<void> {
      if (stopped) throw new CourierUnavailableError(STOPPED_MESSAGE);
      const info = readService();
      if (info === undefined) throw new CourierUnavailableError("service opencode injoignable");
      try {
        const { client, active } = await connect(info, true);
        api = client;
        applyActive(active);
      } catch (error) {
        throw error instanceof CourierUnavailableError ? error : new CourierUnavailableError(errorMessage(error));
      }
      ready = true;
      pump();
    },

    afterSpawn(): void {},

    onMessage(): void {
      if (detached) {
        // Le livreur a quitté le bus : rien de ce qui arrive encore ne sera livré, l'expéditeur est prévenu.
        void rejectQueuedMessages({ queue: o.queue, registration: o.registration, name: o.name, fromMode: o.fromMode, send, label: "opencode" });
        return;
      }
      pump();
    },

    // Les messages passent par l'API du service, pas par `idnma read` ni par des hooks.
    read(): null {
      return null;
    },

    async hook(): Promise<Record<string, unknown>> {
      return {};
    },

    async verifyCaller(): Promise<boolean> {
      return false;
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      clearRetryTimer();
      cancelPause();
      closeStream();
    },
  };
}
