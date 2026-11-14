import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hideNestedEntries, reachablePeers } from "../src/bus/peers.ts";
import { registerPeer, type Registration } from "../src/bus/register.ts";
import type { SessionEntry } from "../src/bus/registry.ts";
import { controlDir } from "../src/paths.ts";
import { controlSocketPath, idnmaNesting } from "../src/understudy/control.ts";
import { startFakePeer, type FakePeer } from "./helpers/fake-peer.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
const ENV_KEYS = ["IDNMA_CONFIG_DIR", "IDNMA_CLAUDE_DIR", "IDNMA_SOCKETS_DIR", "IDNMA_CONTROL_DIR", "IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN"] as const;

let previousEnv: Record<string, string | undefined>;
let tempDirs: string[];
let peers: FakePeer[];
let registrations: Registration[];

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ["IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN"]) delete process.env[key];
  tempDirs = [mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-")];
  process.env.IDNMA_CONFIG_DIR = tempDirs[0];
  process.env.IDNMA_CLAUDE_DIR = tempDirs[1];
  process.env.IDNMA_SOCKETS_DIR = tempDirs[2];
  process.env.IDNMA_CONTROL_DIR = join(tempDirs[3]!, "ctl");
  peers = [];
  registrations = [];
});

afterEach(() => {
  for (const registration of registrations) registration.unregister();
  for (const peer of peers) peer.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** Entrée de registre réduite à ce que `hideNestedEntries` lit : le pid et le nom. */
function entry(pid: number, name: string): SessionEntry {
  return { pid, name } as SessionEntry;
}

describe("hideNestedEntries", () => {
  test("peer list hides a session nested under an idnma process", () => {
    const entries = [entry(10, "opus-mars-ab12"), entry(12, "opus-mars-ab12-acp"), entry(20, "argon-apollon-szvo"), entry(31, "teammate-x")];
    const parents = new Map([[12, 11], [11, 10], [20, 1], [31, 30], [30, 20]]);
    // 20 est une session Claude native : ce qui descend d'elle reste visible.
    const idnma = new Set([10]);
    expect(hideNestedEntries(entries, (pid) => parents.get(pid), (pid) => idnma.has(pid)).map((e) => e.name)).toEqual(["opus-mars-ab12", "argon-apollon-szvo", "teammate-x"]);
  });

  test("an unreadable parent table hides nothing", () => {
    const entries = [entry(10, "a"), entry(12, "b")];
    expect(hideNestedEntries(entries, () => undefined, (pid) => pid === 10)).toEqual(entries);
  });

  test("a descendant of an idnma process that is not itself a live entry does not hide anyone", () => {
    // 10 est un process idnma mais n'est pas dans la liste : seul un ancêtre qui est une entrée masque.
    const entries = [entry(12, "b")];
    expect(hideNestedEntries(entries, (pid) => (pid === 12 ? 10 : undefined), (pid) => pid === 10)).toEqual(entries);
  });

  test("a cycle in the parent table ends instead of looping", () => {
    const entries = [entry(10, "a"), entry(12, "b")];
    const parents = new Map([[12, 13], [13, 12]]);
    expect(hideNestedEntries(entries, (pid) => parents.get(pid), (pid) => pid === 10).map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("reachablePeers with nesting", () => {
  test("hides the nested entry before the caller exclusion, so the idnma process still anchors it", async () => {
    const outer = await startFakePeer("opus-mars-ab12");
    const inner = await startFakePeer("opus-mars-ab12-acp");
    const other = await startFakePeer("codex-zeus");
    peers.push(outer, inner, other);
    const nesting = { parentOf: (pid: number) => (pid === inner.entry.pid ? outer.entry.pid : undefined), isIdnmaProcess: (pid: number) => pid === outer.entry.pid };
    // L'appelant exclu est le process idnma lui-même : sa session interne doit rester masquée.
    const names = reachablePeers((e) => e.pid === outer.entry.pid, nesting).map((e) => e.name);
    expect(names).toEqual(["codex-zeus"]);
    expect(reachablePeers(() => false).map((e) => e.name)).toEqual(["codex-zeus", "opus-mars-ab12", "opus-mars-ab12-acp"]);
  });
});

describe("idnmaNesting", () => {
  test("reads the real parent table and recognizes an idnma process by its control socket", () => {
    const nesting = idnmaNesting();
    expect(nesting).toBeDefined();
    expect(nesting!.parentOf(process.pid)).toBe(process.ppid);
    expect(nesting!.isIdnmaProcess(process.pid)).toBe(false);
    mkdirSync(controlDir(), { recursive: true, mode: 0o700 });
    writeFileSync(controlSocketPath(process.pid), "");
    expect(nesting!.isIdnmaProcess(process.pid)).toBe(true);
  });
});

/** `bun src/cli.ts peer list` lancé comme enfant du process de test, sans variable de doublure. */
async function peerListOutput(): Promise<string> {
  const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, CODEX_THREAD_ID: _d, ...cleanEnv } = process.env;
  const child = Bun.spawn(["bun", CLI, "peer", "list"], { env: cleanEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output;
}

describe("idnma peer list", () => {
  // Le process de test joue le process idnma ; le sleeper du faux pair est son vrai enfant : la filiation est réelle.
  test("hides a session whose process descends from an idnma process", async () => {
    registrations.push(await registerPeer({ name: "opus-mars-ab12", cwd: "/w", onMessage: () => {} }));
    mkdirSync(controlDir(), { recursive: true, mode: 0o700 });
    writeFileSync(controlSocketPath(process.pid), "");
    peers.push(await startFakePeer("opus-mars-ab12-acp", {}, { nested: true }));
    const output = await peerListOutput();
    expect(output).not.toContain("opus-mars-ab12-acp");
  }, 15_000);

  test("keeps the same session visible when its ancestor is not an idnma process", async () => {
    registrations.push(await registerPeer({ name: "opus-mars-ab12", cwd: "/w", onMessage: () => {} }));
    peers.push(await startFakePeer("opus-mars-ab12-acp", {}, { nested: true }));
    const output = await peerListOutput();
    expect(output).toContain("opus-mars-ab12-acp");
  }, 15_000);
});
