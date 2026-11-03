// Copie de erom-agence-control-plane/src/swarm/lock.ts (variables d'environnement IDNMA_LOCK_*).
import { dlopen, FFIType } from "bun:ffi";
import { openSync, closeSync } from "node:fs";

// Budget d'environ 10 s (334 essais espacés de 30 ms) : mesuré, 9 lancements simultanés prennent
// déjà près d'1 s, et l'ancien budget de 1,5 s faisait échouer une rafale de 20.
const MAX_RETRIES_DEFAULT = 334;
const RETRY_DELAY_MS_DEFAULT = 30;

// Constantes overridables par env (lues dynamiquement : un override posé en
// test est pris en compte sans réimport). `||` (pas `??`) : une env var VIDE
// vaut non définie ; une valeur non numérique ou <= 0 retombe sur le défaut.
function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name] || fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const maxRetries = () => envNum("IDNMA_LOCK_MAX_RETRIES", MAX_RETRIES_DEFAULT);
const retryDelayMs = () => envNum("IDNMA_LOCK_RETRY_MS", RETRY_DELAY_MS_DEFAULT);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// flock(2) via libc. Verrou consultatif tenu par le DESCRIPTEUR : le kernel le
// libère à la fermeture du fd, donc aussi à la mort du process. Il n'existe donc
// AUCUN verrou "périmé" à récupérer : ni TTL, ni reaping, ni TOCTOU (un verrou par
// manipulation de pathname + reaping ne peut pas être race-free faute de
// compare-and-delete atomique).
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const libc = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";
const { symbols } = dlopen(libc, {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/**
 * Prend le verrou de `<targetPath>.lock` et rend sa fonction de relâche (idempotente). Le verrou
 * reste tenu jusqu'à cet appel : il survit au retour de la fonction, contrairement à `withLock`.
 * `signal` abandonné pendant l'attente : rejet, descripteur fermé.
 */
export async function acquireLock(
  targetPath: string,
  o: { maxRetries?: number; label?: string; signal?: AbortSignal } = {},
): Promise<() => void> {
  const lockPath = `${targetPath}.lock`;
  const label = o.label ?? "des noms";
  const retries = o.maxRetries ?? maxRetries();
  // Inode STABLE et partagé : on n'efface JAMAIS le fichier de verrou. Le supprimer
  // ferait flock-er des inodes différents à deux acteurs -> plus d'exclusion.
  // "a" crée le fichier si absent sans toucher à son contenu (inutilisé).
  const fd = openSync(lockPath, "a");
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    symbols.flock(fd, LOCK_UN); // libération immédiate (close suffirait aussi)
    closeSync(fd);
  };
  try {
    for (let i = 0; i < retries; i++) {
      if (o.signal?.aborted) throw new Error(`attente du verrou ${label} abandonnée`);
      // LOCK_NB : non bloquant (un flock bloquant gèlerait la boucle d'événements).
      // 0 = acquis ; -1 = déjà tenu (EWOULDBLOCK) -> on patiente et on retente.
      if (symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return release;
      await sleep(retryDelayMs());
    }
    throw new Error(`Impossible d'obtenir le verrou ${label} : ${lockPath}`);
  } catch (error) {
    release();
    throw error;
  }
}

export async function withLock<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(targetPath);
  try {
    return await fn();
  } finally {
    release();
  }
}
