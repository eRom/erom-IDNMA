import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chunkShape, classifyInput, DraftTracker, type InputKind } from "../src/hooked/draft.ts";

interface RecordedInput {
  key: string;
  hex: string;
  expected: InputKind;
}

describe("classifyInput", () => {
  test("classifies typed input", () => {
    const table: Array<[string, InputKind]> = [
      ["\r", "enter"],
      ["abc\r", "enter"],
      ["\x1b[13u", "enter"],
      ["\x1b[13;1u", "enter"],
      ["a", "keystroke"],
      ["\x1b[A", "keystroke"],
      ["\x03", "keystroke"],
      ["\x1b", "keystroke"],
      ["\x1b[13;2u", "keystroke"],
      ["\x1b\r", "keystroke"],
      ["abc\x1b\r", "keystroke"],
      ["\n", "keystroke"],
      ["\x1b[200~collé\x1b[201~", "keystroke"],
      ["\x1b[200~ligne1\rligne2\x1b[201~", "keystroke"],
    ];
    for (const [chunk, expected] of table) {
      expect({ chunk, kind: classifyInput(chunk) }).toEqual({ chunk, kind: expected });
    }
  });

  test("ignores terminal reports, focus and mouse", () => {
    const reports = [
      "\x1b[I",
      "\x1b[O",
      "\x1b[<64;10;5M",
      "\x1b[12;40R",
      "\x1b[?62;22c",
      "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
      "\x1b]10;rgb:ffff/ffff/ffff\x07",
      "\x1b[?1u",
      "\x1b[13;1:3u",
    ];
    for (const chunk of reports) {
      expect({ chunk, kind: classifyInput(chunk) }).toEqual({ chunk, kind: "noise" });
    }
  });

  test("noise is stripped before classifying the rest", () => {
    expect(classifyInput("\x1b[Ia")).toBe("keystroke");
    expect(classifyInput("\x1b[O\r")).toBe("enter");
  });

  test("strips the remaining report families", () => {
    const reports = [
      "\x1b[<0;10;5m", // souris SGR, relâchement
      "\x1b[M !!", // souris X10 : trois octets après \x1b[M
      "\x1b[>1;2c", // attributs secondaires
      "\x1b[?2026;2$y\x1b[?2027;0$y", // deux DECRPM dans un bloc
      "\x1bP>|terminal 1.0\x1b\\", // DCS terminé par ST
    ];
    for (const chunk of reports) {
      expect({ chunk, kind: classifyInput(chunk) }).toEqual({ chunk, kind: "noise" });
    }
  });

  test("a report glued to an Enter or a keystroke does not hide it", () => {
    expect(classifyInput("\x1b[?2026;2$y\r")).toBe("enter");
    expect(classifyInput("\x1b[12;40Rx")).toBe("keystroke");
    expect(classifyInput("\x1b[13;1:3u\r")).toBe("enter");
  });

  test("an Enter after a bracketed paste submits, an Enter inside does not", () => {
    expect(classifyInput("\x1b[200~collé\x1b[201~\r")).toBe("enter");
    // chunk coupé au milieu d'un collage : le \r final appartient au collage
    expect(classifyInput("\x1b[200~ligne1\r")).toBe("keystroke");
  });

  test("classifies the recorded harness input", () => {
    for (const file of ["grok-input.json", "agy-input.json"]) {
      const entries = JSON.parse(
        readFileSync(`tests/fixtures/pty/${file}`, "utf8"),
      ) as RecordedInput[];
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const chunk = Buffer.from(entry.hex, "hex").toString("utf8");
        expect({ file, key: entry.key, kind: classifyInput(chunk) }).toEqual({
          file,
          key: entry.key,
          kind: entry.expected,
        });
      }
    }
  });
});

describe("DraftTracker", () => {
  test("draft tracker follows keystrokes and Enter", () => {
    const tracker = new DraftTracker();
    expect(tracker.dirty).toBe(false);
    expect(tracker.feed("a")).toBe("keystroke");
    expect(tracker.dirty).toBe(true);
    expect(tracker.feed("\x1b[I")).toBe("noise");
    expect(tracker.dirty).toBe(true);
    expect(tracker.feed("\r")).toBe("enter");
    expect(tracker.dirty).toBe(false);
    tracker.feed("b");
    expect(tracker.dirty).toBe(true);
    tracker.reset();
    expect(tracker.dirty).toBe(false);
  });

  test("noise alone never makes the draft dirty", () => {
    const tracker = new DraftTracker();
    tracker.feed("\x1b[?1;2;4c");
    expect(tracker.dirty).toBe(false);
  });
});

describe("chunkShape", () => {
  test("tells a mouse report cut in two from an escape sequence and from text", () => {
    for (const chunk of ["0;10M", ";10M", "10M", "35;40;10m"]) expect(chunkShape(chunk)).toBe("mouse-fragment");
    for (const chunk of ["\x1b[<35;4", "\x1b[A", "\x1bx", "\x1b[97u", "\x1b[200~secret\x1b[201~"]) expect(chunkShape(chunk)).toBe("escape");
    for (const chunk of ["x", "M", "3", "4242;1234", "secret", "mot de passe\r"]) expect(chunkShape(chunk)).toBe("text");
  });
});
