import { createConnection } from "node:net";
import { peerPidOf } from "../bus/peer-pid.ts";
import { errorMessage, logEvent } from "../log.ts";
import { codexDaemonSocket } from "../paths.ts";
import { CodexRpcError, connectCodex, type CodexClient, type CodexNotification } from "./rpc.ts";

const DAEMON_START_TIMEOUT_MS = 30_000;

/** Démarre le daemon via la CLI de Codex et attend la fin de la commande (30 s au plus). */
async function startCodexDaemon(): Promise<void> {
  const child = Bun.spawn(["codex", "app-server", "daemon", "start"], { stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), DAEMON_START_TIMEOUT_MS);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

function unreachable(socketPath: string, cause: unknown): CodexRpcError {
  return new CodexRpcError(`daemon Codex injoignable sur ${socketPath} (${errorMessage(cause)})`);
}

/** Se connecte au daemon Codex ; s'il ne répond pas, le démarre une fois, sauf si `allowStart` vaut `false`. */
export async function connectDaemon(o: {
  onNotification: (n: CodexNotification) => void;
  allowStart?: boolean;
  startDaemon?: () => Promise<void>;
}): Promise<CodexClient> {
  const socketPath = codexDaemonSocket();
  try {
    return await connectCodex({ socketPath, onNotification: o.onNotification });
  } catch (first) {
    if (o.allowStart === false) throw unreachable(socketPath, first);
    logEvent("codex-daemon-start", { socketPath, cause: errorMessage(first) });
  }
  try {
    await (o.startDaemon ?? startCodexDaemon)();
  } catch (error) {
    // Le daemon peut tout de même être monté par ailleurs : la seconde tentative tranche.
    logEvent("codex-daemon-start-failed", { error: errorMessage(error) });
  }
  try {
    return await connectCodex({ socketPath, onNotification: o.onNotification });
  } catch (second) {
    throw unreachable(socketPath, second);
  }
}

const DAEMON_PID_TIMEOUT_MS = 3_000;

/**
 * Pid du process qui sert le socket du daemon Codex : sur une connexion cliente, `LOCAL_PEERPID`
 * rend le pid du serveur (mesuré). Sert de référence d'ascendance pour admettre les commandes de
 * Codex. Toute erreur (socket absent, refus, délai) rend `undefined`.
 */
export function daemonPid(socketPath: string = codexDaemonSocket()): Promise<number | undefined> {
  return new Promise((resolvePid) => {
    const socket = createConnection(socketPath);
    const finish = (pid: number | undefined): void => {
      clearTimeout(timer);
      socket.destroy();
      resolvePid(pid);
    };
    const timer = setTimeout(() => finish(undefined), DAEMON_PID_TIMEOUT_MS);
    socket.once("connect", () => finish(peerPidOf(socket)));
    socket.once("error", () => finish(undefined));
  });
}
