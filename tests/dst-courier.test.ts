import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildEnvelope } from "../src/bus/envelope.ts";
import type { InboundMessage, Priority } from "../src/bus/inbox.ts";
import type { sendPeerMessage } from "../src/bus/send.ts";
import { createBridgeCourier } from "../src/bridge/courier.ts";
import { AUTO_REPLY_MARKER, CourierUnavailableError, replyHintFor, senderNameOf, type Courier } from "../src/understudy/courier.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import { connectFakeDstPlugin, TEST_TOKEN, type FakeDstPlugin } from "./helpers/fake-dst-plugin.ts";
import { fakeRegistration } from "./helpers/fake-registration.ts";

const NAME = "dst-test";
const ADDRESS = "uds:/tmp/peer-a.sock";

let dir: string;
let savedConfigDir: string | undefined;
let couriers: Courier[];
let plugins: FakeDstPlugin[];
let syncCounter: number;

beforeEach(() => {
  savedConfigDir = process.env.IDNMA_CONFIG_DIR;
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = join(dir, "config");
  couriers = [];
  plugins = [];
  syncCounter = 0;
});

afterEach(() => {
  for (const plugin of plugins) plugin.close();
  for (const courier of couriers) courier.stop();
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

/** Fenêtre courte pour affirmer qu'un événement n'arrive PAS (le seul cas où une attente fixe est inévitable). */
const settle = (ms = 60): Promise<void> => Bun.sleep(ms);

function logLines(): Array<Record<string, unknown>> {
  const path = join(process.env.IDNMA_CONFIG_DIR!, "logs", "idnma.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const logged = (event: string): Array<Record<string, unknown>> => logLines().filter((line) => line.event === event);

function rawLog(): string {
  const path = join(process.env.IDNMA_CONFIG_DIR!, "logs", "idnma.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

type SentReply = Parameters<typeof sendPeerMessage>[0];

interface Harness {
  courier: Courier;
  queue: MessageQueue;
  registration: ReturnType<typeof fakeRegistration>;
  sent: SentReply[];
  /** Renvois dont l'envoi est allé à son terme (avec `sendDelayMs`, après le délai). */
  completed: SentReply[];
  socketPath: string;
  /** Texte des renvois, marque de renvoi automatique retirée. */
  replies(): string[];
}

interface MakeOptions {
  isAllowedPeer?: (pid: number | undefined) => boolean;
  admissionTimeoutMs?: number;
  helloTimeoutMs?: number;
  graceMs?: number;
  maxAttempts?: number;
  fromMode?: "bypass" | "prompting";
  socketName?: string;
  /** Délai d'un envoi de renvoi ; `Infinity` pour un envoi qui ne se termine jamais. */
  sendDelayMs?: number;
}

function makeCourier(o: MakeOptions = {}): Harness {
  const queue = new MessageQueue();
  const registration = fakeRegistration();
  const sent: SentReply[] = [];
  const completed: SentReply[] = [];
  const socketPath = join(dir, o.socketName ?? "bridge.sock");
  const courier = createBridgeCourier({
    harness: "dst",
    name: NAME,
    fromMode: o.fromMode ?? "prompting",
    registration,
    queue,
    socketPath,
    token: TEST_TOKEN,
    send: (async (a: SentReply) => {
      sent.push(a);
      if (o.sendDelayMs === Infinity) await new Promise<never>(() => {});
      else if (o.sendDelayMs !== undefined) await Bun.sleep(o.sendDelayMs);
      completed.push(a);
      return { msgId: "reply-id", target: {} };
    }) as unknown as typeof sendPeerMessage,
    ...(o.isAllowedPeer === undefined ? {} : { isAllowedPeer: o.isAllowedPeer }),
    ...(o.admissionTimeoutMs === undefined ? {} : { admissionTimeoutMs: o.admissionTimeoutMs }),
    ...(o.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: o.helloTimeoutMs }),
    ...(o.graceMs === undefined ? {} : { graceMs: o.graceMs }),
    ...(o.maxAttempts === undefined ? {} : { maxAttempts: o.maxAttempts }),
  });
  couriers.push(courier);
  return { courier, queue, registration, sent, completed, socketPath, replies: () => sent.map((s) => s.body.slice(AUTO_REPLY_MARKER.length + 1)) };
}

async function startCourier(o: MakeOptions = {}): Promise<Harness> {
  const harness = makeCourier(o);
  await harness.courier.beforeSpawn();
  return harness;
}

async function connect(h: Harness): Promise<FakeDstPlugin> {
  const plugin = connectFakeDstPlugin(h.socketPath);
  plugins.push(plugin);
  await plugin.ready;
  return plugin;
}

/** Connexion + `hello` valide, attendu admis. */
async function admit(h: Harness): Promise<FakeDstPlugin> {
  const before = logged("dst-bridge-up").length;
  const plugin = await connect(h);
  plugin.hello();
  await waitFor(() => logged("dst-bridge-up").length === before + 1, "bridge up");
  return plugin;
}

/**
 * Attend que la doublure ait traité tout ce que `plugin` a écrit avant : une trame `error` à code
 * unique, journalisée à son traitement, borne les trames qui la précèdent.
 */
async function sync(plugin: FakeDstPlugin): Promise<void> {
  const code = `sync-${syncCounter++}`;
  plugin.send({ type: "error", code });
  await waitFor(() => logged("dst-plugin-error").some((line) => line.code === code), `sync ${code}`);
}

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

/** Un message arrivé, une session de premier plan annoncée : rend l'`id` du `deliver` reçu. */
async function deliverFirst(h: Harness, plugin: FakeDstPlugin, n = 1, o: { content?: string } = {}): Promise<string> {
  const before = plugin.delivers.length;
  receive(h, inbound(n, o));
  plugin.state("s1");
  await waitFor(() => plugin.delivers.length === before + 1, `deliver ${n}`);
  return plugin.delivers[before]!.id;
}

describe("senderNameOf", () => {
  test("reads the from-name of an envelope", () => {
    expect(senderNameOf(envelope("hi", "peer-a"))).toBe("peer-a");
  });

  test("returns undefined for an envelope without a from-name", () => {
    expect(senderNameOf('<cross-session-message from="uds:/tmp/a.sock" from-mode="prompting">\nhi\n</cross-session-message>')).toBeUndefined();
  });

  test("returns undefined for a name outside the peer name form", () => {
    expect(senderNameOf(envelope("hi", 'bad name; rm -rf "/"'))).toBeUndefined();
    expect(senderNameOf(envelope("hi", ""))).toBeUndefined();
  });

  test("returns undefined for text that is not an envelope", () => {
    expect(senderNameOf("just text")).toBeUndefined();
  });
});

describe("beforeSpawn", () => {
  test("opens a socket readable by its owner only and logs it", async () => {
    const h = await startCourier();
    expect(statSync(h.socketPath).mode & 0o777).toBe(0o600);
    expect(logged("dst-bridge-listening")).toHaveLength(1);
  });

  test("replaces a stale file left at the socket path", async () => {
    const stale = join(dir, "stale.sock");
    const first = makeCourier({ socketName: "stale.sock" });
    await first.courier.beforeSpawn();
    first.courier.stop();
    expect(existsSync(stale)).toBe(false);
    await Bun.write(stale, "leftover");
    const second = await startCourier({ socketName: "stale.sock" });
    const plugin = await admit(second);
    expect(plugin.closed).toBe(false);
  });

  test("fails with CourierUnavailableError when the socket directory is not private", async () => {
    const open = join(dir, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    const h = makeCourier({ socketName: "open/bridge.sock" });
    await expect(h.courier.beforeSpawn()).rejects.toBeInstanceOf(CourierUnavailableError);
  });

  test("fails with CourierUnavailableError after stop", async () => {
    const h = makeCourier();
    h.courier.stop();
    await expect(h.courier.beforeSpawn()).rejects.toBeInstanceOf(CourierUnavailableError);
  });
});

describe("admission", () => {
  test("a valid hello is admitted and logged without the token", async () => {
    const h = await startCourier();
    const plugin = await connect(h);
    plugin.hello({ pid: 4242, versions: { tui: "1.2.3" } });
    await waitFor(() => logged("dst-bridge-up").length === 1, "bridge up");
    expect(logged("dst-bridge-up")[0]).toMatchObject({ pid: 4242, versions: { tui: "1.2.3" }, reconnect: false });
    expect(rawLog()).not.toContain(TEST_TOKEN);
    expect(plugin.closed).toBe(false);
  });

  const refusals: Array<{ title: string; reason: string; open: (plugin: FakeDstPlugin) => void; make?: MakeOptions }> = [
    { title: "a wrong token", reason: "token", open: (p) => p.hello({ token: "wrong-token-test" }) },
    { title: "a wrong protocol version", reason: "version", open: (p) => p.hello({ v: 99 }) },
    { title: "a first frame that is not a hello", reason: "not-hello", open: (p) => p.state("s1") },
    { title: "a first frame that is unreadable", reason: "not-hello", open: (p) => p.sendRaw("not json at all\n") },
    { title: "a peer the admission check rejects", reason: "peer", open: (p) => p.hello(), make: { isAllowedPeer: () => false } },
  ];
  for (const refusal of refusals) {
    test(`refuses ${refusal.title}, closes the connection and delivers nothing`, async () => {
      const h = await startCourier(refusal.make);
      receive(h, inbound(1));
      const plugin = await connect(h);
      refusal.open(plugin);
      await waitFor(() => logged("dst-bridge-refused").length === 1, "bridge refused");
      expect(logged("dst-bridge-refused")[0]).toMatchObject({ reason: refusal.reason });
      await waitFor(() => plugin.closed, "connection closed");
      plugin.state("s1");
      await settle();
      expect(plugin.delivers).toEqual([]);
      expect(logged("dst-bridge-up")).toEqual([]);
      expect(rawLog()).not.toContain(TEST_TOKEN);
      expect(rawLog()).not.toContain("wrong-token-test");
    });
  }

  test("refuses a connection that sends no frame within the admission timeout", async () => {
    const h = await startCourier({ admissionTimeoutMs: 80 });
    const plugin = await connect(h);
    await waitFor(() => plugin.closed, "connection closed");
    expect(logged("dst-bridge-refused")[0]).toMatchObject({ reason: "timeout" });
  });

  test("asks the admission check about the kernel pid of the connection", async () => {
    const seen: Array<number | undefined> = [];
    const h = await startCourier({
      isAllowedPeer: (pid) => {
        seen.push(pid);
        return true;
      },
    });
    await admit(h);
    expect(seen).toEqual([process.pid]);
  });

  test("the default admission accepts a peer that descends from the understudy process", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    expect(plugin.closed).toBe(false);
  });

  test("skips blank lines without treating them as invalid frames", async () => {
    const h = await startCourier();
    const plugin = await connect(h);
    plugin.sendRaw("\n   \n");
    plugin.hello();
    await waitFor(() => logged("dst-bridge-up").length === 1, "bridge up");
    plugin.sendRaw("\n\n");
    await sync(plugin);
    expect(logged("dst-frame-invalid")).toEqual([]);
  });
});

describe("delivery", () => {
  test("keeps the queue until a state with a session arrives, then sends everything as deliver frames", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    receive(h, inbound(1, { priority: "now" }));
    receive(h, inbound(2, { priority: "later" }));
    plugin.state(null);
    await sync(plugin);
    await settle(30);
    expect(plugin.delivers).toEqual([]);
    expect(h.queue.size).toBe(2);

    plugin.state("s1");
    await waitFor(() => plugin.delivers.length === 2, "two delivers");
    expect(h.queue.size).toBe(0);
    const [first, second] = plugin.delivers;
    expect(first).toEqual({
      type: "deliver",
      id: expect.any(String),
      priority: "now",
      sender: "peer-a",
      text: inbound(1).content,
      hint: replyHintFor(inbound(1).content),
    });
    expect(second).toMatchObject({ priority: "later", text: inbound(2).content });
    expect(first!.id).not.toBe(second!.id);
    expect(first!.hint).toContain("idnma peer send peer-a");
    expect(plugin.strays).toEqual([]);
  });

  test("sends a message that arrives while a session is in the foreground right away", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    plugin.state("s1");
    await sync(plugin);
    receive(h, inbound(1));
    await waitFor(() => plugin.delivers.length === 1, "deliver");
  });

  test("flushes the queue on every state with a session, changed or not", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    plugin.state("s1");
    await sync(plugin);
    // Un message remis en file sans passer par onMessage : seule la prochaine `state` le fait partir.
    h.queue.push(inbound(1));
    await settle(30);
    expect(plugin.delivers).toEqual([]);
    plugin.state("s1");
    await waitFor(() => plugin.delivers.length === 1, "deliver on unchanged state");
  });

  test("omits the hint for an automatic reply and uses idnma as sender when the envelope has no name", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const autoReply = envelope(`${AUTO_REPLY_MARKER}\nréponse`);
    const nameless = '<cross-session-message from="uds:/tmp/a.sock" from-mode="prompting">\nhello\n</cross-session-message>';
    receive(h, inbound(1, { content: autoReply }));
    receive(h, inbound(2, { content: nameless }));
    plugin.state("s1");
    await waitFor(() => plugin.delivers.length === 2, "two delivers");
    const [first, second] = plugin.delivers;
    expect("hint" in first!).toBe(false);
    expect(first!.sender).toBe("peer-a");
    expect("hint" in second!).toBe(false);
    expect(second!.sender).toBe("idnma");
  });

  test("a message that arrives before any hello waits in the queue and leaves once the bridge is up", async () => {
    const h = await startCourier();
    receive(h, inbound(1));
    const plugin = await admit(h);
    plugin.state("s1");
    await waitFor(() => plugin.delivers.length === 1, "deliver");
  });

  test("delivered is logged with the bus message id and the mode", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "delivered", id, mode: "followup", session: "s1" });
    await sync(plugin);
    expect(logged("dst-deliver")).toEqual([expect.objectContaining({ msgId: "m-1", delivery: "followup" })]);
  });

  test("claimed is logged", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "delivered", id, mode: "followup", session: "s1" });
    plugin.send({ type: "claimed", id, turn: 7 });
    await sync(plugin);
    expect(logged("dst-claimed")).toEqual([expect.objectContaining({ msgId: "m-1", turn: 7 })]);
  });

  test("a claimed steer is settled: nothing comes back, even when the bridge is lost afterwards", async () => {
    const h = await startCourier({ graceMs: 5_000 });
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "delivered", id, mode: "steer", session: "s1" });
    plugin.send({ type: "claimed", id, turn: 2 });
    await sync(plugin);
    plugin.close();
    await waitFor(() => logged("dst-bridge-lost").length === 1, "bridge lost");
    await settle(30);
    expect(h.replies()).toEqual([]);
  });

  test("a steer claimed before its delivered frame is settled too", async () => {
    const h = await startCourier({ graceMs: 5_000 });
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "claimed", id, turn: 2 });
    plugin.send({ type: "delivered", id, mode: "steer", session: "s1" });
    await sync(plugin);
    plugin.close();
    await waitFor(() => logged("dst-bridge-lost").length === 1, "bridge lost");
    await settle(30);
    expect(h.replies()).toEqual([]);
  });

  test("a result that arrives before its delivered frame is still answered", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "result", id, turn: 1, reason: "completed", mixed: false, sources: [], text: "tout de suite" });
    await waitFor(() => h.sent.length === 1, "reply");
    expect(h.replies()).toEqual(["tout de suite"]);
  });

  test("replies go to the sender address with the understudy name and mode", async () => {
    const h = await startCourier({ fromMode: "bypass" });
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "result", id, turn: 1, reason: "completed", mixed: false, sources: [], text: "ok" });
    await waitFor(() => h.sent.length === 1, "reply");
    expect(h.sent[0]).toMatchObject({ fromName: NAME, fromMode: "bypass", to: { address: ADDRESS } });
    expect(h.sent[0]!.body.startsWith(`${AUTO_REPLY_MARKER}\n`)).toBe(true);
  });
});

describe("result replies", () => {
  const cases: Array<{ title: string; frame: Record<string, unknown>; text: string; outcome: string }> = [
    { title: "a mixed turn", frame: { reason: "completed", mixed: true, text: "ignoré" }, text: `${NAME} : tour mêlé à une entrée de l'utilisateur, pas de réponse automatique`, outcome: "mixed" },
    { title: "a completed turn with text", frame: { reason: "completed", text: "Voici la réponse" }, text: "Voici la réponse", outcome: "replied" },
    { title: "a completed turn without text", frame: { reason: "completed" }, text: `${NAME} : tour terminé sans réponse`, outcome: "no-text" },
    { title: "a failed turn", frame: { reason: "error", error: { message: "boom", code: "E_BOOM" } }, text: `${NAME} : tour en échec (boom, E_BOOM)`, outcome: "failed" },
    { title: "a turn aborted by l'utilisateur", frame: { reason: "aborted", cause: "user" }, text: `${NAME} : tour interrompu par l'utilisateur`, outcome: "interrupted" },
    { title: "a turn aborted by a disposed session", frame: { reason: "aborted", cause: "disposed" }, text: `${NAME} : réponse perdue (session fermée dans dst)`, outcome: "lost" },
    { title: "a disposed turn", frame: { reason: "disposed" }, text: `${NAME} : réponse perdue (session fermée dans dst)`, outcome: "lost" },
    { title: "a turn aborted for another cause", frame: { reason: "aborted", cause: "timeout" }, text: `${NAME} : tour interrompu (timeout)`, outcome: "interrupted" },
    {
      title: "a truncated turn with text",
      frame: { reason: "max-tokens", text: "Début de réponse" },
      text: `Début de réponse\n(${NAME} : réponse tronquée, limite de tokens atteinte)`,
      outcome: "truncated",
    },
    { title: "a truncated turn without text", frame: { reason: "max-tokens" }, text: `${NAME} : tour coupé (limite de tokens atteinte)`, outcome: "truncated" },
    { title: "any other reason", frame: { reason: "refusal" }, text: `${NAME} : tour terminé sans réponse (refusal)`, outcome: "other" },
  ];
  for (const c of cases) {
    test(`answers ${c.title} and logs the outcome`, async () => {
      const h = await startCourier();
      const plugin = await admit(h);
      const id = await deliverFirst(h, plugin);
      plugin.send({ type: "delivered", id, mode: "followup", session: "s1" });
      plugin.send({ type: "claimed", id, turn: 3 });
      plugin.send({ type: "result", id, turn: 3, mixed: false, sources: ["user"], ...c.frame });
      await waitFor(() => h.sent.length === 1, "reply");
      expect(h.replies()).toEqual([c.text]);
      expect(logged("dst-turn-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: c.outcome, sources: ["user"] })]);
    });
  }

  test("answers a failed turn without message or code with the bare failure line", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "result", id, turn: 1, reason: "error", mixed: false, sources: [] });
    await waitFor(() => h.sent.length === 1, "reply");
    expect(h.replies()).toEqual([`${NAME} : tour en échec`]);
  });

  test("never answers a message that is itself an automatic reply, and logs the outcome as muted", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin, 1, { content: envelope(`${AUTO_REPLY_MARKER}\nune réponse`) });
    plugin.send({ type: "result", id, turn: 1, reason: "completed", mixed: false, sources: [], text: "merci" });
    await waitFor(() => logged("dst-turn-end").length === 1, "turn end");
    await settle(30);
    expect(h.sent).toEqual([]);
    expect(logged("dst-turn-end")[0]).toMatchObject({ msgId: "m-1", outcome: "muted" });
  });

  test("treats a result whose error carries unknown keys as a normal result", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "result", id, turn: 1, reason: "error", mixed: false, sources: [], error: { message: "boom", code: "E1", stack: "ignored", extra: 42 } });
    await waitFor(() => h.sent.length === 1, "reply");
    expect(h.replies()).toEqual([`${NAME} : tour en échec (boom, E1)`]);
  });

  test("ignores a result for an unknown id", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    await deliverFirst(h, plugin);
    plugin.send({ type: "result", id: "no-such-id", turn: 1, reason: "completed", mixed: false, sources: [], text: "x" });
    await sync(plugin);
    expect(h.sent).toEqual([]);
    expect(logged("dst-turn-end")).toEqual([]);
  });

  test("answers each message once: a second result for the same id is ignored", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    const frame = { type: "result", id, turn: 1, reason: "completed", mixed: false, sources: [], text: "une fois" };
    plugin.send(frame);
    plugin.send(frame);
    await sync(plugin);
    expect(h.replies()).toEqual(["une fois"]);
  });
});

describe("dropped messages", () => {
  test("a disposed message returns to the head of the queue and leaves again on the next state, even an unchanged one", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "dropped", id, why: "disposed" });
    plugin.state("s1");
    await waitFor(() => plugin.delivers.length === 2, "second deliver");
    expect(plugin.delivers[1]!.text).toBe(inbound(1).content);
    expect(plugin.delivers[1]!.id).not.toBe(id);
    expect(h.sent).toEqual([]);
    expect(logged("dst-dropped")).toEqual([expect.objectContaining({ msgId: "m-1", why: "disposed" })]);
  });

  test("keeps the original order of several messages dropped in a burst", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    receive(h, inbound(1));
    receive(h, inbound(2));
    receive(h, inbound(3));
    plugin.state("s1");
    await waitFor(() => plugin.delivers.length === 3, "three delivers");
    for (const frame of plugin.delivers) plugin.send({ type: "dropped", id: frame.id, why: "no-agent" });
    plugin.state("s1");
    await waitFor(() => plugin.delivers.length === 6, "three redelivers");
    expect(plugin.delivers.slice(3).map((frame) => frame.text)).toEqual([inbound(1).content, inbound(2).content, inbound(3).content]);
  });

  test("the third failure is answered as not taken by dst and the message is not sent again", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    let id = await deliverFirst(h, plugin);
    for (let attempt = 2; attempt <= 3; attempt++) {
      plugin.send({ type: "dropped", id, why: "disposed" });
      plugin.state("s1");
      await waitFor(() => plugin.delivers.length === attempt, `deliver ${attempt}`);
      id = plugin.delivers[attempt - 1]!.id;
    }
    plugin.send({ type: "dropped", id, why: "no-agent" });
    plugin.state("s1");
    await waitFor(() => h.sent.length === 1, "reply");
    await settle(30);
    expect(h.replies()).toEqual([`${NAME} : message non livré (dst ne l'a pas pris)`]);
    expect(plugin.delivers).toHaveLength(3);
    expect(h.queue.size).toBe(0);
  });

  test("maxAttempts is honoured", async () => {
    const h = await startCourier({ maxAttempts: 1 });
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "dropped", id, why: "disposed" });
    await waitFor(() => h.sent.length === 1, "reply");
    expect(h.replies()).toEqual([`${NAME} : message non livré (dst ne l'a pas pris)`]);
  });

  test("a discarded message is answered as dropped by the user's interruption", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "dropped", id, why: "discarded" });
    await waitFor(() => h.sent.length === 1, "reply");
    expect(h.replies()).toEqual([`${NAME} : message écarté (l'utilisateur a interrompu dst)`]);
    expect(logged("dst-dropped")).toEqual([expect.objectContaining({ msgId: "m-1", why: "discarded" })]);
    expect(logged("dst-turn-end")).toEqual([expect.objectContaining({ msgId: "m-1", outcome: "discarded", sources: [] })]);
  });

  test("a rejected message is answered with dsh's message, which never reaches the journal", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "dropped", id, why: "rejected", error: "kaboom-from-dsh" });
    await waitFor(() => h.sent.length === 1, "reply");
    expect(h.replies()).toEqual([`${NAME} : message non livré (dst l'a refusé : kaboom-from-dsh)`]);
    expect(logged("dst-dropped")).toEqual([expect.objectContaining({ msgId: "m-1", why: "rejected" })]);
    expect(logged("dst-turn-end")[0]).toMatchObject({ outcome: "rejected" });
    expect(rawLog()).not.toContain("kaboom-from-dsh");
  });

  test("a dropped message that opened as an automatic reply gets no answer", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin, 1, { content: envelope(`${AUTO_REPLY_MARKER}\nréponse`) });
    plugin.send({ type: "dropped", id, why: "discarded" });
    await waitFor(() => logged("dst-dropped").length === 1, "dropped logged");
    await settle(30);
    expect(h.sent).toEqual([]);
  });
});

describe("registry status and foreground", () => {
  test("publishes busy and idle only when the status changes", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    plugin.state("s1", "idle");
    plugin.state("s1", "running");
    plugin.state("s1", "running");
    plugin.state("s1", "idle");
    plugin.state("s1", "idle");
    plugin.state("s1", "running");
    await sync(plugin);
    expect(h.registration.statuses).toEqual(["busy", "idle", "busy"]);
  });

  test("logs dst-foreground when the foreground session changes, and only then", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    plugin.state("s1");
    plugin.state("s1", "running");
    plugin.state("s2");
    plugin.state(null);
    await sync(plugin);
    expect(logged("dst-foreground").map((line) => line.session)).toEqual(["s1", "s2", null]);
  });

  test("a plugin error frame is logged by its code", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    plugin.send({ type: "error", code: "listener-failed" });
    await waitFor(() => logged("dst-plugin-error").some((line) => line.code === "listener-failed"), "plugin error");
  });
});

describe("bridge loss", () => {
  test("answers the in-flight messages at once: claimed lost, unclaimed not delivered", async () => {
    const h = await startCourier({ graceMs: 5_000 });
    const plugin = await admit(h);
    receive(h, inbound(1));
    receive(h, inbound(2));
    plugin.state("s1", "running");
    await waitFor(() => plugin.delivers.length === 2, "two delivers");
    plugin.send({ type: "delivered", id: plugin.delivers[0]!.id, mode: "followup", session: "s1" });
    plugin.send({ type: "claimed", id: plugin.delivers[0]!.id, turn: 1 });
    await sync(plugin);
    expect(h.registration.statuses.at(-1)).toBe("busy");
    plugin.close();
    await waitFor(() => h.sent.length === 2, "two replies");
    expect(h.replies().sort()).toEqual([`${NAME} : message non livré (dst arrêté ou relancé)`, `${NAME} : réponse perdue (dst arrêté ou relancé)`].sort());
    expect(h.registration.statuses.at(-1)).toBe("idle");
    expect(logged("dst-bridge-lost")).toHaveLength(1);
  });

  test("keeps the queue during the grace window and delivers it after a new hello and a state", async () => {
    const h = await startCourier({ graceMs: 2_000 });
    const first = await admit(h);
    first.close();
    await waitFor(() => logged("dst-bridge-lost").length === 1, "bridge lost");
    receive(h, inbound(1));
    await settle(30);
    expect(h.sent).toEqual([]);
    expect(h.queue.size).toBe(1);

    const second = await admit(h);
    expect(logged("dst-bridge-up")[1]).toMatchObject({ reconnect: true });
    second.state("s9");
    await waitFor(() => second.delivers.length === 1, "deliver after reconnect");
    expect(h.queue.size).toBe(0);
    expect(logged("dst-bridge-gone")).toEqual([]);
  });

  test("after the grace window the phase is gone: the queue is refused and later messages are refused at once", async () => {
    const h = await startCourier({ graceMs: 80 });
    const plugin = await admit(h);
    plugin.close();
    await waitFor(() => logged("dst-bridge-lost").length === 1, "bridge lost");
    receive(h, inbound(1));
    await waitFor(() => logged("dst-bridge-gone").length === 1, "bridge gone");
    await waitFor(() => h.sent.length === 1, "queue refused");
    expect(h.replies()).toEqual([`${NAME} : message non livré (pont dst perdu)`]);
    expect(h.queue.size).toBe(0);

    receive(h, inbound(2));
    await waitFor(() => h.sent.length === 2, "later message refused");
    expect(h.replies()[1]).toBe(`${NAME} : message non livré (pont dst perdu)`);
    expect(h.queue.size).toBe(0);
  });

  test("a late hello restores delivery after the phase went gone", async () => {
    const h = await startCourier({ graceMs: 60 });
    const first = await admit(h);
    first.close();
    await waitFor(() => logged("dst-bridge-gone").length === 1, "bridge gone");
    const second = await admit(h);
    second.state("s1");
    await sync(second);
    receive(h, inbound(1));
    await waitFor(() => second.delivers.length === 1, "deliver after late hello");
    expect(h.sent).toEqual([]);
  });

  test("a second admitted hello replaces the first: old connection closed, its sends lost, mirror reset", async () => {
    const h = await startCourier({ graceMs: 5_000 });
    const first = await admit(h);
    const id = await deliverFirst(h, first);
    first.send({ type: "delivered", id, mode: "followup", session: "s1" });
    first.send({ type: "claimed", id, turn: 1 });
    await sync(first);

    const second = await admit(h);
    await waitFor(() => first.closed, "old connection closed");
    await waitFor(() => h.sent.length === 1, "lost reply");
    expect(h.replies()).toEqual([`${NAME} : réponse perdue (dst arrêté ou relancé)`]);

    // Miroir remis à zéro : sans nouvelle `state`, rien ne part.
    receive(h, inbound(2));
    await settle(40);
    expect(second.delivers).toEqual([]);
    second.state("s1");
    await waitFor(() => second.delivers.length === 1, "deliver after state");
  });

  test("the replaced connection no longer counts: its late frames are ignored", async () => {
    const h = await startCourier({ graceMs: 5_000 });
    const first = await admit(h);
    const second = await admit(h);
    first.state("old");
    await settle(30);
    second.state("new");
    await sync(second);
    expect(logged("dst-foreground").map((line) => line.session)).toEqual(["new"]);
  });
});

describe("missing plugin", () => {
  test("without any hello after afterSpawn, the phase is gone and the queue is refused", async () => {
    const h = await startCourier({ helloTimeoutMs: 80 });
    receive(h, inbound(1));
    h.courier.afterSpawn();
    await waitFor(() => logged("dst-bridge-missing").length === 1, "bridge missing");
    await waitFor(() => h.sent.length === 1, "queue refused");
    expect(h.replies()).toEqual([`${NAME} : message non livré (le plugin idnma ne s'est pas chargé dans dst)`]);
    receive(h, inbound(2));
    await waitFor(() => h.sent.length === 2, "later refused");
    expect(h.replies()[1]).toBe(`${NAME} : message non livré (le plugin idnma ne s'est pas chargé dans dst)`);
  });

  test("the wait is armed by afterSpawn, not before", async () => {
    const h = await startCourier({ helloTimeoutMs: 40 });
    receive(h, inbound(1));
    await settle(120);
    expect(logged("dst-bridge-missing")).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test("a hello admitted in time cancels the wait", async () => {
    const h = await startCourier({ helloTimeoutMs: 80 });
    h.courier.afterSpawn();
    await admit(h);
    await settle(150);
    expect(logged("dst-bridge-missing")).toEqual([]);
  });

  test("when a hello was refused in the meantime, the refusal says so", async () => {
    const h = await startCourier({ helloTimeoutMs: 100 });
    receive(h, inbound(1));
    h.courier.afterSpawn();
    const plugin = await connect(h);
    plugin.hello({ token: "wrong-token-test" });
    await waitFor(() => logged("dst-bridge-missing").length === 1, "bridge missing");
    await waitFor(() => h.sent.length === 1, "queue refused");
    expect(h.replies()).toEqual([`${NAME} : message non livré (pont dst refusé, voir le journal idnma)`]);
  });

  test("a late hello after the missing verdict restores delivery", async () => {
    const h = await startCourier({ helloTimeoutMs: 40 });
    h.courier.afterSpawn();
    await waitFor(() => logged("dst-bridge-missing").length === 1, "bridge missing");
    const plugin = await admit(h);
    plugin.state("s1");
    await sync(plugin);
    receive(h, inbound(1));
    await waitFor(() => plugin.delivers.length === 1, "deliver");
  });
});

describe("invalid frames", () => {
  test("logs only the length of an unreadable frame, never its content, and keeps the connection", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    const garbage = "{not json: top-secret-content";
    plugin.sendRaw(`${garbage}\n`);
    plugin.send({ type: "state", session: 42 });
    plugin.send({ type: "mystery" });
    await sync(plugin);
    const lines = logged("dst-frame-invalid");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual(expect.objectContaining({ length: garbage.length }));
    expect(Object.keys(lines[0]!).sort()).toEqual(["event", "length", "ts"]);
    expect(rawLog()).not.toContain("top-secret-content");
    expect(plugin.closed).toBe(false);
    plugin.state("s1");
    await sync(plugin);
    expect(logged("dst-foreground")).toHaveLength(1);
  });

  test("closes the connection on a line over the frame limit", async () => {
    const h = await startCourier({ graceMs: 5_000 });
    const plugin = await admit(h);
    plugin.sendRaw("x".repeat(8 * 1024 * 1024 + 16));
    await waitFor(() => plugin.closed, "connection closed", 5000);
    await waitFor(() => logged("dst-bridge-lost").length === 1, "bridge lost");
  });
});

describe("stop and farewell", () => {
  test("stop removes the socket and closes the connection, and is idempotent", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    expect(existsSync(h.socketPath)).toBe(true);
    h.courier.stop();
    expect(existsSync(h.socketPath)).toBe(false);
    await waitFor(() => plugin.closed, "connection closed");
    expect(() => h.courier.stop()).not.toThrow();
  });

  test("stop keeps the queue and sends no reply by itself", async () => {
    const h = await startCourier({ graceMs: 50 });
    const plugin = await admit(h);
    await deliverFirst(h, plugin);
    receive(h, inbound(2));
    h.courier.stop();
    await waitFor(() => plugin.closed, "connection closed");
    await settle(100);
    expect(h.sent).toEqual([]);
    expect(logged("dst-bridge-gone")).toEqual([]);
  });

  test("farewell after stop answers the in-flight sends with the loss texts and refuses the queue", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    receive(h, inbound(1));
    receive(h, inbound(2));
    plugin.state("s1");
    await waitFor(() => plugin.delivers.length === 2, "two delivers");
    plugin.send({ type: "claimed", id: plugin.delivers[0]!.id, turn: 1 });
    await sync(plugin);
    // Un troisième message reste en file : le premier plan vient de disparaître.
    plugin.state(null);
    await sync(plugin);
    receive(h, inbound(3));
    expect(h.queue.size).toBe(1);

    h.courier.stop();
    await h.courier.farewell!();
    expect(h.replies().sort()).toEqual(
      [
        `${NAME} : réponse perdue (dst arrêté ou relancé)`,
        `${NAME} : message non livré (dst arrêté ou relancé)`,
        `${NAME} : message non livré (dst a quitté le bus)`,
      ].sort(),
    );
    expect(h.queue.size).toBe(0);
  });

  test("a message that arrives after farewell is refused at once", async () => {
    const h = await startCourier();
    await h.courier.farewell!();
    receive(h, inbound(1));
    await waitFor(() => h.sent.length === 1, "refused");
    expect(h.replies()).toEqual([`${NAME} : message non livré (dst a quitté le bus)`]);
    expect(h.queue.size).toBe(0);
  });

  test("farewell is idempotent and never rejects", async () => {
    const h = await startCourier();
    await h.courier.farewell!();
    await h.courier.farewell!();
    expect(h.sent).toEqual([]);
  });

  test("farewell works without a prior stop and closes the bridge", async () => {
    const h = await startCourier();
    const plugin = await admit(h);
    await deliverFirst(h, plugin);
    await h.courier.farewell!();
    await waitFor(() => plugin.closed, "connection closed");
    expect(existsSync(h.socketPath)).toBe(false);
    expect(h.replies()).toEqual([`${NAME} : message non livré (dst arrêté ou relancé)`]);
  });
});

describe("farewell and replies still in flight", () => {
  const completedTexts = (h: Harness): string[] => h.completed.map((s) => s.body.slice(AUTO_REPLY_MARKER.length + 1));

  test("farewell right after a bridge loss waits until the loss reply has completed", async () => {
    const h = await startCourier({ sendDelayMs: 150, graceMs: 60_000 });
    const plugin = await admit(h);
    await deliverFirst(h, plugin);
    plugin.close();
    await waitFor(() => logged("dst-bridge-lost").length === 1, "bridge lost");
    await h.courier.farewell!();
    expect(completedTexts(h)).toEqual([`${NAME} : message non livré (dst arrêté ou relancé)`]);
  });

  test("farewell waits for the loss reply of a plugin replaced by a new connection", async () => {
    const h = await startCourier({ sendDelayMs: 150, graceMs: 60_000 });
    const first = await admit(h);
    await deliverFirst(h, first);
    await admit(h);
    await h.courier.farewell!();
    expect(completedTexts(h)).toEqual([`${NAME} : message non livré (dst arrêté ou relancé)`]);
  });

  test("farewell waits for a result reply still in flight", async () => {
    const h = await startCourier({ sendDelayMs: 150 });
    const plugin = await admit(h);
    const id = await deliverFirst(h, plugin);
    plugin.send({ type: "claimed", id, turn: 1 });
    plugin.send({ type: "result", id, turn: 1, reason: "completed", mixed: false, sources: [], text: "done" });
    await sync(plugin);
    await h.courier.farewell!();
    expect(h.completed).toHaveLength(1);
    expect(completedTexts(h)[0]).toContain("done");
  });

  test("farewell waits for the refusals of a queue turned away when the grace window ends", async () => {
    const h = await startCourier({ sendDelayMs: 150, graceMs: 20 });
    const plugin = await admit(h);
    plugin.close();
    await waitFor(() => logged("dst-bridge-lost").length === 1, "bridge lost");
    receive(h, inbound(1));
    await waitFor(() => logged("dst-bridge-gone").length === 1, "bridge gone");
    await h.courier.farewell!();
    expect(completedTexts(h)).toEqual([`${NAME} : message non livré (pont dst perdu)`]);
  });

  test("a reply that never settles keeps farewell pending (the bound belongs to the caller) and never throws", async () => {
    const h = await startCourier({ sendDelayMs: Infinity, graceMs: 60_000 });
    const plugin = await admit(h);
    await deliverFirst(h, plugin);
    plugin.close();
    await waitFor(() => logged("dst-bridge-lost").length === 1, "bridge lost");
    let settled = false;
    void h.courier.farewell!().then(() => {
      settled = true;
    });
    await settle(200);
    // Le livreur attend ce renvoi ; la borne est celle de `runUnderstudy` (`farewellWaitMs`).
    expect(settled).toBe(false);
    expect(h.sent).toHaveLength(1);
  });
});

describe("unused channels", () => {
  test("read returns null, hook returns an empty object, verifyCaller refuses", async () => {
    const h = makeCourier();
    expect(h.courier.read()).toBeNull();
    expect(await h.courier.hook("grok", "Stop", {})).toEqual({});
    expect(await h.courier.verifyCaller({ codexThreadId: "x" }, 1)).toBe(false);
  });
});
