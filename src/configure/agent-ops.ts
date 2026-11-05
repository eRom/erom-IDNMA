import { isAlias, isMap, isNode, isScalar, type Node, type Pair, type Scalar, visit, YAMLMap } from "yaml";
import type { ConfigDocument } from "./document.ts";
import { EditRefused, readablePath } from "./nodes.ts";
import type { EditOp } from "./types.ts";

export type AgentOp = Extract<
  EditOp,
  {
    op:
      | "addAgent"
      | "duplicateAgent"
      | "deleteAgent"
      | "renameAgent"
      | "setAgentField"
      | "addEngine"
      | "deleteEngine"
      | "renameEngine"
      | "makeDefault";
  }
>;

/** Forme d'une clé d'agent ou d'un nom d'engine : ce que la CLI sait écrire après `idnma run` et `--engine`. */
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Opérations de structure sur les agents et leurs engines. Chacune vérifie tout avant sa première
 * écriture : un refus (`EditRefused`) laisse le `Document` exactement comme il était. Rend `true`
 * si l'arbre a changé, `false` si l'opération n'avait rien à faire.
 */
export function applyAgentOp(config: ConfigDocument, op: AgentOp): boolean {
  switch (op.op) {
    case "addAgent":
      return addAgent(config, op.key, op.label);
    case "duplicateAgent":
      return duplicateAgent(config, op.key);
    case "deleteAgent":
      return deleteAgent(config, op.key);
    case "renameAgent":
      return renameAgent(config, op.key, op.newKey);
    case "setAgentField":
      return setAgentField(config, op.key, op.field, op.value);
    case "addEngine":
      return addEngine(config, op.agent, op.name, op.harness);
    case "deleteEngine":
      return deleteEngine(config, op.agent, op.engine);
    case "renameEngine":
      return renameEngine(config, op.agent, op.engine, op.newName);
    case "makeDefault":
      return makeDefault(config, op.agent, op.engine);
    default: {
      const unreachable: never = op;
      throw new EditRefused(`Unknown operation: ${JSON.stringify(unreachable)}`);
    }
  }
}

// --- Agents -------------------------------------------------------------------------------------

function addAgent(config: ConfigDocument, key: string, label: string): boolean {
  checkKey("Agent key", key);
  if (config.agentsMap()?.has(key)) throw new EditRefused(`Agent "${key}" already exists.`);
  const agents = ensureMapAt(ensureRootMap(config), "agents");
  agents.add(config.doc.createPair(key, config.doc.createNode({ label })));
  return true;
}

/**
 * Copie un agent à la suite des autres : mêmes engines, même avatar, ni `info` ni `cell`, une clé
 * `<clé>-copy` et un label `<label> copy`. Les ancres définies dans l'agent sont dépliées dans la copie
 * (valeurs en clair), sinon le fichier porterait deux fois la même ancre.
 */
function duplicateAgent(config: ConfigDocument, key: string): boolean {
  const original = requireAgent(config, key);
  const agents = config.agentsMap() as YAMLMap;

  let newKey = `${key}-copy`;
  for (let n = 2; agents.has(newKey); n++) newKey = `${key}-copy-${n}`;

  // Tout se fait sur un clone détaché : un refus plus bas ne touche pas le document.
  const clone = original.clone() as YAMLMap;
  unlinkInternalAnchors(clone);

  // Un label absent ou qui n'est pas un texte (liste, table) laisse la clé de l'agent comme base.
  const originalLabel = original.get("label", true);
  const labelBase = isScalar(originalLabel) && originalLabel.value != null ? String(originalLabel.value) : key;
  const copy = new YAMLMap();
  copy.items.push(config.doc.createPair("label", `${labelBase} copy`));
  for (const field of ["avatar", "engines"]) {
    const pair = findPair(clone, field);
    if (pair) copy.items.push(pair);
  }
  agents.add(config.doc.createPair(newKey, copy));
  return true;
}

function deleteAgent(config: ConfigDocument, key: string): boolean {
  const agent = requireAgent(config, key);
  assertAnchorsFree(config, agent);
  (config.agentsMap() as YAMLMap).delete(key);
  return true;
}

function renameAgent(config: ConfigDocument, key: string, newKey: string): boolean {
  checkKey("Agent key", newKey);
  requireAgent(config, key);
  const agents = config.agentsMap() as YAMLMap;
  if (agents.has(newKey)) throw new EditRefused(`Agent "${newKey}" already exists.`);
  renameKey(agents, key, newKey);
  return true;
}

function setAgentField(config: ConfigDocument, key: string, field: "label" | "avatar", value: string | null): boolean {
  const agent = requireAgent(config, key);
  const pair = findPair(agent, field);

  if (value === null) {
    if (!pair) return false;
    agent.delete(field);
    return true;
  }
  if (pair) {
    const current = pair.value;
    if (isScalar(current)) {
      // En place : si la valeur porte une ancre, elle la garde.
      current.value = value;
    } else if (isAlias(current)) {
      pair.value = config.doc.createNode(value);
    } else {
      throw new EditRefused(`Field "${field}" of agent "${key}" is not a text value.`);
    }
    return true;
  }

  const created = config.doc.createPair(field, value);
  if (field === "label") {
    agent.items.unshift(created);
    return true;
  }
  const enginesAt = agent.items.findIndex((item) => keyIs(item, "engines"));
  if (enginesAt === -1) agent.items.push(created);
  else agent.items.splice(enginesAt, 0, created);
  return true;
}

// --- Engines ------------------------------------------------------------------------------------

function addEngine(config: ConfigDocument, agent: string, name: string, harness: string): boolean {
  checkKey("Engine name", name);
  const agentMap = requireAgent(config, agent);
  const existing = agentMap.get("engines", true);
  if (isMap(existing) && existing.has(name)) {
    throw new EditRefused(`Engine "${name}" already exists on agent "${agent}".`);
  }
  const engines = ensureMapAt(agentMap, "engines");
  engines.add(config.doc.createPair(name, config.doc.createNode({ harness })));
  return true;
}

function deleteEngine(config: ConfigDocument, agent: string, engine: string): boolean {
  const engines = requireEngines(config, agent, engine);
  assertAnchorsFree(config, engines.get(engine, true) as Node | undefined);
  engines.delete(engine);
  return true;
}

function renameEngine(config: ConfigDocument, agent: string, engine: string, newName: string): boolean {
  checkKey("Engine name", newName);
  const engines = requireEngines(config, agent, engine);
  if (engines.has(newName)) throw new EditRefused(`Engine "${newName}" already exists on agent "${agent}".`);
  renameKey(engines, engine, newName);
  return true;
}

/** Échange les noms de l'engine et de `default` ; sans `default`, l'engine prend ce nom. */
function makeDefault(config: ConfigDocument, agent: string, engine: string): boolean {
  if (engine === "default") throw new EditRefused(`Engine "default" of agent "${agent}" is already the default.`);
  const engines = requireEngines(config, agent, engine);
  const target = findPair(engines, engine) as Pair;
  const current = findPair(engines, "default");
  (target.key as Scalar).value = "default";
  if (current) (current.key as Scalar).value = engine;
  return true;
}

// --- Garde des ancres et dépliage --------------------------------------------------------------

/**
 * Refuse de retirer un sous-arbre dont une ancre est reprise par alias hors de lui : les alias
 * pointeraient dans le vide. Les alias internes au sous-arbre partent avec lui.
 */
function assertAnchorsFree(config: ConfigDocument, subtree: Node | undefined): void {
  if (!isNode(subtree)) return;
  const anchors = new Set<string>();
  const insideAliases = new Set<unknown>();
  visit(subtree, (_key, node) => {
    if (isAlias(node)) insideAliases.add(node);
    else if (isNode(node) && node.anchor) anchors.add(node.anchor);
  });
  if (anchors.size === 0) return;

  const outsideUsers = new Map<string, string[]>();
  visit(config.doc, (_key, node, path) => {
    if (isAlias(node) && anchors.has(node.source) && !insideAliases.has(node)) {
      const users = outsideUsers.get(node.source) ?? [];
      users.push(readablePath(path, node));
      outsideUsers.set(node.source, users);
    }
  });
  for (const anchor of anchors) {
    const users = outsideUsers.get(anchor);
    if (users) throw new EditRefused(`Anchor &${anchor} is used by ${users.join(", ")}.`);
  }
}

/**
 * Dans un clone détaché : remplace chaque alias vers une ancre définie dans ce clone par une copie de
 * sa valeur, puis retire ces ancres. Les alias vers une ancre extérieure (un preset) restent.
 */
function unlinkInternalAnchors(root: Node): void {
  // Parcours dans l'ordre du document : une ancre est toujours définie avant ses alias, et le parcours
  // en profondeur a déjà déplié ce qu'elle contient quand un alias la reprend. Une seule passe suffit.
  const definitions = new Map<string, Node>();
  visit(root, (_key, node) => {
    if (isAlias(node)) {
      const target = definitions.get(node.source);
      return target ? (target.clone() as Node) : undefined;
    }
    if (isNode(node) && node.anchor) definitions.set(node.anchor, node);
    return undefined;
  });
  if (definitions.size === 0) return;

  visit(root, (_key, node) => {
    if (!isAlias(node) && isNode(node) && node.anchor && definitions.has(node.anchor)) delete node.anchor;
  });
}

// --- Aides --------------------------------------------------------------------------------------

function checkKey(what: "Agent key" | "Engine name", key: string): void {
  if (!KEY_PATTERN.test(key) || key.startsWith("-")) {
    throw new EditRefused(
      `${what} "${key}" is not valid: use letters, digits, dots, underscores and hyphens, and do not start with a hyphen.`,
    );
  }
}

function keyIs(pair: Pair, name: string): boolean {
  return isScalar(pair.key) && pair.key.value === name;
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => keyIs(pair, key));
}

/** Renomme la clé de la paire en place : même nœud de clé, donc même position et mêmes commentaires. */
function renameKey(map: YAMLMap, key: string, newKey: string): void {
  const pair = findPair(map, key);
  if (pair && isScalar(pair.key)) pair.key.value = newKey;
}

function requireAgent(config: ConfigDocument, key: string): YAMLMap {
  if (!config.agentsMap()?.has(key)) throw new EditRefused(`Agent "${key}" does not exist.`);
  const agent = config.agentMap(key);
  if (!agent) throw new EditRefused(`Agent "${key}" is not a map of fields.`);
  return agent;
}

/** La table `engines:` de l'agent, après avoir vérifié que l'engine nommé s'y trouve. */
function requireEngines(config: ConfigDocument, agent: string, engine: string): YAMLMap {
  const engines = requireAgent(config, agent).get("engines", true);
  if (!isMap(engines) || !engines.has(engine)) {
    throw new EditRefused(`Engine "${engine}" does not exist on agent "${agent}".`);
  }
  return engines;
}

/** La table racine du fichier ; un fichier vide ou fait de commentaires en reçoit une. */
function ensureRootMap(config: ConfigDocument): YAMLMap {
  const contents = config.doc.contents;
  if (isMap(contents)) return contents;
  if (contents === null || (isScalar(contents) && contents.value === null)) {
    const root = new YAMLMap();
    config.doc.contents = root;
    return root;
  }
  throw new EditRefused("The file is not a map of sections.");
}

/** La table en bloc sous `key` ; créée si la clé manque ou ne porte rien (`agents:` seul). */
function ensureMapAt(parent: YAMLMap, key: string): YAMLMap {
  const current = parent.get(key, true);
  if (isMap(current)) {
    if (current.items.length === 0) current.flow = false;
    return current;
  }
  if (current === undefined || (isScalar(current) && current.value === null)) {
    const created = new YAMLMap();
    parent.set(key, created);
    return created;
  }
  throw new EditRefused(`The ${key} section is not a map.`);
}
