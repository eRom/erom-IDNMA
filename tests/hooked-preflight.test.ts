import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agyPreflight, grokPreflight } from "../src/hooked/preflight.ts";
import { agyBinary, agyPluginsDir, grokHome } from "../src/paths.ts";

const ENV_KEYS = ["IDNMA_CONFIG_DIR", "GROK_HOME", "IDNMA_AGY_PLUGINS_DIR", "IDNMA_AGY_BIN"] as const;

let previousEnv: Record<string, string | undefined>;
let tempDirs: string[];
let grokDirectory: string;
let agyDirectory: string;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tempDirs = [mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-"), mkdtempSync("/tmp/idnma-t-")];
  process.env.IDNMA_CONFIG_DIR = tempDirs[0];
  grokDirectory = tempDirs[1]!;
  agyDirectory = tempDirs[2]!;
  process.env.GROK_HOME = grokDirectory;
  process.env.IDNMA_AGY_PLUGINS_DIR = agyDirectory;
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function installGrokHooks(): void {
  mkdirSync(join(grokDirectory, "hooks"), { recursive: true });
  writeFileSync(join(grokDirectory, "hooks", "idnma.json"), "{}");
}

function installAgyPlugin(): void {
  mkdirSync(join(agyDirectory, "idnma"), { recursive: true });
  writeFileSync(join(agyDirectory, "idnma", "hooks.json"), "{}");
}

describe("path helpers", () => {
  test("re-read the environment at each call, with prod defaults", () => {
    expect(grokHome()).toBe(grokDirectory);
    expect(agyPluginsDir()).toBe(agyDirectory);
    delete process.env.GROK_HOME;
    delete process.env.IDNMA_AGY_PLUGINS_DIR;
    delete process.env.IDNMA_AGY_BIN;
    expect(grokHome()).toMatch(/\/\.grok$/);
    expect(agyPluginsDir()).toMatch(/\/\.gemini\/config\/plugins$/);
    expect(agyBinary()).toBe("agy");
    process.env.IDNMA_AGY_BIN = "/opt/agy";
    expect(agyBinary()).toBe("/opt/agy");
  });
});

describe("grokPreflight", () => {
  test("has no reason when everything is in place", () => {
    installGrokHooks();
    expect(grokPreflight({ env: {}, argv: ["grok"] })).toBeUndefined();
  });

  test("asks for idnma install when the hooks file is missing", () => {
    expect(grokPreflight({ env: {}, argv: [] })).toBe(`hooks idnma absents de Grok (${grokDirectory}/hooks/idnma.json) : lance idnma install --agent grok`);
  });

  test("refuses the daemon route, unless the variable is empty or 0", () => {
    installGrokHooks();
    const reason = "route daemon de Grok active (GROK_AGENT_HOST_BACKEND) : ses commandes ne descendraient plus de la doublure";
    expect(grokPreflight({ env: { GROK_AGENT_HOST_BACKEND: "1" }, argv: [] })).toBe(reason);
    expect(grokPreflight({ env: { GROK_AGENT_HOST_BACKEND: "true" }, argv: [] })).toBe(reason);
    expect(grokPreflight({ env: { GROK_AGENT_HOST_BACKEND: "0" }, argv: [] })).toBeUndefined();
    expect(grokPreflight({ env: { GROK_AGENT_HOST_BACKEND: "" }, argv: [] })).toBeUndefined();
  });

  test("refuses --leader on the command line", () => {
    installGrokHooks();
    expect(grokPreflight({ env: {}, argv: ["--model", "x", "--leader"] })).toBe(
      "mode leader de Grok demandé (--leader) : ses commandes ne descendraient plus de la doublure",
    );
  });

  test("refuses [cli] use_leader = true in config.toml", () => {
    installGrokHooks();
    writeFileSync(join(grokDirectory, "config.toml"), "[cli]\nuse_leader = true\n");
    expect(grokPreflight({ env: {}, argv: [] })).toBe(
      "mode leader de Grok actif ([cli] use_leader dans config.toml) : ses commandes ne descendraient plus de la doublure",
    );
  });

  test("accepts use_leader = false and a config.toml without a cli table", () => {
    installGrokHooks();
    writeFileSync(join(grokDirectory, "config.toml"), "[cli]\nuse_leader = false\n");
    expect(grokPreflight({ env: {}, argv: [] })).toBeUndefined();
    writeFileSync(join(grokDirectory, "config.toml"), 'model = "x"\n');
    expect(grokPreflight({ env: {}, argv: [] })).toBeUndefined();
  });

  test("an unreadable config.toml gives no reason", () => {
    installGrokHooks();
    writeFileSync(join(grokDirectory, "config.toml"), "[cli\nuse_leader = = true");
    expect(grokPreflight({ env: {}, argv: [] })).toBeUndefined();
  });

  test("reports the missing hooks before the other reasons", () => {
    expect(grokPreflight({ env: { GROK_AGENT_HOST_BACKEND: "1" }, argv: ["--leader"] })).toStartWith("hooks idnma absents de Grok");
  });
});

describe("agyPreflight", () => {
  test("has no reason when the plugin is in place", () => {
    installAgyPlugin();
    expect(agyPreflight()).toBeUndefined();
  });

  test("asks for idnma install when hooks.json is missing", () => {
    expect(agyPreflight()).toBe(`plugin idnma absent d'agy (${agyDirectory}/idnma) : lance idnma install --agent agy`);
    mkdirSync(join(agyDirectory, "idnma"), { recursive: true });
    expect(agyPreflight()).toBe(`plugin idnma absent d'agy (${agyDirectory}/idnma) : lance idnma install --agent agy`);
  });
});
