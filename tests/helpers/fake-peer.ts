import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { publishKey } from "../../src/bus/key.ts";
import { procStart } from "../../src/bus/proc.ts";
import { removeEntry, writeEntry, type SessionEntry } from "../../src/bus/registry.ts";
import { socketsDir } from "../../src/paths.ts";

export interface FakePeer {
  entry: SessionEntry;
  socketPath: string;
  /** Trames reçues, dans l'ordre. Une trame `auth` est réduite à `{ type: "auth", tokenMatches }`. */
  lines: unknown[];
  stop(): void;
}

/**
 * Faux pair du bus : le serveur tourne dans le process de test, mais l'entrée du registre porte
 * le pid d'un enfant `sleep 600` (son `procStart` est donc réel et son `<pid>.json` ne heurte rien).
 * Le jeton n'est jamais journalisé, seulement sa correspondance.
 */
export async function startFakePeer(name: string, overrides: Partial<SessionEntry> = {}): Promise<FakePeer> {
  const sleeper = Bun.spawn(["sleep", "600"]);
  const start = procStart(sleeper.pid);
  if (start === undefined) {
    sleeper.kill();
    throw new Error(`no procStart for pid ${sleeper.pid}`);
  }

  const dir = socketsDir();
  mkdirSync(dir, { recursive: true });
  const socketPath = join(dir, `${sleeper.pid}.sock`);
  const peerToken = randomBytes(16).toString("hex");
  const lines: unknown[] = [];
  const connections = new Set<Socket>();

  const server: Server = createServer((connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {});
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === "auth") lines.push({ type: "auth", tokenMatches: frame.token === peerToken });
          else lines.push(frame);
        } catch {
          lines.push({ type: "unparseable" });
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => resolveListen());
  });

  const keyPath = publishKey(sleeper.pid, socketPath, peerToken, start);
  const now = Date.now();
  const entry: SessionEntry = {
    pid: sleeper.pid,
    sessionId: randomUUID(),
    cwd: "/tmp",
    startedAt: now,
    procStart: start,
    version: "2.1.310",
    peerProtocol: 1,
    peerFeatures: [],
    kind: "interactive",
    entrypoint: "cli",
    pidDomain: "darwin",
    messagingSocketPath: socketPath,
    name,
    nameSource: "user",
    nameSince: now,
    status: "idle",
    updatedAt: now,
    statusUpdatedAt: now,
    ...overrides,
  };
  writeEntry(entry);

  let stopped = false;
  return {
    entry,
    socketPath,
    lines,
    stop() {
      if (stopped) return;
      stopped = true;
      sleeper.kill();
      for (const connection of connections) connection.destroy();
      server.close();
      removeEntry(entry.pid);
      rmSync(keyPath, { force: true });
      rmSync(socketPath, { force: true });
    },
  };
}
