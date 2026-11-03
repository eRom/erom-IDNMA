// Lancement d'un agent étranger derrière un Bun.Terminal (forme du proxy pty de caserne, sans son serveur
// d'injection) : le terminal de l'utilisateur est relayé tel quel dans les deux sens, et le livreur reçoit un
// `Terminal` pour taper dans l'agent comme au clavier et pour observer les frappes de l'utilisateur.
import { StringDecoder } from "node:string_decoder";
import { errorMessage, logEvent } from "../log.ts";

/** Le PTY vu du livreur : écrire comme une frappe, observer ce que l'utilisateur tape dans le pane. */
export interface Terminal {
  /** Écrit dans le PTY comme si l'utilisateur tapait ces octets. */
  write(data: string): void;
  /** Abonne aux octets tapés dans le pane (décodés en UTF-8) ; rend le désabonnement. */
  onInput(listener: (chunk: string) => void): () => void;
}

export interface PtyChild {
  process: Bun.Subprocess;
  terminal: Terminal;
  /** Idempotent : désabonne stdin et `resize`, rend le mode d'origine du terminal, ferme le PTY. */
  release(): void;
}

export function spawnUnderPty(o: {
  argv: string[];
  env: Record<string, string>;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}): PtyChild {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const [bin, ...args] = o.argv;
  if (bin === undefined) throw new Error("idnma : argv vide, rien à lancer sous PTY.");
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });

  const ptyTerminal = new Bun.Terminal({
    ...size(),
    name: process.env.TERM || "xterm-256color",
    data(_terminal, data) {
      stdout.write(data);
    },
  });

  const isTTY = Boolean(stdin.isTTY);
  const wasRaw = isTTY ? Boolean(stdin.isRaw) : false;
  const listeners = new Set<(chunk: string) => void>();
  // Un caractère multioctet coupé entre deux blocs n'est jamais abîmé : le décodeur garde l'amorce.
  const decoder = new StringDecoder("utf8");
  const onData = (chunk: Buffer | string): void => {
    ptyTerminal.write(chunk);
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (text === "") return;
    for (const listener of [...listeners]) {
      // Un écouteur qui lève ne coupe ni le relais des frappes ni les autres écouteurs.
      try {
        listener(text);
      } catch {
        /* l'écouteur est responsable de ses erreurs */
      }
    }
  };
  let onResize = (): void => {};
  let released = false;

  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([bin, ...args], { env: o.env, terminal: ptyTerminal });
  } catch (error) {
    ptyTerminal.close();
    throw error;
  }

  if (isTTY) stdin.setRawMode(true);
  stdin.on("data", onData);
  stdin.resume();

  // CORRECTION (spike D1 de caserne, 2026-09-02) : `terminal.resize()` seul ne repeint jamais un TUI.
  // Le SIGWINCH qu'il émet arrive avant que la nouvelle taille soit lisible côté PTY enfant ; le second
  // SIGWINCH explicite laisse la mise à jour atterrir et déclenche le repaint. Les deux lignes vont
  // ensemble : retirer le kill casse le redimensionnement en silence.
  onResize = () => {
    const s = size();
    ptyTerminal.resize(s.cols, s.rows);
    try {
      proc.kill("SIGWINCH");
    } catch {
      /* enfant déjà sorti */
    }
  };
  stdout.on("resize", onResize);

  const terminal: Terminal = {
    write(data) {
      ptyTerminal.write(data);
    },
    onInput(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const release = (): void => {
    if (released) return;
    released = true;
    // Chaque étape tourne même si une précédente lève : un tty disparu ne doit pas laisser stdin
    // retenir le process ni le PTY ouvert. L'échec va au journal, jamais sur la console de l'utilisateur.
    const step = (name: string, work: () => void): void => {
      try {
        work();
      } catch (error) {
        logEvent("pty-release-error", { step: name, message: errorMessage(error) });
      }
    };
    step("listeners", () => listeners.clear());
    step("stdin-data", () => stdin.off("data", onData));
    step("stdout-resize", () => stdout.off("resize", onResize));
    if (isTTY) step("raw-mode", () => stdin.setRawMode(wasRaw));
    // Sans la pause, stdin retient le process après la sortie de l'agent.
    step("pause", () => stdin.pause());
    step("close", () => ptyTerminal.close());
  };

  return { process: proc, terminal, release };
}
