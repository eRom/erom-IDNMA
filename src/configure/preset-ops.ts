import { type Alias, isAlias, isMap, isNode, isScalar, isSeq, type Node, Pair, parseDocument, Scalar, visit, YAMLMap, YAMLSeq } from "yaml";
import { assertAnchorsFree, checkKey, ensureMapAt, ensureRootMap } from "./agent-ops.ts";
import { type BuiltinPresetName, builtinPresetText, isBuiltinPreset } from "./builtins.ts";
import { commandLine } from "./command.ts";
import type { ConfigDocument } from "./document.ts";
import {
  asNode,
  assertNotLinked,
  EditRefused,
  ENV_NAME_PATTERN,
  findPair,
  ownVariable,
  preferredOptionsFlow,
  textNode,
  writeText,
} from "./nodes.ts";
import type { EditOp } from "./types.ts";

export type PresetOp = Extract<
  EditOp,
  { op: "addPreset" | "renamePreset" | "deletePreset" | "setPresetVar" | "deletePresetVar" | "setPresetOptions" }
>;

export type PresetKind = "provider" | "options";

/** Combien d'utilisateurs un refus de suppression nomme avant de résumer le reste. */
const USERS_SHOWN = 3;

/**
 * Opérations sur les presets. Chacune vérifie tout avant sa première écriture : un refus
 * (`EditRefused`) laisse le `Document` exactement comme il était. Rend `true` si l'arbre a changé,
 * `false` si l'opération n'avait rien à faire.
 */
export function applyPresetOp(config: ConfigDocument, op: PresetOp): boolean {
  switch (op.op) {
    case "addPreset":
      return addPreset(config, op.name, op.kind);
    case "renamePreset":
      return renamePreset(config, op.name, op.newName);
    case "deletePreset":
      return deletePreset(config, op.name);
    case "setPresetVar":
      return setPresetVar(config, op.name, op.varName, op.value, op.previousName, op.create);
    case "deletePresetVar":
      return deletePresetVar(config, op.name, op.varName);
    case "setPresetOptions":
      return setPresetOptions(config, op.name, op.values);
    default: {
      const unreachable: never = op;
      throw new EditRefused(`Unknown operation: ${JSON.stringify(unreachable)}`);
    }
  }
}

// --- Retrouver un preset et écrire un built-in -------------------------------------------------

/** Un preset trouvé : sa paire, son nœud valeur (celui qui porte l'ancre), et s'il est déjà dans le fichier. */
interface LocatedPreset {
  pair: Pair;
  node: Node;
  inFile: boolean;
}

/**
 * Retrouve le preset `name`. Un preset du fichier se trouve par sa clé ; un built-in absent se retrouve par
 * son ancre (`local: &ollama` est le built-in `ollama`) et, faute de mieux, se prépare en copie détachée
 * du gabarit (`inFile: false`) que l'appelant écrit s'il en a besoin. Rien n'est écrit ici.
 */
function locatePreset(config: ConfigDocument, name: string): LocatedPreset {
  const presets = config.presetsMap();
  const own = presets ? findPair(presets, name) : undefined;
  if (own) {
    const node = asNode(own.value);
    if (!node) throw new EditRefused(`Preset "${name}" has no value.`);
    return { pair: own, node, inFile: true };
  }
  if (!isBuiltinPreset(name)) throw new EditRefused(`Preset "${name}" does not exist.`);

  for (const item of presets?.items ?? []) {
    const node = asNode(item.value);
    if (node?.anchor === name) return { pair: item, node, inFile: true };
  }
  // Une ancre du même nom ailleurs dans le fichier : l'écrire la définirait deux fois.
  const taken = config.anchorSites().get(name);
  if (taken) {
    const where = taken.definedAt ?? taken.aliases[0] ?? "the file";
    throw new EditRefused(`Anchor &${name} is already used by ${where}, so built-in preset "${name}" cannot be added.`);
  }
  const pair = freshBuiltin(name);
  return { pair, node: pair.value as Node, inFile: false };
}

/** Le bloc du built-in lu depuis `builtinPresetText`, hors de tout document : une paire `nom: &nom …` neuve. */
function freshBuiltin(name: BuiltinPresetName): Pair {
  const parsed = parseDocument(builtinPresetText(name));
  const pair = (parsed.contents as YAMLMap).items[0];
  if (!pair || !isNode(pair.value)) throw new Error(`Preset built-in illisible : ${name}`);
  return pair;
}

function checkKind(name: string, node: Node, kind: PresetKind | undefined): void {
  if (kind === "provider" && !isMap(node)) throw new EditRefused(`Preset "${name}" is not a provider.`);
  if (kind === "options" && !isSeq(node)) throw new EditRefused(`Preset "${name}" is not an option set.`);
}

/**
 * Le nœud valeur du preset `name`, celui qui porte l'ancre. Un built-in absent du fichier est écrit à la
 * fin de `presets:` (la section est créée en tête du document s'il le faut), avec son ancre. `kind` fait
 * refuser un preset de la mauvaise forme avant toute écriture.
 */
export function ensurePresetInFile(config: ConfigDocument, name: string, kind: "provider"): YAMLMap;
export function ensurePresetInFile(config: ConfigDocument, name: string, kind: "options"): YAMLSeq;
export function ensurePresetInFile(config: ConfigDocument, name: string, kind?: PresetKind): Node;
export function ensurePresetInFile(config: ConfigDocument, name: string, kind?: PresetKind): Node {
  const located = locatePreset(config, name);
  checkKind(name, located.node, kind);
  if (!located.inFile) insertPreset(config, located.pair);
  return located.node;
}

/** Écrit un preset en fin de `presets:` ; sans cette section, elle est créée en tête, avant `agents:`. */
function insertPreset(config: ConfigDocument, pair: Pair): void {
  const root = ensureRootMap(config);
  if (findPair(root, "presets")) {
    ensureMapAt(root, "presets").items.push(pair);
    return;
  }
  const section = new YAMLMap();
  section.items.push(pair);
  const following = root.items[0]?.key;
  root.items.unshift(new Pair(new Scalar("presets"), section));
  // Une ligne vide sépare la section créée de ce qui la suit.
  if (isScalar(following)) following.spaceBefore = true;
}

/** Écrit le preset trouvé s'il vient du gabarit et que l'opération a bien changé quelque chose. */
function commit(config: ConfigDocument, located: LocatedPreset, changed: boolean): boolean {
  if (changed && !located.inFile) insertPreset(config, located.pair);
  return changed;
}

/** Le preset du fichier nommé par sa clé (pas un built-in à écrire) : rename et delete n'agissent que sur lui. */
function requirePresetInFile(config: ConfigDocument, name: string): { presets: YAMLMap; pair: Pair; node: Node } {
  const presets = config.presetsMap();
  const pair = presets ? findPair(presets, name) : undefined;
  const node = asNode(pair?.value);
  if (!presets || !pair || !node) throw new EditRefused(`Preset "${name}" does not exist.`);
  return { presets, pair, node };
}

/** Refuse un nom d'ancre déjà porté par un nœud du fichier. */
function assertAnchorName(config: ConfigDocument, anchor: string): void {
  const taken = config.anchorSites().get(anchor);
  if (taken) throw new EditRefused(`Anchor &${anchor} is already used by ${taken.definedAt ?? taken.aliases[0] ?? "the file"}.`);
}

// --- Ajout, renommage, suppression -------------------------------------------------------------

/** Un nom de built-in garde sa forme : `claude-max` est une liste d'options, les trois autres des providers. */
function assertBuiltinKind(name: string, kind: PresetKind): void {
  if (!isBuiltinPreset(name)) return;
  const builtinKind: PresetKind = isSeq(freshBuiltin(name).value) ? "options" : "provider";
  if (builtinKind !== kind) {
    throw new EditRefused(`"${name}" is a built-in ${builtinKind === "options" ? "option set" : "provider"}; pick another name.`);
  }
}

function addPreset(config: ConfigDocument, name: string, kind: PresetKind): boolean {
  checkKey("Preset name", name);
  if (config.presetsMap()?.has(name)) throw new EditRefused(`Preset "${name}" already exists.`);
  assertBuiltinKind(name, kind);
  assertAnchorName(config, name);
  const node = kind === "provider" ? new YAMLMap() : new YAMLSeq();
  node.anchor = name;
  insertPreset(config, config.doc.createPair(name, node));
  return true;
}

/**
 * Renomme la clé, l'ancre et les alias du preset. L'ancre prend le nom de la clé : elle fait l'identité du
 * preset (c'est à elle que les engines se lient). Seuls les alias liés à CE preset changent : si le nom
 * d'ancre est redéfini ailleurs, les alias de l'autre définition gardent le leur.
 */
function renamePreset(config: ConfigDocument, name: string, newName: string): boolean {
  checkKey("Preset name", newName);
  const { presets, pair, node } = requirePresetInFile(config, name);
  const keyChanges = newName !== name;
  const oldAnchor = node.anchor;
  const anchorChanges = oldAnchor !== undefined && oldAnchor !== newName;
  if (!keyChanges && !anchorChanges) return false;

  if (keyChanges && presets.has(newName)) throw new EditRefused(`Preset "${newName}" already exists.`);
  if (keyChanges) assertBuiltinKind(newName, isSeq(node) ? "options" : "provider");
  if (anchorChanges) assertAnchorName(config, newName);

  const aliases = oldAnchor !== undefined && anchorChanges ? aliasesBoundTo(config, node, oldAnchor) : [];
  if (isScalar(pair.key)) pair.key.value = newName;
  if (anchorChanges) {
    node.anchor = newName;
    for (const alias of aliases) alias.source = newName;
  }
  return true;
}

/** Les alias que le parseur lie à ce nœud : ceux qui suivent sa définition, avant une éventuelle redéfinition du nom. */
function aliasesBoundTo(config: ConfigDocument, definition: Node, anchor: string): Alias[] {
  const aliases: Alias[] = [];
  let current: Node | undefined;
  visit(config.doc, (_key, node) => {
    if (isAlias(node)) {
      if (node.source === anchor && current === definition) aliases.push(node);
    } else if (isNode(node) && node.anchor === anchor) {
      current = node;
    }
  });
  return aliases;
}

function deletePreset(config: ConfigDocument, name: string): boolean {
  const { presets, pair, node } = requirePresetInFile(config, name);
  if (node.anchor !== undefined) {
    const users = [...new Set(config.aliasUsers(node.anchor).map((path) => userLabel(config, path)))];
    if (users.length > 0) {
      const shown = users.slice(0, USERS_SHOWN).join(", ");
      const rest = users.length > USERS_SHOWN ? ` and ${users.length - USERS_SHOWN} more` : "";
      throw new EditRefused(`Preset "${name}" is used by ${shown}${rest}.`);
    }
  }
  // Les ancres posées sur les valeurs du preset (hors la sienne, déjà libre) ne doivent pas servir ailleurs.
  assertAnchorsFree(config, node);
  presets.items = presets.items.filter((item) => item !== pair);
  return true;
}

/** Un utilisateur d'une ancre, nommé comme on le teste : `idnma run glm` pour un engine, le chemin sinon. */
function userLabel(config: ConfigDocument, path: string): string {
  for (const agent of config.agentsMap()?.items ?? []) {
    if (!isScalar(agent.key) || !isMap(agent.value)) continue;
    const engines = agent.value.get("engines", true);
    for (const engine of isMap(engines) ? engines.items : []) {
      if (!isScalar(engine.key)) continue;
      const prefix = `agents.${String(agent.key.value)}.engines.${String(engine.key.value)}`;
      if (path === prefix || path.startsWith(`${prefix}.`)) return commandLine(String(agent.key.value), String(engine.key.value));
    }
  }
  return path;
}

// --- Contenu d'un preset -----------------------------------------------------------------------

function providerMap(located: LocatedPreset, name: string): YAMLMap {
  if (!isMap(located.node)) throw new EditRefused(`Preset "${name}" is not a provider.`);
  return located.node;
}

function setPresetVar(config: ConfigDocument, name: string, varName: string, value: string, previousName?: string, create?: boolean): boolean {
  const located = locatePreset(config, name);
  const map = providerMap(located, name);
  const renaming = previousName !== undefined && previousName !== varName;
  const existing = ownVariable(map, renaming ? previousName : varName);
  // Le motif ne vaut que pour un nom qu'on écrit : la valeur d'une variable au nom inhabituel reste modifiable.
  if ((renaming || !existing) && !ENV_NAME_PATTERN.test(varName)) {
    throw new EditRefused(`Variable name "${varName}" is not valid: use letters, digits and underscores, and do not start with a digit.`);
  }
  // Une création ne réécrit jamais une variable existante (la ligne « + Add variable » viderait sa valeur).
  if (create && previousName === undefined && existing) throw new EditRefused(`Variable "${varName}" already exists in preset "${name}".`);
  if (renaming) {
    if (!existing) throw new EditRefused(`Variable "${previousName}" does not exist in preset "${name}".`);
    if (ownVariable(map, varName)) throw new EditRefused(`Variable "${varName}" already exists in preset "${name}".`);
  }

  if (!existing) {
    // Un preset neuf (ou `{}`) passe en bloc dès sa première variable.
    if (map.items.length === 0) map.flow = false;
    map.items.push(config.doc.createPair(varName, textNode(config, value, Scalar.QUOTE_DOUBLE)));
    return commit(config, located, true);
  }
  const current = existing.value;
  assertNotLinked(current, `Variable ${previousName ?? varName} of preset "${name}"`);
  if (!isScalar(current)) throw new EditRefused(`Variable ${previousName ?? varName} of preset "${name}" is not a text value.`);
  // Les valeurs sont du texte entre guillemets ; un guillemet simple déjà là reste simple.
  // Une valeur déjà égale ne se réécrit pas : sans cela, `A: b` deviendrait `A: "b"` sans rien changer.
  let changed =
    current.value === value ? false : writeText(current, value, current.type === Scalar.QUOTE_SINGLE ? Scalar.QUOTE_SINGLE : Scalar.QUOTE_DOUBLE);
  if (renaming && isScalar(existing.key)) {
    existing.key.value = varName;
    changed = true;
  }
  return commit(config, located, changed);
}

function deletePresetVar(config: ConfigDocument, name: string, varName: string): boolean {
  const located = locatePreset(config, name);
  const map = providerMap(located, name);
  const existing = ownVariable(map, varName);
  if (!existing) throw new EditRefused(`Variable "${varName}" does not exist in preset "${name}".`);
  assertAnchorsFree(config, asNode(existing.value));
  map.items = map.items.filter((item) => item !== existing);
  return commit(config, located, true);
}

function setPresetOptions(config: ConfigDocument, name: string, values: string[]): boolean {
  const located = locatePreset(config, name);
  if (!isSeq(located.node)) throw new EditRefused(`Preset "${name}" is not an option set.`);
  const seq = located.node;
  const same = seq.items.length === values.length && seq.items.every((item, i) => isScalar(item) && item.value === values[i]);
  if (same) return false;
  for (const item of seq.items) assertAnchorsFree(config, asNode(item));

  // En place : la liste garde son ancre, sa position et son style ; une liste vide suit le style du fichier.
  const wasEmpty = seq.items.length === 0;
  seq.items = (config.doc.createNode(values) as YAMLSeq).items;
  if (wasEmpty) seq.flow = preferredOptionsFlow(config);
  return commit(config, located, true);
}
