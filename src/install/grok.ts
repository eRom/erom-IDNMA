import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { grokHome } from "../paths.ts";
import { hookCommand } from "./hook-command.ts";
import { GENERIC_SKILL, removeEmptyDir, skillFile, skillText } from "./skill.ts";
import { TEAMMATE_TEXT } from "./teammate.ts";

// Installation pour Grok : trois fichiers à nous dans ~/.grok (hooks/idnma.json, rules/idnma-teammate.md
// et skills/generic-idnma-network/SKILL.md).
// Le config.toml de l'utilisateur et les fichiers voisins ne sont jamais ouverts en écriture.

export const GROK_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopCancelled",
  "StopFailure",
  "Notification",
] as const;

/** Délai d'un hook en secondes ; `idnma hook` s'arrête de lui-même à 3 s. */
const HOOK_TIMEOUT_SECONDS = 10;

export interface GrokCommandHandler {
  type: "command";
  command: string;
  args: string[];
  timeout: number;
}

export interface GrokHooksConfig {
  hooks: Record<string, Array<{ hooks: GrokCommandHandler[] }>>;
}

/** Un hook de type commande par événement, dans la forme `command` + `args` exécutée par Grok 1.0.70. */
export function grokHooksConfig(c: { bun: string; cli: string }): GrokHooksConfig {
  const hooks: GrokHooksConfig["hooks"] = {};
  for (const event of GROK_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: "command", command: c.bun, args: [c.cli, "hook", "grok", event], timeout: HOOK_TIMEOUT_SECONDS }] }];
  }
  return { hooks };
}

const hooksPath = (): string => join(grokHome(), "hooks", "idnma.json");
const rulePath = (): string => join(grokHome(), "rules", "idnma-teammate.md");
const skillPath = (): string => join(grokHome(), "skills", skillFile(GENERIC_SKILL));

/** Écrit par fichier temporaire du même dossier puis renommage ; crée les dossiers au besoin. */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.idnma-${process.pid}.tmp`;
  try {
    writeFileSync(temp, content);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

const readOrNull = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

export function installGrok(c: { bun: string; cli: string } = hookCommand()): "installed" | "updated" | "unchanged" | "absent" {
  if (!existsSync(grokHome())) return "absent";
  const files: Array<[string, string]> = [
    [hooksPath(), JSON.stringify(grokHooksConfig(c), null, 2) + "\n"],
    [rulePath(), `${TEAMMATE_TEXT}\n`],
    [skillPath(), skillText(GENERIC_SKILL)],
  ];
  const current = files.map(([path]) => readOrNull(path));
  if (files.every(([, content], index) => current[index] === content)) return "unchanged";
  for (const [path, content] of files) writeAtomic(path, content);
  return current.every((existing) => existing === null) ? "installed" : "updated";
}

export function uninstallGrok(): "removed" | "absent" {
  let removed = false;
  for (const path of [hooksPath(), rulePath(), skillPath()]) {
    if (!existsSync(path)) continue;
    rmSync(path);
    removed = true;
  }
  removeEmptyDir(dirname(skillPath()));
  return removed ? "removed" : "absent";
}
