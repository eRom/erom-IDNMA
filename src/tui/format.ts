// Helpers de formatage de l'écran unifié : texte pur, aucun rendu.
import type { ConfigOption } from "../acp/events.ts";
import type { SessionState, Status } from "./state.ts";

/** 950 → "950", 8100 → "8.1k", 23325 → "23.3k", 1048576 → "1M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const thousands = Math.round(n / 100) / 10;
  if (n < 1_000_000 && thousands < 1000) return `${stripZero(thousands.toFixed(1))}k`;
  return `${stripZero((n / 1_000_000).toFixed(1))}M`;
}

function stripZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

function currentName(option: ConfigOption): string {
  return option.values.find((value) => value.value === option.currentValue)?.name ?? option.currentValue;
}

export function headerParts(state: SessionState): { left: { dot: Status; name: string; settings: string }; right: string } {
  const byCategory = (category: string) => state.options.find((option) => option.category === category);
  const model = byCategory("model");
  const effort = byCategory("thought_level");
  const mode = byCategory("mode");
  const settings = [model && currentName(model), effort?.currentValue.toLowerCase(), mode && currentName(mode)].filter((part): part is string => part !== undefined).join(" · ");

  let right = "";
  if (state.usage) {
    right = `${formatTokens(state.usage.used)} / ${formatTokens(state.usage.size)}`;
    const cost = state.usage.cost;
    if (cost) right += cost.currency === "USD" ? ` · $${cost.amount.toFixed(2)}` : ` · ${cost.amount.toFixed(2)} ${cost.currency}`;
  }
  return { left: { dot: state.status, name: state.name, settings }, right };
}

const IDLE_HINTS = "⏎ Send  ·  ⇧⏎ Newline  ·  / Commands  ·  ⌃P Plan";
const RUNNING_HINTS = "esc Interrupt  ·  ⏎ Queue message  ·  ⌃P Plan";

/** Libellés de la ligne d'état, ceux de la maquette ; le suffixe « held » suit le compteur du design §6.3. */
export function statusHints(state: SessionState, overlay?: "palette" | "plan" | "settings"): string {
  if (state.exit) return "Press any key to leave";
  const base = hintsFor(state, overlay);
  return state.heldCount > 0 ? `${base}  ·  ${state.heldCount} held  ·  ⌃R Open` : base;
}

function hintsFor(state: SessionState, overlay?: "palette" | "plan" | "settings"): string {
  if (state.pending?.kind === "permission") return "↑↓ Select  ·  ⏎ Confirm  ·  esc Reject";
  if (state.pending?.kind === "held") return "↑↓ Select  ·  ⏎ Confirm  ·  esc Dismiss";
  if (overlay === "palette") return "↑↓ Select  ·  ⏎ Run  ·  esc Close";
  if (overlay === "plan") return state.turnActive ? "⌃P Close plan  ·  esc Interrupt" : "⌃P Close plan  ·  esc Close";
  if (overlay === "settings") return "↑↓ Select  ·  ⏎ Apply  ·  esc Close";
  return state.turnActive ? RUNNING_HINTS : IDLE_HINTS;
}

/** Garde les `max` premières lignes ; la troncature est l'affaire de la vue (diff : 12, sortie : 5, réflexion finie : 3). */
export function truncateLines(lines: string[], max: number): { shown: string[]; hidden: number } {
  const shown = lines.slice(0, max);
  return { shown, hidden: lines.length - shown.length };
}
