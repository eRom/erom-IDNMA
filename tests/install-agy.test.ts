import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../src/config/network.ts";
import { AGY_HOOK_EVENTS, agyPluginFiles, installAgy, uninstallAgy, type AgyRunner } from "../src/install/agy.ts";
import { GENERIC_SKILL, skillText } from "../src/install/skill.ts";
import { agyAdapter } from "../src/hooked/agy.ts";
import { hookCommand } from "../src/install/hook-command.ts";
import { TEAMMATE_TEXT } from "../src/install/teammate.ts";

const FIXTURES = join(import.meta.dir, "fixtures/hooks");
const FIXTURE_BY_EVENT: Record<string, string> = {
  SessionStart: "agy-session-start",
  PreInvocation: "agy-pre-invocation-doorbell",
  Stop: "agy-stop-doorbell-turn",
};

let dir: string;
let pluginsDir: string;
const saved = { plugins: process.env.IDNMA_AGY_PLUGINS_DIR, bin: process.env.IDNMA_AGY_BIN };

beforeEach(() => {
  dir = mkdtempSync("/tmp/idnma-t-");
  pluginsDir = join(dir, "config", "plugins");
  process.env.IDNMA_AGY_PLUGINS_DIR = pluginsDir;
  // Jamais le vrai agy : un chemin inexistant, que seul un exécuteur injecté contourne.
  process.env.IDNMA_AGY_BIN = join(dir, "no-agy-here");
});

afterEach(() => {
  for (const [name, value] of [
    ["IDNMA_AGY_PLUGINS_DIR", saved.plugins],
    ["IDNMA_AGY_BIN", saved.bin],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const installed = (): string => join(pluginsDir, "idnma");

interface FakeAgy {
  run: AgyRunner;
  calls: string[][];
}

/** Exécuteur factice : `install` copie le dossier reçu dans `<plugins>/idnma`, `uninstall` le retire. */
function fakeAgy(failWith?: { exitCode: number; output: string }): FakeAgy {
  const calls: string[][] = [];
  const run: AgyRunner = (args) => {
    calls.push(args);
    if (failWith !== undefined) return failWith;
    if (args[1] === "install") cpSync(args[2] ?? "", installed(), { recursive: true });
    else if (args[1] === "uninstall") rmSync(installed(), { recursive: true, force: true });
    return { exitCode: 0, output: "ok" };
  };
  return { run, calls };
}

const command = { bun: "/usr/local/bin/bun", cli: "/src/idnma/cli.ts" };

describe("installAgy / uninstallAgy", () => {
  test("stages the plugin and calls agy plugin install", () => {
    mkdirSync(join(dir, "config"));
    const agy = fakeAgy();
    expect(installAgy({ run: agy.run, command })).toBe("installed");

    expect(agy.calls).toHaveLength(1);
    const [first, second, staged] = agy.calls[0] ?? [];
    expect([first, second]).toEqual(["plugin", "install"]);
    expect(staged?.endsWith("/idnma")).toBe(true);
    for (const [path, content] of Object.entries(agyPluginFiles(command))) {
      expect(readFileSync(join(installed(), path), "utf8")).toBe(content);
    }
    // La copie de travail est retirée une fois l'installation faite.
    expect(existsSync(staged ?? "")).toBe(false);
  });

  test("hooks never declare PreToolUse", () => {
    const written = JSON.parse(agyPluginFiles(command)["hooks.json"] ?? "") as Record<string, Record<string, unknown>>;
    expect(Object.keys(written)).toEqual(["idnma"]);
    const keys = Object.keys(written.idnma ?? {});
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain("PreToolUse");
    // Chaque événement déclaré est un événement que l'adaptateur agy sait traduire (jamais `ignore`).
    for (const key of keys) {
      const payload = JSON.parse(readFileSync(join(FIXTURES, `${FIXTURE_BY_EVENT[key]}.json`), "utf8")) as Record<string, unknown>;
      expect(agyAdapter.signal(key, payload).kind).not.toBe("ignore");
    }
    expect([...AGY_HOOK_EVENTS]).not.toContain("PreToolUse");
  });

  test("plugin files carry the manifest, the teammate rule, the generic skill and quoted commands", () => {
    const files = agyPluginFiles({ bun: "/Users/o'neil/bun", cli: "/src/idnma/cli.ts" });
    expect(Object.keys(files).sort()).toEqual(["hooks.json", "plugin.json", "rules/AGENTS.md", "skills/generic-idnma-network/SKILL.md"]);
    expect(files["plugin.json"]).toBe('{\n  "name": "idnma"\n}\n');
    expect(files["rules/AGENTS.md"]).toBe(`${TEAMMATE_TEXT}\n`);
    expect(files["skills/generic-idnma-network/SKILL.md"]).toBe(skillText(GENERIC_SKILL));
    const hooks = JSON.parse(files["hooks.json"] ?? "") as Record<string, Record<string, Array<{ type: string; command: string; timeout: number }>>>;
    expect(hooks.idnma?.Stop).toEqual([{ type: "command", command: "'/Users/o'\\''neil/bun' '/src/idnma/cli.ts' hook agy Stop", timeout: 10 }]);
  });

  test("unchanged when the installed plugin matches", () => {
    mkdirSync(join(dir, "config"));
    const agy = fakeAgy();
    installAgy({ run: agy.run, command });
    expect(installAgy({ run: agy.run, command })).toBe("unchanged");
    expect(agy.calls).toHaveLength(1);
  });

  test("unchanged when the installed folder only gained hidden files", () => {
    mkdirSync(join(dir, "config"));
    const agy = fakeAgy();
    installAgy({ run: agy.run, command });
    writeFileSync(join(installed(), ".DS_Store"), "x");
    mkdirSync(join(installed(), "rules", ".cache"), { recursive: true });
    writeFileSync(join(installed(), "rules", ".cache", "entry"), "x");
    expect(installAgy({ run: agy.run, command })).toBe("unchanged");
    expect(agy.calls).toHaveLength(1);
  });

  test("updated when the installed plugin differs", () => {
    mkdirSync(join(dir, "config"));
    const agy = fakeAgy();
    installAgy({ run: agy.run, command: { bun: "/old/bun", cli: "/old/cli.ts" } });
    expect(installAgy({ run: agy.run, command })).toBe("updated");
    expect(agy.calls).toHaveLength(2);
    expect(readFileSync(join(installed(), "hooks.json"), "utf8")).toBe(agyPluginFiles(command)["hooks.json"] ?? "");
  });

  test("reports agy's message when install fails", () => {
    mkdirSync(join(dir, "config"));
    let staged = "";
    const agy = fakeAgy({ exitCode: 1, output: "boom\nsuite" });
    const run: AgyRunner = (args) => {
      staged = args[2] ?? "";
      return agy.run(args);
    };
    expect(() => installAgy({ run, command })).toThrow(ConfigError);
    expect(() => installAgy({ run, command })).toThrow("agy plugin install a échoué : boom");
    expect(staged.endsWith("/idnma")).toBe(true);
    expect(existsSync(staged)).toBe(false);
  });

  test("uninstall calls agy plugin uninstall idnma", () => {
    mkdirSync(join(dir, "config"));
    const agy = fakeAgy();
    installAgy({ run: agy.run, command });
    expect(uninstallAgy({ run: agy.run })).toBe("removed");
    expect(agy.calls.at(-1)).toEqual(["plugin", "uninstall", "idnma"]);
    expect(existsSync(installed())).toBe(false);
  });

  test("uninstall reports agy's message when it fails", () => {
    mkdirSync(installed(), { recursive: true });
    const agy = fakeAgy({ exitCode: 2, output: "nope\nreste" });
    expect(() => uninstallAgy({ run: agy.run })).toThrow("agy plugin uninstall a échoué : nope");
  });

  test("uninstall without the plugin reports absent and does not call agy", () => {
    mkdirSync(join(dir, "config"));
    const agy = fakeAgy();
    expect(uninstallAgy({ run: agy.run })).toBe("absent");
    expect(agy.calls).toHaveLength(0);
  });

  test("AC-19 never touches the user's agy files", () => {
    const config = join(dir, "config");
    mkdirSync(config);
    const neighbours: Record<string, string> = {
      [join(config, "hooks.json")]: '{"herdr":{"Stop":[]}}\n',
      [join(dir, "GEMINI.md")]: "# Règles de l'utilisateur\n",
    };
    for (const [path, content] of Object.entries(neighbours)) writeFileSync(path, content);
    const before = Object.keys(neighbours).map((path) => readFileSync(path));

    const agy = fakeAgy();
    installAgy({ run: agy.run, command });
    uninstallAgy({ run: agy.run });

    Object.keys(neighbours).forEach((path, index) => expect(readFileSync(path).equals(before[index] ?? Buffer.alloc(0))).toBe(true));
  });

  test("AC-17 the hook command strings run the hook entry point for every event", async () => {
    mkdirSync(join(dir, "config"));
    const real = hookCommand();
    const agy = fakeAgy();
    installAgy({ run: agy.run, command: real });
    const hooks = JSON.parse(readFileSync(join(installed(), "hooks.json"), "utf8")) as Record<string, Record<string, Array<{ command: string }>>>;
    const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, ...cleanEnv } = process.env;

    for (const event of AGY_HOOK_EVENTS) {
      const handler = hooks.idnma?.[event]?.[0];
      if (handler === undefined) throw new Error(`no handler for ${event}`);
      const input = readFileSync(join(FIXTURES, `${FIXTURE_BY_EVENT[event]}.json`), "utf8");
      const child = Bun.spawn(["sh", "-c", handler.command], { env: cleanEnv, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect({ event, code, stdout }).toEqual({ event, code: 0, stdout: "{}\n" });
    }
  }, 30_000);

  test("absent when the plugins parent folder is missing", () => {
    const agy = fakeAgy();
    expect(installAgy({ run: agy.run, command })).toBe("absent");
    expect(agy.calls).toHaveLength(0);
    expect(existsSync(join(dir, "config"))).toBe(false);
  });

  test("absent when the agy binary is missing", () => {
    mkdirSync(join(dir, "config"));
    expect(installAgy({ command })).toBe("absent");
  });
});
