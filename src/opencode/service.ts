import { readFileSync } from "node:fs";
import { errorMessage, logEvent } from "../log.ts";
import { opencodeServiceFile } from "../paths.ts";
import type { ModelEntry, ModelRef } from "./model.ts";

/** Coordonnées du service de fond d'opencode, telles que `service.json` les publie. */
export interface ServiceInfo {
  url: string;
  pid: number;
  password: string;
}

/** Lit `service.json` ; fichier absent, illisible ou champ manquant : `undefined`. */
export function readServiceInfo(path: string = opencodeServiceFile()): ServiceInfo | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const { url, pid, password } = raw as Record<string, unknown>;
    if (typeof url !== "string" || typeof pid !== "number" || typeof password !== "string") return undefined;
    return { url, pid, password };
  } catch {
    return undefined;
  }
}

const SERVICE_POLL_MS = 200;
const SERVICE_START_TIMEOUT_MS = 10_000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM : le process existe, il appartient à un autre utilisateur.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Lance `opencode service start` sans l'attendre : la commande rend la main quand le service est monté. */
function startOpencodeService(): void {
  const child = Bun.spawn(["opencode", "service", "start"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
}

/**
 * Coordonnées d'un service vivant. Fichier lisible et pid vivant : rendus tels quels. Sinon le service
 * est démarré une fois, puis le fichier est relu toutes les 200 ms (10 s au plus) jusqu'à un pid vivant ;
 * `undefined` au-delà.
 */
export async function ensureService(
  deps: Partial<{
    start(): void;
    isAlive(pid: number): boolean;
    sleep(ms: number): Promise<void>;
    read(): ServiceInfo | undefined;
    timeoutMs: number;
  }> = {},
): Promise<ServiceInfo | undefined> {
  const read = deps.read ?? (() => readServiceInfo());
  const isAlive = deps.isAlive ?? isProcessAlive;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const timeoutMs = deps.timeoutMs ?? SERVICE_START_TIMEOUT_MS;

  const current = read();
  if (current && isAlive(current.pid)) return current;

  logEvent("opencode-service-start", { stale: current !== undefined });
  try {
    (deps.start ?? startOpencodeService)();
  } catch (error) {
    // Le service peut tout de même apparaître par ailleurs : la relecture tranche.
    logEvent("opencode-service-start-failed", { error: errorMessage(error) });
  }
  for (let waited = 0; waited < timeoutMs; waited += SERVICE_POLL_MS) {
    await sleep(SERVICE_POLL_MS);
    const info = read();
    if (info && isAlive(info.pid)) return info;
  }
  return undefined;
}

/**
 * Réponse hors 2xx, ou échec réseau / délai dépassé (`status` 0). `tag` est le `_tag` du corps JSON ;
 * `serviceMessage` est le champ `message` de ce corps, seul, sans méthode ni chemin (montrable à un pair).
 */
export class OpencodeHttpError extends Error {
  status: number;
  tag?: string;
  serviceMessage?: string;
  constructor(status: number, message: string, tag?: string, serviceMessage?: string) {
    super(message);
    this.name = "OpencodeHttpError";
    this.status = status;
    if (tag !== undefined) this.tag = tag;
    if (serviceMessage !== undefined) this.serviceMessage = serviceMessage;
  }
}

export interface OpencodeSession {
  id: string;
  parentID?: string;
  model?: ModelRef;
}

export interface OpencodeClient {
  info(): Promise<{ version: string }>;
  listModels(directory: string): Promise<ModelEntry[]>;
  getSession(id: string): Promise<OpencodeSession | undefined>;
  createSession(o: { id?: string; directory: string; model?: ModelRef }): Promise<OpencodeSession>;
  listSessions(directory: string): Promise<OpencodeSession[]>;
  switchModel(id: string, model: ModelRef): Promise<void>;
  cancelInbox(id: string, inboxID: string): Promise<void>;
  prompt(id: string, p: { text: string; delivery: "queue" | "steer"; metadata: Record<string, unknown> }): Promise<{ inboxID: string }>;
  activeSessions(): Promise<Set<string>>;
}

const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSession(raw: unknown, status: number): OpencodeSession {
  if (!isRecord(raw) || typeof raw.id !== "string") throw new OpencodeHttpError(status, "unexpected session payload");
  const session: OpencodeSession = { id: raw.id };
  if (typeof raw.parentID === "string") session.parentID = raw.parentID;
  const model = raw.model;
  if (isRecord(model) && typeof model.providerID === "string" && typeof model.id === "string") {
    session.model = { providerID: model.providerID, id: model.id };
    if (typeof model.variant === "string") session.model.variant = model.variant;
  }
  return session;
}

/** Client HTTP du service : auth Basic `opencode:<password>`, délai de 10 s par requête (hors flux SSE). */
export function createOpencodeClient(info: ServiceInfo, o: { fetchImpl?: typeof fetch; requestTimeoutMs?: number } = {}): OpencodeClient {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const authorization = "Basic " + Buffer.from(`opencode:${info.password}`).toString("base64");

  /** Corps JSON de la réponse (`undefined` si vide) ; lève `OpencodeHttpError` hors 2xx. */
  async function request(
    method: string,
    path: string,
    o: { query?: Record<string, string>; body?: unknown; allow404?: boolean } = {},
  ): Promise<{ status: number; json: unknown }> {
    const url = new URL(path, info.url);
    for (const [key, value] of Object.entries(o.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { authorization };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    let status: number;
    let text: string;
    try {
      const res = await fetchImpl(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      });
      status = res.status;
      text = await res.text();
    } catch (error) {
      throw new OpencodeHttpError(0, `${method} ${path}: ${errorMessage(error)}`);
    }
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (status < 200 || status >= 300) {
      if (status === 404 && o.allow404) return { status, json };
      const tag = isRecord(json) && typeof json._tag === "string" ? json._tag : undefined;
      const detail = isRecord(json) && typeof json.message === "string" ? json.message : "";
      throw new OpencodeHttpError(status, `${method} ${path}: HTTP ${status}${detail ? ` ${detail}` : ""}`, tag, detail || undefined);
    }
    return { status, json };
  }

  /** Champ `data` de l'enveloppe commune à toutes les routes sauf `/api/info`. */
  function dataOf(res: { status: number; json: unknown }): unknown {
    if (!isRecord(res.json) || !("data" in res.json)) throw new OpencodeHttpError(res.status, "unexpected response: no data field");
    return res.json.data;
  }

  const sessionPath = (id: string): string => `/api/session/${encodeURIComponent(id)}`;

  return {
    async info() {
      const res = await request("GET", "/api/info");
      if (!isRecord(res.json) || typeof res.json.version !== "string") throw new OpencodeHttpError(res.status, "unexpected /api/info payload");
      return { version: res.json.version };
    },

    async listModels(directory) {
      const data = dataOf(await request("GET", "/api/model", { query: { "location[directory]": directory } }));
      if (!Array.isArray(data)) throw new OpencodeHttpError(200, "unexpected /api/model payload");
      return data as ModelEntry[];
    },

    async getSession(id) {
      const res = await request("GET", sessionPath(id), { allow404: true });
      if (res.status === 404) return undefined;
      return asSession(dataOf(res), res.status);
    },

    async createSession(s) {
      const body: Record<string, unknown> = { location: { directory: s.directory } };
      if (s.model) body.model = s.model;
      if (s.id !== undefined) body.id = s.id;
      const res = await request("POST", "/api/session", { body });
      return asSession(dataOf(res), res.status);
    },

    async listSessions(directory) {
      const res = await request("GET", "/api/session", { query: { directory, order: "desc" } });
      const data = dataOf(res);
      if (!Array.isArray(data)) throw new OpencodeHttpError(res.status, "unexpected /api/session payload");
      return data.map((raw) => asSession(raw, res.status));
    },

    async switchModel(id, model) {
      await request("POST", `${sessionPath(id)}/model`, { body: { model } });
    },

    async cancelInbox(id, inboxID) {
      await request("DELETE", `${sessionPath(id)}/inbox/${encodeURIComponent(inboxID)}`);
    },

    async prompt(id, p) {
      const res = await request("POST", `${sessionPath(id)}/prompt`, {
        body: { text: p.text, delivery: p.delivery, metadata: p.metadata },
      });
      const data = dataOf(res);
      if (!isRecord(data) || typeof data.id !== "string") throw new OpencodeHttpError(res.status, "unexpected prompt payload");
      return { inboxID: data.id };
    },

    async activeSessions() {
      const res = await request("GET", "/api/session/active");
      const data = dataOf(res);
      if (!isRecord(data)) throw new OpencodeHttpError(res.status, "unexpected /api/session/active payload");
      return new Set(Object.keys(data));
    },
  };
}
