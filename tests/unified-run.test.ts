import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandInfo, ConfigOption } from "../src/acp/events.ts";
import { sendPeerMessage } from "../src/bus/send.ts";
import { listLiveEntries, type SessionEntry } from "../src/bus/registry.ts";
import { ConfigError, type Engine } from "../src/config/network.ts";
import { controlSocketPath, controlRequest } from "../src/understudy/control.ts";
import { UsageError } from "../src/run/args.ts";
import { runAgent, type RunDeps } from "../src/run/run.ts";
import type { PaneProbe } from "../src/run/pane.ts";
import { NOTIFY, PROGRESS_OFF, PROGRESS_ON } from "../src/tui/signals.ts";
import type { SessionState } from "../src/tui/state.ts";
import { runUnified, type UnifiedDeps } from "../src/unified/run-unified.ts";
import { UNIFIED_HARNESSES } from "../src/config/engine-rules.ts";
import { missingAdapterMessage, missingAgentMessage, notConnectedMessage } from "../src/unified/preflight.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { createScreen } from "../src/tui/view/screen.ts";
import { FakeScreen } from "./helpers/fake-screen.ts";
import { startFakePeer, type FakePeer } from "./helpers/fake-peer.ts";

// L'agent réel ne part jamais d'ici : l'adaptateur est un shim qui lance `fake-acp-agent.ts`, le PATH du test est un
// dossier temporaire seul, et chaque dossier d'état d'idnma est redirigé vers un dossier temporaire.

type Json = Record<string, unknown>;

const FAKE_AGENT = join(import.meta.dir, "helpers", "fake-acp-agent.ts");
const CHILD = join(import.meta.dir, "helpers", "unified-child.ts");
const TTY = "/dev/ttys-fake";
const ENV_KEYS = ["PATH", "CLAUDE_CODE_EXECUTABLE", "IDNMA_CONFIG_DIR", "IDNMA_CLAUDE_DIR", "IDNMA_SOCKETS_DIR", "IDNMA_CONTROL_DIR", "IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN"] as const;

let previousEnv: Record<string, string | undefined>;
let workDir: string;
let binDir: string;
let configDir: string;
let adapterCount = 0;
let peers: FakePeer[];
let sessions: Session[];
let grandchildFiles: string[];

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ["IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN", "CLAUDE_CODE_EXECUTABLE"]) delete process.env[key];
  workDir = mkdtempSync("/tmp/idnma-t-");
  binDir = join(workDir, "bin");
  mkdirSync(binDir);
  // Les seuls outils système dont les bibliothèques d'idnma ont besoin ; ni `claude`, ni `agy`, ni `claude-agent-acp`.
  for (const tool of ["sleep", "sh", "ps"]) symlinkSync(`/bin/${tool}`, join(binDir, tool));
  configDir = join(workDir, "config");
  mkdirSync(configDir);
  process.env.PATH = binDir;
  process.env.IDNMA_CONFIG_DIR = configDir;
  process.env.IDNMA_CLAUDE_DIR = join(workDir, "claude");
  process.env.IDNMA_SOCKETS_DIR = join(workDir, "socks");
  // Sous-dossier absent : sa création en 700 fait partie du comportement.
  process.env.IDNMA_CONTROL_DIR = join(workDir, "ctl");
  mkdirSync(process.env.IDNMA_CLAUDE_DIR);
  peers = [];
  sessions = [];
  grandchildFiles = [];
});

afterEach(async () => {
  // Une session restée ouverte par un test en échec est quittée, puis ses restes sont tués par pid noté.
  for (const session of sessions) {
    if (session.exits.length === 0) session.screen.fire("quit");
    await Promise.race([session.running.catch(() => 0), Bun.sleep(8000)]);
    expect(session.screen.rendersAfterDestroy).toBe(0);
  }
  for (const file of grandchildFiles) {
    if (!existsSync(file)) continue;
    try {
      process.kill(Number(readFileSync(file, "utf8")), "SIGKILL");
    } catch {
      // déjà mort
    }
  }
  for (const peer of peers) peer.stop();
  rmSync(workDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---- scénarios et adaptateur factice ----

function option(id: string, category: string, currentValue: string, values: string[]): Json {
  return { id, name: id, category, type: "select", currentValue, options: values.map((value) => ({ value, name: value })) };
}

const STANDARD_OPTIONS = [
  option("model", "model", "opus", ["opus", "haiku"]),
  option("effort", "thought_level", "high", ["low", "medium", "high"]),
  option("mode", "mode", "default", ["default", "plan", "auto", "bypassPermissions"]),
];

const agentChunk = (text: string): Json => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const userChunk = (text: string): Json => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
const toolCall = (toolCallId: string): Json => ({ sessionUpdate: "tool_call", toolCallId, title: "Run", kind: "execute", status: "in_progress" });

/** Un tour qui reste suspendu à une permission tant que l'écran n'y répond pas. */
const PERMISSION_TURN: Json = {
  permission: {
    toolCall: { toolCallId: "t1", title: "git push origin main", kind: "execute", status: "pending" },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  },
  updatesAfterPermission: [agentChunk("pushed")],
};

interface Adapter {
  /** Chemin de l'adaptateur factice, tel que `deps.which` le rend. */
  path: string;
  received: string;
  envDump: string;
}

function makeAdapter(scenario: Json = {}): Adapter {
  adapterCount += 1;
  const received = join(workDir, `received-${adapterCount}.jsonl`);
  const envDump = join(workDir, `env-${adapterCount}.json`);
  const scenarioFile = join(workDir, `scenario-${adapterCount}.json`);
  writeFileSync(scenarioFile, JSON.stringify({ configOptions: STANDARD_OPTIONS, received, envDump, ...scenario }));
  const path = join(binDir, `adapter-${adapterCount}`);
  writeFileSync(path, `#!/bin/sh\nFAKE_ACP_SCENARIO='${scenarioFile}' exec '${process.execPath}' '${FAKE_AGENT}'\n`);
  chmodSync(path, 0o755);
  return { path, received, envDump };
}

function readLines(file: string): Json[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Json);
}

function logLines(): Json[] {
  return readLines(join(configDir, "logs", "idnma.log"));
}

function logsOf(event: string): Json[] {
  return logLines().filter((line) => line.event === event);
}

function requestsOf(adapter: Adapter, method: string): Json[] {
  return readLines(adapter.received).filter((line) => line.type === "request" && line.method === method).map((line) => line.params as Json);
}

function promptTexts(adapter: Adapter): string[] {
  return requestsOf(adapter, "session/prompt").map((params) => ((params.prompt as Json[])[0] as Json).text as string);
}

/** Réponses du client aux requêtes de l'agent (les permissions), dans l'ordre. */
function permissionAnswers(adapter: Adapter): Json[] {
  return readLines(adapter.received).filter((line) => line.type === "response").map((line) => line.result as Json);
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

function runnerEntry(): SessionEntry | undefined {
  return listLiveEntries().find((entry) => entry.pid === process.pid);
}

// ---- lancement ----

function ownPaneProbe(): PaneProbe {
  return { env: { TMUX: "fake,1,0", TMUX_PANE: "%7" }, stdinIsTTY: true, stdinTty: () => TTY, paneTty: () => TTY };
}

function engineOf(harness: "claude" | "agy", extra: Partial<Engine> = {}): Engine {
  return { harness, options: [], env: {}, ...extra };
}

interface Session {
  adapter: Adapter;
  running: Promise<number>;
  screen: FakeScreen;
  /** Codes passés à `exit` ; la première entrée est le code de sortie du process. */
  exits: number[];
  /** Séquences écrites sur le terminal (OSC 9). */
  osc: string[];
  tags: { paneId: string; agentKey: string; name: string | undefined }[];
  name: string;
  state(): SessionState;
}

interface BootOptions {
  harness?: "claude" | "agy";
  scenario?: Json;
  passthrough?: string[];
  engine?: Partial<Engine>;
}

/** Lance `runUnified` sur l'adaptateur factice avec un faux écran, et rend la main quand le premier rendu est parti. */
async function boot(o: BootOptions = {}): Promise<Session> {
  const harness = o.harness ?? "claude";
  const adapter = makeAdapter(o.scenario);
  const exits: number[] = [];
  const osc: string[] = [];
  const tags: Session["tags"] = [];
  let resolveScreen!: (screen: FakeScreen) => void;
  const screenOpened = new Promise<FakeScreen>((resolve) => {
    resolveScreen = resolve;
  });
  const running = runUnified({
    agentKey: harness === "claude" ? "opus" : "argon",
    engine: engineOf(harness, o.engine),
    passthrough: o.passthrough ?? [],
    deps: {
      probe: ownPaneProbe(),
      which: (bin) => (bin === "claude-agent-acp" || bin === "agy" ? adapter.path : bin === "claude" ? "/fake/bin/claude" : null),
      tmuxTarget: (paneId) => `sess:@1.${paneId}`,
      tagPane: (paneId, agentKey, name) => {
        tags.push({ paneId, agentKey, name });
      },
      openScreen: async (options) => {
        const screen = new FakeScreen(options.handlers);
        resolveScreen(screen);
        return screen;
      },
      exit: (code) => {
        exits.push(code);
        return undefined as never;
      },
      write: (bytes) => {
        osc.push(bytes);
      },
    },
  });
  const screen = await Promise.race([
    screenOpened,
    running.then((code) => {
      throw new Error(`runUnified ended before the screen opened (code ${code})`);
    }),
  ]);
  await waitFor(() => screen.renders.length > 0, "the first render");
  const session: Session = {
    adapter,
    running,
    screen,
    exits,
    osc,
    tags,
    name: runnerEntry()?.name ?? "",
    state: () => screen.state,
  };
  sessions.push(session);
  return session;
}

interface RealSession {
  adapter: Adapter;
  running: Promise<number>;
  exits: number[];
  setup: Awaited<ReturnType<typeof createTestRenderer>>;
}

/** Lance `runUnified` sur le vrai écran (moteur de test d'OpenTUI) : les touches passent par les vraies intentions. */
async function bootRealScreen(scenario: Json): Promise<RealSession> {
  const adapter = makeAdapter(scenario);
  const exits: number[] = [];
  const rendered: SessionState[] = [];
  let setup: RealSession["setup"] | undefined;
  const running = runUnified({
    agentKey: "opus",
    engine: engineOf("claude"),
    // La reprise rejoue les commandes du scénario dans l'état, donc dans la palette.
    passthrough: ["--resume", "s1"],
    deps: {
      probe: ownPaneProbe(),
      which: (bin) => (bin === "claude-agent-acp" ? adapter.path : bin === "claude" ? "/fake/bin/claude" : null),
      tmuxTarget: (paneId) => `sess:@1.${paneId}`,
      tagPane: () => {},
      openScreen: async (options) => {
        setup = await createTestRenderer({ width: 104, height: 31, kittyKeyboard: true, exitOnCtrlC: false });
        const screen = createScreen({ renderer: setup.renderer, cwd: options.cwd, handlers: options.handlers });
        const render = screen.render;
        screen.render = (state) => {
          rendered.push(state);
          render(state);
        };
        return screen;
      },
      exit: (code) => {
        exits.push(code);
        return undefined as never;
      },
      write: () => {},
    },
  });
  await waitFor(() => (rendered.at(-1)?.commands.length ?? 0) > 0, "the replayed commands");
  return { adapter, running, exits, setup: setup! };
}

interface Failure {
  code: number;
  stderr: string;
  screenOpened: boolean;
}

/** Lance `runUnified` là où le démarrage doit échouer : l'écran ne doit jamais s'ouvrir. */
async function bootFailing(o: BootOptions & { deps?: Partial<UnifiedDeps> } = {}): Promise<Failure> {
  const harness = o.harness ?? "claude";
  const adapter = makeAdapter(o.scenario);
  let screenOpened = false;
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const code = await runUnified({
      agentKey: harness === "claude" ? "opus" : "argon",
      engine: engineOf(harness, o.engine),
      passthrough: o.passthrough ?? [],
      deps: {
        probe: ownPaneProbe(),
        which: (bin) => (bin === "claude-agent-acp" || bin === "agy" ? adapter.path : null),
        tmuxTarget: (paneId) => `sess:@1.${paneId}`,
        tagPane: () => {},
        openScreen: async (options) => {
          screenOpened = true;
          return new FakeScreen(options.handlers);
        },
        exit: () => undefined as never,
        write: () => {},
        ...o.deps,
      },
    });
    return { code, stderr: stderr.mock.calls.map((call) => String(call[0])).join(""), screenOpened };
  } finally {
    stderr.mockRestore();
  }
}

function nothingLeftBehind(): void {
  expect(runnerEntry()).toBeUndefined();
  expect(existsSync(controlSocketPath())).toBe(false);
}

/** Le contenu de chaque message reçu par un faux pair (enveloppes comprises). */
function contentsOf(peer: FakePeer): string[] {
  return peer.lines
    .filter((line): line is { type: "user"; message: { content: string } } => (line as Json).type === "user")
    .map((line) => line.message.content);
}

async function sendFromPeer(peer: FakePeer, to: string, body: string): Promise<string> {
  const { msgId } = await sendPeerMessage({ fromSocketPath: peer.socketPath, fromName: peer.entry.name, fromMode: "bypass", to, body });
  return msgId;
}

function threadKinds(state: SessionState): string[] {
  return state.thread.map((item) => item.kind);
}

function notices(state: SessionState): string[] {
  return state.thread.flatMap((item) => (item.kind === "notice" ? [item.text] : []));
}

function permissionPending(session: Session): boolean {
  return session.state().pending?.kind === "permission";
}

const statusOfRunner = (entry: SessionEntry | undefined): string | undefined => entry?.status;

// ---- routage et contrôles avant tout effet ----

const NETWORK = `
agents:
  codex:
    engines:
      unified:
        harness: codex
        ui: unified
        options: ["--config", "x=y"]
  dst:
    engines:
      unified:
        harness: dst
        model: x
        ui: unified
  claude:
    engines:
      default:
        harness: claude
      unified:
        harness: claude
        ui: unified
  agy:
    engines:
      default:
        harness: agy
`;

class ExecSentinel extends Error {}

interface Touched {
  probeReads: number;
  tmuxTargets: number;
  tags: number;
  whichCalls: number;
  execs: { file: string; argv: string[] }[];
}

/** Dépendances de `runAgent` qui comptent tout effet : un contrôle qui précède les effets les laisse à zéro. */
function countingRunDeps(adapterPath?: string): { deps: Partial<RunDeps>; touched: Touched } {
  const touched: Touched = { probeReads: 0, tmuxTargets: 0, tags: 0, whichCalls: 0, execs: [] };
  const probe: PaneProbe = {
    get env() {
      touched.probeReads += 1;
      return { TMUX: "fake,1,0", TMUX_PANE: "%7" };
    },
    stdinIsTTY: true,
    stdinTty: () => TTY,
    paneTty: () => TTY,
  };
  const deps: Partial<RunDeps> = {
    probe,
    which: (bin) => {
      touched.whichCalls += 1;
      return bin === "claude-agent-acp" && adapterPath !== undefined ? adapterPath : `/fake/bin/${bin}`;
    },
    tmuxTarget: () => {
      touched.tmuxTargets += 1;
      return "sess:@1.%7";
    },
    tagPane: () => {
      touched.tags += 1;
    },
    execve: (file, argv) => {
      touched.execs.push({ file, argv });
      throw new ExecSentinel("execve");
    },
  };
  return { deps, touched };
}

describe("routing and preflight", () => {
  beforeEach(() => {
    writeFileSync(join(configDir, ".idnma.yml"), NETWORK);
  });

  test("unified codex engine with an embedded flag is refused before any effect", async () => {
    const { deps, touched } = countingRunDeps();
    const error = await runAgent({ agent: "codex", engine: "unified", passthrough: [] }, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("--config");
    expect(touched).toEqual({ probeReads: 0, tmuxTargets: 0, tags: 0, whichCalls: 0, execs: [] });
    expect(listLiveEntries()).toEqual([]);
    expect(existsSync(controlSocketPath())).toBe(false);
  });

  test("unified dst engine with a model is refused before any effect", async () => {
    const { deps, touched } = countingRunDeps();
    const error = await runAgent({ agent: "dst", engine: "unified", passthrough: [] }, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("dst ne prend pas de modèle");
    expect(touched).toEqual({ probeReads: 0, tmuxTargets: 0, tags: 0, whichCalls: 0, execs: [] });
    expect(listLiveEntries()).toEqual([]);
    expect(existsSync(controlSocketPath())).toBe(false);
  });

  test("--native forces the native path", async () => {
    const { deps, touched } = countingRunDeps();
    const error = await runAgent({ agent: "claude", engine: "unified", ui: "native", passthrough: [] }, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExecSentinel);
    expect(touched.execs).toHaveLength(1);
    expect(touched.execs[0]!.file).toBe("/fake/bin/claude");
    expect(existsSync(controlSocketPath())).toBe(false);
  });

  test("--unified on a claude engine takes the unified path through runAgent", async () => {
    const adapter = makeAdapter({ authRequired: true });
    const { deps, touched } = countingRunDeps(adapter.path);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await runAgent({ agent: "claude", ui: "unified", passthrough: [] }, deps);
      expect(code).toBe(1);
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(notConnectedMessage("claude"));
    } finally {
      stderr.mockRestore();
    }
    expect(touched.execs).toEqual([]);
    nothingLeftBehind();
  });
});

describe("pre-screen messages", () => {
  test("missing adapter messages name the install command", () => {
    expect(missingAdapterMessage("codex")).toContain("bun add -g @agentclientprotocol/codex-acp@2.5.0");
    expect(missingAdapterMessage("pi")).toContain("bun add -g pi-acp@0.0.34");
    expect(missingAdapterMessage("dst")).toContain("dsh --profile acp");
    expect(missingAgentMessage("codex")).toContain("CODEX_PATH");
    expect(missingAgentMessage("pi")).toContain("pi-acp le lance");
    expect(notConnectedMessage("opencode")).toContain("opencode auth login");
    expect(notConnectedMessage("codex")).toContain("codex login");
  });

  test("every harness has a message of each kind", () => {
    for (const harness of UNIFIED_HARNESSES) {
      expect(missingAdapterMessage(harness)).not.toBe("");
      expect(missingAgentMessage(harness)).not.toBe("");
      expect(notConnectedMessage(harness)).not.toBe("");
    }
  });
});

describe("startup failures", () => {
  test("a missing adapter names the release archive", async () => {
    const error = await runUnified({
      agentKey: "opus",
      engine: engineOf("claude"),
      passthrough: [],
      deps: { probe: ownPaneProbe(), which: () => null, tagPane: () => {}, tmuxTarget: () => "t" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(missingAdapterMessage("claude"));
    expect((error as Error).message).toContain("releases");
    expect((error as Error).message).toContain("claude-agent-acp");
    nothingLeftBehind();
  });

  test("a missing agy binary is a short French message", async () => {
    const error = await runUnified({
      agentKey: "argon",
      engine: engineOf("agy"),
      passthrough: [],
      deps: { probe: ownPaneProbe(), which: () => null },
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("Binaire « agy » introuvable dans le PATH.");
    nothingLeftBehind();
  });

  test("an agent that is not logged in exits 1 before the screen", async () => {
    for (const harness of ["claude", "agy"] as const) {
      const failure = await bootFailing({ harness, scenario: { authRequired: true } });
      expect(failure.code).toBe(1);
      expect(failure.screenOpened).toBe(false);
      expect(failure.stderr).toContain(notConnectedMessage(harness));
      nothingLeftBehind();
    }
  });

  test("resume unknown id exits 1 with a French message", async () => {
    const failure = await bootFailing({ scenario: { loadNotFound: true }, passthrough: ["--resume", "abc-123"] });
    expect(failure.code).toBe(1);
    expect(failure.screenOpened).toBe(false);
    expect(failure.stderr).toContain("Session « abc-123 » introuvable pour Claude.");
    nothingLeftBehind();
  });

  test("a startup failure cleans up and exits 1", async () => {
    const failure = await bootFailing({ scenario: { exitOnStart: 3 } });
    expect(failure.code).toBe(1);
    expect(failure.screenOpened).toBe(false);
    expect(failure.stderr).toContain("Claude n'a pas démarré (3) ; détail dans ~/.config/idema/logs/idnma.log.");
    expect(logsOf("unified-start-failed")).toHaveLength(1);
    nothingLeftBehind();
  });

  test("an agent error text never reaches the log, while the French message keeps its text", async () => {
    const leaky = "Authentication required for someone@example.com";
    const notConnected = await bootFailing({ scenario: { authRequired: true, authRequiredMessage: leaky } });
    expect(notConnected.stderr).toContain(notConnectedMessage("claude"));
    const started = await bootFailing({ scenario: { sessionNewError: { code: -32603, message: "internal error for someone@example.com" } } });
    expect(started.stderr).toContain("Claude n'a pas démarré (-32603)");
    const logged = readFileSync(join(configDir, "logs", "idnma.log"), "utf8");
    expect(logged).not.toContain("@");
    expect(logsOf("unified-start-failed")).toEqual([
      expect.objectContaining({ error: "AgentNotConnectedError" }),
      expect.objectContaining({ error: "AgentStartError", code: -32603 }),
    ]);
  });

  test("a failure after the screen opened gives the terminal back before the error goes up", async () => {
    let screen: FakeScreen | undefined;
    const error = await bootFailing({
      deps: {
        openScreen: async (options) => {
          screen = new FakeScreen(options.handlers);
          screen.render = () => {
            throw new Error("render failed");
          };
          return screen;
        },
      },
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("render failed");
    expect(screen!.destroyed).toBe(true);
    expect(logsOf("unified-crash")).toEqual([expect.objectContaining({ message: "render failed" })]);
    nothingLeftBehind();
  });

  test("a resume flag without an id is a usage error and leaves nothing behind", async () => {
    const error = await bootFailing({ passthrough: ["--resume"] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UsageError);
    nothingLeftBehind();
  });

  test("a screen that fails to load is not swallowed and the agent is killed", async () => {
    const grandchild = join(workDir, "grandchild.pid");
    grandchildFiles.push(grandchild);
    const error = await bootFailing({
      scenario: { spawnGrandchild: grandchild },
      deps: {
        openScreen: async () => {
          throw new Error("screen load failed");
        },
      },
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("screen load failed");
    nothingLeftBehind();
    await waitFor(() => existsSync(grandchild), "the grandchild pid");
    const pid = Number(readFileSync(grandchild, "utf8"));
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the agent group to be dead");
  });
});

describe("opening announcements", () => {
  test("continue without a previous session announces a new one", async () => {
    const session = await boot({ passthrough: ["-c"], scenario: { listPages: [[]] } });
    expect(notices(session.state())).toContain("No previous session in this folder: new session.");
    expect(notices(session.state())).not.toContain("The agent replayed nothing from this session.");
  });

  test("a resumed session shows what the agent replays, and says when it replays nothing", async () => {
    const replayed = await boot({ passthrough: ["--resume", "s-old"], scenario: { replay: [userChunk("hello"), agentChunk("hi there")] } });
    expect(replayed.state().thread.map((item) => item.kind)).toEqual(["user", "agent"]);
    expect(notices(replayed.state())).toEqual([]);
    replayed.screen.fire("quit");
    await replayed.running;

    const silent = await boot({ passthrough: ["--resume", "s-old"], scenario: { replay: [] } });
    expect(notices(silent.state())).toContain("The agent replayed nothing from this session.");
  });

  test("ignored engine options are announced in the thread and the log, without their values", async () => {
    const session = await boot({ engine: { options: ["--remote-control", "--name", "topsecretvalue"] } });
    expect(notices(session.state())).toContain("Ignored in unified mode: --remote-control (type /remote-control instead)");
    expect(notices(session.state())).not.toContain("Ignored in unified mode: --remote-control");
    expect(notices(session.state())).toContain("Ignored in unified mode: --name topsecretvalue");
    expect(logsOf("unified-ignored")).toEqual([expect.objectContaining({ flags: ["--remote-control", "--name"] })]);
    expect(readFileSync(join(configDir, "logs", "idnma.log"), "utf8")).not.toContain("topsecretvalue");
  });

  test("on agy the ignored --remote-control keeps the generic notice, since no adapter command replaces it", async () => {
    const session = await boot({ harness: "agy", engine: { options: ["--remote-control"] } });
    expect(notices(session.state())).toContain("Ignored in unified mode: --remote-control");
    expect(notices(session.state())).not.toContain("Ignored in unified mode: --remote-control (type /remote-control instead)");
  });

  test("the thread opens with the options the agent announced after the engine settings", async () => {
    const session = await boot({ engine: { model: "haiku", options: ["--effort", "low"] } });
    const options = session.state().options;
    expect(options.find((candidate: ConfigOption) => candidate.category === "model")?.currentValue).toBe("haiku");
    expect(options.find((candidate: ConfigOption) => candidate.category === "thought_level")?.currentValue).toBe("low");
  });

  test("the pane is tagged once the screen is up, with the idnma name", async () => {
    const session = await boot();
    expect(session.tags).toEqual([{ paneId: "%7", agentKey: "opus", name: session.name }]);
    expect(session.name).toMatch(/^opus-/);
  });

  test("the agent receives the control channel variables", async () => {
    const session = await boot({ engine: { env: { EXTRA_VARIABLE: "kept" } } });
    await waitFor(() => existsSync(session.adapter.envDump), "the environment dump");
    const env = JSON.parse(readFileSync(session.adapter.envDump, "utf8")) as Record<string, string>;
    expect(env.IDNMA_NAME).toBe(session.name);
    expect(env.IDNMA_CONTROL_SOCKET).toBe(controlSocketPath());
    expect(env.IDNMA_CONTROL_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    expect(env.EXTRA_VARIABLE).toBe("kept");
    // L'exécutable de Claude du PATH est posé pour que l'adaptateur lance la même version qu'en natif.
    expect(env.CLAUDE_CODE_EXECUTABLE).toBe("/fake/bin/claude");
  });

  test("a bus that speaks another protocol leaves the session off the bus, with a line in the thread", async () => {
    const intruder = await startFakePeer("claude-old", { peerProtocol: 2 });
    peers.push(intruder);
    const session = await boot();
    expect(notices(session.state()).some((text) => text.startsWith("Not on the peer bus: "))).toBe(true);
    expect(runnerEntry()).toBeUndefined();
    // La session continue : un tour passe.
    session.screen.fire("submit", "hello");
    await waitFor(() => promptTexts(session.adapter).length === 1, "the prompt");
  });
});

describe("turns", () => {
  test("a typed prompt becomes a turn, and the registry follows busy and idle", async () => {
    const session = await boot({ scenario: { turn: { updates: [agentChunk("hello back")] } } });
    session.screen.fire("submit", "say hello");
    expect(session.screen.input).toBe("");
    await waitFor(() => session.state().thread.some((item) => item.kind === "agent" && item.text === "hello back"), "the answer");
    await waitFor(() => !session.state().turnActive, "the turn end");
    expect(promptTexts(session.adapter)).toEqual(["say hello"]);
    expect(threadKinds(session.state())).toEqual(["user", "agent"]);
    expect(logsOf("unified-prompt")).toEqual([expect.objectContaining({ origin: "user" })]);
    await waitFor(() => statusOfRunner(runnerEntry()) === "idle", "the idle registry status");
  });

  test("a blank submit does nothing", async () => {
    const session = await boot();
    session.screen.fire("submit", "  \n ");
    await Bun.sleep(50);
    expect(promptTexts(session.adapter)).toEqual([]);
    expect(session.state().thread).toEqual([]);
  });

  test("two quick prompts never both go out: the second waits for the end of the first turn", async () => {
    const session = await boot({ scenario: { turn: PERMISSION_TURN } });
    // Aucun tour de boucle entre les deux : le premier doit déjà compter comme un tour actif.
    session.screen.fire("submit", "first");
    session.screen.fire("submit", "second");
    await waitFor(() => permissionPending(session), "the permission");
    expect(promptTexts(session.adapter)).toEqual(["first"]);
    expect(session.state().localQueue).toEqual(["second"]);

    session.screen.fire("confirm");
    await waitFor(() => promptTexts(session.adapter).length === 2, "the second prompt");
    expect(promptTexts(session.adapter)).toEqual(["first", "second"]);
    await waitFor(() => permissionPending(session), "the second permission");
    session.screen.fire("confirm");
    await waitFor(() => !session.state().turnActive, "the end of the second turn");
  });

  test("a rejected prompt shows the failure and the session goes on", async () => {
    const session = await boot({ scenario: { promptError: { code: -32602, message: "Invalid params" } } });
    session.screen.fire("submit", "one");
    await waitFor(() => notices(session.state()).length === 1, "the first failure notice");
    expect(notices(session.state())[0]).toBe("Turn failed: Invalid params");
    expect(session.state().turnActive).toBe(false);
    session.screen.fire("submit", "two");
    await waitFor(() => notices(session.state()).length === 2, "the second failure notice");
    expect(session.exits).toEqual([]);
  });

  test("an interrupt cancels the turn and answers the pending permission as cancelled", async () => {
    const session = await boot({ scenario: { turn: PERMISSION_TURN } });
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the permission");
    session.screen.fire("interrupt");
    await waitFor(() => !session.state().turnActive, "the turn end");
    expect(session.state().pending).toBeUndefined();
    expect(session.state().interrupted).toBe(true);
    expect(permissionAnswers(session.adapter)).toEqual([{ outcome: { outcome: "cancelled" } }]);
  });

  test("confirm sends the selected choice and refuse sends the reject choice", async () => {
    const session = await boot({ scenario: { turn: PERMISSION_TURN } });
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the first permission");
    session.screen.fire("confirm");
    await waitFor(() => !session.state().turnActive, "the first turn end");
    expect(permissionAnswers(session.adapter)[0]).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

    session.screen.fire("submit", "again");
    await waitFor(() => permissionPending(session), "the second permission");
    session.screen.fire("selectDown");
    expect(session.state().pending).toMatchObject({ kind: "permission", selected: 1 });
    session.screen.fire("confirm");
    await waitFor(() => !session.state().turnActive, "the second turn end");
    expect(permissionAnswers(session.adapter)[1]).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });

    session.screen.fire("submit", "third");
    await waitFor(() => permissionPending(session), "the third permission");
    session.screen.fire("refuse");
    await waitFor(() => !session.state().turnActive, "the third turn end");
    expect(permissionAnswers(session.adapter)[2]).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(session.state().pending).toBeUndefined();
  });

  test("parallel permission requests are shown one at a time, each answered once", async () => {
    const session = await boot({ scenario: { turn: { ...PERMISSION_TURN, permissionCount: 2 } } });
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the first permission");
    // Une seule demande à l'écran : la seconde attend.
    expect(permissionAnswers(session.adapter)).toEqual([]);
    session.screen.fire("confirm");
    await waitFor(() => permissionAnswers(session.adapter).length === 1 && permissionPending(session), "the second permission");
    expect(permissionAnswers(session.adapter)[0]).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    session.screen.fire("refuse");
    await waitFor(() => !session.state().turnActive, "the turn end");
    expect(permissionAnswers(session.adapter)).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }, { outcome: { outcome: "selected", optionId: "reject" } }]);
    expect(session.state().pending).toBeUndefined();
  });

  test("an interrupt answers every parallel permission request as cancelled", async () => {
    const session = await boot({ scenario: { turn: { ...PERMISSION_TURN, permissionCount: 2 } } });
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the permission");
    session.screen.fire("interrupt");
    await waitFor(() => !session.state().turnActive, "the turn end");
    expect(permissionAnswers(session.adapter)).toEqual([{ outcome: { outcome: "cancelled" } }, { outcome: { outcome: "cancelled" } }]);
    expect(session.state().pending).toBeUndefined();
  });

  test("a refusal without any reject choice cancels the request", async () => {
    const turn = { ...PERMISSION_TURN, permission: { ...(PERMISSION_TURN.permission as Json), options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } };
    const session = await boot({ scenario: { turn } });
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the permission");
    session.screen.fire("refuse");
    await waitFor(() => !session.state().turnActive, "the turn end");
    expect(permissionAnswers(session.adapter)).toEqual([{ outcome: { outcome: "cancelled" } }]);
  });
});

describe("settings, mode and palette", () => {
  test("nextMode walks the mode values, skips bypassPermissions and wraps, following the agent's answer", async () => {
    const session = await boot();
    const modeValue = (): string | undefined => session.state().options.find((candidate: ConfigOption) => candidate.category === "mode")?.currentValue;
    const sets = (): Json[] => requestsOf(session.adapter, "session/set_config_option");
    expect(modeValue()).toBe("default");
    for (const expected of ["plan", "auto", "default", "plan"]) {
      const before = sets().length;
      session.screen.fire("nextMode");
      await waitFor(() => sets().length === before + 1 && modeValue() === expected, `the mode ${expected}`);
      expect(sets().at(-1)).toMatchObject({ configId: "mode", value: expected });
    }
  });

  test("a refused option value shows a notice and the session goes on", async () => {
    const session = await boot({ scenario: { setOptionError: { code: -32602, message: "Invalid params" } } });
    session.screen.fire("nextMode");
    await waitFor(() => notices(session.state()).length === 1, "the notice");
    expect(notices(session.state())[0]).toBe("Could not change mode: Invalid params");
    expect(session.state().options.find((candidate: ConfigOption) => candidate.category === "mode")?.currentValue).toBe("default");
    session.screen.fire("submit", "still alive");
    await waitFor(() => promptTexts(session.adapter).length === 1, "a prompt after the failure");
  });

  test("confirm in the settings panel applies the selected value", async () => {
    const session = await boot();
    session.screen.openOverlay("settings");
    session.screen.setting = { category: "thought_level", value: "low" };
    session.screen.fire("confirm");
    await waitFor(() => session.state().options.find((candidate: ConfigOption) => candidate.category === "thought_level")?.currentValue === "low", "the effort");
    expect(requestsOf(session.adapter, "session/set_config_option").at(-1)).toMatchObject({ configId: "effort", value: "low" });
  });

  test("confirm on a palette command closes the palette and runs it as a prompt", async () => {
    const session = await boot();
    const command: CommandInfo = { name: "review", description: "Review the diff" };
    session.screen.openOverlay("palette");
    session.screen.palette = command;
    session.screen.input = "a draft stays in the input";
    session.screen.fire("confirm");
    await waitFor(() => promptTexts(session.adapter).length === 1, "the command prompt");
    expect(promptTexts(session.adapter)).toEqual(["/review"]);
    expect(session.screen.overlay()).toBeUndefined();
    expect(session.screen.input).toBe("a draft stays in the input");
  });

  test("confirm on a palette that filters nothing does nothing", async () => {
    const session = await boot();
    session.screen.openOverlay("palette");
    session.screen.fire("confirm");
    await Bun.sleep(50);
    expect(promptTexts(session.adapter)).toEqual([]);
  });

  describe("text typed after a slash on the real screen", () => {
    const REPLAY = { replay: [{ sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review a PR" }, { name: "compact", description: "Compact the context" }] }] };

    /** Tape `text` dans la saisie vide puis ⏎, comme Romain ; quitte au besoin si le test a échoué avant. */
    async function typeAndEnter(real: RealSession, text: string): Promise<void> {
      await real.setup.mockInput.typeText(text);
      real.setup.mockInput.pressEnter();
    }

    async function quitIfStillRunning(real: RealSession): Promise<void> {
      if (real.exits.length === 0) {
        real.setup.mockInput.pressEscape();
        real.setup.mockInput.pressKey("d", { ctrl: true });
      }
      await Promise.race([real.running, Bun.sleep(5000)]);
    }

    test("/quit typed by hand quits with code 0", async () => {
      const real = await bootRealScreen(REPLAY);
      try {
        await typeAndEnter(real, "/quit");
        expect(await Promise.race([real.running, Bun.sleep(3000).then(() => -1)])).toBe(0);
        expect(real.exits).toEqual([0]);
      } finally {
        await quitIfStillRunning(real);
      }
    });

    test("a command with an argument is sent as typed, not as the palette match", async () => {
      const real = await bootRealScreen(REPLAY);
      try {
        await typeAndEnter(real, "/review 42");
        await waitFor(() => promptTexts(real.adapter).length === 1, "the prompt");
        expect(promptTexts(real.adapter)).toEqual(["/review 42"]);
      } finally {
        await quitIfStillRunning(real);
      }
    });

    test("a pasted path is sent as a prompt", async () => {
      const real = await bootRealScreen(REPLAY);
      try {
        await typeAndEnter(real, "/Users/me/notes.md explain this");
        await waitFor(() => promptTexts(real.adapter).length === 1, "the prompt");
        expect(promptTexts(real.adapter)).toEqual(["/Users/me/notes.md explain this"]);
      } finally {
        await quitIfStillRunning(real);
      }
    });

    test("a prefix of a command still runs the selected command", async () => {
      const real = await bootRealScreen(REPLAY);
      try {
        await typeAndEnter(real, "/rev");
        await waitFor(() => promptTexts(real.adapter).length === 1, "the prompt");
        expect(promptTexts(real.adapter)).toEqual(["/review"]);
      } finally {
        await quitIfStillRunning(real);
      }
    });
  });
});

describe("terminal signals", () => {
  test("progress follows the derived status and a permission notifies", async () => {
    const session = await boot({ scenario: { turn: PERMISSION_TURN } });
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the permission");
    session.screen.fire("confirm");
    await waitFor(() => !session.state().turnActive, "the turn end");
    // En cours, en attente de Romain (progression éteinte, notification), en cours de nouveau, repos.
    expect(session.osc).toEqual([PROGRESS_ON, PROGRESS_OFF, NOTIFY(`${session.name}: waiting for you`), PROGRESS_ON, PROGRESS_OFF]);
  });

  test("cancelling parallel permission requests never notifies again for the ones that were waiting", async () => {
    const session = await boot({ scenario: { turn: { ...PERMISSION_TURN, permissionCount: 3 } } });
    const notifications = () => session.osc.filter((bytes) => bytes === NOTIFY(`${session.name}: waiting for you`)).length;
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the first permission");
    // Les deux autres demandes sont arrivées derrière la première.
    await Bun.sleep(200);
    expect(notifications()).toBe(1);
    session.screen.fire("interrupt");
    await waitFor(() => !session.state().turnActive, "the turn end");
    expect(permissionAnswers(session.adapter)).toHaveLength(3);
    expect(notifications()).toBe(1);
  });

  test("the exit settles waiting permission requests without notifying for them", async () => {
    const session = await boot({ scenario: { turn: { ...PERMISSION_TURN, permissionCount: 3 } } });
    const notifications = () => session.osc.filter((bytes) => bytes === NOTIFY(`${session.name}: waiting for you`)).length;
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the first permission");
    await Bun.sleep(200);
    session.screen.fire("quit");
    expect(await session.running).toBe(0);
    expect(notifications()).toBe(1);
  });

  test("a progress left on by a running turn is switched off when the session exits", async () => {
    const session = await boot({ scenario: { turn: { delayMs: 5000 } } });
    session.screen.fire("submit", "slow");
    await waitFor(() => session.osc.includes(PROGRESS_ON), "the progress to be on");
    session.screen.fire("quit");
    expect(await session.running).toBe(0);
    expect(session.osc).toEqual([PROGRESS_ON, PROGRESS_OFF]);
  });
});

describe("peer messages", () => {
  test("a peer message to an idle Claude opens a turn and the final answer goes back", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ scenario: { turn: { updates: [agentChunk("Looking"), toolCall("tool-1"), agentChunk("Done: pong")] } } });
    const msgId = await sendFromPeer(zeus, session.name, "reply pong");
    await waitFor(() => contentsOf(zeus).length === 1, "the answer to the peer");
    expect(promptTexts(session.adapter)).toEqual([`[idnma] Message from codex-zeus. Your final answer is sent back to codex-zeus automatically; do not send it yourself.\nreply pong`]);
    expect(contentsOf(zeus)[0]).toContain("[réponse automatique idnma]\nDone: pong");
    expect(session.state().thread[0]).toEqual({ kind: "peer", from: "codex-zeus", text: "reply pong" });
    expect(logsOf("unified-prompt")).toEqual([expect.objectContaining({ origin: "peer", msgId })]);
  });

  test("a peer turn that fails tells the peer it was interrupted", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ scenario: { promptError: { code: -32602, message: "Invalid params" } } });
    await sendFromPeer(zeus, session.name, "reply pong");
    await waitFor(() => contentsOf(zeus).length === 1, "the answer to the peer");
    expect(contentsOf(zeus)[0]).toContain(`${session.name} : tour interrompu`);
    expect(notices(session.state())).toContain("Turn failed: Invalid params");
  });

  test("at the end of a turn the local queue goes before the next peer message", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ scenario: { turn: PERMISSION_TURN } });
    session.screen.fire("submit", "first");
    await waitFor(() => permissionPending(session), "the first permission");
    session.screen.fire("submit", "second");
    await sendFromPeer(zeus, session.name, "peer question");
    await Bun.sleep(100);
    // Le tour en cours n'est jamais interrompu par le pair.
    expect(promptTexts(session.adapter)).toEqual(["first"]);

    session.screen.fire("confirm");
    await waitFor(() => permissionPending(session) && promptTexts(session.adapter).length === 2, "the second turn");
    session.screen.fire("confirm");
    await waitFor(() => permissionPending(session) && promptTexts(session.adapter).length === 3, "the peer turn");
    session.screen.fire("confirm");
    await waitFor(() => !session.state().turnActive && contentsOf(zeus).length === 1, "the reply to the peer");
    expect(promptTexts(session.adapter)[1]).toBe("second");
    expect(promptTexts(session.adapter)[2]).toContain("peer question");
    expect(logsOf("unified-prompt").map((line) => line.origin)).toEqual(["user", "user", "peer"]);
  });

  test("a held peer message logs no prompt before Deliver", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ harness: "agy", scenario: { turn: { updates: [agentChunk("pong")] } } });
    const msgId = await sendFromPeer(zeus, session.name, "reply pong");
    await waitFor(() => session.state().pending?.kind === "held", "the held card");
    expect(session.state().pending).toMatchObject({ kind: "held", from: "codex-zeus", text: "reply pong" });
    expect(session.state().heldCount).toBe(1);
    // Aucun prompt n'est parti, ni dans le journal ni vers l'agent.
    expect(logsOf("unified-prompt")).toEqual([]);
    expect(promptTexts(session.adapter)).toEqual([]);

    session.screen.fire("confirm");
    await waitFor(() => contentsOf(zeus).length === 1, "the reply to the peer");
    expect(logsOf("unified-prompt")).toEqual([expect.objectContaining({ origin: "peer", msgId })]);
    expect(promptTexts(session.adapter)).toHaveLength(1);
    expect(contentsOf(zeus)[0]).toContain("pong");
    expect(session.state().pending).toBeUndefined();
    expect(session.state().heldCount).toBe(0);
  });

  test("Dismiss and esc on a held message send the sender a not-delivered notice", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ harness: "agy" });
    await sendFromPeer(zeus, session.name, "first");
    await waitFor(() => session.state().pending?.kind === "held", "the held card");
    session.screen.fire("selectDown");
    session.screen.fire("selectDown");
    session.screen.fire("confirm");
    await waitFor(() => contentsOf(zeus).length === 1, "the first notice");
    expect(contentsOf(zeus)[0]).toContain("message non livré (écarté dans l'écran)");

    await sendFromPeer(zeus, session.name, "second");
    await waitFor(() => session.state().pending?.kind === "held", "the second held card");
    session.screen.fire("refuse");
    await waitFor(() => contentsOf(zeus).length === 2, "the second notice");
    expect(logsOf("unified-prompt")).toEqual([]);
    expect(session.state().pending).toBeUndefined();
  });

  test("Later keeps the message, a later arrival only raises the count, and reopenHeld shows the first again", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ harness: "agy" });
    await sendFromPeer(zeus, session.name, "first");
    await waitFor(() => session.state().pending?.kind === "held", "the held card");
    session.screen.fire("selectDown");
    session.screen.fire("confirm");
    expect(session.state().pending).toBeUndefined();
    expect(session.state().heldCount).toBe(1);

    await sendFromPeer(zeus, session.name, "second");
    await waitFor(() => session.state().heldCount === 2, "the count");
    expect(session.state().pending).toBeUndefined();

    session.screen.fire("reopenHeld");
    await waitFor(() => session.state().pending?.kind === "held", "the reopened card");
    expect(session.state().pending).toMatchObject({ kind: "held", text: "first" });
    expect(logsOf("unified-prompt")).toEqual([]);
  });
});

describe("control channel", () => {
  /** L'environnement que l'agent reçoit : de quoi appeler le canal comme `idnma peer send` le ferait. */
  async function agentEnv(session: Session): Promise<Record<string, string>> {
    await waitFor(() => existsSync(session.adapter.envDump), "the environment dump");
    return JSON.parse(readFileSync(session.adapter.envDump, "utf8")) as Record<string, string>;
  }

  test("read and hook on the control channel never drain the delivery queue", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ harness: "agy", scenario: { turn: { updates: [agentChunk("pong")] } } });
    const env = await agentEnv(session);
    await sendFromPeer(zeus, session.name, "reply pong");
    await waitFor(() => session.state().pending?.kind === "held", "the held card");

    expect(await controlRequest({ op: "read" }, env)).toEqual({ ok: true, message: null });
    expect(await controlRequest({ op: "hook", harness: "agy", event: "PreToolUse", payload: {} }, env)).toEqual({ ok: true, reply: {} });
    // La file est intacte : le message est toujours là pour « Deliver ».
    expect(session.state().heldCount).toBe(1);
    session.screen.fire("confirm");
    await waitFor(() => contentsOf(zeus).length === 1, "the reply to the peer");
    expect(promptTexts(session.adapter)[0]).toContain("reply pong");
  });

  test("an agent writes to a peer under the idnma name, with the from-mode of the session", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot();
    const env = await agentEnv(session);

    const response = await controlRequest({ op: "send", to: "codex-zeus", body: "ping" }, env);
    expect(response.ok).toBe(true);
    await waitFor(() => contentsOf(zeus).length === 1, "the message");
    expect(contentsOf(zeus)[0]).toContain(`from-name="${session.name}"`);
    expect(contentsOf(zeus)[0]).toContain('from-mode="prompting"');

    // Le mode réel de la session est relu à chaque envoi : bypass, puis de nouveau prompting.
    session.screen.openOverlay("settings");
    session.screen.setting = { category: "mode", value: "bypassPermissions" };
    session.screen.fire("confirm");
    await waitFor(() => session.state().options.find((candidate: ConfigOption) => candidate.category === "mode")?.currentValue === "bypassPermissions", "the bypass mode");
    await controlRequest({ op: "send", to: "codex-zeus", body: "ping 2" }, env);
    await waitFor(() => contentsOf(zeus).length === 2, "the second message");
    expect(contentsOf(zeus)[1]).toContain('from-mode="bypass"');

    session.screen.fire("nextMode");
    await waitFor(() => session.state().options.find((candidate: ConfigOption) => candidate.category === "mode")?.currentValue === "default", "the default mode");
    await controlRequest({ op: "send", to: "codex-zeus", body: "ping 3" }, env);
    await waitFor(() => contentsOf(zeus).length === 3, "the third message");
    expect(contentsOf(zeus)[2]).toContain('from-mode="prompting"');
  });

  test("the from-mode of agy follows its skip-permissions flag", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ harness: "agy", engine: { options: ["--dangerously-skip-permissions"] } });
    const env = await agentEnv(session);
    await controlRequest({ op: "send", to: "codex-zeus", body: "ping" }, env);
    await waitFor(() => contentsOf(zeus).length === 1, "the message");
    expect(contentsOf(zeus)[0]).toContain('from-mode="bypass"');
  });

  test("list leaves out the process itself and a session nested under it, and keeps the others", async () => {
    const zeus = await startFakePeer("codex-zeus");
    // Le sleeper de ce faux pair est un vrai enfant du process de test, qui joue ici le process idnma.
    const inner = await startFakePeer("opus-mars-ab12-acp", {}, { nested: true });
    peers.push(zeus, inner);
    const session = await boot();
    const env = await agentEnv(session);
    const response = await controlRequest({ op: "list" }, env);
    expect(response).toEqual({ ok: true, peers: [{ name: "codex-zeus", status: "idle" }] });
  });

  test("send without a registration on the bus is an error answer", async () => {
    const intruder = await startFakePeer("claude-old", { peerProtocol: 2 });
    peers.push(intruder);
    const session = await boot();
    const env = await agentEnv(session);
    expect(await controlRequest({ op: "send", to: "claude-old", body: "x" }, env)).toEqual({ ok: false, error: "pas d'inscription au bus" });
  });
});

describe("agent death", () => {
  test("agent exit mid-turn shows its code and waits for a key", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ scenario: { exitDuringPrompt: 3 } });
    const msgId = await sendFromPeer(zeus, session.name, "reply pong");
    await waitFor(() => session.state().exit !== undefined, "the exit banner");
    expect(session.state().exit).toEqual({ code: 3, signal: null });
    expect(session.state().status).toBe("exited");
    // Le pair du tour en cours apprend que sa réponse est perdue, sans seconde annonce « Turn failed ».
    await waitFor(() => contentsOf(zeus).length === 1, "the lost reply");
    expect(contentsOf(zeus)[0]).toContain(`${session.name} : réponse perdue (agent arrêté)`);
    expect(notices(session.state())).toEqual([]);
    expect(session.exits).toEqual([]);
    await waitFor(() => statusOfRunner(runnerEntry()) === "idle", "the idle registry status");

    // Après la mort de l'agent, un message de pair n'ouvre plus de tour : il est refusé à la sortie.
    await sendFromPeer(zeus, session.name, "second question");
    await Bun.sleep(100);
    expect(logsOf("unified-prompt")).toEqual([expect.objectContaining({ origin: "peer", msgId })]);
    expect(requestsOf(session.adapter, "session/prompt")).toHaveLength(1);

    // Une touche après la mort de l'agent : sortie anormale.
    session.screen.fire("quit");
    await session.running;
    expect(session.exits).toEqual([1]);
    expect(contentsOf(zeus)).toHaveLength(2);
    expect(contentsOf(zeus)[1]).toContain("message non livré");
    nothingLeftBehind();
  });
});

describe("exit path", () => {
  test("/quit exits 0 after refusing the queue, removing the registration and killing the agent group", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const grandchild = join(workDir, "grandchild.pid");
    grandchildFiles.push(grandchild);
    const session = await boot({ scenario: { turn: PERMISSION_TURN, spawnGrandchild: grandchild } });
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the permission");
    await sendFromPeer(zeus, session.name, "too late");
    await Bun.sleep(100);

    session.screen.fire("submit", "/quit");
    // Le terminal revient d'abord : l'écran est détruit avant que l'inscription soit retirée.
    await waitFor(() => session.screen.destroyed, "the screen to be destroyed");
    expect(await session.running).toBe(0);
    expect(session.exits).toEqual([0]);
    nothingLeftBehind();
    await waitFor(() => contentsOf(zeus).length === 1, "the refusal");
    expect(contentsOf(zeus)[0]).toContain("message non livré (Claude a quitté le bus)");
    const pid = Number(readFileSync(grandchild, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("the exit path runs once however many times it is asked", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const session = await boot({ scenario: { turn: PERMISSION_TURN } });
    session.screen.fire("submit", "go");
    await waitFor(() => permissionPending(session), "the permission");
    await sendFromPeer(zeus, session.name, "too late");
    await Bun.sleep(100);
    session.screen.fire("quit");
    session.screen.fire("quit");
    session.screen.fire("submit", "/quit");
    await session.running;
    await Bun.sleep(50);
    expect(session.exits).toEqual([0]);
    expect(contentsOf(zeus)).toHaveLength(1);
  });

  test("no render reaches the screen after destroy, even from events that arrive during the exit", async () => {
    const session = await boot({ scenario: { turn: { updates: [agentChunk("a"), agentChunk("b"), agentChunk("c")] } } });
    session.screen.fire("submit", "stream");
    session.screen.fire("quit");
    await session.running;
    await Bun.sleep(100);
    expect(session.screen.rendersAfterDestroy).toBe(0);
  });

  test("a throwing intent handler is logged and never reaches the screen", async () => {
    const session = await boot();
    session.screen.failClearInput = true;
    expect(() => session.screen.fire("submit", "hello")).not.toThrow();
    expect(() => session.screen.fire("clearInput")).not.toThrow();
    const failures = logsOf("unified-intent-error");
    expect(failures).toEqual([
      expect.objectContaining({ intent: "submit", message: "clear failed" }),
      expect.objectContaining({ intent: "clearInput", message: "clear failed" }),
    ]);
    // Rien n'est parti vers l'agent : l'intention a échoué avant le prompt.
    expect(promptTexts(session.adapter)).toEqual([]);
  });
});

describe("signals and crashes in a child process", () => {
  interface Child {
    process: ReturnType<typeof Bun.spawn>;
    marker: string;
    grandchild: string;
  }

  function spawnChild(mode: "sigterm" | "early" | "crash" | "hardexit"): Child {
    const adapter = makeAdapter({ turn: PERMISSION_TURN, spawnGrandchild: join(workDir, "child-grandchild.pid"), ...(mode === "early" ? { neverAnswers: true } : {}) });
    const marker = join(workDir, "child-marker.txt");
    writeFileSync(marker, "");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    Object.assign(env, { UNIFIED_CHILD_SHIM: adapter.path, UNIFIED_CHILD_MODE: mode, UNIFIED_CHILD_MARKER: marker });
    // Le process de test résout `bun` lui-même : son PATH ne contient que les outils du test.
    const child = Bun.spawn([process.execPath, CHILD], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    grandchildFiles.push(join(workDir, "child-grandchild.pid"));
    return { process: child, marker, grandchild: join(workDir, "child-grandchild.pid") };
  }

  const markers = (child: Child): string[] => readFileSync(child.marker, "utf8").split("\n").filter((line) => line !== "");

  test("SIGTERM during a turn cleans up", async () => {
    const zeus = await startFakePeer("codex-zeus");
    peers.push(zeus);
    const child = spawnChild("sigterm");
    try {
      await waitFor(() => markers(child).includes("permission"), "the child to wait on its permission", 15_000);
      const entry = listLiveEntries().find((candidate) => candidate.pid === child.process.pid);
      expect(entry).toBeDefined();
      await sendFromPeer(zeus, entry!.name, "too late");
      await Bun.sleep(200);

      child.process.kill("SIGTERM");
      expect(await child.process.exited).toBe(143);
      // Message en file refusé, entrée du registre retirée, socket de contrôle retiré, groupe de l'agent mort.
      await waitFor(() => contentsOf(zeus).length === 1, "the refusal");
      expect(contentsOf(zeus)[0]).toContain("message non livré (Claude a quitté le bus)");
      expect(listLiveEntries().find((candidate) => candidate.pid === child.process.pid)).toBeUndefined();
      expect(existsSync(controlSocketPath(child.process.pid))).toBe(false);
      const pid = Number(readFileSync(child.grandchild, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      child.process.kill("SIGKILL");
    }
  }, 30_000);

  test("a crash logs the failure and exits 1 through the same cleanup", async () => {
    const child = spawnChild("crash");
    try {
      expect(await child.process.exited).toBe(1);
      expect(logsOf("unified-crash")).toEqual([expect.objectContaining({ message: "boom" })]);
      expect(listLiveEntries().find((candidate) => candidate.pid === child.process.pid)).toBeUndefined();
      expect(existsSync(controlSocketPath(child.process.pid))).toBe(false);
    } finally {
      child.process.kill("SIGKILL");
    }
  }, 30_000);

  test("SIGTERM while the session is still opening stops the startup and cleans up", async () => {
    const child = spawnChild("early");
    try {
      // L'agent ne répond jamais à `initialize` : l'inscription et le canal existent, l'écran jamais.
      await waitFor(() => listLiveEntries().some((candidate) => candidate.pid === child.process.pid) && existsSync(controlSocketPath(child.process.pid)) && existsSync(child.grandchild), "the child to be registered and its agent started", 15_000);
      child.process.kill("SIGTERM");
      expect(await child.process.exited).toBe(143);
      expect(markers(child)).toEqual([]);
      expect(listLiveEntries().find((candidate) => candidate.pid === child.process.pid)).toBeUndefined();
      expect(existsSync(controlSocketPath(child.process.pid))).toBe(false);
      const pid = Number(readFileSync(child.grandchild, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      child.process.kill("SIGKILL");
    }
  }, 30_000);

  test("the process exit handler is the last resort that kills a surviving agent group", async () => {
    const child = spawnChild("hardexit");
    try {
      // `process.exit` direct : ni signal, ni chemin de sortie, l'agent vit encore au moment de l'arrêt.
      expect(await child.process.exited).toBe(7);
      const pid = Number(readFileSync(child.grandchild, "utf8"));
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, "the agent group to be killed");
    } finally {
      child.process.kill("SIGKILL");
    }
  }, 30_000);
});
