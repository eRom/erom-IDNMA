import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agyPluginsDir, grokHome } from "../paths.ts";

const LEADER_CONSEQUENCE = "ses commandes ne descendraient plus de la doublure";

/** `[cli] use_leader = true` dans le `config.toml` de Grok ; fichier absent ou illisible : faux. */
function grokUsesLeader(): boolean {
  try {
    const config = Bun.TOML.parse(readFileSync(join(grokHome(), "config.toml"), "utf8")) as { cli?: { use_leader?: unknown } };
    return config.cli?.use_leader === true;
  } catch {
    return false;
  }
}

/**
 * Raison pour laquelle Grok ne peut pas être livré par la doublure, `undefined` si tout est prêt :
 * hooks absents, route daemon ou mode leader (les commandes de l'agent ne descendraient plus de la
 * doublure, donc sans canal de contrôle). `env` et `argv` sont ceux du lancement de l'enfant.
 */
export function grokPreflight(o: { env: Record<string, string>; argv: string[] }): string | undefined {
  if (!existsSync(join(grokHome(), "hooks", "idnma.json"))) {
    return `hooks idnma absents de Grok (${grokHome()}/hooks/idnma.json) : lance idnma install --agent grok`;
  }
  const backend = o.env.GROK_AGENT_HOST_BACKEND;
  if (backend !== undefined && backend !== "" && backend !== "0") {
    return `route daemon de Grok active (GROK_AGENT_HOST_BACKEND) : ${LEADER_CONSEQUENCE}`;
  }
  if (o.argv.includes("--leader")) return `mode leader de Grok demandé (--leader) : ${LEADER_CONSEQUENCE}`;
  if (grokUsesLeader()) return `mode leader de Grok actif ([cli] use_leader dans config.toml) : ${LEADER_CONSEQUENCE}`;
  return undefined;
}

/** Raison pour laquelle agy ne peut pas être livré (plugin `idnma` non posé), `undefined` si tout est prêt. */
export function agyPreflight(): string | undefined {
  if (!existsSync(join(agyPluginsDir(), "idnma", "hooks.json"))) {
    return `plugin idnma absent d'agy (${agyPluginsDir()}/idnma) : lance idnma install --agent agy`;
  }
  return undefined;
}
