import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import { authFrame, buildUserFrame } from "../src/bus/envelope.ts";
import { registerPeer } from "../src/bus/register.ts";
import { listLiveEntries } from "../src/bus/registry.ts";
import { writeFrames } from "../src/bus/send.ts";
import { main } from "../src/cli.ts";
import { ConfigError, loadAgentEngine, type Engine } from "../src/config/network.ts";
import type { CodexCourierOptions } from "../src/codex/courier.ts";
import type { DstCourierOptions } from "../src/dst/courier.ts";
import type { DstPluginState } from "../src/install/dst.ts";
import { controlDir, dstBridgeSocketPath } from "../src/paths.ts";
import type { HookedCourierOptions } from "../src/hooked/courier.ts";
import type { OpencodeCourierOptions } from "../src/opencode/courier.ts";
import { createOpencodeClient } from "../src/opencode/service.ts";
import type { Courier } from "../src/understudy/courier.ts";
import type { MessageQueue } from "../src/understudy/queue.ts";
import { parseRunArgs, UsageError } from "../src/run/args.ts";
import { assertOwnPane, tagPane, type PaneProbe } from "../src/run/pane.ts";
import { dstRefusal, dstWorkingDirectory, withDshBackend } from "../src/run/dst-argv.ts";
import { parseOpencodeArgv, stripOpencodeModel } from "../src/run/opencode-argv.ts";
import { buildHarnessArgv, isResume, runAgent, type RunDeps } from "../src/run/run.ts";
import { inferFromMode } from "../src/understudy/from-mode.ts";
import { startFakeOpencodeService, type FakeOpencodeService } from "./helpers/fake-opencode-service.ts";
import { startFakePeer, type FakePeer } from "./helpers/fake-peer.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "network.yml");
const ENV_KEYS = [
  "IDNMA_CONFIG_DIR",
  "IDNMA_CLAUDE_DIR",
  "IDNMA_SOCKETS_DIR",
  "IDNMA_CONTROL_DIR",
  "IDNMA_NAME",
  "IDNMA_CONTROL_SOCKET",
  "IDNMA_CONTROL_TOKEN",
  "OPENROUTER_API_KEY",
  "IDNMA_DSH_HOME",
  "DSH_HOME",
  "DSH_PERMISSION_MODE",
  "DSH_TUI_NO_LAUNCHPAD",
  "IDNMA_DST_BRIDGE",
  "IDNMA_DST_BRIDGE_TOKEN",
  "IDNMA_DST_PREFS_DIR",
] as const;

// Variables retirées avant chaque test : celles de la machine de l'utilisateur ne doivent ni fausser ni être lues par un test.
const CLEARED_ENV_KEYS = [
  "IDNMA_NAME",
  "IDNMA_CONTROL_SOCKET",
  "IDNMA_CONTROL_TOKEN",
  "OPENROUTER_API_KEY",
  "IDNMA_DSH_HOME",
  "DSH_HOME",
  "DSH_PERMISSION_MODE",
  "DSH_TUI_NO_LAUNCHPAD",
  "IDNMA_DST_BRIDGE",
  "IDNMA_DST_BRIDGE_TOKEN",
  "IDNMA_DST_PREFS_DIR",
] as const;

let previousEnv: Record<string, string | undefined>;
let tempDirs: string[];
let configDirectory: string;
let peers: FakePeer[];

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of CLEARED_ENV_KEYS) delete process.env[key];
  tempDirs = [mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-")];
  configDirectory = tempDirs[0]!;
  process.env.IDNMA_CONFIG_DIR = configDirectory;
  process.env.IDNMA_CLAUDE_DIR = tempDirs[1];
  process.env.IDNMA_SOCKETS_DIR = tempDirs[2];
  process.env.IDNMA_CONTROL_DIR = join(tempDirs[3]!, "ctl");
  // Jamais le vrai ~/.dsh-tui : le dernier mode de permission de dst se lit dans un dossier vide.
  process.env.IDNMA_DST_PREFS_DIR = join(tempDirs[3]!, "dst-prefs");
  copyFileSync(FIXTURE, join(configDirectory, ".idnma.yml"));
  peers = [];
});

afterEach(() => {
  for (const peer of peers) peer.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

class ExecSentinel extends Error {}

interface ExecCall {
  file: string;
  argv: string[];
  env: Record<string, string>;
}

const TTY = "/dev/ttys009";

function ownPaneProbe(extraEnv: Record<string, string | undefined> = {}): PaneProbe {
  return {
    env: { TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%7", ...extraEnv },
    stdinIsTTY: true,
    stdinTty: () => TTY,
    paneTty: () => TTY,
  };
}

/** Dépendances factices : tout binaire se résout, `execve` enregistre l'appel puis lève une sentinelle. */
function fakeDeps(overrides: Partial<RunDeps> = {}): { deps: Partial<RunDeps>; execCalls: ExecCall[]; tags: PaneTag[] } {
  const execCalls: ExecCall[] = [];
  const tags: PaneTag[] = [];
  const deps: Partial<RunDeps> = {
    probe: ownPaneProbe(),
    which: (bin) => `/fake/bin/${bin}`,
    execve: (file, argv, env) => {
      execCalls.push({ file, argv, env });
      throw new ExecSentinel("execve");
    },
    tmuxTarget: (paneId) => `sess:@1.${paneId}`,
    tagPane: (paneId, agentKey, name) => {
      // L'ordre compte : le marquage doit précéder l'execve (et `runUnderstudy`).
      tags.push({ paneId, agentKey, name, execCallsBefore: execCalls.length });
    },
    // Jamais le vrai service ni le vrai binaire : un test d'opencode doit brancher les siens.
    ensureOpencodeService: async () => {
      throw new Error("ensureOpencodeService is not stubbed");
    },
    opencodeClient: () => {
      throw new Error("opencodeClient is not stubbed");
    },
    createOpencodeCourier: () => countingCourier(),
    // Jamais le vrai dossier de dst : un test de refus branche son propre état.
    dstPluginState: () => ({ kind: "installed" }),
    createDstCourier: () => countingCourier(),
    ...overrides,
  };
  return { deps, execCalls, tags };
}

interface PaneTag {
  paneId: string;
  agentKey: string;
  name: string | undefined;
  execCallsBefore: number;
}

async function waitFor(condition: () => boolean, label: string, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function logLines(): Record<string, unknown>[] {
  const path = join(configDirectory, "logs", "idnma.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("parseRunArgs", () => {
  test("consumes --here wherever it is and takes the first positional as the agent", () => {
    expect(parseRunArgs(["--here", "agy"])).toEqual({ agent: "agy", passthrough: [] });
    expect(parseRunArgs(["agy", "--here"])).toEqual({ agent: "agy", passthrough: [] });
  });

  test("sends --model, --name, unknown tokens and everything after -- to the harness", () => {
    expect(parseRunArgs(["codex", "--model=x", "--name", "n", "--resume", "--", "-c", "y"])).toEqual({
      agent: "codex",
      passthrough: ["--model=x", "--name", "n", "--resume", "-c", "y"],
    });
  });

  test("reads --engine in both spellings", () => {
    expect(parseRunArgs(["--engine", "alt", "glm"])).toEqual({ agent: "glm", engine: "alt", passthrough: [] });
    expect(parseRunArgs(["glm", "--engine=alt", "--effort", "high"])).toEqual({ agent: "glm", engine: "alt", passthrough: ["--effort", "high"] });
  });

  test("does not read --here nor --engine after the separator", () => {
    expect(parseRunArgs(["codex", "--", "--here", "--engine", "x"])).toEqual({ agent: "codex", passthrough: ["--here", "--engine", "x"] });
  });

  test("rejects --engine without a value", () => {
    expect(() => parseRunArgs(["codex", "--engine"])).toThrow(UsageError);
    expect(() => parseRunArgs(["codex", "--engine="])).toThrow(UsageError);
  });
});

describe("isResume", () => {
  test("recognises every resume spelling and nothing else", () => {
    for (const flag of ["--resume", "-r", "--continue", "-c", "--resume=abc", "--from-pr", "--from-pr=123"]) expect(isResume(["x", flag])).toBe(true);
    expect(isResume(["--model", "opus"])).toBe(false);
  });
});

describe("buildHarnessArgv", () => {
  test("builds the claude argv: engine model and options, then the name idnma gives", () => {
    const { engine } = loadAgentEngine("claude");
    expect(buildHarnessArgv(engine, { name: "claude-vulcain-ab12", passthrough: [] })).toEqual([
      "claude",
      "--model",
      "opus",
      "--effort",
      "medium",
      "--dangerously-skip-permissions",
      "--remote-control",
      "--name",
      "claude-vulcain-ab12",
    ]);
  });

  test("builds the codex argv without model nor --name", () => {
    const { engine } = loadAgentEngine("codex");
    expect(buildHarnessArgv(engine, { passthrough: [] })).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  test("a typed flag replaces the engine's, value included, and the other engine options stay", () => {
    const engine: Engine = { harness: "agy", model: "gemini-4-argon", options: ["--effort", "low", "--dangerously-skip-permissions", "--remote-control"], env: {} };
    expect(buildHarnessArgv(engine, { passthrough: ["--model", "gemini-3.8-flash", "--effort", "high"] })).toEqual([
      "agy",
      "--dangerously-skip-permissions",
      "--remote-control",
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "high",
    ]);
  });

  test("--flag=value and the harness short alias count as the same flag", () => {
    const codex: Engine = { harness: "codex", model: "gpt-6-luna", options: ["--cd", "/a", "--dangerously-bypass-approvals-and-sandbox"], env: {} };
    expect(buildHarnessArgv(codex, { passthrough: ["-m", "gpt-x", "--cd=/b"] })).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-x", "--cd=/b"]);
    const grok: Engine = { harness: "grok", model: "grok-4.7", options: ["--effort=high", "--always-approve"], env: {} };
    expect(buildHarnessArgv(grok, { passthrough: ["--effort", "low"] })).toEqual(["grok", "--model", "grok-4.7", "--always-approve", "--effort", "low"]);
  });

  test("an attached short form counts as its flag", () => {
    const codex: Engine = { harness: "codex", model: "gpt-6-luna", options: [], env: {} };
    expect(buildHarnessArgv(codex, { passthrough: ["-mgpt-x"] })).toEqual(["codex", "-mgpt-x"]);
  });

  test("a typed --name, in any spelling, replaces the name idnma would give", () => {
    const { engine } = loadAgentEngine("claude");
    for (const typed of [["--name", "foo"], ["-n", "foo"], ["--name=foo"], ["-nfoo"]]) {
      const argv = buildHarnessArgv(engine, { name: "claude-vulcain-ab12", passthrough: typed });
      expect(argv).not.toContain("claude-vulcain-ab12");
      expect(argv.slice(-typed.length)).toEqual(typed);
    }
  });
});

describe("opencode harness", () => {
  test("buildHarnessArgv never injects --model, and keeps the typed passthrough", () => {
    const engine: Engine = { harness: "opencode", model: "opencode/big-pickle", options: ["--auto"], env: {} };
    expect(buildHarnessArgv(engine, { passthrough: ["-s", "ses_x"] })).toEqual(["opencode", "--auto", "-s", "ses_x"]);
  });

  test("a typed short alias replaces the engine's long flag", () => {
    const engine: Engine = { harness: "opencode", model: "opencode/big-pickle", options: ["--session", "ses_a", "--auto"], env: {} };
    expect(buildHarnessArgv(engine, { passthrough: ["-s", "ses_b"] })).toEqual(["opencode", "--auto", "-s", "ses_b"]);
    expect(buildHarnessArgv(engine, { passthrough: ["-c"] })).toEqual(["opencode", "--session", "ses_a", "--auto", "-c"]);
    expect(buildHarnessArgv({ ...engine, options: ["--model", "a/b"] }, { passthrough: ["-m", "c/d"] })).toEqual(["opencode", "-m", "c/d"]);
  });

  test("inferFromMode reads --auto as bypass", () => {
    expect(inferFromMode("opencode", ["--auto"])).toBe("bypass");
    expect(inferFromMode("opencode", [])).toBe("prompting");
  });
});

describe("assertOwnPane", () => {
  test("refuses outside tmux", () => {
    expect(() => assertOwnPane({ ...ownPaneProbe(), env: {} })).toThrow(/tmux/);
  });

  test("refuses from an already incarnated pane", () => {
    expect(() => assertOwnPane(ownPaneProbe({ IDNMA_NAME: "codex-vulcain" }))).toThrow(/ce pane a déjà son incarnation/);
  });

  test("refuses without a terminal on stdin", () => {
    expect(() => assertOwnPane({ ...ownPaneProbe(), stdinIsTTY: false })).toThrow(/terminal/);
  });

  test("refuses when tmux is unreachable", () => {
    const probe = ownPaneProbe();
    probe.paneTty = () => {
      throw new Error("no server");
    };
    expect(() => assertOwnPane(probe)).toThrow(/injoignable/);
  });

  test("refuses when the pane belongs to another terminal", () => {
    expect(() => assertOwnPane({ ...ownPaneProbe(), paneTty: () => "/dev/ttys042" })).toThrow(/n'est pas celui du pane/);
  });

  test("accepts the pane that owns the terminal", () => {
    expect(() => assertOwnPane(ownPaneProbe())).not.toThrow();
  });
});

describe("runAgent", () => {
  test("requires an agent", async () => {
    const { deps } = fakeDeps();
    await expect(runAgent({ passthrough: [] }, deps)).rejects.toThrow(/agent/);
  });

  test("fails on an unresolved $VAR before touching the pane or exec", async () => {
    let paneChecked = false;
    const probe = ownPaneProbe();
    probe.paneTty = () => {
      paneChecked = true;
      return TTY;
    };
    const { deps, execCalls } = fakeDeps({ probe });
    await expect(runAgent({ agent: "qwen", passthrough: [] }, deps)).rejects.toThrow("$OPENROUTER_API_KEY");
    expect(execCalls).toHaveLength(0);
    expect(paneChecked).toBe(false);
  });

  test("ignores a secrets.yml in the config dir: the variable must come from the environment", async () => {
    // Le fichier est écrit par stringify : jamais de ligne `CLÉ: valeur` tapée à la main.
    const secretsPath = join(configDirectory, "secrets.yml");
    writeFileSync(secretsPath, stringify({ env: { OPENROUTER_API_KEY: "valeur-temoin" } }));
    chmodSync(secretsPath, 0o600);
    delete process.env.OPENROUTER_API_KEY;
    const { deps, execCalls } = fakeDeps();
    let message = "";
    try {
      await runAgent({ agent: "qwen", passthrough: [] }, deps);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("$OPENROUTER_API_KEY");
    expect(message).not.toContain("valeur-temoin");
    expect(execCalls).toHaveLength(0);
  });

  test("names the missing binary", async () => {
    const { deps, execCalls } = fakeDeps({ which: () => null });
    await expect(runAgent({ agent: "codex", passthrough: [] }, deps)).rejects.toThrow("codex");
    expect(execCalls).toHaveLength(0);
  });

  test("refuses inside an incarnated pane before exec", async () => {
    const { deps, execCalls } = fakeDeps({ probe: ownPaneProbe({ IDNMA_NAME: "glm-vulcain" }) });
    await expect(runAgent({ agent: "glm", passthrough: [] }, deps)).rejects.toThrow(/déjà son incarnation/);
    expect(execCalls).toHaveLength(0);
  });

  test("execs claude harnesses with a fresh free name and the engine env", async () => {
    const { deps, execCalls } = fakeDeps();
    await expect(runAgent({ agent: "glm", passthrough: [] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
    expect(execCalls).toHaveLength(1);
    const call = execCalls[0]!;
    const name = call.env.IDNMA_NAME!;
    expect(name).toMatch(/^glm-[a-z]+-[a-z0-9]{4}$/);
    expect(listLiveEntries().map((entry) => entry.name)).not.toContain(name);
    expect(call.env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(call.file).toBe("/fake/bin/claude");
    expect(call.argv[0]).toBe("claude");
    expect(call.argv.slice(-2)).toEqual(["--name", name]);
    expect(call.argv).toContain("--model");
  });

  test("lets claude take a typed --model and --name in place of the engine model and the idnma name", async () => {
    const { deps, execCalls } = fakeDeps();
    await expect(runAgent({ agent: "claude", passthrough: ["--model", "sonnet", "--name", "claude-custom"] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
    const call = execCalls[0]!;
    expect(call.argv).toEqual(["claude", "--effort", "medium", "--dangerously-skip-permissions", "--remote-control", "--model", "sonnet", "--name", "claude-custom"]);
    expect(call.env.IDNMA_NAME).toBe("claude-custom");
  });

  test("a typed claude --name with a bad format is a usage error, before touching the pane", async () => {
    let paneChecked = false;
    const probe = ownPaneProbe();
    probe.paneTty = () => {
      paneChecked = true;
      return TTY;
    };
    const { deps, execCalls } = fakeDeps({ probe });
    for (const typed of [["--name", "a b"], ["--name=né"], ["-n", "-x"], ["--name", "a".repeat(65)], ["--name="]]) {
      const error = await runAgent({ agent: "claude", passthrough: typed }, deps).catch((caught: unknown) => caught);
      expect({ typed, error }).toEqual({ typed, error: expect.any(UsageError) });
      expect((error as Error).message).toStartWith("--name");
    }
    expect(execCalls).toHaveLength(0);
    expect(paneChecked).toBe(false);
  });

  test("a typed claude --name held by a live session is refused and names its pid", async () => {
    const holder = await startFakePeer("pris");
    peers.push(holder);
    const { deps, execCalls } = fakeDeps();
    const error = await runAgent({ agent: "claude", passthrough: ["--resume", "abc", "--name", "pris"] }, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(String(holder.entry.pid));
    expect(execCalls).toHaveLength(0);
  });

  test("a free typed claude --name of 64 characters is accepted, resume included", async () => {
    const name = "b".repeat(64);
    const { deps, execCalls } = fakeDeps();
    await expect(runAgent({ agent: "claude", passthrough: ["--resume", "abc", "--name", name] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
    expect(execCalls[0]!.env.IDNMA_NAME).toBe(name);
    expect(execCalls[0]!.argv.slice(-4)).toEqual(["--resume", "abc", "--name", name]);
  });

  test("IDNMA_NAME carries the typed claude name in every spelling", async () => {
    for (const typed of [["-n", "foo"], ["--name=foo"], ["-nfoo"], ["--name", "bar", "--name", "foo"]]) {
      const { deps, execCalls } = fakeDeps();
      await expect(runAgent({ agent: "claude", passthrough: typed }, deps)).rejects.toBeInstanceOf(ExecSentinel);
      expect({ typed, name: execCalls[0]!.env.IDNMA_NAME }).toEqual({ typed, name: "foo" });
    }
  });

  test("does not rename a resumed claude session", async () => {
    const { deps, execCalls } = fakeDeps();
    await expect(runAgent({ agent: "claude", passthrough: ["--resume", "abc"] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
    const call = execCalls[0]!;
    expect(call.argv).not.toContain("--name");
    expect(call.argv.slice(-2)).toEqual(["--resume", "abc"]);
    expect(call.env.IDNMA_NAME).toBe("claude");
  });

  test("does not rename a claude session resumed from a PR", async () => {
    const { deps, execCalls } = fakeDeps();
    await expect(runAgent({ agent: "claude", passthrough: ["--from-pr", "123"] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
    expect(execCalls[0]!.argv).not.toContain("--name");
    expect(execCalls[0]!.argv.slice(-2)).toEqual(["--from-pr", "123"]);
  });

  test("registers a foreign harness in the bus around the understudy and unregisters after", async () => {
    let seen: Parameters<RunDeps["runUnderstudy"]>[0] | undefined;
    let liveDuring: string[] = [];
    const { deps } = fakeDeps({
      runUnderstudy: async (o) => {
        seen = o;
        liveDuring = listLiveEntries().map((entry) => entry.name);
        o.registration?.unregister();
        return 7;
      },
    });
    const code = await runAgent({ agent: "codex", passthrough: [] }, deps);
    expect(code).toBe(7);
    expect(seen).toBeDefined();
    expect(seen!.fromMode).toBe("bypass");
    expect(seen!.name).toMatch(/^codex-[a-z]+-[a-z0-9]{4}$/);
    expect(seen!.registration?.entry.tmux).toBe("sess:@1.%7");
    expect(liveDuring).toContain(seen!.name);
    expect(seen!.argv).toEqual(["/fake/bin/codex", "--dangerously-bypass-approvals-and-sandbox"]);
    expect(listLiveEntries()).toHaveLength(0);
  });

  test("infers prompting when the foreign harness runs without its bypass flag", async () => {
    let seen: Parameters<RunDeps["runUnderstudy"]>[0] | undefined;
    const { deps } = fakeDeps({
      runUnderstudy: async (o) => {
        seen = o;
        o.registration?.unregister();
        return 0;
      },
    });
    await runAgent({ agent: "agy", passthrough: [] }, deps);
    expect(seen!.fromMode).toBe("prompting");
    expect(seen!.argv.slice(0, 3)).toEqual(["/fake/bin/agy", "--model", "gemini-4-argon-medium"]);
  });

  test("continues without registration when a live peer speaks another protocol", async () => {
    peers.push(await startFakePeer("other", { peerProtocol: 2 }));
    let seen: Parameters<RunDeps["runUnderstudy"]>[0] | undefined;
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { deps } = fakeDeps({
        runUnderstudy: async (o) => {
          seen = o;
          return 0;
        },
      });
      await runAgent({ agent: "codex", passthrough: [] }, deps);
      const warning = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(warning).toContain("protocole");
    } finally {
      stderr.mockRestore();
    }
    expect(seen!.registration).toBeNull();
  });

  test("logs queue-full and peer_message_status frames to idnma.log and writes nothing on stderr", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { deps } = fakeDeps({
        runUnderstudy: async (o) => {
          const registration = o.registration!;
          const queue: MessageQueue = o.queue;
          const frames = [
            authFrame(registration.peerToken),
            JSON.stringify({ type: "control", action: "ping" }),
            JSON.stringify({ type: "control", action: "peer_message_status", status: "held", reason: "r", from: "uds:/tmp/y.sock", orig_msg_id: "m-orig" }),
          ];
          for (let i = 0; i < 51; i++) frames.push(buildUserFrame({ msgId: `m${i}`, from: "uds:/tmp/x.sock", content: `hello ${i}` }));
          await writeFrames(registration.socketPath, frames);
          await waitFor(() => logLines().some((line) => line.event === "queue-full"), "queue-full line");
          expect(queue.size).toBe(50);
          registration.unregister();
          return 0;
        },
      });
      await runAgent({ agent: "codex", passthrough: [] }, deps);
      expect(stderr.mock.calls).toHaveLength(0);
      expect(consoleError.mock.calls).toHaveLength(0);
      expect(stdout.mock.calls).toHaveLength(0);
    } finally {
      stderr.mockRestore();
      consoleError.mockRestore();
      stdout.mockRestore();
    }
    const lines = logLines();
    const full = lines.filter((line) => line.event === "queue-full");
    expect(full).toHaveLength(1);
    expect(full[0]).toMatchObject({ msgId: "m50", from: "uds:/tmp/x.sock" });
    expect(typeof full[0]!.ts).toBe("string");
    expect(Number.isNaN(Date.parse(String(full[0]!.ts)))).toBe(false);
    // Spec §7.3 : seules les trames peer_message_status sont journalisées, réduites à status et orig_msg_id.
    expect(lines.filter((line) => line.event === "control")).toHaveLength(0);
    const statuses = lines.filter((line) => line.event === "peer_message_status");
    expect(statuses).toHaveLength(1);
    const { ts: _ts, ...status } = statuses[0]!;
    expect(status).toEqual({ event: "peer_message_status", status: "held", orig_msg_id: "m-orig" });
    expect(lines.every((line) => line.event === "queue-full" || line.event === "peer_message_status")).toBe(true);
  });

  test("codex refuses a typed flag that would start it without its shared server, before any effect", async () => {
    let runs = 0;
    const { deps } = fakeDeps({
      runUnderstudy: async () => {
        runs++;
        return 0;
      },
    });
    const cases: Array<[string[], string]> = [
      [["--config", "x=1"], "--config"],
      [["-c", "x=1"], "--config"],
      [["--config=x=1"], "--config"],
      [["-cx=1"], "--config"],
      [["--enable", "f"], "--enable"],
      [["--disable", "f"], "--disable"],
      [["--search"], "--search"],
      [["--profile", "p"], "--profile"],
      [["-p", "p"], "--profile"],
      [["--strict-config"], "--strict-config"],
      [["--dangerously-bypass-hook-trust"], "--dangerously-bypass-hook-trust"],
      [["--oss"], "--oss"],
      [["--no-daemon"], "--no-daemon"],
      [["--remote", "ws://h:1"], "--remote"],
    ];
    for (const [passthrough, flag] of cases) {
      const error = await runAgent({ agent: "codex", passthrough }, deps).catch((caught: unknown) => caught);
      expect({ passthrough, error }).toEqual({ passthrough, error: expect.any(UsageError) });
      expect((error as Error).message).toStartWith(`${flag} `);
      expect((error as Error).message).toContain("bus");
    }
    expect(runs).toBe(0);
    expect(listLiveEntries()).toHaveLength(0);
  });

  test("codex refuses an engine that would start it without its shared server, and names the engine", async () => {
    const { deps } = fakeDeps();
    const error = await runAgent({ agent: "codex", engine: "tuned", passthrough: [] }, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("agents.codex.engines.tuned");
    expect((error as Error).message).toContain("--config");
  });

  test("codex receives a single --model when one is typed over the engine model", async () => {
    let seen: Parameters<RunDeps["runUnderstudy"]>[0] | undefined;
    const { deps } = fakeDeps({
      createCodexCourier: () => countingCourier(),
      runUnderstudy: async (o) => {
        seen = o;
        o.registration?.unregister();
        return 0;
      },
    });
    await runAgent({ agent: "codex", engine: "luna", passthrough: ["--model", "gpt-x"] }, deps);
    expect(seen!.argv).toEqual(["/fake/bin/codex", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-x"]);
  });
});

/** Livreur factice : compte les appels de `onMessage`. */
function countingCourier(): Courier & { messages: number } {
  const courier = {
    messages: 0,
    beforeSpawn: async () => {},
    afterSpawn: () => {},
    onMessage: () => {
      courier.messages++;
    },
    read: () => null,
    hook: async () => ({}),
    verifyCaller: async () => false,
    stop: () => {},
  };
  return courier;
}

describe("runAgent pane options for IdemA", () => {
  test("claude: tags the pane with the agent key and the idnma name, before execve", async () => {
    const { deps, execCalls, tags } = fakeDeps();
    await expect(runAgent({ agent: "glm", passthrough: [] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
    expect(tags).toEqual([{ paneId: "%7", agentKey: "glm", name: execCalls[0]!.env.IDNMA_NAME, execCallsBefore: 0 }]);
    expect(tags[0]!.name).toMatch(/^glm-[a-z]+-[a-z0-9]{4}$/);
  });

  test("claude: a typed --name is the tagged name", async () => {
    const { deps, tags } = fakeDeps();
    await expect(runAgent({ agent: "claude", passthrough: ["--name", "claude-custom"] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
    expect(tags).toEqual([{ paneId: "%7", agentKey: "claude", name: "claude-custom", execCallsBefore: 0 }]);
  });

  test("claude resumed without --name: the name is cleared, never the agent key", async () => {
    const { deps, tags } = fakeDeps();
    await expect(runAgent({ agent: "claude", passthrough: ["--resume", "abc"] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
    expect(tags).toEqual([{ paneId: "%7", agentKey: "claude", name: undefined, execCallsBefore: 0 }]);
  });

  test("understudy: tags the pane with the agent key and the bus name, before runUnderstudy", async () => {
    let tagsAtStart = -1;
    let seenName = "";
    const fake = fakeDeps({
      runUnderstudy: async (o) => {
        tagsAtStart = fake.tags.length;
        seenName = o.name;
        o.registration?.unregister();
        return 0;
      },
    });
    expect(await runAgent({ agent: "codex", passthrough: [] }, fake.deps)).toBe(0);
    expect(tagsAtStart).toBe(1);
    expect(fake.tags).toEqual([{ paneId: "%7", agentKey: "codex", name: seenName, execCallsBefore: 0 }]);
  });

  test("a refused launch tags nothing", async () => {
    for (const [agent, overrides] of [
      ["glm", { probe: ownPaneProbe({ IDNMA_NAME: "glm-vulcain" }) }],
      ["codex", { which: () => null }],
      ["qwen", {}],
    ] as const) {
      delete process.env.OPENROUTER_API_KEY;
      const { deps, tags } = fakeDeps(overrides);
      await expect(runAgent({ agent, passthrough: [] }, deps)).rejects.toThrow();
      expect({ agent, tags }).toEqual({ agent, tags: [] });
    }
    const { deps, tags } = fakeDeps();
    await expect(runAgent({ agent: "claude", passthrough: ["--name", "a b"] }, deps)).rejects.toBeInstanceOf(UsageError);
    expect(tags).toEqual([]);
  });

  test("a failing tag is logged and the agent still starts", async () => {
    const { deps, execCalls } = fakeDeps({
      tagPane: () => {
        throw new Error("tmux injoignable");
      },
    });
    await expect(runAgent({ agent: "glm", passthrough: [] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
    expect(execCalls).toHaveLength(1);
    expect(logLines()).toContainEqual(expect.objectContaining({ event: "pane-tag-failed", pane: "%7", message: "tmux injoignable" }));
  });
});

describe("tagPane on a real tmux server", () => {
  // Serveur tmux isolé (`-L`) : jamais celui de l'utilisateur.
  const socket = `idnma-tag-${process.pid}`;
  const tmux = (...args: string[]): string => Bun.spawnSync(["tmux", "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const previousTmux = process.env.TMUX;
  let pane = "";
  let socketPath = "";

  beforeEach(() => {
    tmux("new-session", "-d", "-s", "t");
    pane = tmux("display-message", "-p", "-t", "t", "#{pane_id}");
    socketPath = tmux("display-message", "-p", "#{socket_path}");
    // `tmux` sans `-L` suit $TMUX : on le pointe sur le serveur isolé.
    process.env.TMUX = `${socketPath},0,0`;
  });

  afterEach(() => {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    tmux("kill-server");
    // `kill-server` laisse le fichier du socket derrière lui.
    rmSync(socketPath, { force: true });
  });

  test("sets @idnma_agent and @idnma_name, and a later resume clears the stale name", () => {
    tagPane(pane, "glm", "glm-venus-ab12");
    expect(tmux("show-options", "-p", "-t", pane, "@idnma_agent")).toBe("@idnma_agent glm");
    expect(tmux("show-options", "-p", "-t", pane, "@idnma_name")).toBe("@idnma_name glm-venus-ab12");
    tagPane(pane, "claude", undefined);
    expect(tmux("show-options", "-p", "-t", pane, "@idnma_agent")).toBe("@idnma_agent claude");
    expect(tmux("show-options", "-p", "-t", pane, "@idnma_name")).toBe("");
  });
});

describe("runAgent with a Codex courier", () => {
  test("runAgent wires a Codex courier", async () => {
    const courier = countingCourier();
    const created: CodexCourierOptions[] = [];
    let seen: Parameters<RunDeps["runUnderstudy"]>[0] | undefined;
    let deliveredBeforeFrame = -1;
    const { deps } = fakeDeps({
      createCodexCourier: (o) => {
        created.push(o);
        return courier;
      },
      runUnderstudy: async (o) => {
        seen = o;
        const registration = o.registration!;
        deliveredBeforeFrame = courier.messages;
        await writeFrames(registration.socketPath, [authFrame(registration.peerToken), buildUserFrame({ msgId: "m1", from: "uds:/tmp/x.sock", content: "salut" })]);
        await waitFor(() => courier.messages === 1, "courier.onMessage call");
        expect(o.queue.size).toBe(1);
        registration.unregister();
        return 0;
      },
    });
    expect(await runAgent({ agent: "codex", passthrough: [] }, deps)).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe(seen!.name);
    expect(created[0]!.fromMode).toBe("bypass");
    expect(created[0]!.cwd).toBe(process.cwd());
    expect(created[0]!.registration).toBe(seen!.registration!);
    expect(created[0]!.queue).toBe(seen!.queue);
    expect(seen!.courier).toBe(courier);
    expect(deliveredBeforeFrame).toBe(0);
    expect(courier.messages).toBe(1);
  });

  test("runAgent passes the Codex working directory", async () => {
    const previousCwd = process.cwd();
    process.chdir(tempDirs[0]!);
    try {
      mkdirSync("sub");
      const root = process.cwd();
      const cases: Array<[string[], string]> = [
        [["-C", "sub"], join(root, "sub")],
        [["--cd=sub"], join(root, "sub")],
        [["--cd", "sub"], join(root, "sub")],
        [["-C", "other", "--cd=sub"], join(root, "sub")],
        [["-C", join(root, "sub")], join(root, "sub")],
        [["--model", "x"], root],
        [["-C"], root],
      ];
      for (const [passthrough, expected] of cases) {
        const cwds: string[] = [];
        const registeredCwds: string[] = [];
        const { deps } = fakeDeps({
          createCodexCourier: (o) => {
            cwds.push(o.cwd);
            return countingCourier();
          },
          runUnderstudy: async (o) => {
            // Le registre de Claude montre où Codex travaille, pas d'où `idnma run` a été lancé.
            registeredCwds.push(o.registration!.entry.cwd);
            o.registration?.unregister();
            return 0;
          },
        });
        await runAgent({ agent: "codex", passthrough }, deps);
        expect({ passthrough, cwds, registeredCwds }).toEqual({ passthrough, cwds: [expected], registeredCwds: [expected] });
      }
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("runAgent keeps the control channel away from a Codex child, and only from it", async () => {
    const exported: Record<string, boolean | undefined> = {};
    for (const agent of ["codex", "grok", "agy"]) {
      const { deps } = fakeDeps({
        createCodexCourier: () => countingCourier(),
        createHookedCourier: () => countingCourier(),
        runUnderstudy: async (o) => {
          exported[agent] = o.exportControlEnv;
          o.registration?.unregister();
          return 0;
        },
      });
      await runAgent({ agent, passthrough: [] }, deps);
    }
    expect(exported.codex).toBe(false);
    expect(exported.grok).toBeUndefined();
    expect(exported.agy).toBeUndefined();
  });

  for (const [agent, label] of [
    ["grok", "Grok"],
    ["agy", "agy"],
  ] as const) {
    test(`${agent} runs under a PTY with a hooked courier`, async () => {
      const created: HookedCourierOptions[] = [];
      let codexCouriers = 0;
      let seen: Parameters<RunDeps["runUnderstudy"]>[0] | undefined;
      const courier = countingCourier();
      const { deps } = fakeDeps({
        createCodexCourier: () => {
          codexCouriers++;
          return countingCourier();
        },
        createHookedCourier: (o) => {
          created.push(o);
          return courier;
        },
        runUnderstudy: async (o) => {
          seen = o;
          o.registration?.unregister();
          return 0;
        },
      });
      await runAgent({ agent, passthrough: [] }, deps);
      expect(codexCouriers).toBe(0);
      expect(created).toHaveLength(1);
      expect(created[0]!.adapter.harness).toBe(agent);
      expect(created[0]!.name).toBe(seen!.name);
      expect(created[0]!.registration).toBe(seen!.registration!);
      expect(created[0]!.queue).toBe(seen!.queue);
      expect(typeof created[0]!.preflight).toBe("function");
      expect(seen!.courier).toBe(courier);
      expect(seen!.pty).toBe(true);
      expect(seen!.harnessLabel).toBe(label);
      expect("exportControlEnv" in seen!).toBe(false);
    });
  }

  test("the hooked courier preflight reads the launch env and argv", async () => {
    const grokDirectory = tempDirs[0]!;
    const previous = process.env.GROK_HOME;
    process.env.GROK_HOME = grokDirectory;
    try {
      let preflight: (() => string | undefined) | undefined;
      const { deps } = fakeDeps({
        createHookedCourier: (o) => {
          preflight = o.preflight;
          return countingCourier();
        },
        runUnderstudy: async (o) => {
          o.registration?.unregister();
          return 0;
        },
      });
      await runAgent({ agent: "grok", passthrough: ["--leader"] }, deps);
      expect(preflight?.()).toStartWith("hooks idnma absents de Grok");
      mkdirSync(join(grokDirectory, "hooks"), { recursive: true });
      writeFileSync(join(grokDirectory, "hooks", "idnma.json"), "{}");
      expect(preflight?.()).toBe("mode leader de Grok demandé (--leader) : ses commandes ne descendraient plus de la doublure");
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previous;
    }
  });

  test("codex keeps its courier and no PTY", async () => {
    let hookedCouriers = 0;
    let seen: Parameters<RunDeps["runUnderstudy"]>[0] | undefined;
    const courier = countingCourier();
    const { deps } = fakeDeps({
      createCodexCourier: () => courier,
      createHookedCourier: () => {
        hookedCouriers++;
        return countingCourier();
      },
      runUnderstudy: async (o) => {
        seen = o;
        o.registration?.unregister();
        return 0;
      },
    });
    await runAgent({ agent: "codex", passthrough: [] }, deps);
    expect(hookedCouriers).toBe(0);
    expect(seen!.courier).toBe(courier);
    expect("pty" in seen!).toBe(false);
    expect("harnessLabel" in seen!).toBe(false);
  });

  test("runAgent codex without registration has no courier", async () => {
    peers.push(await startFakePeer("other", { peerProtocol: 2 }));
    let created = 0;
    let seen: Parameters<RunDeps["runUnderstudy"]>[0] | undefined;
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { deps } = fakeDeps({
        createCodexCourier: () => {
          created++;
          return countingCourier();
        },
        runUnderstudy: async (o) => {
          seen = o;
          return 0;
        },
      });
      await runAgent({ agent: "codex", passthrough: [] }, deps);
    } finally {
      stderr.mockRestore();
    }
    expect(created).toBe(0);
    expect(seen!.courier).toBeUndefined();
  });
});

describe("runAgent grok without registration", () => {
  test("runs under a PTY without a courier", async () => {
    peers.push(await startFakePeer("other", { peerProtocol: 2 }));
    let created = 0;
    let seen: Parameters<RunDeps["runUnderstudy"]>[0] | undefined;
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { deps } = fakeDeps({
        createHookedCourier: () => {
          created++;
          return countingCourier();
        },
        runUnderstudy: async (o) => {
          seen = o;
          return 0;
        },
      });
      await runAgent({ agent: "grok", passthrough: [] }, deps);
    } finally {
      stderr.mockRestore();
    }
    expect(created).toBe(0);
    expect(seen!.courier).toBeUndefined();
    expect(seen!.pty).toBe(true);
  });
});

describe("registerPeer onError", () => {
  test("hands a throwing callback to onError instead of stderr", async () => {
    const errors: unknown[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const registration = await registerPeer({
      name: "thrower",
      cwd: "/w",
      onMessage: () => {
        throw new Error("boom");
      },
      onError: (error) => errors.push(error),
    });
    try {
      await writeFrames(registration.socketPath, [authFrame(registration.peerToken), buildUserFrame({ msgId: "e1", from: "uds:/tmp/x.sock", content: "hi" })]);
      await waitFor(() => errors.length === 1, "onError call");
      expect((errors[0] as Error).message).toBe("boom");
      expect(stderr.mock.calls).toHaveLength(0);
      expect(consoleError.mock.calls).toHaveLength(0);
    } finally {
      registration.unregister();
      stderr.mockRestore();
      consoleError.mockRestore();
    }
  });
});

describe("idnma run command", () => {
  test("exits 2 on --engine without a value, and on a claude --name with a bad format", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["run", "codex", "--engine"])).toBe(2);
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("--engine");
      expect(await main(["run", "claude", "--name", "a.b"])).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });

  test("exits 2 on a codex flag that would take it off the bus, 1 on such an engine", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["run", "codex", "--search"])).toBe(2);
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("--search");
      stderr.mockClear();
      expect(await main(["run", "codex", "--engine", "tuned"])).toBe(1);
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("agents.codex.engines.tuned");
    } finally {
      stderr.mockRestore();
    }
  });

  test("exits 2 without an agent and lists the agents of .idnma.yml with its path", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["run", "--here"])).toBe(2);
      const output = stderr.mock.calls.map((call) => String(call[0])).join("");
      const listed = /Agents : ([^(\n]*)/.exec(output)?.[1]?.trim().split(", ");
      expect(listed).toContain("opencode");
      expect(listed).toEqual([...listed!].sort());
      expect(output).toContain(join(configDirectory, ".idnma.yml"));
    } finally {
      stderr.mockRestore();
    }
  });

  test("prints the help on stdout, even after --here, with the only idnma option", async () => {
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      for (const args of [["--help"], ["--here", "-h"]]) {
        stdout.mockClear();
        expect(await main(["run", ...args])).toBe(0);
        const help = stdout.mock.calls.map((call) => String(call[0])).join("");
        expect(help).toContain("--engine");
        expect(help).toContain("agy, claude, codex");
        expect(help).not.toContain("--model <");
        expect(help).not.toContain("--name <");
      }
    } finally {
      stdout.mockRestore();
    }
  });

  test("the help says why the agents are missing: no file, a broken file, an empty section", async () => {
    const path = join(configDirectory, ".idnma.yml");
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const helpFor = async (content: string | undefined): Promise<string> => {
      if (content === undefined) rmSync(path, { force: true });
      else writeFileSync(path, content);
      stdout.mockClear();
      expect(await main(["run", "--help"])).toBe(0);
      return stdout.mock.calls.map((call) => String(call[0])).join("");
    };
    try {
      expect(await helpFor(undefined)).toContain(`introuvable : ${path}`);
      expect(await helpFor("agents: [\n")).toContain(`invalide (${path})`);
      expect(await helpFor("agents: {}\n")).toContain(`Agents : aucun (${path})`);
    } finally {
      stdout.mockRestore();
    }
  });

  test("fails with a French message and exit 1 outside tmux", async () => {
    mkdirSync(join(configDirectory, "logs"), { recursive: true });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "TMUX" && key !== "TMUX_PANE") env[key] = value;
    }
    const child = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "run", "--here", "codex"], { env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(1);
    // Un seul préfixe : le message du refus nomme déjà « idnma run ».
    expect(child.stderr.toString()).toBe("idnma run se lance depuis un pane tmux.\n");
  });
});

describe("parseOpencodeArgv", () => {
  test("takes the first token that is neither a flag nor a flag value as the directory", () => {
    expect(parseOpencodeArgv(["--auto", "proj", "--wizard"])).toEqual({ rest: ["--auto", "--wizard"], resume: false, directory: "proj" });
    expect(parseOpencodeArgv(["--prompt", "-s x", "proj"])).toEqual({ rest: ["--prompt", "-s x"], resume: false, directory: "proj" });
    expect(parseOpencodeArgv(["--log-level", "DEBUG", "--prompt=hello"])).toEqual({ rest: ["--log-level", "DEBUG", "--prompt=hello"], resume: false });
  });

  test("reads -s, -c and -m in every spelling and removes them with their values", () => {
    expect(parseOpencodeArgv(["-s", "ses_a", "-c", "--auto"])).toEqual({ rest: ["--auto"], resume: true, session: "ses_a" });
    expect(parseOpencodeArgv(["-sses_b"])).toEqual({ rest: [], resume: false, session: "ses_b" });
    expect(parseOpencodeArgv(["--session=ses_c"]).session).toBe("ses_c");
    expect(parseOpencodeArgv(["-m", "a/b", "--model=c/d"]).model).toBe("c/d");
    expect(parseOpencodeArgv(["-ma/b"]).model).toBe("a/b");
    expect(parseOpencodeArgv(["--continue"]).resume).toBe(true);
    expect(parseOpencodeArgv(["-s"]).session).toBe("");
  });

  test("names the flags that take opencode out of its shared service", () => {
    expect(parseOpencodeArgv(["--standalone"]).refused).toBe("--standalone");
    expect(parseOpencodeArgv(["--server", "http://x"]).refused).toBe("--server");
    expect(parseOpencodeArgv(["--server=http://x"]).refused).toBe("--server");
    expect(parseOpencodeArgv(["--prompt", "--standalone"]).refused).toBeUndefined();
    expect(parseOpencodeArgv(["--auto"]).refused).toBeUndefined();
  });

  test("stripOpencodeModel removes only the model flag and its value", () => {
    expect(stripOpencodeModel(["-s", "ses_a", "-m", "a/b", "--auto", "proj", "--model=c/d", "-ma/b"])).toEqual(["-s", "ses_a", "--auto", "proj"]);
  });
});

describe("runAgent opencode", () => {
  let service: FakeOpencodeService;
  const models = [
    { providerID: "opencode", id: "big-pickle" },
    { providerID: "openrouter", id: "particle-ai/particle-1", variants: [{ id: "high" }, { id: "low" }] },
    { providerID: "ollama-cloud", id: "deepseek-v4.1-flash" },
  ];

  beforeEach(() => {
    service = startFakeOpencodeService();
    service.handle("GET", "/api/model", () => ({ status: 200, body: { data: models } }));
    // Comme le vrai service : l'id tapé est repris, sinon il en génère un.
    service.handle("POST", "/api/session", (req) => ({ status: 200, body: { data: { id: (req.body as { id?: string }).id ?? "ses_created" } } }));
    service.handle("GET", "/api/session/ses_known", () => ({ status: 200, body: { data: { id: "ses_known" } } }));
    service.handle("POST", "/api/session/ses_known/model", () => ({ status: 204 }));
    service.handle("POST", "/api/session/ses_a/model", () => ({ status: 204 }));
  });

  afterEach(() => {
    service.stop();
  });

  const serviceRequests = (): string[] => service.requests.map((r) => `${r.method} ${r.path}`);
  const sessionCreations = () => service.requests.filter((r) => r.method === "POST" && r.path === "/api/session");

  /** Dépendances : le faux service derrière la découverte, `runUnderstudy` et le livreur enregistrent leurs options. */
  function opencodeDeps(overrides: Partial<RunDeps> = {}) {
    const understudy: Array<Parameters<RunDeps["runUnderstudy"]>[0]> = [];
    const couriers: OpencodeCourierOptions[] = [];
    const base = fakeDeps({
      ensureOpencodeService: async () => ({ url: service.url, pid: process.pid, password: service.password }),
      opencodeClient: (info) => createOpencodeClient(info),
      createOpencodeCourier: (o) => {
        couriers.push(o);
        return countingCourier();
      },
      runUnderstudy: async (o) => {
        understudy.push(o);
        o.registration?.unregister();
        return 0;
      },
      ...overrides,
    });
    return { ...base, understudy, couriers };
  }

  test("default engine: creates a session with the engine model and hands the TUI and the courier to runUnderstudy", async () => {
    const { deps, understudy, couriers, tags } = opencodeDeps();
    expect(await runAgent({ agent: "opencode", passthrough: [] }, deps)).toBe(0);

    expect(sessionCreations()).toHaveLength(1);
    expect(sessionCreations()[0]!.body).toEqual({ location: { directory: process.cwd() }, model: { providerID: "opencode", id: "big-pickle" } });
    expect(understudy).toHaveLength(1);
    const seen = understudy[0]!;
    expect(seen.argv).toEqual(["/fake/bin/opencode", "-s", "ses_created"]);
    expect(seen.exportControlEnv).not.toBe(false);
    expect(seen.pty).toBeUndefined();
    expect(seen.harnessLabel).toBe("opencode");
    expect(couriers).toHaveLength(1);
    expect(couriers[0]!.sessionID).toBe("ses_created");
    expect(couriers[0]!.fromMode).toBe("prompting");
    expect(couriers[0]!.registration).toBe(seen.registration!);
    expect(couriers[0]!.queue).toBe(seen.queue);
    expect(seen.name).toMatch(/^opencode-[a-z]+-[a-z0-9]{4}$/);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.name).toBe(seen.name);
    expect(logLines().filter((l) => l.event === "opencode-session")).toEqual([
      expect.objectContaining({ event: "opencode-session", sessionID: "ses_created", origin: "created" }),
    ]);
  });

  test("auto engine: bypass mode and a single --auto even when it is typed too", async () => {
    const { deps, understudy, couriers } = opencodeDeps();
    await runAgent({ agent: "opencode", engine: "auto", passthrough: ["--auto"] }, deps);
    expect(couriers[0]!.fromMode).toBe("bypass");
    expect(understudy[0]!.argv.filter((token) => token === "--auto")).toHaveLength(1);
    expect(sessionCreations()[0]!.body).toEqual({ location: { directory: process.cwd() }, model: { providerID: "ollama-cloud", id: "deepseek-v4.1-flash" } });
  });

  test("an engine without model creates a session without a model key", async () => {
    const { deps } = opencodeDeps();
    await runAgent({ agent: "opencode", engine: "bare", passthrough: [] }, deps);
    expect(sessionCreations()[0]!.body).toEqual({ location: { directory: process.cwd() } });
    expect(serviceRequests()).not.toContain("GET /api/model");
  });

  test("a typed -m replaces the engine model, leaves the TUI argv and keeps the variant", async () => {
    const { deps, understudy } = opencodeDeps();
    await runAgent({ agent: "opencode", passthrough: ["-m", "openrouter/particle-ai/particle-1#high"] }, deps);
    expect(sessionCreations()[0]!.body).toEqual({
      location: { directory: process.cwd() },
      model: { providerID: "openrouter", id: "particle-ai/particle-1", variant: "high" },
    });
    expect(understudy[0]!.argv).toEqual(["/fake/bin/opencode", "-s", "ses_created"]);
  });

  test("an unknown model is a usage error: no session created, nothing registered, no TUI (AC-13)", async () => {
    const { deps, understudy } = opencodeDeps();
    await expect(runAgent({ agent: "opencode", passthrough: ["-m", "opencode/nope"] }, deps)).rejects.toMatchObject({
      name: "UsageError",
      message: "modèle inconnu du service opencode : opencode/nope",
    });
    expect(sessionCreations()).toHaveLength(0);
    expect(listLiveEntries()).toHaveLength(0);
    expect(understudy).toHaveLength(0);
    // Une variante absente de la liste du modèle est refusée comme un modèle inconnu.
    await expect(runAgent({ agent: "opencode", passthrough: ["-m", "openrouter/particle-ai/particle-1#nope"] }, deps)).rejects.toBeInstanceOf(UsageError);
    expect(sessionCreations()).toHaveLength(0);
  });

  test("an engine model unknown to the service is refused the same way", async () => {
    service.handle("GET", "/api/model", () => ({ status: 200, body: { data: [] } }));
    const { deps } = opencodeDeps();
    await expect(runAgent({ agent: "opencode", passthrough: [] }, deps)).rejects.toThrow("modèle inconnu du service opencode : opencode/big-pickle");
    expect(sessionCreations()).toHaveLength(0);
  });

  test("the model list is read from the working directory", async () => {
    const { deps } = opencodeDeps();
    await runAgent({ agent: "opencode", passthrough: [tempDirs[1]!] }, deps);
    const listing = service.requests.find((r) => r.path === "/api/model")!;
    expect(listing.query.get("location[directory]")).toBe(tempDirs[1]!);
  });

  test("a model without provider/model shape is a usage error and asks the service nothing", async () => {
    const { deps } = opencodeDeps();
    await expect(runAgent({ agent: "opencode", passthrough: ["-m", "nope"] }, deps)).rejects.toMatchObject({
      name: "UsageError",
      message: "--model : « nope » n'a pas la forme <fournisseur>/<modèle>.",
    });
    expect(service.requests).toHaveLength(0);
  });

  test("a malformed model in .idnma.yml is a configuration error naming the engine; a typed -m stays a usage error", async () => {
    const path = join(configDirectory, ".idnma.yml");
    writeFileSync(path, readFileSync(path, "utf8").replace("      bare:\n        harness: opencode\n", "      bare:\n        harness: opencode\n      malformed:\n        harness: opencode\n        model: nope\n"));
    const { deps } = opencodeDeps();
    const fromEngine = runAgent({ agent: "opencode", engine: "malformed", passthrough: [] }, deps);
    await expect(fromEngine).rejects.toMatchObject({ name: "ConfigError" });
    await expect(fromEngine).rejects.toThrow(".idnma.yml (agents.opencode.engines.malformed)");
    await expect(fromEngine).rejects.not.toThrow("--model");
    // Un `-m` tapé sur le même engine garde l'erreur d'usage, et c'est lui qui est lu.
    await expect(runAgent({ agent: "opencode", engine: "malformed", passthrough: ["-m", "nope"] }, deps)).rejects.toMatchObject({
      name: "UsageError",
      message: "--model : « nope » n'a pas la forme <fournisseur>/<modèle>.",
    });
    expect(service.requests).toHaveLength(0);
  });

  test("-s must look like an opencode session id, without asking the service", async () => {
    const { deps } = opencodeDeps();
    await expect(runAgent({ agent: "opencode", passthrough: ["-s", "abc"] }, deps)).rejects.toMatchObject({
      name: "UsageError",
      message: "-s : un id de session opencode commence par ses.",
    });
    expect(service.requests).toHaveLength(0);
    expect(listLiveEntries()).toHaveLength(0);
  });

  test("--standalone typed and --server in an engine are refused before any request (AC-8)", async () => {
    const { deps, understudy, execCalls } = opencodeDeps();
    await expect(runAgent({ agent: "opencode", passthrough: ["--standalone"] }, deps)).rejects.toMatchObject({
      name: "UsageError",
      message: "--standalone fait démarrer opencode hors de son service partagé : idnma ne pourrait plus lui livrer les messages du bus.",
    });
    await expect(runAgent({ agent: "opencode", engine: "server", passthrough: [] }, deps)).rejects.toMatchObject({
      name: "ConfigError",
      message: ".idnma.yml (agents.opencode.engines.server) : --server fait démarrer opencode hors de son service partagé : idnma ne pourrait plus lui livrer les messages du bus.",
    });
    await expect(runAgent({ agent: "opencode", passthrough: ["--server=http://x"] }, deps)).rejects.toBeInstanceOf(UsageError);
    expect(service.requests).toHaveLength(0);
    expect(listLiveEntries()).toHaveLength(0);
    expect(understudy).toHaveLength(0);
    expect(execCalls).toHaveLength(0);
  });

  test("-s on a known session reuses it: no creation, and a typed -m switches its model", async () => {
    const { deps, understudy, couriers } = opencodeDeps();
    await runAgent({ agent: "opencode", passthrough: ["-s", "ses_known"] }, deps);
    expect(sessionCreations()).toHaveLength(0);
    expect(serviceRequests()).not.toContain("POST /api/session/ses_known/model");
    expect(understudy[0]!.argv).toEqual(["/fake/bin/opencode", "-s", "ses_known"]);
    expect(couriers[0]!.sessionID).toBe("ses_known");
    expect(logLines().filter((l) => l.event === "opencode-session")).toEqual([
      expect.objectContaining({ sessionID: "ses_known", origin: "typed" }),
    ]);

    service.requests.length = 0;
    await runAgent({ agent: "opencode", passthrough: ["-s", "ses_known", "-m", "opencode/big-pickle"] }, deps);
    expect(sessionCreations()).toHaveLength(0);
    const switched = service.requests.find((r) => r.path === "/api/session/ses_known/model");
    expect(switched?.body).toEqual({ model: { providerID: "opencode", id: "big-pickle" } });
  });

  test("-s on an unknown session creates it under that id", async () => {
    const { deps, understudy } = opencodeDeps();
    await runAgent({ agent: "opencode", passthrough: ["-s", "ses_new"] }, deps);
    expect(sessionCreations()).toHaveLength(1);
    expect(sessionCreations()[0]!.body).toEqual({
      id: "ses_new",
      location: { directory: process.cwd() },
      model: { providerID: "opencode", id: "big-pickle" },
    });
    expect(understudy[0]!.argv).toEqual(["/fake/bin/opencode", "-s", "ses_new"]);
  });

  test("-c continues the most recent session without a parent and is removed from the argv", async () => {
    service.handle("GET", "/api/session", () => ({ status: 200, body: { data: [{ id: "ses_child", parentID: "ses_a" }, { id: "ses_a" }] } }));
    const { deps, understudy } = opencodeDeps();
    await runAgent({ agent: "opencode", passthrough: ["-c", "--auto"] }, deps);
    const listing = service.requests.find((r) => r.method === "GET" && r.path === "/api/session")!;
    expect(listing.query.get("directory")).toBe(process.cwd());
    expect(listing.query.get("order")).toBe("desc");
    expect(sessionCreations()).toHaveLength(0);
    expect(understudy[0]!.argv).toEqual(["/fake/bin/opencode", "-s", "ses_a", "--auto"]);
    expect(logLines().filter((l) => l.event === "opencode-session")).toEqual([expect.objectContaining({ sessionID: "ses_a", origin: "continued" })]);
  });

  test("-c with no session to continue creates a new one", async () => {
    service.handle("GET", "/api/session", () => ({ status: 200, body: { data: [] } }));
    const { deps, understudy } = opencodeDeps();
    await runAgent({ agent: "opencode", passthrough: ["-c"] }, deps);
    expect(sessionCreations()).toHaveLength(1);
    expect(understudy[0]!.argv).toEqual(["/fake/bin/opencode", "-s", "ses_created"]);
  });

  test("a directory argument is the working directory; a flag value that looks like a flag is not", async () => {
    const { deps, understudy } = opencodeDeps();
    await runAgent({ agent: "opencode", passthrough: ["--prompt", "-s x", tempDirs[1]!] }, deps);
    expect(sessionCreations()[0]!.body).toMatchObject({ location: { directory: tempDirs[1]! } });
    // Le positionnel reste dans l'argv de la TUI (spec §6 point 7) : seuls `-s` et `-c` sont remplacés.
    expect(understudy[0]!.argv).toEqual(["/fake/bin/opencode", "-s", "ses_created", tempDirs[1]!, "--prompt", "-s x"]);
    expect(listLiveEntries()).toHaveLength(0);
  });

  test("the registry entry carries the working directory", async () => {
    let registeredCwd: string | undefined;
    const { deps } = opencodeDeps({
      runUnderstudy: async (o) => {
        registeredCwd = listLiveEntries().find((entry) => entry.pid === process.pid)?.cwd;
        o.registration?.unregister();
        return 0;
      },
    });
    await runAgent({ agent: "opencode", passthrough: [tempDirs[1]!] }, deps);
    expect(registeredCwd).toBe(tempDirs[1]!);
  });

  test("a directory that does not exist is a usage error before any request", async () => {
    const { deps } = opencodeDeps();
    const missing = join(tempDirs[1]!, "absent");
    await expect(runAgent({ agent: "opencode", passthrough: [missing] }, deps)).rejects.toMatchObject({
      name: "UsageError",
      message: `dossier introuvable : ${missing}`,
    });
    expect(service.requests).toHaveLength(0);
  });

  test("an unreachable service starts opencode as typed, off the bus, without its model", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { deps, execCalls, understudy } = opencodeDeps({ ensureOpencodeService: async () => undefined });
      await expect(runAgent({ agent: "opencode", passthrough: ["-m", "opencode/big-pickle", "-c", tempDirs[1]!] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toBe(
        "idnma : service opencode injoignable. opencode démarre hors du bus (il ne recevra ni n'enverra de messages).\n",
      );
      expect(execCalls).toHaveLength(1);
      expect(execCalls[0]!.file).toBe("/fake/bin/opencode");
      expect(execCalls[0]!.argv).toEqual(["opencode", "-c", tempDirs[1]!]);
      expect(understudy).toHaveLength(0);
      expect(listLiveEntries()).toHaveLength(0);
      expect(service.requests).toHaveLength(0);

      // Le modèle de l'engine n'atteint pas non plus l'argv.
      await expect(runAgent({ agent: "opencode", passthrough: [] }, deps)).rejects.toBeInstanceOf(ExecSentinel);
      expect(execCalls[1]!.argv).toEqual(["opencode"]);
    } finally {
      stderr.mockRestore();
    }
  });

  test("a service error on the session aborts before any registration", async () => {
    service.handle("POST", "/api/session", () => ({ status: 500, body: { _tag: "InternalError", message: "boom" } }));
    const { deps, understudy } = opencodeDeps();
    await expect(runAgent({ agent: "opencode", passthrough: [] }, deps)).rejects.toMatchObject({
      name: "ConfigError",
      message: "opencode a refusé la session (boom)",
    });
    expect(listLiveEntries()).toHaveLength(0);
    expect(understudy).toHaveLength(0);
  });

  test("a service answering 500 without a body is reported the same way", async () => {
    service.handle("POST", "/api/session", () => ({ status: 500 }));
    const { deps } = opencodeDeps();
    await expect(runAgent({ agent: "opencode", passthrough: [] }, deps)).rejects.toThrow("opencode a refusé la session");
    expect(listLiveEntries()).toHaveLength(0);
  });
});

describe("dst argv", () => {
  test("dstRefusal names every launcher command, typed first as the first positional only", () => {
    for (const command of ["run", "cli", "dsh", "update", "migrate", "doctor", "safe", "version", "help", "session", "models", "skills", "mcp", "auth", "capabilities"]) {
      expect(dstRefusal([command])).toContain(command);
      expect(dstRefusal(["--resume", "abc", command])).toContain(command);
    }
    // Ailleurs qu'en premier positionnel, le mot n'est plus une commande.
    expect(dstRefusal(["/some/dir", "update"])).toBeUndefined();
    expect(dstRefusal(["--", "update"])).toContain("update");
  });

  test("dstRefusal refuses the launcher flags, in every spelling", () => {
    for (const flag of ["-p", "-px", "--print", "--print=x", "-v", "--version", "-h", "--help", "--profile", "--profile=x", "--from-default-profile"]) {
      expect(dstRefusal(["--backend", "dsh", flag])).toBeDefined();
    }
    expect(dstRefusal(["-p", "x"])).toContain("-p");
    expect(dstRefusal(["--help"])).toContain("--help");
    expect(dstRefusal(["--profile", "x"])).toContain("--profile");
  });

  test("dstRefusal accepts only --backend dsh, spaced or attached", () => {
    expect(dstRefusal(["--backend", "dsh"])).toBeUndefined();
    expect(dstRefusal(["--backend=dsh"])).toBeUndefined();
    expect(dstRefusal(["--backend", "codex"])).toContain("codex");
    expect(dstRefusal(["--backend=codex"])).toContain("codex");
    expect(dstRefusal(["--backend"])).toContain("--backend");
  });

  test("a flag value and the optional --resume id are not positionals", () => {
    expect(dstRefusal(["--resume", "update"])).toBeUndefined();
    expect(dstRefusal(["--resume=update"])).toBeUndefined();
    expect(dstRefusal(["--patch", "update"])).toBeUndefined();
    expect(dstRefusal(["--patch=update"])).toBeUndefined();
    expect(dstRefusal(["--backend", "dsh", "-c"])).toBeUndefined();
    // Sans id, `--resume` ne mange pas le flag qui le suit.
    expect(dstRefusal(["--resume", "--help"])).toContain("--help");
    expect(dstRefusal(["/some/dir", "--resume", "abc"])).toBeUndefined();
  });

  test("withDshBackend prefixes --backend dsh unless a --backend is already there", () => {
    expect(withDshBackend([])).toEqual(["--backend", "dsh"]);
    expect(withDshBackend(["--resume", "abc"])).toEqual(["--backend", "dsh", "--resume", "abc"]);
    expect(withDshBackend(["-c", "--backend", "dsh"])).toEqual(["-c", "--backend", "dsh"]);
    expect(withDshBackend(["--backend=dsh"])).toEqual(["--backend=dsh"]);
    // Un `--backend` après `--` est un positionnel : il ne compte pas.
    expect(withDshBackend(["--", "--backend"])).toEqual(["--backend", "dsh", "--", "--backend"]);
  });

  test("dstWorkingDirectory is the first positional that is an existing directory, else the current one", () => {
    const dir = tempDirs[1]!;
    expect(dstWorkingDirectory([])).toBe(process.cwd());
    expect(dstWorkingDirectory(["--backend", "dsh", dir])).toBe(dir);
    expect(dstWorkingDirectory(["--resume", dir])).toBe(process.cwd());
    expect(dstWorkingDirectory(["--patch", dir, "-c"])).toBe(process.cwd());
    expect(dstWorkingDirectory([join(dir, "absent")])).toBe(process.cwd());
    expect(dstWorkingDirectory([join(dir, "absent"), dir])).toBe(dir);
    // Un chemin relatif est résolu depuis le dossier courant.
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(dstWorkingDirectory([relative(process.cwd(), sub)])).toBe(sub);
  });

  test("buildHarnessArgv never injects --model for dst", () => {
    const engine: Engine = { harness: "dst", model: "deepseek-v4.1-flash", options: ["--resume"], env: {} };
    expect(buildHarnessArgv(engine, { passthrough: [] })).toEqual(["dst", "--resume"]);
  });
});

describe("runAgent dst", () => {
  /** Dépendances : `runUnderstudy` et le livreur enregistrent leurs options, le plugin a l'état donné. */
  function dstDeps(pluginState: DstPluginState = { kind: "installed" }, overrides: Partial<RunDeps> = {}) {
    const understudy: Array<Parameters<RunDeps["runUnderstudy"]>[0]> = [];
    const couriers: DstCourierOptions[] = [];
    const homes: string[] = [];
    const base = fakeDeps({
      dstPluginState: (home) => {
        homes.push(home);
        return pluginState;
      },
      createDstCourier: (o) => {
        couriers.push(o);
        return countingCourier();
      },
      runUnderstudy: async (o) => {
        understudy.push(o);
        o.registration?.unregister();
        return 0;
      },
      ...overrides,
    });
    return { ...base, understudy, couriers, homes };
  }

  /** Aucun effet : pas de lancement, pas de pane marqué, pas de nom tiré, rien dans les dossiers du registre et des sockets. */
  function expectNoEffect(fake: ReturnType<typeof dstDeps>): void {
    expect(fake.understudy).toHaveLength(0);
    expect(fake.couriers).toHaveLength(0);
    expect(fake.execCalls).toHaveLength(0);
    expect(fake.tags).toHaveLength(0);
    expect(listLiveEntries()).toHaveLength(0);
    expect(readdirSync(tempDirs[1]!, { recursive: true })).toEqual([]);
    expect(readdirSync(tempDirs[2]!, { recursive: true })).toEqual([]);
    expect(existsSync(controlDir())).toBe(false);
  }

  test("every typed refusal is a usage error naming its cause, before any effect (AC-10)", async () => {
    const typed: Array<[string[], string]> = [
      [["--backend", "codex"], "codex"],
      [["--backend=codex"], "codex"],
      [["-p", "x"], "-p"],
      [["--print"], "--print"],
      [["--help"], "--help"],
      [["update"], "update"],
      [["doctor"], "doctor"],
      [["mcp"], "mcp"],
      [["--profile", "x"], "--profile"],
    ];
    for (const [passthrough, cause] of typed) {
      const fake = dstDeps();
      const error = await runAgent({ agent: "dst", passthrough }, fake.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toContain(cause);
      expect((error as Error).message).toContain("dst");
      expectNoEffect(fake);
      // Un refus tapé arrive avant même la lecture de l'état du plugin.
      expect(fake.homes).toEqual([]);
    }
  });

  test("a model or a launcher option in the engine is a configuration error naming the engine (AC-10)", async () => {
    const withModel = dstDeps();
    const modelError = await runAgent({ agent: "dst", engine: "withmodel", passthrough: [] }, withModel.deps).catch((e: unknown) => e);
    expect(modelError).toBeInstanceOf(ConfigError);
    expect((modelError as Error).message).toContain("agents.dst.engines.withmodel");
    expect((modelError as Error).message).toContain("dst ne prend pas de modèle au lancement ; choisis-le avec /model dans dst, la TUI le retient");
    expectNoEffect(withModel);

    const badBackend = dstDeps();
    const backendError = await runAgent({ agent: "dst", engine: "badbackend", passthrough: [] }, badBackend.deps).catch((e: unknown) => e);
    expect(backendError).toBeInstanceOf(ConfigError);
    expect((backendError as Error).message).toContain("agents.dst.engines.badbackend");
    expect((backendError as Error).message).toContain("codex");
    expectNoEffect(badBackend);
  });

  test("a plugin that is not installed is refused with the install command, before pane, name and bus (AC-10)", async () => {
    // Un pane qui serait refusé (stdin sans terminal) : l'erreur du plugin passe la première.
    const fake = dstDeps({ kind: "absent" }, { probe: { ...ownPaneProbe(), stdinIsTTY: false } });
    const error = await runAgent({ agent: "dst", passthrough: [] }, fake.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe("le plugin idnma n'est pas installé dans dst : lance idnma install --agent dst");
    expectNoEffect(fake);
  });

  test("a plugin installed from another checkout names it and is refused the same way (AC-10)", async () => {
    const fake = dstDeps({ kind: "other-checkout", path: "/elsewhere/src/dst/plugin.ts" }, { probe: { ...ownPaneProbe(), stdinIsTTY: false } });
    const error = await runAgent({ agent: "dst", passthrough: [] }, fake.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("autre checkout (/elsewhere/src/dst/plugin.ts)");
    expect((error as Error).message).toContain("relance idnma install --agent dst depuis celui-ci");
    expectNoEffect(fake);
  });

  test("an inconsistent plugin state raised by the check propagates as is", async () => {
    const fake = dstDeps(undefined, {
      dstPluginState: () => {
        throw new ConfigError("marqueurs incohérents");
      },
    });
    await expect(runAgent({ agent: "dst", passthrough: [] }, fake.deps)).rejects.toMatchObject({ name: "ConfigError", message: "marqueurs incohérents" });
    expectNoEffect(fake);
  });

  test("the plugin check reads the home of the child: the engine's DSH_HOME, and IDNMA_DSH_HOME over it", async () => {
    const other = dstDeps();
    await runAgent({ agent: "dst", engine: "otherhome", passthrough: [] }, other.deps);
    expect(other.homes).toEqual(["/tmp/idnma-t-dsthome-from-engine"]);

    process.env.IDNMA_DSH_HOME = join(tempDirs[1]!, "dsh-home");
    const overridden = dstDeps();
    await runAgent({ agent: "dst", engine: "otherhome", passthrough: [] }, overridden.deps);
    expect(overridden.homes).toEqual([join(tempDirs[1]!, "dsh-home")]);
  });

  test("default engine: runs `dst --backend dsh` under the understudy with a dst courier and the dst label", async () => {
    const fake = dstDeps();
    expect(await runAgent({ agent: "dst", passthrough: [] }, fake.deps)).toBe(0);
    expect(fake.understudy).toHaveLength(1);
    const seen = fake.understudy[0]!;
    expect(seen.argv).toEqual(["/fake/bin/dst", "--backend", "dsh"]);
    expect(seen.harnessLabel).toBe("dst");
    expect(seen.pty).toBeUndefined();
    expect(seen.exportControlEnv).not.toBe(false);
    expect(seen.name).toMatch(/^dst-[a-z]+-[a-z0-9]{4}$/);
    expect(fake.tags).toEqual([{ paneId: "%7", agentKey: "dst", name: seen.name, execCallsBefore: 0 }]);
    expect(fake.couriers).toHaveLength(1);
    expect(fake.couriers[0]!.name).toBe(seen.name);
    expect(fake.couriers[0]!.registration).toBe(seen.registration!);
    expect(fake.couriers[0]!.queue).toBe(seen.queue);
    expect(seen.courier).toBeDefined();
  });

  test("a typed --backend dsh is not doubled; --resume with an id, -c and a directory pass through", async () => {
    for (const [passthrough, expected] of [
      [["--backend", "dsh"], ["--backend", "dsh"]],
      [["--backend=dsh", "-c"], ["--backend=dsh", "-c"]],
      [["--resume", "abc"], ["--backend", "dsh", "--resume", "abc"]],
      [["--patch", "p.yml", tempDirs[1]!], ["--backend", "dsh", "--patch", "p.yml", tempDirs[1]!]],
    ] as const) {
      const fake = dstDeps();
      await runAgent({ agent: "dst", passthrough: [...passthrough] }, fake.deps);
      expect(fake.understudy[0]!.argv).toEqual(["/fake/bin/dst", ...expected]);
      expect(fake.understudy[0]!.argv.filter((token) => token.startsWith("--backend"))).toHaveLength(1);
    }
  });

  test("the registry entry carries the directory given as positional", async () => {
    let registeredCwd: string | undefined;
    const fake = dstDeps(undefined, {
      runUnderstudy: async (o) => {
        registeredCwd = listLiveEntries().find((entry) => entry.pid === process.pid)?.cwd;
        o.registration?.unregister();
        return 0;
      },
    });
    await runAgent({ agent: "dst", passthrough: ["--resume", "abc", tempDirs[1]!] }, fake.deps);
    expect(registeredCwd).toBe(tempDirs[1]!);
  });

  test("env: no launchpad, the engine wins over it, and the bridge variables match the courier", async () => {
    const fake = dstDeps();
    await runAgent({ agent: "dst", passthrough: [] }, fake.deps);
    const env = fake.understudy[0]!.env;
    expect(env.DSH_TUI_NO_LAUNCHPAD).toBe("1");
    expect(env.IDNMA_DST_BRIDGE).toBe(dstBridgeSocketPath());
    expect(env.IDNMA_DST_BRIDGE!.startsWith(`${controlDir()}/`)).toBe(true);
    expect(env.IDNMA_DST_BRIDGE_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    expect(fake.couriers[0]!.socketPath).toBe(env.IDNMA_DST_BRIDGE!);
    expect(fake.couriers[0]!.token).toBe(env.IDNMA_DST_BRIDGE_TOKEN!);

    const engineWins = dstDeps();
    await runAgent({ agent: "dst", engine: "launchpad", passthrough: [] }, engineWins.deps);
    expect(engineWins.understudy[0]!.env.DSH_TUI_NO_LAUNCHPAD).toBe("0");
  });

  test("the bridge token is drawn at every launch", async () => {
    const first = dstDeps();
    const second = dstDeps();
    await runAgent({ agent: "dst", passthrough: [] }, first.deps);
    await runAgent({ agent: "dst", passthrough: [] }, second.deps);
    expect(first.couriers[0]!.token).not.toBe(second.couriers[0]!.token);
  });

  test("fromMode is bypass with DSH_PERMISSION_MODE=danger-full-access in the engine or the environment, prompting otherwise", async () => {
    const full = dstDeps();
    await runAgent({ agent: "dst", engine: "full", passthrough: [] }, full.deps);
    expect(full.couriers[0]!.fromMode).toBe("bypass");
    expect(full.understudy[0]!.fromMode).toBe("bypass");
    expect(full.understudy[0]!.env.DSH_PERMISSION_MODE).toBe("danger-full-access");

    const plain = dstDeps();
    await runAgent({ agent: "dst", passthrough: [] }, plain.deps);
    expect(plain.couriers[0]!.fromMode).toBe("prompting");
    expect(plain.understudy[0]!.fromMode).toBe("prompting");

    process.env.DSH_PERMISSION_MODE = "danger-full-access";
    const fromEnvironment = dstDeps();
    await runAgent({ agent: "dst", passthrough: [] }, fromEnvironment.deps);
    expect(fromEnvironment.couriers[0]!.fromMode).toBe("bypass");
  });

  test("without DSH_PERMISSION_MODE, fromMode follows the mode dst remembered; the variable outranks it", async () => {
    const prefsDir = process.env.IDNMA_DST_PREFS_DIR!;
    mkdirSync(prefsDir, { recursive: true });
    writeFileSync(join(prefsDir, "permission.json"), JSON.stringify({ permission: "danger-full-access" }));
    const remembered = dstDeps();
    await runAgent({ agent: "dst", passthrough: [] }, remembered.deps);
    expect(remembered.couriers[0]!.fromMode).toBe("bypass");

    process.env.DSH_PERMISSION_MODE = "workspace-write";
    const pinned = dstDeps();
    await runAgent({ agent: "dst", passthrough: [] }, pinned.deps);
    expect(pinned.couriers[0]!.fromMode).toBe("prompting");
  });

  test("without a bus registration: no courier, no bridge variables, and dst still starts", async () => {
    peers.push(await startFakePeer("other", { peerProtocol: 2 }));
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const fake = dstDeps();
      await runAgent({ agent: "dst", passthrough: [] }, fake.deps);
      expect(fake.couriers).toHaveLength(0);
      expect(fake.understudy[0]!.courier).toBeUndefined();
      expect(fake.understudy[0]!.registration).toBeNull();
      expect(fake.understudy[0]!.env.IDNMA_DST_BRIDGE).toBeUndefined();
      expect(fake.understudy[0]!.env.IDNMA_DST_BRIDGE_TOKEN).toBeUndefined();
      expect(fake.understudy[0]!.env.DSH_TUI_NO_LAUNCHPAD).toBe("1");
    } finally {
      stderr.mockRestore();
    }
  });

  test("without a bus registration, bridge variables inherited from the parent environment are removed from the child env", async () => {
    peers.push(await startFakePeer("other", { peerProtocol: 2 }));
    process.env.IDNMA_DST_BRIDGE = "/tmp/inherited.sock";
    process.env.IDNMA_DST_BRIDGE_TOKEN = "inherited-token-test";
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const fake = dstDeps();
      await runAgent({ agent: "dst", passthrough: [] }, fake.deps);
      expect(fake.understudy[0]!.registration).toBeNull();
      expect("IDNMA_DST_BRIDGE" in fake.understudy[0]!.env).toBe(false);
      expect("IDNMA_DST_BRIDGE_TOKEN" in fake.understudy[0]!.env).toBe(false);
      expect(fake.understudy[0]!.env.DSH_TUI_NO_LAUNCHPAD).toBe("1");
    } finally {
      stderr.mockRestore();
    }
  });

  test("a missing dst binary is reported after the plugin check", async () => {
    const fake = dstDeps(undefined, { which: () => null });
    await expect(runAgent({ agent: "dst", passthrough: [] }, fake.deps)).rejects.toThrow("Binaire « dst » introuvable");
    expectNoEffect(fake);
  });
});
