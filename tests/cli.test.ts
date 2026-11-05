import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import type { InboundMessage } from "../src/bus/inbox.ts";
import { procStart } from "../src/bus/proc.ts";
import { registerPeer, type Registration } from "../src/bus/register.ts";
import { removeEntry, writeEntry } from "../src/bus/registry.ts";
import { controlDir } from "../src/paths.ts";
import { GENERIC_SKILL, skillText } from "../src/install/skill.ts";
import { TEAMMATE_END, TEAMMATE_START, TEAMMATE_TEXT } from "../src/install/teammate.ts";
import { startControlServer, writeCodexPointer, type ControlCall, type ControlResponse } from "../src/understudy/control.ts";
import { runUnderstudy } from "../src/understudy/understudy.ts";
import type { Courier } from "../src/understudy/courier.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import { startFakePeer, type FakePeer } from "./helpers/fake-peer.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
const HOOK_FIXTURES = join(import.meta.dir, "fixtures/hooks");
const childTest = (title: string, body: () => Promise<void>): void => test(title, body, { timeout: 15_000 });

const ENV_KEYS = ["IDNMA_CONFIG_DIR", "IDNMA_CLAUDE_DIR", "IDNMA_SOCKETS_DIR", "IDNMA_CONTROL_DIR", "IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN", "DSH_IDNMA_CONTROL_TOKEN"] as const;
let previousEnv: Record<string, string | undefined>;
let tempDirs: string[];
let registrations: Registration[];
let peers: FakePeer[];
let servers: Server[];
let stops: Array<() => void>;
const BRIDGE_TOKEN = "bridge-token-test";

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ["IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN", "DSH_IDNMA_CONTROL_TOKEN"]) delete process.env[key];
  tempDirs = [mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-")];
  // Journal de la doublure (idnma.log) : jamais dans le dossier de config de prod.
  process.env.IDNMA_CONFIG_DIR = tempDirs[3];
  process.env.IDNMA_CLAUDE_DIR = tempDirs[0];
  process.env.IDNMA_SOCKETS_DIR = tempDirs[1];
  process.env.IDNMA_CONTROL_DIR = join(tempDirs[2]!, "ctl");
  registrations = [];
  peers = [];
  servers = [];
  stops = [];
});

afterEach(() => {
  for (const registration of registrations) registration.unregister();
  for (const peer of peers) peer.stop();
  for (const server of servers) server.close();
  for (const stop of stops) stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function waitFor(condition: () => boolean, label: string, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Lance `bun src/cli.ts …` avec un environnement purgé des variables de la doublure. */
async function cli(args: string[], extraEnv: Record<string, string> = {}, stdinFile?: string): Promise<CliResult> {
  const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, CODEX_THREAD_ID: _d, DSH_IDNMA_CONTROL_TOKEN: _e, ...cleanEnv } = process.env;
  const child = Bun.spawn(["bun", CLI, ...args], {
    env: { ...cleanEnv, ...extraEnv },
    stdin: stdinFile === undefined ? "ignore" : Bun.file(stdinFile),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

describe("idnma CLI", () => {
  childTest("read then peer send run through a real understudy and reach the peer as codex-janus in bypass mode", async () => {
    const peer = await startFakePeer("claude-vulcain");
    peers.push(peer);
    const queue = new MessageQueue();
    const registration = await registerPeer({ name: "codex-janus", cwd: "/w", onMessage: (message) => queue.push(message) });
    registrations.push(registration);
    const message: InboundMessage = { priority: "next", content: "salut depuis vulcain", authenticated: true, receivedAt: Date.now() };
    queue.push(message);
    const readFile = join(tempDirs[2]!, "read.txt");

    const code = await runUnderstudy({
      name: "codex-janus",
      argv: ["sh", "-c", `bun ${CLI} read > ${readFile} && bun ${CLI} peer send claude-vulcain bonjour > /dev/null`],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      fromMode: "bypass",
      registration,
      queue,
    });

    expect(code).toBe(0);
    // Un saut de ligne final : dans un terminal, l'invite ne se colle pas au message.
    expect(readFileSync(readFile, "utf8")).toBe("salut depuis vulcain\n");
    await waitFor(() => peer.lines.some((line) => (line as { type?: string }).type === "user"), "user frame");
    const frame = peer.lines.find((line) => (line as { type?: string }).type === "user") as { message: { content: string } };
    expect(frame.message.content).toContain('from-name="codex-janus" from-mode="bypass"');
    expect(frame.message.content).toContain("\nbonjour\n");
  });

  childTest("read without a message prints the no-pending line", async () => {
    const queue = new MessageQueue();
    const registration = await registerPeer({ name: "codex-janus", cwd: "/w", onMessage: (m) => queue.push(m) });
    registrations.push(registration);
    const outFile = join(tempDirs[2]!, "empty.txt");
    const code = await runUnderstudy({
      name: "codex-janus",
      argv: ["sh", "-c", `bun ${CLI} read > ${outFile}`],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      fromMode: "bypass",
      registration,
      queue,
    });
    expect(code).toBe(0);
    expect(readFileSync(outFile, "utf8")).toBe("idnma : aucun message en attente.\n");
  });

  childTest("peer send joins several words with single spaces and prints the message id", async () => {
    const peer = await startFakePeer("claude-vulcain");
    peers.push(peer);
    const queue = new MessageQueue();
    const registration = await registerPeer({ name: "codex-janus", cwd: "/w", onMessage: (m) => queue.push(m) });
    registrations.push(registration);
    const outFile = join(tempDirs[2]!, "send.txt");
    const code = await runUnderstudy({
      name: "codex-janus",
      argv: ["sh", "-c", `bun ${CLI} peer send claude-vulcain bonjour le monde > ${outFile}`],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      fromMode: "prompting",
      registration,
      queue,
    });
    expect(code).toBe(0);
    await waitFor(() => peer.lines.some((line) => (line as { type?: string }).type === "user"), "user frame");
    const frame = peer.lines.find((line) => (line as { type?: string }).type === "user") as { message: { content: string }; msg_id: string };
    expect(frame.message.content).toContain("\nbonjour le monde\n");
    expect(readFileSync(outFile, "utf8").trim()).toBe(`envoyé à claude-vulcain (${frame.msg_id})`);
  });

  childTest("peer send without an understudy exits 1 and says so on stderr", async () => {
    const result = await cli(["peer", "send", "x", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("aucune doublure ici");
    expect(result.stdout).toBe("");
  });

  childTest("peer send from a codex thread without a pointer file exits 1 and says there is no understudy for it", async () => {
    const result = await cli(["peer", "send", "x", "y"], { CODEX_THREAD_ID: "01a179b5-b063-74a3-8b58-1ef7941809f1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("aucune doublure pour ce thread Codex");
    expect(result.stdout).toBe("");
  });

  childTest("a malformed CODEX_THREAD_ID builds no path and reads as no understudy here", async () => {
    const result = await cli(["peer", "send", "x", "y"], { CODEX_THREAD_ID: "../x" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("aucune doublure ici");
  });

  childTest("peer send reports a bus error from the understudy with exit 1", async () => {
    const queue = new MessageQueue();
    const registration = await registerPeer({ name: "codex-janus", cwd: "/w", onMessage: (m) => queue.push(m) });
    registrations.push(registration);
    const errFile = join(tempDirs[2]!, "err.txt");
    const code = await runUnderstudy({
      name: "codex-janus",
      argv: ["sh", "-c", `bun ${CLI} peer send claude-absent x 2> ${errFile}`],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      fromMode: "bypass",
      registration,
      queue,
    });
    expect(code).toBe(1);
    expect(readFileSync(errFile, "utf8")).toBe("idnma : aucun pair vivant nommé « claude-absent » ; aucun autre pair n'est vivant\n");
  });

  childTest("peer send --help exposes no way to choose the sender name", async () => {
    const result = await cli(["peer", "send", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("peer send");
    for (const forbidden of ["--name", "--from", "--as"]) expect(result.stdout).not.toContain(forbidden);
    const main = await cli(["--help"]);
    expect(main.code).toBe(0);
    for (const forbidden of ["--name", "--from", "--as"]) expect(main.stdout).not.toContain(forbidden);
  });

  childTest("main help aligns every command description on the same column", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toBe(0);
    const commandLines = result.stdout.split("\n").filter((line) => line.startsWith("  idnma "));
    // La description commence après le premier blanc de deux espaces ou plus qui suit la commande.
    const columns = commandLines.map((line) => {
      const gap = /\S( {2,})\S/.exec(line);
      return gap === null ? -1 : gap.index + 1 + (gap[1]?.length ?? 0);
    });
    expect(commandLines.some((line) => line.includes("idnma configure [--no-open]"))).toBe(true);
    expect(columns).not.toContain(-1);
    expect(new Set(columns).size).toBe(1);
  });

  childTest("peer send without a text is a usage error (exit 2)", async () => {
    const result = await cli(["peer", "send", "claude-vulcain"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("peer send");
  });

  childTest("peer send with an empty or blank text is a usage error (exit 2), before reaching any understudy", async () => {
    for (const words of [[""], ["  ", "\n"]]) {
      const result = await cli(["peer", "send", "claude-vulcain", ...words]);
      expect({ words, code: result.code }).toEqual({ words, code: 2 });
      expect(result.stderr).toContain("vide");
      expect(result.stderr).not.toContain("aucune doublure");
    }
  });

  childTest("peer list sorts by name, aligns its columns and flags homonyms", async () => {
    peers.push(await startFakePeer("claude-zeta", { status: "busy", tmux: "main:1.0" }));
    peers.push(await startFakePeer("claude-alpha", { status: "idle" }));
    peers.push(await startFakePeer("claude-alpha", { status: "idle" }));

    const result = await cli(["peer", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        "claude-alpha  idle  -  (homonyme : injoignable par nom)",
        "claude-alpha  idle  -  (homonyme : injoignable par nom)",
        "claude-zeta   busy  main:1.0",
        "",
      ].join("\n"),
    );
  });

  childTest("peer list hides the calling agent by process lineage, not by a stale IDNMA_NAME", async () => {
    const other = await startFakePeer("claude-jupiter");
    peers.push(other);
    // L'entrée de l'agent appelant : le process de test, dont la commande lancée descend.
    writeEntry({ ...other.entry, pid: process.pid, procStart: procStart(process.pid)!, name: "claude-ceres", messagingSocketPath: "/tmp/self.sock" });
    try {
      const result = await cli(["peer", "list"], { IDNMA_NAME: "claude-jupiter" });
      expect(result.stdout).toBe("claude-jupiter  idle  -\n");
    } finally {
      removeEntry(process.pid);
    }
  });

  childTest("peer list from a codex command hides its own understudy, found through the thread pointer", async () => {
    const janus = await startFakePeer("codex-janus");
    peers.push(janus, await startFakePeer("claude-vulcain"));
    const thread = "01a179b5-b063-74a3-8b58-1ef7941809f1";
    writeCodexPointer(thread, join(controlDir(), `${janus.entry.pid}.sock`));
    const result = await cli(["peer", "list"], { CODEX_THREAD_ID: thread });
    expect(result.stdout).toBe("claude-vulcain  idle  -\n");
  });

  childTest("peer list from an opencode command hides the understudy named by IDNMA_CONTROL_SOCKET", async () => {
    const first = await startFakePeer("opencode-janus");
    const second = await startFakePeer("claude-vulcain");
    peers.push(first, second);
    const result = await cli(["peer", "list"], { IDNMA_CONTROL_SOCKET: join(controlDir(), `${first.entry.pid}.sock`) });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("claude-vulcain  idle  -\n");
  });

  childTest("peer list ignores an IDNMA_CONTROL_SOCKET that does not name a pid", async () => {
    peers.push(await startFakePeer("claude-vulcain"));
    const result = await cli(["peer", "list"], { IDNMA_CONTROL_SOCKET: join(controlDir(), "odd.sock") });
    expect(result.stdout).toBe("claude-vulcain  idle  -\n");
  });

  childTest("peer list says when no other peer is alive, and leaves out an entry without a socket", async () => {
    const ghost = await startFakePeer("claude-ghost");
    peers.push(ghost);
    const path = join(process.env.IDNMA_CLAUDE_DIR!, `${ghost.entry.pid}.json`);
    const { messagingSocketPath: _removed, ...withoutSocket } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(withoutSocket));
    const result = await cli(["peer", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("idnma : aucun autre pair vivant.\n");
  });

  /** Doublure de test : un vrai canal de contrôle dont `handle` est écrit par le test. */
  async function fakeUnderstudy(handle: (call: ControlCall) => Promise<ControlResponse>, verifyCaller?: () => Promise<boolean>): Promise<{ socketPath: string; calls: ControlCall[] }> {
    const socketPath = join(controlDir(), "ghost.sock");
    const calls: ControlCall[] = [];
    const server = await startControlServer({
      socketPath,
      token: BRIDGE_TOKEN,
      handle: async (call) => {
        calls.push(call);
        return handle(call);
      },
      verifyCaller,
    });
    stops.push(() => server.stop());
    return { socketPath, calls };
  }
  const dstEnv = (socketPath: string): Record<string, string> => ({ IDNMA_CONTROL_SOCKET: socketPath, DSH_IDNMA_CONTROL_TOKEN: BRIDGE_TOKEN, IDNMA_NAME: "dst-ghost-ab12" });

  childTest("peer list with a control channel prints what the understudy answers, a peer the local reading would not see", async () => {
    const { socketPath, calls } = await fakeUnderstudy(async () => ({
      ok: true,
      peers: [
        { name: "claude-zeta", status: "busy", tmux: "main:1.0" },
        { name: "codex-janus-ab12", status: "idle" },
      ],
    }));
    const result = await cli(["peer", "list"], dstEnv(socketPath));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(["claude-zeta       busy  main:1.0", "codex-janus-ab12  idle  -", ""].join("\n"));
    expect(calls).toEqual([{ op: "list" }]);
  });

  childTest("peer list with a control channel flags homonyms among the peers it prints", async () => {
    const { socketPath } = await fakeUnderstudy(async () => ({
      ok: true,
      peers: [
        { name: "claude-alpha", status: "idle" },
        { name: "claude-alpha", status: "busy" },
        { name: "claude-zeta", status: "idle" },
      ],
    }));
    const result = await cli(["peer", "list"], dstEnv(socketPath));
    expect(result.stdout).toBe(
      ["claude-alpha  idle  -  (homonyme : injoignable par nom)", "claude-alpha  busy  -  (homonyme : injoignable par nom)", "claude-zeta   idle  -", ""].join("\n"),
    );
  });

  childTest("peer list with a control channel and no other peer says so", async () => {
    const { socketPath } = await fakeUnderstudy(async () => ({ ok: true, peers: [] }));
    peers.push(await startFakePeer("claude-vulcain"));
    const result = await cli(["peer", "list"], dstEnv(socketPath));
    // Une liste vide mais valide : la doublure fait foi, pas de lecture locale.
    expect(result.stdout).toBe("idnma : aucun autre pair vivant.\n");
  });

  childTest("peer list falls back to the local reading when the understudy answers ok false", async () => {
    peers.push(await startFakePeer("claude-vulcain"));
    const { socketPath, calls } = await fakeUnderstudy(async () => ({ ok: false, error: "requête de contrôle invalide" }));
    const result = await cli(["peer", "list"], dstEnv(socketPath));
    expect(calls).toEqual([{ op: "list" }]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("claude-vulcain  idle  -\n");
    expect(result.stderr).toBe("");
  });

  childTest("peer list falls back to the local reading when the answer carries no peers", async () => {
    peers.push(await startFakePeer("claude-vulcain"));
    const { socketPath } = await fakeUnderstudy(async () => ({ ok: true, message: null }));
    const result = await cli(["peer", "list"], dstEnv(socketPath));
    expect(result.stdout).toBe("claude-vulcain  idle  -\n");
    expect(result.stderr).toBe("");
  });

  childTest("peer list falls back to the local reading when the understudy is unreachable", async () => {
    peers.push(await startFakePeer("claude-vulcain"));
    const result = await cli(["peer", "list"], dstEnv(join(controlDir(), "nobody.sock")));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("claude-vulcain  idle  -\n");
    expect(result.stderr).toBe("");
  });

  childTest("peer list falls back to the local reading when the socket comes without any token", async () => {
    peers.push(await startFakePeer("claude-vulcain"));
    const result = await cli(["peer", "list"], { IDNMA_CONTROL_SOCKET: join(controlDir(), "ghost.sock"), IDNMA_NAME: "dst-ghost-ab12" });
    expect(result.stdout).toBe("claude-vulcain  idle  -\n");
    expect(result.stderr).toBe("");
  });

  childTest("peer list from a codex command asks the understudy found through the thread pointer", async () => {
    const thread = "01a179b5-b063-74a3-8b58-1ef7941809f1";
    const { socketPath, calls } = await fakeUnderstudy(async () => ({ ok: true, peers: [{ name: "claude-ghost", status: "idle" }] }), async () => true);
    writeCodexPointer(thread, socketPath);
    const result = await cli(["peer", "list"], { CODEX_THREAD_ID: thread });
    expect(result.stdout).toBe("claude-ghost  idle  -\n");
    expect(calls).toEqual([{ op: "list" }]);
  });

  childTest("peer send with a control socket and no token names the missing token, not a Claude", async () => {
    const result = await cli(["peer", "send", "x", "y"], { IDNMA_CONTROL_SOCKET: join(controlDir(), "ghost.sock"), IDNMA_NAME: "dst-ghost-ab12" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("canal de contrôle sans jeton");
    expect(result.stderr).not.toContain("Claude");
  });

  childTest("peer send reaches the understudy with only DSH_IDNMA_CONTROL_TOKEN set", async () => {
    const { socketPath, calls } = await fakeUnderstudy(async () => ({ ok: true, msgId: "msg-1" }));
    const result = await cli(["peer", "send", "claude-vulcain", "bonjour"], dstEnv(socketPath));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("envoyé à claude-vulcain (msg-1)\n");
    expect(calls).toEqual([{ op: "send", to: "claude-vulcain", body: "bonjour" }]);
  });

  childTest("read with DSH_IDNMA_CONTROL_TOKEN and no message says peer messages arrive as turns", async () => {
    const { socketPath } = await fakeUnderstudy(async () => ({ ok: true, message: null }));
    const result = await cli(["read"], dstEnv(socketPath));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "idnma : chez Codex, opencode et dst, les messages de pairs arrivent d'eux-mêmes, chacun comme un nouveau tour : idnma read n'a rien à rendre.\n",
    );
  });

  childTest("read with only IDNMA_CONTROL_TOKEN (Grok, agy) and no message keeps the plain no-pending line", async () => {
    const { socketPath } = await fakeUnderstudy(async () => ({ ok: true, message: null }));
    const result = await cli(["read"], { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: BRIDGE_TOKEN });
    expect(result.stdout).toBe("idnma : aucun message en attente.\n");
  });

  childTest("run --help tells dst's refusals and that its model is picked with /model", async () => {
    const result = await cli(["run", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dst");
    expect(result.stdout).toContain("/model");
    expect(result.stdout).toMatch(/Claude prend la place de ce process ; Codex, Grok, agy, opencode et dst restent sous la doublure/);
  });

  childTest("an unknown command exits 2 and prints the help", async () => {
    const result = await cli(["bogus"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("idnma");
    expect(result.stderr).toContain("peer send");
  });

  childTest("peer read is gone: idnma read is the only way to read", async () => {
    const result = await cli(["peer", "read"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("sous-commande inconnue « read »");
    const help = await cli(["peer", "--help"]);
    expect(help.stdout).not.toContain("peer read");
  });

  childTest("an unknown peer subcommand exits 2", async () => {
    const result = await cli(["peer", "bogus"]);
    expect(result.code).toBe(2);
  });

  childTest("peer without a subcommand prints the peer usage and exits 2", async () => {
    const result = await cli(["peer"]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("«  »");
    expect(result.stderr).toContain("idnma peer send <nom> <texte...>");
    expect(result.stderr).toContain("idnma peer list");
    expect(result.stdout).toBe("");
  });

  childTest("hook without an understudy prints {} and exits 0", async () => {
    const grok = await cli(["hook", "grok", "PostToolUse"], {}, join(HOOK_FIXTURES, "grok-post-tool-use.json"));
    expect(grok).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    const agy = await cli(["hook", "agy", "PreInvocation"], {}, join(HOOK_FIXTURES, "agy-pre-invocation-doorbell.json"));
    expect(agy).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
  });

  childTest("hook without an understudy writes nothing to the log", async () => {
    await cli(["hook", "grok", "PostToolUse"], {}, join(HOOK_FIXTURES, "grok-post-tool-use.json"));
    const logPath = join(tempDirs[3]!, "logs", "idnma.log");
    expect(existsSync(logPath) ? readFileSync(logPath, "utf8") : "").not.toContain("hook-error");
  });

  childTest("hook with an unknown harness prints {}", async () => {
    const result = await cli(["hook", "zed", "Stop"]);
    expect(result).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
  });

  childTest("hook with an unknown harness inside an understudy prints {} and logs the error", async () => {
    const result = await cli(["hook", "zed", "Stop"], { IDNMA_CONTROL_SOCKET: join(tempDirs[2]!, "none.sock"), IDNMA_CONTROL_TOKEN: "t" }, join(HOOK_FIXTURES, "grok-stop-end-turn.json"));
    expect(result).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    const entries = readFileSync(join(tempDirs[3]!, "logs", "idnma.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry.event === "hook-error")).toMatchObject({ harness: "zed", hookEvent: "Stop" });
  });

  childTest("hook prints {} when the understudy does not answer in time", async () => {
    const socketPath = join(tempDirs[2]!, "mute.sock");
    // Serveur qui accepte et ne répond jamais.
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      socket.resume();
    });
    servers.push(server);
    await new Promise<void>((resolveListening) => server.listen(socketPath, resolveListening));

    const started = Date.now();
    const result = await cli(["hook", "grok", "Stop"], { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: "t" }, join(HOOK_FIXTURES, "grok-stop-end-turn.json"));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    const entries = readFileSync(join(tempDirs[3]!, "logs", "idnma.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const logged = entries.find((entry) => entry.event === "hook-error");
    expect(logged).toMatchObject({ harness: "grok", hookEvent: "Stop" });
    expect(typeof logged?.message).toBe("string");
  });

  childTest("hook prints {} without waiting when stdin stays open and silent and there is no understudy", async () => {
    const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, ...cleanEnv } = process.env;
    const child = Bun.spawn(["bun", CLI, "hook", "grok", "Stop"], { env: cleanEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      const started = Date.now();
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(Date.now() - started).toBeLessThan(2_500);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    } finally {
      child.kill();
    }
  });

  childTest("hook prints {} and logs when stdin stays open and silent inside an understudy", async () => {
    const socketPath = join(tempDirs[2]!, "mute-stdin.sock");
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      socket.resume();
    });
    servers.push(server);
    await new Promise<void>((resolveListening) => server.listen(socketPath, resolveListening));
    const { CODEX_THREAD_ID: _d, ...cleanEnv } = process.env;
    const child = Bun.spawn(["bun", CLI, "hook", "grok", "Stop"], {
      env: { ...cleanEnv, IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: "t" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const started = Date.now();
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
    } finally {
      child.kill();
    }
    const entries = readFileSync(join(tempDirs[3]!, "logs", "idnma.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.filter((entry) => entry.event === "hook-error")).toHaveLength(1);
    expect(entries.find((entry) => entry.event === "hook-error")).toMatchObject({ harness: "grok", hookEvent: "Stop" });
  });

  childTest("hook forwards the payload and prints the courier reply", async () => {
    const queue = new MessageQueue();
    const registration = await registerPeer({ name: "grok-test", cwd: "/w", onMessage: (m) => queue.push(m) });
    registrations.push(registration);
    const seen: unknown[][] = [];
    const courier: Courier = {
      beforeSpawn: async () => {},
      afterSpawn: () => {},
      onMessage: () => {},
      read: () => null,
      hook: async (harness, event, payload) => {
        seen.push([harness, event, payload]);
        return { decision: "block", reason: "x" };
      },
      verifyCaller: async () => false,
      stop: () => {},
    };
    const fixture = join(HOOK_FIXTURES, "grok-stop-end-turn.json");
    const outFile = join(tempDirs[2]!, "hook.txt");
    const code = await runUnderstudy({
      name: "grok-test",
      argv: ["sh", "-c", `bun ${CLI} hook grok Stop < ${fixture} > ${outFile}`],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      fromMode: "bypass",
      registration,
      queue,
      courier,
    });
    expect(code).toBe(0);
    expect(readFileSync(outFile, "utf8")).toBe('{"decision":"block","reason":"x"}\n');
    expect(seen).toEqual([["grok", "Stop", JSON.parse(readFileSync(fixture, "utf8"))]]);
  });
});

describe("idnma install --agent opencode", () => {
  const opencodeInstall = (command: "install" | "uninstall", configDir: string) => cli([command, "--agent", "opencode"], { IDNMA_OPENCODE_CONFIG_DIR: configDir });
  const newConfigDir = (): string => {
    const dir = mkdtempSync("/tmp/idnma-t-");
    tempDirs.push(dir);
    return dir;
  };

  childTest("install ends AGENTS.md with the teammate block and copies the generic skill; uninstall restores every byte", async () => {
    const config = newConfigDir();
    const agentsPath = join(config, "AGENTS.md");
    writeFileSync(agentsPath, "# Mes règles opencode\n");
    const before = readFileSync(agentsPath);
    const skillsDir = join(config, "skills");

    const first = await opencodeInstall("install", config);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(`opencode : ligne coéquipier installée dans ${agentsPath} ; skill ${GENERIC_SKILL} installée dans ${skillsDir}\n`);
    expect(readFileSync(agentsPath, "utf8").endsWith(`${TEAMMATE_START}\n${TEAMMATE_TEXT}\n${TEAMMATE_END}\n`)).toBe(true);
    expect(readFileSync(join(skillsDir, GENERIC_SKILL, "SKILL.md"), "utf8")).toBe(skillText(GENERIC_SKILL));

    const second = await opencodeInstall("install", config);
    expect(second.stdout).toBe(`opencode : ligne coéquipier déjà à jour dans ${agentsPath} ; skill ${GENERIC_SKILL} déjà à jour dans ${skillsDir}\n`);

    const removed = await opencodeInstall("uninstall", config);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toBe(`opencode : ligne coéquipier retirée de ${agentsPath} ; skill ${GENERIC_SKILL} retirée de ${skillsDir}\n`);
    expect(readFileSync(agentsPath).equals(before)).toBe(true);
    expect(existsSync(join(skillsDir, GENERIC_SKILL))).toBe(false);
  });

  childTest("an absent config folder is reported and nothing is created", async () => {
    const missing = join(newConfigDir(), "absent");
    const installed = await opencodeInstall("install", missing);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(`opencode : absent (${missing}), rien installé\n`);
    const removed = await opencodeInstall("uninstall", missing);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toBe(`opencode : absent (${missing}), rien retiré\n`);
    expect(existsSync(missing)).toBe(false);
  });

  childTest("an empty config folder gets AGENTS.md created, and uninstall removes it again", async () => {
    const config = newConfigDir();
    expect((await opencodeInstall("install", config)).code).toBe(0);
    expect(existsSync(join(config, "AGENTS.md"))).toBe(true);
    expect((await opencodeInstall("uninstall", config)).code).toBe(0);
    expect(existsSync(join(config, "AGENTS.md"))).toBe(false);
  });

  childTest("the usage message of install lists the installable agents sorted, opencode included", async () => {
    const result = await cli(["install"], { IDNMA_OPENCODE_CONFIG_DIR: newConfigDir() });
    expect(result.code).toBe(2);
    const listed = /\(agents : ([^)]*)\)/.exec(result.stderr)?.[1]?.split(", ");
    expect(listed).toContain("opencode");
    expect(listed).toEqual([...listed!].sort());
  });
});
