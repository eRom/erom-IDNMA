import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROK_HOOK_EVENTS, grokHooksConfig, installGrok, uninstallGrok } from "../src/install/grok.ts";
import { hookCommand } from "../src/install/hook-command.ts";
import { GENERIC_SKILL, skillText } from "../src/install/skill.ts";
import { TEAMMATE_TEXT } from "../src/install/teammate.ts";

const FIXTURES = join(import.meta.dir, "fixtures/hooks");
/** Fixture réelle de chaque événement quand la sonde en a capturé une ; `{}` sinon. */
const FIXTURE_BY_EVENT: Record<string, string> = {
  SessionStart: "grok-session-start",
  UserPromptSubmit: "grok-user-prompt-submit-doorbell",
  PreToolUse: "grok-pre-tool-use",
  PostToolUse: "grok-post-tool-use",
  Stop: "grok-stop-end-turn",
  Notification: "grok-notification-idle",
};

let dir: string;
let grokDir: string;
const saved = process.env.GROK_HOME;

beforeEach(() => {
  dir = mkdtempSync("/tmp/idnma-t-");
  grokDir = join(dir, "grok");
  process.env.GROK_HOME = grokDir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = saved;
  rmSync(dir, { recursive: true, force: true });
});

const hooksFile = (): string => join(grokDir, "hooks", "idnma.json");
const ruleFile = (): string => join(grokDir, "rules", "idnma-teammate.md");
const skillFile = (): string => join(grokDir, "skills", GENERIC_SKILL, "SKILL.md");

interface InstalledHandler {
  type: string;
  command: string;
  args: string[];
  timeout: number;
}
interface InstalledConfig {
  hooks: Record<string, Array<{ hooks: InstalledHandler[] }>>;
}

describe("installGrok / uninstallGrok", () => {
  test("writes one command hook per Grok event", () => {
    mkdirSync(grokDir);
    expect(installGrok()).toBe("installed");
    const written = JSON.parse(readFileSync(hooksFile(), "utf8")) as InstalledConfig;
    expect(written).toEqual(grokHooksConfig(hookCommand()));
    expect(Object.keys(written.hooks).sort()).toEqual([...GROK_HOOK_EVENTS].sort());
    for (const event of GROK_HOOK_EVENTS) {
      const handler = written.hooks[event]?.[0]?.hooks[0];
      expect(handler?.type).toBe("command");
      expect(handler?.args.slice(1)).toEqual(["hook", "grok", event]);
    }
  });

  test("writes the teammate rule", () => {
    mkdirSync(grokDir);
    installGrok();
    expect(readFileSync(ruleFile(), "utf8")).toBe(`${TEAMMATE_TEXT}\n`);
  });

  test("writes the generic skill, and uninstall removes it with its folder only", () => {
    mkdirSync(join(grokDir, "skills", "herdr"), { recursive: true });
    writeFileSync(join(grokDir, "skills", "herdr", "SKILL.md"), "# herdr\n");
    installGrok();
    expect(readFileSync(skillFile(), "utf8")).toBe(skillText(GENERIC_SKILL));
    uninstallGrok();
    expect(existsSync(join(grokDir, "skills", GENERIC_SKILL))).toBe(false);
    expect(readFileSync(join(grokDir, "skills", "herdr", "SKILL.md"), "utf8")).toBe("# herdr\n");
  });

  test("second install is unchanged and byte-identical", () => {
    mkdirSync(grokDir);
    installGrok();
    const hooksBefore = readFileSync(hooksFile());
    const ruleBefore = readFileSync(ruleFile());
    expect(installGrok()).toBe("unchanged");
    expect(readFileSync(hooksFile()).equals(hooksBefore)).toBe(true);
    expect(readFileSync(ruleFile()).equals(ruleBefore)).toBe(true);
  });

  test("an install over a different command reports updated and rewrites both files", () => {
    mkdirSync(grokDir);
    installGrok({ bun: "/old/bun", cli: "/old/cli.ts" });
    expect(installGrok()).toBe("updated");
    expect(JSON.parse(readFileSync(hooksFile(), "utf8"))).toEqual(grokHooksConfig(hookCommand()));
  });

  test("an install with only one of the two files present reports updated", () => {
    mkdirSync(grokDir);
    installGrok();
    rmSync(ruleFile());
    expect(installGrok()).toBe("updated");
    expect(readFileSync(ruleFile(), "utf8")).toBe(`${TEAMMATE_TEXT}\n`);
  });

  test("install and uninstall never write config.toml nor neighbour files", () => {
    mkdirSync(join(grokDir, "hooks"), { recursive: true });
    mkdirSync(join(grokDir, "rules"));
    const neighbours: Record<string, string> = {
      [join(grokDir, "config.toml")]: "[cli]\nmodel = \"x\"\n",
      [join(grokDir, "hooks", "herdr.json")]: "{\"hooks\":{}}\n",
      [join(grokDir, "rules", "autre.md")]: "# Autre règle\n",
    };
    for (const [path, content] of Object.entries(neighbours)) writeFileSync(path, content);

    installGrok();
    expect(uninstallGrok()).toBe("removed");

    for (const [path, content] of Object.entries(neighbours)) expect(readFileSync(path, "utf8")).toBe(content);
    expect(existsSync(hooksFile())).toBe(false);
    expect(existsSync(ruleFile())).toBe(false);
  });

  test("uninstall without our files reports absent", () => {
    mkdirSync(grokDir);
    expect(uninstallGrok()).toBe("absent");
  });

  test("absent Grok home installs nothing", () => {
    expect(installGrok()).toBe("absent");
    expect(existsSync(grokDir)).toBe(false);
    expect(uninstallGrok()).toBe("absent");
  });

  test("the installed commands run the hook entry point for every event", async () => {
    mkdirSync(grokDir);
    installGrok();
    const written = JSON.parse(readFileSync(hooksFile(), "utf8")) as InstalledConfig;
    const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, ...cleanEnv } = process.env;

    for (const event of GROK_HOOK_EVENTS) {
      const handler = written.hooks[event]?.[0]?.hooks[0];
      if (handler === undefined) throw new Error(`no handler for ${event}`);
      const name = FIXTURE_BY_EVENT[event];
      const input = name === undefined ? "{}" : readFileSync(join(FIXTURES, `${name}.json`), "utf8");
      const child = Bun.spawn([handler.command, ...handler.args], { env: cleanEnv, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect({ event, code, stdout }).toEqual({ event, code: 0, stdout: "{}\n" });
    }
  }, 30_000);
});
