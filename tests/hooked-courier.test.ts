import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { InboundMessage, Priority } from "../src/bus/inbox.ts";
import type { Registration } from "../src/bus/register.ts";
import type { sendPeerMessage } from "../src/bus/send.ts";
import { agyAdapter } from "../src/hooked/agy.ts";
import { createHookedCourier, type HookedCourierOptions } from "../src/hooked/courier.ts";
import { grokAdapter } from "../src/hooked/grok.ts";
import { DOORBELL_BYTES, DOORBELL_LINE } from "../src/hooked/signals.ts";
import { addressOf, buildEnvelope } from "../src/bus/envelope.ts";
import { CourierUnavailableError, type Courier, withReplyHint } from "../src/understudy/courier.ts";
import type { Terminal } from "../src/understudy/pty.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import { fakeRegistration } from "./helpers/fake-registration.ts";

const ENV_KEYS = ["IDNMA_CONFIG_DIR"] as const;
const saved: Record<string, string | undefined> = {};

let dir: string;
let clock: number;
let couriers: Courier[];

beforeEach(() => {
  for (const name of ENV_KEYS) saved[name] = process.env[name];
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = join(dir, "config");
  clock = 1_000;
  couriers = [];
});

afterEach(() => {
  for (const courier of couriers) courier.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const name of ENV_KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function logLines(): Array<Record<string, unknown>> {
  const path = join(process.env.IDNMA_CONFIG_DIR!, "logs", "idnma.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const loggedEvents = (event: string) => logLines().filter((line) => line.event === event);

/** Payload réel capturé (tests/fixtures/hooks), avec de petits champs remplacés quand un test en a besoin. */
function fixture(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = readFileSync(join(import.meta.dir, "fixtures", "hooks", `${name}.json`), "utf8");
  return { ...(JSON.parse(raw) as Record<string, unknown>), ...overrides };
}

/** Fait avancer l'horloge injectée : un message « d'avant le tour » a un `receivedAt` strictement plus ancien. */
function tick(): number {
  clock += 10;
  return clock;
}

let messageCounter = 0;

function message(priority: Priority, content: string): InboundMessage {
  messageCounter++;
  return { msgId: `m${messageCounter}`, from: "uds:/tmp/peer.sock", priority, content, authenticated: true, receivedAt: clock };
}

interface Harness {
  courier: Courier;
  queue: MessageQueue;
  registration: ReturnType<typeof fakeRegistration>;
}

function makeCourier(adapter: HookedCourierOptions["adapter"], overrides: Partial<HookedCourierOptions> = {}): Harness {
  const registration = fakeRegistration();
  const queue = new MessageQueue();
  const courier = createHookedCourier({
    adapter,
    name: "grok-test",
    fromMode: "bypass",
    registration: registration as Registration,
    queue,
    now: () => clock,
    ...overrides,
  });
  couriers.push(courier);
  return { courier, queue, registration };
}

const grokPrompt = (overrides: Record<string, unknown> = {}) =>
  fixture("grok-user-prompt-submit-doorbell", { prompt: "fais X", ...overrides });

function additionalContext(reply: Record<string, unknown>): unknown {
  return (reply.hookSpecificOutput as Record<string, unknown> | undefined)?.additionalContext;
}

describe("hooked courier state", () => {
  test("publishes idle at session start, busy during a turn, idle at end_turn", async () => {
    const { courier, registration } = makeCourier(grokAdapter);
    expect(await courier.hook("grok", "SessionStart", fixture("grok-session-start"))).toEqual({});
    expect(await courier.hook("grok", "UserPromptSubmit", grokPrompt())).toEqual({});
    expect(await courier.hook("grok", "Stop", fixture("grok-stop-end-turn"))).toEqual({});
    expect(registration.statuses).toEqual(["idle", "busy", "idle"]);
  });

  test("a notification idle_prompt publishes idle and a PreToolUse publishes busy", async () => {
    const { courier, registration } = makeCourier(grokAdapter);
    await courier.hook("grok", "PreToolUse", fixture("grok-pre-tool-use"));
    await courier.hook("grok", "Notification", fixture("grok-notification-idle"));
    expect(registration.statuses).toEqual(["busy", "idle"]);
  });

  test("StopCancelled leaves the state unknown without publishing idle", async () => {
    const { courier, registration } = makeCourier(grokAdapter);
    await courier.hook("grok", "UserPromptSubmit", grokPrompt());
    const reply = await courier.hook("grok", "StopCancelled", fixture("grok-stop-end-turn", { reason: "cancelled" }));
    expect(reply).toEqual({});
    expect(registration.statuses).toEqual(["busy"]);
  });

  test("a late StopCancelled of a previous prompt is ignored", async () => {
    const { courier, registration } = makeCourier(grokAdapter);
    await courier.hook("grok", "UserPromptSubmit", grokPrompt({ promptId: "p2" }));
    const reply = await courier.hook("grok", "StopCancelled", fixture("grok-stop-end-turn", { promptId: "p1" }));
    expect(reply).toEqual({});
    expect(registration.statuses).toEqual(["busy"]);
    // Le tour p2 est toujours ouvert : son propre Stop publie le repos.
    await courier.hook("grok", "Stop", fixture("grok-stop-end-turn", { promptId: "p2" }));
    expect(registration.statuses).toEqual(["busy", "idle"]);
  });

  test("hook for another harness answers {} and is logged", async () => {
    const { courier, queue, registration } = makeCourier(grokAdapter);
    queue.push(message("now", "urgent"));
    const reply = await courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"));
    expect(reply).toEqual({});
    expect(registration.statuses).toEqual([]);
    expect(queue.size).toBe(1);
    const lines = loggedEvents("hook-wrong-harness");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ harness: "agy", hookEvent: "PreInvocation" });
  });

  test("an ignored signal answers {} and changes nothing", async () => {
    const { courier, registration } = makeCourier(grokAdapter);
    const reply = await courier.hook("grok", "Stop", fixture("grok-stop-shutdown"));
    expect(reply).toEqual({});
    expect(registration.statuses).toEqual([]);
  });
});

describe("hooked courier delivery", () => {
  test("delivers next and now messages at PostToolUse of the user's turn and keeps later", async () => {
    const { courier, queue } = makeCourier(grokAdapter);
    await courier.hook("grok", "UserPromptSubmit", grokPrompt());
    tick();
    const m1 = message("next", "<env>premier</env>");
    const m2 = message("now", "<env>second</env>");
    const m3 = message("later", "<env>troisième</env>");
    for (const m of [m1, m2, m3]) queue.push(m);
    const reply = await courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use"));
    expect(additionalContext(reply)).toBe(m1.content + "\n\n" + m2.content);
    expect((reply.hookSpecificOutput as Record<string, unknown>).hookEventName).toBe("PostToolUse");
    expect(queue.size).toBe(1);
    expect(queue.first(() => true)).toBe(m3);
    const lines = loggedEvents("hook-delivered");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ harness: "grok", hookEvent: "PostToolUse", msgIds: [m1.msgId, m2.msgId] });
    expect(lines[0]).not.toHaveProperty("event", "PostToolUse");
  });

  test("a next message waiting before the turn keeps its place for the doorbell", async () => {
    const { courier, queue, registration } = makeCourier(grokAdapter);
    const m0 = message("next", "<env>attendait</env>");
    const m1 = message("now", "<env>urgent</env>");
    queue.push(m0);
    queue.push(m1);
    tick();
    await courier.hook("grok", "UserPromptSubmit", grokPrompt());
    const reply = await courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use"));
    expect(additionalContext(reply)).toBe(m1.content);
    expect(queue.first(() => true)).toBe(m0);
    expect(queue.size).toBe(1);
    expect(await courier.hook("grok", "Stop", fixture("grok-stop-end-turn"))).toEqual({});
    expect(registration.statuses).toEqual(["busy", "idle"]);
  });

  test("agy injects deliverable messages at its invocations", async () => {
    const { courier, queue } = makeCourier(agyAdapter);
    const m1 = message("now", "<env>avant le tour</env>");
    queue.push(m1);
    tick();
    const first = await courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"));
    expect(first).toEqual({ injectSteps: [{ userMessage: m1.content }] });
    tick();
    const m2 = message("next", "<env>pendant le tour</env>");
    queue.push(m2);
    const second = await courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-after-injection"));
    expect(second).toEqual({ injectSteps: [{ userMessage: m2.content }] });
    expect(queue.size).toBe(0);
  });

  test("never delivers a message longer than the hook limit, without blocking the next ones", async () => {
    const { courier, queue } = makeCourier(grokAdapter, { hookTextLimit: 50 });
    await courier.hook("grok", "UserPromptSubmit", grokPrompt());
    tick();
    const m1 = message("next", "x".repeat(60));
    const m2 = message("next", "court");
    queue.push(m1);
    queue.push(m2);
    const reply = await courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use"));
    expect(additionalContext(reply)).toBe("court");
    expect(queue.first(() => true)).toBe(m1);
    expect(queue.size).toBe(1);
    // Un second hook ne journalise pas deux fois le même message.
    await courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use"));
    expect(loggedEvents("hook-text-too-long")).toHaveLength(1);
    expect(loggedEvents("hook-text-too-long")[0]).toMatchObject({ harness: "grok", msgId: m1.msgId });
  });

  test("joined envelopes stop at the limit and the rest waits for the next hook", async () => {
    const { courier, queue } = makeCourier(grokAdapter, { hookTextLimit: 20 });
    await courier.hook("grok", "UserPromptSubmit", grokPrompt());
    tick();
    const m1 = message("next", "a".repeat(10));
    const m2 = message("next", "b".repeat(10));
    queue.push(m1);
    queue.push(m2);
    // 10 + 2 + 10 = 22 > 20 : le second attend.
    const reply = await courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use"));
    expect(additionalContext(reply)).toBe(m1.content);
    expect(queue.first(() => true)).toBe(m2);
    expect(loggedEvents("hook-text-too-long")).toHaveLength(0);
  });

  test("a mid-turn hook without a seen turn start delivers now messages only", async () => {
    const { courier, queue } = makeCourier(grokAdapter);
    const next = message("next", "<env>next</env>");
    const urgent = message("now", "<env>now</env>");
    queue.push(next);
    queue.push(urgent);
    tick();
    const reply = await courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use"));
    expect(additionalContext(reply)).toBe(urgent.content);
    expect(queue.first(() => true)).toBe(next);
  });
});

describe("hooked courier continuation", () => {
  test("continues the user's turn at Stop at most three times", async () => {
    const { courier, queue, registration } = makeCourier(grokAdapter);
    await courier.hook("grok", "UserPromptSubmit", grokPrompt());
    const sent: InboundMessage[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      tick();
      const m = message("next", `<env>relance ${attempt}</env>`);
      sent.push(m);
      queue.push(m);
      const reply = await courier.hook("grok", "Stop", fixture("grok-stop-end-turn"));
      if (attempt <= 3) expect(reply).toEqual({ decision: "block", reason: m.content });
      else expect(reply).toEqual({});
    }
    expect(registration.statuses).toEqual(["busy", "idle"]);
    expect(queue.size).toBe(1);
    expect(queue.first(() => true)).toBe(sent[3]);
    const lines = loggedEvents("hook-continued");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ harness: "grok", hookEvent: "Stop", msgIds: [sent[0]?.msgId] });
  });

  test("the continuation counter restarts at every turn start", async () => {
    const { courier, queue } = makeCourier(grokAdapter);
    for (let turn = 1; turn <= 2; turn++) {
      await courier.hook("grok", "UserPromptSubmit", grokPrompt());
      for (let attempt = 1; attempt <= 3; attempt++) {
        tick();
        queue.push(message("next", `<env>t${turn}-${attempt}</env>`));
        const reply = await courier.hook("grok", "Stop", fixture("grok-stop-end-turn"));
        expect(reply.decision).toBe("block");
      }
      tick();
      expect(await courier.hook("grok", "Stop", fixture("grok-stop-end-turn"))).toEqual({});
    }
  });

  test("a stop without a seen turn start never continues", async () => {
    const { courier, queue, registration } = makeCourier(grokAdapter);
    queue.push(message("next", "<env>en file</env>"));
    tick();
    expect(await courier.hook("grok", "Stop", fixture("grok-stop-end-turn"))).toEqual({});
    expect(registration.statuses).toEqual(["idle"]);
    expect(queue.size).toBe(1);
  });

  test("agy continues at Stop with its own reply shape", async () => {
    const { courier, queue } = makeCourier(agyAdapter);
    await courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"));
    tick();
    const m = message("next", "<env>à la fin</env>");
    queue.push(m);
    expect(await courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn"))).toEqual({
      decision: "continue",
      reason: m.content,
    });
  });
});

describe("hooked courier lifecycle", () => {
  test("preflight reason makes beforeSpawn throw CourierUnavailableError", async () => {
    const { courier } = makeCourier(grokAdapter, { preflight: () => "hooks absents" });
    const failure = await courier.beforeSpawn().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CourierUnavailableError);
    expect((failure as Error).message).toBe("hooks absents");
  });

  test("beforeSpawn resolves when preflight has nothing to say", async () => {
    const { courier } = makeCourier(grokAdapter, { preflight: () => undefined });
    await courier.beforeSpawn();
  });

  test("verifyCaller always refuses and read has nothing yet", async () => {
    const { courier } = makeCourier(grokAdapter);
    expect(await courier.verifyCaller({ codexThreadId: "x" }, process.pid)).toBe(false);
    expect(courier.read()).toBeNull();
  });

  test("stop is idempotent", () => {
    const { courier } = makeCourier(grokAdapter);
    courier.stop();
    courier.stop();
  });
});

// ---- Sonnette, tours de pair et renvoi automatique ----

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Attend qu'une condition devienne vraie (sans compter sur un délai fixe) ; échoue au bout de `timeoutMs`. */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await sleep(5);
  }
}

interface DoorbellHarness extends Harness {
  writes: string[];
  sent: Array<{ to: unknown; body: string }>;
  type(chunk: string): void;
}

/** Livreur branché sur un faux terminal et un faux `send`, délais courts (sonnette 20 ms, réponse 200 ms). */
function makeDoorbell(adapter: HookedCourierOptions["adapter"], overrides: Partial<HookedCourierOptions> = {}): DoorbellHarness {
  const sent: DoorbellHarness["sent"] = [];
  const send = (async (a: Parameters<typeof sendPeerMessage>[0]) => {
    sent.push({ to: a.to, body: a.body });
  }) as unknown as typeof sendPeerMessage;
  const harness = makeCourier(adapter, { doorbellDelayMs: 20, doorbellAnswerMs: 200, send, ...overrides });
  const writes: string[] = [];
  let listener: (chunk: string) => void = () => {};
  const terminal: Terminal = {
    write(data) {
      writes.push(data);
    },
    onInput(next) {
      listener = next;
      return () => {};
    },
  };
  harness.courier.afterSpawn(terminal);
  return { ...harness, writes, sent, type: (chunk) => listener(chunk) };
}

const grokDoorbellPrompt = (overrides: Record<string, unknown> = {}) =>
  fixture("grok-user-prompt-submit-doorbell", { prompt: DOORBELL_LINE, ...overrides });

const AGY_TRANSCRIPT = join(import.meta.dir, "fixtures", "hooks", "agy-transcript-doorbell-turn.jsonl");

const AUTO_REPLY_PREFIX = "[réponse automatique idnma]\n";

/** Pose un message dans la file et prévient le livreur, comme le fait la boîte de réception. */
function arrive(h: Harness, m: InboundMessage): void {
  h.queue.push(m);
  h.courier.onMessage();
}

/** Un tour doorbell de Grok : attend la `n`-ième sonnette puis ouvre le tour avec la ligne de sonnette. */
async function grokDoorbellTurn(h: DoorbellHarness, ringNumber: number): Promise<Record<string, unknown>> {
  await until(() => h.writes.length >= ringNumber);
  return h.courier.hook("grok", "UserPromptSubmit", grokDoorbellPrompt());
}

const grokStop = (overrides: Record<string, unknown> = {}) => fixture("grok-stop-end-turn", overrides);

describe("hooked courier doorbell", () => {
  test("rings with the exact doorbell bytes and nothing from the message", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    const m = message("next", "<cross-session-message>rm -rf ~\r claude-mars \x1b[A</cross-session-message>");
    arrive(h, m);
    await sleep(60);
    expect(h.writes).toEqual([DOORBELL_BYTES]);
    expect(h.writes[0]).toBe("📨 idnma read\r");
    expect(loggedEvents("doorbell-rung")).toEqual([expect.objectContaining({ msgId: m.msgId })]);
  });

  test("a draft blocks the doorbell until Enter and the end of the turn it starts", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    h.type("brouillon");
    arrive(h, message("next", "<env>next</env>"));
    tick();
    await sleep(100);
    expect(h.writes).toEqual([]);
    h.type("\r");
    await sleep(60);
    expect(h.writes).toEqual([]);
    expect(await h.courier.hook("grok", "UserPromptSubmit", grokPrompt({ prompt: "brouillon" }))).toEqual({});
    expect(await h.courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use"))).toEqual({});
    expect(await h.courier.hook("grok", "Stop", grokStop())).toEqual({});
    await sleep(60);
    expect(h.writes).toEqual([DOORBELL_BYTES]);
  });

  test("a doorbell line recalled from history is the user's turn", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    h.type("x");
    const m = message("later", "<env>en attente</env>");
    arrive(h, m);
    tick();
    expect(await h.courier.hook("grok", "UserPromptSubmit", grokDoorbellPrompt())).toEqual({});
    expect(h.courier.read()).toBe(m.content);
    expect(h.courier.read()).toBeNull();
    await h.courier.hook("grok", "Stop", grokStop());
    await sleep(80);
    expect(h.sent).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  test("terminal reports and focus do not block the doorbell", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    h.type("\x1b[I");
    h.type("\x1b[12;40R");
    arrive(h, message("next", "<env>m</env>"));
    await sleep(60);
    expect(h.writes).toEqual([DOORBELL_BYTES]);
  });

  test("agy never rings before its first reliable stop", async () => {
    const h = makeDoorbell(agyAdapter);
    arrive(h, message("later", "<env>m</env>"));
    await sleep(100);
    expect(h.writes).toEqual([]);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn"));
    await sleep(60);
    expect(h.writes).toEqual([DOORBELL_BYTES]);
  });

  test("Enter without a turn behind it leaves the courier unknown", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    h.type("\r");
    arrive(h, message("next", "<env>m</env>"));
    await sleep(300);
    expect(h.writes).toEqual([]);
  });

  test("an idle_prompt after an Enter without a turn is ignored until the next turn, stop or session start", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    h.type("/model\r");
    arrive(h, message("later", "<env>m</env>"));
    // L'utilisateur a pu ouvrir un sélecteur : l'idle_prompt d'environ 60 s plus tard n'y vaut rien.
    await h.courier.hook("grok", "Notification", fixture("grok-notification-idle"));
    await sleep(100);
    expect(h.writes).toEqual([]);
    expect(h.registration.statuses).toEqual(["idle"]);
    // Un vrai tour (turn-start puis turn-end) rend le repos fiable.
    await h.courier.hook("grok", "UserPromptSubmit", grokPrompt({ prompt: "fais X" }));
    await h.courier.hook("grok", "Stop", grokStop());
    await until(() => h.writes.length === 1);

    const restarted = makeDoorbell(grokAdapter);
    await restarted.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    restarted.type("\r");
    await restarted.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(restarted, message("later", "<env>m</env>"));
    await until(() => restarted.writes.length === 1);

    const afterStop = makeDoorbell(grokAdapter);
    await afterStop.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    afterStop.type("\r");
    arrive(afterStop, message("later", "<env>m</env>"));
    await afterStop.courier.hook("grok", "Stop", grokStop());
    await until(() => afterStop.writes.length === 1);
  });

  test("an idle_prompt without an Enter before it still gives the rest back", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "PreToolUse", fixture("grok-pre-tool-use"));
    arrive(h, message("later", "<env>m</env>"));
    await h.courier.hook("grok", "Notification", fixture("grok-notification-idle"));
    await until(() => h.writes.length === 1);
  });

  test("an ambiguous notification cancels the scheduled doorbell and leaves the state unknown", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("later", "<env>m</env>"));
    const reply = await h.courier.hook("grok", "Notification", fixture("grok-notification-idle", { notificationType: "auth_required" }));
    expect(reply).toEqual({});
    await sleep(100);
    expect(h.writes).toEqual([]);
    expect(h.registration.statuses).toEqual(["idle"]);
    expect(loggedEvents("state-unknown")).toEqual([
      expect.objectContaining({ harness: "grok", hookEvent: "Notification", reason: "auth_required" }),
    ]);
    // Le prochain événement fiable rend le repos.
    await h.courier.hook("grok", "Notification", fixture("grok-notification-idle"));
    await until(() => h.writes.length === 1);
  });

  test("logs each draft once when it starts, with its shape and length but never its bytes", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    // Fin d'un rapport de souris coupé entre deux blocs : pris pour une frappe, il bloque la sonnette.
    h.type("0;10M");
    h.type("x");
    h.type("\r");
    h.type("4242;1234");
    h.type("\r");
    h.type("\x1bQ");
    expect(loggedEvents("draft-dirty")).toEqual([
      { ts: expect.any(String), event: "draft-dirty", harness: "grok", shape: "mouse-fragment", length: 5 },
      { ts: expect.any(String), event: "draft-dirty", harness: "grok", shape: "text", length: 9 },
      { ts: expect.any(String), event: "draft-dirty", harness: "grok", shape: "escape", length: 2 },
    ]);
  });

  test("logs why the doorbell is withheld when a message arrives", async () => {
    // Au repos, brouillon propre : la sonnette part, rien n'est retenu.
    const ready = makeDoorbell(grokAdapter);
    await ready.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(ready, message("next", "<env>m0</env>"));
    await until(() => ready.writes.length === 1);
    expect(loggedEvents("doorbell-withheld")).toEqual([]);

    const h = makeDoorbell(grokAdapter);
    arrive(h, message("next", "<env>m1</env>"));
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    h.type("abc");
    arrive(h, message("next", "<env>m2</env>"));
    expect(loggedEvents("doorbell-withheld")).toEqual([
      { ts: expect.any(String), event: "doorbell-withheld", harness: "grok", state: "unknown", dirty: false, enterWithoutTurn: false, pending: false },
      { ts: expect.any(String), event: "doorbell-withheld", harness: "grok", state: "idle", dirty: true, enterWithoutTurn: false, pending: false },
    ]);
  });

  test("a permission_prompt from a subagent publishes busy and blocks the doorbell", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("later", "<env>m</env>"));
    await h.courier.hook("grok", "Notification", fixture("grok-notification-idle", { notificationType: "permission_prompt", subagentType: "explore" }));
    await sleep(100);
    expect(h.writes).toEqual([]);
    expect(h.registration.statuses).toEqual(["idle", "busy"]);
  });

  test("a Stop with background tasks is no rest, the auto-woken turn's Stop brings it back", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    await h.courier.hook("grok", "UserPromptSubmit", grokPrompt());
    arrive(h, message("later", "<env>m</env>"));
    await h.courier.hook("grok", "Stop", grokStop({ backgroundTasks: [{ id: "bg-1" }] }));
    await sleep(100);
    expect(h.writes).toEqual([]);
    // Grok réveille l'agent à la fin de la tâche de fond : son Stop, sans tâche, rend le repos.
    await h.courier.hook("grok", "Stop", grokStop({ promptId: "p-wake", backgroundTasks: [] }));
    await until(() => h.writes.length === 1);
  });

  test("agy stop reasons other than NO_TOOL_CALL never ring, even fully idle", async () => {
    const h = makeDoorbell(agyAdapter);
    arrive(h, message("later", "<env>m</env>"));
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn", { terminationReason: "TERMINAL_STEP_TYPE", fullyIdle: true }));
    await sleep(100);
    expect(h.writes).toEqual([]);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn"));
    await until(() => h.writes.length === 1);
  });

  test("a keystroke or a hook event cancels a doorbell that has not left yet", async () => {
    const typed = makeDoorbell(grokAdapter);
    await typed.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(typed, message("next", "<env>m</env>"));
    typed.type("a");
    await sleep(60);
    expect(typed.writes).toEqual([]);

    const hooked = makeDoorbell(grokAdapter);
    await hooked.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(hooked, message("next", "<env>m</env>"));
    await hooked.courier.hook("grok", "PreToolUse", fixture("grok-pre-tool-use"));
    await sleep(60);
    expect(hooked.writes).toEqual([]);
  });

  test("an unanswered doorbell leaves the courier unknown", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("next", "<env>m</env>"));
    await sleep(400);
    expect(h.writes).toEqual([DOORBELL_BYTES]);
    expect(loggedEvents("doorbell-unanswered")).toHaveLength(1);
  });

  test("a doorbell turn arriving after the answer timeout is still a peer turn", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    const m = message("next", "<env>tard</env>");
    arrive(h, m);
    await until(() => loggedEvents("doorbell-unanswered").length === 1);
    expect(await h.courier.hook("grok", "UserPromptSubmit", grokDoorbellPrompt())).toEqual({});
    expect(h.courier.read()).toBe(m.content);
  });

  test("a turn start of any kind consumes the pending doorbell", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("next", "<env>m</env>"));
    await until(() => h.writes.length === 1);
    await h.courier.hook("grok", "UserPromptSubmit", grokPrompt({ prompt: "autre chose" }));
    await h.courier.hook("grok", "Stop", grokStop());
    // La ligne de sonnette rappelée ensuite n'est plus une sonnette tapée par la doublure.
    const m = message("later", "<env>ensuite</env>");
    h.queue.push(m);
    await h.courier.hook("grok", "UserPromptSubmit", grokDoorbellPrompt({ promptId: "p-recalled" }));
    expect(h.courier.read()).toBe(m.content);
    await h.courier.hook("grok", "Stop", grokStop({ promptId: "p-recalled" }));
    await sleep(80);
    expect(h.sent).toEqual([]);
  });

  test("stop cancels a scheduled doorbell, the answer timeout and a pending re-read", async () => {
    const scheduled = makeDoorbell(grokAdapter);
    await scheduled.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(scheduled, message("next", "<env>m</env>"));
    scheduled.courier.stop();
    scheduled.courier.stop();
    await sleep(80);
    expect(scheduled.writes).toEqual([]);

    const rung = makeDoorbell(grokAdapter);
    await rung.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(rung, message("next", "<env>m</env>"));
    await until(() => rung.writes.length === 1);
    rung.courier.stop();
    await sleep(300);
    expect(loggedEvents("doorbell-unanswered")).toHaveLength(0);

    const reread = makeDoorbell(grokAdapter);
    await reread.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(reread, message("next", "<env>m</env>"));
    await grokDoorbellTurn(reread, 1);
    reread.courier.read();
    await reread.courier.hook("grok", "Stop", grokStop({ lastAssistantMessage: "" }));
    await sleep(100);
    reread.courier.stop();
    await sleep(600);
    expect(reread.sent).toEqual([]);
  });
});

describe("hooked courier peer turns", () => {
  test("Grok doorbell turn reads once and replies with the final answer", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    const m = message("next", "<env>question</env>");
    arrive(h, m);
    expect(await grokDoorbellTurn(h, 1)).toEqual({});
    expect(h.courier.read()).toBe(m.content);
    expect(h.courier.read()).toBeNull();
    expect(await h.courier.hook("grok", "Stop", grokStop())).toEqual({});
    await until(() => h.sent.length === 1);
    expect(h.sent[0]).toEqual({ to: { address: m.from }, body: `${AUTO_REPLY_PREFIX}MANGUE-42` });
    expect(h.queue.size).toBe(0);
  });

  test("agy doorbell turn gets exactly one message and the next one rings again", async () => {
    const h = makeDoorbell(agyAdapter);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn"));
    const m1 = message("later", "<env>premier</env>");
    const m2 = message("later", "<env>second</env>");
    h.queue.push(m1);
    arrive(h, m2);
    await sleep(60);
    expect(h.writes).toEqual([DOORBELL_BYTES]);
    const reply = await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"));
    expect(reply).toEqual({ injectSteps: [{ userMessage: m1.content }] });
    expect(h.courier.read()).toBeNull();
    const transcriptPath = join(import.meta.dir, "fixtures", "hooks", "agy-transcript-doorbell-turn.jsonl");
    expect(await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn", { transcriptPath }))).toEqual({});
    await until(() => h.sent.length === 1);
    expect(h.sent[0]).toEqual({ to: { address: m1.from }, body: `${AUTO_REPLY_PREFIX}MANGUE-42\nKIWI-17` });
    await until(() => h.writes.length === 2);
    expect(h.writes).toEqual([DOORBELL_BYTES, DOORBELL_BYTES]);
    expect(loggedEvents("doorbell-rung").map((line) => line.msgId)).toEqual([m1.msgId, m2.msgId]);
  });

  test("an auto-reply opens a silent turn", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    const m = message(
      "next",
      `<cross-session-message from="uds:/tmp/peer.sock" from-name="x" from-mode="bypass">\n${AUTO_REPLY_PREFIX}MANGUE-42\n</cross-session-message>`,
    );
    arrive(h, m);
    await grokDoorbellTurn(h, 1);
    expect(h.courier.read()).toBe(m.content);
    await h.courier.hook("grok", "Stop", grokStop());
    await sleep(80);
    expect(h.sent).toEqual([]);
  });

  test("an unread silent message is dropped without a reply", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    const m = message(
      "next",
      `<cross-session-message from="uds:/tmp/peer.sock" from-name="x" from-mode="bypass">\n${AUTO_REPLY_PREFIX}fini\n</cross-session-message>`,
    );
    arrive(h, m);
    for (let ring = 1; ring <= 3; ring++) {
      await grokDoorbellTurn(h, ring);
      await h.courier.hook("grok", "Stop", grokStop());
    }
    await sleep(80);
    expect(h.queue.size).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.writes).toHaveLength(3);
    expect(loggedEvents("doorbell-unread")).toEqual([expect.objectContaining({ msgId: m.msgId })]);
  });

  test("an unread doorbell message is requeued, then rejected after three attempts", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    const m = message("next", "<env>jamais lu</env>");
    arrive(h, m);
    for (let ring = 1; ring <= 2; ring++) {
      await grokDoorbellTurn(h, ring);
      await h.courier.hook("grok", "Stop", grokStop());
      expect(h.queue.first(() => true)).toBe(m);
      expect(h.sent).toEqual([]);
    }
    await grokDoorbellTurn(h, 3);
    await h.courier.hook("grok", "Stop", grokStop());
    await until(() => h.sent.length === 1);
    expect(h.sent[0]).toEqual({
      to: { address: m.from },
      body: `${AUTO_REPLY_PREFIX}grok-test : message non livré (Grok n'a pas lu le message)`,
    });
    expect(h.queue.size).toBe(0);
    expect(loggedEvents("doorbell-unread")).toEqual([expect.objectContaining({ msgId: m.msgId })]);
    await sleep(80);
    expect(h.writes).toHaveLength(3);
  });

  test("a new turn start closes an open peer turn and requeues its unread message", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    const m = message("next", "<env>pas lu</env>");
    arrive(h, m);
    await grokDoorbellTurn(h, 1);
    expect(h.queue.size).toBe(0);
    await h.courier.hook("grok", "UserPromptSubmit", grokPrompt({ promptId: "p-romain", prompt: "fais Y" }));
    expect(h.queue.first(() => true)).toBe(m);
    expect(h.queue.size).toBe(1);
  });

  test("a peer turn lost to a new turn start still replies tour interrompu when the message was read", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    const m = message("next", "<env>lu</env>");
    arrive(h, m);
    await grokDoorbellTurn(h, 1);
    h.courier.read();
    await h.courier.hook("grok", "UserPromptSubmit", grokPrompt({ promptId: "p-romain", prompt: "fais Y" }));
    await until(() => h.sent.length === 1);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_PREFIX}grok-test : tour interrompu`);
  });

  test("read outside a peer turn returns the oldest message", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "UserPromptSubmit", grokPrompt());
    const m1 = message("later", "<env>un</env>");
    const m2 = message("next", "<env>deux</env>");
    h.queue.push(m1);
    h.queue.push(m2);
    expect(h.courier.read()).toBe(m1.content);
    expect(h.courier.read()).toBe(m2.content);
    expect(h.courier.read()).toBeNull();
  });

  test("Enter during a Grok peer turn keeps the auto-reply (Grok queues the user's input)", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("next", "<env>m</env>"));
    await grokDoorbellTurn(h, 1);
    h.courier.read();
    h.type("ok\r");
    await h.courier.hook("grok", "Stop", grokStop());
    await until(() => h.sent.length === 1);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_PREFIX}MANGUE-42`);
    expect(loggedEvents("peer-turn-mixed")).toEqual([]);
  });

  test("Enter during an agy peer turn alone does not mix the turn but leaves the state unknown", async () => {
    const h = makeDoorbell(agyAdapter);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn"));
    const m = message("later", "<env>m</env>");
    arrive(h, m);
    await until(() => h.writes.length === 1);
    await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"));
    h.type("/model\r");
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn", { transcriptPath: AGY_TRANSCRIPT }));
    await until(() => h.sent.length === 1);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_PREFIX}MANGUE-42\nKIWI-17`);
    expect(loggedEvents("peer-turn-mixed")).toEqual([]);
  });

  test("an agy peer turn mixed with the user's input replies tour mêlé instead of the answer", async () => {
    const h = makeDoorbell(agyAdapter);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn"));
    const m = message("later", "<env>m</env>");
    arrive(h, m);
    await until(() => h.writes.length === 1);
    expect(await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"))).toEqual({
      injectSteps: [{ userMessage: m.content }],
    });
    // Après l'injection, le lastUserInput vaut le texte injecté : le tour n'est pas mêlé.
    await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-after-injection", { lastUserInput: m.content }));
    expect(loggedEvents("peer-turn-mixed")).toEqual([]);
    // Une entrée de l'utilisateur entre dans le tour : le lastUserInput n'est ni la sonnette ni le texte injecté.
    await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-after-injection", { invocationNum: 2, lastUserInput: "et aussi X" }));
    expect(loggedEvents("peer-turn-mixed")).toEqual([expect.objectContaining({ harness: "agy" })]);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn", { transcriptPath: AGY_TRANSCRIPT }));
    await until(() => h.sent.length === 1);
    expect(h.sent[0]).toEqual({
      to: { address: m.from },
      body: `${AUTO_REPLY_PREFIX}grok-test : tour mêlé à une entrée de l'utilisateur, pas de réponse automatique`,
    });
    await sleep(80);
    expect(h.sent).toHaveLength(1);
  });

  test("a message injected mid-turn is not the user's input in an agy peer turn", async () => {
    const h = makeDoorbell(agyAdapter);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn"));
    arrive(h, message("later", "<env>m</env>"));
    await until(() => h.writes.length === 1);
    await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"));
    const urgent = message("now", "<env>urgent</env>");
    h.queue.push(urgent);
    const reply = await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-after-injection", { lastUserInput: DOORBELL_LINE }));
    expect(reply).toEqual({ injectSteps: [{ userMessage: urgent.content }] });
    await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-after-injection", { invocationNum: 2, lastUserInput: urgent.content }));
    expect(loggedEvents("peer-turn-mixed")).toEqual([]);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn", { transcriptPath: AGY_TRANSCRIPT }));
    await until(() => h.sent.length === 1);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_PREFIX}MANGUE-42\nKIWI-17`);
  });

  test("a peer message injected into a turn opened for someone else carries the reply hint", async () => {
    const envelopeFrom = (fromName: string, body: string) =>
      buildEnvelope({ from: addressOf(`/tmp/${fromName}.sock`), fromName, fromMode: "bypass", body });
    // Grok, tour de l'utilisateur : la réponse finale va à l'utilisateur, l'expéditeur doit être relancé.
    const grok = makeCourier(grokAdapter);
    await grok.courier.hook("grok", "UserPromptSubmit", grokPrompt());
    tick();
    const passing = message("next", envelopeFrom("claude-ceres", "renvoie-moi FRAISE-17"));
    grok.queue.push(passing);
    expect(additionalContext(await grok.courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use")))).toBe(withReplyHint(passing.content));

    // agy, tour de pair : son message arrive tel quel, un `now` d'un autre pair porte le rappel.
    const h = makeDoorbell(agyAdapter);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn"));
    const own = message("later", envelopeFrom("claude-mars", "question de mars"));
    arrive(h, own);
    await until(() => h.writes.length === 1);
    expect(await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"))).toEqual({ injectSteps: [{ userMessage: own.content }] });
    const urgent = message("now", envelopeFrom("claude-venus", "urgent"));
    h.queue.push(urgent);
    const reply = await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-after-injection", { lastUserInput: own.content }));
    expect(reply).toEqual({ injectSteps: [{ userMessage: withReplyHint(urgent.content) }] });
    // Le texte injecté revient en `lastUserInput` : ce n'est pas une entrée de l'utilisateur.
    await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-after-injection", { invocationNum: 2, lastUserInput: withReplyHint(urgent.content) }));
    expect(loggedEvents("peer-turn-mixed")).toEqual([]);
  });

  test("a mixed agy peer turn answering an auto-reply stays silent", async () => {
    const h = makeDoorbell(agyAdapter);
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn"));
    arrive(
      h,
      message("next", `<cross-session-message from="uds:/tmp/peer.sock" from-name="x" from-mode="bypass">\n${AUTO_REPLY_PREFIX}fini\n</cross-session-message>`),
    );
    await until(() => h.writes.length === 1);
    await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"));
    await h.courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-after-injection", { lastUserInput: "autre chose" }));
    await h.courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn", { transcriptPath: AGY_TRANSCRIPT }));
    await sleep(100);
    expect(h.sent).toEqual([]);
  });

  test("interrupted peer turn replies tour interrompu", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("next", "<env>m</env>"));
    await grokDoorbellTurn(h, 1);
    h.courier.read();
    await h.courier.hook("grok", "StopCancelled", grokStop({ reason: "cancelled" }));
    await until(() => h.sent.length === 1);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_PREFIX}grok-test : tour interrompu`);
  });

  test("failed peer turn replies with the detail, or an unknown error", async () => {
    const withDetail = makeDoorbell(grokAdapter);
    await withDetail.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(withDetail, message("next", "<env>m</env>"));
    await grokDoorbellTurn(withDetail, 1);
    withDetail.courier.read();
    await withDetail.courier.hook("grok", "StopFailure", grokStop({ errorDetails: "quota épuisé" }));
    await until(() => withDetail.sent.length === 1);
    expect(withDetail.sent[0]?.body).toBe(`${AUTO_REPLY_PREFIX}grok-test : tour en échec (quota épuisé)`);

    const bare = makeDoorbell(grokAdapter);
    await bare.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(bare, message("next", "<env>m</env>"));
    await grokDoorbellTurn(bare, 1);
    bare.courier.read();
    await bare.courier.hook("grok", "StopFailure", grokStop());
    await until(() => bare.sent.length === 1);
    expect(bare.sent[0]?.body).toBe(`${AUTO_REPLY_PREFIX}grok-test : tour en échec (erreur inconnue)`);
  });

  test("a completed peer turn without an answer is re-read once, then reported", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("next", "<env>m</env>"));
    await grokDoorbellTurn(h, 1);
    h.courier.read();
    const stoppedAt = Date.now();
    await h.courier.hook("grok", "Stop", grokStop({ lastAssistantMessage: "", last_assistant_message: "" }));
    await sleep(300);
    expect(h.sent).toEqual([]);
    await until(() => h.sent.length === 1);
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(450);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_PREFIX}grok-test : tour terminé sans réponse`);
  });

  test("a peer turn without a message sends nothing", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("next", "<env>m</env>"));
    await until(() => h.writes.length === 1);
    // L'utilisateur lit le message avant que la sonnette n'aboutisse : le tour de pair arrive à file vide.
    expect(h.courier.read()).not.toBeNull();
    await h.courier.hook("grok", "UserPromptSubmit", grokDoorbellPrompt());
    expect(h.courier.read()).toBeNull();
    await h.courier.hook("grok", "Stop", grokStop());
    await sleep(80);
    expect(h.sent).toEqual([]);
  });

  test("mid-turn in a peer turn delivers now messages only and never continues at the end", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("next", "<env>m</env>"));
    await grokDoorbellTurn(h, 1);
    h.courier.read();
    tick();
    h.queue.push(message("next", "<env>pas maintenant</env>"));
    expect(await h.courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use"))).toEqual({});
    const urgent = message("now", "<env>urgent</env>");
    h.queue.push(urgent);
    expect(additionalContext(await h.courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use")))).toBe(urgent.content);
    expect(await h.courier.hook("grok", "Stop", grokStop())).toEqual({});
  });
});

// ---- Conversation étrangère ----

describe("hooked courier conversations", () => {
  const AGY_CONVERSATION = "8d4dcdbc-4426-41f3-94fd-fcc4e502d8c5";
  const GROK_SESSION = "01a17c41-b2d3-7f80-9e52-f2434504e234";

  test("agy adopts another conversation outside a turn without any alarm", async () => {
    const { courier, queue } = makeCourier(agyAdapter);
    await courier.hook("agy", "SessionStart", fixture("agy-session-start"));
    queue.push(message("now", "<env>urgent</env>"));
    const reply = await courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell", { conversationId: "autre" }));
    expect(reply).toHaveProperty("injectSteps");
    expect(loggedEvents("foreign-conversation")).toHaveLength(0);
    expect(loggedEvents("agy-conversation-changed")).toHaveLength(0);
    // La conversation adoptée est celle du tour ouvert : l'ancienne est maintenant étrangère.
    queue.push(message("now", "<env>second</env>"));
    expect(await courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-after-injection"))).toEqual({});
    expect(queue.size).toBe(1);
  });

  test("agy ignores and logs a signal from another conversation while a turn is open", async () => {
    const { courier, queue, registration } = makeCourier(agyAdapter);
    await courier.hook("agy", "PreInvocation", fixture("agy-pre-invocation-doorbell"));
    queue.push(message("now", "<env>urgent</env>"));
    const foreignInvocation = fixture("agy-pre-invocation-after-injection", { conversationId: "sous-agent" });
    expect(await courier.hook("agy", "PreInvocation", foreignInvocation)).toEqual({});
    expect(queue.size).toBe(1);
    expect(await courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn", { conversationId: "sous-agent" }))).toEqual({});
    // Le Stop étranger n'a pas fermé le tour : aucun repos publié.
    expect(registration.statuses).toEqual(["busy"]);
    const lines = loggedEvents("foreign-conversation");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ harness: "agy", hookEvent: "PreInvocation", conversationId: "sous-agent" });
    expect(lines[1]).toMatchObject({ harness: "agy", hookEvent: "Stop", conversationId: "sous-agent" });
    // Le vrai Stop de la conversation du tour le ferme (la file est vidée : pas de relance).
    courier.read();
    await courier.hook("agy", "Stop", fixture("agy-stop-doorbell-turn", { conversationId: AGY_CONVERSATION }));
    expect(registration.statuses).toEqual(["busy", "idle"]);
  });

  test("grok ignores another session during the user's turn and keeps the turn open", async () => {
    const { courier, queue, registration } = makeCourier(grokAdapter);
    await courier.hook("grok", "UserPromptSubmit", grokPrompt());
    tick();
    queue.push(message("now", "<env>urgent</env>"));
    const foreignPost = fixture("grok-post-tool-use", { sessionId: "grok-p" });
    expect(await courier.hook("grok", "PostToolUse", foreignPost)).toEqual({});
    expect(queue.size).toBe(1);
    expect(await courier.hook("grok", "Stop", grokStop({ sessionId: "grok-p" }))).toEqual({});
    expect(registration.statuses).toEqual(["busy"]);
    expect(loggedEvents("foreign-conversation")).toEqual([
      expect.objectContaining({ harness: "grok", hookEvent: "PostToolUse", conversationId: "grok-p" }),
      expect.objectContaining({ harness: "grok", hookEvent: "Stop", conversationId: "grok-p" }),
    ]);
    // Le message attendait : le vrai PostToolUse le livre, le vrai Stop ferme le tour.
    expect(additionalContext(await courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use")))).toBe("<env>urgent</env>");
    await courier.hook("grok", "Stop", grokStop());
    expect(registration.statuses).toEqual(["busy", "idle"]);
  });

  test("grok ignores another session during a peer turn", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    arrive(h, message("next", "<env>m</env>"));
    await grokDoorbellTurn(h, 1);
    h.courier.read();
    h.queue.push(message("now", "<env>urgent</env>"));
    expect(await h.courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use", { sessionId: "grok-p" }))).toEqual({});
    expect(h.queue.size).toBe(1);
    await h.courier.hook("grok", "Stop", grokStop({ sessionId: "grok-p", lastAssistantMessage: "FAUX" }));
    await sleep(80);
    expect(h.sent).toEqual([]);
    await h.courier.hook("grok", "Stop", grokStop());
    await until(() => h.sent.length === 1);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_PREFIX}MANGUE-42`);
  });

  test("grok adopts a new session outside a turn (new, clear)", async () => {
    const { courier, registration } = makeCourier(grokAdapter);
    await courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    await courier.hook("grok", "SessionStart", fixture("grok-session-start", { sessionId: "neuve" }));
    expect(loggedEvents("foreign-conversation")).toHaveLength(0);
    await courier.hook("grok", "UserPromptSubmit", grokPrompt({ sessionId: "neuve" }));
    await courier.hook("grok", "Stop", grokStop({ sessionId: GROK_SESSION }));
    expect(registration.statuses).toEqual(["idle", "busy"]);
    await courier.hook("grok", "Stop", grokStop({ sessionId: "neuve" }));
    expect(registration.statuses).toEqual(["idle", "busy", "idle"]);
  });

  // Fin de tour perdue (aucun `Stop`) puis `/clear` : sans libération du tour, la session neuve resterait étrangère.
  for (const [rest, event, payload] of [
    ["an idle_prompt", "Notification", "grok-notification-idle"],
    ["a session start", "SessionStart", "grok-session-start"],
  ] as const) {
    test(`grok releases a turn whose Stop was lost on ${rest} of the same session`, async () => {
      const { courier, queue } = makeCourier(grokAdapter);
      await courier.hook("grok", "UserPromptSubmit", grokPrompt());
      await courier.hook("grok", event, fixture(payload));
      await courier.hook("grok", "SessionStart", fixture("grok-session-start", { sessionId: "neuve" }));
      await courier.hook("grok", "UserPromptSubmit", grokPrompt({ sessionId: "neuve" }));
      tick();
      queue.push(message("now", "<env>urgent</env>"));
      const reply = await courier.hook("grok", "PostToolUse", fixture("grok-post-tool-use", { sessionId: "neuve" }));
      expect(additionalContext(reply)).toBe("<env>urgent</env>");
      expect(loggedEvents("foreign-conversation")).toHaveLength(0);
    });
  }
});

describe("hooked courier read and the reply hint", () => {
  const envelope = (body: string): string => buildEnvelope({ from: addressOf("/tmp/peer.sock"), fromName: "claude-mars", fromMode: "bypass", body });

  test("outside a peer turn, read tells the agent its final answer will not reach the sender", () => {
    const h = makeCourier(grokAdapter);
    const m = message("next", envelope("salut"));
    h.queue.push(m);
    const text = h.courier.read();
    expect(text).toStartWith(`${m.content}\n`);
    expect(text).toContain("`idnma peer send claude-mars");
  });

  test("in a peer turn, read hands the message as is: the final answer goes back to the sender", async () => {
    const h = makeDoorbell(grokAdapter);
    await h.courier.hook("grok", "SessionStart", fixture("grok-session-start"));
    const m = message("next", envelope("salut"));
    arrive(h, m);
    await until(() => h.writes.length === 1);
    await h.courier.hook("grok", "UserPromptSubmit", grokDoorbellPrompt());
    expect(h.courier.read()).toBe(m.content);
  });
});
