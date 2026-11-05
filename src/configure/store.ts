import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** Empreinte d'un fichier absent : un fichier qui apparaît change l'empreinte comme une édition. */
const ABSENT = "absent";

/** Mode d'un fichier créé par l'app, quand il n'y a pas de fichier dont reprendre le mode. */
const DEFAULT_MODE = 0o644;

export type SaveResult = { kind: "written"; hash: string } | { kind: "changed-on-disk" } | { kind: "failed"; message: string };

/** Empreinte (sha256 hexadécimal) du texte d'un fichier ; `"absent"` quand il n'existe pas. */
export function textHash(text: string | undefined): string {
  return text === undefined ? ABSENT : createHash("sha256").update(text).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/** Lit le fichier : `text` est `undefined` s'il n'existe pas. Toute autre erreur de lecture remonte. */
export function readConfig(path: string): { text: string | undefined; hash: string } {
  try {
    const text = readFileSync(path, "utf-8");
    return { text, hash: textHash(text) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { text: undefined, hash: ABSENT };
    throw error;
  }
}

/** Mode du fichier existant (permissions seules), sinon celui d'un fichier neuf. */
function targetMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * Écrit `text` dans `path` si le fichier n'a pas bougé depuis la lecture qui a donné `baseHash`.
 * L'écriture passe par un temporaire du même dossier puis `renameSync` : le fichier est remplacé en une fois
 * ou pas du tout. Le seul fichier supprimé est ce temporaire, créé par ce process. L'échec se rend en message
 * (chemin et code d'erreur, jamais le contenu) : l'appelant l'affiche tel quel.
 */
export function saveConfig(path: string, text: string, baseHash: string): SaveResult {
  const temporary = `${path}.idnma-tmp-${process.pid}`;
  try {
    if (readConfig(path).hash !== baseHash) return { kind: "changed-on-disk" };
    const mode = targetMode(path);
    try {
      // `wx` : jamais d'écrasement d'un fichier qui n'est pas celui de ce process (EEXIST : rien n'a été créé).
      writeFileSync(temporary, text, { flag: "wx", mode });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") removeOwnTemporary(temporary);
      throw error;
    }
    try {
      // Le masque de création (umask) a pu réduire le mode demandé.
      chmodSync(temporary, mode);
      renameSync(temporary, path);
    } catch (error) {
      removeOwnTemporary(temporary);
      throw error;
    }
    return { kind: "written", hash: textHash(text) };
  } catch (error) {
    return { kind: "failed", message: `Could not write ${path}: ${errorCode(error) ?? "unknown error"}.` };
  }
}

/** Retire le temporaire de ce process s'il a été créé ; un temporaire absent n'est pas une erreur. */
function removeOwnTemporary(temporary: string): void {
  try {
    unlinkSync(temporary);
  } catch {
    // Rien à retirer : l'ouverture a échoué avant de créer le fichier.
  }
}
