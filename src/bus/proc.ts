// Démarrage des process, pour savoir si un pid du registre est encore le même process.

const LINE = /^\s*(\d+)\s+(.*\S)\s*$/;

// PID_MAX de macOS : au-delà, `ps` refuse la liste entière ("process id too large").
const PID_MAX = 99_999;

/** Pid que `ps` accepte : un seul pid invalide ferait avorter tout l'appel. */
export function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= PID_MAX;
}

/**
 * Démarrage (`lstart`) de chaque pid vivant, en un seul appel `ps`.
 * Un pid absent est omis. `TZ=UTC` et `LC_ALL=C` figent le format, identique à celui de Claude.
 */
export function procStarts(pids: number[]): Map<number, string> {
  const starts = new Map<number, string>();
  const valid = pids.filter(isValidPid);
  if (valid.length === 0) return starts;
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
