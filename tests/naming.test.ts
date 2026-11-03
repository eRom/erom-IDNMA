import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { procStart } from "../src/bus/proc.ts";
import { writeEntry, type SessionEntry } from "../src/bus/registry.ts";
import { chooseName, withNameLock } from "../src/naming/choose.ts";
import { acquireLock, withLock } from "../src/naming/lock.ts";
import { ROMAN_DEITIES, nickname } from "../src/naming/nicknames.ts";

const VALID_NAME = /^[A-Za-z0-9_-]+$/;

// Générateur déterministe : renvoie les valeurs fournies en boucle.
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

const ENV_KEYS = ["IDNMA_CLAUDE_DIR", "IDNMA_CONFIG_DIR", "IDNMA_LOCK_MAX_RETRIES", "IDNMA_LOCK_RETRY_MS"] as const;
let previousEnv: Record<string, string | undefined>;
let claudeDir: string;
let configDir: string;
let sleeper: ReturnType<typeof Bun.spawn>;
let deadSleeper: ReturnType<typeof Bun.spawn>;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  claudeDir = mkdtempSync("/tmp/idnma-t-");
  configDir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CLAUDE_DIR = claudeDir;
  process.env.IDNMA_CONFIG_DIR = configDir;
  sleeper = Bun.spawn(["sleep", "600"]);
  deadSleeper = Bun.spawn(["sleep", "600"]);
});

afterEach(() => {
  sleeper.kill();
  deadSleeper.kill();
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function makeEntry(pid: number, start: string, name: string): SessionEntry {
  return {
    pid,
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: "/tmp/somewhere",
    startedAt: 1_700_000_000_000,
    procStart: start,
    version: "2.1.310",
    peerProtocol: 1,
    peerFeatures: ["notify_idle"],
    kind: "interactive",
    entrypoint: "cli",
    pidDomain: "darwin",
    messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
    name,
    nameSource: "user",
    nameSince: 1_700_000_000_001,
    status: "idle",
    updatedAt: 1_700_000_000_002,
    statusUpdatedAt: 1_700_000_000_003,
  };
}

function realStart(pid: number): string {
  const start = procStart(pid);
  if (start === undefined) throw new Error(`no procStart for pid ${pid}`);
  return start;
}

function writeLiveEntry(name: string): void {
  writeEntry(makeEntry(sleeper.pid, realStart(sleeper.pid), name));
}

describe("ROMAN_DEITIES", () => {
  test("strict ASCII: every deity forms a valid name", () => {
    for (const d of ROMAN_DEITIES) {
      expect(`claude-${d}`).toMatch(VALID_NAME);
    }
  });

  test("no duplicate in the pantheon", () => {
    expect(new Set(ROMAN_DEITIES).size).toBe(ROMAN_DEITIES.length);
  });
});

describe("nickname", () => {
  test("always serves <base>-<deity>-<4 base36>, even with a registry of live names", () => {
    expect(nickname("claude", { rand: seq(0, 0.5) })).toBe("claude-jupiter-i000");
    expect(nickname("claude", { taken: new Set(), rand: seq(0, 0.5) })).toBe("claude-jupiter-i000");
  });

  test("consecutive calls do not collide", () => {
    const names = new Set(Array.from({ length: 50 }, () => nickname("claude")));
    expect(names.size).toBe(50);
  });

  test("a name held by a live session is not served again", () => {
    const taken = new Set(["claude-jupiter-i000"]);
    expect(nickname("claude", { taken, rand: seq(0, 0.5, 0, 0.25) })).toBe("claude-jupiter-9000");
  });

  test("fails rather than serve a taken name when every draw collides", () => {
    expect(() => nickname("claude", { taken: new Set(["claude-jupiter-0000"]), rand: seq(0) })).toThrow("claude");
  });

  // Régression : une base issue d'un basename de dossier (`~/.claude`) donnait
  // `.claude-venus`, que tmux réécrit en `_claude-venus`.
  test("hostile base: the nickname stays valid and stable under tmux", () => {
    for (const base of [".claude", "foo.bar", "mon projet", "a:b", "séries", "..", "-x-"]) {
      expect(nickname(base, { taken: new Set() })).toMatch(VALID_NAME);
    }
    expect(nickname(".claude", { rand: seq(0) })).toBe("claude-jupiter-0000");
    expect(nickname("séries", { rand: seq(0) })).toBe("series-jupiter-0000");
  });

  test("every generated nickname is a valid name", () => {
    for (let i = 0; i < 30; i++) {
      expect(nickname("glm", { taken: new Set() })).toMatch(VALID_NAME);
    }
  });
});

// --- Verrou flock ----------------------------------------------------------

// flock externe : simule un verrou tenu par un AUTRE détenteur (autre fd, que
// flock exclut même au sein du process courant).
const libc = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";
const { symbols } = dlopen(libc, {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;

function holdLock(lockPath: string): () => void {
  const fd = openSync(lockPath, "a");
  if (symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    throw new Error("setup: cannot hold the external lock");
  }
  return () => {
    symbols.flock(fd, LOCK_UN);
    closeSync(fd);
  };
}

describe("withLock", () => {
  let target: string;

  afterEach(() => {
    rmSync(dirname(target), { recursive: true, force: true });
  });

  beforeEach(() => {
    target = join(mkdtempSync("/tmp/idnma-t-"), "data.txt");
  });

  test("runs the critical section then releases (reacquirable afterwards)", async () => {
    expect(await withLock(target, async () => 42)).toBe(42);
    expect(await withLock(target, async () => 7)).toBe(7);
  });

  test("releases the lock even when the critical section throws", async () => {
    await expect(withLock(target, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withLock(target, async () => "ok")).toBe("ok");
  });

  test("serialises concurrent accesses without loss", async () => {
    process.env.IDNMA_LOCK_MAX_RETRIES = "5000";
    process.env.IDNMA_LOCK_RETRY_MS = "1";
    writeFileSync(target, "0");
    const inc = () =>
      withLock(target, async () => {
        const n = Number(readFileSync(target, "utf8"));
        await new Promise((r) => setTimeout(r, 1));
        writeFileSync(target, String(n + 1));
      });
    await Promise.all(Array.from({ length: 20 }, inc));
    expect(Number(readFileSync(target, "utf8"))).toBe(20);
  });

  test("throws when the lock is already held by another holder", async () => {
    process.env.IDNMA_LOCK_MAX_RETRIES = "3";
    process.env.IDNMA_LOCK_RETRY_MS = "2";
    const release = holdLock(`${target}.lock`);
    try {
      await expect(withLock(target, async () => "never")).rejects.toThrow(/verrou des noms/);
    } finally {
      release();
    }
  });

  test("the default budget outlasts a holder that keeps the lock for two seconds", async () => {
    delete process.env.IDNMA_LOCK_MAX_RETRIES;
    delete process.env.IDNMA_LOCK_RETRY_MS;
    const releaseHolder = holdLock(`${target}.lock`);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseHolder();
    };
    const timer = setTimeout(release, 2000);
    try {
      expect(await withLock(target, async () => "late but served")).toBe("late but served");
    } finally {
      clearTimeout(timer);
      release();
    }
  }, 15_000);

  test("fails with a French message naming the lock file", async () => {
    process.env.IDNMA_LOCK_MAX_RETRIES = "2";
    process.env.IDNMA_LOCK_RETRY_MS = "1";
    const release = holdLock(`${target}.lock`);
    try {
      await expect(withLock(target, async () => "never")).rejects.toThrow(`Impossible d'obtenir le verrou des noms : ${target}.lock`);
    } finally {
      release();
    }
  });

  test("honours IDNMA_LOCK_MAX_RETRIES and IDNMA_LOCK_RETRY_MS (fast bounded failure)", async () => {
    process.env.IDNMA_LOCK_MAX_RETRIES = "2";
    process.env.IDNMA_LOCK_RETRY_MS = "1";
    const release = holdLock(`${target}.lock`);
    try {
      const start = Date.now();
      await expect(withLock(target, async () => "never")).rejects.toThrow(/verrou des noms/);
      expect(Date.now() - start).toBeLessThan(200);
    } finally {
      release();
    }
  });
});

describe("acquireLock", () => {
  let target: string;

  afterEach(() => {
    rmSync(dirname(target), { recursive: true, force: true });
  });

  beforeEach(() => {
    target = join(mkdtempSync("/tmp/idnma-t-"), "data.txt");
    process.env.IDNMA_LOCK_RETRY_MS = "2";
  });

  test("the returned function releases the lock, and releasing twice is harmless", async () => {
    const release = await acquireLock(target, { maxRetries: 3 });
    await expect(acquireLock(target, { maxRetries: 3 })).rejects.toThrow(/Impossible d'obtenir le verrou/);
    release();
    release();
    const again = await acquireLock(target, { maxRetries: 3 });
    again();
  });

  test("keeps the lock held after it resolves", async () => {
    const release = await acquireLock(target);
    let second = "pending";
    const waiting = acquireLock(target, { maxRetries: 5000 }).then((r) => {
      second = "acquired";
      return r;
    });
    await Bun.sleep(100);
    expect(second).toBe("pending");
    release();
    (await waiting)();
    expect(second).toBe("acquired");
  });

  test("an exhausted budget fails with the label and the lock file", async () => {
    const release = holdLock(`${target}.lock`);
    try {
      await expect(acquireLock(target, { maxRetries: 2, label: "d'adoption Codex" })).rejects.toThrow(
        `Impossible d'obtenir le verrou d'adoption Codex : ${target}.lock`,
      );
    } finally {
      release();
    }
  });

  test("an aborted signal rejects a pending wait and frees the descriptor", async () => {
    const release = holdLock(`${target}.lock`);
    try {
      const controller = new AbortController();
      const pending = acquireLock(target, { maxRetries: 5000, label: "d'adoption Codex", signal: controller.signal });
      // Le rejet est capturé sans `expect(...).rejects` : Bun attendrait la promesse avant de rendre la main.
      const outcome = pending.catch((error: unknown) => error);
      setTimeout(() => controller.abort(), 30);
      const start = Date.now();
      const failure = await outcome;
      expect((failure as Error).message).toBe("attente du verrou d'adoption Codex abandonnée");
      expect(Date.now() - start).toBeLessThan(500);
    } finally {
      release();
    }
    // Le verrou est libre : l'attente abandonnée n'a rien retenu.
    (await acquireLock(target, { maxRetries: 3 }))();
  });

  test("a signal already aborted rejects without taking the lock", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireLock(target, { signal: controller.signal })).rejects.toThrow("abandonnée");
    (await acquireLock(target, { maxRetries: 3 }))();
  });
});

// --- Noms uniques sur la machine -------------------------------------------

describe("withNameLock", () => {
  test("two concurrent sections never overlap", async () => {
    process.env.IDNMA_LOCK_MAX_RETRIES = "5000";
    process.env.IDNMA_LOCK_RETRY_MS = "1";
    let inside = 0;
    let maxInside = 0;
    const section = () =>
      withNameLock(async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 10));
        inside--;
      });
    await Promise.all([section(), section(), section()]);
    expect(maxInside).toBe(1);
  });

  test("creates the config directory when missing", async () => {
    process.env.IDNMA_CONFIG_DIR = join(process.env.IDNMA_CONFIG_DIR!, "nested", "idema");
    expect(await withNameLock(async () => "ok")).toBe("ok");
  });

  test("is exclusive against a holder of the names lock file", async () => {
    process.env.IDNMA_LOCK_MAX_RETRIES = "2";
    process.env.IDNMA_LOCK_RETRY_MS = "1";
    const release = holdLock(join(process.env.IDNMA_CONFIG_DIR!, "names.lock"));
    try {
      await expect(withNameLock(async () => "never")).rejects.toThrow(/verrou des noms/);
    } finally {
      release();
    }
  });
});

describe("chooseName", () => {
  // Tirages fixés : 0 donne jupiter et le suffixe 0000, 0.5 donne le suffixe i000.
  let random: ReturnType<typeof spyOn>;
  afterEach(() => random?.mockRestore());

  test("serves <base>-<deity>-<4 base36> and skips the name of a live session", () => {
    random = spyOn(Math, "random").mockImplementation(seq(0, 0.5, 0, 0));
    writeLiveEntry("claude-jupiter-i000");
    expect(chooseName("claude")).toBe("claude-jupiter-0000");
  });

  test("a dead entry does not block its name", async () => {
    writeEntry(makeEntry(deadSleeper.pid, realStart(deadSleeper.pid), "codex-jupiter-i000"));
    deadSleeper.kill();
    await deadSleeper.exited;
    random = spyOn(Math, "random").mockImplementation(seq(0, 0.5));
    expect(chooseName("codex")).toBe("codex-jupiter-i000");
  });

  test("an entry whose pid was reused by another process does not block its name", () => {
    writeEntry(makeEntry(sleeper.pid, "Thu Jan  1 00:00:00 1970", "codex-jupiter-i000"));
    random = spyOn(Math, "random").mockImplementation(seq(0, 0.5));
    expect(chooseName("codex")).toBe("codex-jupiter-i000");
  });
});
