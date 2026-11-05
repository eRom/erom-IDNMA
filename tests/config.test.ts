import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAgentKeys, loadAgentEngine, readYaml } from "../src/config/network.ts";
import { controlDir, dshHome, dstBridgeSocketPath, opencodeConfigDir, opencodeServiceFile } from "../src/paths.ts";
import { resolveEnv } from "../src/config/secrets.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "network.yml");
const EXAMPLE = join(import.meta.dir, "..", ".idnma.example.yml");

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.IDNMA_CONFIG_DIR;
  dir = mkdtempSync("/tmp/idnma-t-");
  process.env.IDNMA_CONFIG_DIR = dir;
  copyFileSync(FIXTURE, join(dir, ".idnma.yml"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.IDNMA_CONFIG_DIR;
  else process.env.IDNMA_CONFIG_DIR = previousConfigDir;
});

test("loads every agent of the user's example", () => {
  for (const key of ["claude", "glm", "deepseek", "qwen", "kimi", "muse", "grok", "agy", "codex", "opencode"]) {
    expect(loadAgentEngine(key).engineKey).toBe("default");
  }
  expect(loadAgentEngine("grok").engine).toEqual({
    harness: "grok",
    model: "grok-4.7",
    options: ["--effort", "high", "--always-approve"],
    env: {},
  });
  expect(loadAgentEngine("codex").engine.model).toBeUndefined();
});

test("a broken agent does not prevent launching another one", () => {
  const yaml = readFileSync(FIXTURE, "utf-8");
  writeFileSync(
    join(dir, ".idnma.yml"),
    `${yaml}\n  broken:\n    engines:\n      default:\n        harness: nope\n`,
  );
  expect(loadAgentEngine("claude").engine.harness).toBe("claude");
  expect(() => loadAgentEngine("broken")).toThrow(/harness.*claude, codex, grok, agy/);
});

test("unknown agent or engine: the message lists the available choices", () => {
  expect(() => loadAgentEngine("nobody")).toThrow(/agy.*claude.*codex/);
  expect(() => loadAgentEngine("claude", "turbo")).toThrow(/default/);
});

test("presets: a `<<` merge key fills an engine env, an alias reuses options, explicit keys win", () => {
  writeFileSync(
    join(dir, ".idnma.yml"),
    [
      "presets:",
      "  proxy: &proxy",
      '    ANTHROPIC_BASE_URL: "http://localhost:11434"',
      '    ANTHROPIC_API_KEY: ""',
      "  max: &max [--effort, max]",
      "agents:",
      "  kimi:",
      "    engines:",
      "      default:",
      "        harness: claude",
      "        model: &kimi kimi-k3:cloud[1m]",
      "        options: *max",
      "        env:",
      "          <<: *proxy",
      '          ANTHROPIC_API_KEY: "explicit-wins"',
      "          ANTHROPIC_MODEL: *kimi",
      "",
    ].join("\n"),
  );
  expect(loadAgentEngine("kimi").engine).toEqual({
    harness: "claude",
    model: "kimi-k3:cloud[1m]",
    options: ["--effort", "max"],
    env: {
      ANTHROPIC_BASE_URL: "http://localhost:11434",
      ANTHROPIC_API_KEY: "explicit-wins",
      ANTHROPIC_MODEL: "kimi-k3:cloud[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k3:cloud[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k3:cloud[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k3:cloud[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k3:cloud[1m]",
    },
  });
});

test("a claude engine routed off Anthropic fills only its missing model tiers with model:", () => {
  writeFileSync(
    join(dir, ".idnma.yml"),
    [
      "agents:",
      "  mistral:",
      "    engines:",
      "      default:",
      "        harness: claude",
      "        model: mistral-large-4:cloud[1m]",
      "        env:",
      '          ANTHROPIC_BASE_URL: "http://localhost:11434"',
      "      tiered:",
      "        harness: claude",
      "        model: glm-flash",
      "        env:",
      '          ANTHROPIC_BASE_URL: "http://localhost:11434"',
      "          ANTHROPIC_DEFAULT_OPUS_MODEL: glm-pro",
      '          ANTHROPIC_DEFAULT_HAIKU_MODEL: ""',
      "  claude:",
      "    engines:",
      "      default:",
      "        harness: claude",
      "        model: opus",
      "  codex:",
      "    engines:",
      "      default:",
      "        harness: codex",
      "        model: gpt-5",
      "        env:",
      '          ANTHROPIC_BASE_URL: "http://localhost:11434"',
      "",
    ].join("\n"),
  );
  const m = "mistral-large-4:cloud[1m]";
  expect(loadAgentEngine("mistral").engine.env).toEqual({
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    ANTHROPIC_MODEL: m,
    ANTHROPIC_DEFAULT_FABLE_MODEL: m,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
  });
  // Une variable posée, même vide, l'emporte sur model:.
  expect(loadAgentEngine("mistral", "tiered").engine.env).toEqual({
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    ANTHROPIC_MODEL: "glm-flash",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "glm-flash",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-pro",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-flash",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
  });
  // Sans ANTHROPIC_BASE_URL (Claude chez Anthropic) ou hors harnais claude : rien n'est ajouté.
  expect(loadAgentEngine("claude").engine.env).toEqual({});
  expect(loadAgentEngine("codex").engine.env).toEqual({ ANTHROPIC_BASE_URL: "http://localhost:11434" });
});

test("a model tier exported in the shell does not block the fill", () => {
  const previous = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-from-shell";
  try {
    writeFileSync(
      join(dir, ".idnma.yml"),
      ["agents:", "  m:", "    engines:", "      default:", "        harness: claude", "        model: x", "        env:", '          ANTHROPIC_BASE_URL: "http://h"', ""].join("\n"),
    );
    expect(loadAgentEngine("m").engine.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("x");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    else process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = previous;
  }
});

test("every agent and engine of .idnma.example.yml loads", () => {
  copyFileSync(EXAMPLE, join(dir, ".idnma.yml"));
  const raw = readYaml(EXAMPLE, ".idnma.example.yml") as { agents: Record<string, { engines: Record<string, unknown> }> };
  const agents = listAgentKeys();
  expect(agents.length).toBeGreaterThan(0);
  for (const agent of agents) {
    for (const engine of Object.keys(raw.agents[agent]!.engines)) {
      expect(loadAgentEngine(agent, engine).engineKey).toBe(engine);
    }
  }
});

test("resolveEnv: references resolve from the environment only, literals pass through", () => {
  expect(resolveEnv({ A: "$K", B: "plain", C: "" }, { K: "from-env" })).toEqual({
    A: "from-env",
    B: "plain",
    C: "",
  });
});

test("resolveEnv: a missing reference is named with the zshenv hint, never a value", () => {
  const witness = "valeur-temoin";
  expect(() => resolveEnv({ A: "$MISSING" }, { OTHER: witness })).toThrow(
    "Variable $MISSING absente de l'environnement. Exporte-la dans ~/.zshenv, puis relance le pane.",
  );
  let message = "";
  try {
    resolveEnv({ A: "$MISSING" }, { OTHER: witness });
  } catch (e) {
    message = String(e);
  }
  expect(message).toContain("$MISSING");
  expect(message).toContain("~/.zshenv");
  expect(message).not.toContain(witness);
});

test("an unknown engine key is refused and named, never silently dropped", () => {
  writeFileSync(
    join(dir, ".idnma.yml"),
    "agents:\n  codex:\n    engines:\n      default:\n        harness: codex\n        option:\n          - --dangerously-bypass-approvals-and-sandbox\n",
  );
  expect(() => loadAgentEngine("codex")).toThrow(/engines\.default.*« option »/);
  writeFileSync(
    join(dir, ".idnma.yml"),
    "agents:\n  codex:\n    engines:\n      default:\n        harness: codex\n        envs:\n          A: b\n",
  );
  expect(() => loadAgentEngine("codex")).toThrow(/engines\.default.*« envs »/);
});

test("display keys at the agent level stay accepted", () => {
  writeFileSync(
    join(dir, ".idnma.yml"),
    "agents:\n  codex:\n    label: Codex\n    info: x\n    cell: 4\n    avatar: c.png\n    engines:\n      default:\n        harness: codex\n",
  );
  expect(loadAgentEngine("codex").engine).toEqual({ harness: "codex", options: [], env: {} });
});

test("loads the opencode agent with its default and auto engines", () => {
  expect(loadAgentEngine("opencode")).toEqual({
    engine: { harness: "opencode", model: "opencode/big-pickle", options: [], env: {} },
    engineKey: "default",
  });
  expect(loadAgentEngine("opencode", "auto").engine).toEqual({
    harness: "opencode",
    model: "ollama-cloud/deepseek-v4.1-flash",
    options: ["--auto"],
    env: {},
  });
});

test("opencode paths follow the IDNMA override, then the XDG variables", () => {
  const saved = { cfg: process.env.IDNMA_OPENCODE_CONFIG_DIR, svc: process.env.IDNMA_OPENCODE_SERVICE_FILE, xc: process.env.XDG_CONFIG_HOME, xs: process.env.XDG_STATE_HOME };
  try {
    delete process.env.IDNMA_OPENCODE_CONFIG_DIR;
    delete process.env.IDNMA_OPENCODE_SERVICE_FILE;
    process.env.XDG_CONFIG_HOME = "/x";
    process.env.XDG_STATE_HOME = "/y";
    expect(opencodeConfigDir()).toBe("/x/opencode");
    expect(opencodeServiceFile()).toBe("/y/opencode/service.json");
    process.env.IDNMA_OPENCODE_CONFIG_DIR = "/a";
    process.env.IDNMA_OPENCODE_SERVICE_FILE = "/b/service.json";
    expect(opencodeConfigDir()).toBe("/a");
    expect(opencodeServiceFile()).toBe("/b/service.json");
  } finally {
    for (const [key, value] of [["IDNMA_OPENCODE_CONFIG_DIR", saved.cfg], ["IDNMA_OPENCODE_SERVICE_FILE", saved.svc], ["XDG_CONFIG_HOME", saved.xc], ["XDG_STATE_HOME", saved.xs]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("loads a dst engine and keeps its permission env", () => {
  const yaml = readFileSync(FIXTURE, "utf-8");
  writeFileSync(
    join(dir, ".idnma.yml"),
    `${yaml}\n  deepseek-tui:\n    engines:\n      default:\n        harness: dst\n        options:\n          - --resume\n        env:\n          DSH_PERMISSION_MODE: danger-full-access\n`,
  );
  expect(loadAgentEngine("deepseek-tui")).toEqual({
    engine: { harness: "dst", options: ["--resume"], env: { DSH_PERMISSION_MODE: "danger-full-access" } },
    engineKey: "default",
  });
});

test("dshHome follows IDNMA_DSH_HOME, then DSH_HOME, then ~/.dsh", () => {
  expect(dshHome({ IDNMA_DSH_HOME: "/a", DSH_HOME: "/b" })).toBe("/a");
  expect(dshHome({ DSH_HOME: "/b" })).toBe("/b");
  expect(dshHome({})).toBe(join(homedir(), ".dsh"));
});

test("dstBridgeSocketPath lives in the control directory and is keyed by pid", () => {
  const saved = process.env.IDNMA_CONTROL_DIR;
  try {
    process.env.IDNMA_CONTROL_DIR = "/tmp/idnma-t-ctl";
    expect(controlDir()).toBe("/tmp/idnma-t-ctl");
    expect(dstBridgeSocketPath(42)).toBe("/tmp/idnma-t-ctl/42.dst.sock");
    expect(dstBridgeSocketPath()).toBe(`/tmp/idnma-t-ctl/${process.pid}.dst.sock`);
  } finally {
    if (saved === undefined) delete process.env.IDNMA_CONTROL_DIR;
    else process.env.IDNMA_CONTROL_DIR = saved;
  }
});
