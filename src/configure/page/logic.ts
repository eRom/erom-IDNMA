/**
 * Les parties pures de la page, sans DOM : ce que `app.ts` décide à partir de valeurs déjà lues
 * (jeton de l'adresse, valeur d'un champ, formulaire de création, liste d'options). `app.ts` les appelle ;
 * `tests/configure-page-logic.test.ts` les vérifie sans navigateur.
 */
import type { Harness } from "../../config/network.ts";
import type { ConfigView, EditOp } from "../types.ts";

type Dataset = Readonly<Record<string, string | undefined>>;

// --- Jeton ----------------------------------------------------------------------------------------

export const TOKEN_KEY = "idnma-configure-token";

export interface LocationLike {
  search: string;
  pathname: string;
  hash: string;
}
export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | null): void;
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Le jeton arrive dans l'adresse (`?token=`), passe en `sessionStorage` pour survivre à un rechargement, puis
 * quitte la barre d'adresse (historique, copier-coller). Les autres paramètres et le `#` restent.
 */
export function readToken(location: LocationLike, history: HistoryLike, storage: StorageLike): string | undefined {
  const params = new URLSearchParams(location.search);
  const given = params.get("token");
  if (given) {
    storage.setItem(TOKEN_KEY, given);
    params.delete("token");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
    return given;
  }
  return storage.getItem(TOKEN_KEY) ?? undefined;
}

// --- Renommages et focus --------------------------------------------------------------------------

/** Un préfixe d'identifiant de focus qui en devient un autre quand une clé ou un nom change. */
export type Remap = readonly [from: string, to: string];

export function remapId(remaps: readonly Remap[], id: string): string {
  for (const [from, to] of remaps) if (id.startsWith(from)) return to + id.slice(from.length);
  return id;
}

export interface RenameEffect {
  remaps: Remap[];
  /** La sélection de la barre latérale suit le renommage de l'élément qui la porte. */
  selected?: { from: string; to: string };
}

/** Ce qu'une opération acceptée change dans les identifiants de focus et dans la sélection. */
export function renameEffect(op: EditOp): RenameEffect {
  switch (op.op) {
    case "renameAgent":
      return { remaps: [[`agent:${op.key}:`, `agent:${op.newKey}:`]], selected: { from: op.key, to: op.newKey } };
    case "renameEngine":
      return { remaps: [[`agent:${op.agent}:engine:${op.engine}:`, `agent:${op.agent}:engine:${op.newName}:`]] };
    case "setEnvVar":
      return op.previousName === undefined
        ? { remaps: [] }
        : { remaps: [[`agent:${op.agent}:engine:${op.engine}:env:${op.previousName}:`, `agent:${op.agent}:engine:${op.engine}:env:${op.name}:`]] };
    case "setPresetVar":
      return op.previousName === undefined
        ? { remaps: [] }
        : { remaps: [[`preset:${op.name}:var:${op.previousName}:`, `preset:${op.name}:var:${op.varName}:`]] };
    case "renamePreset":
      return { remaps: [[`preset:${op.name}:`, `preset:${op.newName}:`]], selected: { from: op.name, to: op.newName } };
    default:
      return { remaps: [] };
  }
}

// --- Champs ---------------------------------------------------------------------------------------

export interface FieldInput {
  /** Les `data-*` du champ (`dataset`). */
  dataset: Dataset;
  value: string;
  /** Une paire nom/valeur : la valeur actuelle du champ voisin. */
  sibling?: string;
  /** Un jeton d'options : les `data-*` de son groupe et les valeurs de tous les jetons, dans l'ordre (vides compris). */
  group?: { dataset: Dataset; values: string[] };
}

const text = (value: string | undefined): string => value ?? "";

/** L'opération d'un champ qui vient de changer, ou rien (valeur identique, champ sans action). */
export function opForField(field: FieldInput): EditOp | undefined {
  const d = field.dataset;
  const value = field.value;
  const trimmed = value.trim();
  const agent = text(d.agent);
  const engine = text(d.engine);
  const preset = text(d.preset);
  switch (d.action) {
    case "setAgentField":
      return { op: "setAgentField", key: agent, field: d.field === "avatar" ? "avatar" : "label", value: trimmed === "" ? null : trimmed };
    case "renameAgent":
      return trimmed === agent ? undefined : { op: "renameAgent", key: agent, newKey: trimmed };
    case "renameEngine":
      return trimmed === engine ? undefined : { op: "renameEngine", agent, engine, newName: trimmed };
    case "setHarness":
      return { op: "setHarness", agent, engine, harness: value as Harness };
    case "setModel":
      return { op: "setModel", agent, engine, value: trimmed === "" ? null : trimmed };
    case "renamePreset":
      return trimmed === preset ? undefined : { op: "renamePreset", name: preset, newName: trimmed };
    case "setEnvVar":
    case "setPresetVar": {
      // Une paire est deux champs : renommer garde la valeur du voisin, éditer la valeur garde le nom.
      const renaming = d.field === "name";
      if (renaming && trimmed === d.name) return undefined;
      const name = renaming ? trimmed : text(d.name);
      const content = renaming ? text(field.sibling) : value;
      const previousName = renaming ? { previousName: text(d.name) } : {};
      return d.action === "setEnvVar"
        ? { op: "setEnvVar", agent, engine, name, value: content, ...previousName }
        : { op: "setPresetVar", name: preset, varName: name, value: content, ...previousName };
    }
    case "setOptions":
    case "setPresetOptions": {
      if (!field.group) return undefined;
      // Les jetons non vides du groupe, dans l'ordre : vider un jeton le retire, le dernier (vide) en ajoute un.
      const values = field.group.values.map((v) => v.trim()).filter((v) => v !== "");
      return d.action === "setPresetOptions"
        ? { op: "setPresetOptions", name: text(field.group.dataset.preset), values }
        : { op: "setOptions", agent: text(field.group.dataset.agent), engine: text(field.group.dataset.engine), options: { kind: "custom", values } };
    }
    default:
      return undefined;
  }
}

// --- Création -------------------------------------------------------------------------------------

export interface AddInput {
  /** `data-add` du formulaire : l'action de création. */
  add: string;
  /** Les `data-*` du formulaire (`agent`, `engine`, `preset`, `kind`). */
  dataset: Dataset;
  /** Les champs, sans espaces de bord : `key`, `label`, `name`, `harness`, `option`. */
  values: Readonly<Record<string, string>>;
}

export type AddResult =
  | {
      ok: true;
      /** Dans l'ordre : chacune part après le succès de la précédente. */
      ops: EditOp[];
      /** L'agent ou le preset à sélectionner. */
      select?: string;
      /** Le champ qui prend le focus une fois la vue rendue. */
      focus?: string;
    }
  | {
      ok: false;
      message: string;
      /** Le champ du formulaire qui porte le message. */
      field: string;
      /** Un champ existant à montrer à la place (une variable qui existe déjà). */
      focus?: string;
    };

/** Le champ qui porte le nom, et ce qu'on y demande, pour chaque action de création. */
function primaryField(add: string): { id: string; empty: string } {
  if (add === "addAgent") return { id: "add:key", empty: "Enter a name." };
  if (add === "addOption") return { id: "add:option", empty: "Enter an option." };
  return { id: "add:name", empty: "Enter a name." };
}

/** Du formulaire de création aux opérations à envoyer, ou au message à montrer sous son champ. */
export function addOps(input: AddInput, view: ConfigView | undefined): AddResult {
  const d = input.dataset;
  const agent = text(d.agent);
  const engine = text(d.engine);
  const preset = text(d.preset);
  const value = (field: string): string => input.values[field] ?? "";
  const primary = primaryField(input.add);
  const name = value(input.add === "addAgent" ? "key" : input.add === "addOption" ? "option" : "name");
  if (name === "") return { ok: false, message: primary.empty, field: primary.id };

  switch (input.add) {
    case "addAgent": {
      // Un agent sans engine ne se lance pas : le formulaire crée aussi son engine `default`.
      const label = value("label") || name;
      return {
        ok: true,
        ops: [
          { op: "addAgent", key: name, label },
          { op: "addEngine", agent: name, name: "default", harness: (value("harness") || "claude") as Harness },
        ],
        select: name,
        focus: `agent:${name}:engine:default:model`,
      };
    }
    case "addEngine":
      return {
        ok: true,
        ops: [{ op: "addEngine", agent, name, harness: (value("harness") || "claude") as Harness }],
        focus: `agent:${agent}:engine:${name}:harness`,
      };
    case "addPreset":
      return { ok: true, ops: [{ op: "addPreset", name, kind: d.kind === "options" ? "options" : "provider" }], select: name };
    case "addEnvVar": {
      const existing = view?.agents.find((a) => a.key === agent)?.engines.find((e) => e.name === engine)?.env.some((v) => v.name === name);
      const where = `agent:${agent}:engine:${engine}:env:${name}:value`;
      if (existing) return { ok: false, message: `Variable ${name} already exists.`, field: primary.id, focus: where };
      return { ok: true, ops: [{ op: "setEnvVar", agent, engine, name, value: "", create: true }], focus: where };
    }
    case "addPresetVar": {
      const existing = view?.presets.find((p) => p.name === preset)?.vars.some((v) => v.name === name);
      const where = `preset:${preset}:var:${name}:value`;
      if (existing) return { ok: false, message: `Variable ${name} already exists.`, field: primary.id, focus: where };
      return { ok: true, ops: [{ op: "setPresetVar", name: preset, varName: name, value: "", create: true }], focus: where };
    }
    case "addOption": {
      const values = [...(view?.presets.find((p) => p.name === preset)?.options ?? []), name];
      return { ok: true, ops: [{ op: "setPresetOptions", name: preset, values }], focus: `preset:${preset}:option:${values.length - 1}` };
    }
    default:
      return { ok: false, message: "Unknown creation.", field: primary.id };
  }
}

// --- Options d'un option set ----------------------------------------------------------------------

/** Retire l'option d'indice `index`, ou la déplace d'un cran (`dir` < 0 vers le haut) ; `undefined` si c'est impossible. */
export function reorderOptions(
  options: readonly string[],
  action: "removeOption" | "moveOption",
  index: number,
  dir = 1,
): { values: string[]; target: number } | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= options.length) return undefined;
  const values = [...options];
  if (action === "removeOption") {
    values.splice(index, 1);
    return { values, target: index };
  }
  const target = index + (dir < 0 ? -1 : 1);
  if (target < 0 || target >= options.length) return undefined;
  const [moved] = values.splice(index, 1);
  if (moved === undefined) return undefined;
  values.splice(target, 0, moved);
  return { values, target };
}
