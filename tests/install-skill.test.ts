import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_SKILL, GENERIC_SKILL, installSkill, skillText, uninstallSkill } from "../src/install/skill.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync("/tmp/idnma-t-");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Lance la vraie CLI avec le dossier de Claude redirigé vers le dossier de test. */
function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "claude") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("skill sources", () => {
  test("each skill declares its own name in its frontmatter", () => {
    for (const name of [CLAUDE_SKILL, GENERIC_SKILL] as const) {
      expect(skillText(name).startsWith(`---\nname: ${name}\ndescription: `)).toBe(true);
    }
  });
});

describe("installSkill / uninstallSkill", () => {
  test("install, reinstall, update, uninstall", () => {
    const path = join(dir, GENERIC_SKILL, "SKILL.md");
    expect(installSkill(dir, GENERIC_SKILL)).toBe("installed");
    expect(readFileSync(path, "utf8")).toBe(skillText(GENERIC_SKILL));
    expect(installSkill(dir, GENERIC_SKILL)).toBe("unchanged");
    writeFileSync(path, "ancienne version\n");
    expect(installSkill(dir, GENERIC_SKILL)).toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(skillText(GENERIC_SKILL));
    expect(uninstallSkill(dir, GENERIC_SKILL)).toBe("removed");
    expect(existsSync(join(dir, GENERIC_SKILL))).toBe(false);
    expect(uninstallSkill(dir, GENERIC_SKILL)).toBe("absent");
  });

  test("uninstall keeps a skill folder that holds something else", () => {
    installSkill(dir, GENERIC_SKILL);
    writeFileSync(join(dir, GENERIC_SKILL, "notes.md"), "à l'utilisateur\n");
    expect(uninstallSkill(dir, GENERIC_SKILL)).toBe("removed");
    expect(readFileSync(join(dir, GENERIC_SKILL, "notes.md"), "utf8")).toBe("à l'utilisateur\n");
  });
});

describe("idnma install --agent claude", () => {
  test("installs the Claude skill, then uninstalls it, leaving neighbour skills alone", () => {
    const skills = join(dir, "claude", "skills");
    mkdirSync(join(skills, "autre"), { recursive: true });
    writeFileSync(join(skills, "autre", "SKILL.md"), "# autre\n");

    const installed = cli(["install", "--agent", "claude"]);
    expect(installed).toEqual({ code: 0, stdout: `Claude : skill ${CLAUDE_SKILL} installée dans ${skills}\n`, stderr: "" });
    expect(readFileSync(join(skills, CLAUDE_SKILL, "SKILL.md"), "utf8")).toBe(skillText(CLAUDE_SKILL));
    expect(existsSync(join(skills, GENERIC_SKILL))).toBe(false);

    expect(cli(["install", "--agent", "claude"]).stdout).toBe(`Claude : skill ${CLAUDE_SKILL} déjà à jour dans ${skills}\n`);
    expect(cli(["uninstall", "--agent", "claude"]).stdout).toBe(`Claude : skill ${CLAUDE_SKILL} retirée de ${skills}\n`);
    expect(existsSync(join(skills, CLAUDE_SKILL))).toBe(false);
    expect(readFileSync(join(skills, "autre", "SKILL.md"), "utf8")).toBe("# autre\n");
  });

  test("an absent Claude home installs nothing", () => {
    expect(cli(["install", "--agent", "claude"]).stdout).toBe(`Claude : absent (${join(dir, "claude")}), rien installé\n`);
    expect(existsSync(join(dir, "claude"))).toBe(false);
  });
});
