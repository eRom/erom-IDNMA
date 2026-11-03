import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { ConfigError } from "../config/network.ts";
import { dshHome } from "../paths.ts";
import { GENERIC_SKILL, installSkill, removeEmptyDir, uninstallSkill } from "./skill.ts";
import { installTeammateLine, toRaw, uninstallTeammateLine, writeAtomic } from "./teammate.ts";

// Plugin idnma de dst (DeepSeek Harness TUI) : un bloc délimité dans le patch « home » de dsh
// (<home>/cordis.patch.yml), plus la ligne coéquipier (<home>/AGENTS.md) et la skill générique.
// Le fichier appartient à l'utilisateur : l'installation n'ajoute que le bloc, la désinstallation rend le fichier
// octet pour octet. La ligne de début du bloc dit ce que l'installation a ajouté ou remplacé.

/** Préfixe de la ligne de début ; la variante et le rappel de désinstallation suivent. */
export const DST_PATCH_START = "# >>> idnma";
export const DST_PATCH_END = "# <<< idnma";
const START_SUFFIX = " (ne pas éditer : idnma uninstall --agent dst le retire)";
const PATCH_FILE = "cordis.patch.yml";
const EMPTY_LIST_PREFIX = " empty-list:";

/** Dit comment rendre le fichier : le "\n" ajouté avant le bloc, selon la variante (`empty-list` : voir `restoredOf`). */
const ADDED_BEFORE: Record<string, string> = { "": "", " eol-added": "\n", " created": "" };
const VARIANT = /^( eol-added| created| empty-list:[A-Za-z0-9+/=]*)?$/;
/** La seule ligne utile du gabarit de patch livré par dsh : `[]`, éventuellement commentée. */
const EMPTY_LIST_LINE = /^\s*\[\s*\]\s*(#[^\n]*)?$/;

const startLineOf = (variant: string): string => toRaw(`${DST_PATCH_START}${variant}${START_SUFFIX}`);

/** Chemin réel de `src/dst/plugin.ts` de ce checkout, comme `hookCommand` pour les hooks. */
export function dstPluginPath(): string {
  return realpathSync(fileURLToPath(new URL("../dst/plugin.ts", import.meta.url)));
}

/** Corps du bloc : `JSON.stringify` produit seul les guillemets doubles du chemin (chaîne YAML valide). */
const bodyFor = (pluginPath: string): string =>
  toRaw(`- insert:\n    - id: idnma-bridge\n      name: ${JSON.stringify(pluginPath)}\n      disabled: !!js '!process.env.IDNMA_DST_BRIDGE'\n`);

interface Block {
  /** Début de la ligne de début. */
  start: number;
  startLine: string;
  /** Variante lue dans la ligne de début. */
  variant: string;
  /** Fin du bloc : après le "\n" de la ligne de fin, ou fin du fichier. */
  end: number;
  /** Texte entre la ligne de début et la ligne de fin (le corps, "\n" final compris). */
  inner: string;
}

function malformed(path: string): ConfigError {
  return new ConfigError(`bloc idnma mal formé dans ${path} : corrige-le à la main`);
}

/** Cherche le bloc ; `null` sans aucun marqueur, `ConfigError` si les marqueurs sont incohérents. */
function findBlock(raw: string, path: string): Block | null {
  const suffix = toRaw(START_SUFFIX);
  const starts: Array<{ offset: number; line: string; variant: string }> = [];
  const ends: Array<{ offset: number; next: number }> = [];
  let offset = 0;
  while (offset <= raw.length) {
    const newline = raw.indexOf("\n", offset);
    const lineEnd = newline === -1 ? raw.length : newline;
    const line = raw.slice(offset, lineEnd);
    const next = newline === -1 ? raw.length : newline + 1;
    if (line.startsWith(DST_PATCH_START)) {
      // Une ligne de début éditée à la main n'est plus un marqueur sûr : on refuse plutôt que de deviner.
      const rest = line.slice(DST_PATCH_START.length);
      if (!rest.endsWith(suffix)) throw malformed(path);
      const variant = rest.slice(0, rest.length - suffix.length);
      if (!VARIANT.test(variant)) throw malformed(path);
      starts.push({ offset, line, variant });
    } else if (line === DST_PATCH_END) ends.push({ offset, next });
    if (newline === -1) break;
    offset = next;
  }
  if (starts.length === 0 && ends.length === 0) return null;
  const start = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end.offset < start.offset) throw malformed(path);
  const innerFrom = start.offset + start.line.length + 1;
  return { start: start.offset, startLine: start.line, variant: start.variant, end: end.next, inner: raw.slice(innerFrom, Math.max(innerFrom, end.offset)) };
}

/** Balise `!!js` de dsh : on ne l'évalue pas, on garde la chaîne (aucun avertissement du parseur). */
const JS_TAG = { tag: "tag:yaml.org,2002:js", resolve: (value: string): string => value };

/** Relit le résultat avant l'écriture : une séquence qui contient l'entrée `idnma-bridge`, sinon refus. */
function checkResult(raw: string, path: string): void {
  const doc = parseDocument(Buffer.from(raw, "latin1").toString("utf8"), { customTags: [JS_TAG], logLevel: "silent" });
  const items: unknown = doc.errors.length === 0 ? doc.toJS() : null;
  const hasBridge =
    Array.isArray(items) &&
    items.some((item) => {
      const insert = (item as { insert?: unknown } | null)?.insert;
      return Array.isArray(insert) && (insert[0] as { id?: unknown } | undefined)?.id === "idnma-bridge";
    });
  if (!hasBridge) throw new ConfigError(`forme inattendue dans ${path} : ajoute le bloc à la main`);
}

export function installDstPatch(path: string, pluginPath: string = dstPluginPath()): "installed" | "updated" | "unchanged" {
  const body = bodyFor(pluginPath);
  const blockWith = (startLine: string): string => `${startLine}\n${body}${DST_PATCH_END}\n`;

  if (!existsSync(path)) {
    const created = blockWith(startLineOf(" created"));
    checkResult(created, path);
    writeAtomic(path, created, 0o644);
    return "installed";
  }
  const raw = readFileSync(path).toString("latin1");
  const mode = statSync(path).mode & 0o7777;
  const found = findBlock(raw, path);

  if (found !== null) {
    if (found.inner === body) return "unchanged";
    // Remplacement sur place : la ligne de début d'origine est gardée, elle porte la restitution.
    const updated = `${raw.slice(0, found.start)}${blockWith(found.startLine)}${raw.slice(found.end)}`;
    checkResult(updated, path);
    writeAtomic(path, updated, mode);
    return "updated";
  }

  const emptyList = emptyListLine(raw);
  let result: string;
  if (emptyList !== null) {
    // Gabarit de dsh : la ligne `[]` laisse la place au bloc, ses commentaires restent.
    const variant = `${EMPTY_LIST_PREFIX}${Buffer.from(raw.slice(emptyList.from, emptyList.to), "latin1").toString("base64")}`;
    result = `${raw.slice(0, emptyList.from)}${blockWith(startLineOf(variant))}${raw.slice(emptyList.to)}`;
  } else {
    const variant = raw === "" || raw.endsWith("\n") ? "" : " eol-added";
    result = `${raw}${ADDED_BEFORE[variant]}${blockWith(startLineOf(variant))}`;
  }
  checkResult(result, path);
  writeAtomic(path, result, mode);
  return "installed";
}

/** Une ligne ni vide ni commentaire : du YAML qui compte. */
const hasUsefulLine = (text: string): boolean => text.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#"));

/** Étendue (terminateur compris) de la seule ligne utile du fichier si c'est `[]`, sinon `null`. */
function emptyListLine(raw: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  let offset = 0;
  while (offset < raw.length) {
    const newline = raw.indexOf("\n", offset);
    const next = newline === -1 ? raw.length : newline + 1;
    const line = raw.slice(offset, newline === -1 ? raw.length : newline);
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      if (found !== null || !EMPTY_LIST_LINE.test(line)) return null;
      found = { from: offset, to: next };
    }
    offset = next;
  }
  return found;
}

export function uninstallDstPatch(path: string): "removed" | "absent" {
  if (!existsSync(path)) return "absent";
  const raw = readFileSync(path).toString("latin1");
  const found = findBlock(raw, path);
  if (found === null) return "absent";

  let restored: string;
  if (found.variant.startsWith(EMPTY_LIST_PREFIX)) {
    // La ligne d'origine (terminateur compris) revient à la place du bloc, mais seulement si rien d'autre ne
    // reste : à côté d'une entrée ajoutée par l'utilisateur, un `[]` rendrait le fichier invalide, on le laisse tomber.
    const outside = `${raw.slice(0, found.start)}${raw.slice(found.end)}`;
    const original = Buffer.from(found.variant.slice(EMPTY_LIST_PREFIX.length), "base64").toString("latin1");
    restored = hasUsefulLine(outside) ? outside : `${raw.slice(0, found.start)}${original}${raw.slice(found.end)}`;
  } else {
    // On retire le bloc et exactement ce que l'installation a ajouté avant lui, rien de plus.
    const added = ADDED_BEFORE[found.variant] ?? "";
    const cutFrom = raw.slice(0, found.start).endsWith(added) ? found.start - added.length : found.start;
    restored = `${raw.slice(0, cutFrom)}${raw.slice(found.end)}`;
  }

  if (found.variant === " created" && restored === "") {
    rmSync(path);
    return "removed";
  }
  writeAtomic(path, restored, statSync(path).mode & 0o7777);
  return "removed";
}

export type DstPluginState = { kind: "installed" } | { kind: "absent" } | { kind: "other-checkout"; path: string };

/** Le plugin est-il activé dans le patch de <home>, et pour ce checkout ? Lit le `name:` du bloc. */
export function dstPluginState(home: string = dshHome(), pluginPath: string = dstPluginPath()): DstPluginState {
  const path = join(home, PATCH_FILE);
  if (!existsSync(path)) return { kind: "absent" };
  const raw = readFileSync(path).toString("latin1");
  const found = findBlock(raw, path);
  if (found === null) return { kind: "absent" };
  const name = /^\s+name: (".*")\s*$/m.exec(found.inner)?.[1];
  if (name === undefined) return { kind: "absent" };
  let installedPath: unknown;
  try {
    installedPath = JSON.parse(Buffer.from(name, "latin1").toString("utf8"));
  } catch {
    return { kind: "absent" };
  }
  if (typeof installedPath !== "string") return { kind: "absent" };
  return installedPath === pluginPath ? { kind: "installed" } : { kind: "other-checkout", path: installedPath };
}

/** Patch, puis coéquipier, puis skill. `absent` : le dossier de dsh n'existe pas, rien n'est créé. */
export function installDst(): "installed" | "updated" | "unchanged" | "absent" {
  const home = dshHome();
  if (!existsSync(home)) return "absent";
  const outcomes = [
    installDstPatch(join(home, PATCH_FILE)),
    installTeammateLine(join(home, "AGENTS.md")),
    installSkill(join(home, "skills"), GENERIC_SKILL),
  ];
  if (outcomes.every((outcome) => outcome === "unchanged")) return "unchanged";
  return outcomes.every((outcome) => outcome === "installed") ? "installed" : "updated";
}

/** Retire patch, coéquipier et skill ; le dossier `skills/` n'est retiré que s'il est resté vide après la skill. */
export function uninstallDst(): "removed" | "absent" {
  const home = dshHome();
  if (!existsSync(home)) return "absent";
  const skills = join(home, "skills");
  // Patch et coéquipier d'abord : ce sont eux qui peuvent refuser (bloc mal formé), avant tout retrait.
  const patch = uninstallDstPatch(join(home, PATCH_FILE));
  const teammate = uninstallTeammateLine(join(home, "AGENTS.md"));
  const skill = uninstallSkill(skills, GENERIC_SKILL);
  if (skill === "removed") removeEmptyDir(skills);
  return [patch, teammate, skill].includes("removed") ? "removed" : "absent";
}
