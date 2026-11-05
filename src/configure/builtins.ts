/** Presets livrés avec idnma (valeurs de `.idnma.example.yml`, spec §4). */
export const BUILTIN_PRESET_NAMES = ["ollama", "lmstudio", "openrouter", "claude-max"] as const;

export type BuiltinPresetName = (typeof BUILTIN_PRESET_NAMES)[number];

/**
 * Contenu d'un fichier neuf. Le texte ressort à l'octet près d'un aller-retour par le `Document` ;
 * `$OPENROUTER_API_KEY` est une référence littérale, jamais une valeur lue dans l'environnement.
 */
export const NEW_FILE_TEMPLATE = `presets:
  ollama: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"
    ANTHROPIC_AUTH_TOKEN: "ollama"
    ANTHROPIC_API_KEY: ""
  lmstudio: &lmstudio
    ANTHROPIC_BASE_URL: "http://localhost:1234"
    ANTHROPIC_AUTH_TOKEN: "lmstudio"
    ANTHROPIC_API_KEY: ""
  openrouter: &openrouter
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api"
    ANTHROPIC_AUTH_TOKEN: "$OPENROUTER_API_KEY"
    ANTHROPIC_API_KEY: ""
  claude-max: &claude-max [--effort, max, --dangerously-skip-permissions]

agents:
`;

export function isBuiltinPreset(name: string): name is BuiltinPresetName {
  return (BUILTIN_PRESET_NAMES as readonly string[]).includes(name);
}

/**
 * Bloc YAML d'un preset built-in, sans indentation (la ligne `nom: &nom` en tête), prêt à être inséré
 * dans `presets:` au premier usage. Extrait du gabarit : une seule source pour les quatre valeurs.
 */
export function builtinPresetText(name: BuiltinPresetName): string {
  const lines = NEW_FILE_TEMPLATE.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`  ${name}: &${name}`));
  if (start === -1) throw new Error(`Preset built-in inconnu : ${name}`);
  const block = [lines[start] ?? ""];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ")) break;
    block.push(line);
  }
  return block.map((line) => line.slice(2)).join("\n");
}
