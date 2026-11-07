import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { networkPath } from "../paths.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Harness = "claude" | "codex" | "grok" | "agy" | "opencode" | "dst" | "pi";
export type ForeignHarness = Exclude<Harness, "claude">;

export interface Engine {
  harness: Harness;
  model?: string;
  options: string[];
  env: Record<string, string>;
}

const HARNESSES = ["claude", "codex", "grok", "agy", "opencode", "dst", "pi"] as const satisfies readonly Harness[];

// Strict : une clé mal tapée (`option:` pour `options:`) serait sinon retirée en silence, et
// l'agent démarrerait sans ses options (codex en mode prompting, sans un mot).
export const EngineSchema = z.strictObject({
  harness: z.enum(HARNESSES),
  model: z.string().optional(),
  options: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

// Seul `engines` compte ici : label, info, cell et avatar servent à d'autres outils
// (affichage), zod retire les clés inconnues, un agent n'est donc jamais refusé pour eux.
// Le niveau agent reste donc permissif ; seul l'engine est strict.
export const AgentSchema = z.object({
  engines: z.record(z.string(), EngineSchema),
});

/**
 * Lit un fichier YAML. Les clés de fusion `<<` sont actives (désactivées par défaut en YAML 1.2) :
 * un gabarit d'env commun (Ollama, OpenRouter) s'écrit une fois et se fusionne dans chaque engine.
 */
export function readYaml(path: string, name: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError(`${name} introuvable : ${path}.`);
  }
  try {
    return parse(readFileSync(path, "utf-8"), { merge: true });
  } catch (e) {
    throw new ConfigError(`${name} invalide (${path}) : ${e instanceof Error ? e.message : e}`);
  }
}

function frenchIssueReason(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return "champ requis manquant ou de type invalide";
    // Enum fermé (harness) : sans la liste des valeurs acceptées, l'erreur est
    // indevinable.
    case "invalid_value":
      return `valeur invalide (attendu : ${issue.values.map(String).join(", ")})`;
    // Le nom de la clé vient du fichier de config, jamais d'une valeur : il peut être cité.
    case "unrecognized_keys":
      return `clé inconnue ${issue.keys.map((key) => `« ${key} »`).join(", ")}`;
    default:
      return "valeur invalide";
  }
}

/** Valide `data` ; l'erreur ne contient jamais la valeur fautive, seulement son chemin. */
export function validate<T>(schema: z.ZodType<T>, data: unknown, name: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(racine)"} : ${frenchIssueReason(i)}`)
      .join("\n");
    throw new ConfigError(`${name} ne respecte pas le schéma :\n${detail}`);
  }
  return result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Clés d'agent de .idnma.yml, triées ; `[]` sans section `agents:` lisible. Lève `ConfigError` si le fichier manque ou ne se lit pas. */
export function listAgentKeys(): string[] {
  const raw = readYaml(networkPath(), ".idnma.yml");
  return isRecord(raw) && isRecord(raw.agents) ? Object.keys(raw.agents).sort() : [];
}

/**
 * Lit .idnma.yml en entier mais ne valide que l'agent demandé : un agent cassé
 * ne doit pas empêcher d'en lancer un autre.
 */
export function loadAgentEngine(agentKey: string, engineKey?: string): { engine: Engine; engineKey: string } {
  const raw = readYaml(networkPath(), ".idnma.yml");
  const agents = isRecord(raw) && isRecord(raw.agents) ? raw.agents : undefined;
  if (!agents) {
    throw new ConfigError(".idnma.yml : la section `agents:` est absente ou n'est pas un objet.");
  }
  if (!Object.hasOwn(agents, agentKey)) {
    throw new ConfigError(
      `Agent "${agentKey}" inconnu dans .idnma.yml. Agents disponibles : ${Object.keys(agents).sort().join(", ")}.`,
    );
  }
  const agent = validate(AgentSchema, agents[agentKey], `.idnma.yml (agents.${agentKey})`);
  const key = engineKey ?? "default";
  const engine = Object.hasOwn(agent.engines, key) ? agent.engines[key] : undefined;
  if (!engine) {
    throw new ConfigError(
      `Engine "${key}" inconnu pour l'agent "${agentKey}". Engines disponibles : ${Object.keys(agent.engines).sort().join(", ")}.`,
    );
  }
  return { engine: withModelTierDefaults(engine), engineKey: key };
}

/** Variables par lesquelles Claude Code choisit son modèle, palier par palier. */
export const MODEL_TIER_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

/**
 * Engine Claude routé hors d'Anthropic (son `env:` fixe `ANTHROPIC_BASE_URL`) : chaque variable de
 * palier absente de son `env:` reçoit `model:`, pour qu'aucun palier (sous-agent, `/model`) ne
 * réclame un modèle Anthropic au proxy. Une variable présente, même vide, est gardée telle quelle.
 * Seul l'`env:` de l'engine compte : une variable exportée dans le shell ne bloque pas le remplissage.
 */
export function withModelTierDefaults(engine: Engine): Engine {
  const { model } = engine;
  if (engine.harness !== "claude" || model === undefined || !Object.hasOwn(engine.env, "ANTHROPIC_BASE_URL")) return engine;
  const env = { ...engine.env };
  for (const name of MODEL_TIER_VARS) if (!Object.hasOwn(env, name)) env[name] = model;
  return { ...engine, env };
}
