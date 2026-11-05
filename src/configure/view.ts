import { isAlias, isMap, isNode, isScalar, isSeq, type Pair, parseDocument, type YAMLMap } from "yaml";
import { BUILTIN_PRESET_NAMES, isBuiltinPreset, NEW_FILE_TEMPLATE } from "./builtins.ts";
import { commandLine } from "./command.ts";
import { type AnchorSites, type ConfigDocument, isMergePair } from "./document.ts";
import type {
  AgentView,
  ConfigView,
  EngineView,
  EnvVarView,
  LinkView,
  OptionsChoice,
  PresetView,
  ProviderChoice,
} from "./types.ts";

type Sites = Map<string, AnchorSites>;

/** Contexte de lecture : le document et ses ancres, calculées une fois par vue. */
interface Reader {
  doc: ConfigDocument;
  sites: Sites;
  /** Nom du preset du fichier porté par chaque ancre (`&ollama` → `ollama`). */
  presetByAnchor: Map<string, string>;
}

function keyName(pair: Pair): string | undefined {
  return isScalar(pair.key) ? String(pair.key.value) : undefined;
}

/** Texte d'un scalaire ou d'un alias vers un scalaire ; `undefined` pour tout autre nœud ou une valeur nulle. */
function textOf(reader: Reader, node: unknown): string | undefined {
  const target = isAlias(node) ? node.resolve(reader.doc.doc) : node;
  if (!isScalar(target) || target.value === null || target.value === undefined) return undefined;
  return String(target.value);
}

function linkOf(reader: Reader, node: unknown, ownPath: string): LinkView | undefined {
  const anchor = isAlias(node) ? node.source : isNode(node) ? node.anchor : undefined;
  if (!anchor) return undefined;
  const site = reader.sites.get(anchor);
  const places = [site?.definedAt, ...(site?.aliases ?? [])];
  return { anchor, sharedWith: places.filter((p): p is string => p !== undefined && p !== ownPath) };
}

function stringList(reader: Reader, node: unknown): string[] | undefined {
  const target = isAlias(node) ? node.resolve(reader.doc.doc) : node;
  if (!isSeq(target)) return undefined;
  return target.items.map((item) => textOf(reader, item) ?? "");
}

interface EnvReading {
  vars: EnvVarView[];
  /** Ancres fusionnées par `<<` (alias direct ou liste d'alias). */
  merged: string[];
  multiMerge: boolean;
  readOnly?: string;
}

function readEnv(reader: Reader, envNode: unknown, pathPrefix: string): EnvReading {
  const reading: EnvReading = { vars: [], merged: [], multiMerge: false };
  if (envNode === undefined || (isScalar(envNode) && envNode.value === null)) return reading;
  if (!isMap(envNode)) {
    reading.readOnly = "Env is not a table of variables.";
    return reading;
  }
  for (const pair of envNode.items) {
    if (isMergePair(pair)) {
      if (isAlias(pair.value)) {
        reading.merged.push(pair.value.source);
      } else if (isSeq(pair.value)) {
        reading.multiMerge = true;
        for (const item of pair.value.items) if (isAlias(item)) reading.merged.push(item.source);
      } else {
        reading.readOnly = "Env merges something other than a preset.";
      }
      continue;
    }
    const name = keyName(pair);
    const value = textOf(reader, pair.value);
    if (name === undefined || value === undefined) {
      reading.readOnly = `Variable ${name ?? "(unnamed)"} is not a text value.`;
      continue;
    }
    const linked = linkOf(reader, pair.value, `${pathPrefix}.${name}`);
    reading.vars.push(linked ? { name, value, linked } : { name, value });
  }
  if (reading.multiMerge || reading.merged.length > 1) {
    reading.readOnly ??= "Env merges several presets; edit the file directly.";
  }
  return reading;
}

function readOptions(reader: Reader, node: unknown): { choice: OptionsChoice; readOnly?: string; preset?: string } {
  if (node === undefined || (isScalar(node) && node.value === null)) return { choice: { kind: "none" } };
  const values = stringList(reader, node);
  if (!values) return { choice: { kind: "none" }, readOnly: "Options is not a list." };
  if (isAlias(node)) {
    const name = reader.presetByAnchor.get(node.source);
    return name
      ? { choice: { kind: "preset", name, values }, preset: name }
      : { choice: { kind: "custom", values } };
  }
  return { choice: values.length === 0 ? { kind: "none" } : { kind: "custom", values } };
}

interface EngineReading {
  view: EngineView;
  /** Presets du fichier utilisés par cet engine, pour « Used by ». */
  presets: string[];
}

function readEngine(reader: Reader, agentKey: string, name: string, node: unknown): EngineReading {
  const base = { name, isDefault: name === "default", command: commandLine(agentKey, name) };
  if (!isMap(node)) {
    const view: EngineView = {
      ...base,
      harness: "",
      provider: { kind: "none" },
      options: { kind: "none" },
      env: [],
      readOnly: "This engine is not a table of settings.",
    };
    return { view, presets: [] };
  }
  const path = `agents.${agentKey}.engines.${name}`;
  const harness = textOf(reader, node.get("harness", true)) ?? "";
  const modelNode = node.get("model", true);
  const model = textOf(reader, modelNode);
  const modelLinked = model === undefined ? undefined : linkOf(reader, modelNode, `${path}.model`);
  const env = readEnv(reader, node.get("env", true), `${path}.env`);
  const options = readOptions(reader, node.get("options", true));

  const mergedNames = env.merged.map((anchor) => reader.presetByAnchor.get(anchor));
  const single = env.merged.length === 1 && !env.multiMerge ? mergedNames[0] : undefined;
  let provider: ProviderChoice;
  if (harness !== "claude") {
    provider = { kind: "none" };
  } else if (env.merged.length === 0) {
    provider = env.vars.some((v) => v.name === "ANTHROPIC_BASE_URL") ? { kind: "custom" } : { kind: "anthropic" };
  } else {
    provider = single ? { kind: "preset", name: single } : { kind: "custom" };
  }

  const view: EngineView = { ...base, harness, provider, options: options.choice, env: env.vars };
  if (model !== undefined) view.model = model;
  if (modelLinked) view.modelLinked = modelLinked;
  if (single) view.mergedPreset = single;
  const readOnly = env.readOnly ?? options.readOnly;
  if (readOnly) view.readOnly = readOnly;
  const presets = [...mergedNames, options.preset].filter((p): p is string => p !== undefined);
  return { view, presets };
}

function readAgents(reader: Reader, usage: Map<string, string[]>): AgentView[] {
  const agents: AgentView[] = [];
  for (const pair of reader.doc.agentsMap()?.items ?? []) {
    const key = keyName(pair);
    if (key === undefined) continue;
    const agent: AgentView = { key, engines: [] };
    if (isMap(pair.value)) {
      for (const field of ["label", "info", "avatar"] as const) {
        const text = textOf(reader, pair.value.get(field, true));
        if (text !== undefined) agent[field] = text;
      }
      const engines = pair.value.get("engines", true);
      for (const enginePair of isMap(engines) ? engines.items : []) {
        const engineName = keyName(enginePair);
        if (engineName === undefined) continue;
        const reading = readEngine(reader, key, engineName, enginePair.value);
        agent.engines.push(reading.view);
        for (const preset of new Set(reading.presets)) {
          usage.set(preset, [...(usage.get(preset) ?? []), reading.view.command]);
        }
      }
    }
    agents.push(agent);
  }
  return agents;
}

/** Un preset rangé par sa forme : table de textes → provider, liste de textes → option set, le reste à part. */
function readPreset(
  reader: Reader,
  name: string,
  node: unknown,
  flags: { builtIn: boolean; inFile: boolean },
  usedBy: string[],
): PresetView {
  const view: PresetView = {
    name,
    kind: "other",
    builtIn: flags.builtIn,
    inFile: flags.inFile,
    vars: [],
    options: [],
    usedBy,
  };
  if (isMap(node) && node.items.every((pair) => !isMergePair(pair) && textOf(reader, pair.value) !== undefined)) {
    view.kind = "provider";
    view.vars = readEnv(reader, node, `presets.${name}`).vars;
  } else if (isSeq(node) && node.items.every((item) => textOf(reader, item) !== undefined)) {
    view.kind = "options";
    view.options = stringList(reader, node) ?? [];
  }
  return view;
}

/** Le gabarit lu une fois : source des valeurs des built-ins qui ne sont pas encore dans le fichier. */
let builtinTemplate: YAMLMap | undefined;
function builtinNode(name: string): unknown {
  builtinTemplate ??= parseDocument(NEW_FILE_TEMPLATE, { merge: true }).get("presets", true) as YAMLMap;
  return builtinTemplate.get(name, true);
}

function readPresets(reader: Reader, usage: Map<string, string[]>): PresetView[] {
  const presets: PresetView[] = [];
  // Noms de built-ins déjà présents dans le fichier : par la clé du preset ou par son ancre, car ce sont
  // les alias qui font l'identité (`local: &ollama` est le built-in `ollama`, sous un autre nom de clé).
  const covered = new Set<string>();
  for (const pair of reader.doc.presetsMap()?.items ?? []) {
    const name = keyName(pair);
    if (name === undefined) continue;
    const anchor = isNode(pair.value) ? pair.value.anchor : undefined;
    const builtIns = [name, anchor].filter((n): n is string => n !== undefined && isBuiltinPreset(n));
    for (const builtIn of builtIns) covered.add(builtIn);
    const flags = { builtIn: builtIns.length > 0, inFile: true };
    presets.push(readPreset(reader, name, pair.value, flags, usage.get(name) ?? []));
  }
  // Un built-in absent du fichier reste proposé ; il n'est écrit qu'à son premier usage.
  for (const name of BUILTIN_PRESET_NAMES) {
    if (!covered.has(name)) {
      presets.push(readPreset(reader, name, builtinNode(name), { builtIn: true, inFile: false }, []));
    }
  }
  return presets;
}

/** Vue du fichier pour la page. `issues` reste vide ici : la validation s'ajoute à la tâche 6. */
export function buildView(doc: ConfigDocument, path: string, dirty: boolean): ConfigView {
  const view: ConfigView = { path, isNew: doc.isNew, dirty, agents: [], presets: [], issues: [] };
  if (doc.parseError) {
    view.parseError = doc.parseError;
    return view;
  }
  const presetByAnchor = new Map<string, string>();
  for (const pair of doc.presetsMap()?.items ?? []) {
    const name = keyName(pair);
    if (name !== undefined && isNode(pair.value) && pair.value.anchor) presetByAnchor.set(pair.value.anchor, name);
  }
  const reader: Reader = { doc, sites: doc.anchorSites(), presetByAnchor };
  const usage = new Map<string, string[]>();
  view.agents = readAgents(reader, usage);
  view.presets = readPresets(reader, usage);
  return view;
}
