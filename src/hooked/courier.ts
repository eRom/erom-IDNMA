import type { FromMode } from "../bus/envelope.ts";
import type { InboundMessage } from "../bus/inbox.ts";
import type { Registration } from "../bus/register.ts";
import type { sendPeerMessage } from "../bus/send.ts";
import { logEvent } from "../log.ts";
import {
  CourierUnavailableError,
  isAutoReply,
  sendAutoReply,
  withReplyHint,
  type Courier,
} from "../understudy/courier.ts";
import type { Terminal } from "../understudy/pty.ts";
import type { MessageQueue } from "../understudy/queue.ts";
import { chunkShape, DraftTracker } from "./draft.ts";
import { DOORBELL_BYTES, DOORBELL_LINE, type HarnessAdapter, type HookSignal } from "./signals.ts";

export interface HookedCourierOptions {
  adapter: HarnessAdapter;
  name: string;
  fromMode: FromMode;
  registration: Registration;
  queue: MessageQueue;
  /** Envoi d'un message vers un pair (renvoi des réponses) ; défaut `sendPeerMessage`. */
  send?: typeof sendPeerMessage;
  /** Raison pour laquelle le harnais ne peut pas être livré (hooks absents) ; `undefined` si tout est prêt. */
  preflight?: () => string | undefined;
  /** Attente avant de taper la sonnette (1,5 s). */
  doorbellDelayMs?: number;
  /** Délai laissé à l'agent pour lire après la sonnette (15 s). */
  doorbellAnswerMs?: number;
  /** Nombre de sonnettes tentées pour un même message (3). */
  maxReadAttempts?: number;
  /** Plus long texte livré par un hook ; défaut `adapter.textLimit`. */
  hookTextLimit?: number;
  /** Relances d'un même tour de l'utilisateur au `Stop` (3). */
  maxContinuations?: number;
  /** Horloge ; défaut `Date.now`. */
  now?: () => number;
}

const DEFAULT_MAX_CONTINUATIONS = 3;
const DEFAULT_DOORBELL_DELAY_MS = 1_500;
const DEFAULT_DOORBELL_ANSWER_MS = 15_000;
const DEFAULT_MAX_READ_ATTEMPTS = 3;
// Relecture unique de la réponse finale quand le harnais ne l'a pas encore écrite à la fin du tour.
const REREAD_DELAY_MS = 500;

/** État que déduit un signal ; `unknown` (fin de tour sans repos fiable) laisse le statut publié inchangé. */
type HarnessState = "idle" | "busy" | "unknown";

/** Tour de l'utilisateur ouvert par un `turn-start` vu, fermé par son `turn-end`. */
interface UserTurn {
  openedAt: number;
  promptId: string | undefined;
  continuations: number;
}

type TurnEnd = Extract<HookSignal, { kind: "turn-end" }>;

/**
 * Tour ouvert par la sonnette : un seul message, sorti de la file à l'ouverture. `read` : l'agent l'a
 * lu (ou le hook le lui a livré) ; `mixed` : une entrée de l'utilisateur est entrée dans le tour (agy : le
 * `lastUserInput` d'un `PreInvocation` n'est ni la sonnette ni un texte injecté), la réponse finale
 * n'a plus de sens ; `muted` : le message est lui-même un renvoi automatique ; `injected` : textes que
 * les hooks ont injectés dans ce tour (agy les retrouve en `lastUserInput`).
 */
interface PeerTurn {
  message: InboundMessage | undefined;
  muted: boolean;
  read: boolean;
  mixed: boolean;
  promptId: string | undefined;
  injected: Set<string>;
}

/** Messages retirés de la file pour un hook, le texte livré pour chacun, et ces textes joints. */
interface Batch {
  messages: InboundMessage[];
  texts: string[];
  text: string;
}

const ENVELOPE_SEPARATOR = "\n\n";

/**
 * Livreur des harnais à hooks (Grok, agy) : état occupé/repos publié dans le registre de Claude à
 * partir des signaux des hooks, messages livrés en plein tour par la réponse d'un hook, tour de
 * l'utilisateur relancé à son `Stop` quand un message est arrivé pendant qu'il tournait. Un seul endroit
 * applique un signal : `applySignal`.
 */
export function createHookedCourier(o: HookedCourierOptions): Courier {
  const adapter = o.adapter;
  const now = o.now ?? Date.now;
  const hookTextLimit = o.hookTextLimit ?? adapter.textLimit;
  const maxContinuations = o.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
  const doorbellDelayMs = o.doorbellDelayMs ?? DEFAULT_DOORBELL_DELAY_MS;
  const doorbellAnswerMs = o.doorbellAnswerMs ?? DEFAULT_DOORBELL_ANSWER_MS;
  const maxReadAttempts = o.maxReadAttempts ?? DEFAULT_MAX_READ_ATTEMPTS;

  let stopped = false;
  // Dernier statut écrit dans le registre : on ne republie pas ce qui n'a pas changé.
  let published: "idle" | "busy" | undefined;
  // État déduit des signaux ; la sonnette ne part qu'au repos fiable (`idle`).
  let state: HarnessState = "unknown";
  let turn: UserTurn | undefined;
  let peerTurn: PeerTurn | undefined;
  let terminal: Terminal | undefined;
  let unsubscribeInput: (() => void) | undefined;
  const draft = new DraftTracker();
  // Sonnette tapée et pas encore suivie d'un `turn-start` : survit au délai de réponse (un tour tardif
  // reste reconnu), tombe au `turn-start` suivant quel qu'il soit.
  let doorbellPending = false;
  let doorbellTimer: ReturnType<typeof setTimeout> | undefined;
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  // Tous les minuteurs vivants, pour que `stop()` n'en laisse aucun partir.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // Sonnettes sans lecture par message (un message sorti de la file puis remis garde son compte).
  const unreadAttempts = new WeakMap<InboundMessage, number>();
  // Conversation du dernier `session-start`, `busy` ou `turn-start` vu hors tour ; tant qu'un tour est
  // ouvert, un signal d'une autre conversation (un `grok -p` ou un sous-agent) est ignoré.
  let conversationId: string | undefined;
  // Entrée de l'utilisateur sans `turn-start` derrière : un sélecteur ou un dialogue a pu s'ouvrir, un `idle`
  // n'y vaut rien jusqu'au prochain `turn-start`, `turn-end` ou `session-start`.
  let enterWithoutTurn = false;
  // Messages déjà journalisés comme trop longs pour un hook (une fois chacun).
  const loggedTooLong = new WeakSet<InboundMessage>();

  /** Seul endroit où l'état change : tout passage par ici garde la copie du statut publié à jour. */
  const setState = (next: HarnessState): void => {
    state = next;
    if (next === "unknown" || next === published) return;
    published = next;
    o.registration.setStatus(next);
  };

  const later = (ms: number, work: () => void): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) work();
    }, ms);
    timers.add(timer);
    return timer;
  };

  const cancelTimer = (timer: ReturnType<typeof setTimeout> | undefined): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(timer);
  };

  const cancelDoorbellTimer = (): void => {
    cancelTimer(doorbellTimer);
    doorbellTimer = undefined;
  };

  /** Tape la sonnette si les conditions tiennent encore : repos fiable, file non vide, brouillon propre, pas de sonnette en attente. */
  const ringDoorbell = (): void => {
    const oldest = o.queue.first(() => true);
    if (terminal === undefined || state !== "idle" || oldest === undefined || draft.dirty || doorbellPending) return;
    doorbellPending = true;
    terminal.write(DOORBELL_BYTES);
    logEvent("doorbell-rung", { harness: adapter.harness, msgId: oldest.msgId });
    cancelTimer(answerTimer);
    answerTimer = later(doorbellAnswerMs, () => {
      answerTimer = undefined;
      logEvent("doorbell-unanswered", { harness: adapter.harness });
      setState("unknown");
    });
  };

  /** Programme la sonnette après le délai de calme ; sans effet si elle ne peut pas partir ou si une est déjà programmée. */
  const scheduleDoorbell = (): void => {
    if (doorbellTimer !== undefined) return;
    if (terminal === undefined || state !== "idle" || draft.dirty || doorbellPending) return;
    if (o.queue.first(() => true) === undefined) return;
    doorbellTimer = later(doorbellDelayMs, () => {
      doorbellTimer = undefined;
      ringDoorbell();
    });
  };

  /** Ce que l'utilisateur tape : une frappe annule la sonnette programmée, une Entrée ferme aussi l'état (inconnu) et se retient jusqu'au prochain tour. */
  const onTyped = (chunk: string): void => {
    if (stopped) return;
    const wasDirty = draft.dirty;
    const kind = draft.feed(chunk);
    if (kind === "noise") return;
    if (kind === "keystroke" && !wasDirty) {
      // Une ligne par brouillon, sans aucun octet tapé : de quoi reconnaître une séquence de terminal prise pour une frappe.
      logEvent("draft-dirty", { harness: adapter.harness, shape: chunkShape(chunk), length: chunk.length });
    }
    cancelDoorbellTimer();
    if (kind !== "enter") return;
    setState("unknown");
    enterWithoutTurn = true;
  };

  /** Un message livrable dans le tour courant : `now` toujours, `next` s'il est arrivé depuis l'ouverture du tour. */
  const isDeliverable = (message: InboundMessage): boolean => {
    if (message.priority === "now") return true;
    if (message.priority === "next") return turn !== undefined && message.receivedAt >= turn.openedAt;
    return false;
  };

  /**
   * Retire de la file les messages livrables, du plus ancien au plus récent, tant que leurs enveloppes
   * jointes tiennent dans la limite d'un hook. Un message trop long à lui seul est sauté et reste en
   * file ; un message qui ne tient pas avec les précédents attend le hook suivant (l'ordre est gardé).
   */
  const takeBatch = (): Batch | undefined => {
    const messages: InboundMessage[] = [];
    const texts: string[] = [];
    const passed = new Set<InboundMessage>();
    let length = 0;
    for (;;) {
      const next = o.queue.first((m) => !passed.has(m) && isDeliverable(m));
      if (next === undefined) break;
      passed.add(next);
      // Livré dans un tour qui n'a pas été ouvert pour lui : avec le rappel de réponse.
      const text = withReplyHint(next.content);
      const size = text.length;
      if (size > hookTextLimit) {
        if (!loggedTooLong.has(next)) {
          loggedTooLong.add(next);
          logEvent("hook-text-too-long", { harness: adapter.harness, msgId: next.msgId, length: size, limit: hookTextLimit });
        }
        continue;
      }
      const joined = length + (messages.length === 0 ? 0 : ENVELOPE_SEPARATOR.length) + size;
      if (joined > hookTextLimit) break;
      messages.push(next);
      texts.push(text);
      length = joined;
    }
    if (messages.length === 0) return undefined;
    for (const message of messages) o.queue.remove(message);
    return { messages, texts, text: texts.join(ENVELOPE_SEPARATOR) };
  };

  /** Livraison en plein tour : réponse d'hook qui injecte les messages livrables, `{}` s'il n'y en a pas. */
  const deliverNow = (hookEvent: string): Record<string, unknown> => {
    const batch = takeBatch();
    if (batch === undefined) return {};
    if (peerTurn !== undefined) {
      peerTurn.injected.add(batch.text);
      for (const text of batch.texts) peerTurn.injected.add(text);
    }
    logEvent("hook-delivered", { harness: adapter.harness, hookEvent, msgIds: batch.messages.map((m) => m.msgId) });
    return adapter.deliveryReply(hookEvent, batch.text);
  };

  /** Relance du tour de l'utilisateur au `Stop` : `{}` si rien n'est livrable ou si le tour a épuisé ses relances. */
  const continueTurn = (hookEvent: string, current: UserTurn): Record<string, unknown> | undefined => {
    if (current.continuations >= maxContinuations) return undefined;
    const batch = takeBatch();
    if (batch === undefined) return undefined;
    current.continuations++;
    logEvent("hook-continued", { harness: adapter.harness, hookEvent, msgIds: batch.messages.map((m) => m.msgId) });
    return adapter.continueReply(batch.text);
  };

  /** Texte renvoyé à l'expéditeur selon l'issue du tour ; `undefined` quand la réponse finale n'est pas (encore) lisible. */
  const outcomeText = (end: TurnEnd): string | undefined => {
    if (end.outcome === "interrupted") return `${o.name} : tour interrompu`;
    if (end.outcome === "failed") return `${o.name} : tour en échec (${end.detail ?? "erreur inconnue"})`;
    return adapter.finalAnswer(end);
  };

  /** Renvoi automatique, après la réponse au hook (jamais de retard sur le harnais) ; une seule relecture si la réponse manque. */
  const replyLater = (message: InboundMessage, end: TurnEnd): void => {
    later(0, () => {
      const text = outcomeText(end);
      if (text !== undefined) {
        void sendAutoReply(o, message, text);
        return;
      }
      later(REREAD_DELAY_MS, () => {
        void sendAutoReply(o, message, outcomeText(end) ?? `${o.name} : tour terminé sans réponse`);
      });
    });
  };

  /** Tour de pair mêlé à une entrée de l'utilisateur : l'expéditeur n'attend plus en silence. */
  const noticeMixedLater = (message: InboundMessage): void => {
    later(0, () => {
      void sendAutoReply(o, message, `${o.name} : tour mêlé à une entrée de l'utilisateur, pas de réponse automatique`);
    });
  };

  /** Message non lu à la fin du tour : remis en tête de file, ou rejeté (sans réponse s'il est muet) à la dernière tentative. */
  const settleUnread = (message: InboundMessage, muted: boolean): void => {
    const attempts = (unreadAttempts.get(message) ?? 0) + 1;
    unreadAttempts.set(message, attempts);
    if (attempts < maxReadAttempts) {
      o.queue.unshift(message);
      return;
    }
    logEvent("doorbell-unread", { harness: adapter.harness, msgId: message.msgId });
    if (muted) return;
    later(0, () => {
      void sendAutoReply(o, message, `${o.name} : message non livré (${adapter.label} n'a pas lu le message)`);
    });
  };

  /** Ferme le tour de pair ouvert ; l'état (repos ou inconnu) suit `end.reliableIdle`. */
  const closePeerTurn = (end: TurnEnd): void => {
    const closing = peerTurn;
    if (closing === undefined) return;
    peerTurn = undefined;
    const message = closing.message;
    if (message !== undefined) {
      if (!closing.read) settleUnread(message, closing.muted);
      else if (!closing.muted) {
        if (closing.mixed) noticeMixedLater(message);
        else replyLater(message, end);
      }
    }
    setState(end.reliableIdle ? "idle" : "unknown");
  };

  /**
   * Un `turn-start`, `idle` ou `session-start` alors qu'un tour est ouvert : sa fin a été perdue. Le
   * tour de l'utilisateur est libéré aussi, sinon sa conversation resterait retenue et une session neuve
   * (`/new`, `/clear`) serait ignorée comme étrangère jusqu'à la relance du pane.
   */
  const closeLostTurn = (): void => {
    turn = undefined;
    closePeerTurn({ kind: "turn-end", outcome: "interrupted", reliableIdle: false });
  };

  /** Ouvre un tour de pair : le plus ancien message (toute priorité) sort de la file, livré par le hook si le harnais le permet. */
  const openPeerTurn = (signal: Extract<HookSignal, { kind: "turn-start" }>, hookEvent: string): Record<string, unknown> => {
    const message = o.queue.shift();
    const opened: PeerTurn = {
      message,
      muted: message !== undefined && isAutoReply(message.content),
      read: false,
      mixed: false,
      promptId: signal.promptId,
      injected: new Set(),
    };
    peerTurn = opened;
    if (message === undefined) return {};
    if (!signal.canDeliver || message.content.length > hookTextLimit) return {};
    opened.read = true;
    opened.injected.add(message.content);
    logEvent("hook-delivered", { harness: adapter.harness, hookEvent, msgIds: [message.msgId] });
    return adapter.deliveryReply(hookEvent, message.content);
  };

  /** agy : un `PreInvocation` du tour de pair qui porte une entrée de l'utilisateur (ni la sonnette ni un texte injecté) mêle le tour. */
  const noteUserInput = (userInput: string | undefined): void => {
    if (peerTurn === undefined || peerTurn.mixed || userInput === undefined) return;
    if (userInput === DOORBELL_LINE || peerTurn.injected.has(userInput)) return;
    peerTurn.mixed = true;
    logEvent("peer-turn-mixed", { harness: adapter.harness });
  };

  const reduceSignal = (signal: HookSignal, hookEvent: string): Record<string, unknown> => {
    switch (signal.kind) {
      case "session-start":
        closeLostTurn();
        // Une session neuve a une zone de saisie vide.
        draft.reset();
        enterWithoutTurn = false;
        setState("idle");
        return {};
      case "idle":
        // Après un Entrée sans tour, `idle_prompt` ne prouve pas que la zone de saisie est libre.
        if (enterWithoutTurn) return {};
        closeLostTurn();
        setState("idle");
        return {};
      case "busy":
        setState("busy");
        return {};
      case "unknown":
        logEvent("state-unknown", { harness: adapter.harness, hookEvent, ...(signal.reason === undefined ? {} : { reason: signal.reason }) });
        setState("unknown");
        return {};
      case "turn-start": {
        enterWithoutTurn = false;
        closeLostTurn();
        const isPeerTurn = signal.prompt === DOORBELL_LINE && doorbellPending;
        doorbellPending = false;
        cancelTimer(answerTimer);
        answerTimer = undefined;
        setState("busy");
        if (isPeerTurn) {
          turn = undefined;
          return openPeerTurn(signal, hookEvent);
        }
        turn = { openedAt: now(), promptId: signal.promptId, continuations: 0 };
        return signal.canDeliver ? deliverNow(hookEvent) : {};
      }
      case "mid-turn":
        noteUserInput(signal.userInput);
        setState("busy");
        return deliverNow(hookEvent);
      case "turn-end": {
        // Grok peut livrer le `StopCancelled` d'un prompt après le `UserPromptSubmit` du suivant.
        const openPromptId = peerTurn !== undefined ? peerTurn.promptId : turn?.promptId;
        if (openPromptId !== undefined && signal.promptId !== undefined && signal.promptId !== openPromptId) return {};
        enterWithoutTurn = false;
        if (peerTurn !== undefined) {
          // Un tour de pair ne relance jamais.
          closePeerTurn(signal);
          return {};
        }
        if (signal.outcome === "completed" && turn !== undefined) {
          const reply = continueTurn(hookEvent, turn);
          if (reply !== undefined) return reply;
        }
        turn = undefined;
        setState(signal.reliableIdle ? "idle" : "unknown");
        return {};
      }
      case "ignore":
        return {};
    }
  };

  /**
   * Seul endroit où un signal modifie l'état du livreur et produit la réponse du hook. Tout événement
   * annule la sonnette programmée ; si le signal laisse le harnais au repos fiable, elle repart.
   */
  const applySignal = (signal: HookSignal, hookEvent: string): Record<string, unknown> => {
    cancelDoorbellTimer();
    const reply = reduceSignal(signal, hookEvent);
    scheduleDoorbell();
    return reply;
  };

  return {
    async beforeSpawn() {
      const reason = o.preflight?.();
      if (reason !== undefined) throw new CourierUnavailableError(reason);
    },
    afterSpawn(spawned) {
      if (stopped || spawned === undefined || terminal !== undefined) return;
      terminal = spawned;
      unsubscribeInput = spawned.onInput(onTyped);
    },
    onMessage() {
      if (stopped) return;
      scheduleDoorbell();
      // Message arrivé sans sonnette programmée : le journal dit ce qui la retient.
      if (doorbellTimer === undefined) {
        logEvent("doorbell-withheld", { harness: adapter.harness, state, dirty: draft.dirty, enterWithoutTurn, pending: doorbellPending });
      }
    },
    // Seule la voie du jeton ouvre le canal : un hook n'authentifie personne.
    async verifyCaller() {
      return false;
    },
    read() {
      if (peerTurn !== undefined) {
        // Tour de pair : son message une fois, puis plus rien (un seul message par tour).
        const message = peerTurn.message;
        if (message === undefined || peerTurn.read) return null;
        peerTurn.read = true;
        return message.content;
      }
      // Hors tour de pair : le plus ancien message, toute priorité (spec §8). La réponse finale de ce
      // tour ne revient pas à l'expéditeur : l'indice le dit, comme pour un message livré par hook.
      const oldest = o.queue.shift();
      return oldest === undefined ? null : withReplyHint(oldest.content);
    },
    async hook(harness, event, payload) {
      if (stopped) return {};
      if (harness !== adapter.harness) {
        logEvent("hook-wrong-harness", { harness, hookEvent: event });
        return {};
      }
      const signal = adapter.signal(event, payload);
      if (signal.kind === "ignore") return {};
      const seen = signal.conversationId;
      if (seen !== undefined && conversationId !== undefined && seen !== conversationId) {
        // Un tour ouvert appartient à sa conversation : un `grok -p`, un `agy -p` ou un sous-agent n'y touche pas.
        if (turn !== undefined || peerTurn !== undefined) {
          logEvent("foreign-conversation", { harness: adapter.harness, hookEvent: event, conversationId: seen });
          return {};
        }
      }
      // Hors tour, une session neuve de l'utilisateur (`/new`, `/clear`) est adoptée.
      if (seen !== undefined && (signal.kind === "session-start" || signal.kind === "busy" || signal.kind === "turn-start")) {
        conversationId = seen;
      }
      return applySignal(signal, event);
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      doorbellTimer = undefined;
      answerTimer = undefined;
      unsubscribeInput?.();
      unsubscribeInput = undefined;
    },
  };
}
