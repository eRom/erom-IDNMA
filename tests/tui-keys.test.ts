import { describe, expect, test } from "bun:test";
import { type Context, type Intent, intentOf, type KeyLike } from "../src/tui/keys.ts";
import * as theme from "../src/tui/theme.ts";

/** Forme des événements d'OpenTUI 0.8.4 : voir parseKeypress. */
function key(name: string, modifiers: Partial<Omit<KeyLike, "name">> = {}): KeyLike {
  return { name, ctrl: false, shift: false, meta: false, ...modifiers };
}

const ctrl = (name: string): KeyLike => key(name, { ctrl: true });

const baseContext: Context = {
  status: "idle",
  turnActive: false,
  pending: false,
  inputEmpty: true,
  lastWasCtrlC: false,
};

function context(overrides: Partial<Context> = {}): Context {
  return { ...baseContext, ...overrides };
}

interface Row {
  title: string;
  key: KeyLike;
  context: Context;
  expected: Intent;
}

const rows: Row[] = [
  { title: "any key after the agent died quits", key: key("a"), context: context({ status: "exited" }), expected: "quit" },
  { title: "return after the agent died quits", key: key("return"), context: context({ status: "exited" }), expected: "quit" },
  { title: "ctrl+c after the agent died quits even with a turn flag", key: ctrl("c"), context: context({ status: "exited", turnActive: true }), expected: "quit" },

  { title: "ctrl+c while idle clears the input", key: ctrl("c"), context: context(), expected: "clearInput" },
  { title: "ctrl+c during a turn interrupts", key: ctrl("c"), context: context({ status: "running", turnActive: true }), expected: "interrupt" },
  { title: "ctrl+c during a permission of a turn interrupts", key: ctrl("c"), context: context({ status: "waiting", turnActive: true, pending: true }), expected: "interrupt" },
  { title: "two ctrl+c in a row quit", key: ctrl("c"), context: context({ lastWasCtrlC: true }), expected: "quit" },
  { title: "second ctrl+c quits even during a turn", key: ctrl("c"), context: context({ status: "running", turnActive: true, lastWasCtrlC: true }), expected: "quit" },

  { title: "ctrl+d on an empty input quits", key: ctrl("d"), context: context(), expected: "quit" },
  { title: "ctrl+d on a non-empty input goes to the input", key: ctrl("d"), context: context({ inputEmpty: false }), expected: "none" },

  { title: "return submits", key: key("return"), context: context(), expected: "submit" },
  { title: "return with meta but no shift still submits", key: key("return", { meta: true }), context: context(), expected: "submit" },
  { title: "return confirms a pending permission", key: key("return"), context: context({ status: "waiting", turnActive: true, pending: true }), expected: "confirm" },
  { title: "return confirms in the palette", key: key("return"), context: context({ overlay: "palette" }), expected: "confirm" },
  { title: "return confirms in the settings panel", key: key("return"), context: context({ overlay: "settings" }), expected: "confirm" },
  { title: "return in the plan overlay submits", key: key("return"), context: context({ overlay: "plan" }), expected: "submit" },
  { title: "shift+return is a newline in the input", key: key("return", { shift: true }), context: context(), expected: "none" },
  { title: "shift+return stays a newline during a permission", key: key("return", { shift: true }), context: context({ pending: true }), expected: "none" },
  { title: "linefeed is a newline in the input", key: key("linefeed"), context: context(), expected: "none" },
  { title: "ctrl+j is a newline in the input", key: ctrl("j"), context: context(), expected: "none" },

  { title: "escape refuses a pending permission", key: key("escape"), context: context({ status: "waiting", turnActive: true, pending: true }), expected: "refuse" },
  { title: "escape closes the palette", key: key("escape"), context: context({ overlay: "palette" }), expected: "closeOverlay" },
  { title: "escape closes the settings panel", key: key("escape"), context: context({ overlay: "settings" }), expected: "closeOverlay" },
  { title: "escape closes the plan without a turn", key: key("escape"), context: context({ overlay: "plan" }), expected: "closeOverlay" },
  { title: "escape with the plan open during a turn interrupts", key: key("escape"), context: context({ overlay: "plan", status: "running", turnActive: true }), expected: "interrupt" },
  { title: "escape during a turn interrupts", key: key("escape"), context: context({ status: "running", turnActive: true }), expected: "interrupt" },
  { title: "escape while idle goes to the input", key: key("escape"), context: context(), expected: "none" },

  { title: "up moves the selection of a permission", key: key("up"), context: context({ pending: true }), expected: "selectUp" },
  { title: "down moves the selection of the palette", key: key("down"), context: context({ overlay: "palette" }), expected: "selectDown" },
  { title: "down moves the selection of the settings panel", key: key("down"), context: context({ overlay: "settings" }), expected: "selectDown" },
  { title: "up in the text goes to the input", key: key("up"), context: context(), expected: "none" },
  { title: "down in the plan overlay goes to the input", key: key("down"), context: context({ overlay: "plan" }), expected: "none" },

  { title: "slash on an empty input opens the palette", key: key("/"), context: context(), expected: "openPalette" },
  { title: "slash in a non-empty input is typed", key: key("/"), context: context({ inputEmpty: false }), expected: "none" },
  { title: "slash during a permission is not the palette", key: key("/"), context: context({ pending: true }), expected: "none" },
  { title: "slash with an overlay open is not the palette", key: key("/"), context: context({ overlay: "plan" }), expected: "none" },
  { title: "ctrl+slash is not the palette", key: ctrl("/"), context: context(), expected: "none" },
  { title: "meta+slash is not the palette", key: key("/", { meta: true }), context: context(), expected: "none" },

  { title: "ctrl+p toggles the plan", key: ctrl("p"), context: context(), expected: "togglePlan" },
  { title: "ctrl+o toggles the settings panel", key: ctrl("o"), context: context(), expected: "toggleSettings" },
  { title: "ctrl+r reopens the held messages", key: ctrl("r"), context: context(), expected: "reopenHeld" },
  { title: "shift+tab cycles the mode", key: key("tab", { shift: true }), context: context(), expected: "nextMode" },
  { title: "plain tab goes to the input", key: key("tab"), context: context(), expected: "none" },

  { title: "pageup scrolls up", key: key("pageup"), context: context(), expected: "scrollPageUp" },
  { title: "pagedown scrolls down", key: key("pagedown"), context: context(), expected: "scrollPageDown" },
  { title: "home scrolls to the top", key: key("home"), context: context(), expected: "scrollTop" },
  { title: "end scrolls to the bottom", key: key("end"), context: context(), expected: "scrollBottom" },

  { title: "a printable character goes to the input", key: key("a"), context: context(), expected: "none" },
  { title: "backspace goes to the input", key: key("backspace"), context: context(), expected: "none" },
];

describe("intentOf", () => {
  for (const row of rows) {
    test(row.title, () => {
      expect(intentOf(row.key, row.context)).toBe(row.expected);
    });
  }
});

describe("theme", () => {
  test("every exported colour is a #RRGGBB string", () => {
    const colours: string[] = [theme.WINDOW, ...Object.values(theme.LABEL), ...Object.values(theme.SURFACE), ...Object.values(theme.ACCENT)];
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) {
      expect(colour).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
