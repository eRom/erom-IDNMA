import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../src/config/network.ts";
import { AUTO_REPLY_MARKER } from "../src/understudy/courier.ts";
import { GENERIC_SKILL, skillText } from "../src/install/skill.ts";
import {
  installTeammateLine,
  TEAMMATE_END,
  TEAMMATE_START,
  TEAMMATE_START_CREATED,
  TEAMMATE_START_EOL,
  TEAMMATE_TEXT,
  uninstallTeammateLine,
} from "../src/install/teammate.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
const childTest = (title: string, body: () => Promise<void>): void => test(title, body, { timeout: 15_000 });

let dir: string;
let agentsPath: string;

beforeEach(() => {
  dir = mkdtempSync("/tmp/idnma-t-");
  agentsPath = join(dir, "AGENTS.md");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const block = (startLine: string): string => `${startLine}\n${TEAMMATE_TEXT}\n${TEAMMATE_END}\n`;
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("installTeammateLine / uninstallTeammateLine", () => {
  test("creates AGENTS.md with the block when absent", () => {
    expect(installTeammateLine(agentsPath)).toBe("installed");
    expect(readFileSync(agentsPath, "utf8")).toBe(block(TEAMMATE_START_CREATED));
    expect(modeOf(agentsPath)).toBe(0o644);

    expect(uninstallTeammateLine(agentsPath)).toBe("removed");
    expect(existsSync(agentsPath)).toBe(false);
  });

  test("restores a file that ends with a newline", () => {
    const original = "# Mes règles\nLigne 2\n";
    writeFileSync(agentsPath, original);
    chmodSync(agentsPath, 0o600);

    expect(installTeammateLine(agentsPath)).toBe("installed");
    const installed = readFileSync(agentsPath, "utf8");
    expect(installed.startsWith(original)).toBe(true);
    expect(installed).toBe(`${original}\n${block(TEAMMATE_START)}`);
    expect(modeOf(agentsPath)).toBe(0o600);

    expect(uninstallTeammateLine(agentsPath)).toBe("removed");
    expect(readFileSync(agentsPath, "utf8")).toBe(original);
    expect(modeOf(agentsPath)).toBe(0o600);
  });

  test("restores a file without a final newline", () => {
    const original = "# Mes règles\nLigne 2";
    writeFileSync(agentsPath, original);

    expect(installTeammateLine(agentsPath)).toBe("installed");
    const installed = readFileSync(agentsPath, "utf8");
    expect(installed.startsWith(original)).toBe(true);
    expect(installed).toBe(`${original}\n\n${block(TEAMMATE_START_EOL)}`);

    expect(uninstallTeammateLine(agentsPath)).toBe("removed");
    expect(readFileSync(agentsPath, "utf8")).toBe(original);
  });

  test("restores an empty file as an empty file", () => {
    writeFileSync(agentsPath, "");

    expect(installTeammateLine(agentsPath)).toBe("installed");
    expect(readFileSync(agentsPath, "utf8")).toBe(`\n\n${block(TEAMMATE_START_EOL)}`);

    expect(uninstallTeammateLine(agentsPath)).toBe("removed");
    expect(existsSync(agentsPath)).toBe(true);
    expect(readFileSync(agentsPath).length).toBe(0);
  });

  test("restores bytes that are not valid UTF-8 unchanged", () => {
    const original = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x80, 0x0a, 0xe9, 0x0a]);
    writeFileSync(agentsPath, original);

    expect(installTeammateLine(agentsPath)).toBe("installed");
    expect(readFileSync(agentsPath).subarray(0, original.length).equals(original)).toBe(true);
    // Le texte du coéquipier reste de l'UTF-8 valide malgré les octets étrangers du fichier.
    expect(readFileSync(agentsPath).includes(Buffer.from(TEAMMATE_TEXT, "utf8"))).toBe(true);

    expect(uninstallTeammateLine(agentsPath)).toBe("removed");
    expect(readFileSync(agentsPath).equals(original)).toBe(true);
  });

  test("is idempotent", async () => {
    writeFileSync(agentsPath, "# Mes règles\n");
    installTeammateLine(agentsPath);
    const before = readFileSync(agentsPath, "utf8");
    const mtimeBefore = statSync(agentsPath).mtimeMs;
    await Bun.sleep(30);

    expect(installTeammateLine(agentsPath)).toBe("unchanged");
    expect(readFileSync(agentsPath, "utf8")).toBe(before);
    expect(statSync(agentsPath).mtimeMs).toBe(mtimeBefore);
  });

  test("replaces an outdated block in place and keeps its start line", () => {
    const original = "# Mes règles\nLigne 2";
    writeFileSync(agentsPath, `${original}\n\n${TEAMMATE_START_EOL}\nanciens mots\n${TEAMMATE_END}\n`);

    expect(installTeammateLine(agentsPath)).toBe("updated");
    const updated = readFileSync(agentsPath, "utf8");
    expect(updated).toBe(`${original}\n\n${block(TEAMMATE_START_EOL)}`);
    expect(countOf(updated, TEAMMATE_END)).toBe(1);
    expect(updated).not.toContain("anciens mots");

    // La ligne de début conservée permet encore la restitution exacte.
    expect(uninstallTeammateLine(agentsPath)).toBe("removed");
    expect(readFileSync(agentsPath, "utf8")).toBe(original);
  });

  test("keeps what the user wrote after the block on update and uninstall", () => {
    const original = "# Mes règles\n";
    const after = "Règle ajoutée après coup\n";
    writeFileSync(agentsPath, `${original}\n${TEAMMATE_START}\nanciens mots\n${TEAMMATE_END}\n${after}`);

    expect(installTeammateLine(agentsPath)).toBe("updated");
    expect(readFileSync(agentsPath, "utf8")).toBe(`${original}\n${block(TEAMMATE_START)}${after}`);

    expect(uninstallTeammateLine(agentsPath)).toBe("removed");
    expect(readFileSync(agentsPath, "utf8")).toBe(`${original}${after}`);
  });

  test("keeps a created file that the user completed after installation", () => {
    installTeammateLine(agentsPath);
    writeFileSync(agentsPath, `${readFileSync(agentsPath, "utf8")}Ma règle\n`);

    expect(uninstallTeammateLine(agentsPath)).toBe("removed");
    expect(readFileSync(agentsPath, "utf8")).toBe("Ma règle\n");
  });

  test("refuses malformed markers and leaves the file intact", () => {
    const cases: Record<string, string> = {
      "start without end": `# Mes règles\n\n${TEAMMATE_START}\n${TEAMMATE_TEXT}\n`,
      "end without start": `# Mes règles\n${TEAMMATE_END}\n`,
      "two starts": `${block(TEAMMATE_START)}${block(TEAMMATE_START_EOL)}`,
      "end before start": `${TEAMMATE_END}\n${TEAMMATE_START}\n`,
    };
    for (const [label, content] of Object.entries(cases)) {
      writeFileSync(agentsPath, content);
      expect(() => installTeammateLine(agentsPath), label).toThrow(ConfigError);
      expect(() => installTeammateLine(agentsPath), label).toThrow(`bloc idnma mal formé dans ${agentsPath} : corrige-le à la main`);
      expect(() => uninstallTeammateLine(agentsPath), label).toThrow(ConfigError);
      expect(readFileSync(agentsPath, "utf8"), label).toBe(content);
    }
  });

  test("uninstall without block reports absent and leaves the file intact", async () => {
    const original = "# Mes règles\n";
    writeFileSync(agentsPath, original);
    const mtimeBefore = statSync(agentsPath).mtimeMs;
    await Bun.sleep(30);

    expect(uninstallTeammateLine(agentsPath)).toBe("absent");
    expect(readFileSync(agentsPath, "utf8")).toBe(original);
    expect(statSync(agentsPath).mtimeMs).toBe(mtimeBefore);
  });

  test("uninstall of a missing file reports absent", () => {
    expect(uninstallTeammateLine(agentsPath)).toBe("absent");
    expect(existsSync(agentsPath)).toBe(false);
  });

  test("a marker quoted inside a longer line is not a marker", () => {
    const original = `Voir ${TEAMMATE_START} dans la doc\n`;
    writeFileSync(agentsPath, original);

    expect(installTeammateLine(agentsPath)).toBe("installed");
    expect(uninstallTeammateLine(agentsPath)).toBe("removed");
    expect(readFileSync(agentsPath, "utf8")).toBe(original);
  });

  test("the block carries the teammate instructions Codex needs", () => {
    installTeammateLine(agentsPath);
    const installed = readFileSync(agentsPath, "utf8");
    expect(installed).toContain("idnma peer send <from-name>");
    expect(installed).toContain("📨 idnma read");
    expect(installed).toContain("idnma read");
  });

  test("the block names the automatic-reply marker the courier really sends", () => {
    installTeammateLine(agentsPath);
    expect(readFileSync(agentsPath, "utf8")).toContain(`\`${AUTO_REPLY_MARKER}\``);
  });

  test("an install over the block of the previous version reports updated and keeps the file around it", () => {
    // Texte de la version précédente : la réponse passait toujours par `idnma peer send`.
    const previousText = "# Messages de pairs\n\nPour lui répondre : `idnma peer send <from-name> \"…\"`.";
    const around = "# Mes règles\n";
    writeFileSync(agentsPath, `${around}${TEAMMATE_START}\n${previousText}\n${TEAMMATE_END}\n`);

    expect(installTeammateLine(agentsPath)).toBe("updated");
    expect(readFileSync(agentsPath, "utf8")).toBe(`${around}${block(TEAMMATE_START)}`);
    expect(installTeammateLine(agentsPath)).toBe("unchanged");
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Lance `bun src/cli.ts …` avec un environnement purgé des variables de la doublure. */
async function cli(args: string[], codexHome: string, extraEnv: Record<string, string> = {}): Promise<CliResult> {
  const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, CODEX_THREAD_ID: _d, ...cleanEnv } = process.env;
  // Claude, Grok, agy et pi pointent vers des chemins absents du dossier temporaire : jamais le vrai ~/.claude, ~/.grok, ~/.gemini, agy ni ~/.pi.
  const env = { ...cleanEnv, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(dir, "no-claude"), GROK_HOME: grokPath(), IDNMA_AGY_PLUGINS_DIR: join(dir, "no-agy", "plugins"), IDNMA_AGY_BIN: join(dir, "no-agy", "bin"), PI_CODING_AGENT_DIR: join(dir, "no-pi"), ...extraEnv };
  const child = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

const grokPath = (): string => join(dir, "no-grok");
const agyNoneLine = "agy : plugin idnma absent, rien touché\n";
const agyAbsentLine = (): string => `agy : absent (${join(dir, "no-agy")}), rien installé\n`;

const codex = (command: "install" | "uninstall"): string[] => [command, "--agent", "codex"];
/** Seconde moitié de la ligne de Codex : la skill générique, sous <CODEX_HOME>/skills. */
const codexSkill = (label: string): string => ` ; skill ${GENERIC_SKILL} ${label} ${join(dir, "skills")}`;

describe("idnma install / uninstall --agent", () => {
  childTest("install then uninstall --agent codex report on one line and restore the file", async () => {
    const original = "# Mes règles\n";
    writeFileSync(agentsPath, original);

    const first = await cli(codex("install"), dir);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(`Codex : ligne coéquipier installée dans ${agentsPath}${codexSkill("installée dans")}\n`);
    expect(first.stderr).toBe("");
    expect(readFileSync(join(dir, "skills", GENERIC_SKILL, "SKILL.md"), "utf8")).toBe(skillText(GENERIC_SKILL));

    const second = await cli(["install", "--agent=codex"], dir);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(`Codex : ligne coéquipier déjà à jour dans ${agentsPath}${codexSkill("déjà à jour dans")}\n`);

    writeFileSync(agentsPath, readFileSync(agentsPath, "utf8").replace(TEAMMATE_TEXT, "anciens mots"));
    const third = await cli(codex("install"), dir);
    expect(third.code).toBe(0);
    expect(third.stdout).toBe(`Codex : ligne coéquipier mise à jour dans ${agentsPath}${codexSkill("déjà à jour dans")}\n`);

    const removed = await cli(codex("uninstall"), dir);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toBe(`Codex : ligne coéquipier retirée de ${agentsPath}${codexSkill("retirée de")}\n`);
    expect(readFileSync(agentsPath, "utf8")).toBe(original);
    expect(existsSync(join(dir, "skills", GENERIC_SKILL))).toBe(false);

    const again = await cli(codex("uninstall"), dir);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(`Codex : ligne coéquipier absente de ${agentsPath}, rien touché${codexSkill("absente de")}\n`);
  });

  childTest("install --agent codex creates AGENTS.md in an existing CODEX_HOME and uninstall removes it", async () => {
    expect((await cli(codex("install"), dir)).code).toBe(0);
    expect(readFileSync(agentsPath, "utf8")).toBe(block(TEAMMATE_START_CREATED));
    expect((await cli(codex("uninstall"), dir)).code).toBe(0);
    expect(existsSync(agentsPath)).toBe(false);
  });

  childTest("install and uninstall --agent codex without Codex report it absent and exit 0", async () => {
    const missing = join(dir, "absent");
    const installed = await cli(codex("install"), missing);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(`Codex : absent (${missing}), rien installé\n`);
    expect(installed.stderr).toBe("");
    expect(existsSync(missing)).toBe(false);
    const removed = await cli(codex("uninstall"), missing);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toBe(`Codex : absent (${missing}), rien retiré\n`);
  });

  childTest("install --agent grok touches Grok only, and uninstall removes what it laid", async () => {
    mkdirSync(grokPath());
    const installed = await cli(["install", "--agent", "grok"], dir);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(`Grok : hooks, ligne coéquipier et skill installés dans ${grokPath()}\n`);
    expect(existsSync(join(grokPath(), "hooks", "idnma.json"))).toBe(true);
    // Seul l'agent nommé est touché : ni l'AGENTS.md de Codex ni le plugin d'agy.
    expect(existsSync(agentsPath)).toBe(false);
    expect(existsSync(join(dir, "no-agy"))).toBe(false);
    expect((await cli(["install", "--agent", "grok"], dir)).stdout).toBe(`Grok : hooks, ligne coéquipier et skill déjà à jour dans ${grokPath()}\n`);

    const removed = await cli(["uninstall", "--agent", "grok"], dir);
    expect(removed.stdout).toBe(`Grok : hooks, ligne coéquipier et skill retirés de ${grokPath()}\n`);
    expect(existsSync(join(grokPath(), "hooks", "idnma.json"))).toBe(false);
    expect((await cli(["uninstall", "--agent", "grok"], dir)).stdout).toBe(`Grok : rien à retirer de ${grokPath()}\n`);
  });

  childTest("install --agent agy goes through the agy binary, and uninstall removes the plugin", async () => {
    // Faux agy : `plugin install <dossier>` copie le dossier dans le dossier de plugins, `plugin uninstall idnma` le retire.
    const agyHome = join(dir, "gemini", "config");
    const plugins = join(agyHome, "plugins");
    const fakeBin = join(dir, "fake-agy.sh");
    writeFileSync(
      fakeBin,
      `#!/bin/sh\nif [ "$2" = install ]; then mkdir -p "${plugins}" && rm -rf "${plugins}/idnma" && cp -R "$3" "${plugins}/idnma"; exit $?; fi\nif [ "$2" = uninstall ]; then rm -rf "${plugins}/$3"; exit 0; fi\nexit 3\n`,
    );
    chmodSync(fakeBin, 0o755);
    mkdirSync(agyHome, { recursive: true });
    const env = { IDNMA_AGY_PLUGINS_DIR: plugins, IDNMA_AGY_BIN: fakeBin };
    const line = (word: string): string => `agy : plugin idnma ${word} (${plugins}/idnma)\n`;
    const agy = (command: "install" | "uninstall") => cli([command, "--agent", "agy"], dir, env);

    expect((await agy("install")).stdout).toBe(line("installé"));
    expect(existsSync(join(plugins, "idnma", "hooks.json"))).toBe(true);
    expect(existsSync(agentsPath)).toBe(false);
    expect((await agy("install")).stdout).toBe(line("déjà à jour"));

    writeFileSync(join(plugins, "idnma", "rules", "AGENTS.md"), "anciens mots\n");
    expect((await agy("install")).stdout).toBe(line("mis à jour"));

    expect((await agy("uninstall")).stdout).toBe("agy : plugin idnma retiré\n");
    expect(existsSync(join(plugins, "idnma"))).toBe(false);
    expect((await agy("uninstall")).stdout).toBe("agy : plugin idnma absent, rien touché\n");
  });

  childTest("install then uninstall --agent pi lay and remove the block and the skill in the pi agent dir (AC-8)", async () => {
    const piDir = join(dir, "pi-agent");
    mkdirSync(piDir);
    const piAgents = join(piDir, "AGENTS.md");
    const original = "# Règles de pi\nsans saut final";
    writeFileSync(piAgents, original);
    const pi = (command: "install" | "uninstall") => cli([command, "--agent", "pi"], dir, { PI_CODING_AGENT_DIR: piDir });
    const piSkill = (label: string): string => ` ; skill ${GENERIC_SKILL} ${label} ${join(piDir, "skills")}`;

    const installed = await pi("install");
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(`pi : ligne coéquipier installée dans ${piAgents}${piSkill("installée dans")}\n`);
    expect(readFileSync(piAgents, "utf8")).toBe(`${original}\n\n${block(TEAMMATE_START_EOL)}`);
    expect(readFileSync(join(piDir, "skills", GENERIC_SKILL, "SKILL.md"), "utf8")).toBe(skillText(GENERIC_SKILL));
    // Seul pi est touché : ni l'AGENTS.md de Codex.
    expect(existsSync(agentsPath)).toBe(false);
    expect((await pi("install")).stdout).toBe(`pi : ligne coéquipier déjà à jour dans ${piAgents}${piSkill("déjà à jour dans")}\n`);

    const removed = await pi("uninstall");
    expect(removed.code).toBe(0);
    expect(removed.stdout).toBe(`pi : ligne coéquipier retirée de ${piAgents}${piSkill("retirée de")}\n`);
    expect(readFileSync(piAgents, "utf8")).toBe(original);
    expect(existsSync(join(piDir, "skills", GENERIC_SKILL))).toBe(false);
  });

  childTest("install and uninstall --agent pi without a pi agent dir report it absent and create nothing", async () => {
    const missing = join(dir, "no-pi");
    const installed = await cli(["install", "--agent", "pi"], dir);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(`pi : absent (${missing}), rien installé\n`);
    expect(existsSync(missing)).toBe(false);
    expect((await cli(["uninstall", "--agent", "pi"], dir)).stdout).toBe(`pi : absent (${missing}), rien retiré\n`);
  });

  childTest("install --agent agy without agy reports it absent", async () => {
    const result = await cli(["install", "--agent", "agy"], dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`agy : absent (${join(dir, "no-agy")}), rien installé\n`);
  });

  childTest("a malformed block exits 1 with the French message", async () => {
    writeFileSync(agentsPath, `${TEAMMATE_START}\n`);
    const result = await cli(codex("install"), dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("bloc idnma mal formé");
    expect(readFileSync(agentsPath, "utf8")).toBe(`${TEAMMATE_START}\n`);
  });

  childTest("without --agent, with an unknown agent or with an extra argument: usage error (exit 2), nothing touched", async () => {
    for (const command of ["install", "uninstall"]) {
      for (const args of [[], ["--agent"], ["--agent", "gemini"], ["--agent", "codex", "extra"], ["codex"]]) {
        const result = await cli([command, ...args], dir);
        expect({ command, args, code: result.code }).toEqual({ command, args, code: 2 });
        expect(result.stderr).toContain("agy, claude, codex, dst, grok, opencode, pi");
      }
    }
    expect(existsSync(agentsPath)).toBe(false);
  });

  childTest("the main help and the install help show --agent", async () => {
    const main = await cli(["--help"], dir);
    expect(main.stdout).toContain("idnma install --agent <agent>");
    expect(main.stdout).toContain("idnma uninstall --agent <agent>");
    for (const command of ["install", "uninstall"]) {
      const help = await cli([command, "--help"], dir);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`idnma ${command} --agent <agent>`);
      expect(help.stdout).toContain("agy, claude, codex, dst, grok, opencode, pi");
    }
  });
});
