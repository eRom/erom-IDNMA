import { isAlias, isMap, isNode, isScalar, isSeq, type Pair, type Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import type { z } from "zod";
import { type EngineIssueCode, engineIssues } from "../config/engine-rules.ts";
import { EngineSchema } from "../config/network.ts";
import { commandLine } from "./command.ts";
import type { ConfigDocument } from "./document.ts";
import { ENV_NAME_PATTERN, isMergePair, presetShape, textValue } from "./nodes.ts";
import type { IssueView } from "./types.ts";

/** Forme d'une clé d'agent ou d'engine : elle se tape en argument de `idnma run`, donc pas de tiret en tête. */
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

type Where = Partial<Pick<IssueView, "agent" | "engine" | "preset" | "field" | "fix">>;

/** État d'une validation : le document, les issues, et les scalaires non textuels déjà signalés. */
interface Context {
  config: ConfigDocument;
  issues: IssueView[];
  /** Scalaires signalés `not-text`, par identité : l'erreur de schéma que leur valeur provoque ne se répète pas. */
  flagged: Set<unknown>;
  /** Engines déjà parcourus (un engine partagé par alias n'est signalé qu'à sa définition). */
  swept: Set<unknown>;
}

function keyText(pair: Pair): string | undefined {
  return isScalar(pair.key) ? String(pair.key.value) : undefined;
}

function resolveAlias(ctx: Context, node: unknown): unknown {
  return isAlias(node) ? node.resolve(ctx.config.doc) : node;
}

function report(ctx: Context, severity: IssueView["severity"], code: string, message: string, where: Where): void {
  ctx.issues.push({ severity, code, message, ...where });
}

/** Un scalaire qui n'est pas du texte : nombre, booléen ou valeur vide. */
function isNonText(node: unknown): node is Scalar {
  return isScalar(node) && typeof node.value !== "string";
}

/**
 * Signale un scalaire non textuel là où il se corrige. `field` désigne la ligne de la page :
 * `env.<NOM>` pour une variable, `options.<indice>` pour un élément de liste d'options.
 * Une valeur vide dans un preset est l'affaire de `preset-shape`, pas de `not-text`.
 */
function checkText(ctx: Context, node: unknown, where: Where): void {
  if (!isNonText(node)) return;
  if (node.value === null && where.preset !== undefined) return;
  ctx.flagged.add(node);
  const kind = node.value === null ? "No value." : typeof node.value === "boolean" ? "A boolean." : "A number.";
  // Le texte tel qu'il est écrit dans le fichier (`3.80` reste `3.80`), qui est aussi ce que « Quote it » écrit.
  const written = node.source ?? (node.value === null ? "" : String(node.value));
  report(ctx, "error", "not-text", `${kind} Values must be text: write it as "${written}".`, { ...where, fix: "quote" });
}

/** Contrôles d'une paire de table d'env ou de preset : forme du nom, puis texte de la valeur. */
function checkVariable(ctx: Context, pair: Pair, where: Where): void {
  const name = keyText(pair);
  if (name === undefined) return;
  const located = { ...where, field: `env.${name}` };
  if (!ENV_NAME_PATTERN.test(name)) report(ctx, "error", "env-name-form", "Not a valid variable name.", located);
  checkText(ctx, pair.value, located);
}

function checkOptionItems(ctx: Context, seq: YAMLSeq, where: Where): void {
  seq.items.forEach((item, index) => checkText(ctx, item, { ...where, field: `options.${index}` }));
}

function checkKeyForm(ctx: Context, key: string, where: Where): void {
  if (!KEY_PATTERN.test(key) || key.startsWith("-")) {
    report(ctx, "error", "key-form", "Use letters, digits, dot, dash or underscore, without a leading dash.", where);
  }
}

// --- Presets -----------------------------------------------------------------------------------

function checkPresets(ctx: Context): void {
  for (const pair of ctx.config.presetsMap()?.items ?? []) {
    const name = keyText(pair);
    if (name === undefined) continue;
    const where: Where = { preset: name };
    if (presetShape(ctx.config.doc, pair.value) === "other") {
      report(ctx, "warning", "preset-shape", "Neither a provider nor an option set.", where);
    }
    if (isMap(pair.value)) {
      for (const item of pair.value.items) if (!isMergePair(item)) checkVariable(ctx, item, where);
    } else if (isSeq(pair.value)) {
      checkOptionItems(ctx, pair.value, where);
    }
  }
}

// --- Agents et engines -------------------------------------------------------------------------

function checkAgents(ctx: Context): void {
  const labels = new Map<string, string[]>();
  for (const pair of ctx.config.agentsMap()?.items ?? []) {
    const key = keyText(pair);
    if (key === undefined) continue;
    const where: Where = { agent: key };
    checkKeyForm(ctx, key, where);

    const agent = resolveAlias(ctx, pair.value);
    const label = isMap(agent) ? textValue(ctx.config.doc, agent.get("label", true))?.trim() : undefined;
    if (!label) {
      report(ctx, "error", "label-missing", "Label is required.", { ...where, field: "label" });
    } else {
      labels.set(label, [...(labels.get(label) ?? []), key]);
    }

    const engines = isMap(agent) ? resolveAlias(ctx, agent.get("engines", true)) : undefined;
    if (!isMap(engines) || engines.items.length === 0) {
      report(ctx, "error", "no-engine", "Add at least one engine.", where);
      continue;
    }
    let hasDefault = false;
    for (const enginePair of engines.items) {
      const name = keyText(enginePair);
      if (name === undefined) continue;
      if (name === "default") hasDefault = true;
      checkKeyForm(ctx, name, { ...where, engine: name });
      checkEngine(ctx, key, name, enginePair.value);
    }
    if (!hasDefault) {
      report(ctx, "error", "no-default-engine", `No default engine: ${commandLine(key, "default")} would fail.`, where);
    }
  }

  for (const keys of labels.values()) {
    if (keys.length < 2) continue;
    for (const key of keys) {
      const others = keys.filter((other) => other !== key).join(", ");
      report(ctx, "warning", "label-duplicate", `Same label as ${others}.`, { agent: key, field: "label" });
    }
  }
}

/** Variables et options textuelles propres à un engine ; les valeurs fusionnées d'un preset sont vues au preset. */
function sweepEngine(ctx: Context, engine: YAMLMap, where: Where): void {
  const env = engine.get("env", true);
  if (isMap(env)) for (const pair of env.items) if (!isMergePair(pair)) checkVariable(ctx, pair, where);
  const options = engine.get("options", true);
  if (isSeq(options)) checkOptionItems(ctx, options, where);
}

/** Le nœud qui donne sa valeur à la variable `name` de l'env : la valeur propre, sinon la première fusionnée. */
function envValueNode(ctx: Context, env: YAMLMap, name: string): unknown {
  const own = env.items.find((pair) => !isMergePair(pair) && keyText(pair) === name);
  if (own) return own.value;
  for (const pair of env.items) {
    if (!isMergePair(pair)) continue;
    const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
    for (const source of sources) {
      const merged = resolveAlias(ctx, source);
      const found = isMap(merged) ? envValueNode(ctx, merged, name) : undefined;
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Vrai si l'erreur de type porte sur une valeur d'env ou d'options que `not-text` a déjà signalée.
 * Une valeur liée par alias (`B: *n`) se compare à son nœud ancré : c'est lui qui a été signalé, une fois.
 */
function alreadyReported(ctx: Context, engine: unknown, path: PropertyKey[]): boolean {
  if (!isMap(engine) || path.length !== 2) return false;
  const [section, name] = path;
  if (section === "env") {
    const env = resolveAlias(ctx, engine.get("env", true));
    return isMap(env) && ctx.flagged.has(resolveAlias(ctx, envValueNode(ctx, env, String(name))));
  }
  if (section === "options") {
    const options = resolveAlias(ctx, engine.get("options", true));
    return isSeq(options) && ctx.flagged.has(resolveAlias(ctx, options.items[Number(name)]));
  }
  return false;
}

function expectedText(expected: string): string {
  if (expected === "string") return "Must be text.";
  if (expected === "array") return "Must be a list.";
  if (expected === "object" || expected === "record") return "Must be a table.";
  return "Invalid value.";
}

function reportSchemaIssue(ctx: Context, issue: z.core.$ZodIssue, engine: unknown, where: Where): void {
  const field = issue.path.length > 0 ? issue.path.join(".") : undefined;
  const at = field === undefined ? where : { ...where, field };
  switch (issue.code) {
    case "unrecognized_keys":
      for (const key of issue.keys) report(ctx, "error", "schema", `Unknown key "${key}".`, { ...where, field: key });
      return;
    case "invalid_value":
      report(ctx, "error", "schema", issue.path[0] === "harness" ? `Harness must be one of ${issue.values.map(String).join(", ")}.` : "Invalid value.", at);
      return;
    case "invalid_type":
      if (alreadyReported(ctx, engine, issue.path)) return;
      report(ctx, "error", "schema", expectedText(issue.expected), at);
      return;
    default:
      report(ctx, "error", "schema", "Invalid value.", at);
  }
}

/**
 * Un engine : règles de l'app sur ses nœuds d'abord, puis le schéma de `idnma run` sur son JavaScript résolu
 * (fusions et alias compris, engine par engine), puis ses contrôles d'engine. Un engine qui échoue au schéma
 * n'a pas de contrôles d'engine : ils lisent un engine valide.
 */
function checkEngine(ctx: Context, agent: string, name: string, rawNode: unknown): void {
  const where: Where = { agent, engine: name };
  const node = resolveAlias(ctx, rawNode);
  if (isMap(node) && !ctx.swept.has(node)) {
    ctx.swept.add(node);
    sweepEngine(ctx, node, where);
  }

  let resolved: unknown;
  try {
    resolved = isNode(node) ? node.toJS(ctx.config.doc) : node;
  } catch (error) {
    report(ctx, "error", "schema", error instanceof Error ? (error.message.split("\n")[0] ?? "Invalid value.") : "Invalid value.", where);
    return;
  }
  const parsed = EngineSchema.safeParse(resolved);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) reportSchemaIssue(ctx, issue, node, where);
    return;
  }

  const source = `.idnma.yml (agents.${agent}.engines.${name})`;
  for (const found of engineIssues(parsed.data, source)) {
    report(ctx, "error", found.code, engineMessage(found.code, found.token), { ...where, field: found.field });
  }
}

/** Message d'interface d'un contrôle d'engine ; le message français de `runAgent` reste celui de la CLI. */
function engineMessage(code: EngineIssueCode, token: string | undefined): string {
  switch (code) {
    case "codex-embedded-flag":
      return `${token} starts Codex outside its shared server: idnma could not deliver bus messages.`;
    case "opencode-refused-flag":
      return `${token} starts opencode outside its shared service: idnma could not deliver bus messages.`;
    case "opencode-session-form":
      return 'An opencode session id starts with "ses".';
    case "opencode-model-form":
      return "The model must read <provider>/<model>.";
    case "dst-model":
      return "dst takes no model at launch: pick it with /model inside dst.";
    case "dst-refused-flag":
      return "This option has no place in a bus pane for dst.";
    case "pi-refused-flag":
      return "This option takes pi out of its terminal UI: idnma could not deliver bus messages.";
  }
}

/**
 * Tous les problèmes du document, chacun là où il se corrige. Une faute donne une issue. Un fichier qui
 * ne se lit pas n'en donne aucune : la vue montre déjà son erreur de syntaxe.
 */
export function collectIssues(config: ConfigDocument): IssueView[] {
  if (config.parseError) return [];
  const ctx: Context = { config, issues: [], flagged: new Set(), swept: new Set() };
  checkPresets(ctx);
  checkAgents(ctx);
  return ctx.issues;
}
