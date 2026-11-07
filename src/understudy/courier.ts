import type { FromMode } from "../bus/envelope.ts";
import type { Registration } from "../bus/register.ts";
import { sendPeerMessage } from "../bus/send.ts";
import { errorMessage, logEvent } from "../log.ts";
import type { Terminal } from "./pty.ts";
import type { MessageQueue } from "./queue.ts";

/**
 * Livreur d'un agent étranger : tout ce que la doublure sait faire avec le harnais autrement que
 * par le canal de contrôle. `beforeSpawn` prépare ce qui doit exister avant le lancement de l'agent,
 * `afterSpawn` arme la suite, `onMessage` livre un message arrivé sur le bus, `verifyCaller` admet
 * les commandes lancées par le harnais, `read` rend le message que `idnma read` remet à l'agent,
 * `hook` répond à un hook du harnais (`idnma hook`), `stop` défait tout (synchrone et idempotent).
 */
export interface Courier {
  beforeSpawn(): Promise<void>;
  /** `terminal` n'est fourni que si l'agent tourne sous PTY ; le livreur Codex l'ignore. */
  afterSpawn(terminal?: Terminal): void;
  onMessage(): void;
  /** Message que le livreur remet à `idnma read` ; `null` quand il n'y en a pas. */
  read(): string | null;
  /** Réponse à l'événement d'un hook du harnais ; `{}` quand le livreur n'a rien à dire. */
  hook(harness: "grok" | "agy", event: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  verifyCaller(claim: { codexThreadId: string }, peerPid: number | undefined): Promise<boolean>;
  stop(): void;
  /**
   * Adieux, optionnels : appelés par la doublure après la fin de l'enfant ou un signal, attente
   * bornée. Le livreur répond aux envois encore en vol et refuse sa file, puis refuse tout message
   * qui arrive ensuite. Seuls les livreurs à pont (dst, pi) l'implémentent ; les autres n'ont rien à dire de plus que `stop`.
   */
  farewell?(): Promise<void>;
}

/** Le livreur ne peut pas servir cet agent (daemon injoignable, verrou refusé) : le message est destiné à l'utilisateur. */
export class CourierUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourierUnavailableError";
  }
}

/**
 * Première ligne de tout renvoi automatique d'une doublure (réponse finale, ligne d'échec, message
 * non livré, réponse perdue). Elle coupe la boucle où deux doublures se renverraient leurs réponses.
 */
export const AUTO_REPLY_MARKER = "[réponse automatique idnma]";

/**
 * Vrai si `content`, l'enveloppe reçue en entier, porte un renvoi automatique : la première ligne du
 * corps, soit la deuxième de l'enveloppe, est exactement `AUTO_REPLY_MARKER`.
 */
export function isAutoReply(content: string): boolean {
  const lines = content.split("\n");
  return (lines[0] ?? "").startsWith("<cross-session-message ") && lines[1] === AUTO_REPLY_MARKER;
}

// `from-name` de la première ligne de l'enveloppe, et forme d'un nom de session du bus : rien qui
// puisse sortir de la commande suggérée.
const FROM_NAME = /^<cross-session-message\b[^>\n]*?\sfrom-name="([^"]*)"/;
const PEER_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Le `from-name` de l'enveloppe reçue, s'il a la forme d'un nom de pair ; `undefined` sinon
 * (enveloppe sans nom, nom hors forme, texte qui n'est pas une enveloppe).
 */
export function senderNameOf(content: string): string | undefined {
  const name = FROM_NAME.exec(content)?.[1];
  return name !== undefined && PEER_NAME.test(name) ? name : undefined;
}

/**
 * Texte livré pour un message de pair qui entre dans un tour ouvert pour quelqu'un d'autre : sa
 * réponse finale ne revient pas à l'expéditeur, une ligne collée au message dit à l'agent comment lui
 * répondre (l'AGENTS.md seul n'a pas suffi à Codex, recette du 27/10). Un renvoi automatique, ou une
 * enveloppe sans nom lisible, passe tel quel.
 */
export function withReplyHint(content: string): string {
  const hint = replyHintFor(content);
  return hint === undefined ? content : `${content}\n${hint}`;
}

/**
 * La ligne de rappel que `withReplyHint` colle au message ; `undefined` quand il passe tel quel
 * (renvoi automatique, enveloppe sans nom lisible).
 */
export function replyHintFor(content: string): string | undefined {
  if (isAutoReply(content)) return undefined;
  const name = senderNameOf(content);
  if (name === undefined) return undefined;
  return `(idnma) Message reçu pendant ton tour : ta réponse finale ne lui revient pas, réponds à ${name} par \`idnma peer send ${name} "…"\`.`;
}

/** Attend `work` au plus `waitMs` ; le minuteur est retiré dès que le travail se termine. */
export async function waitBounded(work: Promise<unknown>, waitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolveExpiry) => {
    timer = setTimeout(resolveExpiry, waitMs);
  });
  try {
    await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Renvoie `text`, précédé de la marque de renvoi automatique, à l'expéditeur d'un message ; jamais d'exception. */
export async function sendAutoReply(
  o: { registration: Registration; name: string; fromMode: FromMode; send?: typeof sendPeerMessage },
  to: { from?: string | undefined; msgId?: string | undefined },
  text: string,
): Promise<void> {
  const address = to.from;
  if (address === undefined) {
    logEvent("reply-without-sender", { msgId: to.msgId });
    return;
  }
  const send = o.send ?? sendPeerMessage;
  try {
    await send({
      fromSocketPath: o.registration.socketPath,
      fromName: o.name,
      fromMode: o.fromMode,
      to: { address },
      body: `${AUTO_REPLY_MARKER}\n${text}`,
    });
  } catch (error) {
    logEvent("reply-error", { message: errorMessage(error) });
  }
}

const DEFAULT_REJECT_WAIT_MS = 3_000;

/**
 * Vide la file et répond à chaque expéditeur que son message n'a pas été livré : une doublure qui
 * quitte le bus n'avale rien. Au mieux (les échecs partent au journal), attente totale bornée.
 */
export async function rejectQueuedMessages(o: {
  queue: MessageQueue;
  registration: Registration;
  name: string;
  fromMode: FromMode;
  send?: typeof sendPeerMessage;
  waitMs?: number;
  /** Nom du harnais qui quitte le bus, dans le texte du rejet ; « Codex » par défaut. */
  label?: string;
}): Promise<void> {
  const replies: Array<Promise<void>> = [];
  for (let message = o.queue.shift(); message !== undefined; message = o.queue.shift()) {
    replies.push(sendAutoReply(o, message, `${o.name} : message non livré (${o.label ?? "Codex"} a quitté le bus)`));
  }
  if (replies.length === 0) return;
  await waitBounded(Promise.all(replies), o.waitMs ?? DEFAULT_REJECT_WAIT_MS);
}
