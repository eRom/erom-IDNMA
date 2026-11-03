import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { authFrame, buildUserFrame } from "../src/bus/envelope.ts";
import { startInboxServer, type InboundMessage } from "../src/bus/inbox.ts";
import { writeFrames } from "../src/bus/send.ts";

const TOKEN = "d".repeat(32);
let dir: string;
let socketPath: string;
let messages: InboundMessage[];
let controls: Record<string, unknown>[];
let stoppers: Array<() => void>;

beforeEach(() => {
  dir = mkdtempSync("/tmp/idnma-t-");
  socketPath = join(dir, "inbox.sock");
  messages = [];
  controls = [];
  stoppers = [];
});

afterEach(() => {
  for (const stop of stoppers) stop();
  rmSync(dir, { recursive: true, force: true });
});

function start(firstLineDeadlineMs?: number): void {
  const server = startInboxServer({
    socketPath,
    peerToken: TOKEN,
    onMessage: (message) => messages.push(message),
    onControl: (frame) => controls.push(frame),
    ...(firstLineDeadlineMs === undefined ? {} : { firstLineDeadlineMs }),
  });
  stoppers.push(() => server.stop());
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Ouvre une connexion brute et résout à la fermeture, avec la durée écoulée. */
function connectUntilClosed(onConnected?: (socket: ReturnType<typeof createConnection>) => void): Promise<number> {
  return new Promise((resolveClosed) => {
    const startedAt = Date.now();
    const socket = createConnection(socketPath);
    // Une fermeture brutale du serveur (ECONNRESET) fait partie des cas observés.
    socket.on("error", () => {});
    socket.on("close", () => resolveClosed(Date.now() - startedAt));
    socket.resume();
    socket.on("connect", () => onConnected?.(socket));
  });
}

const FROM = "uds:/a.sock";

describe("startInboxServer", () => {
  test("delivers an authenticated message and completes the send well under the timeout", async () => {
    start();
    const startedAt = Date.now();
    await writeFrames(socketPath, [authFrame(TOKEN), buildUserFrame({ msgId: "m1", from: FROM, content: "x" })]);
    expect(Date.now() - startedAt).toBeLessThan(1000);

    await waitFor(() => messages.length >= 1, "one message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ msgId: "m1", from: FROM, content: "x", authenticated: true, priority: "next" });
    expect(typeof messages[0]!.receivedAt).toBe("number");
  });

  test("still delivers the message with authenticated=false on a wrong token", async () => {
    start();
    await writeFrames(socketPath, [authFrame("e".repeat(32)), buildUserFrame({ msgId: "m2", from: FROM, content: "y" })]);
    await waitFor(() => messages.length >= 1, "one message");
    expect(messages[0]).toMatchObject({ msgId: "m2", content: "y", authenticated: false });
  });

  test("delivers a message sent without any auth line as unauthenticated", async () => {
    start();
    await writeFrames(socketPath, [buildUserFrame({ msgId: "m3", from: FROM, content: "z" })]);
    await waitFor(() => messages.length >= 1, "one message");
    expect(messages[0]).toMatchObject({ msgId: "m3", content: "z", authenticated: false });
  });

  test("ignores a non-JSON line and delivers the valid frame on the same connection", async () => {
    start();
    await writeFrames(socketPath, ["this is not json", buildUserFrame({ msgId: "m4", from: FROM, content: "ok" })]);
    await waitFor(() => messages.length >= 1, "one message");
    await Bun.sleep(50);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ msgId: "m4", content: "ok" });
  });

  test("routes a control frame to onControl and not to onMessage", async () => {
    start();
    await writeFrames(socketPath, [JSON.stringify({ type: "control", action: "peer_message_status", status: "held" })]);
    await waitFor(() => controls.length >= 1, "one control frame");
    await Bun.sleep(50);
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ type: "control", action: "peer_message_status", status: "held" });
    expect(messages).toHaveLength(0);
  });

  test("ignores unknown frame types and user frames without a non-empty string content", async () => {
    start();
    const empty = JSON.stringify({ msgV: 1, type: "user", message: { role: "user", content: "" } });
    const nonString = JSON.stringify({ msgV: 1, type: "user", message: { role: "user", content: [{ type: "text", text: "a" }] } });
    const noMessage = JSON.stringify({ msgV: 1, type: "user" });
    const unknown = JSON.stringify({ type: "something-else", message: { content: "nope" } });
    const jsonScalar = "42";
    await writeFrames(socketPath, [empty, nonString, noMessage, unknown, jsonScalar, buildUserFrame({ msgId: "m5", from: FROM, content: "last" })]);
    await waitFor(() => messages.length >= 1, "one message");
    await Bun.sleep(50);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ msgId: "m5", content: "last" });
    expect(controls).toHaveLength(0);
  });

  test("keeps the priority when known and falls back to next otherwise", async () => {
    start();
    const withPriority = (priority: unknown, content: string) =>
      JSON.stringify({ msgV: 1, type: "user", message: { role: "user", content }, priority });
    await writeFrames(socketPath, [
      buildUserFrame({ msgId: "a", from: FROM, content: "now", priority: "now" }),
      buildUserFrame({ msgId: "b", from: FROM, content: "later", priority: "later" }),
      withPriority("urgent", "unknown"),
      JSON.stringify({ msgV: 1, type: "user", message: { role: "user", content: "absent" } }),
    ]);
    await waitFor(() => messages.length >= 4, "four messages");
    expect(messages.map((m) => [m.content, m.priority])).toEqual([
      ["now", "now"],
      ["later", "later"],
      ["unknown", "next"],
      ["absent", "next"],
    ]);
  });

  test("passes the content through untouched, even a 200 KiB body split across chunks", async () => {
    start();
    const content = `<cross-session-message from="${FROM}" from-name="codex-janus" from-mode="bypass">\n${"é\n x ".repeat(45_000)}\n</cross-session-message>`;
    expect(content.length).toBeGreaterThan(200 * 1024);
    await writeFrames(socketPath, [authFrame(TOKEN), buildUserFrame({ msgId: "big", from: FROM, content })]);
    await waitFor(() => messages.length >= 1, "the big message");
    expect(messages[0]!.content).toBe(content);
    expect(messages[0]!.authenticated).toBe(true);
  });

  test("accepts an empty liveness connection and never throws", async () => {
    start();
    await connectUntilClosed((socket) => socket.end());
    await Bun.sleep(50);
    expect(messages).toHaveLength(0);
    // Le serveur reste utilisable après une sonde vide.
    await writeFrames(socketPath, [buildUserFrame({ msgId: "after", from: FROM, content: "alive" })]);
    await waitFor(() => messages.length >= 1, "one message");
    expect(messages[0]).toMatchObject({ msgId: "after" });
  });

  test("closes a connection that sends no complete line before the first-line deadline", async () => {
    start(200);
    const elapsed = await connectUntilClosed();
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1000);
  });

  test("closes a connection that only sent a partial line before the deadline", async () => {
    start(200);
    const elapsed = await connectUntilClosed((socket) => socket.write('{"type":"user"'));
    expect(elapsed).toBeLessThan(1000);
    expect(messages).toHaveLength(0);
  });

  test("does not close a connection that delivered a first line, even after the deadline", async () => {
    start(150);
    let closed = false;
    const connection = connectUntilClosed((socket) => socket.write(buildUserFrame({ msgId: "slow", from: FROM, content: "first" }) + "\n"));
    void connection.then(() => {
      closed = true;
    });
    await Bun.sleep(400);
    expect(closed).toBe(false);
    expect(messages).toHaveLength(1);
    stoppers.at(-1)!();
    await connection;
  });

  test("closes a connection whose line exceeds 2 MiB", async () => {
    start();
    const elapsed = await connectUntilClosed((socket) => {
      socket.write("x".repeat(3 * 1024 * 1024));
    });
    expect(elapsed).toBeLessThan(2000);
    expect(messages).toHaveLength(0);
    // Le serveur survit à la connexion abusive.
    await writeFrames(socketPath, [buildUserFrame({ msgId: "ok", from: FROM, content: "still here" })]);
    await waitFor(() => messages.length >= 1, "one message");
  });

  test("writes nothing back on the connection", async () => {
    start();
    let receivedBytes = 0;
    await new Promise<void>((resolveClosed, rejectClosed) => {
      const socket = createConnection(socketPath);
      socket.on("error", rejectClosed);
      socket.on("data", (chunk) => {
        receivedBytes += chunk.length;
      });
      socket.on("close", () => resolveClosed());
      socket.on("connect", () => socket.end(authFrame(TOKEN) + "\n" + buildUserFrame({ msgId: "q", from: FROM, content: "quiet" }) + "\n"));
    });
    expect(receivedBytes).toBe(0);
  });

  test("creates the socket file in mode 600", () => {
    start();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  test("stop removes the socket file and refuses new connections", async () => {
    start();
    stoppers.at(-1)!();
    await expect(writeFrames(socketPath, ["{}"])).rejects.toThrow();
  });

  test("keeps delivering the following frames of a connection when a callback throws", async () => {
    const errors: unknown[] = [];
    const received: string[] = [];
    let calls = 0;
    const server = startInboxServer({
      socketPath,
      peerToken: TOKEN,
      onMessage: (message) => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        received.push(message.content);
      },
      onError: (error) => errors.push(error),
    });
    stoppers.push(() => server.stop());
    await writeFrames(socketPath, [buildUserFrame({ msgId: "t1", from: FROM, content: "first" }), buildUserFrame({ msgId: "t2", from: FROM, content: "second" })]);
    await waitFor(() => received.length >= 1, "second frame");
    expect(received).toEqual(["second"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  test("keeps delivering the following frames when onControl throws", async () => {
    const errors: unknown[] = [];
    const received: string[] = [];
    const server = startInboxServer({
      socketPath,
      peerToken: TOKEN,
      onMessage: (message) => received.push(message.content),
      onControl: () => {
        throw new Error("control boom");
      },
      onError: (error) => errors.push(error),
    });
    stoppers.push(() => server.stop());
    await writeFrames(socketPath, [JSON.stringify({ type: "control", action: "x" }), buildUserFrame({ msgId: "t3", from: FROM, content: "after" })]);
    await waitFor(() => received.length >= 1, "frame after control");
    expect(received).toEqual(["after"]);
    expect(errors).toHaveLength(1);
  });

  test("restores the process umask when Bun.listen itself fails", () => {
    // Dossier parent en lecture seule : le retrait du socket orphelin passe (fichier absent), c'est
    // `Bun.listen` qui échoue, sous le masque 077. Seul le `finally` autour de lui remet le masque.
    const readOnly = join(dir, "ro");
    mkdirSync(readOnly, { mode: 0o700 });
    chmodSync(readOnly, 0o500);
    const before = process.umask(0o022);
    try {
      expect(() => startInboxServer({ socketPath: join(readOnly, "inbox.sock"), peerToken: TOKEN, onMessage: () => {} })).toThrow();
      expect(process.umask(0o022)).toBe(0o022);
    } finally {
      process.umask(before);
      chmodSync(readOnly, 0o700);
    }
  });
});
