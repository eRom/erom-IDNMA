import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionsDir } from "../paths.ts";
import { isValidPid, pidDomain, procStarts } from "./proc.ts";

/** Nom du fichier de clé que Claude lit : `<pid>.<sha256(chemin résolu du socket)>.key`. */
export function keyFileName(pid: number, socketPath: string): string {
  return `${pid}.${socketHash(socketPath)}.key`;
}

function socketHash(socketPath: string): string {
  return createHash("sha256").update(resolve(socketPath)).digest("hex");
}

/** Publie la clé d'un pair en mode 600, de façon atomique. Rend le chemin du fichier. */
export function publishKey(pid: number, socketPath: string, peerToken: string, procStart: string): string {
  const dir = sessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, keyFileName(pid, socketPath));
  // Le suffixe `.tmp` évite que le temporaire soit pris pour une clé (`*.key`).
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ peerToken, procStart, pidDomain: pidDomain() }), { mode: 0o600 });
  // Le umask peut avoir retiré des droits à la création : on force le mode avant de publier.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

/**
 * Jeton publié par le pair qui écoute `targetSocketPath`, ou `undefined` s'il n'en publie pas
 * (l'auth est facultative sur macOS). Seule une clé dont le pid est vivant avec le même
 * `procStart` compte : sinon le pid a été réutilisé et la clé est périmée.
 */
export function readPeerToken(targetSocketPath: string): string | undefined {
  const dir = sessionsDir();
  const pattern = new RegExp(`^(\\d+)\\.${socketHash(targetSocketPath)}\\.key$`);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  const candidates: { pid: number; procStart: string; peerToken: string }[] = [];
  for (const file of files) {
    const match = pattern.exec(file);
    if (match?.[1] === undefined) continue;
    const pid = Number(match[1]);
    if (!isValidPid(pid)) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      if (typeof parsed.peerToken === "string" && typeof parsed.procStart === "string") {
        candidates.push({ pid, procStart: parsed.procStart, peerToken: parsed.peerToken });
      }
    } catch {
      // Clé illisible ou en cours d'écriture : on l'ignore.
    }
  }
  const starts = procStarts(candidates.map((candidate) => candidate.pid));
  return candidates.find((candidate) => starts.get(candidate.pid) === candidate.procStart)?.peerToken;
}
