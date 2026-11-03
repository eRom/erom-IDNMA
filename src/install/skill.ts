import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Skills idnma : un dossier à nous, `<dossier de skills du harnais>/<nom>/SKILL.md`, recopié depuis
// `skills/<nom>/SKILL.md` de ce checkout. Les skills voisines ne sont jamais ouvertes.

/** Skill de Claude Code : le bus natif (`ListAgents`, `SendMessage`). */
export const CLAUDE_SKILL = "claude-idnma-network";
/** Skill des autres harnais : la CLI `idnma`. */
export const GENERIC_SKILL = "generic-idnma-network";

export type SkillName = typeof CLAUDE_SKILL | typeof GENERIC_SKILL;

/** Contenu de référence de la skill, lu dans ce checkout. */
export function skillText(name: SkillName): string {
  return readFileSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

/** Chemin relatif de la skill sous un dossier de skills. */
export const skillFile = (name: SkillName): string => join(name, "SKILL.md");

/** Supprime `path` s'il est un dossier vide ; ne touche à rien d'autre. */
export function removeEmptyDir(path: string): void {
  if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
}

export function installSkill(skillsDir: string, name: SkillName): "installed" | "updated" | "unchanged" {
  const path = join(skillsDir, skillFile(name));
  const content = skillText(name);
  const existed = existsSync(path);
  if (existed && readFileSync(path, "utf8") === content) return "unchanged";
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.idnma-${process.pid}.tmp`;
  try {
    writeFileSync(temp, content);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return existed ? "updated" : "installed";
}

export function uninstallSkill(skillsDir: string, name: SkillName): "removed" | "absent" {
  const path = join(skillsDir, skillFile(name));
  if (!existsSync(path)) return "absent";
  rmSync(path);
  removeEmptyDir(dirname(path));
  return "removed";
}
