import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { CommandInfo, ConfigOption, PermissionRequest, PlanEntry } from "../src/acp/events.ts";
import type { Intent } from "../src/tui/keys.ts";
import { type Action, initialState, reduce, type SessionState } from "../src/tui/state.ts";
import { ACCENT, LABEL, SURFACE } from "../src/tui/theme.ts";
import { filterSettings, settingsEntries } from "../src/tui/view/overlays.ts";
import { createScreen } from "../src/tui/view/screen.ts";

// ---- états ----

const OPTIONS: ConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "opus",
    values: [
      { value: "opus", name: "Opus 5.5" },
      { value: "sonnet", name: "Sonnet 5" },
    ],
  },
  {
    id: "thought_level",
    name: "Thought level",
    category: "thought_level",
    currentValue: "high",
    values: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra high" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "default",
    values: [
      { value: "default", name: "Manual" },
      { value: "acceptEdits", name: "Auto" },
      { value: "bypassPermissions", name: "Bypass" },
    ],
  },
];

const COMMANDS: CommandInfo[] = [
  { name: "compact", description: "Compact the conversation" },
  { name: "review", description: "Review the current diff" },
  { name: "revise-claude-md", description: "Update CLAUDE.md with learnings from this session" },
  { name: "security-review", description: "Review pending changes for security issues" },
  { name: "init", description: "Initialize a new CLAUDE.md file" },
];

function apply(state: SessionState, ...actions: Action[]): SessionState {
  return actions.reduce(reduce, state);
}

function base(options: ConfigOption[] = OPTIONS): SessionState {
  return apply(
    initialState("claude-mars-x7k2"),
    { type: "event", event: { type: "config", options }, origin: "live" },
    { type: "event", event: { type: "commands", commands: COMMANDS }, origin: "live" },
  );
}

function withTool(state: SessionState, tool: { id: string; name: string; title: string; kind?: string }): SessionState {
  return apply(state, {
    type: "event",
    event: { type: "tool", id: tool.id, created: true, name: tool.name, title: tool.title, ...(tool.kind === undefined ? {} : { kind: tool.kind }), status: "in_progress" },
    origin: "live",
  });
}

function permission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    toolCallId: "tool-1",
    title: "git push origin feat/queue-full",
    kind: "execute",
    choices: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow git push", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  };
}

/** Un tour en cours : un outil Bash qui attend la permission donnée. */
function waitingOnBash(request: PermissionRequest = permission(), options?: ConfigOption[]): SessionState {
  return apply(withTool(apply(base(options), { type: "userPrompt", text: "push it" }, { type: "turnStarted" }), { id: "tool-1", name: "Bash", title: "git push origin feat/queue-full", kind: "execute" }), { type: "permission", request });
}

// ---- montage ----

async function mount(options: { width?: number; height?: number; now?: () => number } = {}) {
  const setup = await createTestRenderer({ width: options.width ?? 104, height: options.height ?? 31, kittyKeyboard: true, exitOnCtrlC: false });
  const intents: Array<{ intent: Intent; input: string }> = [];
  const screen = createScreen({
    renderer: setup.renderer,
    cwd: "/work/idnma",
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

async function show(mounted: Mounted, state: SessionState): Promise<string> {
  mounted.screen.render(state);
  await mounted.renderOnce();
  return mounted.captureCharFrame();
}

async function frameOf(mounted: Mounted): Promise<string> {
  await mounted.renderOnce();
  return mounted.captureCharFrame();
}

function rowsOf(frame: string): string[] {
  return frame.replace(/\n$/, "").split("\n");
}

function lineOf(frame: string, text: string): string | undefined {
  // La rangée 0 est l'en-tête, qui répète le modèle, le mode et le point d'état.
  return rowsOf(frame).slice(1).find((line) => line.includes(text));
}

function hexInts(hex: string): [number, number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16), 255];
}

function spanOf(mounted: Mounted, text: string): { fg: number[]; bg: number[] } | undefined {
  for (const line of mounted.captureSpans().lines.slice(1)) {
    for (const span of line.spans) {
      if (span.text.includes(text)) return { fg: span.fg.toInts(), bg: span.bg.toInts() };
    }
  }
  return undefined;
}

function intentsOf(mounted: Mounted): Intent[] {
  return mounted.intents.map((entry) => entry.intent);
}

async function openPalette(mounted: Mounted, state: SessionState = base()): Promise<void> {
  await show(mounted, state);
  await mounted.mockInput.typeText("/");
  await mounted.renderOnce();
}

// ---- demandes en attente ----

describe("permission request", () => {
  test("shows the question, the choices by name, enter on the selected one and esc on the reject choice", async () => {
    await withScreen({}, async (mounted) => {
      const frame = await show(mounted, waitingOnBash());
      expect(frame).toContain("Allow this command?");
      const selected = lineOf(frame, "Allow once");
      expect(selected).toBeDefined();
      expect(selected?.trimEnd().endsWith("⏎")).toBe(true);
      expect(lineOf(frame, "Always allow git push")?.trimEnd().endsWith("⏎")).toBe(false);
      expect(lineOf(frame, "Reject")?.trimEnd().endsWith("esc")).toBe(true);
      expect(lineOf(frame, "Allow this command?")).toBeDefined();
    });
  });

  test("the selected choice sits on the blue fill and select moves it", async () => {
    await withScreen({}, async (mounted) => {
      const state = waitingOnBash();
      await show(mounted, state);
      expect(spanOf(mounted, "Allow once")?.bg).toEqual(hexInts(ACCENT.blue));
      expect(spanOf(mounted, "Allow once")?.fg).toEqual(hexInts(LABEL.strong));
      expect(spanOf(mounted, "Always allow git push")?.bg).not.toEqual(hexInts(ACCENT.blue));
      expect(spanOf(mounted, "Always allow git push")?.fg).toEqual(hexInts(LABEL.primary));

      await show(mounted, reduce(state, { type: "select", delta: 1 }));
      expect(spanOf(mounted, "Always allow git push")?.bg).toEqual(hexInts(ACCENT.blue));
      expect(spanOf(mounted, "Allow once")?.bg).not.toEqual(hexInts(ACCENT.blue));
      const frame = mounted.captureCharFrame();
      expect(lineOf(frame, "Always allow git push")?.trimEnd().endsWith("⏎")).toBe(true);
      expect(lineOf(frame, "Allow once")?.trimEnd().endsWith("⏎")).toBe(false);
    });
  });

  test("the question follows the tool kind and falls back to the title when no tool row carries the request", async () => {
    await withScreen({}, async (mounted) => {
      let state = apply(base(), { type: "turnStarted" });
      state = withTool(state, { id: "tool-1", name: "Edit", title: "src/a.ts", kind: "edit" });
      expect(await show(mounted, apply(state, { type: "permission", request: permission({ kind: "edit" }) }))).toContain("Allow this edit?");

      expect(await show(mounted, apply(state, { type: "permission", request: permission({ kind: "fetch" }) }))).toContain("Allow this action?");

      const orphan = apply(base(), { type: "turnStarted" }, { type: "permission", request: permission({ toolCallId: "interaction_9", title: "Delete the branch?", kind: undefined }) });
      const frame = await show(mounted, orphan);
      expect(frame).toContain("Delete the branch?");
      expect(frame).not.toContain("Allow this");
      expect(spanOf(mounted, "Delete the branch?")?.fg).toEqual(hexInts(LABEL.strong));
    });
  });

  test("the pending block closes the thread after one blank line and leaves the input row visible", async () => {
    await withScreen({}, async (mounted) => {
      const rows = rowsOf(await show(mounted, waitingOnBash()));
      const toolIndex = rows.findIndex((line) => line.includes("Bash"));
      const questionIndex = rows.findIndex((line) => line.includes("Allow this command?"));
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(questionIndex).toBe(toolIndex + 2);
      expect(rows[toolIndex + 1]?.trim()).toBe("");
      expect(rows.findLastIndex((line) => line.includes("❯"))).toBeGreaterThan(questionIndex);
      expect(rows.at(-1)).toContain("↑↓ Select");
    });
  });

  test("the esc label goes to reject_always when no reject_once exists, and nowhere when there is neither", async () => {
    await withScreen({}, async (mounted) => {
      const alwaysOnly = permission({
        choices: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "never", name: "Never allow", kind: "reject_always" },
        ],
      });
      let frame = await show(mounted, waitingOnBash(alwaysOnly));
      expect(lineOf(frame, "Never allow")?.trimEnd().endsWith("esc")).toBe(true);

      const noReject = permission({ choices: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Allow always", kind: "allow_always" }] });
      frame = await show(mounted, waitingOnBash(noReject));
      // La ligne d'état (dernière) cite `esc Reject` ; aucune rangée de choix ne porte `esc`.
      expect(rowsOf(frame).slice(0, -1).some((line) => line.trimEnd().endsWith("esc"))).toBe(false);
    });
  });

  test("the esc label shows on the first reject_once when several reject choices exist", async () => {
    await withScreen({}, async (mounted) => {
      const many = permission({
        choices: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "never", name: "Never allow", kind: "reject_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const frame = await show(mounted, waitingOnBash(many));
      expect(lineOf(frame, "Reject")?.trimEnd().endsWith("esc")).toBe(true);
      expect(lineOf(frame, "Never allow")?.trimEnd().endsWith("esc")).toBe(false);
    });
  });

  test("escape sequences in a title or a choice name cannot drive the terminal", async () => {
    await withScreen({}, async (mounted) => {
      const hostile = permission({
        toolCallId: "interaction_1",
        title: "Run \x1b]52;c;ZXZpbA==\x07it\x1b[2J?",
        choices: [{ optionId: "a", name: "Yes\x1b[31m please", kind: "allow_once" }],
      });
      const frame = await show(mounted, apply(base(), { type: "turnStarted" }, { type: "permission", request: hostile }));
      expect(frame).toContain("Run it?");
      expect(frame).toContain("Yes please");
      expect(frame).not.toContain("\x1b");
    });
  });

  test("the tool awaiting the permission shows no running time, another running tool still does", async () => {
    let clock = 1_000_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      const state = withTool(waitingOnBash(), { id: "tool-2", name: "Read", title: "src/other.ts" });
      await show(mounted, state);
      clock += 4_000;
      const frame = await show(mounted, state);
      expect(lineOf(frame, "git push origin")).not.toMatch(/\ds\s*$/);
      expect(lineOf(frame, "src/other.ts")).toMatch(/4s\s*$/);
    });
  });

  test("the pending block leaves with the permission and the input row gets the cursor back", async () => {
    await withScreen({}, async (mounted) => {
      const state = waitingOnBash();
      await show(mounted, state);
      const frame = await show(mounted, apply(state, { type: "permissionResolved" }));
      expect(frame).not.toContain("Allow this command?");
      await mounted.mockInput.typeText("ok");
      expect(mounted.screen.inputText()).toBe("ok");
    });
  });
});

describe("held message", () => {
  const held = (state: SessionState = base()) => apply(state, { type: "held", from: "argon-apollon-szvo", text: "Can you check that session/load replays peer messages?", queued: 1 });

  test("shows the sender, the held meta, the text and the three choices", async () => {
    await withScreen({}, async (mounted) => {
      const frame = await show(mounted, held());
      const header = lineOf(frame, "Message");
      expect(header).toContain("●");
      expect(header).toContain("from argon-apollon-szvo");
      expect(header?.trimEnd().endsWith("held")).toBe(true);
      expect(frame).toContain("  Can you check that session/load replays peer messages?");
      const rows = rowsOf(frame);
      const deliver = rows.findIndex((line) => line.includes("Deliver"));
      expect(rows[deliver + 1]).toContain("Later");
      expect(rows[deliver + 2]).toContain("Dismiss");
      expect(rows[deliver - 1]?.trim()).toBe("");
      expect(lineOf(frame, "Deliver")?.trimEnd().endsWith("⏎")).toBe(true);
      expect(lineOf(frame, "Dismiss")?.trimEnd().endsWith("esc")).toBe(true);
      expect(lineOf(frame, "Later")?.trimEnd().endsWith("esc")).toBe(false);
    });
  });

  test("colours: yellow dot, strong title, secondary text, tertiary meta, blue selection", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, held());
      expect(spanOf(mounted, "●")?.fg).toEqual(hexInts(ACCENT.yellow));
      expect(spanOf(mounted, "held")?.fg).toEqual(hexInts(LABEL.tertiary));
      expect(spanOf(mounted, "Can you check")?.fg).toEqual(hexInts(LABEL.secondary));
      expect(spanOf(mounted, "Deliver")?.bg).toEqual(hexInts(ACCENT.blue));
      expect(spanOf(mounted, "Later")?.fg).toEqual(hexInts(LABEL.primary));
      expect(spanOf(mounted, "Dismiss")?.fg).toEqual(hexInts(LABEL.primary));
    });
  });

  test("select moves the blue fill and Dismiss shows enter instead of esc once selected", async () => {
    await withScreen({}, async (mounted) => {
      const state = held();
      await show(mounted, apply(state, { type: "select", delta: 1 }, { type: "select", delta: 1 }));
      expect(spanOf(mounted, "Dismiss")?.bg).toEqual(hexInts(ACCENT.blue));
      const frame = mounted.captureCharFrame();
      expect(lineOf(frame, "Dismiss")?.trimEnd().endsWith("⏎")).toBe(true);
      expect(lineOf(frame, "Deliver")?.trimEnd().endsWith("⏎")).toBe(false);
    });
  });

  test("hostile text from a peer is sanitised", async () => {
    await withScreen({}, async (mounted) => {
      const frame = await show(mounted, apply(base(), { type: "held", from: "evil\x1b[2Jpeer", text: "hi\x1b]0;x\x07 there", queued: 1 }));
      expect(frame).toContain("from evilpeer");
      expect(frame).toContain("hi there");
      expect(frame).not.toContain("\x1b");
    });
  });
});

// ---- palette ----

describe("command palette", () => {
  test("typing a slash on an empty input opens it with every command and the slash in the input row", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      expect(mounted.screen.overlay()).toBe("palette");
      const frame = await frameOf(mounted);
      for (const command of COMMANDS) expect(frame).toContain(`/${command.name}`);
      expect(frame).toContain("Review the current diff");
      const inputRow = rowsOf(frame).find((line) => line.includes("❯"));
      expect(inputRow).toContain("❯ /");
      expect(rowsOf(frame).at(-1)).toContain("↑↓ Select  ·  ⇥ Complete  ·  ⏎ Run  ·  esc Close");
      expect(intentsOf(mounted)).toEqual([]);
    });
  });

  test("filtering keeps the commands that contain the text, names starting with it first, no duplicate", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      await mounted.mockInput.typeText("rev");
      const frame = await frameOf(mounted);
      const rows = rowsOf(frame);
      const order = ["/review", "/revise-claude-md", "/security-review"].map((name) => rows.findIndex((line) => line.includes(name)));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(frame).not.toContain("/compact");
      expect(frame).not.toContain("/init");
      expect(rows.filter((line) => line.includes("/review ")).length).toBe(1);
      expect(rows.find((line) => line.includes("❯"))).toContain("❯ /rev");
      expect(mounted.screen.paletteChoice()?.name).toBe("review");
    });
  });

  test("the filter ignores case and the leading slash", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      await mounted.mockInput.typeText("SEC");
      expect(mounted.screen.paletteChoice()?.name).toBe("security-review");
      const frame = await frameOf(mounted);
      expect(frame).not.toContain("/review ");
    });
  });

  test("a filter that matches nothing leaves an empty list and no choice", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      await mounted.mockInput.typeText("zzz");
      const frame = await frameOf(mounted);
      for (const command of COMMANDS) expect(frame).not.toContain(`/${command.name}`);
      expect(mounted.screen.paletteChoice()).toBeUndefined();
      expect(mounted.screen.overlay()).toBe("palette");
    });
  });

  test("paletteText gives the typed text with its slash, and nothing once the palette is closed", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      expect(mounted.screen.paletteText()).toBeUndefined();
      await openPalette(mounted);
      expect(mounted.screen.paletteText()).toBe("/");
      await mounted.mockInput.typeText("review 42");
      expect(mounted.screen.paletteText()).toBe("/review 42");
      mounted.screen.closeOverlay();
      expect(mounted.screen.paletteText()).toBeUndefined();
    });
  });

  test("enter selects the first match, is forwarded once as confirm and changes nothing in the inputs", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.screen.setInput("draft");
      // Un `/` tapé dans une saisie non vide reste du texte : on ouvre la palette par l'API.
      mounted.screen.openOverlay("palette");
      await mounted.mockInput.typeText("rev");
      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual(["confirm"]);
      expect(mounted.screen.paletteChoice()?.name).toBe("review");
      expect((await frameOf(mounted)).split("\n").find((line) => line.includes("❯"))).toContain("❯ /rev");
      expect(mounted.screen.inputText()).toBe("draft");
    });
  });

  test("tab completes the selected command into the input, closes the palette and forwards nothing", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      await mounted.mockInput.typeText("rev");
      mounted.mockInput.pressArrow("down");
      mounted.mockInput.pressTab();
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(mounted.screen.paletteText()).toBeUndefined();
      expect(mounted.screen.inputText()).toBe("/revise-claude-md ");
      expect(intentsOf(mounted)).toEqual([]);
      const frame = await frameOf(mounted);
      expect(rowsOf(frame).find((line) => line.includes("❯"))).toContain("❯ /revise-claude-md");
      expect(frame).not.toContain("Review pending changes");
      // Le curseur est au bout : ce qu'on tape prolonge la commande, et ⏎ envoie le tout.
      await mounted.mockInput.typeText("add hostinger");
      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(mounted.intents).toEqual([{ intent: "submit", input: "/revise-claude-md add hostinger" }]);
    });
  });

  test("tab with no matching command does nothing and keeps the palette open", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      await mounted.mockInput.typeText("zzz");
      mounted.mockInput.pressTab();
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBe("palette");
      expect(mounted.screen.inputText()).toBe("");
      expect(mounted.screen.paletteText()).toBe("/zzz");
    });
  });

  test("a click on a palette row completes it like tab and runs nothing", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      const frame = await frameOf(mounted);
      const row = rowsOf(frame).findIndex((line) => line.includes("/security-review"));
      expect(row).toBeGreaterThan(0);
      await mounted.mockMouse.click(6, row);
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(mounted.screen.inputText()).toBe("/security-review ");
      expect(intentsOf(mounted)).toEqual([]);
    });
  });

  test("down moves the selection inside the palette and is not forwarded; the blue row follows", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      await mounted.mockInput.typeText("rev");
      await mounted.renderOnce();
      expect(spanOf(mounted, "/review")?.bg).toEqual(hexInts(ACCENT.blue));
      mounted.mockInput.pressArrow("down");
      await mounted.renderOnce();
      expect(mounted.screen.paletteChoice()?.name).toBe("revise-claude-md");
      expect(spanOf(mounted, "/revise-claude-md")?.bg).toEqual(hexInts(ACCENT.blue));
      expect(spanOf(mounted, "/review ")?.bg).not.toEqual(hexInts(ACCENT.blue));
      expect(spanOf(mounted, "Update CLAUDE.md")?.fg).toEqual(hexInts(LABEL.strong));
      mounted.mockInput.pressArrow("up");
      await mounted.renderOnce();
      expect(mounted.screen.paletteChoice()?.name).toBe("review");
      expect(intentsOf(mounted)).toEqual([]);
    });
  });

  test("the selection stops at both ends and survives a filter change by returning to the top", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      mounted.mockInput.pressArrow("up");
      expect(mounted.screen.paletteChoice()?.name).toBe("compact");
      for (let step = 0; step < 9; step++) mounted.mockInput.pressArrow("down");
      expect(mounted.screen.paletteChoice()?.name).toBe("init");
      await mounted.mockInput.typeText("r");
      expect(mounted.screen.paletteChoice()?.name).toBe("review");
    });
  });

  test("the list is on the popover surface, names strong, descriptions secondary", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      // `/compact` est la première rangée, donc la sélectionnée : la surface se lit sur `/init`.
      expect(spanOf(mounted, "/init")?.bg).toEqual(hexInts(SURFACE.popover));
      expect(spanOf(mounted, "/init")?.fg).toEqual(hexInts(LABEL.strong));
      expect(spanOf(mounted, "Initialize a new CLAUDE.md file")?.fg).toEqual(hexInts(LABEL.secondary));
      expect(spanOf(mounted, "/compact")?.bg).toEqual(hexInts(ACCENT.blue));
      expect(spanOf(mounted, "Compact the conversation")?.fg).toEqual(hexInts(LABEL.strong));
    });
  });

  test("names are padded to 22 columns before the description", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      const line = lineOf(await frameOf(mounted), "/compact") ?? "";
      expect(line.indexOf("Compact the conversation") - line.indexOf("/compact")).toBe(22);
    });
  });

  test("at most eight rows show and the window follows the selection", async () => {
    await withScreen({}, async (mounted) => {
      const many: CommandInfo[] = Array.from({ length: 12 }, (_, index) => ({ name: `cmd-${String(index).padStart(2, "0")}`, description: `Command number ${index}` }));
      const state = apply(base(), { type: "event", event: { type: "commands", commands: many }, origin: "live" });
      await openPalette(mounted, state);
      let frame = await frameOf(mounted);
      expect(rowsOf(frame).filter((line) => line.includes("/cmd-")).length).toBe(8);
      expect(frame).toContain("/cmd-00");
      expect(frame).not.toContain("/cmd-08");
      for (let step = 0; step < 9; step++) mounted.mockInput.pressArrow("down");
      frame = await frameOf(mounted);
      expect(rowsOf(frame).filter((line) => line.includes("/cmd-")).length).toBe(8);
      expect(frame).toContain("/cmd-09");
      expect(frame).not.toContain("/cmd-00");
      expect(mounted.screen.paletteChoice()?.name).toBe("cmd-09");
    });
  });

  test("erasing the slash closes the palette and gives the textarea back with its content", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      await mounted.mockInput.typeText("re");
      mounted.mockInput.pressBackspace();
      mounted.mockInput.pressBackspace();
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBe("palette");
      mounted.mockInput.pressBackspace();
      const frame = await frameOf(mounted);
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(frame).not.toContain("/compact");
      await mounted.mockInput.typeText("hi");
      expect(mounted.screen.inputText()).toBe("hi");
    });
  });

  test("ctrl+d with text in the palette is not a quit", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      await mounted.mockInput.typeText("rev");
      mounted.mockInput.pressKey("d", { ctrl: true });
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual([]);
      expect(mounted.screen.overlay()).toBe("palette");
    });
  });

  test("home and end move the palette cursor instead of scrolling the thread", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      await mounted.mockInput.typeText("rev");
      mounted.mockInput.pressKey("HOME");
      mounted.mockInput.pressArrow("right");
      await mounted.mockInput.typeText("X");
      mounted.mockInput.pressKey("END");
      await mounted.mockInput.typeText("Y");
      const frame = await frameOf(mounted);
      expect(rowsOf(frame).find((line) => line.includes("❯"))).toContain("❯ /XrevY");
      expect(mounted.screen.overlay()).toBe("palette");
      expect(intentsOf(mounted)).toEqual([]);
    });
  });

  test("ctrl+c closes the palette, drops what was typed in it and brings the draft back", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.screen.setInput("draft");
      mounted.screen.openOverlay("palette");
      await mounted.mockInput.typeText("rev");
      mounted.mockInput.pressCtrlC();
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(intentsOf(mounted)).toEqual([]);
      expect(mounted.screen.inputText()).toBe("draft");
      mounted.screen.openOverlay("palette");
      expect((await frameOf(mounted)).split("\n").find((line) => line.includes("❯"))).toContain("❯ /");
      expect((await frameOf(mounted)).split("\n").find((line) => line.includes("❯"))).not.toContain("rev");
    });
  });

  test("escape closes it without a forwarded intent and the textarea keeps its text", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.screen.setInput("keep");
      // La palette ne s'ouvre que sur une saisie vide : on l'ouvre par l'API, puis on appuie sur échap.
      mounted.screen.openOverlay("palette");
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBe("palette");
      mounted.mockInput.pressEscape();
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(intentsOf(mounted)).toEqual([]);
      expect(mounted.screen.inputText()).toBe("keep");
      await mounted.mockInput.typeText("!");
      expect(mounted.screen.inputText()).toBe("keep!");
    });
  });

  test("a slash typed in a non-empty input stays text", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      await mounted.mockInput.typeText("a/b");
      expect(mounted.screen.inputText()).toBe("a/b");
      expect(mounted.screen.overlay()).toBeUndefined();
    });
  });

  test("a permission arriving while the palette is open takes over", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      expect(mounted.screen.overlay()).toBe("palette");
      const frame = await show(mounted, waitingOnBash());
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(frame).toContain("Allow this command?");
      expect(frame).not.toContain("/compact");
    });
  });

  test("a command list that changes while the palette is open refreshes", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      const next = apply(base(), { type: "event", event: { type: "commands", commands: [{ name: "fresh", description: "A new command" }] }, origin: "live" });
      const frame = await show(mounted, next);
      expect(frame).toContain("/fresh");
      expect(frame).not.toContain("/compact");
      expect(mounted.screen.paletteChoice()?.name).toBe("fresh");
    });
  });

  test("command names and descriptions are sanitised", async () => {
    await withScreen({}, async (mounted) => {
      const hostile = apply(base(), { type: "event", event: { type: "commands", commands: [{ name: "x\x1b[2Jy", description: "d\x1b]0;t\x07esc" }] }, origin: "live" });
      await openPalette(mounted, hostile);
      const frame = await frameOf(mounted);
      expect(frame).toContain("/xy");
      expect(frame).toContain("desc");
      expect(frame).not.toContain("\x1b");
    });
  });
});

// ---- plan ----

const PLAN: PlanEntry[] = [
  { content: "Read the queue implementation", status: "completed", priority: "high" },
  { content: "Add the full-queue test", status: "completed", priority: "high" },
  { content: "Run the test file", status: "in_progress", priority: "high" },
  { content: "Run the whole suite", status: "pending", priority: "medium" },
  { content: "Report", status: "pending", priority: "low" },
];

function withPlan(state: SessionState, entries: PlanEntry[] = PLAN): SessionState {
  return apply(state, { type: "event", event: { type: "plan", entries }, origin: "live" });
}

describe("plan panel", () => {
  test("ctrl+p opens it, the in-progress entry has a filled dot and ctrl+p closes it, nothing forwarded", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, withPlan(apply(base(), { type: "turnStarted" })));
      mounted.mockInput.pressKey("p", { ctrl: true });
      const frame = await frameOf(mounted);
      expect(mounted.screen.overlay()).toBe("plan");
      expect(frame).toContain("Plan");
      expect(lineOf(frame, "Run the test file")).toContain("●");
      expect(lineOf(frame, "Read the queue implementation")).toContain("✓");
      expect(lineOf(frame, "Run the whole suite")).toContain("○");
      expect(lineOf(frame, "Report")).toContain("○");
      expect(rowsOf(frame).at(-1)).toContain("⌃P Close plan");
      mounted.mockInput.pressKey("p", { ctrl: true });
      const closed = await frameOf(mounted);
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(closed).not.toContain("Run the test file");
      expect(intentsOf(mounted)).toEqual([]);
    });
  });

  test("the panel is 42 columns wide, at the right edge, on screen row 4, on the popover surface", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, withPlan(base()));
      mounted.screen.openOverlay("plan");
      const rows = rowsOf(await frameOf(mounted));
      const titleRow = rows.findIndex((line) => line.includes("Plan"));
      // Comme la maquette : `top: 2` se compte depuis le haut du fil (rangée 1), le titre tombe sur la rangée 4.
      expect(titleRow).toBe(4);
      expect(rows[titleRow]?.indexOf("Plan")).toBe(104 - 42 + 2);
      expect(spanOf(mounted, "Plan")?.bg).toEqual(hexInts(SURFACE.popover));
    });
  });

  test("entry colours follow the status", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, withPlan(base()));
      mounted.screen.openOverlay("plan");
      await mounted.renderOnce();
      expect(spanOf(mounted, "Plan")?.fg).toEqual(hexInts(LABEL.secondary));
      expect(spanOf(mounted, "✓")?.fg).toEqual(hexInts(LABEL.disabled));
      expect(spanOf(mounted, "Read the queue implementation")?.fg).toEqual(hexInts(LABEL.tertiary));
      expect(spanOf(mounted, "●")?.fg).toEqual(hexInts(ACCENT.green));
      expect(spanOf(mounted, "Run the test file")?.fg).toEqual(hexInts(LABEL.strong));
      expect(spanOf(mounted, "○")?.fg).toEqual(hexInts(LABEL.disabled));
      expect(spanOf(mounted, "Run the whole suite")?.fg).toEqual(hexInts(LABEL.primary));
    });
  });

  test("an empty plan says so", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.screen.openOverlay("plan");
      const frame = await frameOf(mounted);
      expect(frame).toContain("No plan yet");
      expect(spanOf(mounted, "No plan yet")?.fg).toEqual(hexInts(LABEL.tertiary));
    });
  });

  test("it never takes focus: the input keeps typing, and a plan update refreshes the open panel", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, withPlan(base()));
      mounted.mockInput.pressKey("p", { ctrl: true });
      await mounted.mockInput.typeText("abc");
      expect(mounted.screen.inputText()).toBe("abc");
      const frame = await show(mounted, withPlan(base(), [{ content: "Only step", status: "pending", priority: "low" }]));
      expect(frame).toContain("Only step");
      expect(frame).not.toContain("Run the test file");
    });
  });

  test("plan text is sanitised", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, withPlan(base(), [{ content: "do\x1b[2J it\x1b]0;x\x07", status: "pending", priority: "low" }]));
      mounted.screen.openOverlay("plan");
      const frame = await frameOf(mounted);
      expect(frame).toContain("do it");
      expect(frame).not.toContain("\x1b");
    });
  });

  test("escape closes it when idle and still interrupts a running turn", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, withPlan(base()));
      mounted.screen.openOverlay("plan");
      mounted.mockInput.pressEscape();
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(intentsOf(mounted)).toEqual([]);

      await show(mounted, withPlan(apply(base(), { type: "turnStarted" })));
      mounted.screen.openOverlay("plan");
      mounted.mockInput.pressEscape();
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBe("plan");
      expect(intentsOf(mounted)).toEqual(["interrupt"]);
    });
  });
});

// ---- réglages ----

describe("settings panel", () => {
  test("ctrl+o opens the three lists with the current value ticked and the model selected", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.mockInput.pressKey("o", { ctrl: true });
      const frame = await frameOf(mounted);
      expect(mounted.screen.overlay()).toBe("settings");
      const rows = rowsOf(frame);
      const model = rows.findIndex((line) => line.trim() === "Model");
      const effort = rows.findIndex((line) => line.trim() === "Effort");
      const mode = rows.findIndex((line) => line.trim() === "Mode");
      expect(model).toBeGreaterThan(0);
      expect(effort).toBeGreaterThan(model);
      expect(mode).toBeGreaterThan(effort);
      for (const name of ["Opus 5.5", "Sonnet 5", "Low", "High", "Extra high", "Manual", "Auto", "Bypass"]) expect(frame).toContain(name);
      expect(lineOf(frame, "Opus 5.5")?.trimEnd().endsWith("✓")).toBe(true);
      expect(lineOf(frame, "Sonnet 5")?.trimEnd().endsWith("✓")).toBe(false);
      expect(lineOf(frame, "High")?.trimEnd().endsWith("✓")).toBe(true);
      expect(lineOf(frame, "Manual")?.trimEnd().endsWith("✓")).toBe(true);
      expect(rowsOf(frame).at(-1)).toContain("⏎ Apply");
      expect(mounted.screen.settingsChoice()).toEqual({ category: "model", value: "opus" });
      expect(spanOf(mounted, "Opus 5.5")?.bg).toEqual(hexInts(ACCENT.blue));
      expect(spanOf(mounted, "Model")?.fg).toEqual(hexInts(LABEL.secondary));
      expect(spanOf(mounted, "Sonnet 5")?.fg).toEqual(hexInts(LABEL.primary));
      expect(spanOf(mounted, "Sonnet 5")?.bg).toEqual(hexInts(SURFACE.popover));
      expect(intentsOf(mounted)).toEqual([]);
    });
  });

  test("down walks over the values across sections, skipping the titles, and settingsChoice reports the option category", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.screen.openOverlay("settings");
      const walked: Array<{ category: string; value: string } | undefined> = [];
      for (let step = 0; step < 8; step++) {
        mounted.mockInput.pressArrow("down");
        walked.push(mounted.screen.settingsChoice());
      }
      expect(walked).toEqual([
        { category: "model", value: "sonnet" },
        { category: "thought_level", value: "low" },
        { category: "thought_level", value: "high" },
        { category: "thought_level", value: "xhigh" },
        { category: "mode", value: "default" },
        { category: "mode", value: "acceptEdits" },
        { category: "mode", value: "bypassPermissions" },
        { category: "mode", value: "bypassPermissions" },
      ]);
      expect(intentsOf(mounted)).toEqual([]);
      mounted.mockInput.pressArrow("up");
      expect(mounted.screen.settingsChoice()).toEqual({ category: "mode", value: "acceptEdits" });
    });
  });

  test("enter is forwarded as confirm and leaves the panel open for the runner to close", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.screen.openOverlay("settings");
      mounted.mockInput.pressArrow("down");
      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual(["confirm"]);
      expect(mounted.screen.settingsChoice()).toEqual({ category: "model", value: "sonnet" });
      expect(mounted.screen.overlay()).toBe("settings");
      mounted.screen.closeOverlay();
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(mounted.screen.settingsChoice()).toBeUndefined();
    });
  });

  test("the tick follows the state once the runner applies a value, the selection stays on the same value", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.screen.openOverlay("settings");
      mounted.mockInput.pressArrow("down");
      const applied = base(OPTIONS.map((option) => (option.category === "model" ? { ...option, currentValue: "sonnet" } : option)));
      const frame = await show(mounted, applied);
      expect(lineOf(frame, "Sonnet 5")?.trimEnd().endsWith("✓")).toBe(true);
      expect(lineOf(frame, "Opus 5.5")?.trimEnd().endsWith("✓")).toBe(false);
      expect(mounted.screen.settingsChoice()).toEqual({ category: "model", value: "sonnet" });
    });
  });

  test("on a low terminal the list scrolls to keep the selected value visible", async () => {
    await withScreen({ height: 16 }, async (mounted) => {
      await show(mounted, base());
      mounted.screen.openOverlay("settings");
      let frame = await frameOf(mounted);
      expect(frame).toContain("Opus 5.5");
      expect(frame).not.toContain("Bypass");
      for (let step = 0; step < 9; step++) mounted.mockInput.pressArrow("down");
      frame = await frameOf(mounted);
      expect(mounted.screen.settingsChoice()).toEqual({ category: "mode", value: "bypassPermissions" });
      expect(frame).toContain("Bypass");
      expect(spanOf(mounted, "Bypass")?.bg).toEqual(hexInts(ACCENT.blue));
      expect(rowsOf(frame).at(-1)).toContain("⏎ Apply");
    });
  });

  test("at every step of the walk the selected value is inside the window and on the blue row", async () => {
    await withScreen({ height: 16 }, async (mounted) => {
      await show(mounted, base());
      mounted.screen.openOverlay("settings");
      const names: Record<string, string> = { opus: "Opus 5.5", sonnet: "Sonnet 5", low: "Low", high: "High", xhigh: "Extra high", default: "Manual", acceptEdits: "Auto", bypassPermissions: "Bypass" };
      const walked: string[] = [];
      for (let step = 0; step < 12; step++) {
        const frame = await frameOf(mounted);
        const choice = mounted.screen.settingsChoice();
        const name = names[choice?.value ?? ""] ?? "";
        walked.push(name);
        expect(lineOf(frame, name)).toBeDefined();
        expect(spanOf(mounted, name)?.bg).toEqual(hexInts(ACCENT.blue));
        mounted.mockInput.pressArrow("down");
      }
      expect(new Set(walked).size).toBe(8);
      // Retour en haut : même garantie en montant.
      for (let step = 0; step < 12; step++) {
        const frame = await frameOf(mounted);
        const name = names[mounted.screen.settingsChoice()?.value ?? ""] ?? "";
        expect(lineOf(frame, name)).toBeDefined();
        expect(spanOf(mounted, name)?.bg).toEqual(hexInts(ACCENT.blue));
        mounted.mockInput.pressArrow("up");
      }
    });
  });

  test("an option the agent does not offer drops its section", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base(OPTIONS.filter((option) => option.category !== "thought_level")));
      mounted.screen.openOverlay("settings");
      const frame = await frameOf(mounted);
      expect(rowsOf(frame).some((line) => line.trim() === "Effort")).toBe(false);
      expect(rowsOf(frame).some((line) => line.trim() === "Model")).toBe(true);
      expect(rowsOf(frame).some((line) => line.trim() === "Mode")).toBe(true);
      mounted.mockInput.pressArrow("down");
      mounted.mockInput.pressArrow("down");
      expect(mounted.screen.settingsChoice()).toEqual({ category: "mode", value: "default" });
    });
  });

  test("without any option the panel says so and offers no choice", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, apply(initialState("claude-mars-x7k2")));
      mounted.screen.openOverlay("settings");
      const frame = await frameOf(mounted);
      expect(frame).toContain("No settings available");
      expect(mounted.screen.settingsChoice()).toBeUndefined();
    });
  });

  test("the effort list shows the values of the thought_level option", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base());
      mounted.screen.openOverlay("settings");
      const frame = await frameOf(mounted);
      for (const name of ["Low", "High", "Extra high"]) expect(frame).toContain(name);
    });
  });

  test("option value names are sanitised", async () => {
    await withScreen({}, async (mounted) => {
      const hostile = base([{ id: "model", name: "Model", category: "model", currentValue: "a", values: [{ value: "a", name: "Opus\x1b[2J 9" }] }]);
      await show(mounted, hostile);
      mounted.screen.openOverlay("settings");
      const frame = await frameOf(mounted);
      expect(frame).toContain("Opus 9");
      expect(frame).not.toContain("\x1b");
    });
  });
});

// ---- réglages : filtre à la frappe ----

const LONG: ConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "ollama-cloud/deepseek-v4.1-flash",
    values: [
      { value: "amd/GLM-5.3-Flash", name: "amd/GLM-5.3-Flash" },
      { value: "ollama-cloud/deepseek-v4.1-flash", name: "ollama-cloud/deepseek-v4.1-flash" },
      { value: "openrouter/deepseek/deepseek-v4-pro", name: "openrouter/deepseek/deepseek-v4-pro" },
      { value: "deepseek/deepseek-flash", name: "deepseek/deepseek-flash" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    currentValue: "default",
    values: [
      { value: "low", name: "low" },
      { value: "high", name: "high" },
      { value: "default", name: "default" },
    ],
  },
];

/** Les rangées du panneau, rognées : ni l'en-tête, ni le fil vide, ni la saisie, ni la ligne d'état. */
function panelRows(frame: string): string[] {
  return rowsOf(frame)
    .slice(1, -1)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "New session" && !line.startsWith("❯"));
}

async function openSettingsOn(mounted: Mounted, options: ConfigOption[] = LONG): Promise<void> {
  await show(mounted, base(options));
  mounted.screen.openOverlay("settings");
  await mounted.renderOnce();
}

describe("settings filter", () => {
  test("typing in the settings panel narrows the list, names that start with the text first", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      await mounted.mockInput.typeText("deeps");
      const rows = panelRows(await frameOf(mounted));
      expect(rows.filter((row) => row === "Model" || row === "Effort")).toEqual(["Model"]);
      const names = rows.filter((row) => row.includes("deepseek")).map((row) => row.replace(/\s*✓$/, ""));
      expect(names).toEqual(["deepseek/deepseek-flash", "ollama-cloud/deepseek-v4.1-flash", "openrouter/deepseek/deepseek-v4-pro"]);
      expect(rows.some((row) => row.includes("GLM"))).toBe(false);
      expect(mounted.screen.settingsChoice()).toEqual({ category: "model", value: "deepseek/deepseek-flash" });
      expect(spanOf(mounted, "deepseek/deepseek-flash")?.bg).toEqual(hexInts(ACCENT.blue));
    });
  });

  test("the match is case-insensitive and also reads the value", async () => {
    await withScreen({}, async (mounted) => {
      const renamed: ConfigOption[] = [{ id: "model", name: "Model", category: "model", currentValue: "a", values: [{ value: "claude-opus-5", name: "Opus" }, { value: "b", name: "Other" }] }];
      await openSettingsOn(mounted, renamed);
      await mounted.mockInput.typeText("CLAUDE");
      expect(panelRows(await frameOf(mounted))).toEqual(["Model", "Opus"]);
    });
  });

  test("a section title match shows the whole section", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      await mounted.mockInput.typeText("eff");
      const rows = panelRows(await frameOf(mounted));
      expect(rows.map((row) => row.replace(/\s*✓$/, ""))).toEqual(["Effort", "low", "high", "default"]);
      expect(mounted.screen.settingsChoice()).toEqual({ category: "thought_level", value: "low" });
    });
  });

  test("return applies the filtered selection and leaves the panel open", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      await mounted.mockInput.typeText("deeps");
      mounted.mockInput.pressEnter();
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual(["confirm"]);
      expect(mounted.screen.settingsChoice()).toEqual({ category: "model", value: "deepseek/deepseek-flash" });
      expect(mounted.screen.overlay()).toBe("settings");
    });
  });

  test("the arrows walk the filtered values only", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      await mounted.mockInput.typeText("deeps");
      mounted.mockInput.pressArrow("down");
      expect(mounted.screen.settingsChoice()).toEqual({ category: "model", value: "ollama-cloud/deepseek-v4.1-flash" });
      mounted.mockInput.pressArrow("down");
      mounted.mockInput.pressArrow("down");
      expect(mounted.screen.settingsChoice()).toEqual({ category: "model", value: "openrouter/deepseek/deepseek-v4-pro" });
    });
  });

  test("each keystroke sends the selection back to the first match", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      await mounted.mockInput.typeText("deeps");
      mounted.mockInput.pressArrow("down");
      mounted.mockInput.pressArrow("down");
      await mounted.mockInput.typeText("e");
      expect(mounted.screen.settingsChoice()).toEqual({ category: "model", value: "deepseek/deepseek-flash" });
    });
  });

  test("clearing the filter brings every section back", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      await mounted.mockInput.typeText("deeps");
      for (let step = 0; step < 5; step++) mounted.mockInput.pressBackspace();
      const rows = panelRows(await frameOf(mounted));
      expect(rows).toContain("Model");
      expect(rows).toContain("Effort");
      expect(rows.some((row) => row.includes("amd/GLM-5.3-Flash"))).toBe(true);
    });
  });

  test("typing over the filter after an apply reaches another section", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      await mounted.mockInput.typeText("deeps");
      mounted.mockInput.pressEnter();
      for (let step = 0; step < 5; step++) mounted.mockInput.pressBackspace();
      await mounted.mockInput.typeText("eff");
      const rows = panelRows(await frameOf(mounted));
      expect(rows[0]).toBe("Effort");
      expect(rows).not.toContain("Model");
    });
  });

  test("a filter without any match says so and offers no choice", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      await mounted.mockInput.typeText("zzz");
      const frame = await frameOf(mounted);
      expect(frame).toContain("No matching settings");
      expect(mounted.screen.settingsChoice()).toBeUndefined();
      mounted.mockInput.pressEnter();
      expect(intentsOf(mounted)).toEqual(["confirm"]);
    });
  });

  test("the filter is a bare input row: no slash, the status line invites to type", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      expect(rowsOf(await frameOf(mounted)).at(-1)).toContain("Type to filter");
      expect(mounted.screen.paletteText()).toBeUndefined();
      await mounted.mockInput.typeText("deeps");
      const frame = await frameOf(mounted);
      expect(rowsOf(frame).some((line) => line.includes("❯ deeps"))).toBe(true);
      expect(mounted.screen.inputText()).toBe("");
    });
  });

  test("ctrl+D with a filter typed does not quit, and still quits on an empty filter", async () => {
    await withScreen({}, async (mounted) => {
      await openSettingsOn(mounted);
      await mounted.mockInput.typeText("deeps");
      mounted.mockInput.pressKey("d", { ctrl: true });
      expect(intentsOf(mounted)).not.toContain("quit");
      for (let step = 0; step < 5; step++) mounted.mockInput.pressBackspace();
      mounted.mockInput.pressKey("d", { ctrl: true });
      expect(intentsOf(mounted)).toContain("quit");
    });
  });

  test("closing the panel hands the keyboard back to the message box, which kept its draft", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base(LONG));
      await mounted.mockInput.typeText("draft");
      mounted.screen.openOverlay("settings");
      await mounted.mockInput.typeText("deeps");
      mounted.screen.closeOverlay();
      await mounted.mockInput.typeText("!");
      expect(mounted.screen.inputText()).toBe("draft!");
      // La saisie filtrée ne reste pas : rouvrir les réglages repart d'un filtre vide.
      mounted.screen.openOverlay("settings");
      expect(panelRows(await frameOf(mounted))).toContain("Effort");
    });
  });

  test("ctrl+c closes the panel, drops the filter and brings the draft back without quitting", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, base(LONG));
      mounted.screen.setInput("draft");
      mounted.screen.openOverlay("settings");
      await mounted.mockInput.typeText("deeps");
      mounted.mockInput.pressCtrlC();
      await mounted.renderOnce();
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(intentsOf(mounted)).toEqual([]);
      expect(mounted.screen.inputText()).toBe("draft");
      mounted.screen.openOverlay("settings");
      expect(panelRows(await frameOf(mounted))).toContain("Effort");
    });
  });

  test("the filter keeps a long catalogue inside the 18-row window", async () => {
    await withScreen({ height: 40 }, async (mounted) => {
      const many: ConfigOption[] = [
        { id: "model", name: "Model", category: "model", currentValue: "m0", values: Array.from({ length: 300 }, (_, index) => ({ value: `m${index}`, name: `provider/model-${index}` })) },
        { id: "effort", name: "Effort", category: "thought_level", currentValue: "low", values: [{ value: "low", name: "low" }] },
      ];
      await openSettingsOn(mounted, many);
      expect(panelRows(await frameOf(mounted)).length).toBeLessThanOrEqual(18);
      await mounted.mockInput.typeText("model-29");
      const rows = panelRows(await frameOf(mounted));
      expect(rows).toHaveLength(12);
      expect(rows[1]).toContain("provider/model-29");
    });
  });
});

describe("filterSettings", () => {
  const entries = settingsEntries(LONG);

  test("an empty filter keeps every entry", () => {
    expect(filterSettings(entries, "")).toEqual(entries);
  });

  test("a section without a match disappears, title included", () => {
    const kept = filterSettings(entries, "deeps");
    expect(kept.some((entry) => entry.kind === "title" && entry.label === "Effort")).toBe(false);
    expect(kept.some((entry) => entry.kind === "value" && entry.category === "thought_level")).toBe(false);
  });

  test("every kept value belongs to a kept title, in section order", () => {
    for (const text of ["", "e", "eff", "low", "deeps", "MODEL"]) {
      let title: string | undefined;
      let previous = -1;
      for (const entry of filterSettings(entries, text)) {
        if (entry.kind === "title") {
          title = entry.label;
          const index = ["Model", "Effort", "Mode"].indexOf(entry.label);
          expect(index).toBeGreaterThan(previous);
          previous = index;
        } else {
          expect(title).toBeDefined();
        }
      }
    }
  });
});

// ---- surcouches : cycle de vie ----

describe("overlay lifecycle", () => {
  test("only one overlay at a time and closeOverlay is idempotent", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, withPlan(base()));
      mounted.screen.openOverlay("plan");
      mounted.screen.openOverlay("settings");
      expect(mounted.screen.overlay()).toBe("settings");
      expect(await frameOf(mounted)).not.toContain("Run the test file");
      mounted.screen.closeOverlay();
      mounted.screen.closeOverlay();
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(mounted.screen.paletteChoice()).toBeUndefined();
      expect(mounted.screen.settingsChoice()).toBeUndefined();
    });
  });

  test("toggle intents switch between overlays and the status line follows", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, withPlan(base()));
      mounted.mockInput.pressKey("o", { ctrl: true });
      expect(rowsOf(await frameOf(mounted)).at(-1)).toContain("⏎ Apply");
      mounted.mockInput.pressKey("p", { ctrl: true });
      expect(mounted.screen.overlay()).toBe("plan");
      expect(rowsOf(await frameOf(mounted)).at(-1)).toContain("⌃P Close plan");
      mounted.mockInput.pressKey("o", { ctrl: true });
      mounted.mockInput.pressKey("o", { ctrl: true });
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(rowsOf(await frameOf(mounted)).at(-1)).toContain("⌃P Plan");
      expect(intentsOf(mounted)).toEqual([]);
    });
  });

  test("session intents still reach the runner while an overlay is open", async () => {
    await withScreen({}, async (mounted) => {
      await show(mounted, withPlan(base()));
      mounted.screen.openOverlay("plan");
      mounted.mockInput.pressKey("r", { ctrl: true });
      mounted.mockInput.pressTab({ shift: true });
      await mounted.renderOnce();
      expect(intentsOf(mounted)).toEqual(["reopenHeld", "nextMode"]);
    });
  });

  test("overlays do not disturb the thread: it renders again at the same place after closing", async () => {
    await withScreen({}, async (mounted) => {
      const state = withTool(apply(base(), { type: "userPrompt", text: "hello there" }), { id: "t", name: "Read", title: "src/a.ts" });
      const before = await show(mounted, state);
      mounted.screen.openOverlay("settings");
      await mounted.renderOnce();
      mounted.screen.closeOverlay();
      expect(await frameOf(mounted)).toBe(before);
      mounted.screen.openOverlay("palette");
      await mounted.renderOnce();
      mounted.screen.closeOverlay();
      expect(await frameOf(mounted)).toBe(before);
    });
  });
});

// ---- agent arrêté ----

describe("agent exited line", () => {
  test("shows the code in red as the last block of the thread, and no pending block", async () => {
    await withScreen({}, async (mounted) => {
      const exited = apply(waitingOnBash(), { type: "agentExited", code: 1, signal: null });
      const frame = await show(mounted, exited);
      expect(frame).toContain("Agent exited (code 1). Press any key to leave.");
      expect(frame).not.toContain("Allow this command?");
      expect(spanOf(mounted, "Agent exited")?.fg).toEqual(hexInts(ACCENT.red));
      const rows = rowsOf(frame);
      const exitedRow = rows.findIndex((line) => line.includes("Agent exited"));
      expect(rows[exitedRow - 1]?.trim()).toBe("");
      expect(rows.findLastIndex((line) => line.includes("❯"))).toBeGreaterThan(exitedRow);
      expect(rows.at(-1)).toContain("Press any key to leave");
    });
  });

  test("a tool that was running shows no running time and a grey dot once the agent has exited", async () => {
    let clock = 1_000_000;
    await withScreen({ now: () => clock }, async (mounted) => {
      const running = waitingOnBash();
      await show(mounted, running);
      clock += 5_000;
      const frame = await show(mounted, apply(running, { type: "agentExited", code: 1, signal: null }));
      expect(lineOf(frame, "git push origin")).not.toMatch(/\ds\s*$/);
      expect(spanOf(mounted, "●")?.fg).toEqual(hexInts(LABEL.disabled));
      clock += 5_000;
      expect(lineOf(await show(mounted, apply(running, { type: "agentExited", code: 1, signal: null })), "git push origin")).not.toMatch(/\ds\s*$/);
    });
  });

  test("names the signal when there is no exit code", async () => {
    await withScreen({}, async (mounted) => {
      const frame = await show(mounted, apply(base(), { type: "agentExited", code: null, signal: "SIGKILL" }));
      expect(frame).toContain("Agent exited (signal SIGKILL). Press any key to leave.");
    });
  });

  test("says nothing about a cause when neither a code nor a signal is known", async () => {
    await withScreen({}, async (mounted) => {
      const frame = await show(mounted, apply(base(), { type: "agentExited", code: null, signal: null }));
      expect(frame).toContain("Agent exited. Press any key to leave.");
    });
  });

  test("an exit closes an open palette", async () => {
    await withScreen({}, async (mounted) => {
      await openPalette(mounted);
      const frame = await show(mounted, apply(base(), { type: "agentExited", code: 0, signal: null }));
      expect(mounted.screen.overlay()).toBeUndefined();
      expect(frame).toContain("Agent exited (code 0)");
    });
  });
});
