import { isAlias, isMap, isNode, isScalar, isSeq, type Node, Pair, Scalar, visit, type YAMLMap, type YAMLSeq } from "yaml";
import { assertAnchorsFree, ensureMapAt, requireEngines } from "./agent-ops.ts";
import type { ConfigDocument } from "./document.ts";
import { EditRefused, findPair, isMergePair, keyIs } from "./nodes.ts";
import { ensurePresetInFile } from "./preset-ops.ts";
import type { EditOp, OptionsInput, ProviderInput } from "./types.ts";

export type EngineOp = Extract<
  EditOp,
  {
    op:
      | "setHarness"
      | "setModel"
      | "setProvider"
      | "setOptions"
      | "setEnvVar"
      | "deleteEnvVar"
      | "removeMerge"
      | "unlink"
      | "quoteValue";
  }
>;

/** Forme d'un nom de variable d'environnement : ce que le shell sait exporter. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Ordre des champs d'un engine dans le fichier : un champ créé s'insère à sa place. */
const FIELD_ORDER = ["harness", "model", "options", "env"];

/**
 * Opérations sur les champs d'un engine. Chacune vérifie tout avant sa première écriture : un refus
 * (`EditRefused`) laisse le `Document` exactement comme il était. Rend `true` si l'arbre a changé,
 * `false` si l'opération n'avait rien à faire.
 */
export function applyEngineOp(config: ConfigDocument, op: EngineOp): boolean {
  switch (op.op) {
    case "setHarness":
      return setHarness(config, op.agent, op.engine, op.harness);
    case "setModel":
      return setModel(config, op.agent, op.engine, op.value);
    case "setProvider":
      return setProvider(config, op.agent, op.engine, op.provider);
    case "setOptions":
      return setOptions(config, op.agent, op.engine, op.options);
    case "setEnvVar":
      return setEnvVar(config, op.agent, op.engine, op.name, op.value, op.previousName);
    case "deleteEnvVar":
      return deleteEnvVar(config, op.agent, op.engine, op.name);
    case "removeMerge":
      return removeMerge(config, op.agent, op.engine);
    case "unlink":
      return unlink(config, op.path);
    case "quoteValue":
      return quoteValue(config, op.path);
    default: {
      const unreachable: never = op;
      throw new EditRefused(`Unknown operation: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Vrai si la majorité des listes sous une clé `options` sont écrites en ligne (`[a, b]`), et aussi s'il
 * n'y en a aucune : une liste neuve suit le style du fichier, en ligne pour un fichier neuf.
 */
export function preferredOptionsFlow(config: ConfigDocument): boolean {
  let flow = 0;
  let block = 0;
  visit(config.doc, {
    Pair(_key, pair) {
      if (keyIs(pair, "options") && isSeq(pair.value)) {
        if (pair.value.flow) flow++;
        else block++;
      }
    },
  });
  return flow >= block;
}

// --- Champs simples -----------------------------------------------------------------------------

function setHarness(config: ConfigDocument, agent: string, engine: string, harness: string): boolean {
  const target = requireEngine(config, agent, engine);
  const harnessPair = findPair(target, "harness");
  const current = harnessPair?.value;
  if (harnessPair) {
    assertNotLinked(current, `The harness of ${agent}/${engine}`);
    if (!isScalar(current)) throw new EditRefused(`The harness of ${agent}/${engine} is not a text value.`);
  }
  const previous = isScalar(current) ? String(current.value) : undefined;
  if (previous === harness) return false;

  // Ce que le nouveau harnais n'utilise pas part : les flags sont propres à chaque harnais, le `<<` du
  // provider n'a de sens que pour claude, et dst ne prend pas de modèle. Les clés d'env propres restent.
  const optionsPair = findPair(target, "options");
  const modelPair = harness === "dst" ? findPair(target, "model") : undefined;
  const env = envMapOf(target, agent, engine);
  const merge = previous === "claude" && harness !== "claude" ? env?.items.find(isMergePair) : undefined;
  for (const dropped of [optionsPair?.value, modelPair?.value]) assertAnchorsFree(config, asNode(dropped));

  if (isScalar(current)) writeText(current, harness);
  else insertField(target, "harness", config.doc.createNode(harness));
  if (optionsPair) target.delete("options");
  if (modelPair) target.delete("model");
  if (env && merge) {
    env.items.splice(env.items.indexOf(merge), 1);
    dropEnvIfEmpty(target);
  }
  return true;
}

function setModel(config: ConfigDocument, agent: string, engine: string, value: string | null): boolean {
  const target = requireEngine(config, agent, engine);
  const pair = findPair(target, "model");
  // Un champ vidé à la saisie s'enlève, comme `null` : `model: ""` ferait lancer `--model ""`.
  if (value === null || value === "") {
    if (!pair) return false;
    assertAnchorsFree(config, asNode(pair.value));
    target.delete("model");
    return true;
  }
  if (!pair) {
    insertField(target, "model", config.doc.createNode(value));
    return true;
  }
  const current = pair.value;
  assertNotLinked(current, `The model of ${agent}/${engine}`);
  if (!isScalar(current)) throw new EditRefused(`The model of ${agent}/${engine} is not a text value.`);
  return writeText(current, value);
}

// --- Provider et options -----------------------------------------------------------------------

function setProvider(config: ConfigDocument, agent: string, engine: string, provider: ProviderInput): boolean {
  const target = requireEngine(config, agent, engine);
  if (harnessOf(config, target) !== "claude") throw new EditRefused("Only claude engines take a provider.");
  const env = envMapOf(target, agent, engine);
  const merge = env?.items.find(isMergePair);

  if (provider.kind === "anthropic") {
    if (!env || !merge) return false;
    env.items.splice(env.items.indexOf(merge), 1);
    dropEnvIfEmpty(target);
    return true;
  }

  if (provider.kind === "custom") {
    // Détacher : les valeurs du preset deviennent celles de l'engine, à la place du `<<`. Une clé que
    // l'engine pose déjà l'emporte sur le preset (c'est la règle de la fusion), l'env effectif ne change pas.
    if (!env || !merge) return false;
    if (!isAlias(merge.value)) throw new EditRefused(`The env of ${agent}/${engine} merges several presets; edit the file directly.`);
    const source = merge.value.resolve(config.doc);
    if (!isMap(source)) throw new EditRefused(`Anchor &${merge.value.source} is not a table of variables.`);
    const own = new Set(env.items.filter((item) => !isMergePair(item)).map((item) => (isScalar(item.key) ? String(item.key.value) : "")));
    const copies: Pair[] = [];
    for (const item of source.items) {
      if (isMergePair(item) || !isScalar(item.key) || !isScalar(item.value)) {
        throw new EditRefused(`Anchor &${merge.value.source} holds more than text variables; edit the file directly.`);
      }
      const name = String(item.key.value);
      if (own.has(name)) continue;
      const text = item.value.value === null || item.value.value === undefined ? "" : String(item.value.value);
      copies.push(config.doc.createPair(name, textNode(config, text, Scalar.QUOTE_DOUBLE)));
    }
    env.items.splice(env.items.indexOf(merge), 1, ...copies);
    dropEnvIfEmpty(target);
    return true;
  }

  const preset = ensurePresetInFile(config, provider.name);
  if (!isMap(preset)) throw new EditRefused(`Preset "${provider.name}" is not a provider.`);
  if (merge) {
    if (!isAlias(merge.value)) throw new EditRefused(`The env of ${agent}/${engine} merges several presets; edit the file directly.`);
    if (preset.anchor !== undefined && merge.value.source === preset.anchor) return false;
    merge.value = config.doc.createAlias(preset, provider.name);
    return true;
  }
  const targetEnv = env ?? ensureMapAt(target, "env");
  targetEnv.items.unshift(mergePair(config, preset, provider.name));
  return true;
}

function setOptions(config: ConfigDocument, agent: string, engine: string, options: OptionsInput): boolean {
  const target = requireEngine(config, agent, engine);
  const pair = findPair(target, "options");
  const current = pair?.value;

  if (options.kind === "none" || (options.kind === "custom" && options.values.length === 0)) {
    if (!pair) return false;
    assertAnchorsFree(config, asNode(current));
    target.delete("options");
    return true;
  }

  if (options.kind === "preset") {
    const preset = ensurePresetInFile(config, options.name);
    if (!isSeq(preset)) throw new EditRefused(`Preset "${options.name}" is not an option set.`);
    if (pair && isAlias(current) && preset.anchor !== undefined && current.source === preset.anchor) return false;
    if (pair) {
      assertAnchorsFree(config, asNode(current));
      pair.value = config.doc.createAlias(preset, options.name);
    } else {
      insertField(target, "options", config.doc.createAlias(preset, options.name));
    }
    return true;
  }

  // Liste libre. Une liste portant une ancre est partagée : la modifier en place changerait les autres.
  if (isNode(current) && !isAlias(current) && current.anchor) {
    throw new EditRefused(`The options of ${agent}/${engine} are linked through &${current.anchor}; unlink them first.`);
  }
  const fresh = config.doc.createNode(options.values, { flow: preferredOptionsFlow(config) }) as YAMLSeq;
  if (!pair) {
    insertField(target, "options", fresh);
    return true;
  }
  if (isSeq(current)) {
    // En place : la liste garde son style et sa position.
    const same = current.items.length === options.values.length && current.items.every((item, i) => isScalar(item) && item.value === options.values[i]);
    if (same) return false;
    current.items = fresh.items;
    return true;
  }
  if (isAlias(current) || (isScalar(current) && current.value === null)) {
    pair.value = fresh;
    return true;
  }
  throw new EditRefused(`The options of ${agent}/${engine} are not a list.`);
}

// --- Env ----------------------------------------------------------------------------------------

function setEnvVar(config: ConfigDocument, agent: string, engine: string, name: string, value: string, previousName?: string): boolean {
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new EditRefused(`Variable name "${name}" is not valid: use letters, digits and underscores, and do not start with a digit.`);
  }
  const target = requireEngine(config, agent, engine);
  const env = envMapOf(target, agent, engine);
  const renaming = previousName !== undefined && previousName !== name;
  const existing = env ? ownVariable(env, renaming ? previousName : name) : undefined;

  if (renaming) {
    if (!env || !existing) throw new EditRefused(`Variable "${previousName}" does not exist on ${agent}/${engine}.`);
    if (ownVariable(env, name)) throw new EditRefused(`Variable "${name}" already exists on ${agent}/${engine}.`);
  }
  if (!existing) {
    const created = config.doc.createPair(name, textNode(config, value, Scalar.QUOTE_DOUBLE));
    (env ?? ensureMapAt(target, "env")).items.push(created);
    return true;
  }

  const current = existing.value;
  assertNotLinked(current, `Variable ${previousName ?? name} of ${agent}/${engine}`);
  if (!isScalar(current)) throw new EditRefused(`Variable ${previousName ?? name} of ${agent}/${engine} is not a text value.`);
  // Les valeurs d'env sont du texte entre guillemets ; un guillemet simple déjà là reste simple.
  let changed = writeText(current, value, current.type === Scalar.QUOTE_SINGLE ? Scalar.QUOTE_SINGLE : Scalar.QUOTE_DOUBLE);
  if (renaming && isScalar(existing.key)) {
    existing.key.value = name;
    changed = true;
  }
  return changed;
}

function deleteEnvVar(config: ConfigDocument, agent: string, engine: string, name: string): boolean {
  const target = requireEngine(config, agent, engine);
  const env = envMapOf(target, agent, engine);
  const existing = env ? ownVariable(env, name) : undefined;
  if (!env || !existing) throw new EditRefused(`Variable "${name}" does not exist on ${agent}/${engine}.`);
  assertAnchorsFree(config, asNode(existing.value));
  env.items.splice(env.items.indexOf(existing), 1);
  dropEnvIfEmpty(target);
  return true;
}

function removeMerge(config: ConfigDocument, agent: string, engine: string): boolean {
  const target = requireEngine(config, agent, engine);
  const env = envMapOf(target, agent, engine);
  const merge = env?.items.find(isMergePair);
  if (!env || !merge) return false;
  env.items.splice(env.items.indexOf(merge), 1);
  dropEnvIfEmpty(target);
  return true;
}

// --- Valeurs liées et nombres -------------------------------------------------------------------

/** Un nœud trouvé par son chemin, avec de quoi le remplacer à sa place. */
interface Located {
  node: Node;
  replace(next: Node): void;
}

function locate(config: ConfigDocument, path: (string | number)[]): Located {
  let current: unknown = config.doc.contents;
  let located: Located | undefined;
  const walked: string[] = [];
  for (const segment of path) {
    walked.push(String(segment));
    if (isMap(current)) {
      const pair = current.items.find((item) => !isMergePair(item) && isScalar(item.key) && String(item.key.value) === String(segment));
      if (!pair || !isNode(pair.value)) throw new EditRefused(`Nothing at ${walked.join(".")}.`);
      current = pair.value;
      located = { node: pair.value, replace: (next) => void (pair.value = next) };
    } else if (isSeq(current)) {
      const index = Number(segment);
      const item = Number.isInteger(index) ? current.items[index] : undefined;
      if (!isNode(item)) throw new EditRefused(`Nothing at ${walked.join(".")}.`);
      const list = current;
      current = item;
      located = { node: item, replace: (next) => void (list.items[index] = next) };
    } else {
      throw new EditRefused(`Nothing at ${walked.join(".")}.`);
    }
  }
  if (!located) throw new EditRefused("Nothing to select: the path is empty.");
  return located;
}

/** Les valeurs de `presets:` : leur ancre fait le preset, aucune opération ne la retire. */
function presetValues(config: ConfigDocument): Set<unknown> {
  return new Set(config.presetsMap()?.items.map((item) => item.value));
}

/**
 * Remplace un alias par le texte qu'il désigne, ou détache le champ qui définit une ancre. Une ancre
 * devenue inutile est retirée ; une ancre encore reprise ailleurs passe au premier alias qui la suit
 * dans le fichier (il devient la définition), pour que les autres endroits restent liés entre eux.
 */
function unlink(config: ConfigDocument, path: (string | number)[]): boolean {
  const { node, replace } = locate(config, path);
  const presets = presetValues(config);
  if (presets.has(node)) throw new EditRefused(`Preset "${path[1]}" keeps its anchor: it is shared by design.`);

  if (isAlias(node)) {
    const source = node.resolve(config.doc);
    if (!isScalar(source) && !isSeq(source)) throw new EditRefused(`Anchor &${node.source} is not a single value or a list.`);
    replace(detachedCopy(source));
    dropAnchorIfUnused(config, node.source, presets);
    return true;
  }
  if (!node.anchor) return false;

  const anchor = node.anchor;
  const heir = detachedCopy(node);
  heir.anchor = anchor;
  let handed = false;
  visit(config.doc, {
    Alias(_key, alias) {
      if (handed || alias.source !== anchor) return undefined;
      handed = true;
      return heir;
    },
  });
  delete node.anchor;
  return true;
}

/** Passe un nombre ou un booléen YAML en texte entre guillemets doubles, avec l'écriture d'origine. */
function quoteValue(config: ConfigDocument, path: (string | number)[]): boolean {
  const { node } = locate(config, path);
  if (!isScalar(node)) throw new EditRefused(`Nothing to quote at ${path.join(".")}: it is not a single value.`);
  if (typeof node.value === "string") return false;
  node.value = node.source ?? String(node.value);
  node.type = Scalar.QUOTE_DOUBLE;
  delete node.source;
  return true;
}

/** Copie d'un nœud sans ancre ni commentaire, à poser à un autre endroit du fichier. */
function detachedCopy<T extends Node>(source: T): T {
  const copy = source.clone() as T;
  const strip = (node: unknown): void => {
    if (isNode(node)) delete node.anchor;
  };
  strip(copy);
  visit(copy, (_key, node) => void strip(node));
  delete copy.comment;
  delete copy.commentBefore;
  delete copy.spaceBefore;
  return copy;
}

/** Retire l'ancre de ses définitions quand plus aucun alias ne la reprend ; celle d'un preset reste. */
function dropAnchorIfUnused(config: ConfigDocument, anchor: string, presets: Set<unknown>): void {
  let used = false;
  const holders: Node[] = [];
  visit(config.doc, (_key, node) => {
    if (isAlias(node)) {
      if (node.source === anchor) used = true;
    } else if (isNode(node) && node.anchor === anchor) {
      holders.push(node);
    }
  });
  if (used) return;
  for (const holder of holders) if (!presets.has(holder)) delete holder.anchor;
}

// --- Aides --------------------------------------------------------------------------------------

function requireEngine(config: ConfigDocument, agent: string, engine: string): YAMLMap {
  const found = requireEngines(config, agent, engine).get(engine, true);
  if (!isMap(found)) throw new EditRefused(`Engine "${engine}" of agent "${agent}" is not a table of settings.`);
  return found;
}

function asNode(value: unknown): Node | undefined {
  return isNode(value) ? value : undefined;
}

/** Texte du harnais de l'engine, alias résolu ; `undefined` s'il manque ou n'est pas un texte. */
function harnessOf(config: ConfigDocument, target: YAMLMap): string | undefined {
  const node = target.get("harness", true);
  const resolved = isAlias(node) ? node.resolve(config.doc) : node;
  return isScalar(resolved) && resolved.value != null ? String(resolved.value) : undefined;
}

/** La table `env:` de l'engine ; `undefined` si elle manque ou ne porte rien, refus si ce n'est pas une table. */
function envMapOf(target: YAMLMap, agent: string, engine: string): YAMLMap | undefined {
  const env = target.get("env", true);
  if (env === undefined || (isScalar(env) && env.value === null)) return undefined;
  if (!isMap(env)) throw new EditRefused(`The env of ${agent}/${engine} is not a table of variables.`);
  return env;
}

/** Retire `env:` quand il ne reste rien dedans : `env: {}` n'a aucun sens dans le fichier. */
function dropEnvIfEmpty(target: YAMLMap): void {
  const env = target.get("env", true);
  if (isMap(env) && env.items.length === 0) target.delete("env");
}

/** Variable propre à l'engine (la fusion `<<` n'en est pas une). */
function ownVariable(env: YAMLMap, name: string): Pair | undefined {
  return env.items.find((item) => !isMergePair(item) && isScalar(item.key) && String(item.key.value) === name);
}

/** Insère un champ à sa place dans l'ordre `harness`, `model`, `options`, `env`. */
function insertField(target: YAMLMap, field: string, value: Node): void {
  const rank = FIELD_ORDER.indexOf(field);
  const pair = new Pair(new Scalar(field), value);
  const at = target.items.findIndex((item) => FIELD_ORDER.findIndex((name) => keyIs(item, name)) > rank);
  if (at === -1) target.items.push(pair);
  else target.items.splice(at, 0, pair);
}

/** La clé de fusion se construit à la main : `map.set("<<", …)` l'écrirait entre guillemets, ce n'est plus une fusion. */
function mergePair(config: ConfigDocument, preset: YAMLMap, name: string): Pair {
  const key = new Scalar("<<");
  key.type = Scalar.PLAIN;
  return new Pair(key, config.doc.createAlias(preset, name));
}

function textNode(config: ConfigDocument, value: string, style: Scalar.Type): Scalar {
  const node = config.doc.createNode(value) as Scalar;
  node.type = style;
  return node;
}

/** Écrit le texte dans le scalaire en place (son ancre reste) ; `true` si quelque chose a changé. */
function writeText(scalar: Scalar, value: string, style?: Scalar.Type): boolean {
  const changed = scalar.value !== value || (style !== undefined && scalar.type !== style);
  if (!changed) return false;
  scalar.value = value;
  if (style !== undefined) scalar.type = style;
  return true;
}

/** Un champ lié par ancre ne se modifie pas : l'ancre ou l'alias entraînerait les autres endroits. */
function assertNotLinked(node: unknown, what: string): void {
  if (isAlias(node)) throw new EditRefused(`${what} is linked through &${node.source}; unlink it first.`);
  if (isNode(node) && node.anchor) throw new EditRefused(`${what} is linked through &${node.anchor}; unlink it first.`);
}
