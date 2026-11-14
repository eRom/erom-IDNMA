import { describe, expect, test } from "bun:test";
import type { Engine } from "../src/config/network.ts";
import { adapterBinary, buildLaunchPlan, CLAUDE_SESSION_SETTINGS, internalSessionName, PEER_INSTRUCTION, pickLatestSession } from "../src/acp/harness.ts";
import { nameFormatProblem } from "../src/naming/choose.ts";
import { UsageError } from "../src/run/args.ts";

const opus: Engine = { harness: "claude", model: "opus", options: ["--effort", "medium", "--dangerously-skip-permissions", "--remote-control"], env: {} };
const argon: Engine = { harness: "agy", model: "gemini-4-argon", options: ["--effort", "medium", "--dangerously-skip-permissions", "--remote-control"], env: {} };

function claudePlan(o: { engine?: Engine; passthrough?: string[]; env?: Record<string, string> } = {}) {
  return buildLaunchPlan({
    harness: "claude",
    binary: "/bin/caa",
    engine: o.engine ?? opus,
    passthrough: o.passthrough ?? [],
    name: "opus-mars-ab12",
    env: o.env ?? {},
    claudeExecutable: "/bin/claude",
  });
}

function agyPlan(o: { engine?: Engine; passthrough?: string[] } = {}) {
  return buildLaunchPlan({ harness: "agy", binary: "/bin/agy", engine: o.engine ?? argon, passthrough: o.passthrough ?? [], name: "argon-mars-ab12", env: {} });
}

function extraArgsOf(meta: Record<string, unknown> | undefined): Record<string, string | null> {
  return (meta as any).claudeCode.options.extraArgs;
}

describe("claude launch plan", () => {
  test("claude engine becomes config steps, never extraArgs for model, effort or permissions", () => {
    const plan = claudePlan();
    expect(plan.configSteps).toEqual([
      { category: "model", value: "opus", origin: "--model opus" },
      { category: "thought_level", value: "medium", origin: "--effort medium" },
      { category: "mode", value: "bypassPermissions", origin: "--dangerously-skip-permissions" },
    ]);
    expect(plan.ignored).toEqual(["--remote-control"]);
    const extra = extraArgsOf(plan.newSessionMeta);
    expect(extra.name).toBe("opus-mars-ab12-acp");
    expect(JSON.parse(extra.settings as string)).toEqual({ crossSessionInbound: "refuse", permissions: { deny: ["ListAgents"] } });
    expect(extra.model).toBeUndefined();
    expect(extra.effort).toBeUndefined();
    expect((plan.newSessionMeta as any).systemPrompt.append).toBe(PEER_INSTRUCTION);
    expect(plan.env.CLAUDE_CODE_EXECUTABLE).toBe("/bin/claude");
    expect(plan.delivery).toBe("auto");
    expect(plan.harness).toBe("claude");
    expect(plan.label).toBe("Claude");
    expect(plan.argv).toEqual(["/bin/caa"]);
    expect(plan.resume).toEqual({ kind: "new" });
  });

  test("the session settings are the exported constant, serialized once", () => {
    expect(JSON.parse(extraArgsOf(claudePlan().newSessionMeta).settings as string)).toEqual(CLAUDE_SESSION_SETTINGS);
  });

  test("other flags go to extraArgs, with or without a value, in both spellings", () => {
    const plan = claudePlan({ passthrough: ["--verbose", "--max-turns", "3", "--betas=x", "--add-dir=/w"] });
    const extra = extraArgsOf(plan.newSessionMeta);
    expect(extra.verbose).toBeNull();
    expect(extra["max-turns"]).toBe("3");
    expect(extra.betas).toBe("x");
    expect(extra["add-dir"]).toBe("/w");
    expect(plan.ignored).toEqual(["--remote-control"]);
  });

  test("a repeated extraArgs flag keeps the last value and announces each earlier one as typed", () => {
    const plan = claudePlan({
      engine: { harness: "claude", options: [], env: {} },
      passthrough: ["--add-dir", "/a", "--add-dir=/b", "--verbose", "--add-dir", "/c", "--verbose"],
    });
    expect(extraArgsOf(plan.newSessionMeta)["add-dir"]).toBe("/c");
    expect(extraArgsOf(plan.newSessionMeta).verbose).toBeNull();
    expect(plan.ignored).toEqual(["--add-dir /a", "--add-dir=/b", "--verbose"]);
    expect(extraArgsOf(plan.loadSessionMeta)["add-dir"]).toBe("/c");
  });

  test("flags the adapter owns or that make no sense in a screen are ignored with their value", () => {
    const plan = claudePlan({
      engine: { harness: "claude", options: [], env: {} },
      passthrough: ["--name", "foo", "-n", "bar", "--permission-mode=plan", "--output-format", "json", "-p", "--fork-session", "--settings", "{}", "stray"],
    });
    expect(plan.ignored).toEqual(["--name foo", "-n bar", "--permission-mode=plan", "--output-format json", "-p", "--fork-session", "--settings {}", "stray"]);
    const extra = extraArgsOf(plan.newSessionMeta);
    expect(extra.name).toBe("opus-mars-ab12-acp");
    expect(JSON.parse(extra.settings as string)).toEqual(CLAUDE_SESSION_SETTINGS);
    expect(plan.configSteps).toEqual([]);
  });

  test("a typed flag replaces the engine one", () => {
    const plan = claudePlan({ passthrough: ["--effort", "high"] });
    expect(plan.configSteps.filter((s) => s.category === "thought_level")).toEqual([{ category: "thought_level", value: "high", origin: "--effort high" }]);
  });

  test("--effort=value is read as --effort value", () => {
    const plan = claudePlan({ passthrough: ["--effort=high", "--model=sonnet"] });
    expect(plan.configSteps[0]).toEqual({ category: "model", value: "sonnet", origin: "--model sonnet" });
    expect(plan.configSteps[1]).toEqual({ category: "thought_level", value: "high", origin: "--effort high" });
  });

  test("resume flags select the resume request, and the resumed claude session keeps its name", () => {
    const cont = claudePlan({ passthrough: ["-c"] });
    expect(cont.resume).toEqual({ kind: "continue" });
    expect(extraArgsOf(cont.loadSessionMeta).name).toBeUndefined();
    expect(JSON.parse(extraArgsOf(cont.loadSessionMeta).settings as string)).toEqual(CLAUDE_SESSION_SETTINGS);
    expect((cont.loadSessionMeta as any).systemPrompt.append).toBe(PEER_INSTRUCTION);

    expect(claudePlan({ passthrough: ["--continue"] }).resume).toEqual({ kind: "continue" });
    expect(claudePlan({ passthrough: ["--resume=abc"] }).resume).toEqual({ kind: "id", id: "abc" });
    expect(claudePlan({ passthrough: ["--resume", "abc"] }).resume).toEqual({ kind: "id", id: "abc" });
    expect(claudePlan({ passthrough: ["-r", "abc"] }).resume).toEqual({ kind: "id", id: "abc" });
  });

  test("a fresh claude session carries the name, the resumed one does not", () => {
    const fresh = claudePlan();
    expect(extraArgsOf(fresh.newSessionMeta).name).toBe("opus-mars-ab12-acp");
    const resumed = claudePlan({ passthrough: ["--resume", "abc"] });
    expect("name" in extraArgsOf(resumed.loadSessionMeta)).toBe(false);
  });

  test("--resume without an id is a usage error", () => {
    expect(() => claudePlan({ passthrough: ["-r"] })).toThrow(UsageError);
    expect(() => claudePlan({ passthrough: ["--resume"] })).toThrow(UsageError);
    expect(() => claudePlan({ passthrough: ["--resume", "--effort", "high"] })).toThrow(UsageError);
    expect(() => claudePlan({ passthrough: ["--resume="] })).toThrow(UsageError);
  });
});

describe("env handling", () => {
  test("an env that fixes CLAUDE_CODE_EXECUTABLE wins over the PATH claude", () => {
    expect(claudePlan({ env: { CLAUDE_CODE_EXECUTABLE: "/x" } }).env.CLAUDE_CODE_EXECUTABLE).toBe("/x");
  });

  test("the received env is copied, never mutated", () => {
    const env = { A: "1" };
    const plan = claudePlan({ env });
    expect(env).toEqual({ A: "1" });
    expect(plan.env).toEqual({ A: "1", CLAUDE_CODE_EXECUTABLE: "/bin/claude" });
    expect(plan.env).not.toBe(env);
  });

  test("without a claude executable and no env value, nothing is set", () => {
    const plan = buildLaunchPlan({ harness: "claude", binary: "/bin/caa", engine: opus, passthrough: [], name: "n", env: {} });
    expect("CLAUDE_CODE_EXECUTABLE" in plan.env).toBe(false);
  });

  test("agy gets the env as is", () => {
    const plan = buildLaunchPlan({ harness: "agy", binary: "/bin/agy", engine: argon, passthrough: [], name: "n", env: { A: "1" }, claudeExecutable: "/bin/claude" });
    expect(plan.env).toEqual({ A: "1" });
  });
});

describe("agy launch plan", () => {
  test("agy engine: effort becomes thought_level, skip-permissions goes to agy acp", () => {
    const plan = agyPlan();
    expect(plan.argv).toEqual(["/bin/agy", "acp", "--dangerously-skip-permissions"]);
    expect(plan.configSteps).toEqual([
      { category: "model", value: "gemini-4-argon", origin: "--model gemini-4-argon" },
      { category: "thought_level", value: "medium", origin: "--effort medium" },
    ]);
    expect(plan.ignored).toEqual(["--remote-control"]);
    expect(plan.delivery).toBe("held");
    expect(plan.label).toBe("agy");
    expect(plan.newSessionMeta).toBeUndefined();
    expect(plan.loadSessionMeta).toBeUndefined();
  });

  test("agent, add-dir (repeatable) and sandbox go to agy acp; unknown flags are ignored", () => {
    const plan = agyPlan({
      engine: { harness: "agy", options: [], env: {} },
      passthrough: ["--agent", "reviewer", "--add-dir=/a", "--add-dir", "/b", "--sandbox", "--weird", "pos"],
    });
    expect(plan.argv).toEqual(["/bin/agy", "acp", "--agent", "reviewer", "--add-dir", "/a", "--add-dir", "/b", "--sandbox"]);
    expect(plan.ignored).toEqual(["--weird", "pos"]);
  });

  test("agy takes resume flags too", () => {
    expect(agyPlan({ passthrough: ["-c"] }).resume).toEqual({ kind: "continue" });
    expect(agyPlan({ passthrough: ["--resume", "s1"] }).resume).toEqual({ kind: "id", id: "s1" });
    expect(() => agyPlan({ passthrough: ["--resume"] })).toThrow(UsageError);
  });
});

describe("helpers", () => {
  test("adapterBinary names the program of each harness", () => {
    expect(adapterBinary("claude")).toBe("claude-agent-acp");
    expect(adapterBinary("agy")).toBe("agy");
  });

  test("the internal session name stays a valid bus name", () => {
    const long = "a".repeat(64);
    expect(internalSessionName(long).length).toBe(64);
    expect(internalSessionName(long).endsWith("-acp")).toBe(true);
    expect(nameFormatProblem(internalSessionName(long))).toBeUndefined();
    expect(internalSessionName("opus-mars-ab12")).toBe("opus-mars-ab12-acp");
    expect(internalSessionName("a".repeat(60))).toBe(`${"a".repeat(60)}-acp`);
    expect(internalSessionName("a".repeat(61)).length).toBe(64);
  });

  test("pickLatestSession filters by folder and sorts by updatedAt", () => {
    const sessions = [
      { sessionId: "old", cwd: "/w", updatedAt: "2026-11-14T10:00:00Z" },
      { sessionId: "other", cwd: "/elsewhere", updatedAt: "2026-11-14T12:00:00Z" },
      { sessionId: "new", cwd: "/w", updatedAt: "2026-11-14T11:00:00Z" },
      { sessionId: "undated", cwd: "/w" },
    ];
    expect(pickLatestSession(sessions, "/w")).toBe("new");
    expect(pickLatestSession(sessions, "/none")).toBeUndefined();
    expect(pickLatestSession([{ sessionId: "undated", cwd: "/w", updatedAt: null }], "/w")).toBe("undated");
    expect(pickLatestSession([], "/w")).toBeUndefined();
  });
});
