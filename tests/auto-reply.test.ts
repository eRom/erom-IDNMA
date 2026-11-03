import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addressOf, buildEnvelope } from "../src/bus/envelope.ts";
import type { InboundMessage } from "../src/bus/inbox.ts";
import type { Registration } from "../src/bus/register.ts";
import type { sendPeerMessage } from "../src/bus/send.ts";
import { AUTO_REPLY_MARKER, isAutoReply, rejectQueuedMessages, replyHintFor, withReplyHint } from "../src/understudy/courier.ts";
import { MessageQueue } from "../src/understudy/queue.ts";

const envelopeWith = (body: string): string => buildEnvelope({ from: addressOf("/tmp/a.sock"), fromName: "codex-a", fromMode: "bypass", body });

describe("withReplyHint", () => {
  test("follows a peer message with a line telling the agent how to answer its sender", () => {
    const envelope = envelopeWith("renvoie-moi le mot FRAISE-17");
    const hinted = withReplyHint(envelope);
    expect(hinted.startsWith(`${envelope}\n`)).toBe(true);
    expect(hinted.slice(envelope.length + 1)).toContain('`idnma peer send codex-a "…"`');
    expect(hinted.split("\n").length).toBe(envelope.split("\n").length + 1);
  });

  test("reads the from-name attribute itself, in the 2.1.311 envelope with hop-chain", () => {
    // Forme vue dans le pane de Codex le 27/10 (Claude Code 2.1.311).
    const observed = '<cross-session-message from="uds:/tmp/cc-socks/1940.sock" hop-chain="63c3da6f846082825e462c4a" from-name="claude-ceres" from-mode="bypass">\nbonjour\n</cross-session-message>';
    expect(withReplyHint(observed)).toContain("`idnma peer send claude-ceres");
    const decoy = '<cross-session-message from="uds:/tmp/a.sock" from-name="claude-ceres" x-from-name="evil" from-mode="bypass">\nbonjour\n</cross-session-message>';
    expect(withReplyHint(decoy)).toContain("`idnma peer send claude-ceres");
    expect(withReplyHint(decoy)).not.toContain("evil\"`");
  });

  test("leaves an auto-reply, a message without a readable name, and plain text untouched", () => {
    const autoReply = envelopeWith(`${AUTO_REPLY_MARKER}\nla réponse`);
    const oddName = buildEnvelope({ from: addressOf("/tmp/a.sock"), fromName: "claude ceres; rm", fromMode: "bypass", body: "bonjour" });
    for (const content of [autoReply, oddName, "<env>urgent</env>"]) expect(withReplyHint(content)).toBe(content);
  });
});

describe("replyHintFor", () => {
  test("renders the hint line for a named envelope", () => {
    const hint = replyHintFor(envelopeWith("bonjour"));
    expect(hint).toBe('(idnma) Message reçu pendant ton tour : ta réponse finale ne lui revient pas, réponds à codex-a par `idnma peer send codex-a "…"`.');
  });

  test("is undefined for an auto-reply, an unreadable name and plain text", () => {
    const oddName = buildEnvelope({ from: addressOf("/tmp/a.sock"), fromName: "claude ceres; rm", fromMode: "bypass", body: "bonjour" });
    for (const content of [envelopeWith(`${AUTO_REPLY_MARKER}\nla réponse`), oddName, "<env>urgent</env>", ""]) {
      expect(replyHintFor(content)).toBeUndefined();
    }
  });

  test("withReplyHint is the content followed by the hint line, or the content itself", () => {
    const named = envelopeWith("bonjour");
    expect(withReplyHint(named)).toBe(`${named}\n${replyHintFor(named)}`);
    const autoReply = envelopeWith(`${AUTO_REPLY_MARKER}\nla réponse`);
    expect(withReplyHint(autoReply)).toBe(autoReply);
  });
});

describe("isAutoReply", () => {
  test("is true when the first line of the body is exactly the marker", () => {
    expect(isAutoReply(envelopeWith(`${AUTO_REPLY_MARKER}\nla réponse`))).toBe(true);
    expect(isAutoReply(envelopeWith(AUTO_REPLY_MARKER))).toBe(true);
  });

  test("is false when the marker is elsewhere in the body", () => {
    expect(isAutoReply(envelopeWith(`bonjour\n${AUTO_REPLY_MARKER}`))).toBe(false);
    expect(isAutoReply(envelopeWith(`bonjour ${AUTO_REPLY_MARKER}`))).toBe(false);
  });

  test("is false when the marker only prefixes a longer first line", () => {
    expect(isAutoReply(envelopeWith(`${AUTO_REPLY_MARKER} et la suite\nautre`))).toBe(false);
    expect(isAutoReply(envelopeWith(`${AUTO_REPLY_MARKER}x`))).toBe(false);
  });

  test("is false for an ordinary message and for content that is no envelope", () => {
    expect(isAutoReply(envelopeWith("peux-tu vérifier le build ?"))).toBe(false);
    expect(isAutoReply("")).toBe(false);
    expect(isAutoReply(`bonjour\n${AUTO_REPLY_MARKER}`)).toBe(false);
  });
});

describe("rejectQueuedMessages", () => {
  let dir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.IDNMA_CONFIG_DIR;
    dir = mkdtempSync("/tmp/idnma-t-");
    process.env.IDNMA_CONFIG_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
    else process.env.IDNMA_CONFIG_DIR = previousConfigDir;
  });

  const events = (name: string): Array<Record<string, unknown>> => {
    const path = join(dir, "logs", "idnma.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.event === name);
  };

  const registration = { socketPath: "/tmp/unused.sock" } as unknown as Registration;
  const queued = (content: string, from?: string): InboundMessage => ({
    ...(from === undefined ? {} : { from }),
    msgId: `m-${content}`,
    priority: "next",
    content,
    authenticated: true,
    receivedAt: 0,
  });

  test("empties the queue and tells every sender, marker first", async () => {
    const queue = new MessageQueue();
    queue.push(queued("un", "uds:/tmp/x.sock"));
    queue.push(queued("deux", "uds:/tmp/y.sock"));
    const sent: Array<Parameters<typeof sendPeerMessage>[0]> = [];
    const send = (async (a: Parameters<typeof sendPeerMessage>[0]) => {
      sent.push(a);
      return { msgId: "x", target: {} };
    }) as unknown as typeof sendPeerMessage;

    await rejectQueuedMessages({ queue, registration, name: "codex-test", fromMode: "bypass", send });

    expect(queue.size).toBe(0);
    expect(sent.map((a) => a.to)).toEqual([{ address: "uds:/tmp/x.sock" }, { address: "uds:/tmp/y.sock" }]);
    for (const a of sent) {
      expect(a.body).toBe(`${AUTO_REPLY_MARKER}\ncodex-test : message non livré (Codex a quitté le bus)`);
      expect(a.fromName).toBe("codex-test");
      expect(a.fromMode).toBe("bypass");
      expect(a.fromSocketPath).toBe("/tmp/unused.sock");
    }
  });

  test("names the harness that left the bus", async () => {
    const queue = new MessageQueue();
    queue.push(queued("un", "uds:/tmp/x.sock"));
    const sent: Array<Parameters<typeof sendPeerMessage>[0]> = [];
    const send = (async (a: Parameters<typeof sendPeerMessage>[0]) => {
      sent.push(a);
      return { msgId: "x", target: {} };
    }) as unknown as typeof sendPeerMessage;

    await rejectQueuedMessages({ queue, registration, name: "agy-test", fromMode: "prompting", send, label: "agy" });

    expect(sent.map((a) => a.body)).toEqual([`${AUTO_REPLY_MARKER}\nagy-test : message non livré (agy a quitté le bus)`]);
  });

  test("never throws: a failed send and a message without sender go to the log", async () => {
    const queue = new MessageQueue();
    queue.push(queued("sans expéditeur"));
    queue.push(queued("pair disparu", "uds:/tmp/gone.sock"));
    const send = (async () => {
      throw new Error("aucun pair vivant");
    }) as unknown as typeof sendPeerMessage;

    await rejectQueuedMessages({ queue, registration, name: "codex-test", fromMode: "bypass", send });

    expect(queue.size).toBe(0);
    expect(events("reply-without-sender")).toEqual([expect.objectContaining({ msgId: "m-sans expéditeur" })]);
    expect(events("reply-error")).toEqual([expect.objectContaining({ message: "aucun pair vivant" })]);
  });

  test("waits no longer than the bound for a send that never ends", async () => {
    const queue = new MessageQueue();
    queue.push(queued("un", "uds:/tmp/x.sock"));
    const send = (() => new Promise(() => {})) as unknown as typeof sendPeerMessage;

    const started = Date.now();
    await rejectQueuedMessages({ queue, registration, name: "codex-test", fromMode: "bypass", send, waitMs: 150 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1000);
    expect(queue.size).toBe(0);
  });

  test("an empty queue sends nothing and returns at once", async () => {
    let calls = 0;
    const send = (async () => {
      calls += 1;
      return { msgId: "x", target: {} };
    }) as unknown as typeof sendPeerMessage;
    const started = Date.now();
    await rejectQueuedMessages({ queue: new MessageQueue(), registration, name: "codex-test", fromMode: "bypass", send });
    expect(calls).toBe(0);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
