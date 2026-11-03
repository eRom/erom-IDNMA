import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { listLiveEntries } from "../bus/registry.ts";
import { ConfigError } from "../config/network.ts";
import { configDir } from "../paths.ts";
import { withLock } from "./lock.ts";
import { nickname } from "./nicknames.ts";

const VALID_NAME = /^[A-Za-z0-9_-]+$/;
// Claude 2.1.310 tronque `from-name` à 64 caractères (`W_`) en reconstruisant l'enveloppe : un nom
// plus long la rendrait non canonique chez le destinataire.
const MAX_NAME_LENGTH = 64;

/** Ce qui empêche `name` (un `--name` tapé) de servir de nom de session ; `undefined` s'il convient. */
export function nameFormatProblem(name: string): string | undefined {
  // Un nom qui commence par un tiret serait pris pour une option par le harnais.
  if (name.startsWith("-")) return `le nom « ${name} » ne peut pas commencer par un tiret.`;
  if (!VALID_NAME.test(name)) return `nom invalide « ${name} » : lettres, chiffres, tiret et tiret bas uniquement.`;
  if (name.length > MAX_NAME_LENGTH) return `nom trop long : ${MAX_NAME_LENGTH} caractères au plus (${name.length} donnés).`;
  return undefined;
}

/**
 * Refuse un nom déjà porté par une session vivante : Claude laisse deux sessions porter le même
 * nom (mesuré le 26/10), et le bus livrerait alors à l'une ce qui était destiné à l'autre.
 * À appeler sous `withNameLock`.
 */
export function assertNameFree(name: string): void {
  const holder = listLiveEntries().find((entry) => entry.name === name);
  if (holder !== undefined) throw new ConfigError(`Le nom « ${name} » est déjà pris par la session vivante de pid ${holder.pid}.`);
}

/** Section critique sur les noms de la machine : verrou `names.lock` dans le dossier de config. */
export async function withNameLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  return withLock(join(dir, "names"), fn);
}

/**
 * Choisit le nom d'une session, `<base>-<divinité>-<4 base36>`, unique parmi toutes les sessions
 * vivantes de la machine. À appeler sous `withNameLock` pour que le nom choisi soit inscrit avant
 * qu'un autre le tire.
 */
export function chooseName(base: string): string {
  return nickname(base, { taken: new Set(listLiveEntries().map((entry) => entry.name)) });
}
