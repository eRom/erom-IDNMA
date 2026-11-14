import type { DeliveryRule } from "../acp/harness.ts";
import type { FromMode } from "../bus/envelope.ts";
import type { InboundMessage } from "../bus/inbox.ts";
import type { Registration } from "../bus/register.ts";
import type { sendPeerMessage } from "../bus/send.ts";
import { isAutoReply, rejectQueuedMessages, sendAutoReply, senderNameOf } from "../understudy/courier.ts";
import type { MessageQueue } from "../understudy/queue.ts";

export interface PeerDeliveryDeps {
  rule: DeliveryRule;
  name: string;
  label: "Claude" | "agy";
  queue: MessageQueue;
  registration: Registration;
  /** Suit le mode réel de la session ; relu à chaque envoi, jamais mis en cache. */
  fromMode(): FromMode;
  isIdle(): boolean;
  /** Ouvre le tour du pair et l'affiche. */
  startPeerTurn(prompt: string, display: { from: string; text: string }): void;
  showHeld(message: { from: string; text: string }, queued: number): void;
  /** À chaque mouvement de la file, tour en cours ou non (règle `held` seulement). */
  heldCountChanged(queued: number): void;
  send?: typeof sendPeerMessage;
}

export interface PeerDelivery {
  /** Un message vient d'entrer en file (le runner l'y a déjà poussé). */
  onMessage(): void;
  /** L'écran revient au repos : livre (auto) ou présente (held) le premier message. */
  onIdle(): void;
  /** Texte de l'agent pour le tour courant. */
  onTurnText(text: string): void;
  /** Événement d'outil : la réponse finale repart de zéro. */
  onTurnTool(): void;
  /** Fin du tour ; renvoie la réponse finale si c'était le tour d'un pair. */
  onTurnEnded(stopReason: string): Promise<void>;
  deliverHeld(): void;
  laterHeld(): void;
  dismissHeld(): Promise<void>;
  /** ⌃R : au repos, présente le premier message retenu et lève la suspension posée par « Later ». */
  reopenHeld(): void;
  /** Agent mort : « réponse perdue » au pair du tour en cours. */
  agentLost(): Promise<void>;
  /** Sortie : chaque expéditeur en file apprend que son message n'a pas été livré. */
  leave(): Promise<void>;
}

const OPEN_TAG_START = "<cross-session-message ";
const CLOSE_TAG = "\n</cross-session-message>";

/**
 * Le corps d'une enveloppe reçue : le texte entre la première ligne et la dernière balise fermante.
 * Tout autre contenu est rendu tel quel. La balise fermante échappée dans le corps n'est pas
 * dé-échappée (une balise rare s'affiche telle quelle).
 */
export function envelopeBody(content: string): string {
  const firstBreak = content.indexOf("\n");
  if (firstBreak === -1 || !content.startsWith(OPEN_TAG_START) || !content.endsWith(CLOSE_TAG)) return content;
  return content.slice(firstBreak + 1, content.length - CLOSE_TAG.length);
}

/** Le texte livré à l'agent pour le tour d'un pair : la ligne d'orientation, puis le corps reçu. */
export function peerPrompt(from: string, body: string, autoReply: boolean): string {
  const line = autoReply
    ? `[idnma] Automatic reply from ${from}. No answer is expected.`
    : `[idnma] Message from ${from}. Your final answer is sent back to ${from} automatically; do not send it yourself.`;
  return `${line}\n${body}`;
}

/** Un tour ouvert pour un pair : son message, le texte de tout le tour et celui reçu depuis le dernier outil. */
interface PeerTurn {
  message: InboundMessage;
  /** Le message ouvrant est lui-même un renvoi automatique : rien ne lui est renvoyé. */
  muted: boolean;
  whole: string;
  sinceTool: string;
}

export function createPeerDelivery(deps: PeerDeliveryDeps): PeerDelivery {
  const { queue } = deps;
  let turn: PeerTurn | undefined;
  // Le message retenu qui est à l'écran, s'il y en a un ; reste en file tant qu'il n'est pas livré ou écarté.
  let shown: InboundMessage | undefined;
  // Posé par « Later », levé par ⌃R : plus aucune présentation automatique entre-temps.
  let suspended = false;
  let left = false;

  const isHeld = deps.rule === "held";

  const notifyCount = (): void => {
    if (isHeld) deps.heldCountChanged(queue.size);
  };

  // Les envois relisent le mode à chaque appel (design §6.3).
  const reply = (message: InboundMessage, text: string): Promise<void> =>
    sendAutoReply(
      { registration: deps.registration, name: deps.name, fromMode: deps.fromMode(), ...(deps.send === undefined ? {} : { send: deps.send }) },
      message,
      text,
    );

  const rejectAll = (): Promise<void> =>
    rejectQueuedMessages({
      queue,
      registration: deps.registration,
      name: deps.name,
      fromMode: deps.fromMode(),
      label: deps.label,
      ...(deps.send === undefined ? {} : { send: deps.send }),
    });

  const display = (message: InboundMessage): { from: string; text: string } => ({
    from: senderNameOf(message.content) ?? "unknown peer",
    text: envelopeBody(message.content),
  });

  /** Ouvre le tour d'un message déjà sorti de la file. */
  const startTurn = (message: InboundMessage): void => {
    const shownAs = display(message);
    const autoReply = isAutoReply(message.content);
    turn = { message, muted: autoReply, whole: "", sinceTool: "" };
    deps.startPeerTurn(peerPrompt(shownAs.from, shownAs.text, autoReply), shownAs);
  };

  const canAct = (): boolean => !left && turn === undefined && deps.isIdle();

  const deliverNextAuto = (): void => {
    if (!canAct()) return;
    const message = queue.shift();
    if (message !== undefined) startTurn(message);
  };

  const presentNextHeld = (): void => {
    if (!canAct() || suspended || shown !== undefined) return;
    const first = queue.first(() => true);
    if (first === undefined) return;
    shown = first;
    deps.showHeld(display(first), queue.size);
  };

  /** Ferme le tour ouvert et répond à son pair, sauf si ce tour répondait lui-même à un renvoi automatique. */
  const settleTurn = async (text: string): Promise<void> => {
    const closing = turn;
    turn = undefined;
    if (closing === undefined || closing.muted) return;
    await reply(closing.message, text);
  };

  const lostText = `${deps.name} : réponse perdue (agent arrêté)`;

  return {
    onMessage(): void {
      if (left) {
        // Après la sortie, tout ce qui arrive est refusé comme le reste de la file ; au mieux.
        void rejectAll();
        return;
      }
      if (isHeld) {
        notifyCount();
        presentNextHeld();
      } else {
        deliverNextAuto();
      }
    },

    onIdle(): void {
      if (isHeld) presentNextHeld();
      else deliverNextAuto();
    },

    onTurnText(text: string): void {
      if (turn === undefined) return;
      turn.whole += text;
      turn.sinceTool += text;
    },

    onTurnTool(): void {
      if (turn !== undefined) turn.sinceTool = "";
    },

    async onTurnEnded(stopReason: string): Promise<void> {
      const ending = turn;
      if (ending === undefined) return;
      if (stopReason === "cancelled") {
        await settleTurn(`${deps.name} : tour interrompu`);
        return;
      }
      const final = ending.sinceTool.trim() !== "" ? ending.sinceTool : ending.whole;
      const text = final.trim() !== "" ? final.trim() : `${deps.name} : tour terminé sans réponse`;
      await settleTurn(text);
    },

    deliverHeld(): void {
      // Seul chemin qui envoie un prompt à agy : jamais dans un tour en cours (design §6.3). Hors repos,
      // le message reste à l'écran.
      if (!canAct() || shown === undefined) return;
      const message = shown;
      shown = undefined;
      queue.remove(message);
      notifyCount();
      startTurn(message);
    },

    laterHeld(): void {
      if (left || shown === undefined) return;
      shown = undefined;
      suspended = true;
    },

    async dismissHeld(): Promise<void> {
      if (left || shown === undefined) return;
      const message = shown;
      shown = undefined;
      queue.remove(message);
      notifyCount();
      await reply(message, `${deps.name} : message non livré (écarté dans l'écran)`);
      presentNextHeld();
    },

    reopenHeld(): void {
      if (left) return;
      suspended = false;
      presentNextHeld();
    },

    async agentLost(): Promise<void> {
      await settleTurn(lostText);
    },

    async leave(): Promise<void> {
      if (left) return;
      left = true;
      shown = undefined;
      await settleTurn(lostText);
      await rejectAll();
      notifyCount();
    },
  };
}
