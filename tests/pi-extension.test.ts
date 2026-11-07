import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createBridgeCourier } from "../src/bridge/courier.ts";
import { buildEnvelope } from "../src/bus/envelope.ts";
import type { InboundMessage } from "../src/bus/inbox.ts";
import type { sendPeerMessage } from "../src/bus/send.ts";
import { createPiBridge, PEER_MESSAGE_TYPE, type PiApi, type PiContext, type PiPeerMessage } from "../src/pi/extension.ts";
import { AUTO_REPLY_MARKER, type Courier } from "../src/understudy/courier.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import { fakeRegistration } from "./helpers/fake-registration.ts";

// Bout en bout : le vrai livreur (createBridgeCourier, harnais pi) et la vraie extension (createPiBridge)
// parlent par un vrai socket Unix. Seuls Pi (faux `pi` et faux `ctx`) et l'envoi des renvois sont factices.
// Les séquences d'événements rejouent celles de la sonde du 07/11 sur Pi 1.5.0 (spec pi §1, F5 à F9).

// Jeton assemblé : jamais une chaîne de 32 hexadécimaux en clair dans un test.
const TOKEN = ["pi", "e2e", "bridge", "token"].join("-");
const NAME = "pi-e2e";

let dir: string;
let savedConfigDir: string | undefined;
let courier: Courier | undefined;
const shutdowns: Array<() => void> = [];

beforeEach(() => {
  savedConfigDir = process.env.IDNMA_CONFIG_DIR;
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = join(dir, "config");
});

afterEach(() => {
  for (const shutdown of shutdowns.splice(0)) shutdown();
  courier?.stop();
  courier = undefined;
  rmSync(dir, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
  else process.env.IDNMA_CONFIG_DIR = savedConfigDir;
});

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await Bun.sleep(5);
  }
}

/** Événements du journal d'idnma, dans l'ordre. */
function logEvents(): Array<Record<string, unknown>> {
  const path = join(process.env.IDNMA_CONFIG_DIR!, "logs", "idnma.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const bridgeUps = (): number => logEvents().filter((entry) => entry.event === "pi-bridge-up").length;

interface SentCall {
  message: PiPeerMessage;
  options: { deliverAs: "steer" | "followUp"; triggerTurn: boolean };
}

/** Faux Pi : gestionnaires enregistrés, `ctx` réglable, appels de `sendMessage` relevés. */
interface FakePi {
  api: PiApi;
  ctx: PiContext & { idle: boolean; sessionId: string };
  sent: SentCall[];
  handlers: Map<string, Array<(event: unknown, ctx: PiContext) => unknown>>;
  /** Appelé dans `sendMessage`, de façon synchrone (Pi émet `before_agent_start` pendant l'appel, F5). */
  onSend?: (call: SentCall) => void;
  emit(event: string, payload?: unknown): void;
  /** Le message custom tel que Pi le passe à `message_start` quand il entre dans le contexte. */
  claim(index: number): void;
  assistant(stopReason: string, text?: string, errorMessage?: string): void;
  user(role?: string): void;
  settle(aborted?: boolean): void;
}

function createFakePi(sessionId = "session-1"): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: PiContext) => unknown>>();
  const fake: FakePi = {
    handlers,
    sent: [],
    ctx: {
      idle: true,
      sessionId,
      isIdle: () => fake.ctx.idle,
      sessionManager: { getSessionId: () => fake.ctx.sessionId },
    },
    api: {
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendMessage(message, options) {
        const call = { message, options };
        fake.sent.push(call);
        fake.onSend?.(call);
      },
    },
    emit(event, payload = {}) {
      for (const handler of handlers.get(event) ?? []) handler(payload, fake.ctx);
    },
    claim(index) {
      const call = fake.sent[index]!;
      fake.emit("message_start", { message: { role: "custom", ...call.message } });
      fake.emit("message_end", { message: { role: "custom", ...call.message } });
    },
    assistant(stopReason, text = "", errorMessage) {
      const content: unknown[] = text === "" ? [] : [{ type: "thinking", thinking: "…" }, { type: "text", text }];
      if (stopReason === "toolUse") content.push({ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 20" } });
      const message = { role: "assistant", stopReason, content, ...(errorMessage === undefined ? {} : { errorMessage }) };
      fake.emit("message_start", { message: { ...message, stopReason: "pending" } });
      fake.emit("message_end", { message });
    },
    user(role = "user") {
      fake.emit("message_start", { message: { role, content: "typed by the user" } });
      fake.emit("message_end", { message: { role, content: "typed by the user" } });
    },
    settle(aborted = false) {
      fake.ctx.idle = true;
      fake.emit("agent_end", { messages: [] });
      fake.emit("agent_settled", { aborted });
    },
  };
  return fake;
}

/** Pi se met au travail : un run démarre (au repos, `triggerTurn` en ouvre un). */
function startRun(fake: FakePi): void {
  fake.ctx.idle = false;
  fake.emit("agent_start", {});
}

type SentReply = Parameters<typeof sendPeerMessage>[0];

interface Rig {
  socketPath: string;
  queue: MessageQueue;
  registration: ReturnType<typeof fakeRegistration>;
  sent: SentReply[];
  push(body: string, n: number, priority?: InboundMessage["priority"]): void;
  /** Texte des renvois, marque de renvoi automatique retirée. */
  replies(): string[];
  /** Charge l'extension dans `fake` et ouvre sa session, comme Pi au `session_start`. */
  load(fake: FakePi, config?: { replaceGraceMs?: number }): Promise<void>;
}

async function startRig(): Promise<Rig> {
  const socketDir = join(dir, "s");
  mkdirSync(socketDir, { mode: 0o700 });
  chmodSync(socketDir, 0o700);
  const socketPath = join(socketDir, "p.sock");
  const queue = new MessageQueue();
  const registration = fakeRegistration();
  const sent: SentReply[] = [];
  courier = createBridgeCourier({
    harness: "pi",
    name: NAME,
    fromMode: "bypass",
    registration,
    queue,
    socketPath,
    token: TOKEN,
    graceMs: 2_000,
    send: (async (a: SentReply) => {
      sent.push(a);
      return { msgId: "reply-id", target: {} };
    }) as unknown as typeof sendPeerMessage,
  });
  await courier.beforeSpawn();
  courier.afterSpawn();
  return {
    socketPath,
    queue,
    registration,
    sent,
    push(body, n, priority = "next") {
      const from = `uds:/tmp/peer-${n}.sock`;
      const message: InboundMessage = {
        msgId: `m${n}`,
        from,
        priority,
        content: buildEnvelope({ from, fromName: `claude-p${n}`, fromMode: "bypass", body }),
        authenticated: true,
        receivedAt: n,
      };
      queue.push(message);
      courier!.onMessage();
    },
    replies: () => sent.map((s) => s.body.slice(AUTO_REPLY_MARKER.length + 1)),
    async load(fake, config = {}) {
      const before = bridgeUps();
      createPiBridge(fake.api, { env: { IDNMA_PI_BRIDGE: socketPath, IDNMA_PI_BRIDGE_TOKEN: TOKEN }, pid: process.pid, version: "1.5.0", ...config });
      fake.emit("session_start", { reason: "startup" });
      shutdowns.push(() => fake.emit("session_shutdown", { reason: "quit" }));
      await waitFor(() => bridgeUps() === before + 1, "bridge admitted");
    },
  };
}

describe("pi extension, inert outside idnma", () => {
  test("without the bridge variables it registers nothing in pi", () => {
    const fake = createFakePi();
    createPiBridge(fake.api, { env: {} });
    expect(fake.handlers.size).toBe(0);
  });
});

describe("pi bridge end to end (real courier, real extension, real socket)", () => {
  test("a peer message at rest opens a turn, and the final text goes back to the sender (AC-2)", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake);
    expect(logEvents().find((entry) => entry.event === "pi-bridge-up")?.versions).toEqual({ tui: "1.5.0" });

    r.push("capitale du Portugal ?", 1);
    await waitFor(() => fake.sent.length === 1, "message delivered to pi");
    const call = fake.sent[0]!;
    expect(call.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(call.message.customType).toBe(PEER_MESSAGE_TYPE);
    expect(call.message.display).toBe(true);
    expect(call.message.content.startsWith("Team message from claude-p1:\n<cross-session-message ")).toBe(true);
    expect(call.message.content).toContain("capitale du Portugal ?");
    // Au repos, aucun rappel de réponse : la réponse finale revient seule.
    expect(call.message.content).not.toContain("idnma peer send");

    startRun(fake);
    fake.claim(0);
    fake.assistant("stop", "Lisbonne");
    fake.settle();
    await waitFor(() => r.sent.length === 1, "reply sent");
    expect(r.replies()).toEqual(["Lisbonne"]);
    expect(r.sent[0]?.to).toEqual({ address: "uds:/tmp/peer-1.sock" });
    await waitFor(() => r.registration.statuses.at(-1) === "idle", "back to idle on the bus");
    expect(r.registration.statuses).toContain("busy");
    expect(logEvents().find((entry) => entry.event === "pi-turn-end")).toMatchObject({ msgId: "m1", outcome: "replied" });
  });

  test("during a user turn, a next message is steered with the reply hint and gets no automatic reply (AC-4)", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake);
    // Tour de l'utilisateur en plein outil (F6 : le steer entre après l'exécution des outils).
    startRun(fake);
    fake.user();
    fake.assistant("toolUse");
    await waitFor(() => logEvents().some((entry) => entry.event === "pi-foreground"), "state seen by the courier");

    r.push("au passage, quelle année ?", 2, "next");
    await waitFor(() => fake.sent.length === 1, "steer delivered");
    const call = fake.sent[0]!;
    expect(call.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(call.message.content).toContain('réponds à claude-p2 par `idnma peer send claude-p2 "…"`');

    fake.claim(0);
    fake.assistant("stop", "OK, 2026");
    fake.settle();
    await waitFor(() => logEvents().some((entry) => entry.event === "pi-claimed"), "claim seen by the courier");
    await Bun.sleep(100);
    expect(r.sent).toHaveLength(0);
    expect(logEvents().find((entry) => entry.event === "pi-deliver")).toMatchObject({ msgId: "m2", delivery: "steer" });
  });

  test("a follow-up queued behind a finished user answer opens its own peer turn and gets its own reply (F6)", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake);
    startRun(fake);
    fake.user();
    fake.assistant("toolUse");
    await waitFor(() => logEvents().some((entry) => entry.event === "pi-foreground"), "state seen by the courier");

    r.push("réponds FOLLOW-PONG", 3, "later");
    await waitFor(() => fake.sent.length === 1, "follow-up queued in pi");
    expect(fake.sent[0]!.options.deliverAs).toBe("followUp");
    // L'utilisateur reçoit sa réponse, puis Pi livre le followUp dans le même run, sans agent_end entre les deux.
    fake.assistant("stop", "OK pour l'utilisateur");
    fake.claim(0);
    fake.assistant("stop", "FOLLOW-PONG");
    fake.settle();
    await waitFor(() => r.sent.length === 1, "reply sent");
    expect(r.replies()).toEqual(["FOLLOW-PONG"]);
  });

  test("Escape during a peer turn: the sender learns it was interrupted, the message queued behind is discarded (AC-5)", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake);
    r.push("lance sleep 20", 4);
    await waitFor(() => fake.sent.length === 1, "first message delivered");
    startRun(fake);
    fake.claim(0);
    fake.assistant("toolUse");

    r.push("et ensuite QUEUED-PONG", 5, "next");
    await waitFor(() => fake.sent.length === 2, "second message delivered");
    // Pendant un tour de pair, `next` attend son tour : pas de steer.
    expect(fake.sent[1]!.options.deliverAs).toBe("followUp");

    // Échap : l'outil est coupé, le dernier message assistant porte une erreur (F7), le followUp est jeté (F8).
    fake.assistant("error", "", "This operation was aborted");
    fake.settle(true);
    await waitFor(() => r.sent.length === 2, "both senders answered");
    expect(r.replies().sort()).toEqual([`${NAME} : message écarté (l'utilisateur a interrompu pi)`, `${NAME} : tour interrompu par l'utilisateur`].sort());
    const toFour = r.sent.find((s) => (s.to as { address: string }).address === "uds:/tmp/peer-4.sock");
    expect(toFour?.body).toContain("tour interrompu par l'utilisateur");
  });

  test("a user input during a peer turn in its tools mixes the turn: no automatic reply (AC-6)", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake);
    r.push("lance un long outil", 6);
    await waitFor(() => fake.sent.length === 1, "message delivered");
    startRun(fake);
    fake.claim(0);
    fake.assistant("toolUse");
    fake.user();
    fake.assistant("stop", "BANANA");
    fake.settle();
    await waitFor(() => r.sent.length === 1, "reply sent");
    expect(r.replies()).toEqual([`${NAME} : tour mêlé à une entrée de l'utilisateur, pas de réponse automatique`]);
    expect(logEvents().find((entry) => entry.event === "pi-turn-end")).toMatchObject({ outcome: "mixed", sources: ["user"] });
  });

  test("/new mid peer turn: the reply is reported lost, and the queued message reaches the new session (AC-7)", async () => {
    const r = await startRig();
    const first = createFakePi("session-1");
    await r.load(first);
    r.push("première question", 7);
    await waitFor(() => first.sent.length === 1, "first message delivered");
    startRun(first);
    first.claim(0);
    first.assistant("toolUse");
    r.push("deuxième question", 8, "later");
    await waitFor(() => first.sent.length === 2, "second message queued");

    // `/new`, dans l'ordre réel de Pi 1.5.0 (`teardownCurrent`) : `session_before_switch`, puis le tour est
    // avorté (repos interrompu), puis `session_shutdown`, puis un runtime neuf sur la nouvelle session (F2).
    first.emit("session_before_switch", { reason: "new" });
    first.assistant("error", "", "This operation was aborted");
    first.settle(true);
    first.emit("session_shutdown", { reason: "new" });
    await waitFor(() => r.sent.length === 1, "first sender answered");
    expect(r.replies()).toEqual([`${NAME} : réponse perdue (session fermée dans pi)`]);
    // Aucun « écarté » ni « interrompu » : le message en file attend la nouvelle session.
    expect(logEvents().some((entry) => entry.event === "pi-dropped" && entry.why === "discarded")).toBe(false);

    const second = createFakePi("session-2");
    await r.load(second);
    await waitFor(() => second.sent.length === 1, "queued message redelivered to the new session");
    expect(second.sent[0]!.message.content).toContain("deuxième question");
    startRun(second);
    second.claim(0);
    second.assistant("stop", "Réponse 2");
    second.settle();
    await waitFor(() => r.sent.length === 2, "second sender answered");
    expect(r.replies()[1]).toBe("Réponse 2");
    expect(logEvents().filter((entry) => entry.event === "pi-bridge-up").at(-1)).toMatchObject({ reconnect: true });
  });

  test("a switch cancelled by another extension: the interrupted rest is an Escape after the grace delay", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake, { replaceGraceMs: 50 });
    r.push("lance sleep 20", 11);
    await waitFor(() => fake.sent.length === 1, "first message delivered");
    startRun(fake);
    fake.claim(0);
    fake.assistant("toolUse");
    r.push("et ensuite", 12, "next");
    await waitFor(() => fake.sent.length === 2, "second message delivered");

    fake.emit("session_before_switch", { reason: "new" });
    fake.assistant("error", "", "This operation was aborted");
    fake.settle(true);
    // Pas de `session_shutdown` : le remplacement n'a pas eu lieu.
    await waitFor(() => r.sent.length === 2, "both senders answered after the grace delay");
    expect(r.replies().sort()).toEqual([`${NAME} : message écarté (l'utilisateur a interrompu pi)`, `${NAME} : tour interrompu par l'utilisateur`].sort());
  });

  test("follow-ups delivered together (followUpMode all) share one answer instead of a reply without text", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake);
    startRun(fake);
    fake.user();
    fake.assistant("toolUse");
    await waitFor(() => logEvents().some((entry) => entry.event === "pi-foreground"), "state seen by the courier");
    r.push("question deux", 13, "later");
    r.push("question trois", 14, "later");
    await waitFor(() => fake.sent.length === 2, "both follow-ups queued");
    fake.assistant("stop", "réponse à l'utilisateur");
    // Pi vide toute sa file d'un coup : deux réclamations de suite, une seule réponse.
    fake.claim(0);
    fake.claim(1);
    fake.assistant("stop", "réponse à deux et trois");
    fake.settle();
    await waitFor(() => r.sent.length === 2, "both senders answered");
    expect(r.replies()).toEqual(["réponse à deux et trois", "réponse à deux et trois"]);
  });

  test("a retryable error is not the end of a peer turn: a user input during the retry mixes it (m3)", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake);
    r.push("question fragile", 15);
    await waitFor(() => fake.sent.length === 1, "message delivered");
    startRun(fake);
    fake.claim(0);
    fake.assistant("error", "", "overloaded");
    // L'utilisateur tape pendant l'attente du nouvel essai ; Pi réessaie et répond.
    fake.user();
    fake.assistant("stop", "réponse après nouvel essai");
    fake.settle();
    await waitFor(() => r.sent.length === 1, "reply sent");
    expect(r.replies()).toEqual([`${NAME} : tour mêlé à une entrée de l'utilisateur, pas de réponse automatique`]);
  });

  test("a message pi refuses goes back to its sender with pi's reason", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake);
    fake.onSend = () => {
      throw new Error("pi is shutting down");
    };
    r.push("tu es là ?", 9);
    await waitFor(() => r.sent.length === 1, "refusal sent");
    expect(r.replies()).toEqual([`${NAME} : message non livré (pi l'a refusé : pi is shutting down)`]);
  });

  test("a turn cut by the token limit keeps its text and says it was truncated", async () => {
    const r = await startRig();
    const fake = createFakePi();
    await r.load(fake);
    r.push("écris beaucoup", 10);
    await waitFor(() => fake.sent.length === 1, "message delivered");
    startRun(fake);
    fake.claim(0);
    fake.assistant("length", "début de réponse");
    fake.settle();
    await waitFor(() => r.sent.length === 1, "reply sent");
    expect(r.replies()).toEqual([`début de réponse\n(${NAME} : réponse tronquée, limite de tokens atteinte)`]);
  });
});
