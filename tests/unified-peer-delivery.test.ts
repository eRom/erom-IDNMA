import { describe, expect, test } from "bun:test";
import { addressOf, buildEnvelope, type FromMode } from "../src/bus/envelope.ts";
import type { InboundMessage } from "../src/bus/inbox.ts";
import type { sendPeerMessage } from "../src/bus/send.ts";
import { AUTO_REPLY_MARKER } from "../src/understudy/courier.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import { createPeerDelivery, envelopeBody, peerPrompt, type PeerDelivery } from "../src/unified/peer-delivery.ts";
import { fakeRegistration } from "./helpers/fake-registration.ts";

type SendArgs = Parameters<typeof sendPeerMessage>[0];

let counter = 0;

/** Message de pair : la vraie forme d'enveloppe du bus, `from` est l'adresse de réponse. */
function peerMessage(body: string, fromName = "codex-a", socket = "/tmp/a.sock"): InboundMessage {
  counter++;
  const content = buildEnvelope({ from: addressOf(socket), fromName, fromMode: "bypass", body });
  return { msgId: `m${counter}`, from: addressOf(socket), priority: "next", content, authenticated: true, receivedAt: counter };
}

interface Harness {
  delivery: PeerDelivery;
  queue: MessageQueue;
  sent: SendArgs[];
  turns: Array<{ prompt: string; display: { from: string; text: string } }>;
  held: Array<{ message: { from: string; text: string }; queued: number }>;
  counts: number[];
  state: { idle: boolean; mode: FromMode };
  modeReads: () => number;
}

function setup(rule: "auto" | "held", options: { failSend?: boolean } = {}): Harness {
  const queue = new MessageQueue();
  const sent: SendArgs[] = [];
  const turns: Harness["turns"] = [];
  const held: Harness["held"] = [];
  const counts: number[] = [];
  const state = { idle: true, mode: "bypass" as FromMode };
  let reads = 0;
  const send = (async (a: SendArgs) => {
    sent.push(a);
    if (options.failSend === true) throw new Error("pair injoignable");
    return { msgId: "x", target: {} };
  }) as unknown as typeof sendPeerMessage;
  const delivery = createPeerDelivery({
    rule,
    name: "claude-test",
    label: rule === "auto" ? "Claude" : "agy",
    queue,
    registration: fakeRegistration(),
    fromMode: () => {
      reads++;
      return state.mode;
    },
    isIdle: () => state.idle,
    startPeerTurn: (prompt, display) => turns.push({ prompt, display }),
    showHeld: (message, queued) => held.push({ message, queued }),
    heldCountChanged: (queued) => counts.push(queued),
    send,
  });
  return { delivery, queue, sent, turns, held, counts, state, modeReads: () => reads };
}

/** Pousse un message dans la file puis prévient la livraison, comme le fera le runner. */
function arrive(h: Harness, message: InboundMessage): void {
  h.queue.push(message);
  h.delivery.onMessage();
}

describe("envelopeBody", () => {
  test("returns the body between the first line and the closing tag", () => {
    const content = buildEnvelope({ from: addressOf("/tmp/a.sock"), fromName: "codex-a", fromMode: "bypass", body: "ligne 1\nligne 2" });
    expect(envelopeBody(content)).toBe("ligne 1\nligne 2");
  });

  test("returns an empty body for an empty envelope", () => {
    const content = buildEnvelope({ from: addressOf("/tmp/a.sock"), fromName: "codex-a", fromMode: "bypass", body: "" });
    expect(envelopeBody(content)).toBe("");
  });

  test("returns any other content unchanged", () => {
    for (const content of ["bonjour", "<env>urgent</env>", '<cross-session-message from="x">\nsans balise fermante', ""]) {
      expect(envelopeBody(content)).toBe(content);
    }
  });
});

describe("peerPrompt", () => {
  test("states the automatic return of the final answer, then the body", () => {
    expect(peerPrompt("codex-a", "fais X", false)).toBe("[idnma] Message from codex-a. Your final answer is sent back to codex-a automatically; do not send it yourself.\nfais X");
  });

  test("states that no answer is expected for an automatic reply", () => {
    expect(peerPrompt("codex-a", "fait", true)).toBe("[idnma] Automatic reply from codex-a. No answer is expected.\nfait");
  });
});

describe("auto rule", () => {
  test("a message at rest opens a peer turn and the final answer goes back", async () => {
    const h = setup("auto");
    const message = peerMessage("fais X");
    arrive(h, message);
    expect(h.turns).toEqual([{ prompt: peerPrompt("codex-a", "fais X", false), display: { from: "codex-a", text: "fais X" } }]);
    expect(h.queue.size).toBe(0);
    expect(h.counts).toEqual([]);
    expect(h.held).toEqual([]);
    h.delivery.onTurnText("a");
    h.delivery.onTurnTool();
    h.delivery.onTurnText("final");
    await h.delivery.onTurnEnded("end_turn");
    expect(h.sent.length).toBe(1);
    const reply = h.sent[0]!;
    expect(reply.body.startsWith(AUTO_REPLY_MARKER)).toBe(true);
    expect(reply.body).toContain("final");
    expect(reply.body).not.toContain("a\n");
    expect(reply.body).toBe(`${AUTO_REPLY_MARKER}\nfinal`);
    expect(reply.to).toEqual({ address: message.from! });
    expect(reply.fromName).toBe("claude-test");
  });

  test("never delivers during a turn", () => {
    const h = setup("auto");
    h.state.idle = false;
    arrive(h, peerMessage("fais X"));
    expect(h.turns).toEqual([]);
    expect(h.queue.size).toBe(1);
    h.state.idle = true;
    h.delivery.onIdle();
    expect(h.turns.length).toBe(1);
    expect(h.queue.size).toBe(0);
  });

  test("delivers one message per idle, oldest first", () => {
    const h = setup("auto");
    h.state.idle = false;
    arrive(h, peerMessage("premier"));
    arrive(h, peerMessage("second"));
    h.state.idle = true;
    h.delivery.onIdle();
    expect(h.turns.map((t) => t.display.text)).toEqual(["premier"]);
    h.state.idle = false;
    h.delivery.onIdle();
    expect(h.turns.length).toBe(1);
    h.state.idle = true;
    h.delivery.onIdle();
    // Le tour du premier n'est pas fini : le second attend.
    expect(h.turns.length).toBe(1);
  });

  test("an automatic reply is delivered without sending anything back", async () => {
    const h = setup("auto");
    arrive(h, peerMessage(`${AUTO_REPLY_MARKER}\nla réponse`));
    expect(h.turns[0]?.prompt).toBe(peerPrompt("codex-a", `${AUTO_REPLY_MARKER}\nla réponse`, true));
    h.delivery.onTurnText("ok, noté");
    await h.delivery.onTurnEnded("end_turn");
    await h.delivery.agentLost();
    await h.delivery.leave();
    expect(h.sent).toEqual([]);
  });

  test("a sender without a readable name is shown as unknown peer", () => {
    const h = setup("auto");
    arrive(h, peerMessage("fais X", "nom invalide;"));
    expect(h.turns[0]?.display.from).toBe("unknown peer");
    expect(h.turns[0]?.prompt.startsWith("[idnma] Message from unknown peer.")).toBe(true);
  });

  test("a cancelled peer turn tells the sender it was interrupted", async () => {
    const h = setup("auto");
    arrive(h, peerMessage("fais X"));
    h.delivery.onTurnText("début de réponse");
    await h.delivery.onTurnEnded("cancelled");
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_MARKER}\nclaude-test : tour interrompu`);
  });

  test("falls back to the whole turn text, then to a no-answer line", async () => {
    const h = setup("auto");
    arrive(h, peerMessage("premier"));
    h.delivery.onTurnText("analyse");
    h.delivery.onTurnTool();
    h.delivery.onTurnText("  \n");
    await h.delivery.onTurnEnded("end_turn");
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_MARKER}\nanalyse`);
    h.delivery.onIdle();
    arrive(h, peerMessage("second"));
    h.delivery.onTurnTool();
    await h.delivery.onTurnEnded("end_turn");
    expect(h.sent[1]?.body).toBe(`${AUTO_REPLY_MARKER}\nclaude-test : tour terminé sans réponse`);
  });

  test("ignores turn text and sends nothing at the end of a turn that is not a peer turn", async () => {
    const h = setup("auto");
    h.delivery.onTurnText("réponse à Romain");
    h.delivery.onTurnTool();
    await h.delivery.onTurnEnded("end_turn");
    await h.delivery.agentLost();
    expect(h.sent).toEqual([]);
    arrive(h, peerMessage("fais X"));
    h.delivery.onTurnText("pour le pair");
    await h.delivery.onTurnEnded("end_turn");
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_MARKER}\npour le pair`);
  });

  test("the peer turn is closed by its end: the next message is delivered at the next idle", async () => {
    const h = setup("auto");
    arrive(h, peerMessage("premier"));
    arrive(h, peerMessage("second"));
    expect(h.turns.length).toBe(1);
    h.delivery.onTurnText("r1");
    await h.delivery.onTurnEnded("end_turn");
    h.delivery.onIdle();
    expect(h.turns.map((t) => t.display.text)).toEqual(["premier", "second"]);
  });

  test("re-reads the from-mode at every send", async () => {
    const h = setup("auto");
    arrive(h, peerMessage("premier"));
    h.delivery.onTurnText("r1");
    h.state.mode = "prompting";
    await h.delivery.onTurnEnded("end_turn");
    h.delivery.onIdle();
    arrive(h, peerMessage("second"));
    h.delivery.onTurnText("r2");
    h.state.mode = "bypass";
    await h.delivery.onTurnEnded("end_turn");
    expect(h.sent.map((s) => s.fromMode)).toEqual(["prompting", "bypass"]);
    expect(h.modeReads()).toBe(2);
  });

  test("agentLost answers the sender of the open turn that the answer was lost", async () => {
    const h = setup("auto");
    arrive(h, peerMessage("fais X"));
    await h.delivery.agentLost();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_MARKER}\nclaude-test : réponse perdue (agent arrêté)`);
    // Le tour est clos : sa fin tardive n'envoie rien de plus.
    await h.delivery.onTurnEnded("end_turn");
    expect(h.sent.length).toBe(1);
  });

  test("leave answers the open turn and every queued sender, then rejects late arrivals", async () => {
    const h = setup("auto");
    arrive(h, peerMessage("premier", "codex-a", "/tmp/a.sock"));
    h.state.idle = false;
    arrive(h, peerMessage("second", "codex-b", "/tmp/b.sock"));
    await h.delivery.leave();
    const bodies = h.sent.map((s) => s.body);
    expect(bodies).toContain(`${AUTO_REPLY_MARKER}\nclaude-test : réponse perdue (agent arrêté)`);
    expect(bodies).toContain(`${AUTO_REPLY_MARKER}\nclaude-test : message non livré (Claude a quitté le bus)`);
    expect(h.sent.length).toBe(2);
    expect(h.queue.size).toBe(0);
    h.state.idle = true;
    arrive(h, peerMessage("tard", "codex-c", "/tmp/c.sock"));
    // Rejet attendu en tâche de fond : on laisse la boucle d'événements le terminer.
    await Bun.sleep(10);
    expect(h.sent.length).toBe(3);
    expect(h.sent[2]?.to).toEqual({ address: addressOf("/tmp/c.sock") });
    expect(h.turns.length).toBe(1);
    h.delivery.onIdle();
    expect(h.turns.length).toBe(1);
  });

  test("never calls the held callbacks", async () => {
    const h = setup("auto");
    arrive(h, peerMessage("fais X"));
    await h.delivery.leave();
    expect(h.held).toEqual([]);
    expect(h.counts).toEqual([]);
  });

  test("never throws when the send fails", async () => {
    const h = setup("auto", { failSend: true });
    arrive(h, peerMessage("fais X"));
    h.delivery.onTurnText("final");
    await h.delivery.onTurnEnded("end_turn");
    arrive(h, peerMessage("autre"));
    await h.delivery.agentLost();
    await h.delivery.leave();
    expect(h.sent.length).toBeGreaterThanOrEqual(2);
  });
});

describe("held rule", () => {
  test("held never prompts before Deliver", () => {
    const h = setup("held");
    const message = peerMessage("fais X");
    arrive(h, message);
    expect(h.turns).toEqual([]);
    expect(h.held).toEqual([{ message: { from: "codex-a", text: "fais X" }, queued: 1 }]);
    h.delivery.onIdle();
    expect(h.turns).toEqual([]);
    expect(h.queue.size).toBe(1);
    h.delivery.deliverHeld();
    expect(h.turns).toEqual([{ prompt: peerPrompt("codex-a", "fais X", false), display: { from: "codex-a", text: "fais X" } }]);
    expect(h.queue.size).toBe(0);
    expect(h.counts.at(-1)).toBe(0);
  });

  test("Deliver during a running turn does nothing, the message stays on screen until a Deliver at rest", () => {
    const h = setup("held");
    arrive(h, peerMessage("fais X"));
    expect(h.held.length).toBe(1);
    // Romain soumet un prompt pendant que la carte est affichée : l'écran n'est plus au repos.
    h.state.idle = false;
    h.delivery.deliverHeld();
    expect(h.turns).toEqual([]);
    expect(h.queue.size).toBe(1);
    h.state.idle = true;
    h.delivery.onIdle();
    // Le message est toujours celui à l'écran : pas de seconde présentation.
    expect(h.held.length).toBe(1);
    h.delivery.deliverHeld();
    expect(h.turns).toEqual([{ prompt: peerPrompt("codex-a", "fais X", false), display: { from: "codex-a", text: "fais X" } }]);
    expect(h.queue.size).toBe(0);
  });

  test("Later keeps the message queued and suspends presentation until reopen", () => {
    const h = setup("held");
    arrive(h, peerMessage("premier"));
    expect(h.held.length).toBe(1);
    h.delivery.laterHeld();
    expect(h.queue.size).toBe(1);
    h.delivery.onIdle();
    expect(h.held.length).toBe(1);
    h.counts.length = 0;
    arrive(h, peerMessage("second"));
    expect(h.counts).toEqual([2]);
    expect(h.held.length).toBe(1);
    h.delivery.reopenHeld();
    expect(h.held.length).toBe(2);
    expect(h.held[1]).toEqual({ message: { from: "codex-a", text: "premier" }, queued: 2 });
  });

  test("reopen during a turn lifts the suspension without presenting", () => {
    const h = setup("held");
    arrive(h, peerMessage("premier"));
    h.delivery.laterHeld();
    h.state.idle = false;
    h.delivery.reopenHeld();
    expect(h.held.length).toBe(1);
    h.state.idle = true;
    h.delivery.onIdle();
    expect(h.held.length).toBe(2);
  });

  test("Dismiss sends message non livré, then presents the next one", async () => {
    const h = setup("held");
    const first = peerMessage("premier", "codex-a", "/tmp/a.sock");
    arrive(h, first);
    arrive(h, peerMessage("second", "codex-b", "/tmp/b.sock"));
    await h.delivery.dismissHeld();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]?.body).toBe(`${AUTO_REPLY_MARKER}\nclaude-test : message non livré (écarté dans l'écran)`);
    expect(h.sent[0]?.to).toEqual({ address: first.from! });
    expect(h.queue.size).toBe(1);
    expect(h.held.at(-1)).toEqual({ message: { from: "codex-b", text: "second" }, queued: 1 });
    expect(h.counts.at(-1)).toBe(1);
  });

  test("Deliver, Later and Dismiss without a message on screen do nothing", async () => {
    const h = setup("held");
    h.delivery.deliverHeld();
    h.delivery.laterHeld();
    await h.delivery.dismissHeld();
    expect(h.turns).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.counts).toEqual([]);
    expect(h.held).toEqual([]);
  });

  test("the held counter moves during a turn", () => {
    const h = setup("held");
    h.state.idle = false;
    arrive(h, peerMessage("premier"));
    arrive(h, peerMessage("second"));
    expect(h.counts).toEqual([1, 2]);
    expect(h.held).toEqual([]);
  });

  test("a message arriving while one is on screen only raises the counter", () => {
    const h = setup("held");
    arrive(h, peerMessage("premier"));
    arrive(h, peerMessage("second"));
    expect(h.held.length).toBe(1);
    expect(h.counts.at(-1)).toBe(2);
  });

  test("nothing is presented while the peer turn is open, then the next one comes at rest", async () => {
    const h = setup("held");
    arrive(h, peerMessage("premier"));
    arrive(h, peerMessage("second"));
    h.delivery.deliverHeld();
    h.delivery.onIdle();
    expect(h.held.length).toBe(1);
    h.delivery.onTurnText("r1");
    await h.delivery.onTurnEnded("end_turn");
    h.delivery.onIdle();
    expect(h.held.length).toBe(2);
    expect(h.held[1]?.message.text).toBe("second");
  });

  test("an automatic reply held on screen is delivered without sending anything back", async () => {
    const h = setup("held");
    arrive(h, peerMessage(`${AUTO_REPLY_MARKER}\nfait`));
    h.delivery.deliverHeld();
    expect(h.turns[0]?.prompt.startsWith("[idnma] Automatic reply from codex-a.")).toBe(true);
    await h.delivery.onTurnEnded("end_turn");
    expect(h.sent).toEqual([]);
  });

  test("leave rejects the queue, the message on screen included, with the agy label", async () => {
    const h = setup("held");
    arrive(h, peerMessage("premier", "codex-a", "/tmp/a.sock"));
    arrive(h, peerMessage("second", "codex-b", "/tmp/b.sock"));
    await h.delivery.leave();
    expect(h.sent.length).toBe(2);
    for (const reply of h.sent) expect(reply.body).toBe(`${AUTO_REPLY_MARKER}\nclaude-test : message non livré (agy a quitté le bus)`);
    expect(h.queue.size).toBe(0);
    expect(h.counts.at(-1)).toBe(0);
    h.delivery.deliverHeld();
    h.delivery.reopenHeld();
    h.delivery.onIdle();
    expect(h.turns).toEqual([]);
    expect(h.held.length).toBe(1);
  });

  test("never throws when the send fails", async () => {
    const h = setup("held", { failSend: true });
    arrive(h, peerMessage("premier"));
    await h.delivery.dismissHeld();
    arrive(h, peerMessage("second"));
    h.delivery.deliverHeld();
    await h.delivery.onTurnEnded("end_turn");
    arrive(h, peerMessage("troisième"));
    await h.delivery.leave();
    expect(h.sent.length).toBeGreaterThanOrEqual(3);
  });
});
