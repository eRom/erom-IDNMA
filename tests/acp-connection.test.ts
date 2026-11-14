import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchPlan } from "../src/acp/harness.ts";
import type { AgentEvent, PermissionAnswer, PermissionRequest } from "../src/acp/events.ts";
import {
  AgentNotConnectedError,
  AgentStartError,
  SessionNotFoundError,
  connectAgent,
  type AgentConnection,
  type ConnectionHandlers,
} from "../src/acp/connection.ts";

const FAKE_AGENT = join(import.meta.dir, "helpers", "fake-acp-agent.ts");

let dir: string;
let previousConfigDir: string | undefined;
const opened: AgentConnection[] = [];
let grandchildFile: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.IDNMA_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "idnma-acp-"));
  process.env.IDNMA_CONFIG_DIR = dir;
});

afterEach(async () => {
  for (const connection of opened.splice(0)) await connection.close();
  // Filet de sécurité : un petit-enfant resté vivant après un test en échec est tué par son pid noté.
  if (grandchildFile && existsSync(grandchildFile)) {
    const pid = Number(readFileSync(grandchildFile, "utf8"));
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // déjà mort
    }
  }
  grandchildFile = undefined;
  rmSync(dir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
  else process.env.IDNMA_CONFIG_DIR = previousConfigDir;
});

type Json = Record<string, unknown>;

function option(id: string, category: string, currentValue: string, values: string[]): Json {
  return { id, name: id, category, type: "select", currentValue, options: values.map((value) => ({ value, name: value })) };
}

const STANDARD_OPTIONS = [
  option("model", "model", "opus", ["opus", "haiku"]),
  option("effort", "thought_level", "high", ["low", "medium", "high"]),
  option("mode", "mode", "default", ["default", "plan", "auto"]),
];

const agentChunk = (text: string): Json => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const userChunk = (text: string): Json => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
const toolCall = (toolCallId: string, status: string): Json => ({ sessionUpdate: "tool_call", toolCallId, title: "Run", kind: "execute", status });
const toolUpdate = (toolCallId: string, status: string): Json => ({ sessionUpdate: "tool_call_update", toolCallId, status });

function planFor(scenario: Json, overrides: Partial<LaunchPlan> = {}): LaunchPlan {
  const scenarioFile = join(dir, "scenario.json");
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  return {
    harness: "claude",
    label: "Claude",
    delivery: "auto",
    argv: [process.execPath, FAKE_AGENT],
    env: { FAKE_ACP_SCENARIO: scenarioFile, HOME: dir },
    configSteps: [],
    ignored: [],
    resume: { kind: "new" },
    ...overrides,
  };
}

interface Harness {
  connection: AgentConnection;
  events: { event: AgentEvent; origin: "replay" | "live" }[];
  permissions: PermissionRequest[];
  exits: { code: number | null; signal: string | null }[];
}

function connect(plan: LaunchPlan, onPermission?: ConnectionHandlers["onPermission"]): Harness {
  const events: Harness["events"] = [];
  const permissions: PermissionRequest[] = [];
  const exits: Harness["exits"] = [];
  const connection = connectAgent(plan, {
    onEvent: (event, origin) => events.push({ event, origin }),
    onPermission:
      onPermission ??
      (async (request): Promise<PermissionAnswer> => {
        permissions.push(request);
        return { outcome: "selected", optionId: request.choices[0]!.optionId };
      }),
    onExit: (code, signal) => exits.push({ code, signal }),
  });
  opened.push(connection);
  return { connection, events, permissions, exits };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function readLines(file: string): Json[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Json);
}

function requestsOf(received: string, method: string): Json[] {
  return readLines(received).filter((line) => line["type"] === "request" && line["method"] === method).map((line) => line["params"] as Json);
}

function logLines(): Json[] {
  return readLines(join(dir, "logs", "idnma.log"));
}

describe("connectAgent", () => {
  test("open starts a session and applies config steps in order", async () => {
    const received = join(dir, "received.jsonl");
    const plan = planFor(
      { sessionId: "s-1", configOptions: STANDARD_OPTIONS, received },
      {
        configSteps: [
          { category: "model", value: "haiku", origin: "--model haiku" },
          { category: "thought_level", value: "low", origin: "--effort low" },
          { category: "mode", value: "plan", origin: "--permission-mode plan" },
        ],
      },
    );
    const { connection } = connect(plan);
    expect(connection.pid).toBeGreaterThan(0);

    const session = await connection.open(dir);

    expect(session.sessionId).toBe("s-1");
    expect(session.resumed).toBe(false);
    expect(session.noPreviousSession).toBe(false);
    expect(session.replayed).toBe(0);
    expect(session.ignored).toEqual([]);
    expect(session.options.map((o) => [o.category, o.currentValue])).toEqual([
      ["model", "haiku"],
      ["thought_level", "low"],
      ["mode", "plan"],
    ]);
    const lines = readLines(received).filter((line) => line["type"] === "request");
    expect(lines.map((line) => line["method"])).toEqual(["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option"]);
    // Le pas est résolu par catégorie contre l'identifiant annoncé (`effort` pour `thought_level`).
    expect(requestsOf(received, "session/set_config_option").map((p) => [p["configId"], p["value"]])).toEqual([
      ["model", "haiku"],
      ["effort", "low"],
      ["mode", "plan"],
    ]);
    expect(requestsOf(received, "session/new")[0]).toMatchObject({ cwd: dir, mcpServers: [] });
  });

  test("session/new carries the plan's meta", async () => {
    const received = join(dir, "received.jsonl");
    const plan = planFor({ received }, { newSessionMeta: { systemPrompt: { append: "hello" } } });
    await connect(plan).connection.open(dir);
    expect(requestsOf(received, "session/new")[0]?.["_meta"]).toEqual({ systemPrompt: { append: "hello" } });
  });

  test("a refused step value is announced, not thrown", async () => {
    const plan = planFor(
      { configOptions: STANDARD_OPTIONS },
      {
        configSteps: [
          { category: "model", value: "haiku", origin: "--model haiku" },
          { category: "thought_level", value: "turbo", origin: "--effort turbo" },
        ],
      },
    );
    const session = await connect(plan).connection.open(dir);
    expect(session.ignored).toEqual(["--effort turbo"]);
    expect(session.options.find((o) => o.category === "model")?.currentValue).toBe("haiku");
    expect(session.options.find((o) => o.category === "thought_level")?.currentValue).toBe("high");
  });

  test("a step whose category the agent does not announce is announced as ignored", async () => {
    const received = join(dir, "received.jsonl");
    const plan = planFor(
      { configOptions: [option("model", "model", "opus", ["opus", "haiku"])], received },
      { configSteps: [{ category: "mode", value: "plan", origin: "--permission-mode plan" }] },
    );
    const session = await connect(plan).connection.open(dir);
    expect(session.ignored).toEqual(["--permission-mode plan"]);
    expect(requestsOf(received, "session/set_config_option")).toEqual([]);
  });

  test("the agent receives the plan's env and nothing of the parent's", async () => {
    const envDump = join(dir, "env.json");
    process.env.IDNMA_TEST_LEAK = "leak";
    try {
      const plan = planFor({ envDump });
      plan.env.IDNMA_TEST_MARKER = "present";
      await connect(plan).connection.open(dir);
    } finally {
      delete process.env.IDNMA_TEST_LEAK;
    }
    const env = JSON.parse(readFileSync(envDump, "utf8")) as Record<string, string>;
    expect(env["IDNMA_TEST_MARKER"]).toBe("present");
    expect(env["IDNMA_TEST_LEAK"]).toBeUndefined();
  });

  test("a prompt streams events then resolves with its stop reason", async () => {
    const plan = planFor({
      configOptions: STANDARD_OPTIONS,
      turn: { updates: [agentChunk("Hel"), agentChunk("lo"), toolCall("t1", "pending"), toolUpdate("t1", "completed")], stopReason: "end_turn" },
    });
    const { connection, events } = connect(plan);
    await connection.open(dir);

    const stop = await connection.prompt("say hello");

    expect(stop).toBe("end_turn");
    // Les événements sont tous livrés avant que le tour ne se résolve, dans l'ordre d'arrivée.
    expect(events.map((e) => e.event)).toEqual([
      { type: "chunk", role: "agent", text: "Hel" },
      { type: "chunk", role: "agent", text: "lo" },
      { type: "tool", id: "t1", created: true, title: "Run", kind: "execute", status: "pending" },
      { type: "tool", id: "t1", created: false, status: "completed" },
    ]);
    expect(events.every((e) => e.origin === "live")).toBe(true);
  });

  test("the prompt text reaches the agent as a text block of the session", async () => {
    const received = join(dir, "received.jsonl");
    const { connection } = connect(planFor({ sessionId: "s-9", received }));
    await connection.open(dir);
    await connection.prompt("do the thing");
    expect(requestsOf(received, "session/prompt")[0]).toEqual({ sessionId: "s-9", prompt: [{ type: "text", text: "do the thing" }] });
  });

  test("a permission is bridged to the handler and its answer reaches the agent", async () => {
    const received = join(dir, "received.jsonl");
    const plan = planFor({
      received,
      turn: {
        permission: {
          toolCall: { toolCallId: "t9", title: "touch probe.txt", kind: "execute", status: "pending" },
          options: [
            { optionId: "allow-once", name: "Yes", kind: "allow_once" },
            { optionId: "reject", name: "No", kind: "reject_once" },
          ],
        },
        updatesAfterPermission: [agentChunk("done")],
      },
    });
    const { connection, events, permissions } = connect(plan);
    await connection.open(dir);

    const stop = await connection.prompt("go");

    expect(stop).toBe("end_turn");
    expect(permissions).toEqual([
      {
        toolCallId: "t9",
        title: "touch probe.txt",
        kind: "execute",
        choices: [
          { optionId: "allow-once", name: "Yes", kind: "allow_once" },
          { optionId: "reject", name: "No", kind: "reject_once" },
        ],
      },
    ]);
    // L'identifiant JSON-RPC de la demande est 0, comme chez l'adaptateur de Claude.
    const answer = readLines(received).find((line) => line["type"] === "response" && line["id"] === 0);
    expect(answer?.["result"]).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(events.map((e) => e.event)).toEqual([{ type: "chunk", role: "agent", text: "done" }]);
  });

  const pendingPermissionScenario = (extra: Json): Json => ({
    ...extra,
    turn: {
      permission: {
        toolCall: { toolCallId: "t1", title: "sleep", kind: "execute", status: "pending" },
        options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }],
      },
      updatesAfterPermission: [agentChunk("must not appear")],
    },
  });

  /** Gestionnaire qui ne répond jamais : seule l'annulation peut clore la demande. */
  function silentHandler(): { handler: ConnectionHandlers["onPermission"]; signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    return {
      signals,
      handler: (_request, signal) => {
        signals.push(signal);
        return new Promise<PermissionAnswer>(() => {});
      },
    };
  }

  test("cancel answers a pending permission with cancelled and the turn ends cancelled", async () => {
    const received = join(dir, "received.jsonl");
    const { handler, signals } = silentHandler();
    const { connection, events } = connect(planFor(pendingPermissionScenario({ received })), handler);
    await connection.open(dir);

    const turn = connection.prompt("sleep");
    await waitFor(() => signals.length === 1, "the permission request");
    connection.cancel();

    expect(await turn).toBe("cancelled");
    expect(signals[0]?.aborted).toBe(true);
    const answer = readLines(received).find((line) => line["type"] === "response" && line["id"] === 0);
    expect(answer?.["result"]).toEqual({ outcome: { outcome: "cancelled" } });
    expect(readLines(received).some((line) => line["type"] === "notification" && line["method"] === "session/cancel")).toBe(true);
    expect(events).toEqual([]);
  });

  test("cancel also holds when the agent withdraws the permission itself", async () => {
    const received = join(dir, "received.jsonl");
    const { handler, signals } = silentHandler();
    const { connection } = connect(planFor(pendingPermissionScenario({ received, cancelRequestsPermission: true })), handler);
    await connection.open(dir);

    const turn = connection.prompt("sleep");
    await waitFor(() => signals.length === 1, "the permission request");
    connection.cancel();

    expect(await turn).toBe("cancelled");
    expect(signals[0]?.aborted).toBe(true);
  });

  test("cancel with nothing pending is harmless, and before open it does nothing", async () => {
    const { connection } = connect(planFor({}));
    connection.cancel();
    await connection.open(dir);
    connection.cancel();
    expect(await connection.prompt("hello")).toBe("end_turn");
  });

  test("continue picks the latest session of the folder, or opens a new one", async () => {
    const received = join(dir, "received.jsonl");
    const pages = [
      [
        { sessionId: "s-old", cwd: "/work/a", updatedAt: "2026-11-01T10:00:00Z" },
        { sessionId: "s-elsewhere", cwd: "/work/other", updatedAt: "2026-11-13T10:00:00Z" },
      ],
      [{ sessionId: "s-new", cwd: "/work/a", updatedAt: "2026-11-10T10:00:00Z" }],
    ];
    const plan = planFor({ received, listPages: pages, configOptions: STANDARD_OPTIONS }, { resume: { kind: "continue" }, loadSessionMeta: { marker: 1 } });
    const found = await connect(plan).connection.open("/work/a");

    expect(found.resumed).toBe(true);
    expect(found.noPreviousSession).toBe(false);
    expect(found.sessionId).toBe("s-new");
    expect(requestsOf(received, "session/list")).toEqual([{ cwd: "/work/a" }, { cwd: "/work/a", cursor: "1" }]);
    expect(requestsOf(received, "session/load")[0]).toMatchObject({ sessionId: "s-new", cwd: "/work/a", mcpServers: [], _meta: { marker: 1 } });
    expect(requestsOf(received, "session/new")).toEqual([]);

    const receivedEmpty = join(dir, "received-empty.jsonl");
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ received: receivedEmpty, listPages: [[]], sessionId: "s-fresh" }));
    const empty = await connect({ ...plan, env: { ...plan.env } }).connection.open("/work/a");
    expect(empty.resumed).toBe(false);
    expect(empty.noPreviousSession).toBe(true);
    expect(empty.sessionId).toBe("s-fresh");
    expect(requestsOf(receivedEmpty, "session/new").length).toBe(1);
  });

  test("a list that stops after ten pages still ends", async () => {
    const received = join(dir, "received.jsonl");
    const pages = Array.from({ length: 14 }, (_, i) => [{ sessionId: `s-${i}`, cwd: "/work/a", updatedAt: `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00Z` }]);
    const plan = planFor({ received, listPages: pages }, { resume: { kind: "continue" } });
    const session = await connect(plan).connection.open("/work/a");
    expect(requestsOf(received, "session/list").length).toBe(10);
    expect(session.sessionId).toBe("s-9");
  });

  test("load replays the conversation before resolving, every event tagged replay", async () => {
    const plan = planFor(
      {
        replay: [userChunk("question"), agentChunk("answer"), toolCall("t1", "completed")],
        turn: { updates: [agentChunk("next turn")] },
        configOptions: STANDARD_OPTIONS,
      },
      { resume: { kind: "id", id: "s-old" } },
    );
    const { connection, events } = connect(plan);

    const session = await connection.open(dir);

    expect(session.resumed).toBe(true);
    expect(session.sessionId).toBe("s-old");
    expect(session.replayed).toBe(3);
    // Au moment où `open` se résout, les trois événements sont déjà livrés, tous marqués `replay`.
    expect(events.map((e) => [e.event.type, e.origin])).toEqual([
      ["chunk", "replay"],
      ["chunk", "replay"],
      ["tool", "replay"],
    ]);
    expect(session.options.length).toBe(3);

    await connection.prompt("again");
    expect(events.at(-1)).toEqual({ event: { type: "chunk", role: "agent", text: "next turn" }, origin: "live" });
  });

  test("load of an unknown session raises SessionNotFoundError, other failures AgentStartError", async () => {
    const missing = connect(planFor({ loadNotFound: true }, { resume: { kind: "id", id: "gone" } }));
    await expect(missing.connection.open(dir)).rejects.toBeInstanceOf(SessionNotFoundError);

    const other = connect(planFor({ sessionNewError: { code: -32603, message: "Internal error" } }));
    const failure = await other.connection.open(dir).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentStartError);
    expect((failure as AgentStartError).code).toBe(-32603);
    expect(failure).not.toBeInstanceOf(SessionNotFoundError);
  });

  test("an agent that is not logged in raises AgentNotConnectedError", async () => {
    const created = connect(planFor({ authRequired: true }));
    await expect(created.connection.open(dir)).rejects.toBeInstanceOf(AgentNotConnectedError);
    const loaded = connect(planFor({ authRequired: true }, { resume: { kind: "id", id: "s" } }));
    await expect(loaded.connection.open(dir)).rejects.toBeInstanceOf(AgentNotConnectedError);
  });

  test("an unknown update, a garbage line and stderr noise never surface", async () => {
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const plan = planFor({ unknownUpdate: true, garbageLine: true, stderrNoise: true, turn: { updates: [agentChunk("visible")] } });
      const { connection, events } = connect(plan);
      await connection.open(dir);
      expect(await connection.prompt("go")).toBe("end_turn");
      expect(events.map((e) => e.event)).toEqual([{ type: "chunk", role: "agent", text: "visible" }]);
      await waitFor(() => logLines().some((line) => line["event"] === "agent-stderr"), "the stderr log line");
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderrWrites.join("")).not.toContain("noise");

    const log = logLines();
    const dropped = log.filter((line) => line["event"] === "acp-unknown-update");
    expect(dropped).toEqual([expect.objectContaining({ method: "session/update", sessionUpdate: "plan_update" })]);
    // Ni le contenu de la trame ni le texte de stderr n'atteignent le journal ; le SDK n'a rien eu à rejeter.
    expect(JSON.stringify(log)).not.toContain("someone@example.com");
    expect(JSON.stringify(log)).not.toContain("noise");
    expect(log.some((line) => line["event"] === "acp-sdk-error")).toBe(false);
    for (const line of log.filter((l) => l["event"] === "agent-stderr")) expect(typeof line["bytes"]).toBe("number");
  });

  test("an unknown update's variant is cut to 64 characters in the log", async () => {
    const plan = planFor({ unknownUpdate: "v".repeat(200), turn: {} });
    const { connection } = connect(plan);
    await connection.open(dir);
    await connection.prompt("go");
    const dropped = logLines().find((line) => line["event"] === "acp-unknown-update");
    expect(dropped?.["sessionUpdate"]).toBe("v".repeat(64));
  });

  test("an agent that dies mid-turn reports its exit", async () => {
    const plan = planFor({ exitDuringPrompt: 3, turn: { updates: [agentChunk("last words")] } });
    const { connection, events, exits } = connect(plan);
    await connection.open(dir);

    const failure = await connection.prompt("go").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AgentStartError);
    expect((failure as AgentStartError).code).toBe(3);
    await waitFor(() => exits.length === 1, "the exit report");
    expect(exits).toEqual([{ code: 3, signal: null }]);
    // Ce que l'agent a écrit avant de mourir est livré avant le rapport de sortie.
    expect(events.map((e) => e.event)).toEqual([{ type: "chunk", role: "agent", text: "last words" }]);
  });

  test("an agent that dies before answering fails the open with its exit code", async () => {
    const plan = planFor({}, { argv: [process.execPath, "-e", "process.exit(4)"] });
    const { connection, exits } = connect(plan);
    const failure = await connection.open(dir).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentStartError);
    expect((failure as AgentStartError).code).toBe(4);
    await waitFor(() => exits.length === 1, "the exit report");
    expect(exits[0]).toEqual({ code: 4, signal: null });
  });

  test("a binary that cannot be started fails the open", async () => {
    const plan = planFor({}, { argv: [join(dir, "no-such-binary")] });
    const { connection } = connect(plan);
    await expect(connection.open(dir)).rejects.toBeInstanceOf(AgentStartError);
  });

  test("setOption changes one option by category and returns the full list", async () => {
    const received = join(dir, "received.jsonl");
    const { connection } = connect(planFor({ configOptions: STANDARD_OPTIONS, received }));
    await connection.open(dir);

    const options = await connection.setOption("mode", "auto");

    expect(options.find((o) => o.category === "mode")?.currentValue).toBe("auto");
    expect(options.length).toBe(3);
    expect(requestsOf(received, "session/set_config_option").at(-1)).toMatchObject({ configId: "mode", value: "auto" });
    await expect(connection.setOption("mode", "turbo")).rejects.toThrow();
    await expect(connection.setOption("nonexistent", "x")).rejects.toThrow();
  });

  test("an option the agent announces through a config event is the one setOption sees", async () => {
    const plan = planFor({
      configOptions: [option("model", "model", "opus", ["opus", "haiku"])],
      turn: {
        updates: [
          { sessionUpdate: "config_option_update", configOptions: [option("model", "model", "opus", ["opus", "haiku"]), option("mode", "mode", "default", ["default", "plan"])] },
        ],
      },
    });
    const { connection } = connect(plan);
    await connection.open(dir);
    await connection.prompt("go");
    // `mode` n'existe dans le scénario que par l'annonce de l'agent : l'agent le refuse, mais la requête part.
    await expect(connection.setOption("mode", "plan")).rejects.toThrow("Invalid params");
  });

  test("close kills the whole process group, and is idempotent", async () => {
    grandchildFile = join(dir, "grandchild.pid");
    const { connection } = connect(planFor({ spawnGrandchild: grandchildFile }));
    await connection.open(dir);
    await waitFor(() => existsSync(grandchildFile!), "the grandchild pid file");
    const grandchildPid = Number(readFileSync(grandchildFile, "utf8"));
    const agentPid = connection.pid;
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();

    await Promise.all([connection.close(), connection.close()]);

    // Un simple `child.kill()` aurait laissé vivre le petit-enfant.
    expect(() => process.kill(grandchildPid, 0)).toThrow();
    expect(() => process.kill(agentPid, 0)).toThrow();
    await connection.close();
  });

  test("close escalates to SIGKILL when the agent ignores SIGTERM", async () => {
    const script = join(dir, "stubborn.ts");
    writeFileSync(script, 'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\nprocess.stdout.write("");\n');
    const { connection } = connect(planFor({}, { argv: [process.execPath, script] }));
    await Bun.sleep(300);
    const started = Date.now();
    await connection.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(() => process.kill(connection.pid, 0)).toThrow();
  }, 10_000);
});
