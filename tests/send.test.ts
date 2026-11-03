import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { buildEnvelope } from "../src/bus/envelope.ts";
import { publishKey, readPeerToken } from "../src/bus/key.ts";
import { pidDomain } from "../src/bus/proc.ts";
import { PeerError, sendPeerMessage, writeFrames } from "../src/bus/send.ts";
import { sessionsDir } from "../src/paths.ts";
import { startFakePeer, type FakePeer } from "./helpers/fake-peer.ts";

const ENV_KEYS = ["IDNMA_CLAUDE_DIR", "IDNMA_SOCKETS_DIR"] as const;
let previousEnv: Record<string, string | undefined>;
let peers: FakePeer[];
let tempDirs: string[];

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  peers = [];
  tempDirs = [mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-")];
  process.env.IDNMA_CLAUDE_DIR = tempDirs[0];
  process.env.IDNMA_SOCKETS_DIR = tempDirs[1];
});

afterEach(() => {
  for (const peer of peers) peer.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function peer(name: string): Promise<FakePeer> {
  const started = await startFakePeer(name);
  peers.push(started);
  return started;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const FROM = "/tmp/cc-socks/1.sock";

describe("sendPeerMessage", () => {
  test("authenticates first, then delivers the canonical envelope", async () => {
    const target = await peer("claude-vulcain");
    const result = await sendPeerMessage({ to: "claude-vulcain", body: "hello", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await waitFor(() => target.lines.length >= 2, "two frames");

    expect(result.target.pid).toBe(target.entry.pid);
    expect(target.lines[0]).toEqual({ type: "auth", tokenMatches: true });
    const frame = target.lines[1] as { msgV: number; msg_id: string; type: string; priority: string; from: string; message: { role: string; content: string } };
    expect(frame.msgV).toBe(1);
    expect(frame.type).toBe("user");
    expect(frame.msg_id).toBe(result.msgId);
    expect(frame.from).toBe(`uds:${FROM}`);
    expect(frame.message.role).toBe("user");
    expect(frame.message.content).toBe(buildEnvelope({ from: `uds:${FROM}`, fromName: "codex-janus", fromMode: "bypass", body: "hello" }));
    expect(frame.message.content).toContain('from-name="codex-janus"');
  });

  test("delivers a 200 KiB body whole (no truncation at 8192 bytes)", async () => {
    const target = await peer("claude-vulcain");
    const body = "x".repeat(200 * 1024);
    await sendPeerMessage({ to: "claude-vulcain", body, fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await waitFor(() => target.lines.length >= 2, "two frames");

    const frame = target.lines[1] as { message: { content: string } };
    const prefix = `<cross-session-message from="uds:${FROM}" from-name="codex-janus" from-mode="bypass">\n`;
    const suffix = "\n</cross-session-message>";
    expect(frame.message.content.startsWith(prefix)).toBe(true);
    expect(frame.message.content.endsWith(suffix)).toBe(true);
    const decoded = frame.message.content.slice(prefix.length, frame.message.content.length - suffix.length);
    expect(decoded.length).toBe(200 * 1024);
  });

  test("rejects an unknown name with a PeerError", async () => {
    await peer("claude-vulcain");
    const attempt = sendPeerMessage({ to: "claude-minerve", body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await expect(attempt).rejects.toBeInstanceOf(PeerError);
    await expect(attempt).rejects.toThrow(/aucun pair vivant nommé/);
    await expect(attempt).rejects.toThrow(/claude-minerve/);
  });

  test("an unknown name lists the live peers the sender can reach, not the sender itself", async () => {
    const sender = await peer("codex-janus");
    await peer("grok-mars-ab12");
    await peer("claude-vulcain");
    const attempt = sendPeerMessage({ to: "claude-vulcan", body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: sender.socketPath });
    await expect(attempt).rejects.toThrow("aucun pair vivant nommé « claude-vulcan » ; pairs vivants : claude-vulcain, grok-mars-ab12");
  });

  test("an unknown name says when no other peer is alive", async () => {
    const sender = await peer("codex-janus");
    const attempt = sendPeerMessage({ to: "claude-vulcain", body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: sender.socketPath });
    await expect(attempt).rejects.toThrow("aucun pair vivant nommé « claude-vulcain » ; aucun autre pair n'est vivant");
  });

  test("refuses to send to the sender itself, by name or by address, and writes nothing", async () => {
    const sender = await peer("codex-janus");
    for (const to of ["codex-janus", { address: `uds:${sender.socketPath}` }]) {
      const attempt = sendPeerMessage({ to, body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: sender.socketPath });
      await expect(attempt).rejects.toBeInstanceOf(PeerError);
      await expect(attempt).rejects.toThrow("lui-même");
    }
    expect(sender.lines).toHaveLength(0);
  });

  test("rejects two live peers with the same name and lists their pids", async () => {
    const first = await peer("claude-vulcain");
    const second = await peer("claude-vulcain");
    const attempt = sendPeerMessage({ to: "claude-vulcain", body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await expect(attempt).rejects.toBeInstanceOf(PeerError);
    await expect(attempt).rejects.toThrow(String(first.entry.pid));
    await expect(attempt).rejects.toThrow(String(second.entry.pid));
    expect(first.lines).toHaveLength(0);
    expect(second.lines).toHaveLength(0);
  });

  test("ignores a live entry without a messagingSocketPath when resolving a name", async () => {
    const ghost = await peer("claude-ghost");
    const path = join(sessionsDir(), `${ghost.entry.pid}.json`);
    const { messagingSocketPath: _removed, ...withoutSocket } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(withoutSocket));
    const alone = sendPeerMessage({ to: "claude-ghost", body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await expect(alone).rejects.toBeInstanceOf(PeerError);
    await expect(alone).rejects.toThrow(/aucun pair vivant nommé « claude-ghost »/);

    // Un homonyme sans socket ne rend pas le nom ambigu : le pair joignable reçoit le message.
    const reachable = await peer("claude-ghost");
    await sendPeerMessage({ to: "claude-ghost", body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await waitFor(() => reachable.lines.some((line) => (line as { type?: string }).type === "user"), "user frame");
  });

  test("sends to an address and delivers the same envelope as a send by name", async () => {
    const target = await peer("claude-vulcain");
    const byName = await sendPeerMessage({ to: "claude-vulcain", body: "hello", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await waitFor(() => target.lines.length >= 2, "frames of the send by name");
    const byAddress = await sendPeerMessage({ to: { address: `uds:${target.socketPath}` }, body: "hello", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await waitFor(() => target.lines.length >= 4, "frames of the send by address");

    expect(byAddress.target.pid).toBe(target.entry.pid);
    expect(target.lines[2]).toEqual({ type: "auth", tokenMatches: true });
    const named = target.lines[1] as { message: unknown; from: string; msg_id: string };
    const addressed = target.lines[3] as { message: unknown; from: string; msg_id: string };
    expect(addressed.msg_id).toBe(byAddress.msgId);
    expect(addressed.msg_id).not.toBe(byName.msgId);
    expect(addressed.from).toBe(named.from);
    expect(addressed.message).toEqual(named.message);
  });

  test("rejects an unknown address with a PeerError naming it", async () => {
    await peer("claude-vulcain");
    const address = "uds:/tmp/idnma-t-nobody.sock";
    const attempt = sendPeerMessage({ to: { address }, body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await expect(attempt).rejects.toBeInstanceOf(PeerError);
    await expect(attempt).rejects.toThrow(/aucun pair vivant à l'adresse/);
    await expect(attempt).rejects.toThrow(address);
  });

  test("two live peers share a name: by name it is ambiguous, by address only the targeted one receives", async () => {
    const first = await peer("claude-vulcain");
    const second = await peer("claude-vulcain");
    expect(second.socketPath).not.toBe(first.socketPath);

    const ambiguous = sendPeerMessage({ to: "claude-vulcain", body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await expect(ambiguous).rejects.toThrow(/nom ambigu/);
    expect(first.lines).toHaveLength(0);
    expect(second.lines).toHaveLength(0);

    const result = await sendPeerMessage({ to: { address: `uds:${second.socketPath}` }, body: "hi", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: FROM });
    await waitFor(() => second.lines.some((line) => (line as { type?: string }).type === "user"), "user frame on the targeted peer");
    await Bun.sleep(50);
    expect(result.target.pid).toBe(second.entry.pid);
    expect(first.lines).toHaveLength(0);
  });

  test("sends without an auth line when the target publishes no key", async () => {
    const target = await peer("claude-vulcain");
    for (const file of readdirSync(sessionsDir()).filter((f) => f.endsWith(".key"))) rmSync(join(sessionsDir(), file));
    expect(readPeerToken(target.socketPath)).toBeUndefined();

    await sendPeerMessage({ to: "claude-vulcain", body: "hello", fromName: "codex-janus", fromMode: "prompting", fromSocketPath: FROM });
    await waitFor(() => target.lines.length >= 1, "one frame");
    await Bun.sleep(50);
    expect(target.lines).toHaveLength(1);
    expect((target.lines[0] as { type: string }).type).toBe("user");
  });
});

describe("readPeerToken", () => {
  test("returns the token published for the socket", async () => {
    const target = await peer("claude-vulcain");
    const token = readPeerToken(target.socketPath);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  test("ignores a key whose procStart no longer matches the live pid", async () => {
    const target = await peer("claude-vulcain");
    for (const file of readdirSync(sessionsDir()).filter((f) => f.endsWith(".key"))) rmSync(join(sessionsDir(), file));
    publishKey(target.entry.pid, target.socketPath, "a".repeat(32), "Thu Jan  1 00:00:00 1970");
    expect(readPeerToken(target.socketPath)).toBeUndefined();
  });

  test("ignores a key whose pid is dead", () => {
    publishKey(99_998, "/tmp/idnma-t-ghost.sock", "b".repeat(32), "Thu Jan  1 00:00:00 1970");
    expect(readPeerToken("/tmp/idnma-t-ghost.sock")).toBeUndefined();
  });
});

describe("publishKey", () => {
  test("writes a 600 file with the expected content", () => {
    const path = publishKey(4242, "/tmp/idnma-t-x.sock", "c".repeat(32), "Mon Oct 26 10:00:00 2026");
    expect(path.startsWith(sessionsDir())).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ peerToken: "c".repeat(32), procStart: "Mon Oct 26 10:00:00 2026", pidDomain: pidDomain() });
  });
});

describe("writeFrames", () => {
  test("rejects with a PeerError naming the socket when nobody listens", async () => {
    const missing = join(tempDirs[1]!, "missing.sock");
    const attempt = writeFrames(missing, ["{}"]);
    await expect(attempt).rejects.toBeInstanceOf(PeerError);
    await expect(attempt).rejects.toThrow(missing);
  });

  test("rejects with a PeerError on timeout when the peer never closes", async () => {
    const socketPath = join(tempDirs[1]!, "mute.sock");
    const server = createServer({ allowHalfOpen: true }, (connection) => {
      connection.resume();
      connection.on("error", () => {});
    });
    await new Promise<void>((resolveListen) => server.listen(socketPath, () => resolveListen()));
    try {
      const attempt = writeFrames(socketPath, ["{}"], 150);
      await expect(attempt).rejects.toBeInstanceOf(PeerError);
      await expect(attempt).rejects.toThrow(socketPath);
    } finally {
      server.close();
    }
  });
});
