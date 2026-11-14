// Faux agent ACP scripté, pour les tests de `src/acp/connection.ts`.
// Script Bun autonome : il parle du JSON-RPC délimité par des retours à la ligne sur stdin/stdout, en JSON brut,
// sans le SDK, pour rester indépendant du code testé. Le scénario est un fichier JSON désigné par `FAKE_ACP_SCENARIO`.
// Rien d'autre que des lignes JSON-RPC n'est écrit sur stdout, sauf si le scénario demande `garbageLine`.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

type Json = Record<string, unknown>;

interface RawOption {
  id: string;
  name: string;
  category?: string;
  type: "select";
  currentValue: string;
  options: { value: string; name: string }[];
}

interface Scenario {
  sessionId?: string;
  /** Options annoncées à `session/new` et `session/load`. */
  configOptions?: RawOption[];
  /** Pages de `session/list` (le curseur est l'index de la page suivante) ; le filtre `cwd` est ignoré, comme chez agy. */
  listPages?: { sessionId: string; cwd: string; updatedAt?: string }[][];
  /** `session/update` rejoués par `session/load` avant sa réponse. */
  replay?: Json[];
  turn?: {
    updates?: Json[];
    permission?: { toolCall: Json; options: Json[] };
    updatesAfterPermission?: Json[];
    stopReason?: string;
  };
  garbageLine?: boolean;
  stderrNoise?: boolean;
  /** `true` : une variante inconnue `plan_update` ; une chaîne : cette variante inconnue. */
  unknownUpdate?: boolean | string;
  /** Erreur ACP rendue à `session/new` (hors authentification). */
  sessionNewError?: { code: number; message: string };
  /** Code de sortie du process au milieu d'un tour. */
  exitDuringPrompt?: number;
  authRequired?: boolean;
  loadNotFound?: boolean;
  /** Chemin du fichier où écrire le pid d'un petit-enfant `sleep 600` du même groupe de process. */
  spawnGrandchild?: string;
  /** Chemin du fichier où écrire l'environnement reçu. */
  envDump?: string;
  /** Chemin du fichier où consigner chaque message reçu du client (une ligne JSON par message). */
  received?: string;
  /** Comme Claude : retire la permission en suspens par `$/cancel_request` au lieu d'attendre la réponse. */
  cancelRequestsPermission?: boolean;
}

const scenarioPath = process.env.FAKE_ACP_SCENARIO;
const scenario: Scenario = scenarioPath ? (JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario) : {};
const sessionId = scenario.sessionId ?? "fake-session";
let options: RawOption[] = structuredClone(scenario.configOptions ?? []);

function record(entry: Json): void {
  if (scenario.received) appendFileSync(scenario.received, JSON.stringify(entry) + "\n");
}

function send(message: Json): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function sendUpdate(update: Json): void {
  send({ method: "session/update", params: { sessionId, update } });
}

function reply(id: unknown, result: Json): void {
  send({ id, result });
}

function fail(id: unknown, code: number, message: string): void {
  send({ id, error: { code, message } });
}

// Démarrage : l'environnement et le petit-enfant sont écrits avant la première requête.
if (scenario.envDump) writeFileSync(scenario.envDump, JSON.stringify(process.env));
if (scenario.spawnGrandchild) {
  const grandchild = spawn("sleep", ["600"], { stdio: "ignore" });
  writeFileSync(scenario.spawnGrandchild, String(grandchild.pid));
}
if (scenario.stderrNoise) process.stderr.write("fake agent noise on stderr\n");

// Réponses du client à nos propres requêtes (la permission), attendues par id.
const waiters = new Map<unknown, (response: Json) => void>();
let outgoingId = 0;
let pendingPermissionId: number | undefined;
let cancelled = false;

function waitForResponse(id: number): Promise<Json> {
  return new Promise((resolve) => waiters.set(id, resolve));
}

async function handlePrompt(id: unknown): Promise<void> {
  cancelled = false;
  if (scenario.garbageLine) process.stdout.write("this is not json\n");
  if (scenario.stderrNoise) process.stderr.write("fake agent noise during the turn\n");
  if (scenario.unknownUpdate) {
    const variant = typeof scenario.unknownUpdate === "string" ? scenario.unknownUpdate : "plan_update";
    sendUpdate({ sessionUpdate: variant, secret: "someone@example.com" });
  }
  const turn = scenario.turn ?? {};
  for (const update of turn.updates ?? []) sendUpdate(update);

  if (scenario.exitDuringPrompt !== undefined) {
    const code = scenario.exitDuringPrompt;
    process.stdout.write("", () => process.exit(code));
    return;
  }

  if (turn.permission) {
    const requestId = outgoingId++;
    pendingPermissionId = requestId;
    send({ id: requestId, method: "session/request_permission", params: { sessionId, ...turn.permission } });
    await waitForResponse(requestId);
    pendingPermissionId = undefined;
    if (!cancelled) for (const update of turn.updatesAfterPermission ?? []) sendUpdate(update);
  }
  reply(id, { stopReason: cancelled ? "cancelled" : (turn.stopReason ?? "end_turn") });
}

function handleRequest(id: unknown, method: string, params: Json): void {
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }, authMethods: [] });
      return;
    case "session/new":
      if (scenario.authRequired) return fail(id, -32000, "Authentication required");
      if (scenario.sessionNewError) return fail(id, scenario.sessionNewError.code, scenario.sessionNewError.message);
      reply(id, { sessionId, configOptions: options });
      return;
    case "session/list": {
      const pages = scenario.listPages ?? [[]];
      const index = typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
      const result: Json = { sessions: pages[index] ?? [] };
      if (index + 1 < pages.length) result["nextCursor"] = String(index + 1);
      reply(id, result);
      return;
    }
    case "session/load":
      if (scenario.authRequired) return fail(id, -32000, "Authentication required");
      if (scenario.loadNotFound) return fail(id, -32002, "Resource not found");
      for (const update of scenario.replay ?? []) sendUpdate(update);
      reply(id, { configOptions: options });
      return;
    case "session/set_config_option": {
      const option = options.find((o) => o.id === params["configId"]);
      if (!option || !option.options.some((o) => o.value === params["value"])) return fail(id, -32602, "Invalid params");
      option.currentValue = String(params["value"]);
      reply(id, { configOptions: options });
      return;
    }
    case "session/prompt":
      void handlePrompt(id);
      return;
    default:
      fail(id, -32601, "Method not found");
  }
}

function handleLine(line: string): void {
  let message: Json;
  try {
    message = JSON.parse(line) as Json;
  } catch {
    return;
  }
  const { id, method } = message;
  if (typeof method === "string") {
    const params = (message["params"] ?? {}) as Json;
    if (id !== undefined) {
      record({ type: "request", method, params });
      handleRequest(id, method, params);
    } else {
      record({ type: "notification", method, params });
      if (method === "session/cancel") {
        cancelled = true;
        if (scenario.cancelRequestsPermission && pendingPermissionId !== undefined) {
          send({ method: "$/cancel_request", params: { requestId: pendingPermissionId } });
        }
      }
    }
    return;
  }
  if (id === undefined) return;
  // Réponse à l'une de nos requêtes, ou erreur `-32700` renvoyée pour notre ligne parasite (`id: null`).
  record({ type: "response", id, result: message["result"], error: message["error"] });
  const waiter = waiters.get(id);
  if (waiter) {
    waiters.delete(id);
    waiter(message);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== "") handleLine(line);
  }
});
// Le client a fermé le tube : plus rien à servir.
process.stdin.on("end", () => process.exit(0));
