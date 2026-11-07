// Protocole du pont entre la doublure idnma (le courier) et le module idnma qui tourne dans le
// process Node du harnais : plugin Cordis de dst, extension de pi. Ce module est importé des deux
// côtés : il ne dépend que de `node:` et reste en TypeScript effaçable (ni enum, ni namespace, ni
// propriété de paramètre), pour que Node 24 le charge sans transpilation. Spec dst : §7.1.
import type { Buffer } from "node:buffer";

/** Version du protocole que le plugin annonce dans `hello` et que la doublure exige. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Taille maximale d'une trame (une ligne, sans son `\n`) : au-delà, la connexion est fermée. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Mode de livraison choisi par le plugin : tour ouvert à la suite, ou injection dans le tour en cours. */
export type DeliveryMode = "followup" | "steer";

/** Priorité du message de pair, reprise telle quelle de la file de la doublure. */
export type DeliveryPriority = "now" | "next" | "later";

/** doublure -> plugin : un message de pair à remettre à dsh. */
export interface DeliverFrame {
  type: "deliver";
  id: string;
  priority: DeliveryPriority;
  sender: string;
  text: string;
  /** Ligne de rappel de réponse ; absente pour un renvoi automatique ou une enveloppe sans nom. */
  hint?: string;
}

/** Erreur d'un tour, réduite aux deux chaînes que la doublure sait relire. */
export interface ResultError {
  message?: string;
  code?: string;
}

export interface HelloFrame {
  type: "hello";
  v: number;
  token: string;
  pid: number;
  versions: { tui?: string };
}

export interface StateFrame {
  type: "state";
  session: string | null;
  status: "idle" | "running";
}

export interface DeliveredFrame {
  type: "delivered";
  id: string;
  mode: DeliveryMode;
  session: string;
}

export interface ClaimedFrame {
  type: "claimed";
  id: string;
  turn: number;
}

export interface ResultFrame {
  type: "result";
  id: string;
  turn: number;
  reason: string;
  cause?: string;
  mixed: boolean;
  sources: string[];
  text?: string;
  error?: ResultError;
}

export type DroppedReason = "discarded" | "disposed" | "no-agent" | "rejected";

export interface DroppedFrame {
  type: "dropped";
  id: string;
  why: DroppedReason;
  error?: string;
}

export interface ErrorFrame {
  type: "error";
  code: string;
}

/** plugin -> doublure. */
export type PluginFrame = HelloFrame | StateFrame | DeliveredFrame | ClaimedFrame | ResultFrame | DroppedFrame | ErrorFrame;

/** doublure -> plugin. */
export type CourierFrame = DeliverFrame;

/** Une trame sur le fil : son JSON sur une ligne, terminée par `\n`. */
export function encodeFrame(frame: object): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Lecteur de lignes d'un flux d'octets. Il coupe sur `\n` et ne décode en UTF-8 que des lignes
 * entières : un caractère coupé entre deux paquets reste entier. `onOverflow` est appelé une fois
 * quand une ligne dépasse `MAX_FRAME_BYTES` sans s'être terminée ; le lecteur ignore alors la suite
 * (l'appelant ferme la connexion).
 */
export function createLineReader(onLine: (line: string) => void, onOverflow: () => void): (chunk: Buffer) => void {
  const decoder = new TextDecoder("utf-8");
  let parts: Uint8Array[] = [];
  let pendingBytes = 0;
  let overflowed = false;

  const overflow = (): void => {
    overflowed = true;
    parts = [];
    pendingBytes = 0;
    onOverflow();
  };

  return (chunk) => {
    if (overflowed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        parts.push(chunk.subarray(start));
        pendingBytes += chunk.length - start;
        if (pendingBytes > MAX_FRAME_BYTES) overflow();
        return;
      }
      const tail = chunk.subarray(start, newline);
      const lineBytes = pendingBytes + tail.length;
      if (lineBytes > MAX_FRAME_BYTES) {
        overflow();
        return;
      }
      const whole = parts.length === 0 ? tail : concat([...parts, tail], lineBytes);
      parts = [];
      pendingBytes = 0;
      onLine(decoder.decode(whole));
      start = newline + 1;
    }
  };
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function parseObject(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// Un champ optionnel absent est accepté ; présent mais mal typé, la trame entière est illisible.
const optionalString = (value: unknown): value is string | undefined => value === undefined || isString(value);

const PRIORITIES: readonly string[] = ["now", "next", "later"];
const MODES: readonly string[] = ["followup", "steer"];
const STATUSES: readonly string[] = ["idle", "running"];
const DROPPED_REASONS: readonly string[] = ["discarded", "disposed", "no-agent", "rejected"];

/** Trame du plugin, ou `undefined` si la ligne est illisible, de type inconnu, ou si un champ requis manque ou est mal typé. Les clés inconnues sont ignorées. */
export function parsePluginFrame(line: string): PluginFrame | undefined {
  const o = parseObject(line);
  if (o === undefined) return undefined;
  switch (o.type) {
    case "hello": {
      const { v, token, pid, versions } = o;
      if (!isNumber(v) || !isString(token) || !isNumber(pid)) return undefined;
      if (versions === null || typeof versions !== "object" || Array.isArray(versions)) return undefined;
      const tui = (versions as Record<string, unknown>).tui;
      return { type: "hello", v, token, pid, versions: isString(tui) ? { tui } : {} };
    }
    case "state": {
      const { session, status } = o;
      if (!(session === null || isString(session)) || !isString(status) || !STATUSES.includes(status)) return undefined;
      return { type: "state", session, status: status as StateFrame["status"] };
    }
    case "delivered": {
      const { id, mode, session } = o;
      if (!isString(id) || !isString(mode) || !MODES.includes(mode) || !isString(session)) return undefined;
      return { type: "delivered", id, mode: mode as DeliveryMode, session };
    }
    case "claimed": {
      const { id, turn } = o;
      if (!isString(id) || !isNumber(turn)) return undefined;
      return { type: "claimed", id, turn };
    }
    case "result":
      return parseResult(o);
    case "dropped": {
      const { id, why, error } = o;
      if (!isString(id) || !isString(why) || !DROPPED_REASONS.includes(why) || !optionalString(error)) return undefined;
      const frame: DroppedFrame = { type: "dropped", id, why: why as DroppedReason };
      if (error !== undefined) frame.error = error;
      return frame;
    }
    case "error": {
      if (!isString(o.code)) return undefined;
      return { type: "error", code: o.code };
    }
    default:
      return undefined;
  }
}

function parseResult(o: Record<string, unknown>): ResultFrame | undefined {
  const { id, turn, reason, cause, mixed, sources, text, error } = o;
  if (!isString(id) || !isNumber(turn) || !isString(reason) || typeof mixed !== "boolean") return undefined;
  if (!Array.isArray(sources) || !sources.every(isString)) return undefined;
  if (!optionalString(cause) || !optionalString(text)) return undefined;
  const frame: ResultFrame = { type: "result", id, turn, reason, mixed, sources: [...sources] };
  if (cause !== undefined) frame.cause = cause;
  if (text !== undefined) frame.text = text;
  if (error !== undefined) {
    if (error === null || typeof error !== "object" || Array.isArray(error)) return undefined;
    const { message, code } = error as Record<string, unknown>;
    const reduced: ResultError = {};
    if (isString(message)) reduced.message = message;
    if (isString(code)) reduced.code = code;
    frame.error = reduced;
  }
  return frame;
}

/** `deliver` de la doublure, ou `undefined` si la ligne est illisible ou invalide. Les clés inconnues sont ignorées. */
export function parseCourierFrame(line: string): DeliverFrame | undefined {
  const o = parseObject(line);
  if (o === undefined || o.type !== "deliver") return undefined;
  const { id, priority, sender, text, hint } = o;
  if (!isString(id) || !isString(priority) || !PRIORITIES.includes(priority) || !isString(sender) || !isString(text) || !optionalString(hint)) {
    return undefined;
  }
  const frame: DeliverFrame = { type: "deliver", id, priority: priority as DeliveryPriority, sender, text };
  if (hint !== undefined) frame.hint = hint;
  return frame;
}
