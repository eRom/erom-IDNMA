import { ConfigError } from "./network.ts";

/**
 * Résout les références `$NOM` de l'env d'un engine depuis l'environnement du process, et
 * lui seul : aucun fichier n'est lu. Une référence introuvable est nommée, jamais une valeur.
 */
export function resolveEnv(
  engineEnv: Record<string, string>,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(engineEnv)) {
    const ref = value.match(/^\$([A-Z0-9_]+)$/);
    if (!ref) {
      out[key] = value;
      continue;
    }
    const name = ref[1]!;
    const resolved = baseEnv[name];
    if (resolved === undefined) {
      throw new ConfigError(`Variable $${name} absente de l'environnement. Exporte-la dans ~/.zshenv, puis relance le pane.`);
    }
    out[key] = resolved;
  }
  return out;
}
