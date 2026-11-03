import { readFileSync, readlinkSync } from "node:fs";

// Démarrage des process, pour savoir si un pid du registre est encore le même process.
// Le format suit celui que Claude Code écrit dans `procStart` : `ps lstart` sous macOS,
// champ 22 brut de `/proc/<pid>/stat` sous Linux (sondé sur Claude Code 2.1.317, 03/11/2026).

const LINE = /^\s*(\d+)\s+(.*\S)\s*$/;

// PID_MAX de macOS : au-delà, `ps` refuse la liste entière ("process id too large").
// Sous Linux, PID_MAX_LIMIT du noyau (`/proc/sys/kernel/pid_max` ne peut pas le dépasser).
const PID_MAX = process.platform === "darwin" ? 99_999 : 4_194_304;

/** Pid plausible pour la plateforme : sous macOS, un seul pid invalide ferait avorter tout l'appel `ps`. */
export function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= PID_MAX;
}

/**
 * Champs de `/proc/<pid>/stat` qui suivent le `comm` entre parenthèses, `undefined` si le pid
 * n'existe pas. Le découpage part de la dernière `)` : le `comm` peut contenir espaces et parenthèses.
 * L'indice 0 est le champ 3 (`state`), l'indice 1 le champ 4 (`ppid`), l'indice 19 le champ 22 (`starttime`).
 */
export function procStatFields(pid: number): string[] | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const end = stat.lastIndexOf(")");
  if (end < 0) return undefined;
  return stat.slice(end + 1).trim().split(/\s+/);
}

/**
 * Démarrage de chaque pid vivant, au format que Claude écrit dans `procStart`. Un pid absent est omis.
 * macOS : un seul appel `ps`, `TZ=UTC` et `LC_ALL=C` figent le format `lstart`.
 */
export function procStarts(pids: number[]): Map<number, string> {
  const starts = new Map<number, string>();
  const valid = pids.filter(isValidPid);
  if (valid.length === 0) return starts;
  if (process.platform !== "darwin") {
    for (const pid of valid) {
      const start = procStatFields(pid)?.[19];
      if (start !== undefined && /^\d+$/.test(start)) starts.set(pid, start);
    }
    return starts;
  }
  // `ps` sort en code 1 quand aucun pid n'existe : on lit la sortie sans regarder le code.
  const result = Bun.spawnSync(["ps", "-o", "pid=,lstart=", "-p", valid.join(",")], {
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  for (const line of result.stdout.toString().split("\n")) {
    const match = LINE.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) starts.set(Number(match[1]), match[2]);
  }
  return starts;
}

/** Démarrage d'un seul pid, `undefined` s'il n'existe pas. */
export function procStart(pid: number): string | undefined {
  return procStarts([pid]).get(pid);
}

let cachedPidDomain: string | undefined;

/**
 * Espace de pids où vivent nos pids, à la manière de Claude : `darwin` sous macOS ;
 * sous Linux `linux:<machine-id>:<lien de /proc/self/ns/pid>`, chaque partie vide si illisible.
 */
export function pidDomain(): string {
  if (cachedPidDomain !== undefined) return cachedPidDomain;
  if (process.platform === "darwin") return (cachedPidDomain = "darwin");
  let machineId = "";
  let pidNamespace = "";
  try {
    machineId = readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    // Machine sans machine-id : Claude écrit alors une partie vide, on fait pareil.
  }
  try {
    pidNamespace = readlinkSync("/proc/self/ns/pid");
  } catch {
    // Idem pour le namespace de pids.
  }
  return (cachedPidDomain = `linux:${machineId}:${pidNamespace}`);
}
