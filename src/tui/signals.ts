// Signaux de terminal lus par IdemA : notification (OSC 9) et progression (OSC 9;4).
import type { Status } from "./state.ts";

/** Notification OSC 9. Les caractères de contrôle sont retirés : un BEL ou un ESC dans le texte clorait la séquence trop tôt. */
export const NOTIFY = (text: string): string => `\x1b]9;${text.replace(/[\x00-\x1f\x7f]/g, "")}\x07`;

/** Progression indéterminée (état 3) : le choix de l'indéterminé plutôt qu'un pourcentage est le nôtre. */
export const PROGRESS_ON = "\x1b]9;4;3\x07";
export const PROGRESS_OFF = "\x1b]9;4;0\x07";

/** Traduit les changements d'état de la session en signaux écrits sur le terminal. */
export function createSignals(name: string, write: (bytes: string) => void): { onStatus(previous: Status, next: Status): void } {
  return {
    onStatus(previous, next) {
      if (previous === next) return;
      if (previous === "running") write(PROGRESS_OFF);
      if (next === "running") write(PROGRESS_ON);
      if (next === "waiting") write(NOTIFY(`${name}: waiting for you`));
    },
  };
}
