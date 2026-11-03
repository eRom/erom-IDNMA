import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { FromMode } from "../bus/envelope.ts";
import type { InboundMessage } from "../bus/inbox.ts";
import { isDescendantOf, peerPidOf } from "../bus/peer-pid.ts";
import type { Registration } from "../bus/register.ts";
import { sendPeerMessage } from "../bus/send.ts";
import { errorMessage, logEvent } from "../log.ts";
import { ensureControlDir } from "../understudy/control.ts";
import {
  CourierUnavailableError,
  isAutoReply,
  rejectQueuedMessages,
  replyHintFor,
  sendAutoReply,
  senderNameOf,
  waitBounded,
  type Courier,
} from "../understudy/courier.ts";
import type { MessageQueue } from "../understudy/queue.ts";
import {
  BRIDGE_PROTOCOL_VERSION,
  createLineReader,
  encodeFrame,
  parsePluginFrame,
  type DeliverFrame,
  type DeliveryMode,
  type DroppedFrame,
  type HelloFrame,
  type PluginFrame,
  type ResultFrame,
  type StateFrame,
} from "./protocol.ts";

export interface DstCourierOptions {
  name: string;
  fromMode: FromMode;
  registration: Registration;
  queue: MessageQueue;
  /** Socket du pont, dans un dossier privé. */
  socketPath: string;
  /** Jeton que le `hello` du plugin doit présenter. */
  token: string;
  send?: typeof sendPeerMessage;
  /** Admission par pid noyau ; défaut : pid connu et descendant de ce process (`isDescendantOf`). */
  isAllowedPeer?: (pid: number | undefined) => boolean;
  /** Délai pour la première trame d'une connexion (défaut 5 000 ms). */
  admissionTimeoutMs?: number;
  /** Attente du premier `hello`, armée par `afterSpawn` (défaut 30 000 ms). */
  helloTimeoutMs?: number;
  /** Fenêtre de grâce après une coupure du pont (défaut 30 000 ms). */
  graceMs?: number;
  /** Nombre d'essais d'un message que dst ne prend pas (défaut 3). */
  maxAttempts?: number;
}

const DEFAULT_ADMISSION_TIMEOUT_MS = 5_000;
const DEFAULT_HELLO_TIMEOUT_MS = 30_000;
const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const FAREWELL_WAIT_MS = 3_000;
const STOPPED_MESSAGE = "le livreur dst est arrêté";

/** `waiting` avant le premier hello, `up` admis, `down` coupé en grâce, `gone` perdu ou jamais venu, `closed` après les adieux. */
type Phase = "waiting" | "up" | "down" | "gone" | "closed";

/** Un message envoyé au plugin (`deliver`), suivi jusqu'à son issue. Indexé par l'id du fil dès l'envoi. */
interface Entry {
  message: InboundMessage;
  /** Le message ouvrant est lui-même un renvoi automatique : rien ne lui est renvoyé. */
  muted: boolean;
  /** Connu par `delivered` ; absent tant que la trame n'est pas passée. */
  mode?: DeliveryMode;
  /** Le plugin a réclamé le message (`claimed`) : une réponse était attendue. */
  claimed: boolean;
}

function tokenMatches(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Texte renvoyé à l'expéditeur pour la fin d'un tour (spec §9.2), et l'issue journalisée. */
function describeResult(name: string, frame: ResultFrame): { outcome: string; text: string } {
  const text = frame.text !== undefined && frame.text.trim() !== "" ? frame.text : undefined;
  if (frame.mixed) return { outcome: "mixed", text: `${name} : tour mêlé à une entrée de l'utilisateur, pas de réponse automatique` };
  switch (frame.reason) {
    case "completed":
      return text === undefined ? { outcome: "no-text", text: `${name} : tour terminé sans réponse` } : { outcome: "replied", text };
    case "error": {
      const detail = [frame.error?.message, frame.error?.code].filter((part) => part !== undefined && part !== "").join(", ");
      return { outcome: "failed", text: detail === "" ? `${name} : tour en échec` : `${name} : tour en échec (${detail})` };
    }
    case "aborted":
      if (frame.cause === "user") return { outcome: "interrupted", text: `${name} : tour interrompu par l'utilisateur` };
      if (frame.cause === "disposed") return { outcome: "lost", text: `${name} : réponse perdue (session fermée dans dst)` };
      return { outcome: "interrupted", text: frame.cause === undefined ? `${name} : tour interrompu` : `${name} : tour interrompu (${frame.cause})` };
    case "disposed":
      return { outcome: "lost", text: `${name} : réponse perdue (session fermée dans dst)` };
    case "max-tokens":
      return text === undefined
        ? { outcome: "truncated", text: `${name} : tour coupé (limite de tokens atteinte)` }
        : { outcome: "truncated", text: `${text}\n(${name} : réponse tronquée, limite de tokens atteinte)` };
    default:
      return { outcome: "other", text: `${name} : tour terminé sans réponse (${frame.reason})` };
  }
}

/**
 * Livreur de l'agent dst : la doublure écoute un socket Unix privé (le pont) que le plugin idnma,
 * chargé dans le process de dst, rejoint. Le plugin porte la sémantique de dst (premier plan,
 * `followup` ou `steer`, tours) ; le livreur porte celle du bus : file, admission, renvois
 * automatiques à l'expéditeur, statut du registre, coupures et adieux (spec §7 et §9).
 *
 * État :
 * - `phase` : `waiting | up | down | gone | closed` ;
 * - `conn` : la connexion admise, une seule à la fois ; une nouvelle admission remplace l'ancienne ;
 * - `mirror` : le dernier `state` du plugin, remis à `{ session: null, status: idle }` à chaque admission ;
 * - `entries` : les messages envoyés en `deliver`, indexés par l'id du fil.
 */
export function createDstCourier(o: DstCourierOptions): Courier {
  const send = o.send ?? sendPeerMessage;
  const admissionTimeoutMs = o.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  const helloTimeoutMs = o.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const graceMs = o.graceMs ?? DEFAULT_GRACE_MS;
  const maxAttempts = o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const isAllowedPeer =
    o.isAllowedPeer ??
    ((pid: number | undefined): boolean => {
      if (pid === undefined) return false;
      try {
        return isDescendantOf(pid, process.pid);
      } catch {
        return false;
      }
    });

  let phase: Phase = "waiting";
  let stopped = false;
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  let conn: Socket | undefined;
  // Un `hello` a déjà été admis au moins une fois : le suivant est une reconnexion.
  let everUp = false;
  // Un `hello` a été refusé : dit pourquoi le plugin n'est jamais venu.
  let helloRefused = false;
  // Texte entre parenthèses du refus d'un message quand la phase est `gone`.
  let goneReason = "pont dst perdu";
  let mirror: { session: string | null; status: StateFrame["status"] } = { session: null, status: "idle" };
  // Dernier statut publié au registre (l'inscription démarre `idle`).
  let published: "idle" | "busy" = "idle";
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const entries = new Map<string, Entry>();
  const failedAttempts = new WeakMap<InboundMessage, number>();
  // Messages remis en tête de file après un échec : ils gardent leur ordre d'origine devant les autres.
  const requeued = new WeakSet<InboundMessage>();

  // Renvois partis et pas encore terminés : `farewell()` les attend, sinon la sortie du process coupe un envoi en vol.
  const outstanding = new Set<Promise<void>>();

  /** Suit `work` (qui ne lève jamais) jusqu'à son terme. */
  const track = (work: Promise<void>): Promise<void> => {
    outstanding.add(work);
    const settle = (): void => {
      outstanding.delete(work);
    };
    work.then(settle, settle);
    return work;
  };

  const reply = (message: InboundMessage, text: string): Promise<void> =>
    track(sendAutoReply({ registration: o.registration, name: o.name, fromMode: o.fromMode, send }, message, text));

  /** Attend tous les renvois en cours, y compris ceux qui partent pendant l'attente. */
  const drainOutstanding = async (): Promise<void> => {
    while (outstanding.size > 0) await Promise.all([...outstanding]);
  };

  const publish = (status: "idle" | "busy"): void => {
    if (published === status) return;
    published = status;
    o.registration.setStatus(status);
  };

  const resetMirror = (): void => {
    mirror = { session: null, status: "idle" };
    publish("idle");
  };

  const clearHelloTimer = (): void => {
    if (helloTimer !== undefined) clearTimeout(helloTimer);
    helloTimer = undefined;
  };

  const clearGraceTimer = (): void => {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    graceTimer = undefined;
  };

  // --- Phases et refus -------------------------------------------------------------------------

  const refuseQueue = (): void => {
    for (let message = o.queue.shift(); message !== undefined; message = o.queue.shift()) {
      void reply(message, `${o.name} : message non livré (${goneReason})`);
    }
  };

  const goGone = (event: string, reason: string): void => {
    phase = "gone";
    goneReason = reason;
    logEvent(event);
    refuseQueue();
  };

  /** Chaque envoi en vol reçoit tout de suite sa réponse de coupure (spec §9.4) ; la table est vidée. */
  const answerInFlightAsLost = (): void => {
    for (const entry of entries.values()) {
      if (entry.muted) continue;
      const lead = entry.claimed ? "réponse perdue" : "message non livré";
      void reply(entry.message, `${o.name} : ${lead} (dst arrêté ou relancé)`);
    }
    entries.clear();
  };

  // --- Livraison -------------------------------------------------------------------------------

  const write = (frame: object): void => {
    if (conn === undefined || conn.destroyed) return;
    conn.write(encodeFrame(frame));
  };

  const sendDeliver = (message: InboundMessage): void => {
    const id = randomUUID();
    requeued.delete(message);
    entries.set(id, { message, muted: isAutoReply(message.content), claimed: false });
    const frame: DeliverFrame = {
      type: "deliver",
      id,
      priority: message.priority,
      sender: senderNameOf(message.content) ?? "idnma",
      text: message.content,
    };
    const hint = replyHintFor(message.content);
    if (hint !== undefined) frame.hint = hint;
    write(frame);
  };

  /** Tout ce qui attend part, dès qu'un plugin admis annonce une session au premier plan. */
  const flush = (): void => {
    if (phase !== "up" || conn === undefined || mirror.session === null) return;
    for (let message = o.queue.shift(); message !== undefined; message = o.queue.shift()) sendDeliver(message);
  };

  const requeue = (message: InboundMessage): void => {
    const ahead: InboundMessage[] = [];
    for (let head = o.queue.first(() => true); head !== undefined && requeued.has(head); head = o.queue.first(() => true)) {
      o.queue.shift();
      ahead.push(head);
    }
    ahead.push(message);
    requeued.add(message);
    for (let index = ahead.length - 1; index >= 0; index--) {
      const item = ahead[index];
      if (item !== undefined) o.queue.unshift(item);
    }
  };

  /** Fin de suivi d'un envoi : l'issue part au journal, et le texte à l'expéditeur sauf renvoi automatique. */
  const finish = (entry: Entry, outcome: string, text: string, sources: string[]): void => {
    logEvent("dst-turn-end", { msgId: entry.message.msgId, outcome: entry.muted ? "muted" : outcome, sources });
    if (!entry.muted) void reply(entry.message, text);
  };

  // --- Trames du plugin ------------------------------------------------------------------------

  const onState = (frame: StateFrame): void => {
    if (frame.session !== mirror.session) logEvent("dst-foreground", { session: frame.session });
    mirror = { session: frame.session, status: frame.status };
    publish(frame.status === "running" ? "busy" : "idle");
    flush();
  };

  const onDelivered = (id: string, mode: DeliveryMode): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    entry.mode = mode;
    logEvent("dst-deliver", { msgId: entry.message.msgId, delivery: mode });
    // Un steer réclamé est réglé : le rappel dit de répondre par `idnma peer send`, rien ne revient.
    if (mode === "steer" && entry.claimed) entries.delete(id);
  };

  const onClaimed = (id: string, turn: number): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    entry.claimed = true;
    logEvent("dst-claimed", { msgId: entry.message.msgId, turn });
    if (entry.mode === "steer") entries.delete(id);
  };

  const onResult = (frame: ResultFrame): void => {
    const entry = entries.get(frame.id);
    if (entry === undefined) return;
    entries.delete(frame.id);
    const { outcome, text } = describeResult(o.name, frame);
    finish(entry, outcome, text, frame.sources);
  };

  const onDropped = (frame: DroppedFrame): void => {
    const entry = entries.get(frame.id);
    if (entry === undefined) return;
    entries.delete(frame.id);
    // Jamais le message d'exception de dsh au journal : il peut citer le texte du message.
    logEvent("dst-dropped", { msgId: entry.message.msgId, why: frame.why });
    if (frame.why === "discarded") {
      finish(entry, "discarded", `${o.name} : message écarté (l'utilisateur a interrompu dst)`, []);
      return;
    }
    if (frame.why === "rejected") {
      const cause = frame.error === undefined || frame.error === "" ? "" : ` : ${frame.error}`;
      finish(entry, "rejected", `${o.name} : message non livré (dst l'a refusé${cause})`, []);
      return;
    }
    // `disposed` et `no-agent` : le message repart à la `state` que le plugin envoie juste après.
    const failures = (failedAttempts.get(entry.message) ?? 0) + 1;
    failedAttempts.set(entry.message, failures);
    if (failures >= maxAttempts) {
      if (!entry.muted) void reply(entry.message, `${o.name} : message non livré (dst ne l'a pas pris)`);
      return;
    }
    requeue(entry.message);
  };

  const onFrame = (frame: PluginFrame): void => {
    switch (frame.type) {
      case "state":
        return onState(frame);
      case "delivered":
        return onDelivered(frame.id, frame.mode);
      case "claimed":
        return onClaimed(frame.id, frame.turn);
      case "result":
        return onResult(frame);
      case "dropped":
        return onDropped(frame);
      case "error":
        logEvent("dst-plugin-error", { code: frame.code });
        return;
      case "hello":
        // Déjà admis sur cette connexion : un second hello ne change rien.
        return;
    }
  };

  // --- Connexions ------------------------------------------------------------------------------

  const admit = (socket: Socket, hello: HelloFrame): void => {
    const reconnect = everUp;
    everUp = true;
    clearHelloTimer();
    clearGraceTimer();
    const previous = conn;
    conn = socket;
    if (previous !== undefined) {
      // Rechargement du plugin ou relance de dst : l'ancienne connexion est une coupure.
      previous.destroy();
      logEvent("dst-bridge-lost", { replaced: true });
      answerInFlightAsLost();
    }
    phase = "up";
    resetMirror();
    logEvent("dst-bridge-up", { pid: hello.pid, versions: hello.versions, reconnect });
  };

  /** La connexion admise s'est fermée sans que la doublure l'ait voulu : fenêtre de grâce. */
  const onConnectionLost = (): void => {
    conn = undefined;
    resetMirror();
    logEvent("dst-bridge-lost");
    answerInFlightAsLost();
    phase = "down";
    clearGraceTimer();
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      goGone("dst-bridge-gone", "pont dst perdu");
    }, graceMs);
  };

  const onConnection = (socket: Socket): void => {
    // Un écouteur `error` avant toute autre opération : une erreur de socket sans écouteur ferait tomber la doublure.
    socket.on("error", () => {});
    if (stopped || phase === "closed") {
      logEvent("dst-bridge-refused", { reason: "closed" });
      socket.destroy();
      return;
    }
    sockets.add(socket);
    // Le pid noyau se lit dès l'acceptation, avant que la connexion ait pu se fermer.
    const peerPid = peerPidOf(socket);
    let admitted = false;
    let refused = false;

    const refuse = (reason: string, wasHello = false): void => {
      if (admitted || refused) return;
      refused = true;
      clearTimeout(timer);
      if (wasHello) helloRefused = true;
      logEvent("dst-bridge-refused", { reason });
      socket.destroy();
    };
    const timer = setTimeout(() => refuse("timeout"), admissionTimeoutMs);

    const onLine = (line: string): void => {
      if (refused || line.trim() === "") return;
      // Connexion remplacée entre-temps : ses trames ne comptent plus.
      if (admitted && socket !== conn) return;
      const frame = parsePluginFrame(line);
      if (frame === undefined) logEvent("dst-frame-invalid", { length: Buffer.byteLength(line) });
      if (admitted) {
        if (frame !== undefined) onFrame(frame);
        return;
      }
      if (frame === undefined || frame.type !== "hello") return refuse("not-hello");
      if (frame.v !== BRIDGE_PROTOCOL_VERSION) return refuse("version", true);
      if (!tokenMatches(frame.token, o.token)) return refuse("token", true);
      if (!isAllowedPeer(peerPid)) return refuse("peer", true);
      admitted = true;
      clearTimeout(timer);
      admit(socket, frame);
    };

    const reader = createLineReader(onLine, () => {
      if (admitted) socket.destroy();
      else refuse("frame-too-large");
    });
    socket.on("data", reader);
    socket.on("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
      if (admitted && socket === conn && !stopped) onConnectionLost();
    });
  };

  /** Ouvre le pont : dossier privé, reste retiré, socket en 600. */
  const listen = async (): Promise<void> => {
    const bridge = createServer(onConnection);
    server = bridge;
    // Un échec d'écoute arrive en événement `error`, pas en exception : avant l'écoute il rejette le
    // démarrage ; après, il part au journal (le harnais tient alors stdout et stderr).
    let listening = false;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      bridge.on("error", (error: NodeJS.ErrnoException) => {
        if (!listening) {
          rejectReady(new CourierUnavailableError(`impossible d'ouvrir le pont dst sur ${o.socketPath} (${error.code ?? error.message})`));
          return;
        }
        logEvent("dst-bridge-error", { message: errorMessage(error) });
      });
      bridge.once("listening", () => {
        listening = true;
        resolveReady();
      });
    });
    // Un reste au même chemin (crash d'un process au pid réutilisé) empêcherait l'écoute.
    rmSync(o.socketPath, { force: true });
    // Masque 077 le temps de la création du socket (liaison synchrone sous Bun), puis chmod 600.
    const previousMask = process.umask(0o077);
    try {
      bridge.listen(o.socketPath);
    } finally {
      process.umask(previousMask);
    }
    await ready;
    try {
      chmodSync(o.socketPath, 0o600);
    } catch (error) {
      bridge.close();
      throw new CourierUnavailableError(errorMessage(error));
    }
    logEvent("dst-bridge-listening");
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearHelloTimer();
    clearGraceTimer();
    // Les connexions sont fermées par la doublure : leur `close` ne passe pas pour une coupure.
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    conn = undefined;
    server?.close();
    rmSync(o.socketPath, { force: true });
  };

  return {
    async beforeSpawn(): Promise<void> {
      if (stopped) throw new CourierUnavailableError(STOPPED_MESSAGE);
      try {
        ensureControlDir(dirname(o.socketPath));
      } catch (error) {
        throw new CourierUnavailableError(errorMessage(error));
      }
      try {
        await listen();
      } catch (error) {
        server?.close();
        throw error instanceof CourierUnavailableError ? error : new CourierUnavailableError(errorMessage(error));
      }
    },

    afterSpawn(): void {
      if (stopped || phase !== "waiting" || helloTimer !== undefined) return;
      helloTimer = setTimeout(() => {
        helloTimer = undefined;
        if (phase !== "waiting") return;
        goGone("dst-bridge-missing", helloRefused ? "pont dst refusé, voir le journal idnma" : "le plugin idnma ne s'est pas chargé dans dst");
      }, helloTimeoutMs);
    },

    onMessage(): void {
      if (phase === "closed") {
        void track(rejectQueuedMessages({ queue: o.queue, registration: o.registration, name: o.name, fromMode: o.fromMode, send, label: "dst" }));
        return;
      }
      if (phase === "gone") {
        refuseQueue();
        return;
      }
      flush();
    },

    // Les messages passent par le pont, pas par `idnma read` ni par des hooks.
    read(): null {
      return null;
    },

    async hook(): Promise<Record<string, unknown>> {
      return {};
    },

    async verifyCaller(): Promise<boolean> {
      return false;
    },

    stop,

    async farewell(): Promise<void> {
      if (phase === "closed") return;
      stop();
      phase = "closed";
      answerInFlightAsLost();
      void track(rejectQueuedMessages({ queue: o.queue, registration: o.registration, name: o.name, fromMode: o.fromMode, send, label: "dst" }));
      // Les renvois de coupure partis plus tôt sont dans `outstanding` : les adieux les attendent aussi.
      await waitBounded(drainOutstanding(), FAREWELL_WAIT_MS);
    },
  };
}
