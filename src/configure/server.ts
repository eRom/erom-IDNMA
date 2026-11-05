import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { EngineSchema } from "../config/network.ts";
import page from "./page/index.html";
import { ConfigDocument, EditRefused } from "./document.ts";
import { readConfig, saveConfig } from "./store.ts";
import type { ConfigView, EditOp } from "./types.ts";
import { buildView } from "./view.ts";

/** Délai sans page ouverte avant l'arrêt, une fois la dernière page partie. */
const DEFAULT_IDLE_MS = 10_000;

/** Un commentaire SSE toutes les 5 s : la connexion reste vivante et une page fermée se détecte. */
const PING_INTERVAL_MS = 5_000;

const harness = EngineSchema.shape.harness;
const pathItem = z.union([z.string(), z.number()]);
const text = z.string();

const providerInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("anthropic") }),
  z.strictObject({ kind: z.literal("preset"), name: text }),
  z.strictObject({ kind: z.literal("custom") }),
]);

const optionsInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("preset"), name: text }),
  z.strictObject({ kind: z.literal("custom"), values: z.array(text) }),
]);

/** Le corps de `POST /api/op` est une donnée externe : chaque opération est validée avant `apply`. */
const opSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("addAgent"), key: text, label: text }),
  z.strictObject({ op: z.literal("duplicateAgent"), key: text }),
  z.strictObject({ op: z.literal("deleteAgent"), key: text }),
  z.strictObject({ op: z.literal("renameAgent"), key: text, newKey: text }),
  z.strictObject({ op: z.literal("setAgentField"), key: text, field: z.enum(["label", "avatar"]), value: text.nullable() }),
  z.strictObject({ op: z.literal("addEngine"), agent: text, name: text, harness }),
  z.strictObject({ op: z.literal("deleteEngine"), agent: text, engine: text }),
  z.strictObject({ op: z.literal("renameEngine"), agent: text, engine: text, newName: text }),
  z.strictObject({ op: z.literal("makeDefault"), agent: text, engine: text }),
  z.strictObject({ op: z.literal("setHarness"), agent: text, engine: text, harness }),
  z.strictObject({ op: z.literal("setModel"), agent: text, engine: text, value: text.nullable() }),
  z.strictObject({ op: z.literal("setProvider"), agent: text, engine: text, provider: providerInput }),
  z.strictObject({ op: z.literal("setOptions"), agent: text, engine: text, options: optionsInput }),
  z.strictObject({
    op: z.literal("setEnvVar"),
    agent: text,
    engine: text,
    name: text,
    value: text,
    previousName: text.optional(),
  }),
  z.strictObject({ op: z.literal("deleteEnvVar"), agent: text, engine: text, name: text }),
  z.strictObject({ op: z.literal("removeMerge"), agent: text, engine: text }),
  z.strictObject({ op: z.literal("unlink"), path: z.array(pathItem) }),
  z.strictObject({ op: z.literal("quoteValue"), path: z.array(pathItem) }),
  z.strictObject({ op: z.literal("addPreset"), name: text, kind: z.enum(["provider", "options"]) }),
  z.strictObject({ op: z.literal("renamePreset"), name: text, newName: text }),
  z.strictObject({ op: z.literal("deletePreset"), name: text }),
  z.strictObject({
    op: z.literal("setPresetVar"),
    name: text,
    varName: text,
    value: text,
    previousName: text.optional(),
  }),
  z.strictObject({ op: z.literal("deletePresetVar"), name: text, varName: text }),
  z.strictObject({ op: z.literal("setPresetOptions"), name: text, values: z.array(text) }),
]);

const opBody = z.strictObject({ op: opSchema });

// Garde de dérive, à la compilation seulement : l'union zod et `EditOp` doivent rester la même.
type ParsedOp = z.output<typeof opSchema>;
type SameAsEditOp = [EditOp] extends [ParsedOp] ? ([ParsedOp] extends [EditOp] ? true : never) : never;
const opSchemaMatchesEditOp: SameAsEditOp = true;
void opSchemaMatchesEditOp;

export interface ConfigureServer {
  /** `http://127.0.0.1:<port>/?token=<token>`, l'adresse à ouvrir dans le navigateur. */
  url: string;
  port: number;
  token: string;
  /** Arrête le serveur ; sans effet s'il est déjà arrêté. */
  stop(): void;
  /** Se résout à tout arrêt (inactivité ou `stop()`), une fois le port libéré. */
  done: Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function sameToken(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Serveur local de `idnma configure` : une session, un fichier. Il n'écoute que sur 127.0.0.1, exige le jeton,
 * refuse les `Host` et `Origin` étrangers (rebinding DNS, page tierce), et s'arrête quand la dernière page
 * ouverte (flux SSE) est partie. Rien n'est écrit sur le disque avant `POST /api/save`.
 */
export function startConfigureServer(o: { path: string; idleMs?: number; token?: string }): ConfigureServer {
  const token = o.token ?? randomBytes(32).toString("hex");
  const idleMs = o.idleMs ?? DEFAULT_IDLE_MS;

  // La base : le texte lu (ou `undefined` pour un fichier neuf) et son empreinte, contre quoi Save et Revert comparent.
  let base = readConfig(o.path);
  let doc = ConfigDocument.parse(base.text);

  /** Faux sur une erreur de syntaxe (rien à sauver) ; sinon, le document diffère de la base ou le fichier est neuf. */
  function isDirty(): boolean {
    return !doc.parseError && (doc.isNew || doc.toText() !== base.text);
  }

  function currentView(): ConfigView {
    return buildView(doc, o.path, isDirty());
  }

  let allowedHosts: string[] = [];
  let allowedOrigins: string[] = [];

  /** Les refus communs à toutes les routes de l'API ; `undefined` quand la requête passe. */
  function guard(req: Request, url: URL): Response | undefined {
    const forbidden = json({ error: "Forbidden." }, 403);
    const host = req.headers.get("host");
    if (host === null || !allowedHosts.includes(host)) return forbidden;
    // Le flux SSE ne peut pas porter d'en-tête (EventSource) : il prend le jeton en paramètre, lui seul.
    const given = url.pathname === "/api/events" ? url.searchParams.get("token") : req.headers.get("x-idnma-token");
    if (!sameToken(given, token)) return forbidden;
    const origin = req.headers.get("origin");
    if (origin !== null && !allowedOrigins.includes(origin)) return forbidden;
    if (req.method === "POST") {
      const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") return json({ error: "Unsupported media type." }, 415);
    }
    return undefined;
  }

  // Flux SSE ouverts : la fermeture du dernier arme le minuteur d'inactivité.
  const streams = new Set<() => void>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    for (const release of [...streams]) release();
    // `true` coupe aussi les connexions encore ouvertes ; `done` attend que le port soit libre.
    server.stop(true).finally(resolveDone).catch(() => {});
  }

  function armIdleTimer(): void {
    if (stopped) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, idleMs);
  }

  function openEvents(req: Request): Response {
    clearTimeout(idleTimer);
    let release = (): void => {};
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), PING_INTERVAL_MS);
        release = () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          streams.delete(release);
          try {
            controller.close();
          } catch {
            // Déjà fermé par le client.
          }
          if (streams.size === 0) armIdleTimer();
        };
        streams.add(release);
        // Un premier commentaire tout de suite : les en-têtes partent sans attendre le premier intervalle.
        controller.enqueue(encoder.encode(": ping\n\n"));
      },
      cancel() {
        release();
      },
    });
    req.signal.addEventListener("abort", () => release());
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }

  async function applyOp(req: Request): Promise<Response> {
    const parsed = opBody.safeParse(await req.json().catch(() => undefined));
    if (!parsed.success) return json({ refused: "Invalid operation." }, 400);
    doc.apply(parsed.data.op);
    return json({ view: currentView() });
  }

  /** Revert : le document redevient la base (dernier texte lu ou sauvé). */
  function revert(): Response {
    doc = ConfigDocument.parse(base.text);
    return json({ view: currentView() });
  }

  /** Reload : relit le fichier, qui devient la nouvelle base ; les modifications en cours sont abandonnées. */
  function reload(): Response {
    base = readConfig(o.path);
    doc = ConfigDocument.parse(base.text);
    return json({ view: currentView() });
  }

  /**
   * Save : écrit `doc.toText()` seulement si le document diffère de la base ; sinon le disque n'est pas touché.
   * Un fichier qui garde des erreurs de validation s'écrit quand même (l'app avertit, elle ne bloque pas).
   */
  function save(): Response {
    if (!isDirty()) return json({ view: currentView() });
    const content = doc.toText();
    const result = saveConfig(o.path, content, base.hash);
    if (result.kind === "changed-on-disk") return json({ changedOnDisk: true }, 409);
    if (result.kind === "failed") return json({ failed: result.message }, 500);
    // Le texte écrit devient la base, et le document en est relu : `modified` repart de zéro.
    base = { text: content, hash: result.hash };
    doc = ConfigDocument.parse(content);
    return json({ view: currentView() });
  }

  const routes = new Map<string, { method: "GET" | "POST"; run: (req: Request) => Response | Promise<Response> }>([
    ["/api/state", { method: "GET", run: () => json({ view: currentView() }) }],
    ["/api/events", { method: "GET", run: openEvents }],
    ["/api/op", { method: "POST", run: applyOp }],
    ["/api/revert", { method: "POST", run: revert }],
    ["/api/save", { method: "POST", run: save }],
    ["/api/reload", { method: "POST", run: reload }],
  ]);

  function route(req: Request, url: URL): Response | Promise<Response> {
    const handler = routes.get(url.pathname);
    if (!handler) return json({ error: "Not found." }, 404);
    if (handler.method !== req.method) return json({ error: "Method not allowed." }, 405);
    return handler.run(req);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    routes: { "/": page },
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
      const refused = guard(req, url);
      if (refused) return refused;
      try {
        return await route(req, url);
      } catch (error) {
        if (error instanceof EditRefused) return json({ refused: error.message }, 409);
        // Le nom de l'erreur et la route suffisent : un message d'erreur peut citer le contenu du fichier.
        const kind = error instanceof Error ? error.name : "unknown error";
        console.error(`idnma configure: internal error on ${req.method} ${url.pathname} (${kind}).`);
        return json({ failed: "Internal error." }, 500);
      }
    },
  });

  const port = server.port ?? 0;
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  allowedOrigins = allowedHosts.map((host) => `http://${host}`);

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    stop,
    done,
  };
}
