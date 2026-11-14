import { expect, test } from "bun:test";
import type { ConfigOption } from "../src/acp/events.ts";
import { formatTokens, headerParts, statusHints, truncateLines } from "../src/tui/format.ts";
import { type Action, initialState, reduce, type SessionState } from "../src/tui/state.ts";

function run(actions: Action[], from: SessionState = initialState("alice")): SessionState {
  return actions.reduce(reduce, from);
}

const options: ConfigOption[] = [
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
    id: "effort",
    name: "Effort",
    category: "thought_level",
    currentValue: "high",
    values: [
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
      { value: "auto", name: "Auto" },
    ],
  },
];

const withOptions = (list: ConfigOption[]) => run([{ type: "event", event: { type: "config", options: list }, origin: "live" }]);

test("formatTokens", () => {
  expect(["950", "8.1k", "23.3k", "1M", "1M"]).toEqual([950, 8100, 23325, 1000000, 1048576].map(formatTokens));
});

test("formatTokens drops a trailing .0 and never prints 1000k", () => {
  expect(formatTokens(0)).toBe("0");
  expect(formatTokens(1000)).toBe("1k");
  expect(formatTokens(2000)).toBe("2k");
  expect(formatTokens(999999)).toBe("1M");
  expect(formatTokens(2500000)).toBe("2.5M");
});

test("header names the settings by their category, effort in lower case", () => {
  const parts = headerParts(withOptions(options));
  expect(parts.left).toEqual({ dot: "idle", name: "alice", settings: "Opus 5.5 · high · Manual" });
});

test("header omits a missing option and falls back to the raw value of an unknown one", () => {
  const noEffort = headerParts(withOptions([options[0] as ConfigOption, options[2] as ConfigOption]));
  expect(noEffort.left.settings).toBe("Opus 5.5 · Manual");
  const unknown = headerParts(withOptions([{ ...(options[0] as ConfigOption), currentValue: "mystery" }, { ...(options[1] as ConfigOption), currentValue: "XHigh" }]));
  expect(unknown.left.settings).toBe("mystery · xhigh");
  expect(headerParts(initialState("alice")).left.settings).toBe("");
});

test("header right shows usage with a dollar or foreign cost, and nothing without usage", () => {
  const usage = (cost?: { amount: number; currency: string }) => run([{ type: "event", event: { type: "usage", used: 23325, size: 1000000, cost }, origin: "live" }]);
  expect(headerParts(initialState("alice")).right).toBe("");
  expect(headerParts(usage()).right).toBe("23.3k / 1M");
  expect(headerParts(usage({ amount: 0.42, currency: "USD" })).right).toBe("23.3k / 1M · $0.42");
  expect(headerParts(usage({ amount: 1.5, currency: "EUR" })).right).toBe("23.3k / 1M · 1.50 EUR");
});

test("the header dot follows the derived status", () => {
  expect(headerParts(run([{ type: "turnStarted" }])).left.dot).toBe("running");
  expect(headerParts(run([{ type: "agentExited", code: 0, signal: null }])).left.dot).toBe("exited");
});

test("status hints for idle and running", () => {
  const idle = initialState("alice");
  expect(statusHints(idle)).toBe("⏎ Send  ·  ⇧⏎ Newline  ·  / Commands  ·  ⌃P Plan");
  expect(statusHints(run([{ type: "turnStarted" }]))).toBe("esc Interrupt  ·  ⏎ Queue message  ·  ⌃P Plan");
});

test("status hints follow the pending prompt, then the overlay", () => {
  const permission = run([
    {
      type: "permission",
      request: { toolCallId: "t", title: "x", choices: [{ optionId: "a", name: "Allow", kind: "allow_once" }] },
    },
  ]);
  expect(statusHints(permission)).toBe("↑↓ Select  ·  ⏎ Confirm  ·  esc Reject");
  expect(statusHints(permission, "palette")).toBe("↑↓ Select  ·  ⏎ Confirm  ·  esc Reject");
  const held = run([{ type: "held", from: "bob", text: "x", queued: 1 }]);
  expect(statusHints(held)).toMatch(/^↑↓ Select {2}· {2}⏎ Confirm {2}· {2}esc Dismiss/);
  expect(statusHints(initialState("alice"), "palette")).toBe("↑↓ Select  ·  ⏎ Run  ·  esc Close");
  expect(statusHints(initialState("alice"), "settings")).toBe("↑↓ Select  ·  ⏎ Apply  ·  esc Close");
  expect(statusHints(initialState("alice"), "plan")).toBe("⌃P Close plan  ·  esc Close");
  expect(statusHints(run([{ type: "turnStarted" }]), "plan")).toBe("⌃P Close plan  ·  esc Interrupt");
});

test("the held counter follows the queue during a turn", () => {
  const state = run([{ type: "turnStarted" }, { type: "heldCount", queued: 2 }]);
  expect(statusHints(state)).toContain("2 held");
  expect(statusHints(state)).toBe("esc Interrupt  ·  ⏎ Queue message  ·  ⌃P Plan  ·  2 held  ·  ⌃R Open");
  expect(statusHints(run([{ type: "heldCount", queued: 1 }]), "palette")).toBe("↑↓ Select  ·  ⏎ Run  ·  esc Close  ·  1 held  ·  ⌃R Open");
});

test("while a held card is open the suffix counts the other held messages only, and is omitted at zero", () => {
  const held = (queued: number) => run([{ type: "held", from: "bob", text: "x", queued }]);
  expect(statusHints(held(1))).toBe("↑↓ Select  ·  ⏎ Confirm  ·  esc Dismiss");
  expect(statusHints(held(3))).toBe("↑↓ Select  ·  ⏎ Confirm  ·  esc Dismiss  ·  2 held  ·  ⌃R Open");
  // Une permission en attente ne rouvre aucune carte : le compteur reste entier.
  const permission = run([{ type: "turnStarted" }, { type: "permission", request: { toolCallId: "t", title: "x", choices: [{ optionId: "a", name: "Allow", kind: "allow_once" }] } }, { type: "heldCount", queued: 3 }]);
  expect(statusHints(permission)).toBe("↑↓ Select  ·  ⏎ Confirm  ·  esc Reject  ·  3 held  ·  ⌃R Open");
});

test("an exited agent shows only the leave hint, without the held suffix", () => {
  const state = run([{ type: "heldCount", queued: 4 }, { type: "agentExited", code: 1, signal: null }]);
  expect(statusHints(state)).toBe("Press any key to leave");
  expect(statusHints(state, "palette")).toBe("Press any key to leave");
});

test("truncateLines keeps the first lines and counts the rest", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `l${index}`);
  const cut = truncateLines(lines, 12);
  expect(cut.shown).toEqual(lines.slice(0, 12));
  expect(cut.hidden).toBe(8);
  expect(truncateLines(lines, 20)).toEqual({ shown: lines, hidden: 0 });
  expect(truncateLines(lines, 50)).toEqual({ shown: lines, hidden: 0 });
  expect(truncateLines([], 5)).toEqual({ shown: [], hidden: 0 });
});
