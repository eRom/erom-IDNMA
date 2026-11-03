import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { connectDaemon } from "../src/codex/daemon.ts";
import { connectCodex, CodexRpcError, type CodexClient, type CodexNotification } from "../src/codex/rpc.ts";
import { codexDaemonSocket, codexHome } from "../src/paths.ts";
import { startFakeCodexDaemon, type FakeCodexDaemon } from "./helpers/fake-codex-daemon.ts";

let dir: string;
let daemon: FakeCodexDaemon;
let client: CodexClient | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ["CODEX_HOME", "IDNMA_CONFIG_DIR"]) saved[name] = process.env[name];
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.CODEX_HOME = dir;
  process.env.IDNMA_CONFIG_DIR = join(dir, "config");
  mkdirSync(join(dir, "app-server-control"), { recursive: true });
  daemon = startFakeCodexDaemon(codexDaemonSocket());
  client = undefined;
});

afterEach(() => {
  client?.close();
  daemon.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const name of ["CODEX_HOME", "IDNMA_CONFIG_DIR"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

function connect(onNotification: (n: CodexNotification) => void = () => {}): Promise<CodexClient> {
  return connectCodex({ socketPath: daemon.socketPath, onNotification });
}

test("codexHome and codexDaemonSocket follow CODEX_HOME at each call", () => {
  expect(codexHome()).toBe(dir);
  expect(codexDaemonSocket()).toBe(join(dir, "app-server-control", "app-server-control.sock"));
  process.env.CODEX_HOME = "/tmp/elsewhere";
  expect(codexDaemonSocket()).toBe("/tmp/elsewhere/app-server-control/app-server-control.sock");
});

test("connects, initializes, then sends initialized", async () => {
  client = await connect();
  await waitFor(() => daemon.received.length >= 2);
  const first = daemon.received[0]!;
  expect(first.method).toBe("initialize");
  expect(typeof first.id).toBe("number");
  expect(first.params).toEqual({
    clientInfo: { name: "idnma", title: null, version: pkg.version },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  expect(daemon.received[1]).toEqual({ method: "initialized" });
});

test("resolves a result", async () => {
  daemon.handle("thread/loaded/list", () => ({ result: { data: ["a", "b"] } }));
  client = await connect();
  expect(await client.request<unknown>("thread/loaded/list", {})).toEqual({ data: ["a", "b"] });
});

test("sends increasing integer ids", async () => {
  daemon.handle("ping", () => ({ result: {} }));
  client = await connect();
  await client.request("ping", {});
  await client.request("ping", {});
  const ids = daemon.received.filter((frame) => frame.method !== "initialized").map((frame) => frame.id as number);
  expect(ids.length).toBe(3);
  expect(ids.every((id, index) => Number.isInteger(id) && (index === 0 || id > ids[index - 1]!))).toBe(true);
});

test("rejects a JSON-RPC error with its code", async () => {
  const message = "failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }";
  daemon.handle("turn/start", () => ({ error: { code: -32603, message } }));
  client = await connect();
  const error = await client.request("turn/start", {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CodexRpcError);
  expect((error as CodexRpcError).code).toBe(-32603);
  expect((error as CodexRpcError).message).toBe(message);
});

test("a method without a handler answers method not found", async () => {
  client = await connect();
  const error = await client.request("nope", {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CodexRpcError);
  expect((error as CodexRpcError).code).toBe(-32601);
});

test("delivers notifications in order and survives a throwing handler", async () => {
  const seen: string[] = [];
  client = await connect((n) => {
    seen.push(String(n.params.n));
    if (n.params.n === 1) throw new Error("handler boom");
  });
  daemon.notify("thing/happened", { n: 1 });
  daemon.notify("thing/happened", { n: 2 });
  daemon.notify("thing/happened", { n: 3 });
  await waitFor(() => seen.length === 3);
  expect(seen).toEqual(["1", "2", "3"]);
  const log = readFileSync(join(dir, "config", "logs", "idnma.log"), "utf8");
  expect(log).toContain("codex-notification-error");
});

test("isolates a rejecting async notification handler", async () => {
  const seen: string[] = [];
  client = await connect(async (n) => {
    seen.push(String(n.params.n));
    if (n.params.n === 1) throw new Error("async boom");
  });
  daemon.notify("thing/happened", { n: 1 });
  daemon.notify("thing/happened", { n: 2 });
  daemon.notify("thing/happened", { n: 3 });
  await waitFor(() => seen.length === 3);
  await Bun.sleep(50);
  expect(seen).toEqual(["1", "2", "3"]);
  const log = readFileSync(join(dir, "config", "logs", "idnma.log"), "utf8");
  expect(log).toContain("codex-notification-error");
  expect(log).toContain("async boom");
});

test("never answers a server request, and logs it", async () => {
  client = await connect();
  daemon.serverRequest(99, "item/commandExecution/requestApproval", {});
  await Bun.sleep(300);
  expect(daemon.received.some((frame) => frame.id === 99)).toBe(false);
  const log = readFileSync(join(dir, "config", "logs", "idnma.log"), "utf8");
  expect(log).toContain("codex-server-request-ignored");
  expect(log).toContain("item/commandExecution/requestApproval");
});

test("round-trips a 200 KiB string intact", async () => {
  daemon.handle("echo", (params) => ({ result: params }));
  client = await connect();
  const big = "x".repeat(200 * 1024);
  const reply = await client.request<{ text: string }>("echo", { text: big });
  expect(reply.text.length).toBe(big.length);
  expect(reply.text === big).toBe(true);
});

test("rejects pending requests when the daemon drops the connection", async () => {
  daemon.handle("silent", () => undefined);
  client = await connect();
  const pending = client.request("silent", {}, 5000).catch((e: unknown) => e);
  await waitFor(() => daemon.received.some((frame) => frame.method === "silent"));
  daemon.dropConnections();
  const error = await pending;
  expect(error).toBeInstanceOf(CodexRpcError);
  expect((error as CodexRpcError).code).toBeUndefined();
  await client.closed;
  const after = await client.request("silent", {}).catch((e: unknown) => e);
  expect(after).toBeInstanceOf(CodexRpcError);
  expect((after as CodexRpcError).message).toContain("fermée");
});

test("close is seen by the daemon", async () => {
  client = await connect();
  expect(daemon.openConnections()).toBe(1);
  client.close();
  await client.closed;
  await waitFor(() => daemon.openConnections() === 0);
  const after = await client.request("x", {}).catch((e: unknown) => e);
  expect(after).toBeInstanceOf(CodexRpcError);
});

test("times out a silent request", async () => {
  daemon.handle("silent", () => undefined);
  client = await connect();
  const error = await client.request("silent", {}, 200).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CodexRpcError);
  expect((error as CodexRpcError).message).toContain("délai dépassé");
  expect((error as CodexRpcError).code).toBeUndefined();
});

test("connectCodex rejects when nothing listens on the socket", async () => {
  const error = await connectCodex({ socketPath: join(dir, "absent.sock"), onNotification: () => {} }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CodexRpcError);
});

test("connectDaemon starts the daemon once when the socket is absent", async () => {
  daemon.stop();
  let calls = 0;
  client = await connectDaemon({
    onNotification: () => {},
    startDaemon: async () => {
      calls += 1;
      daemon = startFakeCodexDaemon(codexDaemonSocket());
    },
  });
  expect(calls).toBe(1);
  daemon.handle("ping", () => ({ result: "pong" }));
  expect(await client.request<string>("ping", {})).toBe("pong");
});

test("connectDaemon does not start the daemon when it is already up", async () => {
  let calls = 0;
  client = await connectDaemon({ onNotification: () => {}, startDaemon: async () => void (calls += 1) });
  expect(calls).toBe(0);
});

test("connectDaemon fails with the socket path when the daemon never comes up", async () => {
  daemon.stop();
  let calls = 0;
  const error = await connectDaemon({ onNotification: () => {}, startDaemon: async () => void (calls += 1) }).catch((e: unknown) => e);
  expect(calls).toBe(1);
  expect(error).toBeInstanceOf(CodexRpcError);
  expect((error as CodexRpcError).message).toContain(codexDaemonSocket());
});

test("connectDaemon without permission to start neither starts the daemon nor logs a start", async () => {
  daemon.stop();
  let calls = 0;
  const error = await connectDaemon({
    onNotification: () => {},
    allowStart: false,
    startDaemon: async () => void (calls += 1),
  }).catch((e: unknown) => e);
  expect(calls).toBe(0);
  expect(error).toBeInstanceOf(CodexRpcError);
  expect((error as CodexRpcError).message).toContain(codexDaemonSocket());
  const logPath = join(dir, "config", "logs", "idnma.log");
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  expect(log).not.toContain("codex-daemon-start");
});

test("connectCodex rejects within its timeout when initialize is never answered", async () => {
  daemon.handle("initialize", () => undefined);
  const startedAt = Date.now();
  const error = await connectCodex({ socketPath: daemon.socketPath, onNotification: () => {}, connectTimeoutMs: 200 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CodexRpcError);
  expect((error as CodexRpcError).code).toBeUndefined();
  expect(Date.now() - startedAt).toBeLessThan(1000);
  await waitFor(() => daemon.openConnections() === 0);
});

test("connectCodex rejects, not hangs, when the daemon drops the connection during initialize", async () => {
  daemon.handle("initialize", () => {
    daemon.dropConnections();
    return undefined;
  });
  const error = await connectCodex({ socketPath: daemon.socketPath, onNotification: () => {} }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CodexRpcError);
  expect((error as CodexRpcError).message).toContain("fermée");
  await waitFor(() => daemon.openConnections() === 0);
});
