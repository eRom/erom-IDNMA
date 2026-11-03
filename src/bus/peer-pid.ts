import { dlopen, FFIType, ptr } from "bun:ffi";
import type { Socket } from "node:net";

// Identité noyau de l'autre bout d'un socket Unix : `getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID)`.
// macOS seulement ; ailleurs l'appelant n'a aucun pid et doit refuser.
const SOL_LOCAL = 0;
const LOCAL_PEERPID = 0x002;
const MAX_ANCESTOR_STEPS = 64;

function openLibc() {
  return dlopen("libc.dylib", {
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
}
let libc: ReturnType<typeof openLibc> | undefined;

/**
 * Pid du process à l'autre bout du socket (connexion acceptée : le client ; connexion cliente : le
 * serveur). `undefined` si la plateforme n'est pas macOS, si le socket n'a pas de descripteur
 * (déjà détruit) ou si le noyau refuse. Le descripteur vient d'un interne de Bun (`_handle.fd`,
 * mesuré sous Bun 1.4.0).
 */
export function peerPidOf(socket: Socket): number | undefined {
  if (process.platform !== "darwin") return undefined;
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) return undefined;
  try {
    const value = new Int32Array(1);
    const length = new Uint32Array([4]);
    // Chargée à la première demande : l'import ne doit pas échouer hors macOS.
    libc ??= openLibc();
    const status = libc.symbols.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, ptr(value), ptr(length));
    const pid = value[0];
    return status === 0 && pid !== undefined && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Vrai si `pid` est `ancestor` ou en descend (remontée des parents, 64 pas au plus) ; faux si `ancestor` vaut 1 ou moins, ou `pid` 0 ou moins. */
export function isDescendantOf(pid: number, ancestor: number): boolean {
  // launchd (pid 1) est l'ancêtre de tout process : un daemon qui le déclarerait admettrait n'importe qui.
  if (ancestor <= 1 || pid <= 0) return false;
  // Chemin absolu : le `ps` du PATH n'est pas de confiance pour une décision d'admission.
  const listing = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  if (listing.exitCode !== 0) return false;
  const parents = new Map<number, number>();
  for (const line of listing.stdout.toString().split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child !== undefined && parent !== undefined && Number.isInteger(child) && Number.isInteger(parent)) parents.set(child, parent);
  }
  let current = pid;
  for (let step = 0; step <= MAX_ANCESTOR_STEPS; step++) {
    if (current === ancestor) return true;
    const parent = parents.get(current);
    if (parent === undefined || parent <= 0) return false;
    current = parent;
  }
  return false;
}
