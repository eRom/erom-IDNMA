import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock, RequestPermissionRequest, SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import { textOfContent, toConfigOptions, toPermissionRequest, translateUpdate } from "../src/acp/translate.ts";

interface Frame {
  message: { method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
}

function fixture(name: string): { traffic?: Frame[]; result?: { configOptions: SessionConfigOption[] } } {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "acp", name), "utf8"));
}

/** Les `session/update` d'une capture, dans l'ordre d'arrivée. */
function updatesOf(name: string): SessionUpdate[] {
  return (fixture(name).traffic ?? [])
    .filter((frame) => frame.message.method === "session/update")
    .map((frame) => frame.message.params?.update as SessionUpdate);
}

function configOptionsOf(name: string): SessionConfigOption[] {
  return fixture(name).result?.configOptions ?? [];
}

function permissionOf(name: string): RequestPermissionRequest {
  const frame = (fixture(name).traffic ?? []).find((f) => f.message.method === "session/request_permission");
  return frame?.message.params as unknown as RequestPermissionRequest;
}

const text = (value: string): ContentBlock => ({ type: "text", text: value });

describe("captured traffic", () => {
  test("a captured Claude turn yields tool start, tool completion, agent text and usage", () => {
    const events = updatesOf("claude-turn.json").flatMap(translateUpdate);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", created: true, name: "Bash", status: "pending" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", created: false, status: "completed", rawOutput: "(Bash completed with no output)" }));
    expect(events).toContainEqual({ type: "usage", used: 23325, size: 1000000, cost: { amount: 0.00274447, currency: "USD" } });
    const agentText = events.flatMap((e) => (e.type === "chunk" && e.role === "agent" ? [e.text] : [])).join("");
    expect(agentText).toBe("Un seul mot : Fait");
    expect(events).toContainEqual({ type: "title", title: "Création du fichier probe.txt" });
    expect(events).toContainEqual({ type: "mode", modeId: "default" });
  });

  test("a Claude tool update only carries the fields it brought", () => {
    const events = updatesOf("claude-turn.json").flatMap(translateUpdate);
    const titleOnly = events.find((e) => e.type === "tool" && !e.created && e.title === "touch probe.txt");
    expect(titleOnly).toEqual({ type: "tool", id: "toolu_01NTi63RT7zsHcZaWcT51sQK", created: false, title: "touch probe.txt" });
  });

  test("an agy replayed tool carries its final status and its output", () => {
    const events = updatesOf("agy-replay.json").flatMap(translateUpdate);
    const done = events.find((e) => e.type === "tool" && e.status === "completed");
    expect(done).toMatchObject({ type: "tool", created: true, name: "run_command", kind: "execute" });
    expect(done?.type === "tool" ? done.rawOutput : "").toContain("IDNMA_NAME=");
    const failed = events.find((e) => e.type === "tool" && e.status === "failed");
    expect(failed).toMatchObject({ type: "tool", created: true, rawOutput: "" });
  });

  test("an agy replay keeps user turns, thoughts, commands, usage and title", () => {
    const events = updatesOf("agy-replay.json").flatMap(translateUpdate);
    expect(events.filter((e) => e.type === "chunk" && e.role === "user")).toHaveLength(2);
    expect(events.some((e) => e.type === "chunk" && e.role === "thought")).toBe(true);
    expect(events).toContainEqual({ type: "usage", used: 14606, size: 1048576 });
    expect(events).toContainEqual({ type: "title", title: "Shell Command Execution Setup" });
    const commands = events.find((e) => e.type === "commands");
    expect(commands?.type === "commands" ? commands.commands.map((c) => c.name) : []).toEqual(["review", "plan", "compact"]);
  });

  test("config options keep their category, Claude effort included", () => {
    const options = toConfigOptions(configOptionsOf("claude-session-new.json"));
    expect(options.find((o) => o.category === "thought_level")?.id).toBe("effort");
    expect(options.find((o) => o.id === "agent")?.category).toBeUndefined();
    const mode = options.find((o) => o.id === "mode");
    expect(mode?.values.map((v) => v.value)).toContain(mode?.currentValue ?? "");
  });

  test("agy config options expose the thinking level and the model", () => {
    const options = toConfigOptions(configOptionsOf("agy-session-new.json"));
    expect(options.find((o) => o.id === "thought_level")?.category).toBe("thought_level");
    expect(options.find((o) => o.category === "model")?.values.length).toBeGreaterThan(1);
  });

  test("a permission request keeps the agent's option ids", () => {
    const request = toPermissionRequest(permissionOf("claude-turn.json"));
    expect(request.choices.map((c) => c.optionId)).toEqual(["allow-once", "reject"]);
    expect(request.choices.map((c) => c.kind)).toEqual(["allow_once", "reject_once"]);
    expect(request.title).toBe("touch probe.txt");
    expect(request.toolCallId).toBe("toolu_01NTi63RT7zsHcZaWcT51sQK");
    expect(request.kind).toBe("execute");
  });
});

describe("translateUpdate", () => {
  test("message chunks map to their role and keep the message id", () => {
    expect(translateUpdate({ sessionUpdate: "agent_message_chunk", content: text("hi"), messageId: "m1" })).toEqual([{ type: "chunk", role: "agent", text: "hi", messageId: "m1" }]);
    expect(translateUpdate({ sessionUpdate: "user_message_chunk", content: text("yo") })).toEqual([{ type: "chunk", role: "user", text: "yo" }]);
    expect(translateUpdate({ sessionUpdate: "agent_thought_chunk", content: text("hm"), messageId: null })).toEqual([{ type: "chunk", role: "thought", text: "hm" }]);
  });

  test("tool content maps text and diff, and ignores terminals", () => {
    const events = translateUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Edit",
      content: [
        { type: "content", content: text("done") },
        { type: "diff", path: "/tmp/probe/a.ts", oldText: null, newText: "x" },
        { type: "diff", path: "/tmp/probe/b.ts", oldText: "a", newText: "b" },
        { type: "terminal", terminalId: "term-1" },
      ],
    });
    expect(events).toEqual([
      {
        type: "tool",
        id: "t1",
        created: true,
        title: "Edit",
        content: [
          { kind: "text", text: "done" },
          { kind: "diff", path: "/tmp/probe/a.ts", newText: "x" },
          { kind: "diff", path: "/tmp/probe/b.ts", oldText: "a", newText: "b" },
        ],
      },
    ]);
  });

  test("rawOutput: a string stays, an output field is unwrapped, any other object is serialised", () => {
    const outputOf = (rawOutput: unknown) => {
      const [event] = translateUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", rawOutput });
      return event?.type === "tool" ? event.rawOutput : "missing";
    };
    expect(outputOf("plain")).toBe("plain");
    expect(outputOf({ output: "from agy", exit_code: 0 })).toBe("from agy");
    expect(outputOf({ stdout: "a", code: 1 })).toBe('{"stdout":"a","code":1}');
    expect(outputOf(null)).toBeUndefined();
    expect(outputOf(undefined)).toBeUndefined();
  });

  test("a tool update with null fields leaves them out", () => {
    expect(translateUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", title: null, status: null, name: null, content: null })).toEqual([
      { type: "tool", id: "t", created: false },
    ]);
  });

  const toolOf = (update: Record<string, unknown>) => {
    const [event] = translateUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress", ...update } as any);
    if (event?.type !== "tool") throw new Error("expected a tool event");
    return event;
  };

  test("a bare tool title takes the command from rawInput", () => {
    const [event] = translateUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "other", status: "in_progress", rawInput: { description: "Create probe.txt with touch", command: "touch probe.txt" } } as any);
    expect(event).toMatchObject({ type: "tool", title: "touch probe.txt" });
  });

  test("a title with spaces or without a command is kept", () => {
    expect(toolOf({ title: "touch probe.txt && ls", rawInput: { command: "x" } }).title).toBe("touch probe.txt && ls");
    expect(toolOf({ title: "Read", rawInput: { file_path: "/a" } }).title).toBe("Read");
    expect(toolOf({ title: "bash", rawInput: { command: "" } }).title).toBe("bash");
    expect(toolOf({ title: "bash", rawInput: "ls" }).title).toBe("bash");
    expect(toolOf({ title: "bash", rawInput: { command: 7 } }).title).toBe("bash");
    expect(toolOf({ title: "bash", rawInput: { command: "  \n " } }).title).toBe("bash");
  });

  test("a multi-line command gives its first non-empty line", () => {
    expect(toolOf({ title: "bash", rawInput: { command: "echo a\necho b" } }).title).toBe("echo a");
    expect(toolOf({ title: "bash", rawInput: { command: "\n  \necho c" } }).title).toBe("echo c");
    expect(toolOf({ title: "bash", rawInput: { command: "\n   echo d \r\necho e" } }).title).toBe("echo d");
  });

  test("a grok terminal command shows its command", () => {
    const event = toolOf({ title: "run_terminal_command", kind: "execute", rawInput: { command: "touch probe.txt" } });
    expect(event).toMatchObject({ title: "touch probe.txt", kind: "execute" });
  });

  test("a dst shell tool becomes an execute tool", () => {
    expect(toolOf({ title: "bash", kind: "other", rawInput: { description: "Create probe.txt with touch", command: "touch probe.txt" } }).kind).toBe("execute");
    expect(toolOf({ title: "bash", rawInput: { command: "ls" } }).kind).toBe("execute");
    expect(toolOf({ title: "Read", kind: "other", rawInput: { file_path: "/a" } }).kind).toBe("other");
    expect(toolOf({ title: "Read" }).kind).toBeUndefined();
    expect(toolOf({ title: "bash", kind: "read", rawInput: { command: "cat a" } }).kind).toBe("read");
  });

  test("terminal output in _meta becomes an output delta", () => {
    const update = (meta: unknown) => {
      const [event] = translateUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", _meta: meta } as any);
      return event?.type === "tool" ? event.outputDelta : "missing";
    };
    expect(update({ terminal_output_delta: { data: "ok-codex\n", terminal_id: "exec-1" }, terminal_exit: { exit_code: 0 } })).toBe("ok-codex\n");
    expect(update({ terminal_output: { terminal_id: "call_1", data: "ok-pi\n" } })).toBe("ok-pi\n");
    expect(update({ terminal_output_delta: { data: "a" }, terminal_output: { data: "b" } })).toBe("ab");
    expect(update({ terminal_output: { data: 3 } })).toBeUndefined();
    expect(update({ other: 1 })).toBeUndefined();
    expect(update(null)).toBeUndefined();
  });

  test("a metadata rawOutput gives way to text content", () => {
    const text = (value: string) => [{ type: "content", content: { type: "text", text: value } }];
    const outputOf = (rawOutput: unknown, content?: unknown) => toolOf({ rawOutput, ...(content ? { content } : {}) }).rawOutput;
    expect(outputOf({ metadata: { status: "completed", truncated: false, exit: 0 } }, text("-rw-r--r--@ 1 u  wheel  0 probe.txt\n"))).toBe("-rw-r--r--@ 1 u  wheel  0 probe.txt\n");
    expect(outputOf({ type: "Bash", output: [111, 107, 10], output_for_prompt: "ok\n" }, text("ok\n"))).toBe("ok\n");
    expect(outputOf({ metadata: {} })).toBe('{"metadata":{}}');
    expect(outputOf({ metadata: {} }, [])).toBe('{"metadata":{}}');
    expect(outputOf({ metadata: {} }, text(""))).toBe("");
    expect(outputOf({ output: "from agy" }, text("other"))).toBe("from agy");
    expect(outputOf("plain", text("other"))).toBe("plain");
  });

  test("an interim grok update with empty output gives an empty output, never JSON", () => {
    const interim = { type: "Bash", output: [], output_for_prompt: "", exit_code: 0 };
    expect(toolOf({ rawOutput: interim, content: [{ type: "content", content: { type: "text", text: "" } }] }).rawOutput).toBe("");
    expect(toolOf({ rawOutput: interim }).rawOutput).toBe("");
  });

  test("a grok output_for_prompt is taken when there is no content", () => {
    expect(toolOf({ rawOutput: { type: "Bash", output: [111, 107, 10], output_for_prompt: "ok\n" } }).rawOutput).toBe("ok\n");
    expect(toolOf({ rawOutput: { type: "Bash", output: [], output_for_prompt: "ok\n" }, content: [{ type: "content", content: { type: "text", text: "other" } }] }).rawOutput).toBe("ok\n");
  });

  test("a plan keeps its entries and skips an unknown status", () => {
    const events = translateUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "a", priority: "high", status: "completed" },
        { content: "b", priority: "low", status: "weird" as never },
        { content: "c", priority: "medium", status: "in_progress" },
      ],
    });
    expect(events).toEqual([
      {
        type: "plan",
        entries: [
          { content: "a", priority: "high", status: "completed" },
          { content: "c", priority: "medium", status: "in_progress" },
        ],
      },
    ]);
  });

  test("commands carry their input hint", () => {
    const events = translateUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "Review.", input: { hint: "[file]" } },
        { name: "plan", description: "Plan.", input: null },
        { name: "compact", description: "Compact." },
      ],
    });
    expect(events).toEqual([
      {
        type: "commands",
        commands: [
          { name: "review", description: "Review.", hint: "[file]" },
          { name: "plan", description: "Plan." },
          { name: "compact", description: "Compact." },
        ],
      },
    ]);
  });

  test("config, mode, usage, title and notice updates map to their event", () => {
    const configOptions: SessionConfigOption[] = [
      { id: "mode", name: "Mode", type: "select", category: "mode", currentValue: "a", options: [{ value: "a", name: "A" }] },
    ];
    expect(translateUpdate({ sessionUpdate: "config_option_update", configOptions })).toEqual([
      { type: "config", options: [{ id: "mode", name: "Mode", category: "mode", currentValue: "a", values: [{ value: "a", name: "A" }] }] },
    ]);
    expect(translateUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" })).toEqual([{ type: "mode", modeId: "plan" }]);
    expect(translateUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 })).toEqual([{ type: "usage", used: 1, size: 2 }]);
    expect(translateUpdate({ sessionUpdate: "usage_update", used: 1, size: 2, cost: null })).toEqual([{ type: "usage", used: 1, size: 2 }]);
    expect(translateUpdate({ sessionUpdate: "session_info_update", title: "T", updatedAt: "2026-01-01T00:00:00Z" })).toEqual([{ type: "title", title: "T" }]);
    expect(translateUpdate({ sessionUpdate: "session_info_update", title: null })).toEqual([]);
    expect(translateUpdate({ sessionUpdate: "notice", severity: "warning", title: "Heads up", description: null })).toEqual([
      { type: "notice", severity: "warning", title: "Heads up" },
    ]);
    expect(translateUpdate({ sessionUpdate: "notice", severity: "info", title: "FYI", description: "more" })).toEqual([
      { type: "notice", severity: "info", title: "FYI", description: "more" },
    ]);
  });

  test("compaction updates and unknown variants yield nothing", () => {
    expect(translateUpdate({ sessionUpdate: "compaction_update", compactionId: "c", status: "in_progress" })).toEqual([]);
    expect(translateUpdate({ sessionUpdate: "compaction_summary_chunk" } as unknown as SessionUpdate)).toEqual([]);
    expect(translateUpdate({ sessionUpdate: "brand_new_variant" } as unknown as SessionUpdate)).toEqual([]);
  });
});

describe("toConfigOptions", () => {
  test("grouped options are flattened in order and a null name falls back to the value", () => {
    const raw = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "b",
        options: [
          { group: "g1", name: "First", options: [{ value: "a", name: "A" }, { value: "b", name: null }] },
          { group: "g2", name: "Second", options: [{ value: "c", name: "C" }] },
        ],
      },
    ] as unknown as SessionConfigOption[];
    expect(toConfigOptions(raw)).toEqual([
      {
        id: "model",
        name: "Model",
        currentValue: "b",
        values: [
          { value: "a", name: "A" },
          { value: "b", name: "b" },
          { value: "c", name: "C" },
        ],
      },
    ]);
  });

  test("a boolean option is ignored and an absent list gives an empty one", () => {
    const raw = [{ id: "flag", name: "Flag", type: "boolean", currentValue: true }] as unknown as SessionConfigOption[];
    expect(toConfigOptions(raw)).toEqual([]);
    expect(toConfigOptions(null)).toEqual([]);
    expect(toConfigOptions(undefined)).toEqual([]);
  });
});

describe("textOfContent", () => {
  test("text stays text, other blocks get a placeholder", () => {
    expect(textOfContent(text("hello"))).toBe("hello");
    expect(textOfContent({ type: "image", data: "AAAA", mimeType: "image/png" })).toBe("[image]");
    expect(textOfContent({ type: "audio", data: "AAAA", mimeType: "audio/wav" })).toBe("[audio]");
    expect(textOfContent({ type: "resource_link", name: "n", uri: "file:///tmp/probe/a.txt" })).toBe("[resource: file:///tmp/probe/a.txt]");
    expect(textOfContent({ type: "resource", resource: { uri: "file:///tmp/probe/b.txt", text: "x" } })).toBe("[resource: file:///tmp/probe/b.txt]");
  });
});

describe("toPermissionRequest", () => {
  test("the title falls back to the tool name, then to an empty string", () => {
    const base = { sessionId: "s", options: [{ optionId: "ok", name: "Yes", kind: "allow_once" as const }] };
    expect(toPermissionRequest({ ...base, toolCall: { toolCallId: "t", name: "Bash" } }).title).toBe("Bash");
    expect(toPermissionRequest({ ...base, toolCall: { toolCallId: "t" } }).title).toBe("");
    expect(toPermissionRequest({ ...base, toolCall: { toolCallId: "t", title: "x", kind: null } }).kind).toBeUndefined();
  });
});
