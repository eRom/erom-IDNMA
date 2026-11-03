import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir } from "../paths.ts";
import { isValidPid, procStarts } from "./proc.ts";

/** Entrée `<pid>.json` du registre de Claude Code (forme capturée le 26/10/2026). */
export interface SessionEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  procStart: string;
  version: string;
  peerProtocol: number;
  peerFeatures: string[];
  kind: string;
  entrypoint: string;
  pidDomain: string;
  messagingSocketPath: string;
  name: string;
  nameSource: string;
  nameSince: number;
  status: "idle" | "busy" | "waiting";
  updatedAt: number;
  statusUpdatedAt: number;
  tmux?: string;
}

const ENTRY_FILE = /^\d+\.json$/;

/** Lit un fichier d'entrée ; `undefined` s'il est illisible ou sans `pid`, `procStart` ou `name`. */
function readEntry(path: string): SessionEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.pid !== "number" || !isValidPid(record.pid) || typeof record.procStart !== "string" || typeof record.name !== "string") {
    return undefined;
  }
  return parsed as SessionEntry;
}

/** Entrées dont le process est vivant : même pid et même `procStart` (sinon le pid a été réutilisé). */
export function listLiveEntries(): SessionEntry[] {
  const dir = sessionsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => ENTRY_FILE.test(file));
  } catch {
    return [];
  }
  const entries: SessionEntry[] = [];
  for (const file of files) {
    const entry = readEntry(join(dir, file));
    if (entry !== undefined) entries.push(entry);
  }
  const starts = procStarts(entries.map((entry) => entry.pid));
  return entries.filter((entry) => starts.get(entry.pid) === entry.procStart);
}

/** Écrit `<pid>.json` en mode 644, de façon atomique (temporaire puis renommage). Rend le chemin. */
export function writeEntry(entry: SessionEntry): string {
  const dir = sessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${entry.pid}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o644 });
  // Le umask peut avoir retiré des droits à la création : on force le mode avant de publier.
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
  return path;
}

/** Retire `<pid>.json` ; sans erreur s'il n'existe pas. */
export function removeEntry(pid: number): void {
  try {
    unlinkSync(join(sessionsDir(), `${pid}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
