// Types seuls, importables par le serveur comme par la page : aucun import de valeur ici.
import type { Harness } from "../config/network.ts";

/** Un problème de validation, rattaché à l'endroit où il se corrige. */
export interface IssueView {
  severity: "error" | "warning";
  code: string;
  message: string;
  agent?: string;
  engine?: string;
  preset?: string;
  field?: string;
  /** Correction proposée en un clic ; `quote` passe un nombre YAML en texte. */
  fix?: "quote";
}

/** Une valeur partagée par ancre : le nom de l'ancre et les autres endroits qui la portent. */
export interface LinkView {
  anchor: string;
  /** Chemins lisibles des autres endroits (`agents.glm.engines.default.env.ANTHROPIC_MODEL`). */
  sharedWith: string[];
}

export interface EnvVarView {
  name: string;
  value: string;
  linked?: LinkView;
}

export type ProviderChoice =
  | { kind: "anthropic" }
  | { kind: "preset"; name: string }
  | { kind: "custom" }
  | { kind: "none" };

export type OptionsChoice =
  | { kind: "none" }
  | { kind: "preset"; name: string; values: string[] }
  | { kind: "custom"; values: string[] };

export interface EngineView {
  name: string;
  isDefault: boolean;
  /** Commande de test, par exemple `idnma run glm --engine dst`. */
  command: string;
  harness: string;
  model?: string;
  modelLinked?: LinkView;
  provider: ProviderChoice;
  /** Nom du preset fusionné dans l'env, quel que soit le harnais. */
  mergedPreset?: string;
  options: OptionsChoice;
  /** Variables d'env propres à l'engine (la fusion en est exclue). */
  env: EnvVarView[];
  /** Raison pour laquelle l'engine ne se modifie pas depuis l'app. */
  readOnly?: string;
}

export interface AgentView {
  key: string;
  label?: string;
  info?: string;
  avatar?: string;
  engines: EngineView[];
}

export interface PresetView {
  name: string;
  kind: "provider" | "options" | "other";
  builtIn: boolean;
  /** Faux pour un built-in proposé mais pas encore écrit dans le fichier. */
  inFile: boolean;
  vars: EnvVarView[];
  options: string[];
  /** Commandes de test des engines qui utilisent ce preset. */
  usedBy: string[];
}

export interface ParseErrorView {
  message: string;
  line: number;
  col: number;
}

export interface ConfigView {
  path: string;
  /** `path` pour l'affichage : le dossier personnel y est écrit `~`. */
  displayPath: string;
  isNew: boolean;
  dirty: boolean;
  /** Vrai quand une opération a modifié le document depuis la base (un fichier neuf intact : faux). */
  canRevert: boolean;
  parseError?: ParseErrorView;
  agents: AgentView[];
  presets: PresetView[];
  issues: IssueView[];
}

export type ProviderInput = { kind: "anthropic" } | { kind: "preset"; name: string } | { kind: "custom" };
export type OptionsInput =
  | { kind: "none" }
  | { kind: "preset"; name: string }
  | { kind: "custom"; values: string[] };

/** Toutes les modifications que la page peut demander ; chaque membre est discriminé par `op`. */
export type EditOp =
  // Tâche 3 (agent-ops.ts)
  | { op: "addAgent"; key: string; label: string }
  | { op: "duplicateAgent"; key: string }
  | { op: "deleteAgent"; key: string }
  | { op: "renameAgent"; key: string; newKey: string }
  | { op: "setAgentField"; key: string; field: "label" | "avatar"; value: string | null }
  | { op: "addEngine"; agent: string; name: string; harness: Harness }
  | { op: "deleteEngine"; agent: string; engine: string }
  | { op: "renameEngine"; agent: string; engine: string; newName: string }
  | { op: "makeDefault"; agent: string; engine: string }
  // Tâche 4 (engine-ops.ts)
  | { op: "setHarness"; agent: string; engine: string; harness: Harness }
  | { op: "setModel"; agent: string; engine: string; value: string | null }
  | { op: "setProvider"; agent: string; engine: string; provider: ProviderInput }
  | { op: "setOptions"; agent: string; engine: string; options: OptionsInput }
  /** `create: true` : le nom ne doit pas exister (ligne « + Add variable ») ; sans lui, écrire sur un nom existant le modifie. */
  | { op: "setEnvVar"; agent: string; engine: string; name: string; value: string; previousName?: string; create?: boolean }
  | { op: "deleteEnvVar"; agent: string; engine: string; name: string }
  | { op: "removeMerge"; agent: string; engine: string }
  | { op: "unlink"; path: (string | number)[] }
  | { op: "quoteValue"; path: (string | number)[] }
  // Tâche 5 (preset-ops.ts)
  | { op: "addPreset"; name: string; kind: "provider" | "options" }
  | { op: "renamePreset"; name: string; newName: string }
  | { op: "deletePreset"; name: string }
  | { op: "setPresetVar"; name: string; varName: string; value: string; previousName?: string; create?: boolean }
  | { op: "deletePresetVar"; name: string; varName: string }
  | { op: "setPresetOptions"; name: string; values: string[] };
