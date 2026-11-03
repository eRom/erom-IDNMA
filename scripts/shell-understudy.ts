// Outil de recette de la phase 1 (pas une commande produit) : inscrit le pane courant au bus de
// Claude sous `shell-<divinité>-<suffixe>` et y lance $SHELL en doublure, comme `idnma run` le fait pour un
// agent étranger. Usage : bun scripts/shell-understudy.ts [bypass|prompting]
import { registerPeer, type Registration } from "../src/bus/register.ts";
import { runUnderstudy } from "../src/understudy/understudy.ts";
import type { FromMode } from "../src/bus/envelope.ts";
import { MessageQueue } from "../src/understudy/queue.ts";
import { chooseName, withNameLock } from "../src/naming/choose.ts";
import { errorMessage, logEvent } from "../src/log.ts";
import { logControlFrame } from "../src/run/run.ts";
import { tmuxTarget } from "../src/run/pane.ts";

const mode = process.argv[2] ?? "bypass";
if (mode !== "bypass" && mode !== "prompting") {
  console.error(`shell-understudy : mode « ${mode} » inconnu (bypass ou prompting).`);
  process.exit(1);
}
const fromMode: FromMode = mode;

const paneId = process.env.TMUX_PANE;
const queue = new MessageQueue();
let registration: Registration | undefined;
const name = await withNameLock(async () => {
  const chosen = chooseName("shell");
  registration = await registerPeer({
    name: chosen,
    cwd: process.cwd(),
    ...(paneId === undefined ? {} : { tmux: tmuxTarget(paneId) }),
    onMessage: (message) => {
      if (!queue.push(message)) logEvent("queue-full", { msgId: message.msgId, from: message.from });
    },
    onControl: logControlFrame,
    onError: (error) => logEvent("inbox-error", { message: errorMessage(error) }),
  });
  return chosen;
});

// Avant le démarrage du shell : ensuite le terminal appartient à $SHELL.
console.log(`Inscrit au bus sous le nom ${name} (mode ${mode}).`);

process.exit(
  await runUnderstudy({
    name,
    argv: [process.env.SHELL || "/bin/zsh"],
    env: process.env as Record<string, string>,
    fromMode,
    registration: registration ?? null,
    queue,
  }),
);
