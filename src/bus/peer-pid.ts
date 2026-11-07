import { dlopen, FFIType, ptr } from "bun:ffi";
import type { Socket } from "node:net";
import { procStatFields } from "./proc.ts";

// Identité noyau de l'autre bout d'un socket Unix.
// macOS : `getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID)`, un int32.
// Linux : `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)`, une `struct ucred { pid, uid, gid }` (3 × int32) ;
// constantes valables sur x86_64 et aarch64 (pas sur mips ni powerpc, hors cible).
// Ailleurs l'appelant n'a aucun pid et doit refuser.
const DARWIN = { lib: "libc.dylib", level: 0, option: 0x002, size: 4 } as const;
const LINUX = { lib: "libc.so.6", level: 1, option: 17, size: 12 } as const;
const MAX_ANCESTOR_STEPS = 64;

const peerOption = process.platform === "darwin" ? DARWIN : process.platform === "linux" ? LINUX : undefined;

function openLibc(lib: string) {
  return dlopen(lib, {
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
}
let libc: ReturnType<typeof openLibc> | undefined;

/**
 * Pid du process à l'autre bout du socket (connexion acceptée : le client ; connexion cliente : le
 * serveur). `undefined` si la plateforme n'est ni macOS ni Linux, si le socket n'a pas de descripteur
 * (déjà détruit) ou si le noyau refuse. Le descripteur vient d'un interne de Bun (`_handle.fd`,
 * mesuré sous Bun 1.4.0).
 */
export function peerPidOf(socket: Socket): number | undefined {
  if (peerOption === undefined) return undefined;
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) return undefined;
  try {
    // Le pid est le premier int32 dans les deux cas (seul champ sous macOS, `ucred.pid` sous Linux).
    const value = new Int32Array(peerOption.size / 4);
    const length = new Uint32Array([peerOption.size]);
    // Chargée à la première demande : l'import ne doit pas échouer sur une plateforme sans cette libc.
    libc ??= openLibc(peerOption.lib);
    const status = libc.symbols.getsockopt(fd, peerOption.level, peerOption.option, ptr(value), ptr(length));
    const pid = value[0];
    return status === 0 && pid !== undefined && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Parent d'un pid sous Linux, lu dans `/proc/<pid>/stat` (champ 4), sans binaire externe. */
function linuxParentOf(pid: number): number | undefined {
  const ppid = Number(procStatFields(pid)?.[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** Fonction enfant → parent pour la plateforme, `undefined` si la table des process est illisible. */
function parentResolver(): ((pid: number) => number | undefined) | undefined {
  if (process.platform !== "darwin") return linuxParentOf;
  // Chemin absolu : le `ps` du PATH n'est pas de confiance pour une décision d'admission.
  const listing = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  if (listing.exitCode !== 0) return undefined;
  const parents = new Map<number, number>();
  for (const line of listing.stdout.toString().split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child !== undefined && parent !== undefined && Number.isInteger(child) && Number.isInteger(parent)) parents.set(child, parent);
  }
  return (pid) => parents.get(pid);
}

/** Vrai si `pid` est un enfant direct de `parent` ; faux si `parent` vaut 1 ou moins, ou `pid` 0 ou moins. */
export function isChildOf(pid: number, parent: number): boolean {
  if (parent <= 1 || pid <= 0) return false;
  return parentResolver()?.(pid) === parent;
}

/** Vrai si `pid` est `ancestor` ou en descend (remontée des parents, 64 pas au plus) ; faux si `ancestor` vaut 1 ou moins, ou `pid` 0 ou moins. */
export function isDescendantOf(pid: number, ancestor: number): boolean {
  // launchd ou init (pid 1) est l'ancêtre de tout process : un daemon qui le déclarerait admettrait n'importe qui.
  if (ancestor <= 1 || pid <= 0) return false;
  const parentOf = parentResolver();
  if (parentOf === undefined) return false;
  let current = pid;
  for (let step = 0; step <= MAX_ANCESTOR_STEPS; step++) {
    if (current === ancestor) return true;
    const parent = parentOf(current);
    if (parent === undefined || parent <= 0) return false;
    current = parent;
  }
  return false;
}
