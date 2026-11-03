import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.ts";

/** Message d'une erreur pour le journal ; chaîne technique anglaise si ce n'est pas une `Error`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Une ligne JSON horodatée dans `idnma.log`. Après le démarrage du harnais, stdout et stderr
 * appartiennent à sa TUI : tout ce que la doublure a à dire passe par ce fichier.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const dir = join(configDir(), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "idnma.log"), JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");
  } catch {
    // Le journal est le dernier recours : s'il échoue, l'écrire sur stderr abîmerait la TUI du harnais.
  }
}
