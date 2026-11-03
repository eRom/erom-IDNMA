import { createConnection, type Socket } from "node:net";
import { BRIDGE_PROTOCOL_VERSION, type DeliverFrame } from "../../src/dst/protocol.ts";

export interface FakeDstPlugin {
  /** `deliver` reçus, dans l'ordre. */
  delivers: DeliverFrame[];
  /** Octets reçus qui ne sont pas un `deliver` lisible (une doublure ne doit rien écrire d'autre). */
  strays: string[];
  /** La connexion est fermée (par la doublure ou par `close`). */
  closed: boolean;
  /** Écrit une trame JSON sur une ligne. */
  send(frame: object): void;
  /** Écrit tel quel, sans retour à la ligne ajouté. */
  sendRaw(text: string): void;
  /** `hello` valide par défaut ; `overrides` remplace les champs. */
  hello(overrides?: Record<string, unknown>): void;
  state(session: string | null, status?: "idle" | "running"): void;
  close(): void;
  /** Résolu une fois la connexion établie. */
  ready: Promise<void>;
}

export const TEST_TOKEN = "bridge-token-test";

/**
 * Faux plugin idnma : un client `node:net` qui joue le plugin dans le process de test. Son pid noyau
 * est celui du process de test, donc descendant de lui-même : l'admission par défaut l'accepte.
 */
export function connectFakeDstPlugin(socketPath: string): FakeDstPlugin {
  const socket: Socket = createConnection(socketPath);
  let received = "";
  const plugin: FakeDstPlugin = {
    delivers: [],
    strays: [],
    closed: false,
    ready: new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
    send(frame) {
      socket.write(`${JSON.stringify(frame)}\n`);
    },
    sendRaw(text) {
      socket.write(text);
    },
    hello(overrides = {}) {
      plugin.send({ type: "hello", v: BRIDGE_PROTOCOL_VERSION, token: TEST_TOKEN, pid: process.pid, versions: { tui: "0.0.0-test" }, ...overrides });
    },
    state(session, status = "idle") {
      plugin.send({ type: "state", session, status });
    },
    close() {
      socket.destroy();
    },
  };
  // Un écouteur `error` d'abord : une doublure qui coupe la connexion ne doit pas faire planter le test.
  socket.on("error", () => {});
  socket.on("close", () => {
    plugin.closed = true;
  });
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("utf8");
    for (let newline = received.indexOf("\n"); newline !== -1; newline = received.indexOf("\n")) {
      const line = received.slice(0, newline);
      received = received.slice(newline + 1);
      try {
        const frame = JSON.parse(line) as DeliverFrame;
        if (frame.type === "deliver") plugin.delivers.push(frame);
        else plugin.strays.push(line);
      } catch {
        plugin.strays.push(line);
      }
    }
  });
  return plugin;
}
