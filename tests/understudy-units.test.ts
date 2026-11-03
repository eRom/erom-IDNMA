import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboundMessage } from "../src/bus/inbox.ts";
import { inferFromMode } from "../src/understudy/from-mode.ts";
import { MessageQueue } from "../src/understudy/queue.ts";

function message(index: number): InboundMessage {
  return { priority: "next", content: `message ${index}`, authenticated: true, receivedAt: index };
}

describe("MessageQueue", () => {
  test("accepts 50 messages, refuses the 51st and hands them back in arrival order", () => {
    const queue = new MessageQueue();
    for (let i = 0; i < 50; i++) expect(queue.push(message(i))).toBe(true);
    expect(queue.push(message(50))).toBe(false);
    expect(queue.size).toBe(50);
    for (let i = 0; i < 50; i++) expect(queue.shift()?.content).toBe(`message ${i}`);
    expect(queue.shift()).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  test("frees a slot once a message is shifted", () => {
    const queue = new MessageQueue(1);
    expect(queue.push(message(0))).toBe(true);
    expect(queue.push(message(1))).toBe(false);
    queue.shift();
    expect(queue.push(message(2))).toBe(true);
  });
});

describe("MessageQueue unshift", () => {
  test("queue unshift puts a message back at the head even when full", () => {
    const queue = new MessageQueue(2);
    queue.push(message(1));
    queue.push(message(2));
    expect(queue.push(message(3))).toBe(false);
    const back = message(0);
    queue.unshift(back);
    expect(queue.size).toBe(3);
    expect(queue.shift()).toBe(back);
    expect(queue.shift()?.content).toBe("message 1");
    expect(queue.shift()?.content).toBe("message 2");
  });
});

describe("MessageQueue first and remove", () => {
  function prioritized(content: string, priority: InboundMessage["priority"]): InboundMessage {
    return { priority, content, authenticated: true, receivedAt: 0 };
  }

  test("first finds the oldest match without removing it, remove drops that very message", () => {
    const queue = new MessageQueue();
    const a = prioritized("a", "later");
    const b = prioritized("b", "now");
    const c = prioritized("c", "now");
    for (const item of [a, b, c]) queue.push(item);

    expect(queue.first((m) => m.priority === "now")).toBe(b);
    expect(queue.size).toBe(3);
    expect(queue.remove(b)).toBe(true);
    expect(queue.size).toBe(2);
    expect(queue.first((m) => m.priority === "now")).toBe(c);
    expect(queue.shift()).toBe(a);
    expect(queue.shift()).toBe(c);
    expect(queue.remove(b)).toBe(false);
  });

  test("first returns undefined when nothing matches", () => {
    const queue = new MessageQueue();
    queue.push(prioritized("a", "later"));
    expect(queue.first((m) => m.priority === "now")).toBeUndefined();
  });

  test("remove works by identity, not by equal content, and frees a slot", () => {
    const queue = new MessageQueue(2);
    const twin = prioritized("same", "next");
    const other = prioritized("same", "next");
    queue.push(twin);
    queue.push(other);
    expect(queue.push(prioritized("late", "next"))).toBe(false);
    expect(queue.remove(other)).toBe(true);
    expect(queue.first(() => true)).toBe(twin);
    expect(queue.push(prioritized("late", "next"))).toBe(true);
  });
});

const prefsDirs: string[] = [];

afterEach(() => {
  for (const dir of prefsDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Dossier d'état de dst factice, sans `permission.json`. */
function emptyPrefsDir(): string {
  const dir = mkdtempSync("/tmp/idnma-t-");
  prefsDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Dossier d'état de dst factice dont `permission.json` contient `raw`. */
function prefsDirWith(raw: string): string {
  const dir = emptyPrefsDir();
  writeFileSync(join(dir, "permission.json"), raw);
  return dir;
}

describe("inferFromMode", () => {
  test("detects the bypass flag of each harness", () => {
    expect(inferFromMode("codex", ["--dangerously-bypass-approvals-and-sandbox"])).toBe("bypass");
    expect(inferFromMode("grok", ["--always-approve"])).toBe("bypass");
    expect(inferFromMode("agy", ["--dangerously-skip-permissions"])).toBe("bypass");
  });

  test("stays prompting without the flag", () => {
    expect(inferFromMode("agy", ["--model", "gemini-4-argon-medium"])).toBe("prompting");
  });

  test("ignores the bypass flag of another harness", () => {
    expect(inferFromMode("grok", ["--dangerously-skip-permissions"])).toBe("prompting");
  });

  test("dst reads the permission mode from the environment, not from a flag", () => {
    const prefsDir = emptyPrefsDir();
    expect(inferFromMode("dst", [], { DSH_PERMISSION_MODE: "danger-full-access" }, prefsDir)).toBe("bypass");
    expect(inferFromMode("dst", [], { DSH_PERMISSION_MODE: "workspace-write" }, prefsDir)).toBe("prompting");
    expect(inferFromMode("dst", [], {}, prefsDir)).toBe("prompting");
  });

  test("a flag of another harness does not make a dst bypass", () => {
    expect(inferFromMode("dst", ["--dangerously-bypass-approvals-and-sandbox", "--always-approve", "--auto"], {}, emptyPrefsDir())).toBe("prompting");
  });

  describe("dst remembered permission", () => {
    test("an explicit DSH_PERMISSION_MODE outranks the remembered preset, both ways", () => {
      const remembersFull = prefsDirWith(JSON.stringify({ permission: "danger-full-access" }));
      expect(inferFromMode("dst", [], { DSH_PERMISSION_MODE: "workspace-write" }, remembersFull)).toBe("prompting");
      const remembersSandbox = prefsDirWith(JSON.stringify({ permission: "workspace-write" }));
      expect(inferFromMode("dst", [], { DSH_PERMISSION_MODE: "danger-full-access" }, remembersSandbox)).toBe("bypass");
    });

    test("without the variable, a remembered danger-full-access is a bypass (value trimmed)", () => {
      expect(inferFromMode("dst", [], {}, prefsDirWith(JSON.stringify({ permission: "danger-full-access" })))).toBe("bypass");
      expect(inferFromMode("dst", [], { DSH_PERMISSION_MODE: "" }, prefsDirWith(JSON.stringify({ permission: " danger-full-access\n" })))).toBe("bypass");
    });

    test("another remembered preset stays prompting", () => {
      expect(inferFromMode("dst", [], {}, prefsDirWith(JSON.stringify({ permission: "workspace-write" })))).toBe("prompting");
    });

    test("a missing, corrupt or oddly shaped file means no preference", () => {
      expect(inferFromMode("dst", [], {}, emptyPrefsDir())).toBe("prompting");
      expect(inferFromMode("dst", [], {}, prefsDirWith("{ not json"))).toBe("prompting");
      expect(inferFromMode("dst", [], {}, prefsDirWith("null"))).toBe("prompting");
      expect(inferFromMode("dst", [], {}, prefsDirWith(JSON.stringify({ permission: 42 })))).toBe("prompting");
      expect(inferFromMode("dst", [], {}, join(emptyPrefsDir(), "absent"))).toBe("prompting");
    });

    test("the flag harnesses never read the file", () => {
      expect(inferFromMode("codex", [], {}, prefsDirWith(JSON.stringify({ permission: "danger-full-access" })))).toBe("prompting");
    });
  });

  test("the environment does not affect the flag harnesses", () => {
    expect(inferFromMode("codex", [], { DSH_PERMISSION_MODE: "danger-full-access" })).toBe("prompting");
    expect(inferFromMode("codex", ["--dangerously-bypass-approvals-and-sandbox"], {})).toBe("bypass");
  });
});
