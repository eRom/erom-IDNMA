// Un nœud = une doublure Codex complète (inscription réelle, livreur réel, faux daemon qui termine
// chaque tour par une réponse finale). Deux nœuds se parlent par le bus d'un registre de test commun.
// Usage : bun codex-understudy-node.ts <nom> <dossier> <threadId> <pair-à-qui-écrire|-> <durée-ms>
// Écrit sur stdout une ligne JSON : { name, turnStarts }.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerPeer } from "../../src/bus/register.ts";
import { sendPeerMessage } from "../../src/bus/send.ts";
import { createCodexCourier } from "../../src/codex/courier.ts";
import { connectDaemon } from "../../src/codex/daemon.ts";
import { codexDaemonSocket } from "../../src/paths.ts";
import type { Courier } from "../../src/understudy/courier.ts";
import { MessageQueue } from "../../src/understudy/queue.ts";
import { startFakeCodexDaemon } from "./fake-codex-daemon.ts";

const [name, base, threadId, writeTo, durationText] = process.argv.slice(2) as [string, string, string, string, string];
process.env.CODEX_HOME = join(base, "codex");
process.env.IDNMA_CONTROL_DIR = join(base, "control");
const work = join(base, "work");
mkdirSync(join(process.env.CODEX_HOME, "app-server-control"), { recursive: true });
mkdirSync(work, { recursive: true });

const daemon = startFakeCodexDaemon(codexDaemonSocket());
let turns = 0;
daemon.handle("thread/resume", () => ({ result: {} }));
daemon.handle("turn/start", () => {
  turns += 1;
  const id = `${name}-turn-${turns}`;
  const answer = `${name} répond au tour ${turns}`;
  setTimeout(() => {
    daemon.notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    daemon.notify("turn/started", { threadId, turn: { id, status: "inProgress", items: [] } });
    daemon.notify("thread/status/changed", { threadId, status: { type: "idle" } });
    daemon.notify("turn/completed", {
      threadId,
      turn: { id, status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: answer }] },
    });
  }, 20);
  return { result: { turn: { id, status: "inProgress", items: [] } } };
});

const queue = new MessageQueue();
let courier: Courier | undefined;
const registration = await registerPeer({
  name,
  cwd: work,
  onMessage: (message) => {
    queue.push(message);
    courier?.onMessage();
  },
  onError: () => {},
});
courier = createCodexCourier({
  name,
  fromMode: "bypass",
  registration,
  queue,
  cwd: work,
  connect: (onNotification, { allowStart }) => connectDaemon({ onNotification, allowStart, startDaemon: async () => {} }),
});
await courier.beforeSpawn();
courier.afterSpawn();
daemon.notify("thread/started", {
  thread: { id: threadId, cwd: work, ephemeral: false, threadSource: "user", parentThreadId: null, status: { type: "idle" } },
});
await Bun.sleep(300);

if (writeTo !== "-") {
  // Ce que ferait `idnma peer send <pair> "…"` lancé par Codex : un seul message explicite.
  await sendPeerMessage({ fromSocketPath: registration.socketPath, fromName: name, fromMode: "bypass", to: writeTo, body: "peux-tu vérifier le build ?" });
}
await Bun.sleep(Number(durationText));
console.log(JSON.stringify({ name, turnStarts: turns }));
courier.stop();
registration.unregister();
daemon.stop();
process.exit(0);
