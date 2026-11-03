import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { procStart, procStarts } from "../src/bus/proc.ts";
import { listLiveEntries, removeEntry, writeEntry, type SessionEntry } from "../src/bus/registry.ts";

let dir: string;
let previousClaudeDir: string | undefined;
let sleeper: ReturnType<typeof Bun.spawn>;

beforeEach(() => {
  previousClaudeDir = process.env.IDNMA_CLAUDE_DIR;
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CLAUDE_DIR = dir;
  sleeper = Bun.spawn(["sleep", "600"]);
});

afterEach(() => {
  sleeper.kill();
  rmSync(dir, { recursive: true, force: true });
  if (previousClaudeDir === undefined) delete process.env.IDNMA_CLAUDE_DIR;
  else process.env.IDNMA_CLAUDE_DIR = previousClaudeDir;
});

// sessionsDir() vaut <IDNMA_CLAUDE_DIR> tel quel : le test écrit directement dedans.
function makeEntry(pid: number, start: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    pid,
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: "/tmp/somewhere",
    startedAt: 1_700_000_000_000,
    procStart: start,
    version: "2.1.310",
    peerProtocol: 1,
    peerFeatures: ["notify_idle"],
    kind: "interactive",
    entrypoint: "cli",
    pidDomain: "darwin",
    messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
    name: "understudy",
    nameSource: "user",
    nameSince: 1_700_000_000_001,
    status: "idle",
    updatedAt: 1_700_000_000_002,
    statusUpdatedAt: 1_700_000_000_003,
    ...overrides,
  };
}

function realStart(pid: number): string {
  const start = procStart(pid);
  if (start === undefined) throw new Error(`no procStart for pid ${pid}`);
  return start;
}

test("lists a live entry with all its fields", () => {
  const entry = makeEntry(sleeper.pid, realStart(sleeper.pid), { tmux: "main:0.1" });
  writeEntry(entry);
  expect(listLiveEntries()).toEqual([entry]);
});

test("drops an entry whose process has terminated", async () => {
  const entry = makeEntry(sleeper.pid, realStart(sleeper.pid));
  writeEntry(entry);
  sleeper.kill();
  await sleeper.exited;
  expect(listLiveEntries()).toEqual([]);
});

test("drops an entry whose pid is alive but procStart differs (reused pid)", () => {
  writeEntry(makeEntry(sleeper.pid, "Thu Jan  1 00:00:00 1970"));
  expect(listLiveEntries()).toEqual([]);
});

test("ignores unreadable json, incomplete entries and non-entry files", () => {
  writeFileSync(join(dir, "123.json"), "{ not json");
  writeFileSync(join(dir, "124.json"), JSON.stringify({ pid: 124, name: "x" }));
  writeFileSync(join(dir, "125.json"), JSON.stringify({ pid: 125, procStart: "x" }));
  writeFileSync(join(dir, "x.key"), "{}");
  writeFileSync(join(dir, `${sleeper.pid}.json.tmp`), "{}");
  const entry = makeEntry(sleeper.pid, realStart(sleeper.pid));
  writeEntry(entry);
  expect(listLiveEntries()).toEqual([entry]);
});

test("returns nothing when the sessions directory does not exist", () => {
  process.env.IDNMA_CLAUDE_DIR = join(dir, "missing");
  expect(listLiveEntries()).toEqual([]);
});

test("writeEntry round-trips the json, in mode 644, leaving no temporary file", () => {
  const entry = makeEntry(sleeper.pid, realStart(sleeper.pid));
  const path = writeEntry(entry);
  expect(path).toBe(join(dir, `${sleeper.pid}.json`));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(entry);
  expect(statSync(path).mode & 0o777).toBe(0o644);
  expect(readdirSync(dir)).toEqual([`${sleeper.pid}.json`]);
});

test("writeEntry creates the sessions directory when missing", () => {
  process.env.IDNMA_CLAUDE_DIR = join(dir, "nested", "sessions");
  const path = writeEntry(makeEntry(sleeper.pid, realStart(sleeper.pid)));
  expect(existsSync(path)).toBe(true);
});

test("removeEntry deletes the file and tolerates a second call", () => {
  const path = writeEntry(makeEntry(sleeper.pid, realStart(sleeper.pid)));
  removeEntry(sleeper.pid);
  expect(existsSync(path)).toBe(false);
  expect(() => removeEntry(sleeper.pid)).not.toThrow();
});

test("procStarts maps live pids and procStart matches ps output", () => {
  const starts = procStarts([sleeper.pid, 1]);
  expect([...starts.keys()].sort((a, b) => a - b)).toEqual([1, sleeper.pid]);
  const expected = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(sleeper.pid)], {
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  })
    .stdout.toString()
    .trim();
  expect(procStart(sleeper.pid)).toBe(expected);
  expect(starts.get(sleeper.pid)).toBe(expected);
});

test("procStarts handles an empty list and unknown pids without throwing", () => {
  expect(procStarts([]).size).toBe(0);
  expect(procStarts([2_000_000_000]).size).toBe(0);
  expect(procStart(2_000_000_000)).toBeUndefined();
});

test("an invalid pid in one file does not hide the healthy entries", () => {
  const entry = makeEntry(sleeper.pid, realStart(sleeper.pid));
  writeEntry(entry);
  writeFileSync(join(dir, "7.json"), JSON.stringify(makeEntry(-5, "x")));
  writeFileSync(join(dir, "8.json"), JSON.stringify(makeEntry(1.5, "x")));
  writeFileSync(join(dir, "9.json"), JSON.stringify(makeEntry(99_999_999, "x")));
  expect(listLiveEntries()).toEqual([entry]);
});

test("procStarts skips invalid pids instead of letting ps abort the whole list", () => {
  const starts = procStarts([sleeper.pid, -5, 1.5, 99_999_999, 0]);
  expect([...starts.keys()]).toEqual([sleeper.pid]);
});
