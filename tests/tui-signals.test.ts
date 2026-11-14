import { expect, test } from "bun:test";
import type { Status } from "../src/tui/state.ts";
import { NOTIFY, PROGRESS_OFF, PROGRESS_ON, createSignals } from "../src/tui/signals.ts";

/** Rejoue une suite d'états et renvoie les écritures dans l'ordre. */
function replay(statuses: Status[], name = "opus-mars-ab12"): string[] {
  const writes: string[] = [];
  const signals = createSignals(name, (bytes) => writes.push(bytes));
  for (let index = 1; index < statuses.length; index++) {
    signals.onStatus(statuses[index - 1] as Status, statuses[index] as Status);
  }
  return writes;
}

test("idle to running to waiting to idle writes progress on, progress off, then the notification, then nothing", () => {
  const writes = replay(["idle", "running", "waiting", "idle"]);
  expect(writes).toHaveLength(3);
  expect(writes[0]).toBe(PROGRESS_ON);
  expect(writes[1]).toBe(PROGRESS_OFF);
  expect(writes[2]).toContain("opus-mars-ab12");
  expect(writes[2]).toBe(NOTIFY("opus-mars-ab12: waiting for you"));
});

test("PROGRESS_OFF is the OSC 9;4;0 sequence, bytes verified against IdemA", () => {
  expect(Buffer.from(PROGRESS_OFF).toString("hex")).toBe("1b5d393b343b3007");
});

test("PROGRESS_ON is the indeterminate OSC 9;4;3 sequence", () => {
  expect(Buffer.from(PROGRESS_ON).toString("hex")).toBe("1b5d393b343b3307");
});

test("a status that does not change writes nothing", () => {
  const writes: string[] = [];
  const signals = createSignals("alice", (bytes) => writes.push(bytes));
  signals.onStatus("running", "running");
  signals.onStatus("waiting", "waiting");
  signals.onStatus("idle", "idle");
  expect(writes).toEqual([]);
});

test("waiting back to running turns the progress on again", () => {
  expect(replay(["waiting", "running"])).toEqual([PROGRESS_ON]);
});

test("running to exited turns the progress off and nothing else", () => {
  expect(replay(["running", "exited"])).toEqual([PROGRESS_OFF]);
});

test("idle to waiting notifies without touching the progress", () => {
  expect(replay(["idle", "waiting"], "alice")).toEqual([NOTIFY("alice: waiting for you")]);
});

test("NOTIFY frames the text as OSC 9 terminated by BEL", () => {
  const bytes = NOTIFY("hello");
  expect(bytes.startsWith("\x1b]9;")).toBe(true);
  expect(bytes.endsWith("\x07")).toBe(true);
  expect(bytes).toContain("hello");
});

test("NOTIFY strips control characters that would end the sequence early", () => {
  const bytes = NOTIFY("a\x07b\x1bc\x7fd\ne");
  expect(bytes).toBe("\x1b]9;abcde\x07");
  expect(bytes.indexOf("\x07")).toBe(bytes.length - 1);
});
