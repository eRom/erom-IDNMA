import { timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";

// Boîte de réception d'une doublure : serveur de socket Unix qui reçoit les trames d'un pair,
// comme le serveur de Claude Code (lignes JSON, `auth` facultative en première ligne, délai de
// 30 s sans ligne complète). Il ne répond jamais sur la connexion.

export type Priority = "now" | "next" | "later";

export interface InboundMessage {
  msgId?: string;
  from?: string;
  priority: Priority;
  content: string;
  authenticated: boolean;
  receivedAt: number;
}

/** Plafond d'une ligne, comme chez Claude : au-delà, la connexion est fermée. */
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_FIRST_LINE_DEADLINE_MS = 30_000;
const NEWLINE = 0x0a;

interface ConnectionState {
  pending: Buffer;
  lineCount: number;
  authenticated: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function tokenMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function asPriority(value: unknown): Priority {
  return value === "now" || value === "next" || value === "later" ? value : "next";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function startInboxServer(o: {
  socketPath: string;
  peerToken: string;
  onMessage: (m: InboundMessage) => void;
  onControl?: (frame: Record<string, unknown>) => void;
  /** Reçoit l'exception d'un rappel qui a levé ; sans lui, elle est écrite sur stderr (message seul). */
  onError?: (error: unknown) => void;
  firstLineDeadlineMs?: number;
}): { stop(): void } {
  const deadlineMs = o.firstLineDeadlineMs ?? DEFAULT_FIRST_LINE_DEADLINE_MS;
  const states = new Map<object, ConnectionState>();

  const reportError =
    o.onError ??
    ((error: unknown) => {
      console.error("idnma: rappel de la boîte de réception en erreur :", error instanceof Error ? error.message : "erreur inconnue");
    });

  const handleLine = (state: ConnectionState, raw: Buffer): void => {
    const isFirstLine = state.lineCount === 0;
    state.lineCount += 1;
    if (isFirstLine && state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(raw.toString("utf8"));
    } catch {
      return; // ligne non JSON : ignorée, la connexion continue
    }
    if (!isRecord(frame)) return;

    // L'authentification ne compte qu'en première ligne, comme chez Claude.
    if (frame.type === "auth") {
      if (isFirstLine) state.authenticated = tokenMatches(frame.token, o.peerToken);
      return;
    }
    if (frame.type === "control") {
      o.onControl?.(frame);
      return;
    }
    if (frame.type !== "user") return;

    const message = frame.message;
    if (!isRecord(message) || typeof message.content !== "string" || message.content === "") return;
    o.onMessage({
      ...(typeof frame.msg_id === "string" ? { msgId: frame.msg_id } : {}),
      ...(typeof frame.from === "string" ? { from: frame.from } : {}),
      priority: asPriority(frame.priority),
      content: message.content,
      authenticated: state.authenticated,
      receivedAt: Date.now(),
    });
  };

  // Un socket orphelin d'un process mort empêcherait l'écoute. Fait avant le masque : une
  // exception ici ne doit jamais laisser le umask à 077 sur le process.
  rmSync(o.socketPath, { force: true });
  // Le masque 077 limite la fenêtre d'accès à la création du socket (700), puis le chmod le fixe à 600.
  const previousMask = process.umask(0o077);
  let listener: ReturnType<typeof Bun.listen>;
  try {
    listener = Bun.listen<undefined>({
      unix: o.socketPath,
      socket: {
        open(socket) {
          const state: ConnectionState = {
            pending: Buffer.alloc(0),
            lineCount: 0,
            authenticated: false,
            closed: false,
            timer: undefined,
          };
          // Sans ligne complète dans le délai, la connexion est fermée.
          state.timer = setTimeout(() => {
            state.closed = true;
            socket.end();
          }, deadlineMs);
          states.set(socket, state);
        },
        data(socket, chunk) {
          const state = states.get(socket);
          if (state === undefined || state.closed) return;
          state.pending = state.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([state.pending, chunk]);

          let newline = state.pending.indexOf(NEWLINE);
          while (newline !== -1) {
            if (newline > MAX_LINE_BYTES) break; // traitée comme trop longue ci-dessous
            // Un rappel qui lève ne doit pas faire perdre les trames suivantes de la connexion.
            try {
              handleLine(state, state.pending.subarray(0, newline));
            } catch (error) {
              reportError(error);
            }
            state.pending = state.pending.subarray(newline + 1);
            newline = state.pending.indexOf(NEWLINE);
          }

          if (newline > MAX_LINE_BYTES || (newline === -1 && state.pending.length > MAX_LINE_BYTES)) {
            state.closed = true;
            state.pending = Buffer.alloc(0);
            if (state.timer !== undefined) clearTimeout(state.timer);
            socket.end();
          }
        },
        close(socket) {
          const state = states.get(socket);
          if (state?.timer !== undefined) clearTimeout(state.timer);
          states.delete(socket);
        },
        error(socket) {
          const state = states.get(socket);
          if (state?.timer !== undefined) clearTimeout(state.timer);
          states.delete(socket);
        },
      },
    });
  } finally {
    process.umask(previousMask);
  }
  chmodSync(o.socketPath, 0o600);

  return {
    stop() {
      for (const state of states.values()) if (state.timer !== undefined) clearTimeout(state.timer);
      states.clear();
      listener.stop(true);
      rmSync(o.socketPath, { force: true });
    },
  };
}
