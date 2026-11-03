import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, logEvent } from "../log.ts";
import { sessionsDir, socketsDir } from "../paths.ts";
import { addressOf } from "./envelope.ts";
import { startInboxServer, type InboundMessage } from "./inbox.ts";
import { keyFileName, publishKey } from "./key.ts";
import { procStart } from "./proc.ts";
import { listLiveEntries, removeEntry, writeEntry, type SessionEntry } from "./registry.ts";

/** Version du protocole de pairs que cette inscription sait parler. */
const PEER_PROTOCOL = 1;

/** Un pair vivant parle un autre protocole que le nôtre : s'inscrire risquerait de casser le bus. */
export class ProtocolMismatchError extends Error {
  constructor(seen: number) {
    super(`le bus de Claude parle le protocole de pairs ${seen}, idnma ne parle que le ${PEER_PROTOCOL} : inscription refusée`);
    this.name = "ProtocolMismatchError";
  }
}

export interface Registration {
  socketPath: string;
  address: string;
  entry: SessionEntry;
  peerToken: string;
  /** Retire la boîte, l'entrée, la clé et le socket, dans cet ordre, chaque étape même si une autre échoue. Idempotent. */
  unregister(): void;
  /**
   * Publie `busy` ou `idle` dans l'entrée du registre (réécriture atomique, `statusUpdatedAt` et
   * `updatedAt` à l'instant de l'appel). Sans effet si l'état est déjà celui-là ou après
   * `unregister()`. Ne lève jamais : un échec d'écriture va au journal (`status-write-error`).
   */
  setStatus(status: "idle" | "busy"): void;
}

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/** Compare deux versions numériquement, segment par segment (`2.1.310` > `2.1.30`). */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Premier mot de `claude --version` (« 2.1.310 (Claude Code) »), ou `undefined` si indisponible. */
function versionFromBinary(): string | undefined {
  try {
    const result = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    const word = result.stdout.toString().trim().split(/\s+/)[0];
    return word !== undefined && VERSION_PATTERN.test(word) ? word : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Version de Claude Code à déclarer : la plus haute parmi les entrées vivantes, sinon celle du
 * binaire `claude`, sinon `0.0.0`.
 */
export function claudeVersion(live: SessionEntry[]): string {
  let best: string | undefined;
  for (const entry of live) {
    const version = entry.version;
    if (typeof version !== "string" || !VERSION_PATTERN.test(version)) continue;
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  }
  return best ?? versionFromBinary() ?? "0.0.0";
}

/**
 * Inscrit ce process dans le bus de Claude Code comme une session interactive : boîte de
 * réception sur socket Unix, clé du pair, puis entrée du registre (publiée en dernier, pour
 * que personne ne voie une entrée sans socket).
 */
export async function registerPeer(o: {
  name: string;
  cwd: string;
  tmux?: string;
  onMessage: (m: InboundMessage) => void;
  onControl?: (f: Record<string, unknown>) => void;
  /** Reçoit l'exception d'un rappel de la boîte ; sans lui, elle est écrite sur stderr. */
  onError?: (error: unknown) => void;
}): Promise<Registration> {
  const live = listLiveEntries();
  for (const entry of live) {
    // Champ absent : Claude le lit comme 0, on l'ignore comme lui.
    if (typeof entry.peerProtocol === "number" && entry.peerProtocol !== PEER_PROTOCOL) {
      throw new ProtocolMismatchError(entry.peerProtocol);
    }
  }

  const start = procStart(process.pid);
  if (start === undefined) throw new Error(`démarrage du process ${process.pid} introuvable (ps)`);

  const dir = socketsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = join(dir, `${process.pid}.sock`);

  const peerToken = randomBytes(16).toString("hex");
  const keyPath = join(sessionsDir(), keyFileName(process.pid, socketPath));

  // Un socket périmé à notre pid (crash avant réutilisation du pid) est retiré par la boîte elle-même.
  const inbox = startInboxServer({
    socketPath,
    peerToken,
    onMessage: o.onMessage,
    ...(o.onControl === undefined ? {} : { onControl: o.onControl }),
    ...(o.onError === undefined ? {} : { onError: o.onError }),
  });

  const now = Date.now();
  const entry: SessionEntry = {
    pid: process.pid,
    sessionId: randomUUID(),
    cwd: o.cwd,
    startedAt: now,
    procStart: start,
    version: claudeVersion(live),
    peerProtocol: PEER_PROTOCOL,
    peerFeatures: [],
    kind: "interactive",
    entrypoint: "cli",
    pidDomain: "darwin",
    messagingSocketPath: socketPath,
    name: o.name,
    nameSource: "user",
    nameSince: now,
    status: "idle",
    updatedAt: now,
    statusUpdatedAt: now,
    ...(o.tmux === undefined ? {} : { tmux: o.tmux }),
  };

  let unregistered = false;
  const unregister = (): void => {
    if (unregistered) return;
    // Chaque étape tourne même si une précédente lève : un retrait d'entrée refusé ne doit pas
    // laisser la clé et le socket derrière lui. La première erreur est relancée à la fin.
    const errors: unknown[] = [];
    const attempt = (step: () => void): void => {
      try {
        step();
      } catch (error) {
        errors.push(error);
      }
    };
    attempt(() => inbox.stop());
    attempt(() => removeEntry(process.pid));
    attempt(() => rmSync(keyPath, { force: true }));
    attempt(() => rmSync(socketPath, { force: true }));
    unregistered = true;
    if (errors.length > 0) throw errors[0];
  };

  // La clé précède l'entrée : un pair qui lit l'entrée trouve déjà la clé. En cas d'échec, on défait tout.
  try {
    publishKey(process.pid, socketPath, peerToken, start);
    writeEntry(entry);
  } catch (error) {
    // L'erreur d'origine prime : un échec du nettoyage est signalé à part, sans la masquer.
    // Le harnais n'a pas encore démarré, stderr est donc encore à nous.
    try {
      unregister();
    } catch (cleanupError) {
      process.stderr.write(`idnma : nettoyage incomplet après l'échec de l'inscription (${errorMessage(cleanupError)})\n`);
    }
    throw error;
  }

  const setStatus = (status: "idle" | "busy"): void => {
    if (unregistered || entry.status === status) return;
    const now = Date.now();
    try {
      writeEntry({ ...entry, status, updatedAt: now, statusUpdatedAt: now });
      // L'entrée de la registration suit l'état publié, seulement une fois l'écriture réussie.
      Object.assign(entry, { status, updatedAt: now, statusUpdatedAt: now });
    } catch (error) {
      // Appelé depuis des rappels d'un process dont stdout et stderr sont à la TUI : jamais d'exception ni de sortie.
      logEvent("status-write-error", { message: errorMessage(error) });
    }
  };

  return { socketPath, address: addressOf(socketPath), entry, peerToken, unregister, setStatus };
}
