// Process enfant des tests de sortie de `runUnified` : le vrai `process.exit`, les vrais signaux, un faux écran.
// Entrée : UNIFIED_CHILD_SHIM (adaptateur factice), UNIFIED_CHILD_MODE (`sigterm`, `early`, `crash` ou `hardexit`), UNIFIED_CHILD_MARKER
// (fichier où le process dit où il en est). Les dossiers IDNMA_* viennent de l'environnement du test.
import { appendFileSync } from "node:fs";
import { runUnified } from "../../src/unified/run-unified.ts";
import { FakeScreen } from "./fake-screen.ts";

const shim = process.env.UNIFIED_CHILD_SHIM!;
const mode = process.env.UNIFIED_CHILD_MODE!;
const marker = process.env.UNIFIED_CHILD_MARKER!;
const note = (line: string): void => appendFileSync(marker, `${line}\n`);

const TTY = "/dev/ttys-fake";

const code = await runUnified({
  agentKey: "claude",
  engine: { harness: "claude", options: [], env: {} },
  passthrough: [],
  deps: {
    probe: { env: { TMUX: "fake,1,0", TMUX_PANE: "%7" }, stdinIsTTY: true, stdinTty: () => TTY, paneTty: () => TTY },
    which: () => shim,
    tmuxTarget: () => "fake:@1.%7",
    tagPane: () => {},
    write: () => {},
    openScreen: async (options) => {
      const screen = new FakeScreen(options.handlers);
      const render = screen.render.bind(screen);
      screen.render = (state) => {
        render(state);
        if (state.pending?.kind === "permission") note("permission");
      };
      // L'écran ouvert, le tour démarre (il reste suspendu à la permission) ou le process plante.
      setTimeout(() => {
        note("screen");
        if (mode === "crash") throw new Error("boom");
        // Sortie sans passer par le chemin de sortie : seul le dernier recours de `process.on("exit")` tue l'agent.
        if (mode === "hardexit") process.exit(7);
        screen.fire("submit", "hello");
      }, 50);
      return screen;
    },
  },
});
// Atteint seulement si `exit` n'a pas arrêté le process : ce n'est pas le chemin attendu.
note(`returned ${code}`);
