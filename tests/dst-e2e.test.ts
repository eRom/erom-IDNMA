import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEnvelope } from "../src/bus/envelope.ts";
import type { InboundMessage } from "../src/bus/inbox.ts";
import type { sendPeerMessage } from "../src/bus/send.ts";
import { createBridgeCourier } from "../src/bridge/courier.ts";
import { apply } from "../src/dst/plugin.ts";
import { AUTO_REPLY_MARKER, type Courier } from "../src/understudy/courier.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import { createFakeAgent, createFakeDsh, type FakeAgent, type FakeCtx, type FakeMessage } from "./helpers/fake-dsh.ts";
import { fakeRegistration } from "./helpers/fake-registration.ts";

// Bout en bout : le vrai livreur (createDstCourier) et le vrai plugin (apply) parlent par un vrai
// socket Unix ; seuls dsh (faux ctx) et l'envoi des renvois (`send` injecté) sont factices.

const TOKEN = "bridge-token-test";

let dir: string;
let savedConfigDir: string | undefined;
let courier: Courier | undefined;
let ctx: FakeCtx | undefined;

beforeEach(() => {
  savedConfigDir = process.env.IDNMA_CONFIG_DIR;
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = join(dir, "config");
});

afterEach(() => {
  ctx?.dispose();
  courier?.stop();
  ctx = undefined;
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

/** Le pont est admis quand la doublure a journalisé `dst-bridge-up` (hello du plugin accepté). */
function bridgeIsUp(): boolean {
  const path = join(process.env.IDNMA_CONFIG_DIR!, "logs", "idnma.log");
  return existsSync(path) && readFileSync(path, "utf8").includes('"event":"dst-bridge-up"');
}

type SentReply =Parameters<typeof sendPeerMessage>[0];

interface Rig {
  dsh: FakeCtx;
  queue: MessageQueue;
  registration: ReturnType<typeof fakeRegistration>;
  sent: SentReply[];
  /** Livraison d'un message de pair, comme le fait le serveur d'entrée d'idnma. */
  push(body: string, n: number): void;
  /** Texte des renvois, marque de renvoi automatique retirée. */
  replies(): string[];
  /** Comme dsh : un followup au repos ouvre un tour, de façon synchrone (status, turn/start, claimed). */
  wire(agent: FakeAgent): void;
  /** Fin de tour d'un agent, comme dsh (réponse, turn/end, retour au repos). */
  endTurn(agent: FakeAgent, text: string): void;
}

async function startRig(agent: FakeAgent): Promise<Rig> {
  const socketDir = join(dir, "s");
  mkdirSync(socketDir, { mode: 0o700 });
  chmodSync(socketDir, 0o700);
  const socketPath = join(socketDir, "b.sock");
  const queue = new MessageQueue();
  const registration = fakeRegistration();
  const sent: SentReply[] = [];
  courier = createBridgeCourier({
    harness: "dst",
    name: "dst-e2e",
    fromMode: "bypass",
    registration,
    queue,
    socketPath,
    token: TOKEN,
    send: (async (a: SentReply) => {
      sent.push(a);
      return { msgId: "reply-id", target: {} };
    }) as unknown as typeof sendPeerMessage,
  });
  await courier.beforeSpawn();
  courier.afterSpawn();

  const dsh = createFakeDsh();
  ctx = dsh;
  dsh.agents.add(agent);
  // Un fichier absent du dossier de test : jamais le vrai ~/.dsh-tui.
  const serversFile = join(dir, "servers.json");
  writeFileSync(serversFile, "[]");

  let turnNumber = 0;
  const turnOf = new Map<string, number>();
  const rig: Rig = {
    dsh,
    queue,
    registration,
    sent,
    push(body, n) {
      const from = `uds:/tmp/peer-${n}.sock`;
      const message: InboundMessage = {
        msgId: `m${n}`,
        from,
        priority: "next",
        content: buildEnvelope({ from, fromName: `claude-p${n}`, fromMode: "bypass", body }),
        authenticated: true,
        receivedAt: n,
      };
      queue.push(message);
      courier!.onMessage();
    },
    replies: () => sent.map((s) => s.body.slice(AUTO_REPLY_MARKER.length + 1)),
    wire(target) {
      target.onCall = (call) => {
        if (call.mode !== "followup") return;
        if (target.status !== "idle") {
          target.inbox.nextTurn.push(call.message);
          return;
        }
        const message: FakeMessage = call.message;
        target.status = "running";
        dsh.emit("agent/status", { agent: target, status: "running" });
        turnNumber += 1;
        turnOf.set(target.id, turnNumber);
        target.inbox.nextTurn.push(message);
        dsh.emit("session/event", target.session, { type: "turn/start", data: { turn: turnNumber } });
        target.inbox.nextTurn.shift();
        dsh.emit("agent/inbox/claimed", { agent: target, message, turn: turnNumber });
      };
    },
    endTurn(target, text) {
      const turn = turnOf.get(target.id)!;
      dsh.emit("session/event", target.session, { type: "assistant/message", data: { turn, message: { content: [{ type: "text", text: `⏵ Answering the team message\n\n${text}` }] } } });
      dsh.emit("session/event", target.session, { type: "turn/end", data: { turn, reason: { kind: "completed" } } });
      target.status = "idle";
      dsh.emit("agent/status", { agent: target, status: "idle" });
    },
  };
  rig.wire(agent);
  apply(dsh, { env: { IDNMA_DST_BRIDGE: socketPath, IDNMA_DST_BRIDGE_TOKEN: TOKEN }, pid: process.pid, serversFile, refreshMs: 600_000, discardGraceMs: 50 });
  await waitFor(() => bridgeIsUp(), "bridge admitted");
  return rig;
}

describe("dst bridge end to end (real courier, real plugin, real socket)", () => {
  test("a peer turn at rest answers the sender with the text of the turn, without the step line", async () => {
    const agent = createFakeAgent("a1");
    const r = await startRig(agent);
    r.push("capitale du Portugal ?", 1);
    await waitFor(() => agent.calls.length === 1, "followup delivered");
    expect(agent.calls[0]?.mode).toBe("followup");
    r.endTurn(agent, "Lisbonne");
    await waitFor(() => r.sent.length === 1, "reply sent");
    expect(r.replies()).toEqual(["Lisbonne"]);
    expect(r.sent[0]?.body).not.toContain("⏵");
    expect(r.sent[0]?.to).toEqual({ address: "uds:/tmp/peer-1.sock" });
  });

  test("an agent disposed with a followup still in its inbox: the message is redelivered to the new root and answered", async () => {
    const first = createFakeAgent("a1");
    const r = await startRig(first);
    // Un tour de l'utilisateur occupe a1 : le message du pair attend dans sa file.
    first.status = "running";
    r.dsh.emit("agent/status", { agent: first, status: "running" });
    r.push("deuxième question", 2);
    await waitFor(() => first.calls.length === 1, "followup queued in a1");
    expect(first.inbox.nextTurn).toHaveLength(1);

    const second = createFakeAgent("a2");
    r.wire(second);
    r.dsh.agents.add(second);
    r.dsh.emit("agent/created", { agent: second, source: "startup" });
    r.dsh.agents.remove("a1");
    r.dsh.emit("agent/disposed", { agent: first });
    await waitFor(() => second.calls.length === 1, "redelivered to the new root");
    r.endTurn(second, "OK-C");
    await waitFor(() => r.sent.length === 1, "reply sent");
    expect(r.replies()).toEqual(["OK-C"]);
    expect(r.sent[0]?.to).toEqual({ address: "uds:/tmp/peer-2.sock" });
  });

  test("farewell with a claimed followup in flight answers the sender that the reply is lost", async () => {
    const agent = createFakeAgent("a1");
    const r = await startRig(agent);
    r.push("troisième question", 3);
    await waitFor(() => agent.calls.length === 1, "followup delivered and claimed");
    // Laisse le plugin écrire `claimed` jusqu'à la doublure avant l'arrêt.
    await Bun.sleep(50);
    await courier!.farewell!();
    expect(r.replies()).toEqual(["dst-e2e : réponse perdue (dst arrêté ou relancé)"]);
    expect(r.sent[0]?.to).toEqual({ address: "uds:/tmp/peer-3.sock" });
  });
});
