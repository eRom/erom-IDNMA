import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { addressOf } from "../src/bus/envelope.ts";
import type { InboundMessage } from "../src/bus/inbox.ts";
import { keyFileName } from "../src/bus/key.ts";
import { listLiveEntries } from "../src/bus/registry.ts";
import { registerPeer, type Registration } from "../src/bus/register.ts";
import { PeerError } from "../src/bus/send.ts";
import { connectDaemon } from "../src/codex/daemon.ts";
import { createCodexCourier } from "../src/codex/courier.ts";
import { isDescendantOf } from "../src/bus/peer-pid.ts";
import {
  codexPointerPath,
  controlRequest,
  controlSocketPath,
  removeCodexPointer,
  startControlServer,
  writeCodexPointer,
  type VerifyCaller,
} from "../src/understudy/control.ts";
import { AUTO_REPLY_MARKER, CourierUnavailableError, isAutoReply, type Courier } from "../src/understudy/courier.ts";
import { runUnderstudy } from "../src/understudy/understudy.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import type { Terminal } from "../src/understudy/pty.ts";
import { codexDaemonSocket, sessionsDir } from "../src/paths.ts";
import { startFakeCodexDaemon, type FakeCodexDaemon } from "./helpers/fake-codex-daemon.ts";
import { startFakePeer, type FakePeer } from "./helpers/fake-peer.ts";

// Tout test qui lance un enfant porte un délai de 15 s.
const childTest = (title: string, body: () => Promise<void>): void => test(title, body, { timeout: 15_000 });
const REPO = join(import.meta.dir, "..");
const NO_PENDING_PUSHED_TURNS =
  "idnma : chez Codex, opencode, dst et pi, les messages de pairs arrivent d'eux-mêmes, chacun comme un nouveau tour : idnma read n'a rien à rendre.\n";
const THREAD = "01a179b5-b063-74a3-8b58-1ef7941809f1";

const ENV_KEYS = ["CODEX_HOME", "IDNMA_CONFIG_DIR", "IDNMA_CLAUDE_DIR", "IDNMA_SOCKETS_DIR", "IDNMA_CONTROL_DIR", "IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN", "DSH_IDNMA_CONTROL_TOKEN"] as const;
let previousEnv: Record<string, string | undefined>;
let tempDirs: string[];
let registrations: Registration[];
let peers: FakePeer[];
let queue: MessageQueue;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ["IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN", "DSH_IDNMA_CONTROL_TOKEN"]) delete process.env[key];
  tempDirs = [mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-")];
  // Journal de la doublure (idnma.log) : jamais dans le dossier de config de prod.
  process.env.IDNMA_CONFIG_DIR = tempDirs[3];
  process.env.IDNMA_CLAUDE_DIR = tempDirs[0];
  process.env.IDNMA_SOCKETS_DIR = tempDirs[1];
  // Sous-dossier absent : la création du dossier de contrôle (700) fait partie du comportement testé.
  process.env.IDNMA_CONTROL_DIR = join(tempDirs[2]!, "ctl");
  registrations = [];
  peers = [];
  queue = new MessageQueue();
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

function logLines(): Record<string, unknown>[] {
  const path = join(process.env.IDNMA_CONFIG_DIR!, "logs", "idnma.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const answerNothing = async () => ({ ok: true as const, message: null });

function inbound(content: string): InboundMessage {
  return { priority: "next", content, authenticated: true, receivedAt: Date.now() };
}

async function register(name: string): Promise<Registration> {
  const registration = await registerPeer({ name, cwd: "/w", onMessage: (message) => queue.push(message) });
  registrations.push(registration);
  return registration;
}

async function waitFor(condition: () => boolean, label: string, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

interface Running {
  done: Promise<number>;
  control: Promise<{ socketPath: string; token: string }>;
}

/** Lance une doublure sur `argv` et rend la promesse de son code et celle de son canal de contrôle. */
function launch(
  argv: string[],
  registration: Registration | null,
  fromMode: "bypass" | "prompting" = "bypass",
  codex?: { verifyCaller?: VerifyCaller; threadId: string },
  courier?: Courier,
  extra: { exportControlEnv?: boolean; env?: Record<string, string>; harnessLabel?: string; farewellWaitMs?: number } = {},
): Running {
  let ready!: (c: { socketPath: string; token: string }) => void;
  const control = new Promise<{ socketPath: string; token: string }>((resolveControl) => {
    ready = resolveControl;
  });
  const done = runUnderstudy({
    name: "codex-janus",
    argv,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra.env },
    fromMode,
    registration,
    queue,
    verifyCaller: codex?.verifyCaller,
    courier,
    ...(extra.exportControlEnv === undefined ? {} : { exportControlEnv: extra.exportControlEnv }),
    ...(extra.harnessLabel === undefined ? {} : { harnessLabel: extra.harnessLabel }),
    ...(extra.farewellWaitMs === undefined ? {} : { farewellWaitMs: extra.farewellWaitMs }),
    onControlReady: (c) => {
      if (codex !== undefined) writeCodexPointer(codex.threadId, c.socketPath);
      ready(c);
    },
  });
  return { done, control };
}

describe("control channel through runUnderstudy", () => {
  childTest("read hands back queued messages in order, then null", async () => {
    const registration = await register("codex-janus");
    queue.push(inbound("premier"));
    queue.push(inbound("second"));
    const running = launch(["sleep", "2"], registration);
    const { socketPath, token } = await running.control;
    const env = { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token };

    expect(await controlRequest({ op: "read" }, env)).toEqual({ ok: true, message: "premier" });
    expect(await controlRequest({ op: "read" }, env)).toEqual({ ok: true, message: "second" });
    expect(await controlRequest({ op: "read" }, env)).toEqual({ ok: true, message: null });
    await running.done;
  });

  childTest("read returns a 200 KiB message intact", async () => {
    const registration = await register("codex-janus");
    const big = "é".repeat(100 * 1024) + "fin";
    queue.push(inbound(big));
    const running = launch(["sleep", "2"], registration);
    const { socketPath, token } = await running.control;

    const response = await controlRequest({ op: "read" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token });
    expect(response).toEqual({ ok: true, message: big });
    await running.done;
  });

  childTest("send reaches the peer under a canonical envelope with from-name and from-mode", async () => {
    const peer = await startFakePeer("claude-vulcain");
    peers.push(peer);
    const registration = await register("codex-janus");
    const running = launch(["sleep", "2"], registration, "bypass");
    const { socketPath, token } = await running.control;

    const response = await controlRequest({ op: "send", to: "claude-vulcain", body: "bonjour" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token });
    expect(response.ok).toBe(true);
    await waitFor(() => peer.lines.some((line) => (line as { type?: string }).type === "user"), "user frame");
    const frame = peer.lines.find((line) => (line as { type?: string }).type === "user") as { message: { content: string }; msg_id: string };
    expect(response).toEqual({ ok: true, msgId: frame.msg_id });
    expect(frame.message.content).toContain('from-name="codex-janus" from-mode="bypass"');
    expect(frame.message.content).toContain("\nbonjour\n");
    await running.done;
  });

  childTest("send to an unknown peer reports the bus error to the caller", async () => {
    const registration = await register("codex-janus");
    const running = launch(["sleep", "2"], registration);
    const { socketPath, token } = await running.control;

    const response = await controlRequest({ op: "send", to: "claude-absent", body: "x" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token });
    expect(response).toEqual({ ok: false, error: "aucun pair vivant nommé « claude-absent » ; aucun autre pair n'est vivant" });
    await running.done;
  });

  childTest("send without a bus registration is refused", async () => {
    const running = launch(["sleep", "2"], null);
    const { socketPath, token } = await running.control;

    const response = await controlRequest({ op: "send", to: "claude-vulcain", body: "x" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token });
    expect(response).toEqual({ ok: false, error: "pas d'inscription au bus" });
    await running.done;
  });

  childTest("list leaves out the understudy itself and hands back the other reachable peers sorted, reduced to name, status and tmux", async () => {
    peers.push(await startFakePeer("claude-zeta", { status: "busy", tmux: "main:1.0" }), await startFakePeer("claude-alpha"));
    const registration = await register("codex-janus");
    const running = launch(["sleep", "2"], registration);
    const { socketPath, token } = await running.control;

    const response = await controlRequest({ op: "list" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token });
    expect(response).toEqual({
      ok: true,
      peers: [
        { name: "claude-alpha", status: "idle" },
        { name: "claude-zeta", status: "busy", tmux: "main:1.0" },
      ],
    });
    // Les trames sont réduites : rien d'autre que ces trois champs ne sort de la doublure.
    if (!response.ok || !("peers" in response)) throw new Error("expected a peers answer");
    expect(Object.keys(response.peers[1]!).sort()).toEqual(["name", "status", "tmux"]);
    await running.done;
  });

  childTest("list leaves out a peer that has no messaging socket", async () => {
    const ghost = await startFakePeer("claude-ghost");
    peers.push(ghost, await startFakePeer("claude-vulcain"));
    const path = join(process.env.IDNMA_CLAUDE_DIR!, `${ghost.entry.pid}.json`);
    const { messagingSocketPath: _removed, ...withoutSocket } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    await Bun.write(path, JSON.stringify(withoutSocket));
    const registration = await register("codex-janus");
    const running = launch(["sleep", "2"], registration);
    const { socketPath, token } = await running.control;

    const response = await controlRequest({ op: "list" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token });
    expect(response).toEqual({ ok: true, peers: [{ name: "claude-vulcain", status: "idle" }] });
    await running.done;
  });

  childTest("controlRequest with only DSH_IDNMA_CONTROL_TOKEN reaches the understudy", async () => {
    const registration = await register("codex-janus");
    queue.push(inbound("pour dst"));
    const running = launch(["sleep", "2"], registration);
    const { socketPath, token } = await running.control;

    expect(await controlRequest({ op: "read" }, { IDNMA_CONTROL_SOCKET: socketPath, DSH_IDNMA_CONTROL_TOKEN: token })).toEqual({ ok: true, message: "pour dst" });
    await running.done;
  });

  childTest("IDNMA_CONTROL_TOKEN wins over DSH_IDNMA_CONTROL_TOKEN when both are set", async () => {
    const registration = await register("codex-janus");
    const running = launch(["sleep", "2"], registration);
    const { socketPath, token } = await running.control;

    const good = await controlRequest({ op: "read" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token, DSH_IDNMA_CONTROL_TOKEN: "wrong-token-test" });
    expect(good).toEqual({ ok: true, message: null });
    const bad = await controlRequest({ op: "read" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: "wrong-token-test", DSH_IDNMA_CONTROL_TOKEN: token });
    expect(bad).toEqual({ ok: false, error: "jeton de contrôle invalide" });
    await running.done;
  });

  childTest("a wrong token is rejected and the queue is left untouched", async () => {
    const registration = await register("codex-janus");
    queue.push(inbound("secret"));
    const running = launch(["sleep", "2"], registration);
    const { socketPath, token } = await running.control;

    const response = await controlRequest({ op: "read" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: "0".repeat(token.length) });
    expect(response).toEqual({ ok: false, error: "jeton de contrôle invalide" });
    expect(queue.size).toBe(1);
    await running.done;
  });

  childTest("the control socket is 600 inside a 700 directory and the child receives its variables", async () => {
    const registration = await register("codex-janus");
    const out = join(tempDirs[2]!, "child-env.txt");
    const running = launch(["sh", "-c", `printf '%s\\n%s\\n%s\\n' "$IDNMA_NAME" "$IDNMA_CONTROL_SOCKET" "$IDNMA_CONTROL_TOKEN" > ${out}`], registration);
    const { socketPath, token } = await running.control;

    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(process.env.IDNMA_CONTROL_DIR!).mode & 0o777).toBe(0o700);
    expect(socketPath).toBe(join(process.env.IDNMA_CONTROL_DIR!, `${process.pid}.sock`));
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    await running.done;
    expect(readFileSync(out, "utf8").split("\n").slice(0, 3)).toEqual(["codex-janus", socketPath, token]);
  });
});

describe("control environment export", () => {
  const childEnvLines = async (extra: { exportControlEnv?: boolean }): Promise<string[]> => {
    const registration = await register("codex-janus");
    const out = join(tempDirs[2]!, "child-env.txt");
    // Un parent qui porte déjà un jeton (lancé depuis un autre agent) ne le passe pas non plus.
    const inherited = { IDNMA_NAME: "autre", IDNMA_CONTROL_SOCKET: "/tmp/autre.sock", IDNMA_CONTROL_TOKEN: "autre-jeton" };
    const running = launch(["sh", "-c", `env > ${out}`], registration, "bypass", undefined, undefined, { ...extra, env: inherited });
    expect(await running.done).toBe(0);
    return readFileSync(out, "utf8").split("\n");
  };

  childTest("exportControlEnv false gives the child none of the three control variables", async () => {
    const lines = await childEnvLines({ exportControlEnv: false });
    for (const key of ["IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN"]) {
      expect(lines.filter((line) => line.startsWith(`${key}=`))).toEqual([]);
    }
    expect(lines.some((line) => line.startsWith("PATH="))).toBe(true);
  });

  childTest("the control variables are exported by default", async () => {
    const lines = await childEnvLines({});
    // Pas de `toContain` sur les lignes entières : un échec afficherait le jeton.
    expect(lines.includes("IDNMA_NAME=codex-janus")).toBe(true);
    expect(lines.filter((line) => line.startsWith("IDNMA_CONTROL_SOCKET=")).length).toBe(1);
    expect(lines.filter((line) => line.startsWith("IDNMA_CONTROL_TOKEN=")).length).toBe(1);
  });
});

/** Commande d'un agent Codex : ni jeton ni socket hérités, seulement l'identifiant de thread. */
function codexCommand(): string[] {
  const control = `IDNMA_CONTROL_DIR=${process.env.IDNMA_CONTROL_DIR}`;
  return ["sh", "-c", `env -u IDNMA_CONTROL_SOCKET -u IDNMA_CONTROL_TOKEN CODEX_THREAD_ID=${THREAD} ${control} bun ${REPO}/src/cli.ts peer send claude-vulcain bonjour > /dev/null`];
}

describe("codex command identity (AC-9)", () => {
  childTest("a command descending from the daemon is admitted and sent as codex-janus", async () => {
    const peer = await startFakePeer("claude-vulcain");
    peers.push(peer);
    const registration = await register("codex-janus");
    // Le process de test joue le daemon Codex : la commande en descend.
    const verifyCaller: VerifyCaller = async (claim, pid) => claim.codexThreadId === THREAD && pid !== undefined && isDescendantOf(pid, process.pid);
    const running = launch(codexCommand(), registration, "bypass", { verifyCaller, threadId: THREAD });
    expect(await running.done).toBe(0);
    await waitFor(() => peer.lines.some((line) => (line as { type?: string }).type === "user"), "user frame");
    const frame = peer.lines.find((line) => (line as { type?: string }).type === "user") as { message: { content: string } };
    expect(frame.message.content).toContain('from-name="codex-janus"');
    expect(frame.message.content).toContain("\nbonjour\n");
  });

  childTest("read from a codex command says its messages arrive as turns, not through read", async () => {
    const registration = await register("codex-janus");
    const verifyCaller: VerifyCaller = async (claim, pid) => claim.codexThreadId === THREAD && pid !== undefined && isDescendantOf(pid, process.pid);
    const outFile = join(tempDirs[2]!, "codex-read.txt");
    const control = `IDNMA_CONTROL_DIR=${process.env.IDNMA_CONTROL_DIR}`;
    const command = `env -u IDNMA_CONTROL_SOCKET -u IDNMA_CONTROL_TOKEN CODEX_THREAD_ID=${THREAD} ${control} bun ${REPO}/src/cli.ts read > ${outFile}`;
    const running = launch(["sh", "-c", command], registration, "bypass", { verifyCaller, threadId: THREAD });
    expect(await running.done).toBe(0);
    expect(readFileSync(outFile, "utf8")).toBe(NO_PENDING_PUSHED_TURNS);
  });

  childTest("read from an opencode command, with a live understudy and no message, says its messages arrive as turns", async () => {
    const registration = await register("opencode-janus");
    const outFile = join(tempDirs[2]!, "opencode-read.txt");
    // La commande d'opencode porte le socket et le jeton de sa doublure, et OPENCODE_SESSION_ID de sa session.
    const running = launch(["sh", "-c", `OPENCODE_SESSION_ID=ses_x bun ${REPO}/src/cli.ts read > ${outFile}`], registration, "bypass");
    expect(await running.done).toBe(0);
    expect(readFileSync(outFile, "utf8")).toBe(NO_PENDING_PUSHED_TURNS);
  });

  childTest("a command that does not descend from the daemon is refused and nothing is sent", async () => {
    const peer = await startFakePeer("claude-vulcain");
    peers.push(peer);
    const registration = await register("codex-janus");
    const unrelated = Bun.spawn(["sleep", "30"]);
    try {
      const verifyCaller: VerifyCaller = async (_claim, pid) => pid !== undefined && isDescendantOf(pid, unrelated.pid);
      const errFile = join(tempDirs[2]!, "refused.txt");
      const [shell, flag, command] = codexCommand();
      const running = launch([shell!, flag!, `${command} 2> ${errFile}`], registration, "bypass", { verifyCaller, threadId: THREAD });
      expect(await running.done).toBe(1);
      expect(readFileSync(errFile, "utf8")).toContain("appelant refusé");
      expect(peer.lines.some((line) => (line as { type?: string }).type === "user")).toBe(false);
    } finally {
      unrelated.kill();
    }
  });

  childTest("a verifier that throws refuses the caller", async () => {
    const registration = await register("codex-janus");
    const running = launch(["sleep", "2"], registration, "bypass", {
      verifyCaller: async () => {
        throw new Error("boom");
      },
      threadId: THREAD,
    });
    const { socketPath } = await running.control;
    const response = await rawRequest(socketPath, { op: "read", codexThreadId: THREAD });
    expect(response).toEqual({ ok: false, error: "appelant refusé : cette commande ne descend pas du thread Codex de cette doublure" });
    await running.done;
  });

  test("a codex request is refused when the server has no verifier, and the handler stays untouched", async () => {
    const socketPath = join(tempDirs[2]!, "nov.sock");
    let calls = 0;
    const server = await startControlServer({
      socketPath,
      token: "tok",
      handle: async () => {
        calls += 1;
        return { ok: true, message: null };
      },
    });
    try {
      const response = await rawRequest(socketPath, { op: "read", codexThreadId: THREAD });
      expect(response).toEqual({ ok: false, error: "appelant refusé : cette commande ne descend pas du thread Codex de cette doublure" });
      expect(calls).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("a wrong token next to a valid thread id is refused without consulting the verifier", async () => {
    const socketPath = join(tempDirs[2]!, "tok.sock");
    let verified = 0;
    let calls = 0;
    const server = await startControlServer({
      socketPath,
      token: "tok",
      handle: async () => {
        calls += 1;
        return { ok: true, message: null };
      },
      verifyCaller: async () => {
        verified += 1;
        return true;
      },
    });
    try {
      const response = await rawRequest(socketPath, { op: "read", token: "wrong", codexThreadId: THREAD });
      expect(response).toEqual({ ok: false, error: "jeton de contrôle invalide" });
      expect(verified).toBe(0);
      expect(calls).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("the codex route admits list but the hook op stays reserved to the token route", async () => {
    const socketPath = join(tempDirs[2]!, "lst.sock");
    const calls: string[] = [];
    const server = await startControlServer({
      socketPath,
      token: "tok",
      handle: async (call) => {
        calls.push(call.op);
        return { ok: true, peers: [] };
      },
      verifyCaller: async () => true,
    });
    try {
      expect(await rawRequest(socketPath, { op: "list", codexThreadId: THREAD })).toEqual({ ok: true, peers: [] });
      expect(await rawRequest(socketPath, { op: "list", token: "tok" })).toEqual({ ok: true, peers: [] });
      const hook = await rawRequest(socketPath, { op: "hook", harness: "grok", event: "x", payload: {}, codexThreadId: THREAD });
      expect(hook.ok).toBe(false);
      expect(calls).toEqual(["list", "list"]);
    } finally {
      server.stop();
    }
  });

  test("a thread id outside the pattern never reaches the verifier", async () => {
    const socketPath = join(tempDirs[2]!, "pat.sock");
    let verified = 0;
    const server = await startControlServer({
      socketPath,
      token: "tok",
      handle: answerNothing,
      verifyCaller: async () => {
        verified += 1;
        return true;
      },
    });
    try {
      const response = await rawRequest(socketPath, { op: "read", codexThreadId: "../x" });
      expect(response.ok).toBe(false);
      expect(verified).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("the pointer file is 600, written atomically, replaceable and removable without error when absent", () => {
    const socketPath = controlSocketPath();
    writeCodexPointer(THREAD, socketPath);
    const path = codexPointerPath(THREAD);
    expect(path).toBe(join(process.env.IDNMA_CONTROL_DIR!, `codex-${THREAD}.json`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ socketPath });
    writeCodexPointer(THREAD, "/tmp/other.sock");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ socketPath: "/tmp/other.sock" });
    removeCodexPointer(THREAD);
    expect(existsSync(path)).toBe(false);
    expect(() => removeCodexPointer(THREAD)).not.toThrow();
  });

  test("a thread id outside the pattern builds no path", () => {
    expect(() => codexPointerPath("../x")).toThrow();
    expect(() => writeCodexPointer("../x", "/tmp/s.sock")).toThrow();
    expect(() => removeCodexPointer("../x")).toThrow();
  });

  test("controlRequest through a codex pointer reaches the understudy, a missing pointer is a PeerError", async () => {
    const env = { CODEX_THREAD_ID: THREAD };
    const missing = await controlRequest({ op: "read" }, env).catch((caught: unknown) => caught);
    expect(missing).toBeInstanceOf(PeerError);
    expect((missing as PeerError).message).toBe("idnma : aucune doublure pour ce thread Codex. Lance Codex par idnma run.");
    const invalid = await controlRequest({ op: "read" }, { CODEX_THREAD_ID: "../x" }).catch((caught: unknown) => caught);
    expect((invalid as PeerError).message).toContain("aucune doublure ici");
  });
});

/** Requête brute sur le socket de contrôle, pour les trames que `controlRequest` ne construit pas. */
async function rawRequest(socketPath: string, frame: Record<string, unknown>): Promise<{ ok: boolean; error?: string; peers?: unknown }> {
  const { createConnection } = await import("node:net");
  const reply = await new Promise<string>((resolveReply, rejectReply) => {
    const socket = createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.once("error", rejectReply);
    socket.once("close", () => resolveReply(received));
    socket.end(JSON.stringify(frame) + "\n");
  });
  return JSON.parse(reply) as { ok: boolean; error?: string; peers?: unknown };
}

describe("controlRequest", () => {
  test("without control variables it explains that no understudy is running", async () => {
    const error = await controlRequest({ op: "read" }, {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PeerError);
    expect((error as PeerError).message).toBe("idnma : aucune doublure ici. Cette commande se lance depuis un agent démarré par idnma run.");
  });

  test("a Claude agent launched by idnma run, without a control channel, is sent to its native SendMessage", async () => {
    const error = await controlRequest({ op: "send", to: "x", body: "y" }, { IDNMA_NAME: "claude-vesta-ab12" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PeerError);
    // IDNMA_NAME peut être périmé (une reprise dans la TUI rend son nom à la session) : le message ne le cite pas.
    expect((error as PeerError).message).not.toContain("claude-vesta-ab12");
    expect((error as PeerError).message).toContain("SendMessage");
    expect((error as PeerError).message).not.toContain("aucune doublure ici");
  });

  test("a control socket without any token says the token is missing, before the Claude case", async () => {
    const env = { IDNMA_CONTROL_SOCKET: "/tmp/idnma-t-none/1.sock", IDNMA_NAME: "dst-janus-ab12" };
    for (const withEmptyTokens of [env, { ...env, IDNMA_CONTROL_TOKEN: "", DSH_IDNMA_CONTROL_TOKEN: "" }]) {
      const error = await controlRequest({ op: "read" }, withEmptyTokens).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PeerError);
      expect((error as PeerError).message).toBe("idnma : canal de contrôle sans jeton (IDNMA_CONTROL_TOKEN ou DSH_IDNMA_CONTROL_TOKEN absent)");
    }
  });

  test("with a socket nobody listens on it fails with a PeerError", async () => {
    const error = await controlRequest({ op: "read" }, { IDNMA_CONTROL_SOCKET: join(tempDirs[2]!, "nobody.sock"), IDNMA_CONTROL_TOKEN: "t" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PeerError);
  });
});

describe("startControlServer", () => {
  test("answers a malformed request without calling the handler", async () => {
    const socketPath = join(tempDirs[2]!, "raw.sock");
    let calls = 0;
    const server = await startControlServer({
      socketPath,
      token: "tok",
      handle: async () => {
        calls += 1;
        return { ok: true, message: null };
      },
    });
    try {
      const { createConnection } = await import("node:net");
      const reply = await new Promise<string>((resolveReply, rejectReply) => {
        const socket = createConnection(socketPath);
        let received = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => (received += chunk));
        socket.once("error", rejectReply);
        socket.once("close", () => resolveReply(received));
        socket.end('{"op":"send","token":"tok"}\n');
      });
      expect(JSON.parse(reply)).toEqual({ ok: false, error: "requête de contrôle invalide" });
      expect(calls).toBe(0);
    } finally {
      server.stop();
    }
    expect(existsSync(socketPath)).toBe(false);
  });

  test("replaces a leftover socket file at the same path", async () => {
    const socketPath = join(tempDirs[2]!, "stale.sock");
    const first = await startControlServer({ socketPath, token: "a", handle: async () => ({ ok: true, message: null }) });
    // Le premier serveur n'est pas arrêté : son fichier reste, comme après un crash.
    const second = await startControlServer({ socketPath, token: "b", handle: async () => ({ ok: true, message: "second" }) });
    try {
      expect(await controlRequest({ op: "read" }, { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: "b" })).toEqual({ ok: true, message: "second" });
    } finally {
      second.stop();
      first.stop();
    }
  });
});

describe("startControlServer safety", () => {
  test("rejects with a French error when the socket cannot listen, without an uncaught error", async () => {
    const readOnly = join(tempDirs[2]!, "ro");
    mkdirSync(readOnly, { mode: 0o700 });
    chmodSync(readOnly, 0o500);
    try {
      await expect(startControlServer({ socketPath: join(readOnly, "c.sock"), token: "t", handle: answerNothing })).rejects.toThrow(
        /canal de contrôle/,
      );
      // Laisse passer un tour : un événement `error` sans écouteur ferait tomber le process ici.
      await Bun.sleep(50);
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });

  test("refuses a pre-existing control directory open to group or others", async () => {
    const loose = join(tempDirs[2]!, "loose");
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    await expect(startControlServer({ socketPath: join(loose, "c.sock"), token: "t", handle: answerNothing })).rejects.toThrow(
      /Dossier de contrôle non sûr/,
    );
    expect(existsSync(join(loose, "c.sock"))).toBe(false);
    expect(statSync(loose).mode & 0o777).toBe(0o755);
  });

  test("refuses a control directory that is a symbolic link", async () => {
    const real = join(tempDirs[2]!, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(tempDirs[2]!, "link");
    symlinkSync(real, link);
    await expect(startControlServer({ socketPath: join(link, "c.sock"), token: "t", handle: answerNothing })).rejects.toThrow(
      /Dossier de contrôle non sûr/,
    );
    expect(existsSync(join(real, "c.sock"))).toBe(false);
  });
});

describe("runUnderstudy cleanup robustness", () => {
  childTest("a throwing unregister still stops the control channel, returns the child code and is logged", async () => {
    const registration = await register("codex-janus");
    const throwing: Registration = {
      ...registration,
      unregister() {
        registration.unregister();
        throw new Error("unregister exploded");
      },
    };
    const running = launch(["sh", "-c", "exit 4"], throwing);
    const { socketPath } = await running.control;
    expect(await running.done).toBe(4);
    expect(existsSync(socketPath)).toBe(false);
    const errors = logLines().filter((line) => line.event === "cleanup-error");
    expect(errors).toEqual([expect.objectContaining({ step: "unregister", message: "unregister exploded" })]);
  });

  childTest("a throwing control stop does not skip the rest of the cleanup", async () => {
    const registration = await register("codex-janus");
    // L'enfant remplace le socket de contrôle par un dossier non vide : son retrait lève alors EISDIR.
    const script = 'mv "$IDNMA_CONTROL_SOCKET" "$IDNMA_CONTROL_SOCKET.moved" && mkdir "$IDNMA_CONTROL_SOCKET" && touch "$IDNMA_CONTROL_SOCKET/x"; exit 5';
    const running = launch(["sh", "-c", script], registration);
    expect(await running.done).toBe(5);
    expect(listLiveEntries().find((entry) => entry.pid === process.pid)).toBeUndefined();
    const steps = logLines()
      .filter((line) => line.event === "cleanup-error")
      .map((line) => line.step);
    expect(steps).toContain("control-stop");
  });

  childTest("SIGTERM still exits 143 and removes the control socket when unregister throws", async () => {
    const childPidFile = join(tempDirs[2]!, "child.pid");
    const script = `
      import { registerPeer } from ${JSON.stringify(join(import.meta.dir, "../src/bus/register.ts"))};
      import { runUnderstudy } from ${JSON.stringify(join(import.meta.dir, "../src/understudy/understudy.ts"))};
      import { MessageQueue } from ${JSON.stringify(join(import.meta.dir, "../src/understudy/queue.ts"))};
      const queue = new MessageQueue();
      const registration = await registerPeer({ name: "codex-janus", cwd: "/w", onMessage: (m) => queue.push(m) });
      const throwing = { ...registration, unregister() { registration.unregister(); throw new Error("unregister exploded"); } };
      const code = await runUnderstudy({
        name: "codex-janus",
        argv: ["sh", "-c", "trap '' TERM; echo $$ > ${childPidFile}; exec sleep 30"],
        env: { PATH: process.env.PATH ?? "" },
        fromMode: "bypass",
        registration: throwing,
        queue,
      });
      process.exitCode = code;
    `;
    const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, ...cleanEnv } = process.env;
    const understudy = Bun.spawn(["bun", "-e", script], { env: cleanEnv, stdout: "ignore", stderr: "pipe" });
    let childPid: number | undefined;
    try {
      const controlSocket = (): string => join(process.env.IDNMA_CONTROL_DIR!, `${understudy.pid}.sock`);
      await waitFor(() => existsSync(controlSocket()) && existsSync(childPidFile) && readFileSync(childPidFile, "utf8").trim() !== "", "control socket and child pid");
      childPid = Number(readFileSync(childPidFile, "utf8").trim());
      understudy.kill("SIGTERM");
      expect(await understudy.exited).toBe(143);
      expect(existsSync(controlSocket())).toBe(false);
      expect(logLines().some((line) => line.event === "cleanup-error" && line.step === "unregister")).toBe(true);
    } finally {
      understudy.kill("SIGKILL");
      if (childPid !== undefined && Number.isInteger(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Déjà mort : rien à tuer.
        }
      }
    }
  });
});

describe("runUnderstudy lifecycle", () => {
  childTest("returns the child exit code and removes every trace", async () => {
    const listenersBefore = { SIGHUP: process.listenerCount("SIGHUP"), SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
    const registration = await register("codex-janus");
    const running = launch(["sh", "-c", "exit 3"], registration);
    const { socketPath } = await running.control;

    expect(await running.done).toBe(3);
    expect(listLiveEntries().find((entry) => entry.pid === process.pid)).toBeUndefined();
    expect(existsSync(join(sessionsDir(), keyFileName(process.pid, registration.socketPath)))).toBe(false);
    expect(existsSync(registration.socketPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    expect({ SIGHUP: process.listenerCount("SIGHUP"), SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }).toEqual(listenersBefore);
  });

  childTest("reports 128 plus the signal number when the child is killed", async () => {
    const registration = await register("codex-janus");
    const running = launch(["sh", "-c", "kill -9 $$"], registration);
    expect(await running.done).toBe(137);
  });

  childTest("a child that cannot start rejects and still cleans up", async () => {
    const listenersBefore = process.listenerCount("SIGHUP");
    const registration = await register("codex-janus");
    const running = launch(["/nonexistent/idnma-agent"], registration);
    const error = await running.done.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(listLiveEntries().find((entry) => entry.pid === process.pid)).toBeUndefined();
    expect(existsSync(join(process.env.IDNMA_CONTROL_DIR!, `${process.pid}.sock`))).toBe(false);
    expect(process.listenerCount("SIGHUP")).toBe(listenersBefore);
  });

  childTest("SIGHUP on the understudy cleans up fast even when the child ignores the signal", async () => {
    const childPidFile = join(tempDirs[2]!, "child.pid");
    const script = `
      import { registerPeer } from ${JSON.stringify(join(import.meta.dir, "../src/bus/register.ts"))};
      import { runUnderstudy } from ${JSON.stringify(join(import.meta.dir, "../src/understudy/understudy.ts"))};
      import { MessageQueue } from ${JSON.stringify(join(import.meta.dir, "../src/understudy/queue.ts"))};
      const queue = new MessageQueue();
      const registration = await registerPeer({ name: "codex-janus", cwd: "/w", onMessage: (m) => queue.push(m) });
      const code = await runUnderstudy({
        name: "codex-janus",
        argv: ["sh", "-c", "trap '' HUP; echo $$ > ${childPidFile}; exec sleep 30"],
        env: { PATH: process.env.PATH ?? "" },
        fromMode: "bypass",
        registration,
        queue,
      });
      process.exitCode = code;
    `;
    const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, ...cleanEnv } = process.env;
    const understudy = Bun.spawn(["bun", "-e", script], { env: cleanEnv, stdout: "ignore", stderr: "pipe" });
    let childPid: number | undefined;
    try {
      const controlSocket = (): string => join(process.env.IDNMA_CONTROL_DIR!, `${understudy.pid}.sock`);
      await waitFor(() => existsSync(controlSocket()) && existsSync(childPidFile) && readFileSync(childPidFile, "utf8").trim() !== "", "control socket and child pid");
      childPid = Number(readFileSync(childPidFile, "utf8").trim());
      expect(listLiveEntries().some((entry) => entry.pid === understudy.pid)).toBe(true);

      const signalledAt = Date.now();
      understudy.kill("SIGHUP");
      const code = await understudy.exited;
      expect(Date.now() - signalledAt).toBeLessThan(2000);
      expect(code).toBe(129);
      expect(listLiveEntries().some((entry) => entry.pid === understudy.pid)).toBe(false);
      const busSocket = join(process.env.IDNMA_SOCKETS_DIR!, `${understudy.pid}.sock`);
      expect(existsSync(busSocket)).toBe(false);
      expect(existsSync(join(sessionsDir(), keyFileName(understudy.pid, busSocket)))).toBe(false);
      expect(existsSync(controlSocket())).toBe(false);
    } finally {
      understudy.kill("SIGKILL");
      if (childPid !== undefined && Number.isInteger(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Déjà mort : rien à tuer.
        }
      }
    }
  });

  // Un signal reçu avant « listening » : le nettoyage retire le socket, puis le démarrage du canal échoue.
  for (const [signal, expectedCode] of [["SIGHUP", 129], ["SIGTERM", 143]] as const) {
    childTest(`a ${signal} while the control channel starts exits ${expectedCode} without spawning the child`, async () => {
      const listenersBefore = { SIGHUP: process.listenerCount("SIGHUP"), SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
      const marker = join(tempDirs[2]!, "child-ran");
      const done = runUnderstudy({
        name: "codex-janus",
        argv: ["/bin/sh", "-c", `touch ${marker}; sleep 3`],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        fromMode: "prompting",
        registration: null,
        queue,
      });
      // `runUnderstudy` est suspendu sur le démarrage du canal : le signal tombe dans la fenêtre.
      process.emit(signal, signal);
      expect(await done).toBe(expectedCode);
      await Bun.sleep(500);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(process.env.IDNMA_CONTROL_DIR!, `${process.pid}.sock`))).toBe(false);
      expect({ SIGHUP: process.listenerCount("SIGHUP"), SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }).toEqual(listenersBefore);
    });
  }
});

/** Envoie une trame brute au canal de contrôle et rend la réponse décodée. */
async function rawFrame(socketPath: string, frame: unknown): Promise<{ ok: boolean; error?: string }> {
  return await new Promise((resolveReply, rejectReply) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", rejectReply);
    socket.once("close", () => resolveReply(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    socket.end(JSON.stringify(frame) + "\n");
  });
}

/** Livreur factice : note ses appels dans l'ordre ; chaque étape se règle par `overrides`. */
function fakeCourier(overrides: Partial<Courier> = {}): Courier & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    beforeSpawn: async () => {
      calls.push("beforeSpawn");
    },
    afterSpawn: () => {
      calls.push("afterSpawn");
    },
    onMessage: () => {
      calls.push("onMessage");
    },
    read: () => null,
    hook: async () => ({}),
    verifyCaller: async () => false,
    stop: () => {
      calls.push("stop");
    },
    ...overrides,
  };
}

describe("runUnderstudy with a courier", () => {
  childTest("drives the courier around the child", async () => {
    const registration = await register("codex-janus");
    const marker = join(tempDirs[2]!, "child-ran");
    let markerAtBeforeSpawn: boolean | undefined;
    let markerAtAfterSpawn: boolean | undefined;
    const courier = fakeCourier({
      beforeSpawn: async () => {
        courier.calls.push("beforeSpawn");
        // Laisse le temps à un enfant lancé trop tôt d'écrire son témoin.
        await Bun.sleep(100);
        markerAtBeforeSpawn = existsSync(marker);
      },
      afterSpawn: () => {
        courier.calls.push("afterSpawn");
        markerAtAfterSpawn = existsSync(marker);
      },
    });
    const running = launch(["sh", "-c", `touch ${marker}`], registration, "bypass", undefined, courier);
    expect(await running.done).toBe(0);
    expect(markerAtBeforeSpawn).toBe(false);
    expect(markerAtAfterSpawn).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(courier.calls).toEqual(["beforeSpawn", "afterSpawn", "stop"]);
  });

  childTest("read is empty when a courier owns the queue", async () => {
    const registration = await register("codex-janus");
    queue.push(inbound("pour le livreur"));
    const running = launch(["sleep", "1"], registration, "bypass", undefined, fakeCourier());
    const { socketPath, token } = await running.control;
    const env = { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token };

    expect(await controlRequest({ op: "read" }, env)).toEqual({ ok: true, message: null });
    expect(queue.size).toBe(1);
    await running.done;
  });

  childTest("read asks the active courier", async () => {
    const registration = await register("codex-janus");
    queue.push(inbound("reste dans la file"));
    const running = launch(["sleep", "1"], registration, "bypass", undefined, fakeCourier({ read: () => "M" }));
    const { socketPath, token } = await running.control;
    const env = { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token };

    expect(await controlRequest({ op: "read" }, env)).toEqual({ ok: true, message: "M" });
    expect(queue.size).toBe(1);
    await running.done;
  });

  childTest("hook hands the harness, the event and the payload to the active courier and returns its reply", async () => {
    const registration = await register("codex-janus");
    const seen: unknown[][] = [];
    const courier = fakeCourier({
      hook: async (harness, event, payload) => {
        seen.push([harness, event, payload]);
        return { decision: "block", reason: "x" };
      },
    });
    const running = launch(["sleep", "1"], registration, "bypass", undefined, courier);
    const { socketPath, token } = await running.control;
    const env = { IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token };

    const response = await controlRequest({ op: "hook", harness: "agy", event: "PreInvocation", payload: { a: 1 } }, env);
    expect(response).toEqual({ ok: true, reply: { decision: "block", reason: "x" } });
    expect(seen).toEqual([["agy", "PreInvocation", { a: 1 }]]);
    await running.done;
  });

  childTest("hook answers {} when no courier is active, and an error when the courier throws", async () => {
    const registration = await register("codex-janus");
    const bare = launch(["sleep", "1"], registration);
    const bareControl = await bare.control;
    const bareEnv = { IDNMA_CONTROL_SOCKET: bareControl.socketPath, IDNMA_CONTROL_TOKEN: bareControl.token };
    expect(await controlRequest({ op: "hook", harness: "grok", event: "Stop", payload: {} }, bareEnv)).toEqual({ ok: true, reply: {} });
    await bare.done;

    const failing = launch(["sleep", "1"], registration, "bypass", undefined, fakeCourier({ hook: async () => { throw new Error("boom"); } }));
    const failingControl = await failing.control;
    const failingEnv = { IDNMA_CONTROL_SOCKET: failingControl.socketPath, IDNMA_CONTROL_TOKEN: failingControl.token };
    expect(await controlRequest({ op: "hook", harness: "grok", event: "Stop", payload: {} }, failingEnv)).toEqual({ ok: false, error: "boom" });
    await failing.done;
  });

  childTest("a hook payload that is not an object is an invalid request", async () => {
    const registration = await register("codex-janus");
    const running = launch(["sleep", "1"], registration, "bypass", undefined, fakeCourier());
    const { socketPath, token } = await running.control;
    for (const payload of [null, [1], "x", 3]) {
      const reply = await rawFrame(socketPath, { op: "hook", harness: "grok", event: "Stop", payload, token });
      expect(reply).toEqual({ ok: false, error: "requête de contrôle invalide" });
    }
    await running.done;
  });

  childTest("the hook op is refused on the codex thread path", async () => {
    const registration = await register("codex-janus");
    const verified: unknown[] = [];
    const running = launch(["sleep", "1"], registration, "bypass", { threadId: THREAD, verifyCaller: async (claim) => {
      verified.push(claim);
      return true;
    } }, fakeCourier());
    const { socketPath } = await running.control;
    const reply = await rawFrame(socketPath, { op: "hook", harness: "grok", event: "Stop", payload: {}, codexThreadId: THREAD });
    expect(reply.ok).toBe(false);
    // Refusée avant toute vérification : la voie Codex n'est même pas consultée pour un hook.
    expect(verified).toEqual([]);
    await running.done;
  });

  childTest("the channel admits codex callers through the courier verifier", async () => {
    const peer = await startFakePeer("claude-vulcain");
    peers.push(peer);
    const registration = await register("codex-janus");
    const verified: Array<{ codexThreadId: string }> = [];
    const courier = fakeCourier({
      verifyCaller: async (claim, pid) => {
        verified.push(claim);
        return pid !== undefined && isDescendantOf(pid, process.pid);
      },
    });
    const running = launch(codexCommand(), registration, "bypass", { threadId: THREAD }, courier);
    expect(await running.done).toBe(0);
    expect(verified).toEqual([{ codexThreadId: THREAD }]);
    await waitFor(() => peer.lines.some((line) => (line as { type?: string }).type === "user"), "user frame");
  });

  childTest("an unavailable daemon still launches the agent off the bus", async () => {
    const registration = await register("codex-janus");
    const seen = join(tempDirs[2]!, "seen");
    const entryPath = join(sessionsDir(), `${process.pid}.json`);
    const courier = fakeCourier({
      beforeSpawn: async () => {
        courier.calls.push("beforeSpawn");
        throw new CourierUnavailableError("daemon Codex injoignable");
      },
    });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const script = `sleep 0.5; test -e ${entryPath} && echo present > ${seen} || echo absent > ${seen}`;
      const running = launch(["sh", "-c", script], registration, "bypass", undefined, courier);
      expect(await running.done).toBe(0);
      const written = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(written).toContain("daemon Codex injoignable");
      expect(written).toContain("hors du bus");
    } finally {
      stderr.mockRestore();
    }
    expect(readFileSync(seen, "utf8").trim()).toBe("absent");
    expect(courier.calls).toContain("stop");
    expect(courier.calls).not.toContain("afterSpawn");
  });

  childTest("an unavailable courier starts Grok off the bus with its label", async () => {
    const sender = await startFakePeer("claude-vulcain");
    peers.push(sender);
    const registration = await register("codex-janus");
    expect(queue.push({ ...inbound("avant le lancement"), from: addressOf(sender.socketPath), msgId: "m-early" })).toBe(true);
    const courier = fakeCourier({
      beforeSpawn: async () => {
        throw new CourierUnavailableError("hooks idnma absents");
      },
    });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    let written: string;
    try {
      const running = launch(["true"], registration, "bypass", undefined, courier, { harnessLabel: "Grok" });
      expect(await running.done).toBe(0);
      written = stderr.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      stderr.mockRestore();
    }
    expect(written).toBe("idnma : hooks idnma absents. Grok démarre hors du bus (il ne recevra ni n'enverra de messages).\n");
    const frames = sender.lines.filter((line) => (line as { type?: string }).type === "user") as Array<{ message: { content: string } }>;
    expect(frames.length).toBe(1);
    expect(frames[0]!.message.content).toContain("codex-janus : message non livré (Grok a quitté le bus)");
  });

  childTest("an unavailable daemon refuses the queued messages before leaving the bus", async () => {
    const sender = await startFakePeer("claude-vulcain");
    peers.push(sender);
    const registration = await register("codex-janus");
    expect(queue.push({ ...inbound("avant le lancement"), from: addressOf(sender.socketPath), msgId: "m-early" })).toBe(true);
    const courier = fakeCourier({
      beforeSpawn: async () => {
        throw new CourierUnavailableError("daemon Codex injoignable");
      },
    });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const running = launch(["true"], registration, "bypass", undefined, courier);
      expect(await running.done).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    const frames = sender.lines.filter((line) => (line as { type?: string }).type === "user") as Array<{ message: { content: string } }>;
    expect(frames.length).toBe(1);
    const content = frames[0]!.message.content;
    expect(isAutoReply(content)).toBe(true);
    expect(content.split("\n")[1]).toBe(AUTO_REPLY_MARKER);
    expect(content).toContain("codex-janus : message non livré (Codex a quitté le bus)");
    expect(queue.size).toBe(0);
  });

  childTest("a courier whose afterSpawn throws does not orphan the child, which runs to its exit code", async () => {
    const registration = await register("codex-janus");
    const marker = join(tempDirs[2]!, "child-ran");
    const courier = fakeCourier({
      afterSpawn: () => {
        courier.calls.push("afterSpawn");
        throw new Error("afterSpawn exploded");
      },
    });
    const running = launch(["sh", "-c", `sleep 0.3; touch ${marker}; exit 7`], registration, "bypass", undefined, courier);
    expect(await running.done).toBe(7);
    expect(existsSync(marker)).toBe(true);
    expect(courier.calls).toEqual(["beforeSpawn", "afterSpawn", "stop"]);
    expect(logLines().filter((line) => line.event === "cleanup-error" && line.step === "courier-after-spawn")).toEqual([
      expect.objectContaining({ message: "afterSpawn exploded" }),
    ]);
  });

  childTest("any other beforeSpawn failure rejects, stops the courier and cleans up", async () => {
    const registration = await register("codex-janus");
    const marker = join(tempDirs[2]!, "child-ran");
    const courier = fakeCourier({
      beforeSpawn: async () => {
        throw new Error("beforeSpawn exploded");
      },
    });
    const running = launch(["sh", "-c", `touch ${marker}`], registration, "bypass", undefined, courier);
    await expect(running.done).rejects.toThrow("beforeSpawn exploded");
    expect(existsSync(marker)).toBe(false);
    expect(courier.calls).toEqual(["stop"]);
    expect(listLiveEntries().find((entry) => entry.pid === process.pid)).toBeUndefined();
    expect(existsSync(join(process.env.IDNMA_CONTROL_DIR!, `${process.pid}.sock`))).toBe(false);
  });

  childTest("a signal during beforeSpawn exits at once without spawning", async () => {
    const registration = await register("codex-janus");
    const marker = join(tempDirs[2]!, "child-ran");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectPending!: (error: Error) => void;
      const courier = fakeCourier({
        // Ne se résout jamais : il rejette quand `stop` l'abandonne, comme l'attente du verrou d'adoption.
        beforeSpawn: () =>
          new Promise<void>((_resolve, reject) => {
            rejectPending = reject;
          }),
        stop: () => {
          courier.calls.push("stop");
          rejectPending(new CourierUnavailableError("le livreur Codex est arrêté"));
        },
      });
      const startedAt = Date.now();
      const running = launch(["sh", "-c", `touch ${marker}; sleep 3`], registration, "bypass", undefined, courier);
      await running.control;
      setTimeout(() => process.emit("SIGHUP", "SIGHUP"), 100);
      expect(await running.done).toBe(129);
      expect(Date.now() - startedAt).toBeLessThan(500);
      // Laisse passer des tours : un rejet tardif non rattrapé tomberait ici.
      await Bun.sleep(300);
      expect(existsSync(marker)).toBe(false);
      expect(courier.calls).toEqual(["stop"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  describe("courier farewell", () => {
    childTest("farewell runs once when the child ends, and its work is awaited before the exit code returns", async () => {
      const registration = await register("codex-janus");
      let finished = false;
      const courier = fakeCourier({
        farewell: async () => {
          courier.calls.push("farewell");
          await Bun.sleep(100);
          finished = true;
        },
      });
      const running = launch(["sh", "-c", "exit 4"], registration, "bypass", undefined, courier);
      expect(await running.done).toBe(4);
      expect(finished).toBe(true);
      expect(courier.calls).toEqual(["beforeSpawn", "afterSpawn", "farewell", "stop"]);
    });

    childTest("farewell runs once after SIGTERM, its work is awaited, and the code stays 143", async () => {
      const registration = await register("codex-janus");
      let finished = false;
      const courier = fakeCourier({
        farewell: async () => {
          courier.calls.push("farewell");
          await Bun.sleep(100);
          finished = true;
        },
      });
      const running = launch(["sh", "-c", "sleep 30"], registration, "bypass", undefined, courier);
      await running.control;
      await waitFor(() => courier.calls.includes("afterSpawn"), "afterSpawn");
      process.emit("SIGTERM", "SIGTERM");
      expect(await running.done).toBe(143);
      expect(finished).toBe(true);
      expect(courier.calls.filter((call) => call === "farewell")).toEqual(["farewell"]);
    });

    childTest("a farewell that never ends is abandoned after farewellWaitMs", async () => {
      const registration = await register("codex-janus");
      const courier = fakeCourier({
        farewell: () => {
          courier.calls.push("farewell");
          return new Promise<void>(() => {});
        },
      });
      const running = launch(["sh", "-c", "exit 5"], registration, "bypass", undefined, courier, { farewellWaitMs: 50 });
      const startedAt = Date.now();
      expect(await running.done).toBe(5);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(courier.calls).toContain("farewell");
      expect(courier.calls).toContain("stop");
    });

    childTest("a rejecting or throwing farewell is logged and never changes the exit code", async () => {
      const registration = await register("codex-janus");
      const rejecting = fakeCourier({ farewell: async () => { throw new Error("farewell exploded"); } });
      expect(await launch(["sh", "-c", "exit 6"], registration, "bypass", undefined, rejecting).done).toBe(6);
      const throwing = fakeCourier({
        farewell: () => {
          throw new Error("farewell threw");
        },
      });
      expect(await launch(["sh", "-c", "exit 8"], registration, "bypass", undefined, throwing).done).toBe(8);
      expect(logLines().filter((line) => line.event === "farewell-error")).toEqual([
        expect.objectContaining({ message: "farewell exploded" }),
        expect.objectContaining({ message: "farewell threw" }),
      ]);
    });

    childTest("a courier without farewell keeps the current behavior", async () => {
      const registration = await register("codex-janus");
      const courier = fakeCourier();
      const startedAt = Date.now();
      expect(await launch(["sh", "-c", "exit 9"], registration, "bypass", undefined, courier).done).toBe(9);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(courier.calls).toEqual(["beforeSpawn", "afterSpawn", "stop"]);
      expect(logLines().filter((line) => line.event === "farewell-error")).toEqual([]);
    });

    childTest("no farewell when the courier declared itself unavailable", async () => {
      const registration = await register("codex-janus");
      const courier = fakeCourier({
        beforeSpawn: async () => {
          throw new CourierUnavailableError("dst injoignable");
        },
        farewell: async () => {
          courier.calls.push("farewell");
        },
      });
      const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(await launch(["true"], registration, "bypass", undefined, courier).done).toBe(0);
      } finally {
        stderr.mockRestore();
      }
      expect(courier.calls).not.toContain("farewell");
    });

    childTest("a signal during beforeSpawn does not call farewell", async () => {
      const registration = await register("codex-janus");
      let rejectPending!: (error: Error) => void;
      const courier = fakeCourier({
        beforeSpawn: () =>
          new Promise<void>((_resolve, reject) => {
            rejectPending = reject;
          }),
        stop: () => {
          courier.calls.push("stop");
          rejectPending(new CourierUnavailableError("le livreur est arrêté"));
        },
        farewell: async () => {
          courier.calls.push("farewell");
        },
      });
      const running = launch(["sleep", "3"], registration, "bypass", undefined, courier);
      await running.control;
      setTimeout(() => process.emit("SIGHUP", "SIGHUP"), 100);
      expect(await running.done).toBe(129);
      await Bun.sleep(100);
      expect(courier.calls).toEqual(["stop"]);
    });
  });

  childTest("AC-12: the real Codex courier adopts the thread, delivers and leaves no trace", async () => {
    const registration = await register("codex-janus");
    process.env.CODEX_HOME = join(tempDirs[2]!, "codex");
    mkdirSync(join(process.env.CODEX_HOME, "app-server-control"), { recursive: true });
    const daemon: FakeCodexDaemon = startFakeCodexDaemon(codexDaemonSocket());
    try {
      daemon.handle("turn/start", () => ({ result: { turn: { id: "turn-1", status: "inProgress", items: [] } } }));
      const courier = createCodexCourier({
        name: "codex-janus",
        fromMode: "bypass",
        registration,
        queue,
        cwd: process.cwd(),
        connect: (onNotification, { allowStart }) => connectDaemon({ onNotification, allowStart, startDaemon: async () => {} }),
      });
      const started = join(tempDirs[2]!, "started");
      const running = launch(["sh", "-c", `touch ${started}; sleep 2`], registration, "bypass", undefined, courier);
      // Le témoin existe : `afterSpawn` est passé, une diffusion plus tôt serait ignorée par construction.
      await waitFor(() => existsSync(started), "child marker");
      daemon.notify("thread/started", {
        thread: { id: THREAD, cwd: process.cwd(), ephemeral: false, threadSource: "user", parentThreadId: null, status: { type: "idle" }, preview: "", turns: [] },
      });
      await waitFor(() => existsSync(codexPointerPath(THREAD)), "codex pointer");

      queue.push(inbound("message du bus"));
      courier.onMessage();
      await waitFor(() => daemon.received.some((frame) => frame.method === "turn/start"), "turn/start");
      const turn = daemon.received.find((frame) => frame.method === "turn/start")!;
      const params = turn.params as { threadId: string; input: Array<{ text: string }> };
      expect(Object.keys(params).sort()).toEqual(["clientUserMessageId", "input", "threadId"]);
      expect(params.threadId).toBe(THREAD);
      expect(params.input[0]!.text).toContain("message du bus");

      const busSocket = registration.socketPath;
      expect(await running.done).toBe(0);
      expect(existsSync(codexPointerPath(THREAD))).toBe(false);
      expect(listLiveEntries().find((entry) => entry.pid === process.pid)).toBeUndefined();
      expect(existsSync(join(sessionsDir(), keyFileName(process.pid, busSocket)))).toBe(false);
      expect(existsSync(busSocket)).toBe(false);
      expect(existsSync(controlSocketPath())).toBe(false);
      await waitFor(() => daemon.openConnections() === 0, "daemon connections closed");
    } finally {
      daemon.stop();
    }
  });
});

/** stdin et stdout factices pour le PTY : jamais le vrai stdin de `bun test`. */
function fakePtyStreams(): { stdin: PassThrough & NodeJS.ReadStream; stdout: PassThrough & NodeJS.WriteStream } {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(stdin, { isTTY: false });
  Object.assign(stdout, { columns: 80, rows: 24 });
  return { stdin, stdout };
}

describe("runUnderstudy under a PTY", () => {
  childTest("runs the agent under a PTY and hands its terminal to the courier", async () => {
    const streams = fakePtyStreams();
    let received: Terminal | undefined;
    const courier = fakeCourier({
      afterSpawn: (terminal) => {
        courier.calls.push("afterSpawn");
        received = terminal;
      },
    });
    const code = await runUnderstudy({
      name: "grok-janus",
      argv: ["/bin/sh", "-c", "printf x"],
      env: { PATH: process.env.PATH ?? "" },
      fromMode: "bypass",
      registration: null,
      queue,
      courier,
      pty: true,
      ptyStdin: streams.stdin,
      ptyStdout: streams.stdout,
    });
    expect(code).toBe(0);
    expect(courier.calls).toEqual(["beforeSpawn", "afterSpawn", "stop"]);
    expect(typeof received?.write).toBe("function");
    expect(typeof received?.onInput).toBe("function");
  });

  childTest("the courier can type into the agent through its terminal", async () => {
    const streams = fakePtyStreams();
    let output = "";
    streams.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const courier = fakeCourier({
      afterSpawn: (terminal) => terminal?.write("ping\r"),
    });
    const code = await runUnderstudy({
      name: "grok-janus",
      argv: ["/bin/sh", "-c", "read line; printf 'got:%s' \"$line\""],
      env: { PATH: process.env.PATH ?? "" },
      fromMode: "bypass",
      registration: null,
      queue,
      courier,
      pty: true,
      ptyStdin: streams.stdin,
      ptyStdout: streams.stdout,
    });
    expect(code).toBe(0);
    await waitFor(() => output.includes("got:ping"), "typed line echoed");
  });

  childTest("PTY child killed by SIGTERM yields 143", async () => {
    const streams = fakePtyStreams();
    const code = await runUnderstudy({
      name: "grok-janus",
      argv: ["/bin/sh", "-c", "kill -TERM $$"],
      env: { PATH: process.env.PATH ?? "" },
      fromMode: "bypass",
      registration: null,
      queue,
      pty: true,
      ptyStdin: streams.stdin,
      ptyStdout: streams.stdout,
    });
    expect(code).toBe(143);
  });

  childTest("cleanup releases the PTY", async () => {
    const streams = fakePtyStreams();
    const dataBefore = streams.stdin.listenerCount("data");
    const resizeBefore = streams.stdout.listenerCount("resize");
    const code = await runUnderstudy({
      name: "grok-janus",
      argv: ["/bin/sh", "-c", "exit 3"],
      env: { PATH: process.env.PATH ?? "" },
      fromMode: "bypass",
      registration: null,
      queue,
      pty: true,
      ptyStdin: streams.stdin,
      ptyStdout: streams.stdout,
    });
    expect(code).toBe(3);
    expect(streams.stdin.listenerCount("data")).toBe(dataBefore);
    expect(streams.stdout.listenerCount("resize")).toBe(resizeBefore);
  });

  childTest("a signal exit also releases the PTY", async () => {
    const streams = fakePtyStreams();
    const dataBefore = streams.stdin.listenerCount("data");
    const done = runUnderstudy({
      name: "grok-janus",
      argv: ["/bin/sh", "-c", "sleep 30"],
      env: { PATH: process.env.PATH ?? "" },
      fromMode: "bypass",
      registration: null,
      queue,
      pty: true,
      ptyStdin: streams.stdin,
      ptyStdout: streams.stdout,
    });
    await waitFor(() => streams.stdin.listenerCount("data") > dataBefore, "pty attached");
    process.emit("SIGTERM", "SIGTERM");
    expect(await done).toBe(143);
    expect(streams.stdin.listenerCount("data")).toBe(dataBefore);
  });
});
