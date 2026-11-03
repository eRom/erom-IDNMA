import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildEnvelope } from "../src/bus/envelope.ts";
import type { InboundMessage, Priority } from "../src/bus/inbox.ts";
import type { sendPeerMessage } from "../src/bus/send.ts";
import { createOpencodeCourier } from "../src/opencode/courier.ts";
import { COURIER_EVENT_TYPES } from "../src/opencode/events.ts";
import { createOpencodeClient, readServiceInfo, type ServiceInfo } from "../src/opencode/service.ts";
import { AUTO_REPLY_MARKER, CourierUnavailableError, isAutoReply, withReplyHint, type Courier } from "../src/understudy/courier.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import { startFakeOpencodeService, type FakeOpencodeService, type FakeReply } from "./helpers/fake-opencode-service.ts";
import { fakeRegistration } from "./helpers/fake-registration.ts";
import * as ev from "./helpers/opencode-events.ts";

const SESSION = "ses_courier_test";
const PROMPT_PATH = `/api/session/${SESSION}/prompt`;
const RETRY_DELAY_MS = 20;

let dir: string;
let savedConfigDir: string | undefined;
let fake: FakeOpencodeService;
let couriers: Courier[];
let extraFakes: FakeOpencodeService[];

beforeEach(() => {
  savedConfigDir = process.env.IDNMA_CONFIG_DIR;
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = join(dir, "config");
  fake = startFakeOpencodeService();
  couriers = [];
  extraFakes = [];
});

afterEach(() => {
  for (const courier of couriers) courier.stop();
  fake.stop();
  for (const extra of extraFakes) extra.stop();
  rmSync(dir, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
  else process.env.IDNMA_CONFIG_DIR = savedConfigDir;
});

async function waitFor(condition: () => boolean, what = "condition", timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await Bun.sleep(5);
  }
}

/** Fenêtre courte pour affirmer qu'une requête ne part PAS (le seul cas où une attente fixe est inévitable). */
const settle = (ms = 60): Promise<void> => Bun.sleep(ms);

function logged(event: string): Array<Record<string, unknown>> {
  const path = join(process.env.IDNMA_CONFIG_DIR!, "logs", "idnma.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === event);
}

interface PromptBody {
  text: string;
  delivery: "queue" | "steer";
  metadata: { idnma: { msgId: string; from?: string } };
}

const prompts = (): PromptBody[] => fake.requests.filter((r) => r.method === "POST" && r.path === PROMPT_PATH).map((r) => r.body as PromptBody);

/**
 * Programme le faux service comme opencode : `GET /api/session/active`, puis `POST …/prompt` qui
 * émet `inbox.enqueued` (avec le `metadata` reçu) avant de répondre. `inbox_<n>` numérote les
 * prompts acceptés.
 */
function scriptOpencode(
  o: { active?: boolean; emitEnqueued?: boolean; responseDelayMs?: number; failAttempt?: (attempt: number) => FakeReply | undefined } = {},
): { inbox(n: number): string } {
  let attempts = 0;
  let accepted = 0;
  fake.handle("GET", "/api/session/active", () => ({ status: 200, body: { data: o.active ? { [SESSION]: {} } : {} } }));
  fake.handle("POST", PROMPT_PATH, async (req) => {
    attempts++;
    const failure = o.failAttempt?.(attempts);
    if (failure !== undefined) return failure;
    accepted++;
    const body = req.body as PromptBody;
    const inboxID = `inbox_${accepted}`;
    if (o.emitEnqueued !== false) fake.emit(ev.enqueued(SESSION, inboxID, { delivery: body.delivery, metadata: body.metadata }));
    if (o.responseDelayMs !== undefined) await Bun.sleep(o.responseDelayMs);
    return { status: 200, body: { data: { id: inboxID } } };
  });
  return { inbox: (n) => `inbox_${n}` };
}

type SentReply = Parameters<typeof sendPeerMessage>[0];

interface Harness {
  courier: Courier;
  queue: MessageQueue;
  registration: ReturnType<typeof fakeRegistration>;
  sent: SentReply[];
  /** Corps des renvois, marque comprise. */
  replies(): string[];
}

function makeCourier(
  o: {
    retryDelayMs?: number;
    service?: () => { url: string; pid: number; password: string } | undefined;
    requestTimeoutMs?: number;
    reconnectDelayMs?: number;
    reconnectWindowMs?: number;
    reconnectPollMs?: number;
  } = {},
): Harness {
  const queue = new MessageQueue();
  const registration = fakeRegistration();
  const sent: SentReply[] = [];
  const courier = createOpencodeCourier({
    name: "opencode-test",
    fromMode: "prompting",
    registration,
    queue,
    sessionID: SESSION,
    service: o.service ?? (() => ({ url: fake.url, pid: process.pid, password: fake.password })),
    send: (async (a: SentReply) => {
      sent.push(a);
      return { msgId: "reply-id", target: {} };
    }) as unknown as typeof sendPeerMessage,
    retryDelayMs: o.retryDelayMs ?? RETRY_DELAY_MS,
    ...(o.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: o.reconnectDelayMs }),
    ...(o.reconnectWindowMs === undefined ? {} : { reconnectWindowMs: o.reconnectWindowMs }),
    ...(o.reconnectPollMs === undefined ? {} : { reconnectPollMs: o.reconnectPollMs }),
    ...(o.requestTimeoutMs === undefined ? {} : { client: (info: ServiceInfo) => createOpencodeClient(info, { requestTimeoutMs: o.requestTimeoutMs }) }),
  });
  couriers.push(courier);
  return { courier, queue, registration, sent, replies: () => sent.map((s) => s.body) };
}

async function startCourier(o: Parameters<typeof makeCourier>[0] = {}): Promise<Harness> {
  const harness = makeCourier(o);
  await harness.courier.beforeSpawn();
  return harness;
}

const ADDRESS = "uds:/tmp/peer-a.sock";

function envelope(body: string, fromName = "peer-a"): string {
  return buildEnvelope({ from: ADDRESS, fromName, fromMode: "prompting", body });
}

function inbound(n: number, o: { priority?: Priority; content?: string } = {}): InboundMessage {
  return {
    msgId: `m-${n}`,
    from: ADDRESS,
    priority: o.priority ?? "next",
    content: o.content ?? envelope(`message ${n}`),
    authenticated: true,
    receivedAt: n,
  };
}

function receive(h: Harness, message: InboundMessage): void {
  h.queue.push(message);
  h.courier.onMessage();
}

/** Ouvre un tour de pair : un premier message au repos, puis `started` et `delivered` de son élément. */
async function openPeerTurn(h: Harness, firstMessage = 1): Promise<void> {
  const before = prompts().length;
  receive(h, inbound(firstMessage));
  await waitFor(() => prompts().length === before + 1, "first prompt");
  fake.emit(ev.started(SESSION));
  fake.emit(ev.delivered(SESSION, `inbox_${before + 1}`));
  await waitFor(() => h.registration.statuses.at(-1) === "busy", "busy status");
}

/** Ouvre un tour de l'utilisateur : son prompt tapé dans la TUI, sans `metadata`. */
async function openUserTurn(h: Harness, metadata?: Record<string, unknown>): Promise<void> {
  fake.emit(ev.enqueued(SESSION, "inbox_romain", { delivery: "steer", ...(metadata === undefined ? {} : { metadata }) }));
  fake.emit(ev.started(SESSION));
  fake.emit(ev.delivered(SESSION, "inbox_romain"));
  await waitFor(() => h.registration.statuses.at(-1) === "busy", "busy status");
}

describe("beforeSpawn", () => {
  test("opens the stream on the courier event types and never sends a PUT", async () => {
    scriptOpencode();
    await startCourier();
    const streamRequest = fake.requests.find((r) => r.method === "GET" && r.path === "/api/event");
    expect(streamRequest?.query.getAll("types")).toEqual([...COURIER_EVENT_TYPES]);
    expect(fake.openStreams()).toBe(1);
    expect(fake.requests.filter((r) => r.method === "PUT")).toEqual([]);
    expect(fake.requests.some((r) => r.path === "/api/info")).toBe(true);
    expect(logged("opencode-info")).toEqual([expect.objectContaining({ version: "2.2.0" })]);
  });

  test("without a service file it raises CourierUnavailableError and sends no request", async () => {
    const harness = makeCourier({ service: () => undefined });
    await expect(harness.courier.beforeSpawn()).rejects.toBeInstanceOf(CourierUnavailableError);
    await expect(harness.courier.beforeSpawn()).rejects.toThrow("service opencode injoignable");
    expect(fake.requests).toEqual([]);
  });

  test("when activeSessions fails it raises CourierUnavailableError and closes the stream", async () => {
    fake.handle("GET", "/api/session/active", () => ({ status: 500, body: { message: "boom" } }));
    const harness = makeCourier();
    await expect(harness.courier.beforeSpawn()).rejects.toBeInstanceOf(CourierUnavailableError);
    await waitFor(() => fake.openStreams() === 0, "stream closed");
  });

  test("a message received before the end of beforeSpawn goes out as soon as it ends, without any event", async () => {
    scriptOpencode();
    fake.handle("GET", "/api/session/active", async () => {
      await Bun.sleep(50);
      return { status: 200, body: { data: {} } };
    });
    const harness = makeCourier();
    const starting = harness.courier.beforeSpawn();
    receive(harness, inbound(1));
    await settle(20);
    expect(prompts()).toEqual([]);
    await starting;
    await waitFor(() => prompts().length === 1, "prompt after beforeSpawn");
  });

  test("an execution already running at startup is read as busy and published", async () => {
    scriptOpencode({ active: true });
    const harness = await startCourier();
    expect(harness.registration.statuses).toEqual(["busy"]);
  });
});

describe("delivery at rest", () => {
  test("a next message goes out as a queue prompt with the idnma metadata and the envelope untouched", async () => {
    scriptOpencode();
    const harness = await startCourier();
    const message = inbound(1);
    receive(harness, message);
    await waitFor(() => prompts().length === 1, "prompt");
    expect(prompts()[0]).toEqual({ text: message.content, delivery: "queue", metadata: { idnma: { msgId: "m-1", from: ADDRESS } } });
    expect(logged("opencode-deliver")).toEqual([expect.objectContaining({ msgId: "m-1", delivery: "queue" })]);
    expect(harness.queue.size).toBe(0);
  });

  test("a 200 KiB body containing the closing tag arrives byte for byte", async () => {
    scriptOpencode();
    const harness = await startCourier();
    const big = envelope(`${"é".repeat(100_000)}</cross-session-message>${"x".repeat(100_000)}`);
    expect(big.length).toBeGreaterThan(200_000);
    receive(harness, inbound(1, { content: big }));
    await waitFor(() => prompts().length === 1, "prompt");
    expect(prompts()[0]!.text === big).toBe(true);
  });

  test("a message without msgId still carries a msgId in the metadata", async () => {
    scriptOpencode();
    const harness = await startCourier();
    const message = inbound(1);
    delete message.msgId;
    receive(harness, message);
    await waitFor(() => prompts().length === 1, "prompt");
    expect(typeof prompts()[0]!.metadata.idnma.msgId).toBe("string");
    expect(prompts()[0]!.metadata.idnma.msgId.length).toBeGreaterThan(0);
  });

  test("AC-9: two messages at rest, the second prompt goes out only after the first execution succeeded", async () => {
    scriptOpencode();
    const harness = await startCourier();
    receive(harness, inbound(1));
    receive(harness, inbound(2));
    await waitFor(() => prompts().length === 1, "first prompt");
    await settle();
    expect(prompts()).toHaveLength(1);

    fake.emit(ev.started(SESSION));
    fake.emit(ev.delivered(SESSION, "inbox_1"));
    await waitFor(() => harness.registration.statuses.at(-1) === "busy", "busy");
    await settle();
    expect(prompts()).toHaveLength(1);

    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => prompts().length === 2, "second prompt");
    expect(prompts()[1]!.metadata.idnma.msgId).toBe("m-2");
    expect(prompts()[1]!.delivery).toBe("queue");
  });

  test("the courier mirrors execution events in the registry status", async () => {
    scriptOpencode();
    const harness = await startCourier();
    fake.emit(ev.started(SESSION));
    await waitFor(() => harness.registration.statuses.length === 1, "busy");
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => harness.registration.statuses.length === 2, "idle");
    fake.emit(ev.started(SESSION));
    fake.emit(ev.failed(SESSION, "Free usage limit reached"));
    await waitFor(() => harness.registration.statuses.length === 4, "busy then idle");
    expect(harness.registration.statuses).toEqual(["busy", "idle", "busy", "idle"]);
  });

  test("events of another session are ignored", async () => {
    scriptOpencode();
    const harness = await startCourier();
    fake.emit(ev.started("ses_someone_else"));
    receive(harness, inbound(1));
    await waitFor(() => prompts().length === 1, "prompt");
    expect(harness.registration.statuses).toEqual([]);
  });
});

describe("ownership of the turn", () => {
  test("an inbox.enqueued emitted before the HTTP response is recognised: the turn belongs to the peer", async () => {
    scriptOpencode({ responseDelayMs: 50 });
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => fake.requests.some((r) => r.path === PROMPT_PATH), "prompt request");
    // started puis delivered arrivent avant la réponse HTTP : seul le msgId de l'enqueued relie l'élément à la doublure.
    fake.emit(ev.started(SESSION));
    fake.emit(ev.delivered(SESSION, "inbox_1"));
    await waitFor(() => logged("opencode-deliver").length === 1, "response processed");
    receive(harness, inbound(2));
    await settle();
    expect(prompts()).toHaveLength(1);
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => prompts().length === 2, "second prompt");
  });

  test("the inboxID of the prompt response also recognises the item when no enqueued carries the metadata", async () => {
    scriptOpencode({ emitEnqueued: false });
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => logged("opencode-deliver").length === 1, "response processed");
    fake.emit(ev.started(SESSION));
    fake.emit(ev.delivered(SESSION, "inbox_1"));
    await waitFor(() => harness.registration.statuses.at(-1) === "busy", "busy");
    receive(harness, inbound(2));
    await settle();
    expect(prompts()).toHaveLength(1);
  });

  test("an execution opened by a compaction is not a peer turn: a next message enters it as steer", async () => {
    scriptOpencode();
    const harness = await startCourier();
    fake.emit(ev.enqueuedItem(SESSION, "inbox_compaction", "compaction", {}));
    fake.emit(ev.started(SESSION));
    fake.emit(ev.delivered(SESSION, "inbox_compaction"));
    await waitFor(() => harness.registration.statuses.at(-1) === "busy", "busy status");
    receive(harness, inbound(1));
    await waitFor(() => prompts().length === 1, "steer prompt");
    expect(prompts()[0]!.delivery).toBe("steer");
  });

  test("an execution started while the courier queue item is not yet delivered keeps a next message waiting, without steer", async () => {
    scriptOpencode();
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => logged("opencode-deliver").length === 1, "first prompt accepted");
    fake.emit(ev.started(SESSION));
    await waitFor(() => harness.registration.statuses.at(-1) === "busy", "busy");
    receive(harness, inbound(2));
    await settle();
    expect(prompts()).toHaveLength(1);
    fake.emit(ev.delivered(SESSION, "inbox_1"));
    await settle();
    expect(prompts()).toHaveLength(1);
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => prompts().length === 2, "second prompt");
    expect(prompts()[1]!.delivery).toBe("queue");
  });

  test("a user turn: next goes out as steer with the reply hint", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openUserTurn(harness);
    const message = inbound(1);
    receive(harness, message);
    await waitFor(() => prompts().length === 1, "steer prompt");
    expect(prompts()[0]!.delivery).toBe("steer");
    expect(prompts()[0]!.text).toBe(withReplyHint(message.content));
    expect(prompts()[0]!.text).not.toBe(message.content);
    // AC-5 : le steer est livré dans le tour de l'utilisateur, qui s'achève ; aucun renvoi automatique ne part.
    await waitFor(() => logged("opencode-deliver").length === 1, "steer accepted");
    fake.emit(ev.delivered(SESSION, "inbox_1"));
    fake.emit(ev.textEnded(SESSION, "réponse à l'utilisateur"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => harness.registration.statuses.at(-1) === "idle", "idle");
    await settle();
    expect(harness.sent).toEqual([]);
    expect(logged("opencode-segment-end")).toEqual([]);
  });

  test("a user turn: later waits for execution.succeeded, then goes out as queue", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openUserTurn(harness);
    const message = inbound(1, { priority: "later" });
    receive(harness, message);
    await settle();
    expect(prompts()).toEqual([]);
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => prompts().length === 1, "queue prompt");
    expect(prompts()[0]!.delivery).toBe("queue");
    expect(prompts()[0]!.text).toBe(message.content);
  });

  test("an item carrying a foreign idnma metadata still opens a user turn", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openUserTurn(harness, { idnma: { msgId: "someone-elses", from: "uds:/tmp/other.sock" } });
    receive(harness, inbound(1));
    await waitFor(() => prompts().length === 1, "steer prompt");
    expect(prompts()[0]!.delivery).toBe("steer");
  });

  test("a turn already running at startup has an unknown owner, treated as the user's", async () => {
    scriptOpencode({ active: true });
    const harness = await startCourier();
    receive(harness, inbound(1));
    receive(harness, inbound(2, { priority: "later" }));
    await waitFor(() => prompts().length === 1, "steer prompt");
    expect(prompts()[0]!.delivery).toBe("steer");
    expect(prompts()[0]!.metadata.idnma.msgId).toBe("m-1");
    await settle();
    expect(prompts()).toHaveLength(1);
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => prompts().length === 2, "later goes out at rest");
    expect(prompts()[1]!.delivery).toBe("queue");
  });

  test("a peer turn: next waits for the end of the turn, now goes out as steer with the reply hint", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    receive(harness, inbound(2));
    await settle();
    expect(prompts()).toHaveLength(1);

    const urgent = inbound(3, { priority: "now" });
    receive(harness, urgent);
    await waitFor(() => prompts().length === 2, "steer prompt");
    expect(prompts()[1]!.delivery).toBe("steer");
    expect(prompts()[1]!.text).toBe(withReplyHint(urgent.content));
    expect(prompts()[1]!.metadata.idnma.msgId).toBe("m-3");

    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => prompts().length === 3, "next goes out at rest");
    expect(prompts()[2]!.metadata.idnma.msgId).toBe("m-2");
    expect(prompts()[2]!.delivery).toBe("queue");
  });

  test("a steer of the courier that itself opens the execution makes it a peer turn: a next from another peer waits", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openUserTurn(harness);
    receive(harness, inbound(1));
    await waitFor(() => prompts().length === 1, "steer prompt");
    expect(prompts()[0]!.delivery).toBe("steer");
    await waitFor(() => logged("opencode-deliver").length === 1, "steer accepted");
    // Le tour de l'utilisateur s'achève avant que le steer soit livré : celui-ci ouvre une nouvelle exécution (capturé).
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => harness.registration.statuses.at(-1) === "idle", "idle");
    fake.emit(ev.started(SESSION));
    await waitFor(() => harness.registration.statuses.at(-1) === "busy", "busy again");
    fake.emit(ev.delivered(SESSION, "inbox_1"));
    // Le delivered n'a aucun effet observable avant le message suivant : on le laisse arriver avant de le poser.
    await settle(40);
    receive(harness, inbound(2));
    await settle();
    expect(prompts()).toHaveLength(1);
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => prompts().length === 2, "second prompt");
    expect(prompts()[1]!.delivery).toBe("queue");
    expect(prompts()[1]!.metadata.idnma.msgId).toBe("m-2");
  });

  test("an auto-reply is delivered as is, never with the reply hint", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openUserTurn(harness);
    const autoReply = inbound(1, { content: envelope(`${AUTO_REPLY_MARKER}\nréponse`) });
    receive(harness, autoReply);
    await waitFor(() => prompts().length === 1, "steer prompt");
    expect(prompts()[0]!.text).toBe(autoReply.content);
  });
});

describe("stream and lifecycle", () => {
  test("a dropped stream means no prompt at all", async () => {
    scriptOpencode();
    const harness = await startCourier();
    fake.dropStreams();
    await waitFor(() => logged("opencode-stream-closed").length === 1, "stream closed");
    receive(harness, inbound(1));
    await settle();
    expect(prompts()).toEqual([]);
  });

  test("stop closes the stream, is idempotent, and no prompt follows a message received afterwards", async () => {
    scriptOpencode();
    const harness = await startCourier();
    harness.courier.stop();
    harness.courier.stop();
    await waitFor(() => fake.openStreams() === 0, "stream closed");
    const requestsAfterStop = fake.requests.length;
    receive(harness, inbound(1));
    await settle();
    expect(prompts()).toEqual([]);
    expect(fake.requests.length).toBe(requestsAfterStop);
  });

  test("stop cancels the retry timer: a failed prompt is not retried afterwards", async () => {
    scriptOpencode({ failAttempt: () => ({ status: 500, body: { message: "boom" } }) });
    const harness = await startCourier({ retryDelayMs: 40 });
    receive(harness, inbound(1));
    await waitFor(() => prompts().length === 1, "first attempt");
    harness.courier.stop();
    await settle(100);
    expect(prompts()).toHaveLength(1);
  });

  test("the other courier methods are inert", async () => {
    scriptOpencode();
    const harness = await startCourier();
    expect(harness.courier.read()).toBeNull();
    expect(await harness.courier.hook("grok", "x", {})).toEqual({});
    expect(await harness.courier.verifyCaller({ codexThreadId: "x" }, 1)).toBe(false);
    harness.courier.afterSpawn();
  });
});

describe("failures", () => {
  test("a 404 SessionNotFoundError leaves the bus: every queued sender is told, the registration is removed, nothing follows", async () => {
    scriptOpencode({ failAttempt: () => ({ status: 404, body: { _tag: "SessionNotFoundError", message: `Session not found: ${SESSION}` } }) });
    const harness = await startCourier();
    harness.queue.push(inbound(1));
    harness.queue.push(inbound(2));
    harness.courier.onMessage();
    await waitFor(() => harness.sent.length === 2, "two rejections");
    expect(harness.replies()).toEqual([
      `${AUTO_REPLY_MARKER}\nopencode-test : message non livré (opencode a quitté le bus)`,
      `${AUTO_REPLY_MARKER}\nopencode-test : message non livré (opencode a quitté le bus)`,
    ]);
    expect(harness.sent.map((s) => s.to)).toEqual([{ address: ADDRESS }, { address: ADDRESS }]);
    await waitFor(() => harness.registration.unregistered === 1, "unregistered");
    await waitFor(() => fake.openStreams() === 0, "stream closed");
    expect(logged("opencode-lost")).toHaveLength(1);
    expect(harness.queue.size).toBe(0);

    receive(harness, inbound(3));
    await waitFor(() => harness.sent.length === 3, "late message rejected");
    await settle();
    expect(prompts()).toHaveLength(1);
  });

  test("a 500 at rest is retried after retryDelayMs without any event; a second 500 tells the sender, and the next message goes out", async () => {
    scriptOpencode({ failAttempt: (attempt) => (attempt <= 2 ? { status: 500, body: { message: "service en panne" } } : undefined) });
    const harness = await startCourier();
    receive(harness, inbound(1));
    receive(harness, inbound(2));
    await waitFor(() => prompts().length === 3, "second attempt then the next message");
    expect(prompts().map((p) => p.metadata.idnma.msgId)).toEqual(["m-1", "m-1", "m-2"]);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]!.body).toBe(`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (service en panne)`);
    expect(harness.sent[0]!.to).toEqual({ address: ADDRESS });
    expect(harness.queue.size).toBe(0);
  });

  test("a second failure without a JSON body tells the sender the HTTP status only", async () => {
    scriptOpencode({ failAttempt: () => ({ status: 500 }) });
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => harness.sent.length === 1, "failure reply");
    expect(harness.sent[0]!.body).toBe(`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (HTTP 500)`);
  });

  test("a second failure by timeout tells the sender the service is unreachable, with no path or session id", async () => {
    scriptOpencode({ failAttempt: () => ({ status: 200 }) });
    fake.handle("POST", PROMPT_PATH, () => new Promise(() => {}));
    const harness = await startCourier({ requestTimeoutMs: 40 });
    receive(harness, inbound(1));
    await waitFor(() => harness.sent.length === 1, "failure reply");
    expect(harness.sent[0]!.body).toBe(`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (service opencode injoignable)`);
    expect(harness.sent[0]!.body).not.toContain(SESSION);
  });

  test("a first failure puts the message back at the head of the queue", async () => {
    scriptOpencode({ failAttempt: (attempt) => (attempt === 1 ? { status: 500 } : undefined) });
    const harness = await startCourier({ retryDelayMs: 200 });
    const first = inbound(1);
    receive(harness, first);
    await waitFor(() => prompts().length === 1, "first attempt");
    await waitFor(() => harness.queue.first(() => true) === first, "message back in the queue");
    expect(harness.sent).toEqual([]);
  });

  test("inbox.cancelled of the waiting item tells its sender and frees the place for the next message", async () => {
    scriptOpencode();
    const harness = await startCourier();
    receive(harness, inbound(1));
    receive(harness, inbound(2));
    await waitFor(() => logged("opencode-deliver").length === 1, "first prompt accepted");
    await settle();
    expect(prompts()).toHaveLength(1);

    fake.emit(ev.cancelled(SESSION, "inbox_1"));
    await waitFor(() => harness.sent.length === 1, "cancellation reply");
    expect(harness.sent[0]!.body).toBe(`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (annulé dans opencode)`);
    await waitFor(() => prompts().length === 2, "second prompt");
    expect(prompts()[1]!.metadata.idnma.msgId).toBe("m-2");
  });

  test("an inbox.cancelled of a user item is not the courier's business", async () => {
    scriptOpencode();
    const harness = await startCourier();
    fake.emit(ev.enqueued(SESSION, "inbox_romain", { delivery: "steer" }));
    fake.emit(ev.cancelled(SESSION, "inbox_romain"));
    receive(harness, inbound(1));
    await waitFor(() => prompts().length === 1, "prompt");
    expect(harness.sent).toEqual([]);
  });

  test("execution.interrupted with an undelivered queue item removes it from the inbox and tells its sender", async () => {
    scriptOpencode();
    fake.handle("DELETE", `/api/session/${SESSION}/inbox/inbox_1`, () => ({ status: 204 }));
    const harness = await startCourier();
    receive(harness, inbound(1));
    receive(harness, inbound(2));
    await waitFor(() => logged("opencode-deliver").length === 1, "first prompt accepted");
    // L'utilisateur lance un tour avant l'élément de la doublure, puis l'interrompt : l'élément reste garé.
    fake.emit(ev.started(SESSION));
    await waitFor(() => harness.registration.statuses.at(-1) === "busy", "busy");
    fake.emit(ev.interrupted(SESSION));
    await waitFor(() => harness.sent.length === 1, "interruption reply");
    expect(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/api/session/${SESSION}/inbox/inbox_1`]);
    expect(harness.sent[0]!.body).toBe(`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (tour interrompu)`);
    expect(harness.registration.statuses.at(-1)).toBe("idle");
    await waitFor(() => prompts().length === 2, "second prompt");
    expect(prompts()[1]!.metadata.idnma.msgId).toBe("m-2");
  });

  test("the inbox.cancelled that follows the courier's own DELETE does not produce a second reply", async () => {
    scriptOpencode();
    fake.handle("DELETE", `/api/session/${SESSION}/inbox/inbox_1`, async () => {
      fake.emit(ev.cancelled(SESSION, "inbox_1"));
      // La réponse HTTP tarde : l'inbox.cancelled arrive pendant que le retrait est en cours.
      await Bun.sleep(40);
      return { status: 204 };
    });
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => logged("opencode-deliver").length === 1, "first prompt accepted");
    fake.emit(ev.started(SESSION));
    await waitFor(() => harness.registration.statuses.at(-1) === "busy", "busy");
    fake.emit(ev.interrupted(SESSION));
    await waitFor(() => harness.sent.length >= 1, "interruption reply");
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (tour interrompu)`]);
  });

  test("execution.interrupted of a peer turn whose item was delivered cancels nothing", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.interrupted(SESSION));
    await waitFor(() => harness.registration.statuses.at(-1) === "idle", "idle");
    await waitFor(() => harness.sent.length === 1, "interruption reply");
    await settle();
    expect(fake.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    // Rien à retirer, mais le tour du pair s'est arrêté : son segment répond tour interrompu.
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : tour interrompu`]);
  });
});

// --- Segments de pair et renvois automatiques (spec §7.3) ------------------------------------------

// Alias de type et non interface : l'événement doit être assignable à `Record<string, unknown>` (`emit`).
type FixtureEvent = {
  type: string;
  data: Record<string, unknown>;
};

function readFixture(name: string): FixtureEvent[] {
  const raw = readFileSync(join(import.meta.dir, "fixtures", name), "utf8").trim();
  if (name.endsWith(".jsonl")) return raw.split("\n").map((line) => JSON.parse(line) as FixtureEvent);
  return [JSON.parse(raw) as FixtureEvent];
}

/** L'événement capturé, rattaché à la session du test (le reste de la charge est celui de la capture). */
const inSession = (event: FixtureEvent): FixtureEvent => ({ type: event.type, data: { ...event.data, sessionID: SESSION } });

const PEER_B_ADDRESS = "uds:/tmp/peer-b.sock";

describe("peer segments and automatic replies", () => {
  test("the captured peer turn gives the sender the last text before the first stop; the later user steer does not change it", async () => {
    const events = readFixture("opencode-peer-turn.jsonl");
    const firstEnqueued = events.find((e) => e.type === "session.inbox.enqueued")!;
    const ownInboxID = firstEnqueued.data.inboxID as string;
    // Le seul élément de la doublure est m-1 ; m-2 et m-3 de la capture sont ceux de l'utilisateur.
    const firstStop = events.findIndex((e) => e.type === "session.step.ended" && e.data.finish === "stop");
    const expected = events
      .slice(0, firstStop)
      .filter((e) => e.type === "session.text.ended")
      .at(-1)!.data.text as string;
    expect(expected.length).toBeGreaterThan(0);

    scriptOpencode();
    fake.handle("POST", PROMPT_PATH, () => ({ status: 200, body: { data: { id: ownInboxID } } }));
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => logged("opencode-deliver").length === 1, "prompt accepted");
    for (const event of events) fake.emit(inSession(event));
    await waitFor(() => harness.sent.length === 1, "automatic reply");
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\n${expected}`]);
    expect(harness.sent[0]!.to).toEqual({ address: ADDRESS });
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "replied" })]);
    // Le journal ne porte jamais le texte du message.
    expect(JSON.stringify(logged("opencode-segment-end"))).not.toContain(expected.slice(0, 20));
  });

  test("a compaction delivered between two steps of a peer turn leaves the segment open: the sender gets the final text (captured)", async () => {
    const events = readFixture("opencode-compaction-mid-turn.jsonl");
    const ownInboxID = events.find((e) => e.type === "session.inbox.enqueued")!.data.inboxID as string;
    const compaction = events.find((e) => e.type === "session.inbox.enqueued" && (e.data.item as { type: string }).type === "compaction");
    expect(compaction).toBeDefined();

    scriptOpencode();
    fake.handle("POST", PROMPT_PATH, () => ({ status: 200, body: { data: { id: ownInboxID } } }));
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => logged("opencode-deliver").length === 1, "prompt accepted");
    for (const event of events) fake.emit(inSession(event));
    await waitFor(() => harness.sent.length === 1, "automatic reply");
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nFINI`]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "replied" })]);
  });

  test("the end of a background shell command delivered between two steps of a peer turn leaves the segment open (captured)", async () => {
    const events = readFixture("opencode-background-shell-mid-turn.jsonl");
    const ownInboxID = events.find((e) => e.type === "session.inbox.enqueued")!.data.inboxID as string;
    const notice = events.find((e) => e.type === "session.inbox.enqueued" && (e.data.item as { type: string }).type === "synthetic");
    expect(notice).toBeDefined();

    scriptOpencode();
    fake.handle("POST", PROMPT_PATH, () => ({ status: 200, body: { data: { id: ownInboxID } } }));
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => logged("opencode-deliver").length === 1, "prompt accepted");
    for (const event of events) fake.emit(inSession(event));
    await waitFor(() => harness.sent.length === 1, "automatic reply");
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nFOND-OK`]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "replied" })]);
  });

  test("an item of an unknown type delivered before any stop mixes the turn, like an input of the user", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.stepEnded(SESSION, "tool-calls"));
    fake.emit(ev.enqueuedItem(SESSION, "inbox_future", "future-type", { text: "inconnu" }));
    fake.emit(ev.delivered(SESSION, "inbox_future"));
    await waitFor(() => harness.sent.length === 1, "mixed reply");
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : tour mêlé à une entrée de l'utilisateur, pas de réponse automatique`]);
  });

  test("a compaction delivered after the stop of a peer turn answers the sender at once, before the compaction runs (captured)", async () => {
    const events = readFixture("opencode-compaction-after-stop.jsonl");
    const ownInboxID = events.find((e) => e.type === "session.inbox.enqueued")!.data.inboxID as string;
    const last = events.at(-1)!;
    expect(last.type).toBe("session.execution.succeeded");
    const firstStop = events.findIndex((e) => e.type === "session.step.ended" && e.data.finish === "stop");
    const expected = events
      .slice(0, firstStop)
      .filter((e) => e.type === "session.text.ended")
      .at(-1)!.data.text as string;

    scriptOpencode();
    fake.handle("POST", PROMPT_PATH, () => ({ status: 200, body: { data: { id: ownInboxID } } }));
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => logged("opencode-deliver").length === 1, "prompt accepted");
    // Tout sauf la fin de l'exécution : la compaction tourne encore, la réponse du pair est déjà complète.
    for (const event of events.slice(0, -1)) fake.emit(inSession(event));
    await waitFor(() => harness.sent.length === 1, "reply at the compaction delivery");
    fake.emit(inSession(last));
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\n${expected}`]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "replied" })]);
  });

  test("a compaction delivered after the stop that then fails or is interrupted still gives the sender the finished answer", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.textEnded(SESSION, "réponse complète"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.enqueuedItem(SESSION, "inbox_compaction", "compaction", {}));
    fake.emit(ev.delivered(SESSION, "inbox_compaction"));
    fake.emit(ev.interrupted(SESSION));
    await waitFor(() => harness.sent.length === 1, "reply");
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nréponse complète`]);
  });

  test("a move item delivered between two steps of a peer turn leaves the segment open", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.textEnded(SESSION, "avant le déplacement"));
    fake.emit(ev.stepEnded(SESSION, "tool-calls"));
    fake.emit(ev.enqueuedItem(SESSION, "inbox_move", "move", { location: { directory: "/tmp/ailleurs" }, projectID: "global" }));
    fake.emit(ev.delivered(SESSION, "inbox_move"));
    fake.emit(ev.textEnded(SESSION, "réponse finale"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => harness.sent.length === 1, "reply");
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nréponse finale`]);
  });

  test("an execution.failed gives the sender the failure with the service message (captured 429)", async () => {
    const failure = readFixture("opencode-execution-failed.json")[0]!;
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(inSession(failure));
    await waitFor(() => harness.sent.length === 1, "failure reply");
    expect(harness.replies()).toEqual([
      `${AUTO_REPLY_MARKER}\nopencode-test : tour en échec (Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.)`,
    ]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "failed" })]);
  });

  test("an interrupted execution gives the sender tour interrompu, even after some text", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.textEnded(SESSION, "début de réponse"));
    fake.emit(ev.interrupted(SESSION));
    await waitFor(() => harness.sent.length === 1, "interruption reply");
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : tour interrompu`]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "interrupted" })]);
  });

  test("an execution that succeeds without any text gives the sender tour terminé sans réponse", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => harness.sent.length === 1, "reply");
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : tour terminé sans réponse`]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "no-text" })]);
  });

  test("the sender gets the last text.ended, not an earlier one", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.textEnded(SESSION, "premier texte"));
    fake.emit(ev.stepEnded(SESSION, "tool-calls"));
    fake.emit(ev.textEnded(SESSION, "texte final"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => harness.sent.length === 1, "reply");
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\ntexte final`]);
  });

  test("an item of the user delivered before any stop mixes the turn: no automatic answer, said once", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.textEnded(SESSION, "réponse commune"));
    fake.emit(ev.enqueued(SESSION, "inbox_romain", { delivery: "steer" }));
    fake.emit(ev.delivered(SESSION, "inbox_romain"));
    await waitFor(() => harness.sent.length === 1, "mixed reply");
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : tour mêlé à une entrée de l'utilisateur, pas de réponse automatique`]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "mixed" })]);
  });

  test("an item of the user delivered after a stop closes the segment with the text from before it", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.textEnded(SESSION, "réponse au pair"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.delivered(SESSION, "inbox_romain"));
    await waitFor(() => harness.sent.length === 1, "reply");
    // Ce que l'utilisateur obtient ensuite n'est plus le segment du pair.
    fake.emit(ev.textEnded(SESSION, "réponse à l'utilisateur"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nréponse au pair`]);
  });

  test("a queue item of the courier delivered after the user item of the same execution opens its own segment", async () => {
    scriptOpencode();
    const harness = await startCourier();
    receive(harness, inbound(1));
    await waitFor(() => logged("opencode-deliver").length === 1, "prompt accepted");
    // L'utilisateur tape avant : son élément est livré le premier, celui de la doublure suit dans la même exécution.
    fake.emit(ev.started(SESSION));
    fake.emit(ev.delivered(SESSION, "inbox_romain"));
    fake.emit(ev.textEnded(SESSION, "réponse à l'utilisateur"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.delivered(SESSION, "inbox_1"));
    fake.emit(ev.textEnded(SESSION, "réponse au pair"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => harness.sent.length === 1, "reply");
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nréponse au pair`]);
  });

  test("a now from another peer delivered as steer in the segment of A leaves A the final text and B nothing", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    const urgent = inbound(2, { priority: "now" });
    urgent.from = PEER_B_ADDRESS;
    receive(harness, urgent);
    await waitFor(() => prompts().length === 2, "steer prompt");
    expect(prompts()[1]!.delivery).toBe("steer");
    fake.emit(ev.delivered(SESSION, "inbox_2"));
    await settle(40);
    expect(harness.sent).toEqual([]);
    fake.emit(ev.textEnded(SESSION, "texte final"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => harness.sent.length === 1, "reply");
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\ntexte final`]);
    expect(harness.sent.map((s) => s.to)).toEqual([{ address: ADDRESS }]);
  });

  test("a now from another peer delivered as steer after the stop of the segment of A closes it with the text from before; B gets nothing", async () => {
    scriptOpencode();
    const harness = await startCourier();
    await openPeerTurn(harness);
    fake.emit(ev.textEnded(SESSION, "réponse à A"));
    const urgent = inbound(2, { priority: "now" });
    urgent.from = PEER_B_ADDRESS;
    receive(harness, urgent);
    await waitFor(() => prompts().length === 2, "steer prompt");
    // Ordre capturé (api-queue-steer, t=2964-2965) : text.ended, step.ended stop, puis le steer est livré et l'exécution continue.
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.delivered(SESSION, "inbox_2"));
    await waitFor(() => harness.sent.length === 1, "reply to A");
    fake.emit(ev.textEnded(SESSION, "réponse à B"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await settle();
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nréponse à A`]);
    expect(harness.sent.map((s) => s.to)).toEqual([{ address: ADDRESS }]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "replied" })]);
  });

  test("an auto-reply received opens a segment but nothing is sent back at its end", async () => {
    scriptOpencode();
    const harness = await startCourier();
    const autoReply = inbound(1, { content: envelope(`${AUTO_REPLY_MARKER}\nréponse du pair`) });
    expect(isAutoReply(autoReply.content)).toBe(true);
    receive(harness, autoReply);
    await waitFor(() => prompts().length === 1, "prompt");
    fake.emit(ev.started(SESSION));
    fake.emit(ev.delivered(SESSION, "inbox_1"));
    fake.emit(ev.textEnded(SESSION, "merci"));
    fake.emit(ev.stepEnded(SESSION, "stop"));
    fake.emit(ev.succeeded(SESSION));
    await waitFor(() => logged("opencode-segment-end").length === 1, "segment end");
    await settle();
    expect(harness.sent).toEqual([]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "muted" })]);
  });
});

// --- Coupure du flux et reconnexion (spec §7.4) ----------------------------------------------------

const RECONNECT_DELAY_MS = 10;

/** Second faux service : autre port, autre mot de passe, au repos. */
function startSecondService(): FakeOpencodeService {
  const second = startFakeOpencodeService({ password: "pw-second-not-secret" });
  extraFakes.push(second);
  second.handle("GET", "/api/session/active", () => ({ status: 200, body: { data: {} } }));
  second.handle("POST", PROMPT_PATH, () => ({ status: 200, body: { data: { id: "second_inbox" } } }));
  return second;
}

const promptsOf = (service: FakeOpencodeService): PromptBody[] =>
  service.requests.filter((r) => r.method === "POST" && r.path === PROMPT_PATH).map((r) => r.body as PromptBody);

describe("stream cut and reconnection", () => {
  test("the service restarts elsewhere: the open segment is lost, then the next message goes to the new service", async () => {
    scriptOpencode();
    const serviceFile = join(dir, "service.json");
    fake.writeServiceFile(serviceFile);
    const harness = await startCourier({ service: () => readServiceInfo(serviceFile), reconnectDelayMs: RECONNECT_DELAY_MS });
    await openPeerTurn(harness);
    fake.emit(ev.textEnded(SESSION, "début de réponse"));
    const promptsBeforeCut = prompts().length;

    const second = startSecondService();
    second.writeServiceFile(serviceFile);
    fake.stop();
    fake.dropStreams();

    await waitFor(() => harness.sent.length === 1, "lost reply");
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : réponse perdue (service opencode redémarré)`]);
    expect(logged("opencode-segment-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "lost" })]);
    await waitFor(() => second.openStreams() === 1, "stream on the new service");
    await waitFor(() => logged("opencode-reconnect").length === 1, "reconnect logged");
    // Le service redémarré est au repos : la doublure le publie.
    expect(harness.registration.statuses.at(-1)).toBe("idle");

    receive(harness, inbound(2));
    await waitFor(() => promptsOf(second).length === 1, "prompt on the new service");
    expect(promptsOf(second)[0]!.metadata.idnma.msgId).toBe("m-2");
    expect(promptsOf(second)[0]!.delivery).toBe("queue");
    expect(prompts()).toHaveLength(promptsBeforeCut);
    expect(harness.sent).toHaveLength(1);
  });

  test("an item waiting for its delivery when the stream drops is refused, removed from the inbox, and does not block the next message", async () => {
    scriptOpencode();
    fake.handle("DELETE", `/api/session/${SESSION}/inbox/inbox_1`, () => ({ status: 204 }));
    const harness = await startCourier({ reconnectDelayMs: RECONNECT_DELAY_MS });
    receive(harness, inbound(1));
    await waitFor(() => logged("opencode-deliver").length === 1, "first prompt accepted");
    fake.dropStreams();
    await waitFor(() => harness.sent.length === 1, "refusal");
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (service opencode redémarré)`]);
    await waitFor(() => logged("opencode-reconnect").length === 1, "reconnected");
    await waitFor(() => fake.requests.some((r) => r.method === "DELETE"), "inbox item removed");
    expect(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/api/session/${SESSION}/inbox/inbox_1`]);

    receive(harness, inbound(2));
    await waitFor(() => prompts().length === 2, "second prompt");
    expect(prompts()[1]!.metadata.idnma.msgId).toBe("m-2");
  });

  test("a prompt still in flight when the stream drops is refused once, its late answer changes nothing, and the next message goes out", async () => {
    scriptOpencode({ responseDelayMs: 120 });
    const harness = await startCourier({ reconnectDelayMs: RECONNECT_DELAY_MS });
    receive(harness, inbound(1));
    await waitFor(() => fake.requests.some((r) => r.path === PROMPT_PATH), "prompt request");
    fake.dropStreams();
    await waitFor(() => harness.sent.length === 1, "refusal");
    await waitFor(() => logged("opencode-reconnect").length === 1, "reconnected");
    receive(harness, inbound(2));
    await waitFor(() => prompts().length === 2, "second prompt while the first is still pending");
    await settle(200);
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (service opencode redémarré)`]);
    expect(logged("opencode-deliver").map((l) => l.msgId)).toEqual(["m-2"]);
  });

  test("nothing is delivered while the reconnection is still opening: no prompt goes to the previous service", async () => {
    scriptOpencode();
    const serviceFile = join(dir, "service.json");
    fake.writeServiceFile(serviceFile);
    const second = startSecondService();
    second.handle("GET", "/api/session/active", async () => {
      await Bun.sleep(150);
      return { status: 200, body: { data: {} } };
    });
    const harness = await startCourier({ service: () => readServiceInfo(serviceFile), reconnectDelayMs: RECONNECT_DELAY_MS });
    second.writeServiceFile(serviceFile);
    fake.dropStreams();
    await waitFor(() => second.openStreams() === 1, "stream on the new service");
    // Le flux est ouvert, la lecture de `activeSessions` n'est pas revenue : un `started` et un message `now` en file.
    second.emit(ev.started(SESSION));
    await waitFor(() => harness.registration.statuses.at(-1) === "busy", "busy");
    receive(harness, inbound(1, { priority: "now" }));
    await settle(60);
    expect(prompts()).toEqual([]);
    expect(promptsOf(second)).toEqual([]);
    // La reconnexion terminée, le message part vers le nouveau service.
    await waitFor(() => promptsOf(second).length === 1, "prompt on the new service");
    expect(promptsOf(second)[0]!.delivery).toBe("steer");
    expect(prompts()).toEqual([]);
  });

  test("a prompt accepted after the cut, once the reconnection is done, gets its inbox item removed", async () => {
    scriptOpencode({ emitEnqueued: false, responseDelayMs: 150 });
    fake.handle("DELETE", `/api/session/${SESSION}/inbox/inbox_1`, () => ({ status: 204 }));
    const harness = await startCourier({ reconnectDelayMs: RECONNECT_DELAY_MS });
    receive(harness, inbound(1));
    await waitFor(() => fake.requests.some((r) => r.path === PROMPT_PATH), "prompt request");
    fake.dropStreams();
    await waitFor(() => logged("opencode-reconnect").length === 1, "reconnected");
    // Le service rend l'`inboxID` après la reconnexion : l'élément dormirait dans la boîte d'opencode.
    await waitFor(() => fake.requests.some((r) => r.method === "DELETE"), "late inbox item removed");
    expect(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/api/session/${SESSION}/inbox/inbox_1`]);
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (service opencode redémarré)`]);
  });

  test("a prompt accepted after the cut, before the reconnection is done, gets its inbox item removed once reconnected", async () => {
    scriptOpencode({ emitEnqueued: false, responseDelayMs: 40 });
    fake.handle("DELETE", `/api/session/${SESSION}/inbox/inbox_1`, () => ({ status: 204 }));
    const harness = await startCourier({ reconnectDelayMs: 200 });
    receive(harness, inbound(1));
    await waitFor(() => fake.requests.some((r) => r.path === PROMPT_PATH), "prompt request");
    fake.dropStreams();
    await settle(120);
    // La réponse est revenue, la reconnexion n'a pas eu lieu : rien n'est encore retiré.
    expect(fake.requests.some((r) => r.method === "DELETE")).toBe(false);
    await waitFor(() => logged("opencode-reconnect").length === 1, "reconnected");
    await waitFor(() => fake.requests.some((r) => r.method === "DELETE"), "late inbox item removed");
    expect(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/api/session/${SESSION}/inbox/inbox_1`]);
  });

  test("the service file keeps naming a stopped service for a while: the courier polls until the new one answers", async () => {
    scriptOpencode();
    const second = startSecondService();
    const stale = { url: fake.url, pid: process.pid, password: fake.password };
    const fresh = { url: second.url, pid: process.pid, password: second.password };
    let readsAfterCut = 0;
    let cut = false;
    const harness = await startCourier({
      service: () => {
        if (!cut) return stale;
        readsAfterCut++;
        return readsAfterCut <= 3 ? stale : fresh;
      },
      reconnectDelayMs: RECONNECT_DELAY_MS,
      reconnectPollMs: 10,
      reconnectWindowMs: 2000,
    });
    cut = true;
    fake.stop();
    fake.dropStreams();
    await waitFor(() => second.openStreams() === 1, "stream on the new service");
    expect(readsAfterCut).toBeGreaterThan(3);
    // Le flux s'ouvre avant la fin de la lecture d'`activeSessions` : la reconnexion est journalisée juste après.
    await waitFor(() => logged("opencode-reconnect").length === 1, "reconnect logged");
    receive(harness, inbound(1));
    await waitFor(() => promptsOf(second).length === 1, "prompt on the new service");
  });

  test("a service file whose pid is dead is not trusted", async () => {
    scriptOpencode();
    const second = startSecondService();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    let pid = dead.pid;
    let cut = false;
    await startCourier({
      service: () => (cut ? { url: second.url, pid, password: second.password } : { url: fake.url, pid: process.pid, password: fake.password }),
      reconnectDelayMs: RECONNECT_DELAY_MS,
      reconnectPollMs: 10,
      reconnectWindowMs: 2000,
    });
    cut = true;
    fake.stop();
    fake.dropStreams();
    await settle(120);
    expect(second.requests).toEqual([]);
    pid = process.pid;
    await waitFor(() => second.openStreams() === 1, "stream once the pid is alive");
  });

  test("when the service never comes back the courier leaves the bus: queued senders are told and the registration is removed", async () => {
    scriptOpencode();
    let gone = false;
    const harness = await startCourier({
      service: () => (gone ? undefined : { url: fake.url, pid: process.pid, password: fake.password }),
      reconnectDelayMs: RECONNECT_DELAY_MS,
      reconnectPollMs: 10,
      reconnectWindowMs: 80,
    });
    gone = true;
    fake.dropStreams();
    await waitFor(() => logged("opencode-stream-closed").length === 1, "stream closed");
    receive(harness, inbound(1));
    await waitFor(() => harness.sent.length === 1, "refusal");
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (opencode a quitté le bus)`]);
    await waitFor(() => harness.registration.unregistered === 1, "unregistered");
    expect(logged("opencode-lost")).toEqual([expect.objectContaining({ reason: "reconnect-failed" })]);
    expect(logged("opencode-reconnect")).toEqual([]);
    expect(prompts()).toEqual([]);

    receive(harness, inbound(2));
    await waitFor(() => harness.sent.length === 2, "late message refused");
  });

  test("a service that answers but never lets the stream open also ends in leaving the bus", async () => {
    scriptOpencode();
    const harness = await startCourier({ reconnectDelayMs: RECONNECT_DELAY_MS, reconnectPollMs: 10, reconnectWindowMs: 80 });
    harness.queue.push(inbound(1));
    fake.stop();
    fake.dropStreams();
    await waitFor(() => harness.sent.length === 1, "refusal");
    expect(harness.replies()).toEqual([`${AUTO_REPLY_MARKER}\nopencode-test : message non livré (opencode a quitté le bus)`]);
    await waitFor(() => harness.registration.unregistered === 1, "unregistered");
  });

  test("stop during the wait cancels the reconnection", async () => {
    scriptOpencode();
    const harness = await startCourier({ reconnectDelayMs: 80 });
    fake.dropStreams();
    await waitFor(() => logged("opencode-stream-closed").length === 1, "stream closed");
    harness.courier.stop();
    await settle(200);
    expect(fake.openStreams()).toBe(0);
    expect(logged("opencode-reconnect")).toEqual([]);
  });
});
