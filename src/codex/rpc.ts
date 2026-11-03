import pkg from "../../package.json";
import { errorMessage, logEvent } from "../log.ts";

/** Erreur JSON-RPC du daemon (`code` présent) ou échec local : délai, connexion fermée (`code` absent). */
export class CodexRpcError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "CodexRpcError";
    if (code !== undefined) this.code = code;
  }
}

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexClient {
  request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): void;
  /** Se résout dès que la connexion est fermée, de n'importe quel côté. */
  readonly closed: Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CLOSED_MESSAGE = "connexion au daemon Codex fermée";

interface Pending {
  method: string;
  resolve: (value: never) => void;
  reject: (error: CodexRpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Ouvre le WebSocket sur le socket Unix du daemon, fait la poignée de main `initialize` puis `initialized`. */
export async function connectCodex(o: {
  socketPath: string;
  onNotification: (n: CodexNotification) => void;
  connectTimeoutMs?: number;
}): Promise<CodexClient> {
  const connectTimeoutMs = o.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const ws = new WebSocket("ws+unix://" + o.socketPath);
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let isClosed = false;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  // Point unique de fermeture : toute requête en cours échoue, les suivantes échouent aussitôt.
  const shutdown = () => {
    if (isClosed) return;
    isClosed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new CodexRpcError(CLOSED_MESSAGE));
    }
    pending.clear();
    markClosed();
  };

  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (event) => reject(new CodexRpcError((event as ErrorEvent).message || "connexion refusée"));
  });
  // Après l'ouverture, une erreur est suivie d'un `close` : seul `close` compte.
  opened.catch(() => {});

  ws.onclose = shutdown;
  ws.onmessage = (event) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      logEvent("codex-frame-unparseable");
      return;
    }
    const hasId = frame.id !== undefined && frame.id !== null;
    const method = typeof frame.method === "string" ? frame.method : undefined;
    if (hasId && method === undefined) {
      settle(frame);
    } else if (hasId) {
      // Requête du serveur (approbation) : jamais de réponse, la TUI reste seule juge.
      logEvent("codex-server-request-ignored", { method });
    } else if (method !== undefined) {
      const logFailure = (error: unknown) => logEvent("codex-notification-error", { method, error: errorMessage(error) });
      try {
        // Un rappel async rend une promesse : son rejet doit être journalisé, jamais remonter
        // en rejet non géré (il écrirait sur stderr, donc dans la TUI du harnais).
        const outcome: unknown = o.onNotification({ method, params: (frame.params ?? {}) as Record<string, unknown> });
        if (outcome instanceof Promise) outcome.catch(logFailure);
      } catch (error) {
        logFailure(error);
      }
    }
  };

  function settle(frame: Record<string, unknown>): void {
    const entry = pending.get(frame.id as number);
    if (!entry) return;
    pending.delete(frame.id as number);
    clearTimeout(entry.timer);
    const failure = frame.error as { code?: number; message?: string } | undefined;
    if (failure) entry.reject(new CodexRpcError(failure.message ?? "erreur JSON-RPC sans message", failure.code));
    else entry.resolve(frame.result as never);
  }

  function request<T>(method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (isClosed) return Promise.reject(new CodexRpcError(CLOSED_MESSAGE));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CodexRpcError(`délai dépassé (${timeoutMs} ms) pour ${method}`));
      }, timeoutMs);
      pending.set(id, { method, resolve: resolve as (value: never) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new CodexRpcError(`envoi impossible pour ${method} (${errorMessage(error)})`));
      }
    });
  }

  const client: CodexClient = {
    request,
    closed,
    close() {
      shutdown();
      try {
        ws.close();
      } catch {
        // Déjà fermé : rien à faire.
      }
    },
  };

  const deadline = Date.now() + connectTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      opened,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CodexRpcError(`délai de connexion dépassé (${connectTimeoutMs} ms)`)), connectTimeoutMs);
      }),
    ]);
    await request("initialize", {
      clientInfo: { name: "idnma", title: null, version: pkg.version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, Math.max(1, deadline - Date.now()));
    ws.send(JSON.stringify({ method: "initialized" }));
    return client;
  } catch (error) {
    client.close();
    throw error instanceof CodexRpcError ? error : new CodexRpcError(errorMessage(error));
  } finally {
    clearTimeout(timer);
  }
}
