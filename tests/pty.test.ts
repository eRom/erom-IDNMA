import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { spawnUnderPty, type PtyChild } from "../src/understudy/pty.ts";

const childTest = (title: string, body: () => Promise<void>): void => test(title, body, { timeout: 15_000 });

/** stdin et stdout factices : ni TTY, ni vraie console, 80x24. */
function fakeStreams(): { stdin: PassThrough & NodeJS.ReadStream; stdout: PassThrough & NodeJS.WriteStream; output: () => string } {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(stdin, { isTTY: false });
  Object.assign(stdout, { columns: 80, rows: 24 });
  let collected = "";
  stdout.on("data", (chunk: Buffer) => {
    collected += chunk.toString("utf8");
  });
  return { stdin, stdout, output: () => collected };
}

async function waitFor(condition: () => boolean, label: string, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const READ_LINE = ["/bin/sh", "-c", "read line; printf 'got:%s' \"$line\""];

describe("spawnUnderPty", () => {
  childTest("relays child output to stdout", async () => {
    const streams = fakeStreams();
    const child = spawnUnderPty({ argv: ["/bin/sh", "-c", "printf ready"], env: { PATH: process.env.PATH ?? "" }, stdin: streams.stdin, stdout: streams.stdout });
    try {
      expect(await child.process.exited).toBe(0);
      await waitFor(() => streams.output().includes("ready"), "relayed output");
    } finally {
      child.release();
    }
  });

  childTest("settle keeps the last output of an exited child when the PTY is released right after", async () => {
    // Sous Linux, ce dernier bloc arrive après `exited` : fermer aussitôt le PTY le perdait.
    const streams = fakeStreams();
    const child = spawnUnderPty({ argv: READ_LINE, env: { PATH: process.env.PATH ?? "" }, stdin: streams.stdin, stdout: streams.stdout });
    child.terminal.write("bye\r");
    expect(await child.process.exited).toBe(0);
    await child.settle();
    child.release();
    await waitFor(() => streams.output().includes("got:bye"), "last output kept");
  });

  childTest("terminal writes reach the child", async () => {
    const streams = fakeStreams();
    const child = spawnUnderPty({ argv: READ_LINE, env: { PATH: process.env.PATH ?? "" }, stdin: streams.stdin, stdout: streams.stdout });
    try {
      child.terminal.write("hello\r");
      await waitFor(() => streams.output().includes("got:hello"), "echoed line");
      expect(await child.process.exited).toBe(0);
    } finally {
      child.release();
    }
  });

  childTest("stdin chunks reach input listeners and the child", async () => {
    const streams = fakeStreams();
    const child = spawnUnderPty({ argv: READ_LINE, env: { PATH: process.env.PATH ?? "" }, stdin: streams.stdin, stdout: streams.stdout });
    const received: string[] = [];
    child.terminal.onInput((chunk) => received.push(chunk));
    try {
      streams.stdin.write("abc\r");
      await waitFor(() => streams.output().includes("got:abc"), "echoed line");
      expect(received.join("")).toBe("abc\r");
    } finally {
      child.release();
    }
  });

  childTest("a multibyte character split across two chunks reaches listeners intact", async () => {
    const streams = fakeStreams();
    const child = spawnUnderPty({ argv: ["/bin/sh", "-c", "sleep 5"], env: { PATH: process.env.PATH ?? "" }, stdin: streams.stdin, stdout: streams.stdout });
    const received: string[] = [];
    child.terminal.onInput((chunk) => received.push(chunk));
    try {
      const bytes = Buffer.from("é", "utf8");
      streams.stdin.write(bytes.subarray(0, 1));
      await Bun.sleep(30);
      streams.stdin.write(bytes.subarray(1));
      await waitFor(() => received.join("") === "é", "decoded character");
    } finally {
      child.process.kill("SIGKILL");
      await child.process.exited;
      child.release();
    }
  });

  childTest("an unsubscribed listener no longer receives input", async () => {
    const streams = fakeStreams();
    const child = spawnUnderPty({ argv: ["/bin/sh", "-c", "sleep 5"], env: { PATH: process.env.PATH ?? "" }, stdin: streams.stdin, stdout: streams.stdout });
    const received: string[] = [];
    const unsubscribe = child.terminal.onInput((chunk) => received.push(chunk));
    try {
      streams.stdin.write("a");
      await waitFor(() => received.length === 1, "first chunk");
      unsubscribe();
      streams.stdin.write("b");
      await Bun.sleep(100);
      expect(received.join("")).toBe("a");
    } finally {
      child.process.kill("SIGKILL");
      await child.process.exited;
      child.release();
    }
  });

  childTest("release is idempotent and detaches stdin", async () => {
    const streams = fakeStreams();
    const before = { data: streams.stdin.listenerCount("data"), resize: streams.stdout.listenerCount("resize") };
    const child: PtyChild = spawnUnderPty({ argv: ["/bin/sh", "-c", "printf done"], env: { PATH: process.env.PATH ?? "" }, stdin: streams.stdin, stdout: streams.stdout });
    expect(streams.stdin.listenerCount("data")).toBeGreaterThan(before.data);
    await child.process.exited;
    expect(() => {
      child.release();
      child.release();
    }).not.toThrow();
    expect(streams.stdin.listenerCount("data")).toBe(before.data);
    expect(streams.stdout.listenerCount("resize")).toBe(before.resize);
  });

  childTest("release runs every step even when setRawMode throws", async () => {
    // Le journal de l'échec va dans un dossier temporaire, jamais dans la config de l'utilisateur.
    const logDir = mkdtempSync("/tmp/idnma-t-");
    const savedConfigDir = process.env.IDNMA_CONFIG_DIR;
    process.env.IDNMA_CONFIG_DIR = logDir;
    try {
      await releaseWithFailingRawMode();
      const logPath = join(logDir, "logs", "idnma.log");
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, "utf8")).toContain('"event":"pty-release-error"');
    } finally {
      if (savedConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
      else process.env.IDNMA_CONFIG_DIR = savedConfigDir;
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  async function releaseWithFailingRawMode(): Promise<void> {
    const streams = fakeStreams();
    let failRawMode = false;
    Object.assign(streams.stdin, {
      isTTY: true,
      isRaw: false,
      setRawMode: () => {
        if (failRawMode) throw new Error("tty disparu");
        return streams.stdin;
      },
    });
    const before = { data: streams.stdin.listenerCount("data"), resize: streams.stdout.listenerCount("resize") };
    const child = spawnUnderPty({ argv: ["/bin/sh", "-c", "printf done"], env: { PATH: process.env.PATH ?? "" }, stdin: streams.stdin, stdout: streams.stdout });
    await child.process.exited;
    expect(streams.stdin.isPaused()).toBe(false);
    failRawMode = true;
    expect(() => child.release()).not.toThrow();
    // Les étapes après l'échec ont tourné : désabonnements, pause de stdin.
    expect(streams.stdin.listenerCount("data")).toBe(before.data);
    expect(streams.stdout.listenerCount("resize")).toBe(before.resize);
    expect(streams.stdin.isPaused()).toBe(true);
  }

  test("an empty argv is refused", () => {
    const streams = fakeStreams();
    expect(() => spawnUnderPty({ argv: [], env: {}, stdin: streams.stdin, stdout: streams.stdout })).toThrow("idnma : ");
  });
});
