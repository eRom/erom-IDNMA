import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { filterUnknownUpdates, KNOWN_SESSION_UPDATES, silenceConsoleError } from "../src/acp/stream-filter.ts";

function streamOf(messages: unknown[]): ReadableStream<AnyMessage> {
  return new ReadableStream<AnyMessage>({
    start(controller) {
      for (const message of messages) controller.enqueue(message as AnyMessage);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<AnyMessage>): Promise<AnyMessage[]> {
  const out: AnyMessage[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

function sessionUpdate(update: unknown): unknown {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update } };
}

describe("filterUnknownUpdates", () => {
  test("an unknown session/update variant is dropped and reported without its content", async () => {
    const dropped: unknown[] = [];
    const out = filterUnknownUpdates(
      streamOf([
        sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
        sessionUpdate({ sessionUpdate: "plan_update", secret: "x@y.z" }),
        { jsonrpc: "2.0", id: 3, result: {} },
      ]),
      (info) => dropped.push(info),
    );
    expect((await collect(out)).length).toBe(2);
    expect(dropped).toEqual([{ method: "session/update", sessionUpdate: "plan_update" }]);
    expect(JSON.stringify(dropped)).not.toContain("x@y.z");
  });

  test("every known variant passes through and nothing is reported", async () => {
    const dropped: unknown[] = [];
    const known = [...KNOWN_SESSION_UPDATES];
    const out = filterUnknownUpdates(streamOf(known.map((name) => sessionUpdate({ sessionUpdate: name }))), (info) => dropped.push(info));
    expect((await collect(out)).length).toBe(known.length);
    expect(dropped).toEqual([]);
  });

  test("requests, responses and other notifications pass untouched", async () => {
    const dropped: unknown[] = [];
    const messages = [
      { jsonrpc: "2.0", id: 0, method: "session/request_permission", params: { sessionId: "s", toolCall: { toolCallId: "t" }, options: [] } },
      { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } },
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "boom" } },
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } },
    ];
    const out = await collect(filterUnknownUpdates(streamOf(messages), (info) => dropped.push(info)));
    expect(out).toEqual(messages as AnyMessage[]);
    expect(dropped).toEqual([]);
  });

  test("a session/update with a missing or malformed update is dropped without leaking content", async () => {
    const dropped: unknown[] = [];
    const out = filterUnknownUpdates(
      streamOf([
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s" } },
        sessionUpdate("not-an-object"),
        sessionUpdate({ sessionUpdate: 42 }),
        sessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t" }),
      ]),
      (info) => dropped.push(info),
    );
    expect((await collect(out)).length).toBe(1);
    expect(dropped.length).toBe(3);
    for (const info of dropped) expect(Object.keys(info as object).sort()).toEqual(["method", "sessionUpdate"]);
  });
});

describe("silenceConsoleError", () => {
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.IDNMA_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "idnma-stream-filter-"));
    process.env.IDNMA_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
    else process.env.IDNMA_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  function logLines(): Record<string, unknown>[] {
    const raw = readFileSync(join(configDir, "logs", "idnma.log"), "utf8");
    return raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  test("silenceConsoleError routes console.error to the log and restores it", () => {
    const original = console.error;
    const restore = silenceConsoleError();
    expect(console.error).not.toBe(original);
    console.error("Error handling notification", { secret: "x@y.z" }, new Error("payload"));
    restore();
    expect(console.error).toBe(original);

    const lines = logLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ event: "acp-sdk-error", message: "Error handling notification" });
    expect(JSON.stringify(lines)).not.toContain("x@y.z");
    expect(JSON.stringify(lines)).not.toContain("payload");
  });

  test("overlapping silences restore the original console.error in opening order", () => {
    const original = console.error;
    const restoreA = silenceConsoleError();
    const silenced = console.error;
    const restoreB = silenceConsoleError();
    expect(console.error).toBe(silenced);
    restoreA();
    // La seconde connexion vit encore : le détournement reste en place.
    expect(console.error).toBe(silenced);
    restoreB();
    expect(console.error).toBe(original);
  });

  test("overlapping silences restore the original console.error in reverse order", () => {
    const original = console.error;
    const restoreA = silenceConsoleError();
    const restoreB = silenceConsoleError();
    restoreB();
    expect(console.error).not.toBe(original);
    restoreA();
    expect(console.error).toBe(original);
  });

  test("a restore called twice counts once", () => {
    const original = console.error;
    const restoreA = silenceConsoleError();
    const restoreB = silenceConsoleError();
    restoreA();
    restoreA();
    expect(console.error).not.toBe(original);
    restoreB();
    expect(console.error).toBe(original);
  });

  test("a non-string first argument is logged as a fixed marker", () => {
    const restore = silenceConsoleError();
    console.error({ secret: "x@y.z" });
    restore();
    const lines = logLines();
    expect(lines[0]).toMatchObject({ event: "acp-sdk-error", message: "non-string console.error" });
    expect(JSON.stringify(lines)).not.toContain("x@y.z");
  });
});
