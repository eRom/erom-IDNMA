import { expect, test } from "bun:test";
import type { AgentEvent, ConfigOption, PermissionRequest } from "../src/acp/events.ts";
import { type Action, HELD_CHOICES, initialState, nextQueuedPrompt, reduce, type SessionState, type ThreadItem } from "../src/tui/state.ts";

// Gèle récursivement : toute mutation dans reduce lève une TypeError (mode strict des modules).
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

function run(actions: Action[], from: SessionState = initialState("alice")): SessionState {
  let state = deepFreeze(from);
  for (const action of actions) state = deepFreeze(reduce(state, action));
  return state;
}

const ev = (event: AgentEvent, origin: "replay" | "live" = "live"): Action => ({ type: "event", event, origin });
const agentChunk = (text: string): Action => ev({ type: "chunk", role: "agent", text });
const thoughtChunk = (text: string): Action => ev({ type: "chunk", role: "thought", text });
const tools = (state: SessionState) => state.thread.filter((item): item is Extract<ThreadItem, { kind: "tool" }> => item.kind === "tool");

const request: PermissionRequest = {
  toolCallId: "t1",
  title: "Run rm -rf build",
  kind: "execute",
  choices: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};

test("a turn streams agent text into one item and turns the dot green then grey", () => {
  let state = run([{ type: "userPrompt", text: "hello" }]);
  expect(state.status).toBe("idle");
  expect(state.thread).toEqual([{ kind: "user", text: "hello" }]);
  state = run([{ type: "turnStarted" }], state);
  expect(state.status).toBe("running");
  state = run([agentChunk("a"), agentChunk("b")], state);
  expect(state.thread[1]).toEqual({ kind: "agent", text: "ab", streaming: true });
  state = run([{ type: "turnEnded", stopReason: "end_turn" }], state);
  expect(state.status).toBe("idle");
  expect(state.thread.filter((item) => item.kind === "agent")).toEqual([{ kind: "agent", text: "ab", streaming: false }]);
  expect(state.interrupted).toBe(false);
});

test("a prompt typed during a turn waits in the local queue", () => {
  const state = run([{ type: "turnStarted" }, { type: "userPrompt", text: "x" }]);
  expect(state.localQueue).toEqual(["x"]);
  expect(state.thread).toEqual([]);
  const [prompt, after] = nextQueuedPrompt(state);
  expect(prompt).toBe("x");
  expect(after.localQueue).toEqual([]);
});

test("nextQueuedPrompt shows the popped prompt in the thread and leaves an empty queue untouched", () => {
  const state = run([{ type: "turnStarted" }, { type: "userPrompt", text: "one" }, { type: "userPrompt", text: "two" }, { type: "turnEnded", stopReason: "end_turn" }]);
  const [first, afterFirst] = nextQueuedPrompt(state);
  expect(first).toBe("one");
  expect(afterFirst.thread).toEqual([{ kind: "user", text: "one" }]);
  expect(afterFirst.localQueue).toEqual(["two"]);
  const empty = run([]);
  const [none, same] = nextQueuedPrompt(empty);
  expect(none).toBeUndefined();
  expect(same).toBe(empty);
});

test("a prompt after the agent exited is ignored", () => {
  const state = run([{ type: "agentExited", code: 1, signal: null }, { type: "userPrompt", text: "late" }]);
  expect(state.thread).toEqual([]);
  expect(state.localQueue).toEqual([]);
});

test("a cancelled turn marks open tools cancelled", () => {
  const state = run([
    { type: "turnStarted" },
    ev({ type: "tool", id: "a", created: true, name: "Bash", status: "in_progress" }),
    ev({ type: "tool", id: "b", created: true, name: "Read", status: "pending" }),
    ev({ type: "tool", id: "c", created: true, name: "Edit", status: "completed" }),
    agentChunk("partial"),
    { type: "turnEnded", stopReason: "cancelled" },
  ]);
  expect(state.interrupted).toBe(true);
  expect(state.turnActive).toBe(false);
  expect(tools(state).map((tool) => tool.status)).toEqual(["cancelled", "cancelled", "completed"]);
  expect(state.thread.at(-1)).toEqual({ kind: "agent", text: "partial", streaming: false });
});

test("another stop reason adds nothing to the thread and a new turn clears the interruption", () => {
  const cancelled = run([{ type: "turnStarted" }, { type: "turnEnded", stopReason: "cancelled" }]);
  expect(cancelled.thread).toEqual([]);
  expect(run([{ type: "turnStarted" }], cancelled).interrupted).toBe(false);
  const refused = run([{ type: "turnStarted" }, { type: "turnEnded", stopReason: "max_tokens" }]);
  expect(refused.interrupted).toBe(false);
  expect(refused.thread).toEqual([]);
});

test("a permission makes the state waiting until it is resolved", () => {
  let state = run([{ type: "turnStarted" }, { type: "permission", request }]);
  expect(state.status).toBe("waiting");
  expect(state.pending).toEqual({ kind: "permission", request, selected: 0 });
  state = run([{ type: "permissionResolved" }], state);
  expect(state.pending).toBeUndefined();
  expect(state.status).toBe("running");
});

test("a turn that ends clears a pending permission", () => {
  const state = run([{ type: "turnStarted" }, { type: "permission", request }, { type: "turnEnded", stopReason: "cancelled" }]);
  expect(state.pending).toBeUndefined();
  expect(state.status).toBe("idle");
});

test("a held message is shown only at rest", () => {
  const during = run([{ type: "turnStarted" }, { type: "held", from: "bob", text: "psst", queued: 1 }]);
  expect(during.pending).toBeUndefined();
  expect(during.heldCount).toBe(1);
  const atRest = run([{ type: "held", from: "bob", text: "psst", queued: 1 }]);
  expect(atRest.pending).toEqual({ kind: "held", from: "bob", text: "psst", selected: 0 });
  expect(atRest.status).toBe("waiting");
  expect(atRest.heldCount).toBe(1);
  const resolved = run([{ type: "heldResolved", queued: 0 }], atRest);
  expect(resolved.pending).toBeUndefined();
  expect(resolved.heldCount).toBe(0);
  expect(resolved.status).toBe("idle");
});

test("heldResolved leaves a permission pending alone but still updates the counter", () => {
  const state = run([{ type: "permission", request }, { type: "heldResolved", queued: 3 }]);
  expect(state.pending?.kind).toBe("permission");
  expect(state.heldCount).toBe(3);
  const stateB = run([{ type: "held", from: "bob", text: "x", queued: 1 }, { type: "permissionResolved" }]);
  expect(stateB.pending?.kind).toBe("held");
});

test("the held counter follows the queue during a turn", () => {
  const state = run([{ type: "turnStarted" }, { type: "heldCount", queued: 2 }]);
  expect(state.heldCount).toBe(2);
});

test("select moves the highlighted choice and clamps at both ends", () => {
  let state = run([{ type: "permission", request }, { type: "select", delta: -1 }]);
  expect((state.pending as { selected: number }).selected).toBe(0);
  state = run([{ type: "select", delta: 1 }, { type: "select", delta: 1 }, { type: "select", delta: 1 }], state);
  expect((state.pending as { selected: number }).selected).toBe(2);
  state = run([{ type: "permissionResolved" }, { type: "held", from: "bob", text: "x", queued: 1 }, { type: "select", delta: 1 }, { type: "select", delta: 1 }, { type: "select", delta: 1 }, { type: "select", delta: 1 }], state);
  expect(HELD_CHOICES).toEqual(["Deliver", "Later", "Dismiss"]);
  expect((state.pending as { selected: number }).selected).toBe(HELD_CHOICES.length - 1);
  const none = run([]);
  expect(reduce(none, { type: "select", delta: 1 })).toEqual(none);
});

test("tool diff keeps every line and truncation is a view concern", () => {
  const newText = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  const state = run([ev({ type: "tool", id: "d", created: true, name: "Edit", kind: "edit", content: [{ kind: "diff", path: "/w/a.ts", newText }] })]);
  expect(tools(state)[0]?.diff?.lines.length).toBe(20);
});

test("a diff drops the lines common to both sides and prefixes the rest with a sign", () => {
  const oldText = ["import a", "const x = 1", "const y = 2", "export x"].join("\n");
  const newText = ["import a", "const x = 10", "const z = 3", "const y = 2", "export x"].join("\n");
  const state = run([ev({ type: "tool", id: "d", created: true, name: "Edit", kind: "edit", status: "completed", content: [{ kind: "diff", path: "src/a.ts", oldText, newText }] })]);
  const row = tools(state)[0];
  expect(row?.diff).toEqual({ path: "src/a.ts", lines: ["−const x = 1", "+const x = 10", "+const z = 3"] });
  expect(row?.meta).toBe("+2 −1");
});

test("a diff without old text is all additions and only the first diff item counts", () => {
  const state = run([
    ev({
      type: "tool",
      id: "d",
      created: true,
      name: "Write",
      content: [
        { kind: "diff", path: "new.ts", newText: "a\nb" },
        { kind: "diff", path: "other.ts", newText: "zzz" },
      ],
    }),
  ]);
  expect(tools(state)[0]?.diff).toEqual({ path: "new.ts", lines: ["+a", "+b"] });
  expect(tools(state)[0]?.meta).toBe("+2 −0");
});

test("an execute tool shows its output lines while another kind only reports a line count", () => {
  const exec = run([
    ev({ type: "tool", id: "e", created: true, name: "Bash", kind: "execute", status: "in_progress" }),
    ev({ type: "tool", id: "e", created: false, status: "completed", rawOutput: "one\ntwo\nthree\n" }),
  ]);
  expect(tools(exec)[0]?.output).toEqual(["one", "two", "three"]);
  expect(tools(exec)[0]?.meta).toBe("3 lines");
  expect(tools(exec)[0]?.status).toBe("completed");

  const read = run([ev({ type: "tool", id: "r", created: true, name: "Read", kind: "read", content: [{ kind: "text", text: "a\nb\nc\nd" }] })]);
  expect(tools(read)[0]?.output).toBeUndefined();
  expect(tools(read)[0]?.meta).toBe("4 lines");

  const single = run([ev({ type: "tool", id: "r", created: true, name: "Read", kind: "read", rawOutput: "only" })]);
  expect(tools(single)[0]?.meta).toBe("1 line");

  const plain = run([ev({ type: "tool", id: "p", created: true, name: "Think" })]);
  expect(tools(plain)[0]?.meta).toBe("");
});

test("text contents are joined when there is no raw output", () => {
  const state = run([
    ev({
      type: "tool",
      id: "e",
      created: true,
      name: "run_command",
      kind: "execute",
      content: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ],
    }),
  ]);
  expect(tools(state)[0]?.output).toEqual(["first", "second"]);
});

test("a metadata-only tool update is ignored and a real update merges by id", () => {
  const created = run([ev({ type: "tool", id: "a", created: true, name: "Bash", title: "ls -la", kind: "execute", status: "in_progress" })]);
  expect(tools(created)[0]).toMatchObject({ id: "a", name: "Bash", title: "ls -la", toolKind: "execute", status: "in_progress", meta: "" });
  const ignored = run([ev({ type: "tool", id: "a", created: false })], created);
  expect(ignored.thread).toEqual(created.thread);
  const merged = run([ev({ type: "tool", id: "a", created: false, status: "completed" })], created);
  expect(tools(merged)).toHaveLength(1);
  expect(tools(merged)[0]).toMatchObject({ name: "Bash", title: "ls -la", toolKind: "execute", status: "completed" });
});

test("an update for an unknown id appends a row and a bare creation gets default fields", () => {
  const state = run([ev({ type: "tool", id: "x", created: false, title: "late", status: "completed" })]);
  expect(tools(state)[0]).toMatchObject({ id: "x", name: "Tool", title: "late", status: "completed" });
  const bare = run([ev({ type: "tool", id: "y", created: true, kind: "fetch" })]);
  expect(tools(bare)[0]).toMatchObject({ name: "fetch", title: "", status: "pending" });
});

test("a tool row closes the streaming agent item and the next text opens a new one", () => {
  const state = run([{ type: "turnStarted" }, agentChunk("before"), ev({ type: "tool", id: "a", created: true, name: "Bash" }), agentChunk("after")]);
  expect(state.thread.map((item) => item.kind)).toEqual(["agent", "tool", "agent"]);
  expect(state.thread[0]).toEqual({ kind: "agent", text: "before", streaming: false });
  expect(state.thread[2]).toEqual({ kind: "agent", text: "after", streaming: true });
});

test("a thought streams, then closes when the answer starts", () => {
  const state = run([{ type: "turnStarted" }, thoughtChunk("hm"), thoughtChunk("mm"), agentChunk("ok")]);
  expect(state.thread[0]).toEqual({ kind: "thought", text: "hmmm", done: true });
  expect(state.thread[1]).toEqual({ kind: "agent", text: "ok", streaming: true });
});

test("a turn start and an agent exit close every open item", () => {
  const replayed = run([ev({ type: "chunk", role: "agent", text: "old answer" }, "replay")]);
  expect(replayed.thread).toEqual([{ kind: "agent", text: "old answer", streaming: true }]);
  const started = run([{ type: "turnStarted" }], replayed);
  expect(started.thread).toEqual([{ kind: "agent", text: "old answer", streaming: false }]);
  const thinking = run([{ type: "turnStarted" }, thoughtChunk("t"), { type: "turnEnded", stopReason: "end_turn" }]);
  expect(thinking.thread).toEqual([{ kind: "thought", text: "t", done: true }]);
  const exited = run([{ type: "turnStarted" }, agentChunk("x"), { type: "agentExited", code: 0, signal: null }]);
  expect(exited.thread[0]).toEqual({ kind: "agent", text: "x", streaming: false });
});

test("agy's live echo of a prompt is not shown twice", () => {
  const base: Action[] = [{ type: "userPrompt", text: "x" }, { type: "turnStarted" }];
  const live = run([...base, ev({ type: "chunk", role: "user", text: "x" }, "live")]);
  expect(live.thread.filter((item) => item.kind === "user")).toHaveLength(1);
  const replay = run([...base, ev({ type: "chunk", role: "user", text: "x" }, "replay")]);
  expect(replay.thread.filter((item) => item.kind === "user")).toHaveLength(2);
});

test("each replayed user chunk is its own user item", () => {
  const state = run([ev({ type: "chunk", role: "user", text: "first" }, "replay"), ev({ type: "chunk", role: "user", text: "second" }, "replay")]);
  expect(state.thread).toEqual([
    { kind: "user", text: "first" },
    { kind: "user", text: "second" },
  ]);
});

test("a tool announced again under a known id merges into its row instead of duplicating it", () => {
  const state = run([
    ev({ type: "tool", id: "a", created: true, name: "Bash", kind: "execute", status: "in_progress" }),
    ev({ type: "tool", id: "a", created: true, title: "ls -la", status: "completed", rawOutput: "x\ny" }),
  ]);
  expect(tools(state)).toHaveLength(1);
  expect(tools(state)[0]).toMatchObject({ name: "Bash", title: "ls -la", toolKind: "execute", status: "completed", output: ["x", "y"], meta: "2 lines" });
});

test("a peer turn appends a peer item", () => {
  const state = run([{ type: "peerTurn", from: "bob", text: "ping" }]);
  expect(state.thread).toEqual([{ kind: "peer", from: "bob", text: "ping" }]);
});

test("plan, commands, config, usage and mode events land in their slots", () => {
  const option: ConfigOption = {
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "default",
    values: [
      { value: "default", name: "Manual" },
      { value: "auto", name: "Auto" },
    ],
  };
  const state = run([
    ev({ type: "plan", entries: [{ content: "do it", status: "pending", priority: "high" }] }),
    ev({ type: "commands", commands: [{ name: "help", description: "Help" }] }),
    ev({ type: "config", options: [option] }),
    ev({ type: "mode", modeId: "auto" }),
    ev({ type: "usage", used: 10, size: 100, cost: { amount: 0.5, currency: "USD" } }),
    ev({ type: "title", title: "ignored" }),
  ]);
  expect(state.plan).toHaveLength(1);
  expect(state.commands[0]?.name).toBe("help");
  expect(state.options[0]?.currentValue).toBe("auto");
  expect(state.usage).toEqual({ used: 10, size: 100, cost: { amount: 0.5, currency: "USD" } });
  expect(state.thread).toEqual([]);
  const noMode = run([ev({ type: "mode", modeId: "auto" })]);
  expect(noMode.options).toEqual([]);
});

test("a notice event becomes a thread item whose tone follows the severity", () => {
  const state = run([
    ev({ type: "notice", severity: "error", title: "Auth failed", description: "token expired" }),
    ev({ type: "notice", severity: "warning", title: "Heads up" }),
    { type: "notice", text: "from the screen", tone: "info" },
  ]);
  expect(state.thread).toEqual([
    { kind: "notice", text: "Auth failed: token expired", tone: "error" },
    { kind: "notice", text: "Heads up", tone: "info" },
    { kind: "notice", text: "from the screen", tone: "info" },
  ]);
});

test("the agent exit is sticky, clears the pending and adds no thread item", () => {
  const state = run([{ type: "turnStarted" }, { type: "permission", request }, { type: "agentExited", code: 2, signal: null }, { type: "turnStarted" }]);
  expect(state.exit).toEqual({ code: 2, signal: null });
  expect(state.pending).toBeUndefined();
  expect(state.thread).toEqual([]);
  expect(state.status).toBe("exited");
});
