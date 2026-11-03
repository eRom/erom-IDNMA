import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboundMessage } from "../src/bus/inbox.ts";
import { keyFileName } from "../src/bus/key.ts";
import { pidDomain, procStart } from "../src/bus/proc.ts";
import { listLiveEntries, type SessionEntry } from "../src/bus/registry.ts";
import { claudeVersion, ProtocolMismatchError, registerPeer, type Registration } from "../src/bus/register.ts";
import { sendPeerMessage } from "../src/bus/send.ts";
import { sessionsDir, socketsDir } from "../src/paths.ts";
import { startFakePeer, type FakePeer } from "./helpers/fake-peer.ts";

const ENV_KEYS = ["IDNMA_CLAUDE_DIR", "IDNMA_SOCKETS_DIR", "IDNMA_CONFIG_DIR"] as const;
// Retrait d'un dossier non vide par `unlink` : macOS répond EPERM, Linux EISDIR.
const UNLINK_DIR_CODE = process.platform === "darwin" ? "EPERM" : "EISDIR";
let previousEnv: Record<string, string | undefined>;
let tempDirs: string[];
let registrations: Registration[];
let peers: FakePeer[];
let messages: InboundMessage[];

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tempDirs = [mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-")];
  process.env.IDNMA_CLAUDE_DIR = tempDirs[0];
  process.env.IDNMA_SOCKETS_DIR = tempDirs[1];
  process.env.IDNMA_CONFIG_DIR = tempDirs[2];
  registrations = [];
  peers = [];
  messages = [];
});

afterEach(() => {
  for (const registration of registrations) registration.unregister();
  for (const peer of peers) peer.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function register(name: string, tmux?: string): Promise<Registration> {
  const registration = await registerPeer({
    name,
    cwd: "/w",
    ...(tmux === undefined ? {} : { tmux }),
    onMessage: (message) => messages.push(message),
  });
  registrations.push(registration);
  return registration;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe("registerPeer", () => {
  test("writes a live registry entry with every field of the captured shape", async () => {
    const before = Date.now();
    const registration = await register("codex-janus", "idema-1:@4.%6");
    const entry = listLiveEntries().find((candidate) => candidate.pid === process.pid);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      pid: process.pid,
      cwd: "/w",
      procStart: procStart(process.pid),
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      entrypoint: "cli",
      pidDomain: pidDomain(),
      messagingSocketPath: join(socketsDir(), `${process.pid}.sock`),
      name: "codex-janus",
      nameSource: "user",
      status: "idle",
      tmux: "idema-1:@4.%6",
    });
    expect(entry!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof entry!.version).toBe("string");
    for (const field of ["startedAt", "nameSince", "updatedAt", "statusUpdatedAt"] as const) {
      expect(entry![field]).toBeGreaterThanOrEqual(before);
      expect(entry![field]).toBeLessThanOrEqual(Date.now());
    }
    expect(registration.entry).toEqual(entry as SessionEntry);
    expect(registration.socketPath).toBe(entry!.messagingSocketPath);
    expect(registration.address).toBe("uds:" + entry!.messagingSocketPath);
  });

  test("omits tmux when none is given", async () => {
    const registration = await register("codex-janus");
    expect("tmux" in registration.entry).toBe(false);
  });

  test("publishes a key in mode 600 and a socket in mode 600", async () => {
    const registration = await register("codex-janus");
    const keyPath = join(sessionsDir(), keyFileName(process.pid, registration.socketPath));
    expect(existsSync(keyPath)).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const key = JSON.parse(readFileSync(keyPath, "utf8")) as Record<string, unknown>;
    expect(key.peerToken).toBe(registration.peerToken);
    expect(registration.peerToken).toMatch(/^[0-9a-f]{32}$/);
    expect(key.procStart).toBe(registration.entry.procStart);
    expect(statSync(registration.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(socketsDir()).mode & 0o777).toBe(0o700);
  });

  test("receives an authenticated message sent by another peer", async () => {
    await register("codex-janus");
    const sender = await startFakePeer("sender");
    peers.push(sender);
    await sendPeerMessage({ fromSocketPath: sender.socketPath, fromName: "sender", fromMode: "prompting", to: "codex-janus", body: "hello" });
    await waitFor(() => messages.length >= 1, "one message");
    expect(messages[0]).toMatchObject({ authenticated: true, from: "uds:" + sender.socketPath });
    expect(messages[0]!.content).toContain("hello");
  });

  test("unregister twice leaves no entry, key or socket and throws nothing", async () => {
    const registration = await register("codex-janus");
    const keyPath = join(sessionsDir(), keyFileName(process.pid, registration.socketPath));
    registration.unregister();
    registration.unregister();
    expect(listLiveEntries().some((entry) => entry.pid === process.pid)).toBe(false);
    expect(existsSync(join(sessionsDir(), `${process.pid}.json`))).toBe(false);
    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(registration.socketPath)).toBe(false);
  });

  test("rejects with ProtocolMismatchError when a live entry has another peerProtocol, and writes nothing", async () => {
    const other = await startFakePeer("other", { peerProtocol: 2 });
    peers.push(other);
    const error = await registerPeer({ name: "codex-janus", cwd: "/w", onMessage: () => {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect((error as Error).message).toContain("2");
    expect(existsSync(join(sessionsDir(), `${process.pid}.json`))).toBe(false);
    expect(existsSync(join(socketsDir(), `${process.pid}.sock`))).toBe(false);
    expect(existsSync(join(sessionsDir(), keyFileName(process.pid, join(socketsDir(), `${process.pid}.sock`))))).toBe(false);
  });

  test("ignores a live entry without a peerProtocol field", async () => {
    const other = await startFakePeer("legacy");
    peers.push(other);
    const path = join(sessionsDir(), `${other.entry.pid}.json`);
    const { peerProtocol: _removed, ...withoutProtocol } = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(withoutProtocol));
    const registration = await register("codex-janus");
    expect(registration.entry.peerProtocol).toBe(1);
  });

  test("a stale socket file at our pid does not block registration", async () => {
    mkdirSync(socketsDir(), { recursive: true });
    writeFileSync(join(socketsDir(), `${process.pid}.sock`), "stale");
    const registration = await register("codex-janus");
    const sender = await startFakePeer("sender");
    peers.push(sender);
    await sendPeerMessage({ fromSocketPath: sender.socketPath, fromName: "sender", fromMode: "prompting", to: "codex-janus", body: "after stale" });
    await waitFor(() => messages.length >= 1, "one message");
    expect(statSync(registration.socketPath).isSocket()).toBe(true);
  });

  test("creates a missing sockets directory in mode 700", async () => {
    process.env.IDNMA_SOCKETS_DIR = join(tempDirs[1]!, "cc-socks");
    const registration = await register("codex-janus");
    expect(statSync(socketsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(registration.socketPath).isSocket()).toBe(true);
  });

  test("takes the version of the highest live entry", async () => {
    // 9.9.9 : ni le défaut du faux pair ni le `claude --version` local, donc discriminant.
    const other = await startFakePeer("claude", { version: "9.9.9" });
    peers.push(other);
    const registration = await register("codex-janus");
    expect(registration.entry.version).toBe("9.9.9");
  });

  test("unregister runs every step even when removing the entry fails, then reports that first error", async () => {
    const registration = await register("codex-janus");
    const entryPath = join(sessionsDir(), `${process.pid}.json`);
    const keyPath = join(sessionsDir(), keyFileName(process.pid, registration.socketPath));
    // Un dossier non vide à la place de l'entrée : son retrait échoue (UNLINK_DIR_CODE), la clé reste retirable.
    unlinkSync(entryPath);
    mkdirSync(join(entryPath, "occupied"), { recursive: true });
    let error: unknown;
    try {
      registration.unregister();
    } catch (caught) {
      error = caught;
    }
    expect((error as NodeJS.ErrnoException).code).toBe(UNLINK_DIR_CODE);
    expect((error as Error).message).toContain(`${process.pid}.json`);
    // Les étapes suivantes ont tourné malgré l'échec : clé et socket retirés.
    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(registration.socketPath)).toBe(false);
    // Le drapeau n'est posé qu'après les étapes : un second appel ne refait rien et ne lève pas.
    expect(() => registration.unregister()).not.toThrow();
  });

  test("a failed registration rethrows the original error, not the rollback one, and rolls back the key and socket", async () => {
    // Un dossier à la place de <pid>.json : le renommage final échoue (EISDIR), puis le retrait de
    // l'entrée échoue aussi (UNLINK_DIR_CODE) pendant le rollback.
    mkdirSync(join(sessionsDir(), `${process.pid}.json`, "occupied"), { recursive: true });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    let error: unknown;
    let written = "";
    try {
      error = await registerPeer({ name: "codex-janus", cwd: "/w", onMessage: () => {} }).catch((caught: unknown) => caught);
      written = stderr.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      stderr.mockRestore();
    }
    expect((error as NodeJS.ErrnoException).code).toBe("EISDIR");
    expect(existsSync(join(socketsDir(), `${process.pid}.sock`))).toBe(false);
    expect(existsSync(join(sessionsDir(), keyFileName(process.pid, join(socketsDir(), `${process.pid}.sock`))))).toBe(false);
    expect(written).toContain("nettoyage incomplet");
    expect(written).toContain(UNLINK_DIR_CODE);
  });
});

describe("Registration.setStatus", () => {
  function liveEntry(): SessionEntry | undefined {
    return listLiveEntries().find((candidate) => candidate.pid === process.pid);
  }

  test("publishes busy then idle in the live entry and moves statusUpdatedAt and updatedAt", async () => {
    const registration = await register("codex-janus");
    const before = Date.now();
    registration.setStatus("busy");
    expect(liveEntry()).toMatchObject({ status: "busy" });
    expect(liveEntry()!.statusUpdatedAt).toBeGreaterThanOrEqual(before);
    expect(liveEntry()!.updatedAt).toBe(liveEntry()!.statusUpdatedAt);
    expect(registration.entry.status).toBe("busy");

    const beforeIdle = Date.now();
    registration.setStatus("idle");
    expect(liveEntry()).toMatchObject({ status: "idle" });
    expect(liveEntry()!.statusUpdatedAt).toBeGreaterThanOrEqual(beforeIdle);
  });

  test("keeps every other field of the entry", async () => {
    const registration = await register("codex-janus", "idema-1:@4.%6");
    const { status: _status, updatedAt: _updatedAt, statusUpdatedAt: _statusUpdatedAt, ...stable } = registration.entry;
    registration.setStatus("busy");
    expect(liveEntry()).toMatchObject(stable);
  });

  test("does nothing when the status is already the requested one", async () => {
    const registration = await register("codex-janus");
    const before = liveEntry()!;
    await Bun.sleep(5);
    registration.setStatus("idle");
    expect(liveEntry()).toEqual(before);
  });

  test("does not recreate the entry after unregister", async () => {
    const registration = await register("codex-janus");
    registration.unregister();
    registration.setStatus("busy");
    expect(existsSync(join(sessionsDir(), `${process.pid}.json`))).toBe(false);
    expect(listLiveEntries().some((entry) => entry.pid === process.pid)).toBe(false);
  });

  test("never throws when the write fails: logs status-write-error and keeps the old status", async () => {
    const registration = await register("codex-janus");
    const entryPath = join(sessionsDir(), `${process.pid}.json`);
    // Un dossier non vide à la place de l'entrée : le renommage final de writeEntry échoue.
    unlinkSync(entryPath);
    mkdirSync(join(entryPath, "occupied"), { recursive: true });
    expect(() => registration.setStatus("busy")).not.toThrow();
    const log = readFileSync(join(tempDirs[2]!, "logs", "idnma.log"), "utf8");
    expect(log).toContain('"event":"status-write-error"');
    expect(log).toContain('"message"');
    expect(registration.entry.status).toBe("idle");
    // Remet un fichier ordinaire à la place du dossier pour que le unregister du afterEach passe.
    rmSync(entryPath, { recursive: true, force: true });
  });
});

describe("claudeVersion", () => {
  test("compares versions numerically by segment", () => {
    const live = ["2.1.9", "2.1.310", "2.1.30"].map((version) => ({ version }) as SessionEntry);
    expect(claudeVersion(live)).toBe("2.1.310");
  });

  test("ignores entries without a usable version", () => {
    const live = [{ version: "" }, {}, { version: "2.1.4" }].map((partial) => partial as SessionEntry);
    expect(claudeVersion(live)).toBe("2.1.4");
  });
});
