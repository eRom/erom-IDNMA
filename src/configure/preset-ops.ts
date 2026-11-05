import type { Node } from "yaml";
import type { ConfigDocument } from "./document.ts";
import { isBuiltinPreset } from "./builtins.ts";
import { EditRefused } from "./nodes.ts";

/**
 * Le nœud valeur du preset `name`, celui qui porte l'ancre. Un preset absent du fichier est refusé en
 * le nommant ; un built-in absent sera écrit dans `presets:` à la tâche 5, d'ici là il est refusé aussi.
 */
export function ensurePresetInFile(config: ConfigDocument, name: string): Node {
  const found = config.presetNode(name);
  if (found) return found;
  if (isBuiltinPreset(name)) throw new EditRefused(`Built-in preset "${name}" is not in the file yet.`);
  throw new EditRefused(`Preset "${name}" does not exist.`);
}
