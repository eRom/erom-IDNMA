import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { addressOf, buildEnvelope } from "../src/bus/envelope.ts";
import type { InboundMessage, Priority } from "../src/bus/inbox.ts";
import { listLiveEntries } from "../src/bus/registry.ts";
import { registerPeer, type Registration } from "../src/bus/register.ts";
import { connectDaemon } from "../src/codex/daemon.ts";
import { createCodexCourier } from "../src/codex/courier.ts";
import type { CodexClient, CodexNotification } from "../src/codex/rpc.ts";
import { codexDaemonSocket } from "../src/paths.ts";
import { codexPointerPath, controlSocketPath } from "../src/understudy/control.ts";
import { AUTO_REPLY_MARKER, CourierUnavailableError, type Courier, withReplyHint } from "../src/understudy/courier.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import { startFakeCodexDaemon, type FakeCodexDaemon } from "./helpers/fake-codex-daemon.ts";
import { fakeRegistration } from "./helpers/fake-registration.ts";
import { startFakePeer, type FakePeer } from "./helpers/fake-peer.ts";

const ENV_KEYS = [
  "CODEX_HOME",
  "IDNMA_CONFIG_DIR",
  "IDNMA_CLAUDE_DIR",
  "IDNMA_SOCKETS_DIR",
  "IDNMA_CONTROL_DIR",
  "IDNMA_LOCK_RETRY_MS",
] as const;
const saved: Record<string, string | undefined> = {};

const THREAD_A = "01a179b5-b063-74a3-8b58-1ef7941809f1";
const THREAD_B = "02b280c6-c174-75b4-9c69-2f0852a1a0f2";
const THREAD_TITLE = "03c391d7-d285-76c5-8d7a-3a1963b2b1a3";
const THREAD_ELSEWHERE = "04d4a2e8-e396-77d6-9e8b-4b2a74c3c2b4";

let dir: string;
let workDir: string;
let otherDir: string;
let daemon: FakeCodexDaemon;
let registration: Registration | undefined;
let couriers: Courier[];
let children: Array<ReturnType<typeof Bun.spawn>>;
let peers: FakePeer[];

beforeEach(() => {
  for (const name of ENV_KEYS) saved[name] = process.env[name];
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.CODEX_HOME = join(dir, "codex");
  process.env.IDNMA_CONFIG_DIR = join(dir, "config");
  process.env.IDNMA_CLAUDE_DIR = join(dir, "sessions");
  process.env.IDNMA_SOCKETS_DIR = join(dir, "socks");
  process.env.IDNMA_CONTROL_DIR = join(dir, "control");
  process.env.IDNMA_LOCK_RETRY_MS = "5";
  mkdirSync(process.env.IDNMA_CLAUDE_DIR, { recursive: true });
  mkdirSync(join(process.env.CODEX_HOME, "app-server-control"), { recursive: true });
  workDir = join(dir, "work");
  otherDir = join(dir, "other");
  mkdirSync(workDir);
  mkdirSync(otherDir);
  daemon = startFakeCodexDaemon(codexDaemonSocket());
  registration = undefined;
  couriers = [];
  children = [];
  peers = [];
});

afterEach(() => {
  for (const courier of couriers) courier.stop();
  for (const child of children) child.kill();
  for (const peer of peers) peer.stop();
  registration?.unregister();
  daemon.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const name of ENV_KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

function logLines(): Array<Record<string, unknown>> {
  const path = join(process.env.IDNMA_CONFIG_DIR!, "logs", "idnma.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const loggedEvents = (event: string) => logLines().filter((line) => line.event === event);

interface Harness {
  courier: Courier;
  queue: MessageQueue;
  /** Notifications reçues par ce livreur, avant son propre filtrage. */
  seen: CodexNotification[];
}

function makeCourier(
  overrides: {
    registration?: Registration;
    cwd?: string;
    adoptionTimeoutMs?: number;
    daemonPid?: () => Promise<number | undefined>;
    reconnectDelayMs?: number;
    requestTimeoutMs?: number;
  } = {},
): Harness {
  const seen: CodexNotification[] = [];
  const queue = new MessageQueue();
  const courier = createCodexCourier({
    name: "codex-test",
    fromMode: "prompting",
    registration: overrides.registration ?? fakeRegistration(),
    queue,
    cwd: overrides.cwd ?? workDir,
    connect: (onNotification, { allowStart }) =>
      connectDaemon({
        onNotification: (notification) => {
          seen.push(notification);
          onNotification(notification);
        },
        allowStart,
        startDaemon: async () => {},
      }),
    ...(overrides.daemonPid === undefined ? {} : { daemonPid: overrides.daemonPid }),
    ...(overrides.adoptionTimeoutMs === undefined ? {} : { adoptionTimeoutMs: overrides.adoptionTimeoutMs }),
    ...(overrides.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: overrides.reconnectDelayMs }),
    ...(overrides.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: overrides.requestTimeoutMs }),
  });
  couriers.push(courier);
  return { courier, queue, seen };
}

function thread(
  id: string,
  overrides: { cwd?: string; ephemeral?: boolean; threadSource?: string; parentThreadId?: string | null; status?: string } = {},
): Record<string, unknown> {
  return {
    thread: {
      id,
      cwd: overrides.cwd ?? workDir,
      ephemeral: overrides.ephemeral ?? false,
      threadSource: overrides.threadSource ?? "user",
      parentThreadId: overrides.parentThreadId === undefined ? null : overrides.parentThreadId,
      status: { type: overrides.status ?? "idle" },
      preview: "",
      turns: [],
    },
  };
}

async function waitForSeen(harness: Harness, count: number): Promise<void> {
  await waitFor(() => harness.seen.length >= count);
}

const pointerExists = (id: string) => existsSync(codexPointerPath(id));

describe("harness hooks", () => {
  test("codex courier reads null and answers hooks with {}", async () => {
    const { courier } = makeCourier();
    expect(courier.read()).toBeNull();
    expect(await courier.hook("grok", "Stop", { a: 1 })).toEqual({});
    expect(await courier.hook("agy", "PreInvocation", {})).toEqual({});
  });
});

describe("adoption", () => {
  test("adopts only the user thread started in its directory", async () => {
    const { courier, seen } = makeCourier();
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_TITLE, { ephemeral: true, threadSource: "thread_title" }));
    daemon.notify("thread/started", thread(THREAD_ELSEWHERE, { cwd: otherDir }));
    daemon.notify("thread/started", thread(THREAD_B, { parentThreadId: THREAD_A }));
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    expect(seen.length).toBe(4);
    expect(pointerExists(THREAD_TITLE)).toBe(false);
    expect(pointerExists(THREAD_ELSEWHERE)).toBe(false);
    expect(pointerExists(THREAD_B)).toBe(false);
    expect(JSON.parse(readFileSync(codexPointerPath(THREAD_A), "utf8"))).toEqual({ socketPath: controlSocketPath() });
    expect(loggedEvents("codex-adopted")).toEqual([expect.objectContaining({ threadId: THREAD_A })]);
  });

  test("ignores threads started before the agent is spawned", async () => {
    const harness = makeCourier();
    await harness.courier.beforeSpawn();
    daemon.notify("thread/started", thread(THREAD_B));
    await waitForSeen(harness, 1);
    harness.courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    expect(pointerExists(THREAD_B)).toBe(false);
  });

  test("compares resolved paths", async () => {
    // Un lien explicite vers le dossier de travail : discriminant aussi sous Linux, où /tmp n'est pas un lien.
    const viaLink = join(dir, "work-link");
    symlinkSync(workDir, viaLink);
    const resolved = realpathSync(workDir);
    expect(resolved).not.toBe(viaLink);
    const { courier } = makeCourier({ cwd: viaLink });
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A, { cwd: resolved }));
    await waitFor(() => pointerExists(THREAD_A));
  });

  test("adopts only once: a later user thread in the same directory is ignored", async () => {
    const { courier } = makeCourier();
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    daemon.notify("thread/started", thread(THREAD_B));
    await waitFor(() => pointerExists(THREAD_A));
    await Bun.sleep(100);
    expect(pointerExists(THREAD_B)).toBe(false);
  });

  test("publishes the status of the thread at adoption: active means busy and subscribed", async () => {
    const fake = fakeRegistration();
    daemon.handle("thread/resume", () => ({ result: {} }));
    const { courier } = makeCourier({ registration: fake });
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A, { status: "active" }));
    await waitFor(() => daemon.received.some((frame) => frame.method === "thread/resume"));
    expect(fake.statuses).toEqual(["busy"]);
  });

  test("an unknown status at adoption publishes nothing", async () => {
    const fake = fakeRegistration();
    const { courier } = makeCourier({ registration: fake });
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A, { status: "notLoaded" }));
    await waitFor(() => pointerExists(THREAD_A));
    expect(fake.statuses).toEqual([]);
    expect(daemon.received.some((frame) => frame.method === "thread/resume")).toBe(false);
  });
});

describe("state", () => {
  test("publishes busy and subscribes on first activity", async () => {
    registration = await registerPeer({ name: "codex-test", cwd: workDir, onMessage: () => {} });
    const entryStatus = () => listLiveEntries().find((entry) => entry.name === "codex-test")?.status;
    const resumes = () => daemon.received.filter((frame) => frame.method === "thread/resume");
    daemon.handle("thread/resume", () => ({ result: {} }));
    const { courier } = makeCourier({ registration });
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    expect(entryStatus()).toBe("idle");

    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "active", activeFlags: [] } });
    await waitFor(() => entryStatus() === "busy");
    await waitFor(() => resumes().length === 1);
    expect(resumes()[0]!.params).toEqual({ threadId: THREAD_A, excludeTurns: true });

    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "idle" } });
    await waitFor(() => entryStatus() === "idle");

    // Déjà abonné : une nouvelle activité ne relance pas de `thread/resume`.
    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "active", activeFlags: [] } });
    await waitFor(() => entryStatus() === "busy");
    await Bun.sleep(100);
    expect(resumes().length).toBe(1);
  });

  test("a failed thread/resume is logged and retried at the next activity", async () => {
    let attempts = 0;
    daemon.handle("thread/resume", () => {
      attempts++;
      return attempts === 1 ? { error: { code: -32000, message: "no rollout found" } } : { result: {} };
    });
    const { courier } = makeCourier();
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));

    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "active", activeFlags: [] } });
    await waitFor(() => loggedEvents("codex-resume-error").length === 1);
    expect(loggedEvents("codex-resume-error")[0]!.message).toBe("no rollout found");

    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "idle" } });
    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "active", activeFlags: [] } });
    await waitFor(() => attempts === 2);
    await Bun.sleep(100);
    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "active", activeFlags: [] } });
    await Bun.sleep(100);
    expect(attempts).toBe(2);
  });

  test("a failed thread/resume is retried even when the next activity arrived during the failed request", async () => {
    let attempts = 0;
    daemon.handle("thread/resume", () => {
      attempts++;
      // Le premier essai ne répond jamais : il échoue au délai, après l'arrivée du second `active`.
      return attempts === 1 ? undefined : { result: {} };
    });
    const { courier } = makeCourier({ requestTimeoutMs: 400 });
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));

    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "active", activeFlags: [] } });
    await waitFor(() => attempts === 1);
    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "idle" } });
    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "active", activeFlags: [] } });
    await waitFor(() => loggedEvents("codex-resume-error").length === 1);
    await waitFor(() => attempts === 2);
    await Bun.sleep(100);
    expect(attempts).toBe(2);
  });

  test("systemError and notLoaded are logged and publish nothing", async () => {
    const fake = fakeRegistration();
    const { courier } = makeCourier({ registration: fake });
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    const before = fake.statuses.length;
    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "systemError" } });
    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "notLoaded" } });
    await waitFor(() => loggedEvents("codex-thread-status").length === 2);
    expect(loggedEvents("codex-thread-status").map((line) => line.status)).toEqual(["systemError", "notLoaded"]);
    expect(fake.statuses.length).toBe(before);
  });

  test("ignores the status of a thread that is not the adopted one", async () => {
    const fake = fakeRegistration();
    const { courier } = makeCourier({ registration: fake });
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    const before = fake.statuses.length;
    daemon.notify("thread/status/changed", { threadId: THREAD_B, status: { type: "active", activeFlags: [] } });
    await Bun.sleep(100);
    expect(fake.statuses.length).toBe(before);
    expect(daemon.received.some((frame) => frame.method === "thread/resume")).toBe(false);
  });
});

describe("adoption timeout and daemon loss", () => {
  test("leaves the bus when no thread shows up", async () => {
    registration = await registerPeer({ name: "codex-test", cwd: workDir, onMessage: () => {} });
    const { courier } = makeCourier({ registration, adoptionTimeoutMs: 300 });
    await courier.beforeSpawn();
    expect(listLiveEntries().some((entry) => entry.name === "codex-test")).toBe(true);
    courier.afterSpawn();
    await waitFor(() => !listLiveEntries().some((entry) => entry.name === "codex-test"));
    expect(loggedEvents("codex-adoption-timeout")).toEqual([expect.objectContaining({ cwd: workDir })]);
    await waitFor(() => daemon.openConnections() === 0);
  });

  test("a timed-out courier releases the lock and ignores a thread that shows up late", async () => {
    const { courier } = makeCourier({ adoptionTimeoutMs: 100 });
    await courier.beforeSpawn();
    courier.afterSpawn();
    await waitFor(() => loggedEvents("codex-adoption-timeout").length === 1);
    expect(await settlesWithin(makeCourier().courier.beforeSpawn(), 500)).toBe(true);
    daemon.notify("thread/started", thread(THREAD_A));
    await Bun.sleep(100);
    expect(pointerExists(THREAD_A)).toBe(false);
  });

  test("a lost daemon before adoption releases the lock", async () => {
    const { courier } = makeCourier();
    await courier.beforeSpawn();
    courier.afterSpawn();
    expect(daemon.openConnections()).toBe(1);
    daemon.dropConnections();
    await waitFor(() => daemon.openConnections() === 0);
    expect(await settlesWithin(makeCourier().courier.beforeSpawn(), 1000)).toBe(true);
  });
});

describe("daemon loss before adoption", () => {
  test("a daemon lost before adoption unregisters once, logs one terminal event and cancels the timeout", async () => {
    const fake = fakeRegistration();
    const { courier } = makeCourier({ registration: fake, adoptionTimeoutMs: 300 });
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.dropConnections();
    await waitFor(() => loggedEvents("codex-daemon-lost").length === 1);
    expect(fake.unregistered).toBe(1);
    await Bun.sleep(450);
    expect(loggedEvents("codex-adoption-timeout")).toEqual([]);
    expect(loggedEvents("codex-daemon-lost").length).toBe(1);
    expect(loggedEvents("codex-daemon-closed")).toEqual([]);
    expect(fake.unregistered).toBe(1);
    // Détaché : un thread qui apparaît ensuite n'est plus adopté.
    daemon.notify("thread/started", thread(THREAD_A));
    await Bun.sleep(100);
    expect(pointerExists(THREAD_A)).toBe(false);
  });
});

describe("two couriers in one directory", () => {
  test("two couriers in one directory adopt distinct threads", async () => {
    const registrationA = fakeRegistration();
    const registrationB = fakeRegistration();
    const one = makeCourier({ registration: registrationA, daemonPid: async () => process.pid });
    const two = makeCourier({ registration: registrationB, daemonPid: async () => process.pid });
    const settled: Courier[] = [];
    const first = one.courier.beforeSpawn().then(() => settled.push(one.courier));
    const second = two.courier.beforeSpawn().then(() => settled.push(two.courier));
    await waitFor(() => settled.length === 1);
    await Bun.sleep(150);
    // Le second reste bloqué tant que le premier n'a pas adopté.
    expect(settled.length).toBe(1);
    const leader = settled[0]!;
    const follower = leader === one.courier ? two.courier : one.courier;

    leader.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    await Promise.all([first, second]);
    expect(settled.length).toBe(2);

    follower.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_B));
    await waitFor(() => pointerExists(THREAD_B));

    const child = Bun.spawn(["sleep", "600"]);
    children.push(child);
    expect(await leader.verifyCaller({ codexThreadId: THREAD_A }, child.pid)).toBe(true);
    expect(await leader.verifyCaller({ codexThreadId: THREAD_B }, child.pid)).toBe(false);
    expect(await follower.verifyCaller({ codexThreadId: THREAD_B }, child.pid)).toBe(true);
    expect(await follower.verifyCaller({ codexThreadId: THREAD_A }, child.pid)).toBe(false);
  });
});

describe("verifyCaller", () => {
  test("accepts a descendant of the daemon for the adopted thread only", async () => {
    const { courier } = makeCourier({ daemonPid: async () => process.pid });
    await courier.beforeSpawn();
    const child = Bun.spawn(["sleep", "600"]);
    children.push(child);
    expect(await courier.verifyCaller({ codexThreadId: THREAD_A }, child.pid)).toBe(false);
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    expect(await courier.verifyCaller({ codexThreadId: THREAD_A }, child.pid)).toBe(true);
    expect(await courier.verifyCaller({ codexThreadId: THREAD_B }, child.pid)).toBe(false);
    expect(await courier.verifyCaller({ codexThreadId: THREAD_A }, undefined)).toBe(false);
    expect(await courier.verifyCaller({ codexThreadId: THREAD_A }, 1)).toBe(false);
  });

  test("refuses when the daemon pid is unknown", async () => {
    const { courier } = makeCourier({ daemonPid: async () => undefined });
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    const child = Bun.spawn(["sleep", "600"]);
    children.push(child);
    expect(await courier.verifyCaller({ codexThreadId: THREAD_A }, child.pid)).toBe(false);
  });
});

describe("stop and failures", () => {
  test("stop releases everything", async () => {
    const { courier } = makeCourier();
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    expect(daemon.openConnections()).toBe(1);

    courier.stop();
    courier.stop();
    expect(pointerExists(THREAD_A)).toBe(false);
    await waitFor(() => daemon.openConnections() === 0);
    expect(await settlesWithin(makeCourier().courier.beforeSpawn(), 500)).toBe(true);
  });

  test("stop before adoption releases the lock and the connection", async () => {
    const { courier } = makeCourier();
    await courier.beforeSpawn();
    courier.afterSpawn();
    courier.stop();
    await waitFor(() => daemon.openConnections() === 0);
    expect(await settlesWithin(makeCourier().courier.beforeSpawn(), 500)).toBe(true);
  });

  test("stop aborts a pending lock wait", async () => {
    const holder = makeCourier();
    await holder.courier.beforeSpawn();
    const waiter = makeCourier();
    const waiting = waiter.courier.beforeSpawn();
    // Le rejet est capturé sans `expect(...).rejects` : Bun attendrait la promesse avant de rendre la main.
    const outcome = waiting.catch((error: unknown) => error);
    await Bun.sleep(100);
    const start = Date.now();
    waiter.courier.stop();
    expect(await outcome).toBeInstanceOf(CourierUnavailableError);
    expect(Date.now() - start).toBeLessThan(500);
    await waitFor(() => daemon.openConnections() === 1);

    // Le premier garde son verrou : un troisième livreur attend toujours.
    const third = makeCourier();
    let thirdSettled = false;
    const thirdPending = third.courier.beforeSpawn().then(() => {
      thirdSettled = true;
    });
    await Bun.sleep(150);
    expect(thirdSettled).toBe(false);
    holder.courier.stop();
    await thirdPending;
  });

  test("beforeSpawn rejects with the connection error message when connect rejects", async () => {
    const courier = createCodexCourier({
      name: "codex-test",
      fromMode: "prompting",
      registration: fakeRegistration(),
      queue: new MessageQueue(),
      cwd: workDir,
      connect: async () => {
        throw new Error("daemon Codex injoignable");
      },
    });
    couriers.push(courier);
    const failure = await courier.beforeSpawn().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CourierUnavailableError);
    expect((failure as Error).message).toBe("daemon Codex injoignable");
  });

  test("a courier stopped before beforeSpawn rejects and opens nothing", async () => {
    const early = makeCourier();
    early.courier.stop();
    const failure = await early.courier.beforeSpawn().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CourierUnavailableError);
    expect(daemon.openConnections()).toBe(0);
  });

  test("ignores notifications delivered after stop or after the adoption timeout", async () => {
    let deliver: ((notification: CodexNotification) => void) | undefined;
    const client: CodexClient = { request: async () => ({}) as never, close: () => {}, closed: new Promise<void>(() => {}) };
    const build = (adoptionTimeoutMs?: number) => {
      const courier = createCodexCourier({
        name: "codex-test",
        fromMode: "prompting",
        registration: fakeRegistration(),
        queue: new MessageQueue(),
        cwd: workDir,
        connect: async (onNotification) => {
          deliver = onNotification;
          return client;
        },
        ...(adoptionTimeoutMs === undefined ? {} : { adoptionTimeoutMs }),
      });
      couriers.push(courier);
      return courier;
    };

    const stopped = build();
    await stopped.beforeSpawn();
    stopped.afterSpawn();
    stopped.stop();
    deliver!({ method: "thread/started", params: thread(THREAD_A) });
    expect(pointerExists(THREAD_A)).toBe(false);

    const timedOut = build(50);
    await timedOut.beforeSpawn();
    timedOut.afterSpawn();
    await waitFor(() => loggedEvents("codex-adoption-timeout").length === 1);
    deliver!({ method: "thread/started", params: thread(THREAD_B) });
    expect(pointerExists(THREAD_B)).toBe(false);
  });
});

const turnStarts = () => daemon.received.filter((frame) => frame.method === "turn/start");
/** Texte envoyé par le n-ième `turn/start`. */
const turnText = (index: number): string => (turnStarts()[index]!.params as { input: Array<{ text: string }> }).input[0]!.text;
const threadReads = () => daemon.received.filter((frame) => frame.method === "thread/read");
const threadResumes = () => daemon.received.filter((frame) => frame.method === "thread/resume");
const finalAnswer = (text: string) => ({ type: "agentMessage", phase: "final_answer", text });
/** Enveloppe d'un message envoyé en retour par le livreur : le corps commence par la marque de renvoi automatique. */
const autoReplyEnvelopeOf = (text: string) =>
  buildEnvelope({ from: addressOf("/tmp/unused.sock"), fromName: "codex-test", fromMode: "prompting", body: `${AUTO_REPLY_MARKER}\n${text}` });
const NOT_STEERABLE = {
  code: -32603,
  message: "failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }",
};

/** Le faux daemon répond à chaque `turn/start` par l'id suivant, dans l'ordre, avec la forme mesurée. */
function scriptTurnStarts(...ids: string[]): void {
  let next = 0;
  daemon.handle("turn/start", () => {
    const id = ids[next++];
    if (id === undefined) return { error: { code: -32000, message: "unscripted turn/start" } };
    return { result: { turn: { id, status: "inProgress", items: [] } } };
  });
}

const notifyStatus = (type: "idle" | "active"): void =>
  daemon.notify("thread/status/changed", {
    threadId: THREAD_A,
    status: type === "active" ? { type, activeFlags: [] } : { type },
  });
const notifyTurnStarted = (id: string): void =>
  daemon.notify("turn/started", { threadId: THREAD_A, turn: { id, status: "inProgress", items: [] } });
const notifyTurnCompleted = (id: string, turn: Record<string, unknown> = {}): void =>
  daemon.notify("turn/completed", { threadId: THREAD_A, turn: { id, status: "completed", items: [], ...turn } });
/** Fin de tour dans l'ordre mesuré : `idle`, puis `turn/completed`. */
const finishTurn = (id: string, turn: Record<string, unknown> = {}): void => {
  notifyStatus("idle");
  notifyTurnCompleted(id, turn);
};

/** Notifie `active` (et `turn/started` si un id est donné), puis attend que le livreur les ait traitées. */
async function enterTurn(harness: Harness, turnId?: string): Promise<void> {
  const before = harness.seen.length;
  notifyStatus("active");
  if (turnId !== undefined) notifyTurnStarted(turnId);
  await waitFor(() => harness.seen.length >= before + (turnId === undefined ? 1 : 2));
}

async function startPeer(name: string): Promise<FakePeer> {
  const peer = await startFakePeer(name);
  peers.push(peer);
  return peer;
}

function submit(harness: Harness, from: FakePeer, content: string, priority: Priority = "next", msgId?: string): InboundMessage {
  const message: InboundMessage = {
    ...(msgId === undefined ? {} : { msgId }),
    from: addressOf(from.socketPath),
    priority,
    content,
    authenticated: true,
    receivedAt: Date.now(),
  };
  harness.queue.push(message);
  harness.courier.onMessage();
  return message;
}

const userContents = (peer: FakePeer): string[] =>
  peer.lines
    .filter((line) => (line as { type?: string }).type === "user")
    .map((line) => (line as { message: { content: string } }).message.content);


describe("delivery", () => {
  async function adoptedHarness(o: { status?: string; make?: Parameters<typeof makeCourier>[0] } = {}): Promise<Harness> {
    daemon.handle("thread/resume", () => ({ result: {} }));
    const harness = makeCourier(o.make);
    await harness.courier.beforeSpawn();
    harness.courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A, { status: o.status ?? "idle" }));
    await waitFor(() => pointerExists(THREAD_A));
    return harness;
  }

  test("starts a turn for a message at rest and returns the final answer", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    const harness = await adoptedHarness();
    submit(harness, vulcain, "bonjour codex", "next", "msg-1");
    await waitFor(() => turnStarts().length === 1);
    expect(turnStarts()[0]!.params).toEqual({
      threadId: THREAD_A,
      clientUserMessageId: "idnma-msg-1",
      input: [{ type: "text", text: "bonjour codex", text_elements: [] }],
    });
    await waitFor(() => harness.queue.size === 0);

    notifyStatus("active");
    notifyTurnStarted("T1");
    finishTurn("T1", { items: [{ type: "agentMessage", phase: "commentary", text: "je réfléchis" }, finalAnswer("RÉPONSE")] });
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("RÉPONSE")]);
  });

  test("queues messages that arrive at rest, one turn each", async () => {
    const vulcain = await startPeer("claude-vulcain");
    const mars = await startPeer("claude-mars");
    scriptTurnStarts("T1", "T2");
    const harness = await adoptedHarness();
    submit(harness, vulcain, "question de vulcain");
    submit(harness, mars, "question de mars");
    await waitFor(() => turnStarts().length === 1);
    await waitFor(() => harness.queue.size === 1);
    await enterTurn(harness, "T1");
    await Bun.sleep(150);
    expect(turnStarts().length).toBe(1);

    finishTurn("T1", { items: [finalAnswer("réponse 1")] });
    await waitFor(() => turnStarts().length === 2);
    expect(turnText(1)).toBe("question de mars");
    notifyStatus("active");
    notifyTurnStarted("T2");
    finishTurn("T2", { items: [finalAnswer("réponse 2")] });
    await waitFor(() => userContents(vulcain).length === 1 && userContents(mars).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("réponse 1")]);
    expect(userContents(mars)).toEqual([autoReplyEnvelopeOf("réponse 2")]);
  });

  test("steers into the user's turn without auto-reply", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("R1");
    const harness = await adoptedHarness();
    await enterTurn(harness, "R1");
    submit(harness, vulcain, "un mot en passant", "next");
    await waitFor(() => turnStarts().length === 1);
    await waitFor(() => harness.queue.size === 0);
    finishTurn("R1", { items: [finalAnswer("réponse à l'utilisateur")] });
    await Bun.sleep(200);
    expect(vulcain.lines.filter((line) => (line as { type?: string }).type === "user")).toEqual([]);
    expect(loggedEvents("reply-without-sender")).toEqual([]);
  });

  test("a peer message steered into the user's turn carries the reply hint, one that opens a peer turn does not", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("R1", "T2");
    const harness = await adoptedHarness();
    const envelope = buildEnvelope({ from: addressOf(vulcain.socketPath), fromName: "claude-vulcain", fromMode: "bypass", body: "renvoie-moi FRAISE-17" });
    await enterTurn(harness, "R1");
    submit(harness, vulcain, envelope, "next");
    await waitFor(() => turnStarts().length === 1);
    expect(turnText(0)).toBe(withReplyHint(envelope));
    expect(turnText(0)).not.toBe(envelope);
    const before = harness.seen.length;
    finishTurn("R1", { items: [finalAnswer("réponse à l'utilisateur")] });
    await waitFor(() => harness.seen.length >= before + 2);
    submit(harness, vulcain, envelope, "next");
    await waitFor(() => turnStarts().length === 2);
    expect(turnText(1)).toBe(envelope);
  });

  test("steers into a turn whose start was never seen", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("R1");
    const harness = await adoptedHarness();
    // Premier tour de la TUI : `active` sans aucun `turn/started`.
    await enterTurn(harness);
    submit(harness, vulcain, "un mot en passant", "next");
    await waitFor(() => turnStarts().length === 1);
    await waitFor(() => harness.queue.size === 0);
    finishTurn("R1", { items: [finalAnswer("réponse à l'utilisateur")] });
    await Bun.sleep(200);
    expect(userContents(vulcain)).toEqual([]);
  });

  test("holds later during the user's turn", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    const harness = await adoptedHarness();
    await enterTurn(harness, "R1");
    submit(harness, vulcain, "plus tard", "later");
    await Bun.sleep(200);
    expect(turnStarts().length).toBe(0);
    notifyStatus("idle");
    await waitFor(() => turnStarts().length === 1);
  });

  test("steers a now queued behind a held later", async () => {
    const vulcain = await startPeer("claude-vulcain");
    const mars = await startPeer("claude-mars");
    scriptTurnStarts("R1", "T2");
    const harness = await adoptedHarness();
    await enterTurn(harness, "R1");
    submit(harness, vulcain, "plus tard", "later");
    submit(harness, mars, "tout de suite", "now");
    await waitFor(() => turnStarts().length === 1);
    expect(turnText(0)).toBe("tout de suite");
    await waitFor(() => harness.queue.size === 1);
    await Bun.sleep(100);
    expect(turnStarts().length).toBe(1);
    notifyStatus("idle");
    await waitFor(() => turnStarts().length === 2);
    expect(turnText(1)).toBe("plus tard");
  });

  test("keeps a peer turn to one message unless now", async () => {
    const a = await startPeer("claude-vulcain");
    const b = await startPeer("claude-mars");
    // Le steer du `now` de B rend l'id du tour de A ; le `next` de B part ensuite au repos (T2).
    scriptTurnStarts("T1", "T1", "T2");
    const harness = await adoptedHarness();
    submit(harness, a, "message de A");
    await waitFor(() => turnStarts().length === 1);
    await waitFor(() => harness.queue.size === 0);
    // `turn/started` de T1 omis : l'id du tour vient de la réponse de `turn/start`.
    await enterTurn(harness);

    submit(harness, b, "suite de B", "next");
    await Bun.sleep(150);
    expect(turnStarts().length).toBe(1);
    submit(harness, b, "urgence de B", "now");
    await waitFor(() => turnStarts().length === 2);
    expect(turnText(1)).toBe("urgence de B");
    await waitFor(() => harness.queue.size === 1);

    finishTurn("T1", { items: [finalAnswer("réponse du tour de A")] });
    await waitFor(() => userContents(a).length === 1);
    expect(userContents(a)).toEqual([autoReplyEnvelopeOf("réponse du tour de A")]);
    await waitFor(() => turnStarts().length === 3);
    await waitFor(() => harness.queue.size === 0);
    await Bun.sleep(100);
    expect(userContents(b)).toEqual([]);
  });

  test("waits for an idle after ActiveTurnNotSteerable", async () => {
    const vulcain = await startPeer("claude-vulcain");
    const mars = await startPeer("claude-mars");
    let attempts = 0;
    daemon.handle("turn/start", () => {
      attempts++;
      return attempts === 1 ? { error: NOT_STEERABLE } : { result: { turn: { id: "T1", status: "inProgress", items: [] } } };
    });
    const harness = await adoptedHarness();
    submit(harness, vulcain, "pendant un compactage", "next");
    await waitFor(() => turnStarts().length === 1);
    await Bun.sleep(300);
    expect(turnStarts().length).toBe(1);
    expect(harness.queue.size).toBe(1);
    expect(loggedEvents("codex-delivery-error")).toEqual([]);
    expect(userContents(vulcain)).toEqual([]);

    // Chaque relance possible pendant le blocage : `active`, nouveau message `now` (onMessage), fin d'un autre tour.
    await enterTurn(harness);
    submit(harness, mars, "urgence pendant le compactage", "now");
    notifyTurnCompleted("OTHER");
    await Bun.sleep(300);
    expect(turnStarts().length).toBe(1);
    expect(harness.queue.size).toBe(2);

    notifyStatus("idle");
    await waitFor(() => turnStarts().length === 3);
    await waitFor(() => harness.queue.size === 0);
    expect(turnText(1)).toBe("pendant un compactage");
    expect(turnText(2)).toBe("urgence pendant le compactage");
  });

  test("keeps the message on a local error", async () => {
    const vulcain = await startPeer("claude-vulcain");
    daemon.handle("turn/start", () => undefined);
    const harness = await adoptedHarness({ make: { requestTimeoutMs: 150 } });
    submit(harness, vulcain, "sans réponse du daemon");
    await waitFor(() => turnStarts().length === 1);
    await Bun.sleep(400);
    expect(harness.queue.size).toBe(1);
    // Pas de nouvel essai en boucle, et aucun « non livré » à l'expéditeur.
    expect(turnStarts().length).toBe(1);
    expect(userContents(vulcain)).toEqual([]);
    expect(loggedEvents("codex-delivery-error")).toEqual([]);
  });

  test("reports a refused delivery to the sender", async () => {
    const vulcain = await startPeer("claude-vulcain");
    daemon.handle("turn/start", () => ({ error: { code: -32600, message: "thread not found" } }));
    const harness = await adoptedHarness();
    submit(harness, vulcain, "vers un thread disparu", "next", "msg-9");
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("codex-test : message non livré (thread not found)")]);
    expect(harness.queue.size).toBe(0);
    expect(loggedEvents("codex-delivery-error")).toEqual([expect.objectContaining({ msgId: "msg-9", message: "thread not found" })]);
  });

  test("reports an interrupted and a failed turn", async () => {
    const vulcain = await startPeer("claude-vulcain");
    const mars = await startPeer("claude-mars");
    scriptTurnStarts("T1", "T2");
    const harness = await adoptedHarness();
    submit(harness, vulcain, "premier");
    await waitFor(() => harness.queue.size === 0);
    notifyStatus("active");
    finishTurn("T1", { status: "interrupted" });
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("codex-test : tour interrompu")]);

    submit(harness, mars, "second");
    await waitFor(() => turnStarts().length === 2);
    await waitFor(() => harness.queue.size === 0);
    notifyStatus("active");
    finishTurn("T2", { status: "failed", error: { message: "boom" } });
    await waitFor(() => userContents(mars).length === 1);
    expect(userContents(mars)).toEqual([autoReplyEnvelopeOf("codex-test : tour en échec (boom)")]);
  });

  test("reports a completed turn without any answer", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    const harness = await adoptedHarness();
    submit(harness, vulcain, "muet");
    await waitFor(() => harness.queue.size === 0);
    notifyStatus("active");
    finishTurn("T1", { items: [{ type: "reasoning" }] });
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("codex-test : tour terminé sans réponse")]);
  });

  test("falls back to the last agent message when no final answer is flagged", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    const harness = await adoptedHarness();
    submit(harness, vulcain, "sans phase");
    await waitFor(() => harness.queue.size === 0);
    notifyStatus("active");
    finishTurn("T1", {
      items: [
        { type: "agentMessage", phase: "commentary", text: "premier" },
        { type: "agentMessage", phase: "commentary", text: "dernier" },
      ],
    });
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("dernier")]);
  });

  test("a vanished sender is logged and the next message is still delivered", async () => {
    const vulcain = await startPeer("claude-vulcain");
    const mars = await startPeer("claude-mars");
    scriptTurnStarts("T1", "T2");
    const harness = await adoptedHarness();
    submit(harness, vulcain, "premier");
    await waitFor(() => harness.queue.size === 0);
    notifyStatus("active");
    vulcain.stop();
    finishTurn("T1", { items: [finalAnswer("trop tard")] });
    await waitFor(() => loggedEvents("reply-error").length === 1);
    submit(harness, mars, "second");
    await waitFor(() => turnStarts().length === 2);
  });

  test("logs a reply without sender and delivers nothing to anyone", async () => {
    scriptTurnStarts("T1");
    const harness = await adoptedHarness();
    harness.queue.push({ msgId: "anonymous", priority: "next", content: "sans adresse", authenticated: true, receivedAt: Date.now() });
    harness.courier.onMessage();
    await waitFor(() => harness.queue.size === 0);
    notifyStatus("active");
    finishTurn("T1", { items: [finalAnswer("réponse")] });
    await waitFor(() => loggedEvents("reply-without-sender").length === 1);
    expect(loggedEvents("reply-without-sender")[0]!.msgId).toBe("anonymous");
  });

  test("delivers a 200 KiB body untouched, closing tag included", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    const harness = await adoptedHarness();
    const content = "x".repeat(200 * 1024) + "</cross-session-message>" + "fin";
    submit(harness, vulcain, content);
    await waitFor(() => turnStarts().length === 1);
    expect(turnText(0) === content).toBe(true);
  });

  test("delivers what arrived before adoption", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    daemon.handle("thread/resume", () => ({ result: {} }));
    const harness = makeCourier();
    await harness.courier.beforeSpawn();
    harness.courier.afterSpawn();
    submit(harness, vulcain, "arrivé trop tôt");
    await Bun.sleep(150);
    expect(turnStarts().length).toBe(0);
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => turnStarts().length === 1);
  });

  test("waits for a known state", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    const harness = await adoptedHarness({ status: "notLoaded" });
    submit(harness, vulcain, "état inconnu");
    await Bun.sleep(150);
    expect(turnStarts().length).toBe(0);
    notifyStatus("idle");
    await waitFor(() => turnStarts().length === 1);
  });

  test("never delivers after stop", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    const harness = await adoptedHarness();
    harness.courier.stop();
    submit(harness, vulcain, "trop tard");
    await Bun.sleep(150);
    expect(turnStarts().length).toBe(0);
  });

  test("an auto-reply delivered at rest starts a turn that never answers back", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    const harness = await adoptedHarness();
    const content = buildEnvelope({
      from: addressOf(vulcain.socketPath),
      fromName: "claude-vulcain",
      fromMode: "bypass",
      body: `${AUTO_REPLY_MARKER}\nbien reçu, le build passe`,
    });
    submit(harness, vulcain, content, "next", "msg-auto");
    await waitFor(() => turnStarts().length === 1);
    // Livrée comme les autres : le texte part tel quel, marque comprise.
    expect(turnText(0)).toBe(content);
    await waitFor(() => harness.queue.size === 0);

    notifyStatus("active");
    notifyTurnStarted("T1");
    finishTurn("T1", { items: [finalAnswer("réponse à une réponse")] });
    await Bun.sleep(200);
    expect(userContents(vulcain)).toEqual([]);
    expect(loggedEvents("reply-without-sender")).toEqual([]);
  });

  test("a request queued behind an auto-reply gets its own turn and its answer", async () => {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1", "T2");
    const harness = await adoptedHarness();
    const envelope = (body: string) => buildEnvelope({ from: addressOf(vulcain.socketPath), fromName: "claude-vulcain", fromMode: "bypass", body });
    submit(harness, vulcain, envelope(`${AUTO_REPLY_MARKER}\nune réponse`));
    submit(harness, vulcain, envelope("une vraie demande"));
    await waitFor(() => turnStarts().length === 1);
    await waitFor(() => harness.queue.size === 1);
    // Le tour du renvoi tient la place d'un tour de pair : la vraie demande attend son propre tour, elle n'est pas fondue dans celui-ci.
    await Bun.sleep(150);
    expect(turnStarts().length).toBe(1);
    notifyStatus("active");
    notifyTurnStarted("T1");
    finishTurn("T1", { items: [finalAnswer("sans suite")] });
    await waitFor(() => turnStarts().length === 2);
    await waitFor(() => harness.queue.size === 0);
    notifyStatus("active");
    notifyTurnStarted("T2");
    finishTurn("T2", { items: [finalAnswer("la réponse attendue")] });
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("la réponse attendue")]);
  });
});

describe("the user's input in a peer turn", () => {
  async function adoptedHarness(): Promise<Harness> {
    daemon.handle("thread/resume", () => ({ result: {} }));
    const harness = makeCourier();
    await harness.courier.beforeSpawn();
    harness.courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    return harness;
  }
  const notifyItem = (method: "item/started" | "item/completed", turnId: string, item: Record<string, unknown>): void =>
    daemon.notify(method, { threadId: THREAD_A, turnId, item });
  const userMessage = (clientId: unknown): Record<string, unknown> => ({
    type: "userMessage",
    id: "item-1",
    content: [{ type: "text", text: "et pendant ce temps", text_elements: [] }],
    clientId,
  });

  /** Un tour T1 lancé pour `vulcain`, noté et en cours. */
  async function peerTurnInFlight(): Promise<{ harness: Harness; vulcain: FakePeer }> {
    const vulcain = await startPeer("claude-vulcain");
    scriptTurnStarts("T1");
    const harness = await adoptedHarness();
    submit(harness, vulcain, "une demande", "next", "msg-1");
    await waitFor(() => turnStarts().length === 1);
    await waitFor(() => harness.queue.size === 0);
    await enterTurn(harness, "T1");
    return { harness, vulcain };
  }

  for (const method of ["item/started", "item/completed"] as const) {
    test(`a userMessage typed by l'utilisateur (${method}) cancels the auto-reply of the peer turn`, async () => {
      const { harness, vulcain } = await peerTurnInFlight();
      const before = harness.seen.length;
      notifyItem(method, "T1", userMessage("a553d52d-b292-4f54-8cb1-29cc3b0da13b"));
      await waitFor(() => harness.seen.length >= before + 1);
      finishTurn("T1", { items: [finalAnswer("mélange de deux demandes")] });
      await Bun.sleep(200);
      expect(userContents(vulcain)).toEqual([]);
      expect(loggedEvents("codex-peer-turn-mixed")).toEqual([expect.objectContaining({ turnId: "T1" })]);
    });
  }

  test("a userMessage without any client id also cancels the auto-reply", async () => {
    const { harness, vulcain } = await peerTurnInFlight();
    const before = harness.seen.length;
    notifyItem("item/started", "T1", userMessage(null));
    await waitFor(() => harness.seen.length >= before + 1);
    finishTurn("T1", { items: [finalAnswer("mélange")] });
    await Bun.sleep(200);
    expect(userContents(vulcain)).toEqual([]);
  });

  test("the courier's own userMessage keeps the auto-reply", async () => {
    const { harness, vulcain } = await peerTurnInFlight();
    const before = harness.seen.length;
    notifyItem("item/started", "T1", userMessage("idnma-msg-1"));
    notifyItem("item/started", "T1", { type: "agentMessage", id: "item-2", text: "je m'y mets", phase: "commentary" });
    await waitFor(() => harness.seen.length >= before + 2);
    finishTurn("T1", { items: [finalAnswer("la réponse au pair")] });
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("la réponse au pair")]);
    expect(loggedEvents("codex-peer-turn-mixed")).toEqual([]);
  });

  test("the user's userMessage in another turn leaves the peer turn alone", async () => {
    const { harness, vulcain } = await peerTurnInFlight();
    const before = harness.seen.length;
    notifyItem("item/started", "R7", userMessage("a553d52d-b292-4f54-8cb1-29cc3b0da13b"));
    await waitFor(() => harness.seen.length >= before + 1);
    finishTurn("T1", { items: [finalAnswer("toujours pour le pair")] });
    await waitFor(() => userContents(vulcain).length === 1);
    expect(loggedEvents("codex-peer-turn-mixed")).toEqual([]);
  });
});

describe("reconnection", () => {
  const LOST_LINE = "codex-test : réponse perdue (daemon Codex redémarré)";

  function readReturns(type: "idle" | "active"): void {
    daemon.handle("thread/read", () => ({ result: { thread: { id: THREAD_A, status: { type } } } }));
  }
  async function adopted(reconnectDelayMs = 100): Promise<Harness> {
    daemon.handle("thread/resume", () => ({ result: {} }));
    const harness = makeCourier({ reconnectDelayMs });
    await harness.courier.beforeSpawn();
    harness.courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    return harness;
  }

  test("reconnects, re-reads the state and delivers a message submitted during the outage", async () => {
    readReturns("idle");
    scriptTurnStarts("T1");
    const vulcain = await startPeer("claude-vulcain");
    const harness = await adopted();
    daemon.dropConnections();
    await waitFor(() => loggedEvents("codex-daemon-closed").length === 1);
    submit(harness, vulcain, "pendant la coupure");
    await Bun.sleep(30);
    expect(turnStarts().length).toBe(0);

    await waitFor(() => threadReads().length === 1);
    expect(threadReads()[0]!.params).toEqual({ threadId: THREAD_A, includeTurns: false });
    await waitFor(() => turnStarts().length === 1);
    expect(loggedEvents("codex-daemon-lost")).toEqual([]);
    expect(daemon.openConnections()).toBe(1);

    // La nouvelle connexion reçoit bien les notifications du thread.
    daemon.notify("thread/status/changed", { threadId: THREAD_A, status: { type: "active", activeFlags: [] } });
    await waitFor(() => threadResumes().length === 1);
  });

  test("answers 'lost' to a peer turn when the re-read state is idle", async () => {
    readReturns("idle");
    scriptTurnStarts("T1");
    const vulcain = await startPeer("claude-vulcain");
    const harness = await adopted();
    submit(harness, vulcain, "avant la coupure");
    await waitFor(() => turnStarts().length === 1);
    await waitFor(() => harness.queue.size === 0);

    daemon.dropConnections();
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf(LOST_LINE)]);
    // La table est vidée : la fin tardive du même tour ne renvoie plus rien.
    daemon.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: "T1", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "tard" }] },
    });
    await Bun.sleep(150);
    expect(userContents(vulcain).length).toBe(1);
  });

  test("answers 'lost' at the first turn/completed when the re-read state is active", async () => {
    readReturns("active");
    scriptTurnStarts("T1");
    const vulcain = await startPeer("claude-vulcain");
    const harness = await adopted();
    submit(harness, vulcain, "avant la coupure");
    await waitFor(() => turnStarts().length === 1);
    await waitFor(() => harness.queue.size === 0);

    daemon.dropConnections();
    await waitFor(() => threadResumes().length === 1);
    await Bun.sleep(100);
    expect(userContents(vulcain)).toEqual([]);

    daemon.notify("turn/completed", { threadId: THREAD_A, turn: { id: "R9", status: "completed", items: [] } });
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf(LOST_LINE)]);
  });

  test("the noted turn that ends first keeps its real answer", async () => {
    readReturns("active");
    scriptTurnStarts("T1");
    const vulcain = await startPeer("claude-vulcain");
    const harness = await adopted();
    submit(harness, vulcain, "avant la coupure");
    await waitFor(() => harness.queue.size === 0);
    daemon.dropConnections();
    await waitFor(() => threadResumes().length === 1);
    daemon.notify("turn/completed", {
      threadId: THREAD_A,
      turn: { id: "T1", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "bien reçu" }] },
    });
    await waitFor(() => userContents(vulcain).length === 1);
    await Bun.sleep(100);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("bien reçu")]);
  });

  test("a failed reconnection unregisters and detaches", async () => {
    registration = await registerPeer({ name: "codex-test", cwd: workDir, onMessage: () => {} });
    const { courier } = makeCourier({ registration, reconnectDelayMs: 100 });
    daemon.handle("thread/resume", () => ({ result: {} }));
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    expect(listLiveEntries().some((entry) => entry.name === "codex-test")).toBe(true);

    daemon.stop();
    daemon.dropConnections();
    await waitFor(() => loggedEvents("codex-daemon-lost").length === 1);
    expect(loggedEvents("codex-daemon-closed").length).toBe(1);
    expect(listLiveEntries().some((entry) => entry.name === "codex-test")).toBe(false);
  });

  test("a failed reconnection answers every noted peer turn before unregistering", async () => {
    scriptTurnStarts("T1");
    const vulcain = await startPeer("claude-vulcain");
    const fake = fakeRegistration();
    daemon.handle("thread/resume", () => ({ result: {} }));
    const harness = makeCourier({ registration: fake, reconnectDelayMs: 100 });
    await harness.courier.beforeSpawn();
    harness.courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    submit(harness, vulcain, "avant la perte");
    await waitFor(() => harness.queue.size === 0);

    daemon.stop();
    daemon.dropConnections();
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("codex-test : réponse perdue (daemon Codex perdu)")]);
    await waitFor(() => loggedEvents("codex-daemon-lost").length === 1);
    expect(fake.unregistered).toBe(1);
    expect(loggedEvents("codex-reconnect-error").length).toBe(1);
    await Bun.sleep(100);
    expect(userContents(vulcain).length).toBe(1);
  });

  test("a failed reconnection removes the pointer and refuses commands", async () => {
    const { courier } = makeCourier({ reconnectDelayMs: 100, daemonPid: async () => process.pid });
    daemon.handle("thread/resume", () => ({ result: {} }));
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    const child = Bun.spawn(["sleep", "600"]);
    children.push(child);
    expect(await courier.verifyCaller({ codexThreadId: THREAD_A }, child.pid)).toBe(true);

    daemon.stop();
    daemon.dropConnections();
    await waitFor(() => loggedEvents("codex-daemon-lost").length === 1);
    expect(pointerExists(THREAD_A)).toBe(false);
    expect(await courier.verifyCaller({ codexThreadId: THREAD_A }, child.pid)).toBe(false);
  });

  test("answers 'lost' at once when the re-read state is neither idle nor active", async () => {
    daemon.handle("thread/read", () => ({ result: { thread: { id: THREAD_A, status: { type: "notLoaded" } } } }));
    scriptTurnStarts("T1");
    const vulcain = await startPeer("claude-vulcain");
    const harness = await adopted();
    submit(harness, vulcain, "avant la coupure");
    await waitFor(() => harness.queue.size === 0);

    daemon.dropConnections();
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf(LOST_LINE)]);
  });

  test("stop during the reconnection wait cancels it", async () => {
    readReturns("idle");
    const { courier } = await adopted(300);
    daemon.dropConnections();
    await waitFor(() => loggedEvents("codex-daemon-closed").length === 1);
    courier.stop();
    await Bun.sleep(500);
    expect(threadReads()).toEqual([]);
    expect(daemon.openConnections()).toBe(0);
    expect(loggedEvents("codex-daemon-lost")).toEqual([]);
  });
});

describe("leaving the bus with messages in the queue", () => {
  const NOT_DELIVERED = "codex-test : message non livré (Codex a quitté le bus)";

  async function adopt(harness: Harness): Promise<void> {
    await harness.courier.beforeSpawn();
    harness.courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
  }

  test("an adoption timeout refuses the queued message and tells its sender", async () => {
    const vulcain = await startPeer("claude-vulcain");
    const fake = fakeRegistration();
    const harness = makeCourier({ registration: fake, adoptionTimeoutMs: 200 });
    await harness.courier.beforeSpawn();
    harness.courier.afterSpawn();
    submit(harness, vulcain, "bonjour", "next", "msg-1");
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf(NOT_DELIVERED)]);
    expect(harness.queue.size).toBe(0);
    await waitFor(() => loggedEvents("codex-adoption-timeout").length === 1);
    expect(fake.unregistered).toBe(1);
  });

  test("a failed reconnection refuses what was queued during the outage", async () => {
    const vulcain = await startPeer("claude-vulcain");
    daemon.handle("thread/resume", () => ({ result: {} }));
    const harness = makeCourier({ reconnectDelayMs: 100 });
    await adopt(harness);

    daemon.stop();
    daemon.dropConnections();
    await waitFor(() => loggedEvents("codex-daemon-closed").length === 1);
    submit(harness, vulcain, "pendant la coupure", "next", "msg-2");
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf(NOT_DELIVERED)]);
    expect(harness.queue.size).toBe(0);
    await waitFor(() => loggedEvents("codex-daemon-lost").length === 1);
  });

  test("a daemon lost before adoption refuses what was queued", async () => {
    const vulcain = await startPeer("claude-vulcain");
    const harness = makeCourier();
    await harness.courier.beforeSpawn();
    harness.courier.afterSpawn();
    submit(harness, vulcain, "trop tôt", "next", "msg-3");
    daemon.dropConnections();
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf(NOT_DELIVERED)]);
    expect(harness.queue.size).toBe(0);
  });

  test("answers the noted peer turn and the queued message of two different senders", async () => {
    scriptTurnStarts("T1");
    const vulcain = await startPeer("claude-vulcain");
    const mars = await startPeer("claude-mars");
    daemon.handle("thread/resume", () => ({ result: {} }));
    const harness = makeCourier({ reconnectDelayMs: 100 });
    await adopt(harness);
    submit(harness, vulcain, "dans le tour", "next", "msg-4");
    await waitFor(() => harness.queue.size === 0);

    daemon.stop();
    daemon.dropConnections();
    await waitFor(() => loggedEvents("codex-daemon-closed").length === 1);
    submit(harness, mars, "dans la file", "next", "msg-5");
    await waitFor(() => userContents(vulcain).length === 1 && userContents(mars).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf("codex-test : réponse perdue (daemon Codex perdu)")]);
    expect(userContents(mars)).toEqual([autoReplyEnvelopeOf(NOT_DELIVERED)]);
  });

  test("a message arriving once the courier has left the bus is refused at once", async () => {
    const vulcain = await startPeer("claude-vulcain");
    const harness = makeCourier({ adoptionTimeoutMs: 100 });
    await harness.courier.beforeSpawn();
    harness.courier.afterSpawn();
    await waitFor(() => loggedEvents("codex-adoption-timeout").length === 1);
    expect(userContents(vulcain)).toEqual([]);

    submit(harness, vulcain, "après le départ", "next", "msg-6");
    await waitFor(() => userContents(vulcain).length === 1);
    expect(userContents(vulcain)).toEqual([autoReplyEnvelopeOf(NOT_DELIVERED)]);
    expect(harness.queue.size).toBe(0);
  });
});

describe("daemon connection modes", () => {
  test("the first connection may start the daemon, the reconnection never does", async () => {
    const modes: Array<{ allowStart: boolean }> = [];
    daemon.handle("thread/resume", () => ({ result: {} }));
    daemon.handle("thread/read", () => ({ result: { thread: { id: THREAD_A, status: { type: "idle" } } } }));
    const courier = createCodexCourier({
      name: "codex-test",
      fromMode: "prompting",
      registration: fakeRegistration(),
      queue: new MessageQueue(),
      cwd: workDir,
      reconnectDelayMs: 50,
      connect: (onNotification, mode) => {
        modes.push(mode);
        return connectDaemon({ onNotification, allowStart: mode.allowStart, startDaemon: async () => {} });
      },
    });
    couriers.push(courier);
    await courier.beforeSpawn();
    courier.afterSpawn();
    daemon.notify("thread/started", thread(THREAD_A));
    await waitFor(() => pointerExists(THREAD_A));
    expect(modes).toEqual([{ allowStart: true }]);

    daemon.dropConnections();
    await waitFor(() => loggedEvents("codex-daemon-reconnected").length === 1);
    expect(modes).toEqual([{ allowStart: true }, { allowStart: false }]);
  });
});

/** Vrai si la promesse se règle (résolue) dans le délai. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const outcome = await Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);
  return outcome;
}
