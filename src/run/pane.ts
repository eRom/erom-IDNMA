import { execFileSync } from "node:child_process";

/** Refus de lancer un agent dans ce pane : message en français pour l'utilisateur. */
export class PaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaneError";
  }
}

export type PaneProbe = {
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
  stdinTty: () => string;
  paneTty: (paneId: string) => string;
};

const defaultProbe = (): PaneProbe => ({
  env: process.env,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdinTty: () => execFileSync("tty", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim(),
  paneTty: (paneId) => execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_tty}"], { encoding: "utf8" }).trim(),
});

/**
 * `idnma run` prend le pane où il tourne : il doit en être le process de premier plan, sur SON
 * terminal. Refusé hors tmux, depuis un agent déjà incarné (l'outil Bash d'un pane), sans
 * terminal (pipe, script), et avec un $TMUX hérité d'un autre pane (terminal d'éditeur lancé
 * depuis tmux) : le registre pointerait le pane d'un autre, qui recevrait les messages.
 */
export function assertOwnPane(probe: PaneProbe = defaultProbe()): void {
  const { TMUX, TMUX_PANE, IDNMA_NAME } = probe.env;
  if (!TMUX || !TMUX_PANE) {
    throw new PaneError("idnma run se lance depuis un pane tmux.");
  }
  if (IDNMA_NAME) {
    throw new PaneError(`idnma run depuis l'agent « ${IDNMA_NAME} » : ce pane a déjà son incarnation.`);
  }
  if (!probe.stdinIsTTY) throw new PaneError("idnma run exige un terminal : stdin n'en est pas un.");
  let pane: string;
  try {
    pane = probe.paneTty(TMUX_PANE);
  } catch {
    throw new PaneError(`idnma run : serveur tmux injoignable pour le pane ${TMUX_PANE} ($TMUX périmé ?).`);
  }
  const own = probe.stdinTty();
  if (own !== pane) {
    throw new PaneError(`idnma run : ce terminal (${own}) n'est pas celui du pane ${TMUX_PANE} (${pane}) ; $TMUX hérité d'un autre pane ?`);
  }
}

/**
 * Marque le pane pour IdemA : `@idnma_agent` reçoit la clé d'agent, `@idnma_name` le nom sur le bus,
 * ou est vidée quand idnma ne le connaît pas (Claude repris) : jamais la clé, jamais un nom périmé.
 */
export function tagPane(paneId: string, agentKey: string, name: string | undefined): void {
  execFileSync("tmux", ["set-option", "-p", "-t", paneId, "@idnma_agent", agentKey], { stdio: "ignore" });
  const nameArgs = name === undefined ? ["-u", "@idnma_name"] : ["@idnma_name", name];
  execFileSync("tmux", ["set-option", "-p", "-t", paneId, ...nameArgs], { stdio: "ignore" });
}

/** Cible tmux complète d'un pane, `session:fenêtre.pane`, telle que le registre de Claude la publie. */
export function tmuxTarget(paneId: string): string {
  return execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{session_name}:#{window_id}.#{pane_id}"], { encoding: "utf8" }).trim();
}
