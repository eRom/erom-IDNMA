import { homedir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { ConfigOption, PermissionRequest } from "../src/acp/events.ts";
import { type Action, initialState, reduce, type SessionState } from "../src/tui/state.ts";
import type { Intent } from "../src/tui/keys.ts";
import { ACCENT, LABEL, SURFACE } from "../src/tui/theme.ts";
import { createScreen } from "../src/tui/view/screen.ts";

// ---- états ----

const OPTIONS: ConfigOption[] = [
  { id: "model", name: "Model", category: "model", currentValue: "opus", values: [{ value: "opus", name: "Opus 5.5" }] },
  { id: "effort", name: "Effort", category: "thought_level", currentValue: "high", values: [{ value: "high", name: "High" }] },
  { id: "mode", name: "Mode", category: "mode", currentValue: "manual", values: [{ value: "manual", name: "Manual" }] },
];

function apply(state: SessionState, ...actions: Action[]): SessionState {
  return actions.reduce(reduce, state);
}

function base(name = "claude-mars-x7k2"): SessionState {
  return apply(
    initialState(name),
    { type: "event", event: { type: "config", options: OPTIONS }, origin: "live" },
    { type: "event", event: { type: "usage", used: 23325, size: 1048576, cost: { amount: 0.42, currency: "USD" } }, origin: "live" },
  );
}

function withUser(state: SessionState, text: string): SessionState {
  return apply(state, { type: "userPrompt", text });
}

function withAgentText(state: SessionState, text: string): SessionState {
  return apply(state, { type: "event", event: { type: "chunk", role: "agent", text }, origin: "live" });
}

function withTool(state: SessionState, tool: { id: string; name: string; title: string; kind?: string; status?: "pending" | "in_progress" | "completed" | "failed"; newText?: string; oldText?: string; output?: string }): SessionState {
  const content = tool.newText === undefined ? undefined : [{ kind: "diff" as const, path: `${tool.title}`, oldText: tool.oldText, newText: tool.newText }];
  return apply(state, {
    type: "event",
    event: {
      type: "tool",
      id: tool.id,
      created: true,
      name: tool.name,
      title: tool.title,
      ...(tool.kind === undefined ? {} : { kind: tool.kind }),
      status: tool.status ?? "in_progress",
      ...(content === undefined ? {} : { content }),
      ...(tool.output === undefined ? {} : { rawOutput: tool.output }),
    },
    origin: "live",
  });
}

function numberedLines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join("\n");
}

const PERMISSION: PermissionRequest = {
  toolCallId: "tool-1",
  title: "git push origin main",
  kind: "execute",
  choices: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};

// ---- montage ----

async function mount(options: { width?: number; height?: number; cwd?: string; branch?: string; now?: () => number } = {}) {
  // Comme `openScreen` : ⌃C n'arrête pas le moteur, c'est une intention de l'écran.
  const setup = await createTestRenderer({ width: options.width ?? 104, height: options.height ?? 31, kittyKeyboard: true, exitOnCtrlC: false });
  const intents: Array<{ intent: Intent; input: string }> = [];
  const screen = createScreen({
    renderer: setup.renderer,
    cwd: options.cwd ?? `${homedir()}/dev/idnma`,
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    handlers: { onIntent: (intent, input) => intents.push({ intent, input }) },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { ...setup, screen, intents };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

async function withScreen(options: Parameters<typeof mount>[0], body: (mounted: Mounted) => Promise<void>): Promise<void> {
  const mounted = await mount(options);
  try {
    await body(mounted);
  } finally {
    await mounted.dispose();
  }
}

/** Rend des images jusqu'à ce que le prédicat passe : le Markdown fini se pose en différé, il faut du temps réel. */
async function eventually(mounted: Mounted, predicate: (frame: string) => boolean): Promise<string> {
  const deadline = Date.now() + 3_000;
  let frame = mounted.captureCharFrame();
  while (!predicate(frame) && Date.now() < deadline) {
    await Bun.sleep(20);
    await mounted.renderOnce();
    frame = mounted.captureCharFrame();
  }
  if (!predicate(frame)) throw new Error(`frame never matched:\n${frame}`);
  return frame;
}

/** Rend l'état puis attend qu'une image contienne le texte (le Markdown se pose après coup). */
async function show(mounted: Mounted, state: SessionState, expected?: string): Promise<string> {
  mounted.screen.render(state);
  await mounted.renderOnce();
  if (expected === undefined) return mounted.captureCharFrame();
  return await eventually(mounted, (frame) => frame.includes(expected));
}

function hexInts(hex: string): [number, number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16), 255];
}

/** Premier span du texte donné, avec sa couleur de texte et de fond. */
function spanOf(mounted: Mounted, text: string): { fg: number[]; bg: number[] } | undefined {
  for (const line of mounted.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) return { fg: span.fg.toInts(), bg: span.bg.toInts() };
    }
  }
  return undefined;
}

/** Lignes d'une image, sans la ligne vide que laisse le saut de ligne final. */
function rowsOf(frame: string): string[] {
  return frame.replace(/\n$/, "").split("\n");
}

function lineOf(frame: string, text: string): string | undefined {
  return rowsOf(frame).find((line) => line.includes(text));
}

// ---- tests ----

describe("screen layout", () => {
  test("header and status line hold on one line each at 104 columns", async () => {
    await withScreen({ branch: "feat/unified-tui" }, async (mounted) => {
      const longName = "claude-aurora-longue-session-x7k2zz";
      const state = apply(
        base(longName),
        { type: "event", event: { type: "config", options: [{ ...OPTIONS[0]!, currentValue: "opus-long", values: [{ value: "opus-long", name: "Opus 5.5 with a very long display name" }] }, OPTIONS[1]!, { ...OPTIONS[2]!, currentValue: "manual-long", values: [{ value: "manual-long", name: "Manual approval" }] }] }, origin: "live" },
      );
      const frame = await show(mounted, state);
      const lines = rowsOf(frame);
      expect(lines[0]).toContain(longName);
      expect(lines[0]).toContain("Opus 5.5 with a very long display name");
      expect(lines[0]).toContain("23.3k / 1M");
      expect(lines.at(-1)).toContain("⏎ Send");
      expect(lines.at(-1)).toContain("~/dev/idnma  ⎇ feat/unified-tui");
      expect(lines[1]).not.toContain(longName);
    });
  });

  test("the layout recomposes at each size", async () => {
    await withScreen({}, async (mounted) => {
      const state = base();
      await show(mounted, state);
      mounted.resize(164, 77);
      await mounted.renderOnce();
      let lines = rowsOf(mounted.captureCharFrame());
      expect(lines).toHaveLength(77);
      expect(lines[0]!.trimEnd()).toHaveLength(163);
      expect(lines[0]).toContain("claude-mars-x7k2");
      expect(lines.at(-1)).toContain("⏎ Send");

      mounted.resize(104, 31);
      await mounted.renderOnce();
      lines = rowsOf(mounted.captureCharFrame());
      expect(lines).toHaveLength(31);
      expect(lines[0]!.trimEnd()).toHaveLength(103);
      expect(lines[0]).toContain("23.3k / 1M");
      expect(lines.at(-1)).toContain("⏎ Send");
    });
  });

  test("an empty thread shows a one-line placeholder, replaced by the first item", async () => {
    await withScreen({}, async (mounted) => {
      const empty = await show(mounted, base(), "New session");
      expect(empty).toContain("New session");
      const filled = await show(mounted, withUser(base(), "hello there"), "hello there");
      expect(filled).not.toContain("New session");
    });
  });

  test("the status line follows the turn state and shows the idle hints otherwise", async () => {
    await withScreen({}, async (mounted) => {
      const idle = await show(mounted, base());
      expect(rowsOf(idle).at(-1)).toContain("⏎ Send  ·  ⇧⏎ Newline");
      const running = await show(mounted, apply(base(), { type: "turnStarted" }), "esc Interrupt");
      expect(rowsOf(running).at(-1)).toContain("esc Interrupt  ·  ⏎ Queue message");
    });
  });

  test("the header dot follows the status", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      expect(lineOf(mounted.captureCharFrame(), "claude-mars-x7k2")).toContain("○");
      expect(spanOf(mounted, "○")?.fg).toEqual(hexInts(LABEL.tertiary));

      await show(mounted, apply(base(), { type: "turnStarted" }));
      expect(spanOf(mounted, "●")?.fg).toEqual(hexInts(ACCENT.green));

      await show(mounted, apply(base(), { type: "turnStarted" }, { type: "permission", request: PERMISSION }));
      expect(spanOf(mounted, "●")?.fg).toEqual(hexInts(ACCENT.yellow));

      await show(mounted, apply(base(), { type: "agentExited", code: 1, signal: null }));
      expect(spanOf(mounted, "●")?.fg).toEqual(hexInts(ACCENT.red));
    });
  });
});

describe("thread", () => {
  test("the thread shows a user row, streamed markdown and a tool row with its diff", async () => {
    await withScreen({}, async (mounted) => {
      let state = withUser(base(), "Add a test for the full queue.");
      state = withAgentText(state, "I read the queue first, then add the missing case.");
      state = withTool(state, { id: "t1", name: "Edit", title: "tests/queue.test.ts", kind: "edit", oldText: "keep\n", newText: "keep\nadded line\n" });
      const frame = await show(mounted, state, "I read the queue first");
      expect(frame).toContain("❯ Add a test for the full queue.");
      expect(frame).toContain("I read the queue first, then add the missing case.");
      expect(lineOf(frame, "Edit")).toContain("tests/queue.test.ts");
      expect(lineOf(frame, "Edit")).toContain("+1 −0");
      expect(frame).toContain("+ added line");
      // le fond de la ligne ajoutée et celui de la ligne de l'utilisateur
      expect(spanOf(mounted, "added line")?.bg).toEqual(hexInts("#17261C"));
      expect(spanOf(mounted, "+ ")?.fg).toEqual(hexInts(ACCENT.green));
      expect(spanOf(mounted, "Add a test")?.bg).toEqual(hexInts(SURFACE.userRow));
    });
  });

  test("blank lines separate items except between two consecutive tool rows", async () => {
    await withScreen({}, async (mounted) => {
      let state = withUser(base(), "go");
      state = withTool(state, { id: "t1", name: "Read", title: "first.ts", status: "completed" });
      state = withTool(state, { id: "t2", name: "Read", title: "second.ts", status: "completed" });
      state = withAgentText(state, "done reading");
      const frame = await show(mounted, state, "done reading");
      const lines = rowsOf(frame);
      const user = lines.findIndex((line) => line.includes("❯ go"));
      const first = lines.findIndex((line) => line.includes("first.ts"));
      const second = lines.findIndex((line) => line.includes("second.ts"));
      const agent = lines.findIndex((line) => line.includes("done reading"));
      expect(first - user).toBe(2);
      expect(second - first).toBe(1);
      expect(agent - second).toBe(2);
    });
  });

  test("a long diff shows twelve lines and the hidden count", async () => {
    await withScreen({}, async (mounted) => {
      const state = withTool(base(), { id: "t1", name: "Edit", title: "big.ts", kind: "edit", newText: numberedLines(20) });
      const frame = await show(mounted, state, "more lines");
      expect(frame).toContain("+ line-12");
      expect(frame).not.toContain("line-13");
      expect(frame).toContain("… 8 more lines");
    });
  });

  test("a single hidden line reads in the singular", async () => {
    await withScreen({}, async (mounted) => {
      const state = withTool(base(), { id: "t1", name: "Edit", title: "big.ts", kind: "edit", newText: numberedLines(13) });
      const frame = await show(mounted, state, "more line");
      expect(frame).toContain("… 1 more line");
      expect(frame).not.toContain("1 more lines");
    });
  });

  test("a removed line shows a red minus without a fill", async () => {
    await withScreen({}, async (mounted) => {
      const state = withTool(base(), { id: "t1", name: "Edit", title: "x.ts", kind: "edit", oldText: "old value\n", newText: "new value\n" });
      const frame = await show(mounted, state, "new value");
      expect(frame).toContain("− old value");
      expect(spanOf(mounted, "− ")?.fg).toEqual(hexInts(ACCENT.red));
      expect(spanOf(mounted, "old value")?.fg).toEqual(hexInts(LABEL.secondary));
      expect(spanOf(mounted, "old value")?.bg).not.toEqual(hexInts("#17261C"));
    });
  });

  test("a command output shows five lines and the hidden count", async () => {
    await withScreen({}, async (mounted) => {
      const state = withTool(base(), { id: "t1", name: "Bash", title: "bun test", kind: "execute", status: "completed", output: numberedLines(8, "out") });
      const frame = await show(mounted, state, "more lines");
      expect(frame).toContain("out-5");
      expect(frame).not.toContain("out-6");
      expect(frame).toContain("… 3 more lines");
      expect(lineOf(frame, "Bash")).toContain("8 lines");
    });
  });

  test("blank lines in a command output keep their row and count in the hidden total", async () => {
    await withScreen({}, async (mounted) => {
      const output = "one\n\ntwo\n\nthree\nfour\nfive\nsix\nseven";
      const state = withTool(base(), { id: "t1", name: "Bash", title: "blanks", kind: "execute", status: "completed", output });
      const frame = await show(mounted, state, "more lines");
      const lines = rowsOf(frame);
      const first = lines.findIndex((line) => line.trim() === "one");
      expect(lineOf(frame, "blanks")).toContain("9 lines");
      expect(lines.slice(first, first + 5).map((line) => line.trim())).toEqual(["one", "", "two", "", "three"]);
      expect(frame).not.toContain("four");
      expect(frame).toContain("… 4 more lines");
    });
  });

  test("a blank line inside a diff keeps its row and counts", async () => {
    await withScreen({}, async (mounted) => {
      const newText = `${numberedLines(5, "a")}\n\n${numberedLines(8, "b")}`;
      const state = withTool(base(), { id: "t1", name: "Edit", title: "blank.ts", kind: "edit", newText });
      const frame = await show(mounted, state, "more lines");
      const lines = rowsOf(frame);
      const first = lines.findIndex((line) => line.includes("+ a-1"));
      expect(lines[first + 5]?.trim()).toBe("+");
      expect(lines[first + 6]).toContain("+ b-1");
      expect(frame).toContain("+ b-6");
      expect(frame).not.toContain("b-7");
      expect(frame).toContain("… 2 more lines");
    });
  });

  test("escape sequences and tabs in a tool output cannot drive the terminal", async () => {
    await withScreen({}, async (mounted) => {
      const output = "\x1b[31mred text\x1b[0m\n\x1b]0;hijacked title\x07tab\there\r";
      const state = withTool(base(), { id: "t1", name: "Bash", title: "colors", kind: "execute", status: "completed", output });
      const frame = await show(mounted, state, "red text");
      expect(frame).toContain("red text");
      expect(frame).toContain("tab  here");
      expect(frame).not.toContain("hijacked");
      expect(frame).not.toContain("\x1b");
    });
  });

  test("a long tool title and a long diff line stay inside the window", async () => {
    await withScreen({}, async (mounted) => {
      const longTitle = `git commit -m "${"very long message ".repeat(12)}"\nsecond line of the command`;
      let state = withTool(base(), { id: "t1", name: "Bash", title: longTitle, kind: "execute", status: "completed" });
      state = withTool(state, { id: "t2", name: "Edit", title: "x.ts", kind: "edit", newText: `const value = "${"abcdefghij".repeat(20)}";` });
      const frame = await show(mounted, state, "abcdefghij");
      for (const row of rowsOf(frame)) expect(row.length).toBeLessThanOrEqual(104);
      expect(frame).not.toContain("second line of the command");
      expect(rowsOf(frame).at(-1)).toContain("⏎ Send");
    });
  });

  test("a finished thought is cut to three lines, a live one is shown whole", async () => {
    await withScreen({}, async (mounted) => {
      const live = apply(base(), { type: "event", event: { type: "chunk", role: "thought", text: numberedLines(5, "idea") }, origin: "live" });
      const open = await show(mounted, live, "idea-5");
      expect(open).toContain("idea-5");
      const done = await show(mounted, apply(live, { type: "turnEnded", stopReason: "end_turn" }), "more lines");
      expect(done).toContain("idea-3");
      expect(done).not.toContain("idea-4");
      expect(done).toContain("… 2 more lines");
    });
  });

  test("a blank line inside a finished thought keeps its row and counts", async () => {
    await withScreen({}, async (mounted) => {
      const thought = apply(base(), { type: "event", event: { type: "chunk", role: "thought", text: "first\n\nthird\nfourth\nfifth" }, origin: "live" }, { type: "turnEnded", stopReason: "end_turn" });
      const frame = await show(mounted, thought, "more lines");
      const lines = rowsOf(frame);
      const first = lines.findIndex((line) => line.trim() === "first");
      expect(lines.slice(first, first + 3).map((line) => line.trim())).toEqual(["first", "", "third"]);
      expect(frame).not.toContain("fourth");
      expect(frame).toContain("… 2 more lines");
    });
  });

  test("a peer message and a notice follow the thread anatomy", async () => {
    await withScreen({}, async (mounted) => {
      let state = apply(base(), { type: "peerTurn", from: "argon-apollon-szvo", text: "Can you check session/load?" });
      state = apply(state, { type: "notice", text: "rate limited", tone: "error" }, { type: "notice", text: "reconnected", tone: "info" });
      const frame = await show(mounted, state, "reconnected");
      expect(lineOf(frame, "Message")).toContain("Message  from argon-apollon-szvo");
      expect(lineOf(frame, "Can you check")).toMatch(/^ {3}Can you check/);
      expect(spanOf(mounted, "Can you check")?.fg).toEqual(hexInts(LABEL.secondary));
      expect(spanOf(mounted, "rate limited")?.fg).toEqual(hexInts(ACCENT.red));
      expect(spanOf(mounted, "reconnected")?.fg).toEqual(hexInts(LABEL.tertiary));
    });
  });

  test("the thread sticks to the bottom and PgUp scrolls back", async () => {
    await withScreen({}, async (mounted) => {
      let state = base();
      for (let index = 1; index <= 80; index++) state = withUser(state, `message-${index}-end`);
      const bottom = await show(mounted, state, "message-80-end");
      expect(bottom).toContain("message-80-end");
      expect(bottom).not.toContain("message-1-end");

      mounted.mockInput.pressKey("\x1b[5~");
      const up = await eventually(mounted, (frame) => !frame.includes("message-80-end"));
      expect(up).not.toContain("message-80-end");

      mounted.mockInput.pressKey("END");
      const down = await eventually(mounted, (frame) => frame.includes("message-80-end"));
      expect(down).toContain("message-80-end");
      // les intentions de défilement restent dans l'écran
      expect(mounted.intents).toEqual([]);
    });
  });
});

describe("tool rows", () => {
  const states = (id: string) => withTool(base(), { id, name: "Bash", title: "bun test", kind: "execute", status: "in_progress" });

  test("the dot is green while running, yellow when a permission awaits it, red when failed, grey when done", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, states("tool-1"), "bun test");
      expect(spanOf(mounted, "●")?.fg).toEqual(hexInts(ACCENT.green));

      const waiting = apply(states("tool-1"), { type: "turnStarted" }, { type: "permission", request: PERMISSION });
      await show(mounted, waiting);
      const toolLine = mounted.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("bun test")));
      expect(toolLine?.spans.find((span) => span.text.includes("●"))?.fg.toInts()).toEqual(hexInts(ACCENT.yellow));

      const failed = withTool(base(), { id: "tool-1", name: "Bash", title: "bun test", status: "failed" });
      await show(mounted, failed);
      expect(spanOf(mounted, "●")?.fg).toEqual(hexInts(ACCENT.red));

      const done = withTool(base(), { id: "tool-1", name: "Bash", title: "bun test", status: "completed" });
      await show(mounted, done);
      expect(spanOf(mounted, "●")?.fg).toEqual(hexInts(LABEL.disabled));
    });
  });

  test("a running tool shows whole seconds since it was first seen, a state meta wins", async () => {
    let clock = 1_000_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      const running = states("tool-1");
      let frame = await show(mounted, running, "bun test");
      expect(lineOf(frame, "bun test")).toContain("0s");
      clock += 3_400;
      frame = await show(mounted, running);
      expect(lineOf(frame, "bun test")).toMatch(/3s\s*$/);

      const finished = withTool(base(), { id: "tool-1", name: "Bash", title: "bun test", kind: "execute", status: "completed", output: "a\nb" });
      frame = await show(mounted, finished);
      expect(lineOf(frame, "bun test")).toContain("2 lines");
      expect(lineOf(frame, "bun test")).not.toContain("3s");
    });
  });

  test("the running time is refreshed by a timer while a tool is running", async () => {
    let clock = 5_000_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      await show(mounted, states("tool-1"), "bun test");
      clock += 7_000;
      const deadline = Date.now() + 3_000;
      let frame = mounted.captureCharFrame();
      while (!lineOf(frame, "bun test")?.includes("7s") && Date.now() < deadline) {
        await Bun.sleep(100);
        await mounted.renderOnce();
        frame = mounted.captureCharFrame();
      }
      expect(lineOf(frame, "bun test")).toContain("7s");
    });
  });
});

describe("incremental render", () => {
  test("only the changed items are touched: earlier renderables keep their identity", async () => {
    await withScreen({}, async (mounted) => {
      const first = withTool(withUser(base(), "go"), { id: "t1", name: "Read", title: "a.ts", status: "completed" });
      const streaming = withAgentText(first, "first part");
      await show(mounted, streaming, "first part");
      const ids = ["thread-item-0", "thread-item-1", "thread-item-2"];
      const before = ids.map((id) => mounted.renderer.root.findDescendantById(id));
      expect(before.every((node) => node !== undefined)).toBe(true);

      const longer = withAgentText(streaming, " and a second part");
      const frame = await show(mounted, longer, "second part");
      expect(frame).toContain("first part and a second part");
      const after = ids.map((id) => mounted.renderer.root.findDescendantById(id));
      expect(after[0]).toBe(before[0]!);
      expect(after[1]).toBe(before[1]!);
      expect(after[2]).toBe(before[2]!); // le Markdown reçoit son nouveau contenu, il n'est pas recréé

      // un outil mis à jour est reconstruit, ses voisins non
      const updated = apply(longer, { type: "event", event: { type: "tool", id: "t1", created: false, status: "failed" }, origin: "live" });
      await show(mounted, updated);
      const rebuilt = ids.map((id) => mounted.renderer.root.findDescendantById(id));
      expect(rebuilt[0]).toBe(before[0]!);
      expect(rebuilt[1]).not.toBe(before[1]!);
      expect(rebuilt[2]).toBe(before[2]!);
    });
  });

  test("rendering the same state twice is a no-op", async () => {
    await withScreen({}, async (mounted) => {
      const state = withAgentText(withUser(base(), "go"), "same text");
      await show(mounted, state, "same text");
      const first = mounted.renderer.root.findDescendantById("thread-item-1");
      const frame = mounted.captureCharFrame();
      mounted.screen.render(state);
      await mounted.renderOnce();
      expect(mounted.renderer.root.findDescendantById("thread-item-1")).toBe(first!);
      expect(mounted.captureCharFrame()).toBe(frame);
    });
  });
});

describe("input and keys", () => {
  test("shift+enter and ctrl+j add a line, enter submits once", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      await mounted.mockInput.typeText("a");
      mounted.mockInput.pressEnter({ shift: true });
      await mounted.mockInput.typeText("b");
      mounted.mockInput.pressKey("j", { ctrl: true });
      await mounted.mockInput.typeText("c");
      await mounted.renderOnce();
      expect(mounted.screen.inputText()).toBe("a\nb\nc");
      expect(mounted.intents).toEqual([]);

      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(mounted.intents).toEqual([{ intent: "submit", input: "a\nb\nc" }]);
      expect(mounted.screen.inputText()).toBe("a\nb\nc");
    });
  });

  test("setInput, inputText and clearInput drive the textarea", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      expect(mounted.screen.inputText()).toBe("");
      mounted.screen.setInput("draft text");
      await mounted.renderOnce();
      expect(mounted.screen.inputText()).toBe("draft text");
      expect(mounted.captureCharFrame()).toContain("❯ draft text");
      mounted.screen.clearInput();
      await mounted.renderOnce();
      expect(mounted.screen.inputText()).toBe("");
      expect(mounted.captureCharFrame()).toContain("Message");
    });
  });

  test("home and end go to the input when it has text, and scroll the thread when it is empty", async () => {
    await withScreen({}, async (mounted) => {
      let state = base();
      for (let index = 1; index <= 80; index++) state = withUser(state, `message-${index}-end`);
      await show(mounted, state, "message-80-end");

      mounted.screen.setInput("hello");
      await mounted.renderOnce();
      mounted.mockInput.pressKey("HOME");
      await mounted.mockInput.typeText("X");
      await mounted.renderOnce();
      expect(mounted.screen.inputText()).toBe("Xhello");
      expect(mounted.captureCharFrame()).toContain("message-80-end");
      expect(mounted.intents).toEqual([]);

      mounted.screen.clearInput();
      await mounted.renderOnce();
      mounted.mockInput.pressKey("HOME");
      const top = await eventually(mounted, (frame) => frame.includes("message-1-end"));
      expect(top).toContain("message-1-end");
    });
  });

  test("arrow keys during a pending request move the choice, not the input cursor", async () => {
    await withScreen({}, async (mounted) => {
      const state = apply(base(), { type: "turnStarted" }, { type: "permission", request: PERMISSION });
      await show(mounted, state);
      mounted.screen.setInput("keep");
      await mounted.renderOnce();
      mounted.mockInput.pressArrow("down");
      mounted.mockInput.pressArrow("up");
      await mounted.renderOnce();
      expect(mounted.intents).toEqual([
        { intent: "selectDown", input: "keep" },
        { intent: "selectUp", input: "keep" },
      ]);
      expect(mounted.screen.inputText()).toBe("keep");
      await mounted.mockInput.typeText("Z");
      expect(mounted.screen.inputText()).toBe("keepZ");
    });
  });

  test("arrow keys without a pending request stay in the input", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.screen.setInput("ab");
      mounted.mockInput.pressArrow("left");
      await mounted.mockInput.typeText("X");
      expect(mounted.screen.inputText()).toBe("aXb");
      expect(mounted.intents).toEqual([]);
    });
  });

  test("ctrl+c clears while idle, interrupts during a turn, and a second ctrl+c in a row quits", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.mockInput.pressCtrlC();
      await mounted.mockInput.typeText("x");
      mounted.screen.clearInput();
      await show(mounted, apply(base(), { type: "turnStarted" }));
      mounted.mockInput.pressCtrlC();
      mounted.mockInput.pressCtrlC();
      await mounted.mockInput.typeText("x");
      mounted.mockInput.pressCtrlC();
      expect(mounted.intents.map((entry) => entry.intent)).toEqual(["clearInput", "interrupt", "quit", "interrupt"]);
    });
  });

  test("escape interrupts a running turn and does nothing when idle", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.mockInput.pressEscape();
      await mounted.renderOnce();
      expect(mounted.intents).toEqual([]);
      await show(mounted, apply(base(), { type: "turnStarted" }));
      mounted.mockInput.pressEscape();
      await mounted.renderOnce();
      expect(mounted.intents.map((entry) => entry.intent)).toEqual(["interrupt"]);
    });
  });

  test("after the agent exits any key quits", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, apply(base(), { type: "agentExited", code: 1, signal: null }));
      await mounted.mockInput.typeText("a");
      expect(mounted.intents.map((entry) => entry.intent)).toEqual(["quit"]);
      expect(mounted.screen.inputText()).toBe("");
    });
  });
});

describe("interrupted turn", () => {
  test("a cancelled tool row reads cancelled in place of its meta, a finished one keeps its own, and the turn says Interrupted", async () => {
    await withScreen({}, async (mounted) => {
      let state = apply(base(), { type: "userPrompt", text: "push both" }, { type: "turnStarted" });
      state = withTool(state, { id: "done", name: "Bash", title: "git push done", kind: "execute", status: "completed", output: "a\nb" });
      state = withTool(state, { id: "open", name: "Bash", title: "git push open", kind: "execute", status: "in_progress" });
      state = apply(state, { type: "turnEnded", stopReason: "cancelled" });
      const frame = await show(mounted, state);
      expect(lineOf(frame, "git push open")).toMatch(/cancelled\s*$/);
      expect(lineOf(frame, "git push done")).toContain("2 lines");
      expect(lineOf(frame, "git push done")).not.toContain("cancelled");
      expect(lineOf(frame, "Interrupted")).toBeDefined();
    });
  });

  test("a tool cancelled by the agent exit reads cancelled too", async () => {
    await withScreen({}, async (mounted) => {
      const state = apply(withTool(apply(base(), { type: "turnStarted" }), { id: "open", name: "Bash", title: "sleep 60", status: "in_progress" }), { type: "agentExited", code: 1, signal: null });
      expect(lineOf(await show(mounted, state), "sleep 60")).toMatch(/cancelled\s*$/);
    });
  });
});

describe("double ctrl+c window", () => {
  const intentsOf = (mounted: Mounted): Intent[] => mounted.intents.map((entry) => entry.intent);
  const running = (): SessionState => apply(base(), { type: "turnStarted" });

  test("two ctrl+c 2.5 s apart interrupt two turns instead of quitting", async () => {
    let clock = 10_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      await show(mounted, running());
      mounted.mockInput.pressCtrlC();
      await show(mounted, apply(running(), { type: "turnEnded", stopReason: "cancelled" }));
      clock += 2_500;
      await show(mounted, apply(running(), { type: "turnEnded", stopReason: "cancelled" }, { type: "peerTurn", from: "codex-x", text: "ping" }, { type: "turnStarted" }));
      mounted.mockInput.pressCtrlC();
      expect(intentsOf(mounted)).toEqual(["interrupt", "interrupt"]);
    });
  });

  test("the window is time-bound even when the same turn is still running", async () => {
    let clock = 10_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      await show(mounted, running());
      mounted.mockInput.pressCtrlC();
      clock += 2_500;
      mounted.mockInput.pressCtrlC();
      expect(intentsOf(mounted)).toEqual(["interrupt", "interrupt"]);
    });
  });

  test("a turn that starts inside the window disarms it", async () => {
    let clock = 10_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      await show(mounted, running());
      mounted.mockInput.pressCtrlC();
      await show(mounted, base());
      clock += 300;
      await show(mounted, running());
      mounted.mockInput.pressCtrlC();
      expect(intentsOf(mounted)).toEqual(["interrupt", "interrupt"]);
    });
  });

  test("two ctrl+c within one second at rest quit, and the status line says so while armed", async () => {
    let clock = 10_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      await show(mounted, base());
      mounted.mockInput.pressCtrlC();
      clock += 400;
      expect(rowsOf(await show(mounted, base())).at(-1)).toContain("⌃C again to quit");
      mounted.mockInput.pressCtrlC();
      expect(intentsOf(mounted)).toEqual(["clearInput", "quit"]);
    });
  });

  test("the hint goes away once the window has passed, and any other key disarms it", async () => {
    let clock = 10_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      await show(mounted, base());
      mounted.mockInput.pressCtrlC();
      clock += 1_200;
      const expired = rowsOf(await show(mounted, base())).at(-1);
      expect(expired).not.toContain("⌃C again to quit");
      expect(expired).toContain("⏎ Send");

      mounted.mockInput.pressCtrlC();
      await mounted.mockInput.typeText("x");
      expect(rowsOf(await show(mounted, base())).at(-1)).not.toContain("⌃C again to quit");
    });
  });

  // Horloge réelle : le minuteur interne de la fenêtre est un vrai setTimeout, on laisse la fenêtre passer sans aucun nouveau rendu.
  test("a render during the window does not keep the hint on screen once the window has passed", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.mockInput.pressCtrlC();
      await mounted.renderOnce();
      expect(rowsOf(mounted.captureCharFrame()).at(-1)).toContain("⌃C again to quit");
      await show(mounted, apply(base(), { type: "heldCount", queued: 0 }));
      await Bun.sleep(1_200);
      await mounted.renderOnce();
      const expired = rowsOf(mounted.captureCharFrame()).at(-1);
      expect(expired).not.toContain("⌃C again to quit");
      expect(expired).toContain("⏎ Send");
    });
  });

  test("an interrupting ctrl+c followed by the turn ending inside the window leaves no stale hint", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, running());
      mounted.mockInput.pressCtrlC();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual(["interrupt"]);
      await show(mounted, apply(running(), { type: "turnEnded", stopReason: "cancelled" }));
      await Bun.sleep(1_200);
      await mounted.renderOnce();
      const expired = rowsOf(mounted.captureCharFrame()).at(-1);
      expect(expired).not.toContain("⌃C again to quit");
      expect(expired).toContain("⏎ Send");
    });
  });
});

describe("type-ahead guard", () => {
  const permissionState = (): SessionState => apply(base(), { type: "turnStarted" }, { type: "permission", request: PERMISSION });
  const intentsOf = (mounted: Mounted): Intent[] => mounted.intents.map((entry) => entry.intent);

  test("enter 100 ms after a request appears does nothing, 600 ms after it confirms", async () => {
    let clock = 10_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      await show(mounted, permissionState());
      clock += 100;
      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual([]);
      expect(mounted.screen.inputText()).toBe("");
      clock += 500;
      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual(["confirm"]);
    });
  });

  test("escape and arrows are never held back, and moving the choice does not restart the delay", async () => {
    let clock = 10_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      await show(mounted, permissionState());
      clock += 100;
      mounted.mockInput.pressArrow("down");
      mounted.mockInput.pressEscape();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual(["selectDown", "refuse"]);

      mounted.intents.length = 0;
      clock += 500;
      await show(mounted, apply(permissionState(), { type: "select", delta: 1 }));
      clock += 50;
      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual(["confirm"]);
    });
  });

  test("a held card guards enter the same way, and a second request restarts the delay", async () => {
    let clock = 10_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      await show(mounted, apply(base(), { type: "held", from: "codex-x", text: "ping", queued: 1 }));
      clock += 100;
      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual([]);
      clock += 500;
      await show(mounted, apply(base(), { type: "held", from: "codex-y", text: "other", queued: 2 }));
      clock += 100;
      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual([]);
    });
  });
});

describe("status line fit", () => {
  const LONG_CWD = `${homedir()}/dev/erom-agence-network/.claude/worktrees/feat+unified-tui`;

  test("at 104 columns the branch stays whole, the path is shortened from its start and the hints are intact", async () => {
    await withScreen({ cwd: LONG_CWD, branch: "feat/unified-tui" }, async (mounted) => {
      const idle = rowsOf(await show(mounted, base())).at(-1)!;
      expect(idle).toContain("⎇ feat/unified-tui");
      expect(idle).toContain("⏎ Send  ·  ⇧⏎ Newline  ·  / Commands  ·  ⌃P Plan");
      expect(idle).toMatch(/^ …\/\S*feat\+unified-tui {2}⎇ feat\/unified-tui /);

      const busy = apply(base(), { type: "userPrompt", text: "go" }, { type: "turnStarted" }, { type: "heldCount", queued: 2 });
      const running = rowsOf(await show(mounted, busy)).at(-1)!;
      expect(running).toContain("⎇ feat/unified-tui");
      expect(running).toContain("esc Interrupt  ·  ⏎ Queue message  ·  ⌃P Plan  ·  2 held  ·  ⌃R Open");
    });
  });

  test("the path comes back whole when the window grows, and is cut again when it shrinks", async () => {
    await withScreen({ cwd: LONG_CWD, branch: "feat/unified-tui" }, async (mounted) => {
      await show(mounted, base());
      mounted.resize(164, 31);
      await mounted.renderOnce();
      expect(rowsOf(mounted.captureCharFrame()).at(-1)).toContain("~/dev/erom-agence-network/.claude/worktrees/feat+unified-tui  ⎇ feat/unified-tui");
      mounted.resize(104, 31);
      await mounted.renderOnce();
      const narrow = rowsOf(mounted.captureCharFrame()).at(-1)!;
      expect(narrow).toContain("⎇ feat/unified-tui");
      expect(narrow).toContain("…");
    });
  });

  test("without a branch the path alone is shortened to fit", async () => {
    await withScreen({ cwd: `${homedir()}/${"deep/".repeat(20)}project` }, async (mounted) => {
      const line = rowsOf(await show(mounted, base())).at(-1)!;
      expect(line).toContain("project");
      expect(line).toContain("⏎ Send");
      expect(line).toContain("…");
    });
  });
});

describe("lifecycle", () => {
  test("destroy resolves once the renderer is closed", async () => {
    const mounted = await mount();
    await show(mounted, withTool(base(), { id: "t1", name: "Bash", title: "run", status: "in_progress" }), "run");
    await mounted.screen.destroy();
    expect(mounted.renderer.isDestroyed).toBe(true);
  });
});
