import { rmSync } from "node:fs";
import { dirname } from "node:path";

type Frame = Record<string, unknown>;
type Reply = { result: unknown } | { error: { code: number; message: string } } | undefined;

export interface FakeCodexDaemon {
  socketPath: string;
  /** Chaque trame reçue d'un client, dans l'ordre. */
  received: Frame[];
  /** Gestionnaire d'une méthode ; rendre `undefined` ne répond jamais. */
  handle(method: string, reply: (params: Record<string, unknown>) => Reply): void;
  /** Notification diffusée à toutes les connexions ouvertes. */
  notify(method: string, params: Record<string, unknown>): void;
  /** Requête du serveur (approbation) diffusée à toutes les connexions ouvertes. */
  serverRequest(id: number, method: string, params: Record<string, unknown>): void;
  openConnections(): number;
  /** Ferme chaque connexion côté serveur. */
  dropConnections(): void;
  stop(): void;
}

/** Faux daemon app-server de Codex : WebSocket sur un socket Unix (forme mesurée, sonde 7b). */
export function startFakeCodexDaemon(socketPath: string): FakeCodexDaemon {
  // Un socket laissé par un daemon précédent ferait échouer le bind.
  rmSync(socketPath, { force: true });
  const handlers = new Map<string, (params: Record<string, unknown>) => Reply>();
  const connections = new Set<Bun.ServerWebSocket<undefined>>();
  const received: Frame[] = [];

  handlers.set("initialize", () => ({
    result: { userAgent: "fake", codexHome: dirname(dirname(socketPath)), platformFamily: "unix", platformOs: "macos" },
  }));

  const server = Bun.serve<undefined>({
    unix: socketPath,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response(null, { status: 400 })),
    websocket: {
      open(ws) {
        connections.add(ws);
      },
      close(ws) {
        connections.delete(ws);
      },
      message(ws, data) {
        const frame = JSON.parse(String(data)) as Frame;
        received.push(frame);
        if (typeof frame.method !== "string" || frame.id === undefined) return;
        const handler = handlers.get(frame.method);
        if (!handler) {
          ws.send(JSON.stringify({ id: frame.id, error: { code: -32601, message: "method not found" } }));
          return;
        }
        const reply = handler((frame.params ?? {}) as Record<string, unknown>);
        if (reply) ws.send(JSON.stringify({ id: frame.id, ...reply }));
      },
    },
  });

  const broadcast = (frame: Frame) => {
    const text = JSON.stringify(frame);
    for (const ws of connections) ws.send(text);
  };

  return {
    socketPath,
    received,
    handle: (method, reply) => void handlers.set(method, reply),
    notify: (method, params) => broadcast({ method, params }),
    serverRequest: (id, method, params) => broadcast({ id, method, params }),
    openConnections: () => connections.size,
    dropConnections: () => {
      for (const ws of [...connections]) ws.close();
    },
    stop: () => {
      server.stop(true);
      rmSync(socketPath, { force: true });
    },
  };
}
