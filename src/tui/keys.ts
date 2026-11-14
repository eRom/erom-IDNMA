// Intentions clavier de l'écran unifié : pur, sans OpenTUI. Les noms de touches sont ceux de parseKeypress (0.8.4).
import type { Status } from "./state.ts";

/** Forme de KeyEvent d'OpenTUI réduite à ce qui sert. */
export interface KeyLike {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence?: string;
}

export type Context = {
  status: Status;
  turnActive: boolean;
  pending: boolean;
  overlay?: "palette" | "plan" | "settings";
  inputEmpty: boolean;
  lastWasCtrlC: boolean;
};

export type Intent =
  | "submit"
  | "interrupt"
  | "clearInput"
  | "quit"
  | "confirm"
  | "refuse"
  | "selectUp"
  | "selectDown"
  | "openPalette"
  | "togglePlan"
  | "toggleSettings"
  | "reopenHeld"
  | "nextMode"
  | "closeOverlay"
  | "scrollPageUp"
  | "scrollPageDown"
  | "scrollTop"
  | "scrollBottom"
  | "none";

/**
 * Traduit une touche en intention. Les règles sont évaluées dans l'ordre, la première qui correspond gagne.
 * `none` : la touche va à la saisie (frappe, ⇧⏎, ⌃J, flèches dans le texte).
 */
export function intentOf(key: KeyLike, context: Context): Intent {
  if (context.status === "exited") return "quit";

  // Palette et réglages se pilotent au clavier comme une permission en attente.
  const selecting = context.pending || context.overlay === "palette" || context.overlay === "settings";

  if (key.ctrl && key.name === "c") {
    if (context.lastWasCtrlC) return "quit";
    return context.turnActive ? "interrupt" : "clearInput";
  }
  if (key.ctrl && key.name === "d") return context.inputEmpty ? "quit" : "none";

  // ⇧⏎, linefeed (⌃J brut) et ⌃J (modifyOtherKeys, kitty) sont des sauts de ligne de la saisie.
  if (key.name === "return" && key.shift) return "none";
  if (key.name === "linefeed" || (key.ctrl && key.name === "j")) return "none";
  if (key.name === "return") return selecting ? "confirm" : "submit";

  if (key.name === "escape") {
    if (context.pending) return "refuse";
    if (context.overlay === "palette" || context.overlay === "settings") return "closeOverlay";
    if (context.overlay === "plan" && !context.turnActive) return "closeOverlay";
    return context.turnActive ? "interrupt" : "none";
  }

  if (key.name === "up") return selecting ? "selectUp" : "none";
  if (key.name === "down") return selecting ? "selectDown" : "none";

  if (key.name === "/" && !key.ctrl && !key.meta) {
    return context.inputEmpty && !context.pending && context.overlay === undefined ? "openPalette" : "none";
  }
  if (key.ctrl && key.name === "p") return "togglePlan";
  if (key.ctrl && key.name === "o") return "toggleSettings";
  if (key.ctrl && key.name === "r") return "reopenHeld";
  if (key.name === "tab" && key.shift) return "nextMode";

  if (key.name === "pageup") return "scrollPageUp";
  if (key.name === "pagedown") return "scrollPageDown";
  if (key.name === "home") return "scrollTop";
  if (key.name === "end") return "scrollBottom";

  return "none";
}
