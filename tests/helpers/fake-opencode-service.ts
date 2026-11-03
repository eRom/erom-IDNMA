import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** En-tête `authorization` reçu, tel quel. */
  authorization: string | null;
}

export interface FakeReply {
  status: number;
  body?: unknown;
}

export interface FakeOpencodeService {
  url: string;
  password: string;
  /** Chaque requête authentifiée reçue, dans l'ordre. */
  requests: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }>;
  /** Gestionnaire d'une route ; rendre une promesse qui ne se résout jamais simule un service muet. */
  handle(method: string, path: string, reply: (req: FakeRequest) => FakeReply | Promise<FakeReply>): void;
  /** Écrit un `service.json` désignant ce faux service (`url`, `pid`, `password`). */
  writeServiceFile(path: string, pid?: number): void;
  /** Écrit `data: <json>` suivi d'une ligne vide sur chaque flux `GET /api/event` ouvert. */
  emit(event: Record<string, unknown>): void;
  /** Écrit ces octets tels quels sur chaque flux ouvert (trames partielles, JSON invalide, commentaires). */
  emitRaw(chunk: string | Uint8Array): void;
  /** Ferme côté serveur chaque flux ouvert. */
  dropStreams(): void;
  /** Nombre de flux `GET /api/event` actuellement ouverts. */
  openStreams(): number;
  stop(): void;
}

/** Faux service de fond d'opencode 2.2.0 : HTTP sur 127.0.0.1, auth Basic `opencode:<password>` (formes mesurées). */
export function startFakeOpencodeService(o: { password?: string } = {}): FakeOpencodeService {
  const password = o.password ?? "pw-test-not-secret";
  const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  const handlers = new Map<string, (req: FakeRequest) => FakeReply | Promise<FakeReply>>();
  const requests: FakeOpencodeService["requests"] = [];
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const writeAll = (chunk: Uint8Array): void => {
    for (const controller of streams) {
      try {
        controller.enqueue(chunk);
      } catch {
        streams.delete(controller);
      }
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const authorization = req.headers.get("authorization");
      if (authorization !== expected) {
        return Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401 });
      }
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/event") {
        requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body: undefined });
        let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            opened = controller;
            streams.add(controller);
            // Un battement tout de suite : Bun n'envoie les en-têtes qu'avec le premier octet.
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          },
          cancel() {
            if (opened) streams.delete(opened);
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      }
      const text = await req.text();
      let body: unknown;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body });
      const handler = handlers.get(`${req.method} ${url.pathname}`);
      if (!handler) return new Response(null, { status: 404 });
      const reply = await handler({ method: req.method, path: url.pathname, query: url.searchParams, body, authorization });
      if (reply.body === undefined) return new Response(null, { status: reply.status });
      return Response.json(reply.body, { status: reply.status });
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  // Le vrai `GET /api/info` n'a pas d'enveloppe `data`.
  handlers.set("GET /api/info", () => ({ status: 200, body: { version: "2.2.0", pid: process.pid, urls: [url] } }));

  return {
    url,
    password,
    requests,
    handle(method, path, reply) {
      handlers.set(`${method} ${path}`, reply);
    },
    writeServiceFile(path, pid = process.pid) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ url, pid, password }));
    },
    emit(event) {
      writeAll(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    emitRaw(chunk) {
      writeAll(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    dropStreams() {
      for (const controller of streams) {
        try {
          controller.close();
        } catch {
          // Flux déjà fermé par le client.
        }
      }
      streams.clear();
    },
    openStreams() {
      return streams.size;
    },
    stop() {
      server.stop(true);
    },
  };
}
