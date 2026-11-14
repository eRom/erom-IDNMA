import { describe, expect, test } from "bun:test";
import type { Engine } from "../src/config/network.ts";
import { buildLaunchPlan, CLAUDE_SESSION_SETTINGS, HARNESS_PROFILES, internalSessionName, PEER_INSTRUCTION, pickLatestSession } from "../src/acp/harness.ts";
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
    agentExecutable: "/bin/claude",
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
    const plan = buildLaunchPlan({ harness: "agy", binary: "/bin/agy", engine: argon, passthrough: [], name: "n", env: { A: "1" }, agentExecutable: "/bin/claude" });
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

const luna: Engine = { harness: "codex", model: "gpt-6-luna", options: ["--dangerously-bypass-approvals-and-sandbox"], env: {} };
const grokEngine: Engine = { harness: "grok", model: "grok-4.7", options: ["--effort", "high", "--always-approve"], env: {} };
const piEngine: Engine = { harness: "pi", model: "ollama/deepseek-v4.1-flash:cloud", options: ["--thinking", "high"], env: {} };
const oc: Engine = { harness: "opencode", model: "ollama-cloud/deepseek-v4.1-flash", options: ["--auto"], env: {} };
const dstEngine: Engine = { harness: "dst", options: [], env: { DSH_PERMISSION_MODE: "danger-full-access" } };

function plan(harness: "opencode" | "codex" | "grok" | "pi" | "dst", binary: string, engine: Engine, passthrough: string[] = [], env: Record<string, string> = {}, agentExecutable?: string) {
  return buildLaunchPlan({ harness, binary, engine, passthrough, name: "n-mars-ab12", env, ...(agentExecutable === undefined ? {} : { agentExecutable }) });
}

describe("opencode launch plan", () => {
  test("opencode plan: acp argv, engine model step, auto-approve", () => {
    const p = buildLaunchPlan({ harness: "opencode", binary: "/bin/opencode", engine: oc, passthrough: [], name: "deepseek-flash-mars-ab12", env: {} });
    expect(p.argv).toEqual(["/bin/opencode", "acp"]);
    expect(p.configSteps).toEqual([{ category: "model", value: "ollama-cloud/deepseek-v4.1-flash", origin: "model: ollama-cloud/deepseek-v4.1-flash" }]);
    expect(p.autoApprove).toBe(true);
    expect(p.peerMode).toEqual({ kind: "fixed", mode: "bypass" });
    expect(p.label).toBe("opencode");
    expect(p.delivery).toBe("auto");
  });

  test("opencode typed -m replaces the engine model; -s resumes by id", () => {
    const p = plan("opencode", "/bin/opencode", oc, ["-m", "openrouter/qwen/qwen3.8-flash", "-s", "ses_abc"]);
    expect(p.configSteps).toEqual([{ category: "model", value: "openrouter/qwen/qwen3.8-flash", origin: "--model openrouter/qwen/qwen3.8-flash" }]);
    expect(p.resume).toEqual({ kind: "id", id: "ses_abc" });
    expect(p.ignored).toEqual([]);
  });

  test("opencode --agent becomes a mode step", () => {
    const p = plan("opencode", "/bin/opencode", oc, ["--agent", "plan"]);
    expect(p.configSteps).toContainEqual({ category: "mode", value: "plan", origin: "--agent plan" });
  });

  test("opencode without --auto prompts, and -c continues", () => {
    const p = plan("opencode", "/bin/opencode", { harness: "opencode", options: [], env: {} }, ["-c"]);
    expect(p.autoApprove).toBe(false);
    expect(p.peerMode).toEqual({ kind: "fixed", mode: "prompting" });
    expect(p.resume).toEqual({ kind: "continue" });
    expect(p.configSteps).toEqual([]);
  });

  test("opencode announces what the screen cannot honour, without a usage error", () => {
    const p = plan("opencode", "/bin/opencode", { harness: "opencode", options: [], env: {} }, ["--print-logs", "-s"]);
    expect(p.ignored).toEqual(["--print-logs", "-s"]);
    expect(p.resume).toEqual({ kind: "new" });
  });
});

describe("codex launch plan", () => {
  test("codex plan: CODEX_PATH from the agent executable, bypass as mode step", () => {
    const p = buildLaunchPlan({ harness: "codex", binary: "/bin/codex-acp", engine: luna, passthrough: [], name: "luna-mars-ab12", env: {}, agentExecutable: "/opt/homebrew/bin/codex" });
    expect(p.argv).toEqual(["/bin/codex-acp"]);
    expect(p.env.CODEX_PATH).toBe("/opt/homebrew/bin/codex");
    expect(p.configSteps).toEqual([
      { category: "model", value: "gpt-6-luna", origin: "--model gpt-6-luna" },
      { category: "mode", value: "agent-full-access", origin: "--dangerously-bypass-approvals-and-sandbox" },
    ]);
    expect(p.peerMode).toEqual({ kind: "option", bypassValue: "agent-full-access" });
    expect(p.autoApprove).toBe(false);
    expect(p.label).toBe("Codex");
  });

  test("codex keeps an engine CODEX_PATH", () => {
    const p = plan("codex", "/bin/codex-acp", luna, [], { CODEX_PATH: "/x/codex" }, "/opt/homebrew/bin/codex");
    expect(p.env.CODEX_PATH).toBe("/x/codex");
  });

  test("codex resume --last continues, resume <id> loads that id", () => {
    const last = plan("codex", "/bin/codex-acp", luna, ["resume", "--last"]);
    expect(last.resume).toEqual({ kind: "continue" });
    expect(last.ignored).not.toContain("resume");
    expect(last.ignored).not.toContain("--last");
    const byId = plan("codex", "/bin/codex-acp", luna, ["resume", "01a1"]);
    expect(byId.resume).toEqual({ kind: "id", id: "01a1" });
    expect(byId.ignored).toEqual([]);
  });

  test("codex -c is announced, not a resume", () => {
    const p = plan("codex", "/bin/codex-acp", luna, ["-c", "model=x"]);
    expect(p.resume).toEqual({ kind: "new" });
    expect(p.ignored).toContain("-c model=x");
  });

  test("codex bare resume and bare --last are announced", () => {
    const bare = plan("codex", "/bin/codex-acp", luna, ["resume"]);
    expect(bare.resume).toEqual({ kind: "new" });
    expect(bare.ignored).toEqual(["resume"]);
    const last = plan("codex", "/bin/codex-acp", luna, ["--last"]);
    expect(last.resume).toEqual({ kind: "new" });
    expect(last.ignored).toEqual(["--last"]);
  });
});

describe("grok launch plan", () => {
  test("grok plan: always-approve before stdio, model and effort as steps", () => {
    const p = buildLaunchPlan({ harness: "grok", binary: "/bin/grok", engine: grokEngine, passthrough: [], name: "grok-mars-ab12", env: {} });
    expect(p.argv).toEqual(["/bin/grok", "agent", "--no-leader", "--always-approve", "stdio"]);
    expect(p.configSteps.map((s) => [s.category, s.value])).toEqual([
      ["model", "grok-4.7"],
      ["thought_level", "high"],
    ]);
    expect(p.peerMode).toEqual({ kind: "fixed", mode: "bypass" });
    expect(p.autoApprove).toBe(true);
  });

  test("grok without --always-approve prompts", () => {
    const p = plan("grok", "/bin/grok", { harness: "grok", options: [], env: {} });
    expect(p.argv).toEqual(["/bin/grok", "agent", "--no-leader", "stdio"]);
    expect(p.peerMode).toEqual({ kind: "fixed", mode: "prompting" });
    expect(p.autoApprove).toBe(false);
  });

  test("grok bare -r continues, -r <id> resumes that id", () => {
    const engine: Engine = { harness: "grok", options: [], env: {} };
    expect(plan("grok", "/bin/grok", engine, ["-r"]).resume).toEqual({ kind: "continue" });
    expect(plan("grok", "/bin/grok", engine, ["-r", "01a1db96"]).resume).toEqual({ kind: "id", id: "01a1db96" });
  });

  test("grok -s names a new session and is announced", () => {
    const p = plan("grok", "/bin/grok", { harness: "grok", options: [], env: {} }, ["-s", "0000-uuid"]);
    expect(p.resume).toEqual({ kind: "new" });
    expect(p.ignored).toContain("-s 0000-uuid");
  });
});

describe("pi launch plan", () => {
  test("pi plan: thinking as effort step, peer mode bypass", () => {
    const p = plan("pi", "/bin/pi-acp", piEngine);
    expect(p.argv).toEqual(["/bin/pi-acp"]);
    expect(p.configSteps.map((s) => [s.category, s.value])).toEqual([
      ["model", "ollama/deepseek-v4.1-flash:cloud"],
      ["thought_level", "high"],
    ]);
    expect(p.peerMode).toEqual({ kind: "fixed", mode: "bypass" });
    expect(p.label).toBe("Pi");
  });

  test("pi -r is announced", () => {
    const p = plan("pi", "/bin/pi-acp", { harness: "pi", options: [], env: {} }, ["-r"]);
    expect(p.resume).toEqual({ kind: "new" });
    expect(p.ignored).toEqual(["-r"]);
  });

  test("pi -c continues and --session resumes by id", () => {
    const engine: Engine = { harness: "pi", options: [], env: {} };
    expect(plan("pi", "/bin/pi-acp", engine, ["-c"]).resume).toEqual({ kind: "continue" });
    expect(plan("pi", "/bin/pi-acp", engine, ["--session", "abc"]).resume).toEqual({ kind: "id", id: "abc" });
  });
});

describe("dst launch plan", () => {
  test("dst plan: profile acp, peer mode from DSH_PERMISSION_MODE", () => {
    const p = buildLaunchPlan({ harness: "dst", binary: "/bin/dsh", engine: dstEngine, passthrough: [], name: "deepseek-flash-mars-ab12", env: { DSH_PERMISSION_MODE: "danger-full-access" } });
    expect(p.argv).toEqual(["/bin/dsh", "--profile", "acp"]);
    expect(p.peerMode).toEqual({ kind: "fixed", mode: "bypass" });
    expect(p.env.DSH_PERMISSION_MODE).toBe("danger-full-access");
    const prompting = plan("dst", "/bin/dsh", dstEngine, [], {});
    expect(prompting.peerMode).toEqual({ kind: "fixed", mode: "prompting" });
    expect(plan("dst", "/bin/dsh", dstEngine, [], { DSH_PERMISSION_MODE: "default" }).peerMode).toEqual({ kind: "fixed", mode: "prompting" });
  });

  test("dst bare --resume continues", () => {
    const engine: Engine = { harness: "dst", options: [], env: {} };
    expect(plan("dst", "/bin/dsh", engine, ["--resume"]).resume).toEqual({ kind: "continue" });
    expect(plan("dst", "/bin/dsh", engine, ["--resume", "dc33"]).resume).toEqual({ kind: "id", id: "dc33" });
    expect(plan("dst", "/bin/dsh", engine, ["-c"]).resume).toEqual({ kind: "continue" });
  });
});

describe("profiles", () => {
  test("agy and claude peer modes", () => {
    expect(agyPlan().peerMode).toEqual({ kind: "fixed", mode: "bypass" });
    expect(agyPlan({ engine: { harness: "agy", options: [], env: {} } }).peerMode).toEqual({ kind: "fixed", mode: "prompting" });
    expect(claudePlan().peerMode).toEqual({ kind: "option", bypassValue: "bypassPermissions" });
    expect(claudePlan().autoApprove).toBe(false);
  });

  test("claude and agy launch binaries", () => {
    expect(HARNESS_PROFILES.claude.launchBinary).toBe("claude-agent-acp");
    expect(HARNESS_PROFILES.agy.launchBinary).toBe("agy");
  });

  test("every profile names a launch binary and a label", () => {
    for (const profile of Object.values(HARNESS_PROFILES)) {
      expect(profile.launchBinary.length).toBeGreaterThan(0);
      expect(profile.label.length).toBeGreaterThan(0);
    }
  });
});
