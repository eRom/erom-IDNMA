import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ConfigError } from "../config/network.ts";
import { agyBinary, agyPluginsDir } from "../paths.ts";
import { hookCommand } from "./hook-command.ts";
import { GENERIC_SKILL, skillFile, skillText } from "./skill.ts";
import { TEAMMATE_TEXT } from "./teammate.ts";

// Installation pour agy : un plugin `idnma` (hooks, règle coéquipier et skill) posé et retiré par la CLI `agy`
// elle-même. Le hooks.json, le GEMINI.md et le reste de ~/.gemini ne sont jamais ouverts en écriture.

/** Jamais `PreToolUse` : un hook qui y répond `{}` bloque les outils d'agy, et `allow` les approuverait d'office. */
export const AGY_HOOK_EVENTS = ["SessionStart", "PreInvocation", "Stop"] as const;

/** Délai d'un hook en secondes ; `idnma hook` s'arrête de lui-même à 3 s. */
const HOOK_TIMEOUT_SECONDS = 10;

const PLUGIN_NAME = "idnma";

export type AgyRunner = (args: string[]) => { exitCode: number; output: string };

/** Lance le vrai `agy` ; stdout et stderr réunis. */
const spawnAgy: AgyRunner = (args) => {
  try {
    const result = Bun.spawnSync([agyBinary(), ...args], { stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
  } catch (error) {
    // Binaire introuvable ou non exécutable : `Bun.spawnSync` lève, on le rend comme un échec d'agy.
    return { exitCode: 127, output: error instanceof Error ? error.message : String(error) };
  }
};

/** Entre apostrophes pour `sh -c` : une apostrophe interne devient `'\''`. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Les fichiers du plugin, par chemin relatif à son dossier. */
export function agyPluginFiles(c: { bun: string; cli: string }): Record<string, string> {
  const hooks: Record<string, Array<{ type: "command"; command: string; timeout: number }>> = {};
  for (const event of AGY_HOOK_EVENTS) {
    hooks[event] = [{ type: "command", command: `${shellQuote(c.bun)} ${shellQuote(c.cli)} hook agy ${event}`, timeout: HOOK_TIMEOUT_SECONDS }];
  }
  return {
    "plugin.json": `{\n  "name": "${PLUGIN_NAME}"\n}\n`,
    "rules/AGENTS.md": `${TEAMMATE_TEXT}\n`,
    "hooks.json": JSON.stringify({ [PLUGIN_NAME]: hooks }, null, 2) + "\n",
    [join("skills", skillFile(GENERIC_SKILL))]: skillText(GENERIC_SKILL),
  };
}

/** Chemins relatifs de tous les fichiers sous `root`, triés ; les noms cachés (`.DS_Store`…) sont ignorés. */
function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
}

/** Le dossier installé porte exactement ces fichiers, avec ce contenu. */
function matchesInstalled(root: string, files: Record<string, string>): boolean {
  if (!existsSync(root)) return false;
  const expected = Object.keys(files).sort();
  const actual = listFiles(root);
  if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) return false;
  return expected.every((path) => readFileSync(join(root, path), "utf8") === files[path]);
}

const firstLine = (output: string): string => output.trim().split("\n")[0] ?? "";

export function installAgy(o: { run?: AgyRunner; command?: { bun: string; cli: string } } = {}): "installed" | "updated" | "unchanged" | "absent" {
  const pluginsDir = agyPluginsDir();
  if (!existsSync(dirname(pluginsDir))) return "absent";
  // ~/.gemini/config est partagé avec Gemini CLI : le dossier peut exister sans agy, et lancer un binaire introuvable lève.
  if (o.run === undefined && Bun.which(agyBinary()) === null) return "absent";
  const run = o.run ?? spawnAgy;
  const files = agyPluginFiles(o.command ?? hookCommand());
  const target = join(pluginsDir, PLUGIN_NAME);
  if (matchesInstalled(target, files)) return "unchanged";
  const existed = existsSync(target);

  const work = mkdtempSync(join(tmpdir(), "idnma-agy-"));
  try {
    const staged = join(work, PLUGIN_NAME);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(staged, path)), { recursive: true });
      writeFileSync(join(staged, path), content);
    }
    const result = run(["plugin", "install", staged]);
    if (result.exitCode !== 0) throw new ConfigError(`agy plugin install a échoué : ${firstLine(result.output)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return existed ? "updated" : "installed";
}

export function uninstallAgy(o: { run?: AgyRunner } = {}): "removed" | "absent" {
  if (!existsSync(join(agyPluginsDir(), PLUGIN_NAME))) return "absent";
  const result = (o.run ?? spawnAgy)(["plugin", "uninstall", PLUGIN_NAME]);
  if (result.exitCode !== 0) throw new ConfigError(`agy plugin uninstall a échoué : ${firstLine(result.output)}`);
  return "removed";
}
