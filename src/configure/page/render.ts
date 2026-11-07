/**
 * Rendu de la page `idnma configure` : une fonction pure `ConfigView` + `UiState` -> chaîne HTML.
 * Aucun DOM, aucun `document`, aucun `window` ; toute valeur venue de la vue passe par `escapeHtml`,
 * attributs compris. Aucun style en ligne : la mise en forme est la feuille `styles.css` (tâche 11).
 *
 * CONTRAT DES ATTRIBUTS (la tâche 11 s'appuie dessus, `app.ts` délègue les événements sur `document`)
 *
 * Chaque contrôle agissant porte `data-action`. Deux familles :
 *
 * 1. Nom d'un `EditOp` : la page envoie l'opération, les paramètres viennent des `data-*` :
 *    - `data-agent` (clé d'agent), `data-engine` (nom d'engine), `data-preset` (nom de preset),
 *      `data-name` (nom de variable courant), `data-field` (`label`|`avatar` pour `setAgentField`,
 *      `name`|`value` pour une variable : `name` renomme, avec `previousName` = `data-name`),
 *      `data-path` (tableau JSON de `unlink`, échappé), `data-index`, `data-dir` (-1 ou 1).
 *    - La valeur saisie est celle du contrôle (`value`) ; une valeur vide vaut `null` pour
 *      `setAgentField` et `setModel`.
 *    - `renameAgent` : champ Key, `data-agent` = clé courante. `renameEngine` : `data-agent`,
 *      `data-engine` = nom courant. `renamePreset` : `data-preset` = nom courant.
 *    - `setHarness` : `<select>`, la valeur est le harnais.
 *    - `setProvider` : item de menu ; `data-provider-kind` = `anthropic`|`preset`|`custom`, plus
 *      `data-preset` pour `preset`.
 *    - `setOptions` : item de menu ; `data-options-kind` = `none`|`preset`|`custom`, plus `data-preset`
 *      pour `preset`, et pour `custom` `data-values` = tableau JSON des valeurs à recopier (celles du
 *      preset quitté). Les jetons d'un engine sont des `<input data-action="setOptions">` regroupés dans
 *      `[data-options-list]` (même `data-agent` / `data-engine`) : à chaque changement, envoyer
 *      `{ kind: "custom", values }` avec les valeurs non vides de tous les jetons du groupe, dans l'ordre ;
 *      le dernier jeton, toujours vide, sert à en ajouter.
 *    - `setPresetOptions` : même principe pour un option set, `[data-options-list][data-preset]`.
 *    - `setPresetVar` / `deletePresetVar` : `data-preset`, `data-name`, `data-field`.
 *    - `setEnvVar` / `deleteEnvVar` : `data-agent`, `data-engine`, `data-name`, `data-field`.
 *    - `unlink` : `data-path`.
 *    - `addAgent`, `addEngine` (`data-agent`), `addPreset` (`data-kind` = `provider`|`options`) : boutons
 *      sans nom ni clé, la page doit les demander à l'utilisateur avant d'envoyer l'opération. La page
 *      pose `UiState.adding` (même action, mêmes `data-*`) : le bouton est alors remplacé par un
 *      `<form class="addrow" data-add="<action>" …>` dont les champs ont les ids `add:key|label|name|harness|option` ;
 *      son `submit` fournit les noms, `cancelAdd` (bouton Cancel) l'abandonne. Le formulaire d'agent a une clé, un label et un
 *      harnais ; la page envoie `addAgent` puis `addEngine` (`default`). Un fichier sans agent montre ce même formulaire
 *      comme écran d'accueil (`form.addrow.first`, son bouton `Add agent` est l'action primaire du panneau).
 *    - `duplicateAgent`, `deleteAgent`, `deleteEngine`, `makeDefault`, `removeMerge`, `deletePreset` :
 *      boutons, paramètres en `data-*`.
 *
 * 2. Action d'interface, sans `EditOp` direct :
 *    - `tab` : `data-tab` = `agents`|`providers`|`options`.
 *    - `select` : `data-key` = clé de l'agent ou nom du preset à afficher (l'onglet est celui d'`UiState`).
 *    - `groupBy` : bascule `UiState.groupBy` (`harness` ou absent) ; bouton `role="checkbox"` de la barre latérale,
 *      onglet Agents seulement. Regroupé, un agent figure sous chaque harnais qu'utilise l'un de ses engines.
 *    - `openAgent` : badge « Used by » ; `data-key` = clé de l'agent, `data-harness` = son harnais (la couleur du
 *      badge). Ouvre l'onglet Agents sur cet agent et amène sa rangée dans la vue.
 *    - `menu` : ouvre (ou ferme) le menu d'un engine ; `data-agent`, `data-engine`, `data-kind` =
 *      `provider`|`options`. Le menu ouvert est celui d'`UiState.menu`.
 *    - `copy` : `data-text` = le texte exact à copier (bouton Copy de la bande de commande d'un engine).
 *    - `save`, `revert`, `reload` : sans paramètre.
 *    - `quote` : bouton « Quote it », `data-path` = chemin de la valeur à passer en texte, à envoyer en
 *      `quoteValue`.
 *    - `addEnvVar` (`data-agent`, `data-engine`), `addPresetVar` (`data-preset`) : ajoutent une variable,
 *      le nom est à demander (ligne de saisie ci-dessus) puis envoyé en `setEnvVar` / `setPresetVar` avec `create: true`. Sans
 *      variable propre, l'engine n'affiche que ce bouton (section Env repliée).
 *    - `addOption` (ligne de saisie), `removeOption`, `moveOption` (`data-preset`, `data-index`, `data-dir`) :
 *      sur un option set ; calculer le nouveau tableau et envoyer `setPresetOptions`.
 *    - `cancelAdd` : abandonne la création en cours.
 *
 * Chaque `<input>`, `<select>` et bouton de menu porte `data-focus-id` (aussi son `id`) : identifiant
 * stable d'un rendu à l'autre tant que la clé de l'agent, le nom d'engine ou de variable ne change pas.
 * Formes : `agent:<clé>:label|key|avatar`, `agent:<clé>:engine:<nom>:name|harness|provider|options-menu|model`,
 * `agent:<clé>:engine:<nom>:env:<VAR>:name|value`, `agent:<clé>:engine:<nom>:options:<i>`,
 * `preset:<nom>:name`, `preset:<nom>:var:<VAR>:name|value`, `preset:<nom>:option:<i>`. Un champ qui
 * renomme (Key, nom d'engine, nom de variable) change donc son propre identifiant : la page remappe
 * `UiState.selected` et le focus après l'opération.
 */
import type { Harness } from "../../config/network.ts";
import type {
  AgentView,
  ConfigView,
  EngineView,
  EnvVarView,
  IssueView,
  LinkView,
  PresetView,
} from "../types.ts";

/** Une création en cours de saisie : le bouton `+ Add …` correspondant est remplacé par une ligne de saisie. */
export interface AddingState {
  action: "addAgent" | "addEngine" | "addPreset" | "addEnvVar" | "addPresetVar" | "addOption";
  agent?: string;
  engine?: string;
  preset?: string;
  kind?: "provider" | "options";
}

export interface UiState {
  tab: "agents" | "providers" | "options";
  selected?: string;
  menu?: { agent: string; engine: string; kind: "harness" | "provider" | "options" };
  adding?: AddingState;
  /** Regroupement de la liste des agents ; en mémoire seulement (le port du serveur change à chaque lancement). */
  groupBy?: "harness";
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const esc = escapeHtml;

/** Les harnais proposés ; le type `Record` oblige à les lister tous quand `Harness` s'allonge. */
const HARNESS_TABLE: Record<Harness, true> = { claude: true, codex: true, grok: true, agy: true, opencode: true, dst: true, pi: true };

/**
 * L'unique ordre alphabétique de la page : sans casse ni accent, les nombres par valeur (« agent 2 » avant
 * « agent 10 »). Deux noms égaux pour la locale se départagent par point de code, le résultat est déterministe.
 */
export function compareNames(a: string, b: string): number {
  const byLocale = a.localeCompare(b, "en", { sensitivity: "base", numeric: true });
  if (byLocale !== 0) return byLocale;
  return a < b ? -1 : a > b ? 1 : 0;
}

const HARNESS_NAMES = Object.keys(HARNESS_TABLE).sort(compareNames);

type Path = (string | number)[];
type DataAttrs = Record<string, string | number | undefined>;

/** Attributs `data-*` échappés ; les clés sont des constantes du code, jamais des valeurs du fichier. */
function data(attrs: DataAttrs): string {
  let out = "";
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out += ` data-${key}="${esc(String(value))}"`;
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function initialOf(text: string): string {
  return (Array.from(text.trim())[0] ?? "?").toUpperCase();
}

// --- Champs ---------------------------------------------------------------------------------------

interface FieldOptions {
  id: string;
  value: string;
  /** Nom accessible quand aucun `<label>` n'est visible. */
  label?: string;
  attrs?: DataAttrs;
  mono?: boolean;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  invalid?: boolean;
  className?: string;
}

function inputHtml(o: FieldOptions): string {
  const classes = ["field", o.mono ? "mono" : "", o.invalid ? "invalid" : "", o.className ?? ""].filter(Boolean).join(" ");
  return (
    `<input class="${classes}" type="text" id="${esc(o.id)}" data-focus-id="${esc(o.id)}"${data(o.attrs ?? {})}` +
    (o.label ? ` aria-label="${esc(o.label)}"` : "") +
    (o.invalid ? ' aria-invalid="true"' : "") +
    (o.readonly ? " readonly" : "") +
    (o.disabled ? " disabled" : "") +
    (o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : "") +
    ` spellcheck="false" autocomplete="off" value="${esc(o.value)}">`
  );
}

/** `ariaLabel` donne un nom accessible distinct aux boutons répétés (Copy, Delete, + Add variable…). */
function buttonHtml(label: string, classes: string, attrs: DataAttrs, disabled = false, ariaLabel?: string): string {
  return `<button type="button" class="${classes}"${data(attrs)}${ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : ""}${disabled ? " disabled" : ""}>${esc(label)}</button>`;
}

/** Un `<select>` natif avec le même chevron que les déclencheurs de menu (le chevron n'intercepte pas le clic). */
function selectHtml(select: string): string {
  return `<span class="sel">${select}<span class="cv" aria-hidden="true">⌄</span></span>`;
}

// --- Création en cours ----------------------------------------------------------------------------

function sameAdding(current: AddingState | undefined, target: AddingState): boolean {
  return (
    current !== undefined &&
    current.action === target.action &&
    current.agent === target.agent &&
    current.engine === target.engine &&
    current.preset === target.preset &&
    current.kind === target.kind
  );
}

/** Ligne de saisie d'un nom (et de ce que l'opération exige en plus) ; `app.ts` l'envoie au `submit`. */
function addForm(target: AddingState, firstAgent = false): string {
  const text = (id: string, label: string, placeholder: string): string => inputHtml({ id: `add:${id}`, value: "", label, placeholder, mono: true });
  const harness = (): string => {
    // Triés, mais un nouvel agent (ou engine) part toujours sur claude.
    const options = HARNESS_NAMES.map((h) => `<option value="${h}"${h === "claude" ? " selected" : ""}>${h}</option>`).join("");
    return selectHtml(`<select class="pop" id="add:harness" data-focus-id="add:harness" aria-label="Harness">${options}</select>`);
  };
  let inputs: string;
  switch (target.action) {
    case "addAgent":
      inputs = text("key", "Agent key", "Key") + text("label", "Agent label", "Label") + harness();
      break;
    case "addEngine":
      inputs = text("name", "Engine name", "Engine name") + harness();
      break;
    case "addPreset":
      inputs = text("name", target.kind === "options" ? "Option set name" : "Provider name", "Name");
      break;
    case "addOption":
      inputs = text("option", "New option", "--flag");
      break;
    default:
      inputs = text("name", "Variable name", "NAME");
  }
  const attrs = data({ add: target.action, agent: target.agent, engine: target.engine, preset: target.preset, kind: target.kind });
  // Premier agent d'un fichier : le formulaire est la page, son bouton est l'action du panneau.
  if (firstAgent) return `<form class="addrow first"${attrs} novalidate>${inputs}<button type="submit" class="btn pri">Add agent</button></form>`;
  return `<form class="addrow"${attrs} novalidate>${inputs}<button type="submit" class="btn pill sm">Add</button>${buttonHtml("Cancel", "btn pill sm", { action: "cancelAdd" })}</form>`;
}

/** Le bouton de création, ou sa ligne de saisie quand c'est celle-là qui se remplit. */
function addControl(ui: UiState, target: AddingState, button: string): string {
  return sameAdding(ui.adding, target) ? addForm(target) : button;
}

// --- Problèmes ------------------------------------------------------------------------------------

interface Scope {
  agent?: string;
  engine?: string;
  preset?: string;
}

/** Les problèmes qui portent exactement ce rattachement (un problème d'agent n'est pas un problème d'engine). */
function issuesIn(issues: IssueView[], scope: Scope): IssueView[] {
  return issues.filter((i) => i.agent === scope.agent && i.engine === scope.engine && i.preset === scope.preset);
}

/** Retire de `list` les problèmes qui répondent au prédicat et les rend : ce qui reste est « général ». */
function take(list: IssueView[], predicate: (issue: IssueView) => boolean): IssueView[] {
  const taken = list.filter(predicate);
  for (const issue of taken) list.splice(list.indexOf(issue), 1);
  return taken;
}

const hasError = (issues: IssueView[]): boolean => issues.some((i) => i.severity === "error");

/** Chemin de la valeur à passer en texte pour un problème `fix: "quote"`, d'après la convention de `validate.ts`. */
function quotePath(issue: IssueView): Path | undefined {
  const field = issue.field;
  if (issue.fix !== "quote" || field === undefined) return undefined;
  const isPreset = issue.preset !== undefined;
  const base: Path | undefined = isPreset
    ? ["presets", issue.preset as string]
    : issue.agent !== undefined && issue.engine !== undefined
      ? ["agents", issue.agent, "engines", issue.engine]
      : undefined;
  if (!base) return undefined;
  if (field.startsWith("env.")) return isPreset ? [...base, field.slice(4)] : [...base, "env", field.slice(4)];
  if (field.startsWith("options.")) {
    const index = Number(field.slice(8));
    if (!Number.isInteger(index)) return undefined;
    return isPreset ? [...base, index] : [...base, "options", index];
  }
  return undefined;
}

function issuesHtml(issues: IssueView[]): string {
  return issues
    .map((issue) => {
      const path = quotePath(issue);
      const level = issue.severity === "error" ? "err" : "warn";
      const quote = path ? buttonHtml("Quote it", "btn pill sm", { action: "quote", path: JSON.stringify(path) }, false, `Quote it: ${issue.field ?? "value"}`) : "";
      return `<div class="issue ${level}" role="${level === "err" ? "alert" : "status"}"><i class="dot ${level}"></i><span>${esc(issue.message)}</span>${quote}</div>`;
    })
    .join("");
}

function dotHtml(label: string): string {
  return `<i class="dot err" role="img" aria-label="${esc(label)}"></i>`;
}

// --- Barre d'outils -------------------------------------------------------------------------------

function toolbar(view: ConfigView): string {
  const path = `<span class="path">${esc(view.displayPath)}</span>${view.isNew ? '<span class="tag">New file</span>' : ""}`;
  const head = `<span class="prod">idnma configure</span>${path}<span class="grow"></span>`;
  if (view.parseError) return `<header class="bar">${head}</header>`;

  const total = view.issues.length;
  let status: string;
  if (total === 0) status = `<i class="dot ok"></i>Valid · ${plural(view.agents.length, "agent")}`;
  else if (hasError(view.issues)) status = `<i class="dot err"></i>${plural(total, "issue")}`;
  else status = `<i class="dot warn"></i>${plural(total, "warning")}`;

  const dirty = view.dirty;
  return (
    `<header class="bar">${head}<span class="status" role="status">${status}</span>` +
    buttonHtml("Revert", "btn sec", { action: "revert" }, !view.canRevert) +
    `<button type="button" class="btn pri"${data({ action: "save" })}${dirty ? "" : " disabled"}>${view.isNew ? "Create" : "Save"} <span class="kt">⌘S</span></button>` +
    "</header>"
  );
}

// --- Barre latérale -------------------------------------------------------------------------------

const providerLike = (preset: PresetView): boolean => preset.kind !== "options";

/** Le nom affiché d'un agent : son label, à défaut sa clé. */
const displayName = (agent: AgentView): string => agent.label || agent.key;

/** Ordre de la liste des agents : le nom affiché, puis la clé pour départager deux noms égaux. */
const compareAgents = (a: AgentView, b: AgentView): number => compareNames(displayName(a), displayName(b)) || compareNames(a.key, b.key);

const byPresetName = (a: PresetView, b: PresetView): number => compareNames(a.name, b.name);

/** Une section de la liste des agents ; `header` est absent hors regroupement. */
interface AgentGroup {
  header?: string;
  agents: AgentView[];
}

/**
 * Les agents dans l'ordre où la barre latérale les montre. Regroupé par harnais, un agent figure sous chaque
 * harnais qu'utilise l'un de ses engines (un agent est un modèle : le groupe répond à « quels modèles lancer
 * avec ce harnais »). Un harnais vide s'intitule `(none)` ; les agents sans engine ferment la liste.
 */
function agentGroups(view: ConfigView, ui: UiState): AgentGroup[] {
  const sorted = [...view.agents].sort(compareAgents);
  if (ui.groupBy !== "harness") return [{ agents: sorted }];
  const byHarness = new Map<string, AgentView[]>();
  const noEngine: AgentView[] = [];
  for (const agent of sorted) {
    if (agent.engines.length === 0) noEngine.push(agent);
    for (const harness of new Set(agent.engines.map((e) => e.harness || "(none)"))) {
      byHarness.set(harness, [...(byHarness.get(harness) ?? []), agent]);
    }
  }
  const groups = [...byHarness.keys()].sort(compareNames).map((header) => ({ header, agents: byHarness.get(header) ?? [] }));
  return noEngine.length > 0 ? [...groups, { header: "No engine", agents: noEngine }] : groups;
}

/** Les clés sélectionnables de l'onglet, dans l'ordre affiché : la première est la sélection par défaut. */
export function shownKeys(view: ConfigView, ui: UiState): string[] {
  if (ui.tab === "agents") return agentGroups(view, ui).flatMap((g) => g.agents.map((a) => a.key));
  return presetsOf(view, ui.tab).map((p) => p.name);
}

function presetsOf(view: ConfigView, tab: "providers" | "options"): PresetView[] {
  return view.presets.filter((p) => (tab === "options" ? p.kind === "options" : providerLike(p))).sort(byPresetName);
}

/** Bascule « Group by harness » : un bouton (et non un `<input>`) pour que `app.ts` n'y voie pas un champ qui envoie une opération. */
function groupToggle(ui: UiState): string {
  const on = ui.groupBy === "harness";
  return `<button type="button" role="checkbox" aria-checked="${on}" class="grp"${data({ action: "groupBy" })}><span class="ckb" aria-hidden="true">${on ? "✓" : ""}</span>Group by harness</button>`;
}

function sidebar(view: ConfigView, ui: UiState, selected: string | undefined): string {
  const tabs: [UiState["tab"], string, number][] = [
    ["agents", "Agents", view.agents.length],
    ["providers", "Providers", presetsOf(view, "providers").length],
    ["options", "Options", presetsOf(view, "options").length],
  ];
  const seg = tabs
    .map(([tab, label, count]) => {
      const on = tab === ui.tab;
      return `<button type="button" role="tab" aria-selected="${on}" class="${on ? "on" : ""}"${data({ action: "tab", tab })}>${label} <i class="c">${count}</i></button>`;
    })
    .join("");

  let rows: string;
  let add: string;
  let toggle = "";
  if (ui.tab === "agents") {
    rows = agentGroups(view, ui)
      .map((group) => {
        const list = group.agents.map((agent) => agentRow(view, agent, agent.key === selected, group.header)).join("");
        return group.header === undefined ? list : `<div class="rowgroup" role="group" aria-label="${esc(group.header)}"><div class="gh">${esc(group.header)}</div>${list}</div>`;
      })
      .join("");
    toggle = groupToggle(ui);
    add = addControl(ui, { action: "addAgent" }, buttonHtml("+ Add agent", "row add", { action: "addAgent" }));
  } else {
    rows = presetsOf(view, ui.tab)
      .map((preset) => presetRow(view, preset, preset.name === selected))
      .join("");
    const kind = ui.tab === "providers" ? "provider" : "options";
    const label = kind === "provider" ? "+ Add provider" : "+ Add option set";
    add = addControl(ui, { action: "addPreset", kind }, buttonHtml(label, "row add", { action: "addPreset", kind }));
  }
  return `<nav class="side"><div class="seg" role="tablist">${seg}</div>${toggle}<div class="rows">${rows}</div>${add}</nav>`;
}

/**
 * `group` : le titre du groupe, présent en mode regroupé seulement. Il porte déjà le harnais, la rangée ne le
 * répète pas (le point d'erreur reste), et il est posé en `data-group` : un agent figure sous plusieurs groupes,
 * c'est ce qui distingue ses rangées pour retrouver le focus après un rendu.
 */
function agentRow(view: ConfigView, agent: AgentView, selected: boolean, group?: string): string {
  const lead = agent.engines.find((e) => e.isDefault) ?? agent.engines[0];
  const more = agent.engines.length - 1;
  const broken = hasError(view.issues.filter((i) => i.agent === agent.key));
  const name = displayName(agent);
  const meta = group !== undefined
    ? broken
      ? `<span class="meta">${dotHtml("Has errors")}</span>`
      : ""
    : `<span class="meta">${broken ? dotHtml("Has errors") : ""}${esc(lead?.harness ?? "")}${more > 0 ? ` <span class="more">+${more}</span>` : ""}</span>`;
  return (
    `<button type="button" class="row${selected ? " sel" : ""}"${selected ? ' aria-current="true"' : ""}${data({ action: "select", key: agent.key, group })}>` +
    `<span class="av">${esc(initialOf(name))}</span><span class="name">${esc(name)}</span>${meta}</button>`
  );
}

function presetRow(view: ConfigView, preset: PresetView, selected: boolean): string {
  const broken = hasError(view.issues.filter((i) => i.preset === preset.name));
  return (
    `<button type="button" class="row${selected ? " sel" : ""}"${selected ? ' aria-current="true"' : ""}${data({ action: "select", key: preset.name })}>` +
    `<span class="av sq">${esc(initialOf(preset.name))}</span><span class="name">${esc(preset.name)}</span>` +
    `<span class="bi">${broken ? dotHtml("Has errors") : ""}${preset.builtIn ? "Built-in" : ""}</span></button>`
  );
}

// --- Vue Agent ------------------------------------------------------------------------------------

function agentPane(view: ConfigView, ui: UiState, agent: AgentView): string {
  const key = agent.key;
  const general = issuesIn(view.issues, { agent: key });
  const labelIssues = take(general, (i) => i.field === "label");
  const name = agent.label || key;
  const identity = (id: string, caption: string, field: Omit<FieldOptions, "id">, issues: IssueView[] = []): string =>
    `<div class="fld"><label class="lbl" for="${esc(id)}">${caption}</label>${inputHtml({ ...field, id, invalid: hasError(issues) })}${issuesHtml(issues)}</div>`;

  const head =
    `<div class="head"><span class="av lg">${esc(initialOf(name))}</span><h2>${esc(name)}</h2>` +
    (agent.info ? `<span class="info">${esc(agent.info)}</span>` : "") +
    `<span class="acts">${buttonHtml("Duplicate", "btn pill sm", { action: "duplicateAgent", agent: key }, false, `Duplicate agent ${key}`)}${buttonHtml("Delete", "btn pill sm", { action: "deleteAgent", agent: key }, false, `Delete agent ${key}`)}</span></div>`;

  const ident =
    `<div class="ident">` +
    identity(`agent:${key}:label`, "Label", { value: agent.label ?? "", attrs: { action: "setAgentField", agent: key, field: "label" } }, labelIssues) +
    identity(`agent:${key}:key`, "Key", { value: key, mono: true, attrs: { action: "renameAgent", agent: key } }) +
    identity(`agent:${key}:avatar`, "Avatar", { value: agent.avatar ?? "", placeholder: "None", attrs: { action: "setAgentField", agent: key, field: "avatar" } }) +
    "</div>";

  const engines = agent.engines.map((engine) => engineBlock(view, ui, agent, engine)).join("");
  return (
    `<main class="main">${head}${ident}${issuesHtml(general)}` +
    `<div class="sect"><span>Engines</span>${addControl(ui, { action: "addEngine", agent: key }, buttonHtml("+ Add engine", "btn ghost sm", { action: "addEngine", agent: key }, false, `Add engine to ${key}`))}</div>` +
    `${engines}</main>`
  );
}

/** `idnma run <clé>` découpé pour la coloration : tout vient de la commande de la vue. */
function commandParts(engine: EngineView): { head: string; bin: string; key: string } {
  const flag = engine.command.indexOf(" --engine ");
  const head = flag === -1 ? engine.command : engine.command.slice(0, flag);
  const bin = "idnma run ";
  return head.startsWith(bin) ? { head, bin: bin.trim(), key: head.slice(bin.length) } : { head, bin: "", key: head };
}

function engineBlock(view: ConfigView, ui: UiState, agent: AgentView, engine: EngineView): string {
  const base = { agent: agent.key, engine: engine.name };
  const id = (field: string): string => `agent:${agent.key}:engine:${engine.name}:${field}`;
  const ro = engine.readOnly !== undefined;
  const claude = engine.harness === "claude";
  const issues = issuesIn(view.issues, { agent: agent.key, engine: engine.name });

  // Bande de commande : la commande est le titre de l'engine, son nom s'y modifie.
  const parts = commandParts(engine);
  const line =
    (parts.bin ? `<span class="bin">${esc(parts.bin)}</span>` : "") +
    `<span class="key">${esc(parts.key)}</span>` +
    (engine.isDefault
      ? ""
      : `<span class="fl">--engine</span>${inputHtml({ id: id("name"), value: engine.name, mono: true, label: `Name of engine ${engine.name}`, className: "ek", disabled: ro, attrs: { action: "renameEngine", ...base } })}`);
  const strip =
    `<div class="cmd"><span class="p">❯</span>${line}` +
    (engine.isDefault ? '<span class="def">default</span>' : '<span class="push"></span>') +
    (engine.isDefault ? "" : buttonHtml("Make default", "btn pill sm", { action: "makeDefault", ...base }, false, `Make ${engine.name} the default engine`)) +
    buttonHtml("Copy", "btn pill sm", { action: "copy", text: engine.command }, false, `Copy ${engine.command}`) +
    (engine.isDefault ? "" : buttonHtml("Delete", "btn pill sm", { action: "deleteEngine", ...base }, false, `Delete engine ${engine.name}`)) +
    "</div>";

  // Harnais : un `<select>` natif suffit (six valeurs fixes, rien à légender).
  const known = HARNESS_NAMES.includes(engine.harness);
  const harnessOptions =
    (known ? "" : `<option value="${esc(engine.harness)}" selected>${esc(engine.harness || "(none)")}</option>`) +
    HARNESS_NAMES.map((h) => `<option value="${h}"${h === engine.harness ? " selected" : ""}>${h}</option>`).join("");
  const harnessIssues = take(issues, (i) => i.field === "harness");
  const harness =
    `<span class="c"><label class="k" for="${esc(id("harness"))}">Harness</label>` +
    selectHtml(
      `<select class="pop${hasError(harnessIssues) ? " invalid" : ""}" id="${esc(id("harness"))}" data-focus-id="${esc(id("harness"))}" aria-label="Harness of engine ${esc(engine.name)}"${data({ action: "setHarness", ...base })}${ro ? " disabled" : ""}>${harnessOptions}</select>`,
    ) +
    "</span>";

  const provider = claude ? providerControl(view, ui, engine, base, id("provider"), ro) : "";
  const optionsIssues = take(issues, (i) => i.field === "options" || (i.field ?? "").startsWith("options."));
  const options = optionsControl(view, ui, engine, base, id, ro, optionsIssues);
  const dst = engine.harness === "dst" ? '<span class="c"><span class="k dim">Model is chosen inside dst with /model</span></span>' : "";
  const controls = `<div class="ctl">${harness}${provider}${dst}${options}</div>${issuesHtml(harnessIssues)}${issuesHtml(optionsIssues)}`;

  // Model : absent pour dst ; lié par ancre, il se montre en lecture seule avec son action Unlink.
  let model = "";
  if (engine.harness !== "dst") {
    const modelIssues = take(issues, (i) => i.field === "model");
    const place = engine.harness === "opencode" || engine.harness === "pi" ? "provider/model" : "Default";
    const field = inputHtml({
      id: id("model"),
      value: engine.model ?? "",
      mono: true,
      label: `Model of engine ${engine.name}`,
      placeholder: place,
      disabled: ro,
      readonly: engine.modelLinked !== undefined,
      invalid: hasError(modelIssues),
      attrs: { action: "setModel", ...base },
    });
    const link = engine.modelLinked ? linkHtml(engine.modelLinked, ["agents", agent.key, "engines", engine.name, "model"], `model of engine ${engine.name}`) : "";
    model = `<div class="mrow"><label class="k" for="${esc(id("model"))}">Model</label><div class="val">${field}${link}</div></div>${issuesHtml(modelIssues)}`;
  }

  const env = envControl(ui, engine, base, id, ro, issues, agent.key);
  const note = ro ? `<p class="hint">${esc(engine.readOnly ?? "")}</p>` : "";
  // Ce que ni un champ ni une commande n'a réclamé : problème de l'engine entier.
  return `<section class="eng" data-engine="${esc(engine.name)}">${strip}${issuesHtml(issues)}${note}${controls}${model}${env}</section>`;
}

/** `what` nomme la valeur liée pour le nom accessible du bouton Unlink. */
function linkHtml(link: LinkView, path: Path, what: string): string {
  const others = link.sharedWith.length > 0 ? ` · also used by ${link.sharedWith.join(", ")}` : "";
  return (
    `<span class="linked"><span class="tag">linked</span><span class="hint">&amp;${esc(link.anchor)}${esc(others)}</span>` +
    `${buttonHtml("Unlink", "btn pill sm", { action: "unlink", path: JSON.stringify(path) }, false, `Unlink ${what}`)}</span>`
  );
}

// --- Menus Provider et Options --------------------------------------------------------------------

interface MenuItem {
  label: string;
  checked: boolean;
  right?: string;
  attrs: DataAttrs;
}

function menuHtml(caption: string, main: MenuItem[], tail: MenuItem[]): string {
  const item = (m: MenuItem): string =>
    `<button type="button" role="menuitem" class="mi${m.checked ? " on" : ""}"${data(m.attrs)}><span class="ck">${m.checked ? "✓" : ""}</span>${esc(m.label)}${m.right ? `<span class="r">${esc(m.right)}</span>` : ""}</button>`;
  return `<div class="menu" role="menu"><div class="mcap">${esc(caption)}</div>${main.map(item).join("")}<div class="msep"></div>${tail.map(item).join("")}</div>`;
}

/** Nombre d'agents dont un engine utilise ce preset comme provider. */
function agentsUsing(view: ConfigView, preset: string): number {
  return view.agents.filter((a) => a.engines.some((e) => e.provider.kind === "preset" && e.provider.name === preset)).length;
}

function isOpen(ui: UiState, engine: { agent: string; engine: string }, kind: "provider" | "options"): boolean {
  const m = ui.menu;
  return m !== undefined && m.agent === engine.agent && m.engine === engine.engine && m.kind === kind;
}

/** Le nom accessible porte la légende (« Provider: ollama ») ; le chevron est décoratif. */
function trigger(caption: string, label: string, open: boolean, id: string, kind: "provider" | "options", base: { agent: string; engine: string }, ro: boolean): string {
  return (
    `<button type="button" class="pop${open ? " open" : ""}" id="${esc(id)}" data-focus-id="${esc(id)}" aria-haspopup="menu" aria-expanded="${open}" aria-label="${esc(`${caption}: ${label}`)}"` +
    `${data({ action: "menu", kind, ...base })}${ro ? " disabled" : ""}>${esc(label)} <span class="cv" aria-hidden="true">⌄</span></button>`
  );
}

function providerControl(view: ConfigView, ui: UiState, engine: EngineView, base: { agent: string; engine: string }, id: string, ro: boolean): string {
  const current = engine.provider;
  const label = current.kind === "preset" ? current.name : current.kind === "custom" ? "Custom env" : "Anthropic";
  const open = isOpen(ui, base, "provider");
  let menu = "";
  if (open) {
    const providers = view.presets.filter((p) => p.kind === "provider");
    const act = (extra: DataAttrs): DataAttrs => ({ action: "setProvider", ...base, ...extra });
    // Anthropic se trie avec les presets : un seul ordre alphabétique pour toute la liste.
    const main: MenuItem[] = [
      { label: "Anthropic", checked: current.kind === "anthropic", right: "no proxy", attrs: act({ "provider-kind": "anthropic" }) },
      ...providers.map((p) => ({
        label: p.name,
        checked: current.kind === "preset" && current.name === p.name,
        right: plural(agentsUsing(view, p.name), "agent"),
        attrs: act({ "provider-kind": "preset", preset: p.name }),
      })),
    ].sort((a, b) => compareNames(a.label, b.label));
    menu = menuHtml(
      "Providers",
      main,
      [
        { label: "Custom env…", checked: current.kind === "custom", attrs: act({ "provider-kind": "custom" }) },
        { label: "Edit providers…", checked: false, attrs: { action: "tab", tab: "providers" } },
      ],
    );
  }
  return `<div class="c menu-host"><span class="k">Provider</span>${trigger("Provider", label, open, id, "provider", base, ro)}${menu}</div>`;
}

function optionsControl(
  view: ConfigView,
  ui: UiState,
  engine: EngineView,
  base: { agent: string; engine: string },
  id: (field: string) => string,
  ro: boolean,
  issues: IssueView[],
): string {
  const current = engine.options;
  const label = current.kind === "preset" ? current.name : current.kind === "custom" ? "Custom" : "None";
  const open = isOpen(ui, base, "options");
  let menu = "";
  if (open) {
    const sets = view.presets.filter((p) => p.kind === "options").sort(byPresetName);
    const act = (extra: DataAttrs): DataAttrs => ({ action: "setOptions", ...base, ...extra });
    const carried = current.kind === "none" ? [] : current.values;
    menu = menuHtml(
      "Option sets",
      [
        { label: "None", checked: current.kind === "none", attrs: act({ "options-kind": "none" }) },
        ...sets.map((p) => ({
          label: p.name,
          checked: current.kind === "preset" && current.name === p.name,
          right: plural(p.options.length, "option"),
          attrs: act({ "options-kind": "preset", preset: p.name }),
        })),
      ],
      [{ label: "Custom", checked: current.kind === "custom", attrs: act({ "options-kind": "custom", values: JSON.stringify(carried) }) }],
    );
  }

  // Jetons : modifiables pour une liste libre (avec un jeton vide pour en ajouter), figés pour un preset.
  let tokens: string;
  if (current.kind === "preset") {
    tokens = `<span class="chips">${current.values.map((v) => `<span class="chip ref">${esc(v)}</span>`).join("")}</span>`;
  } else {
    const values = current.kind === "custom" ? current.values : [];
    const invalidAt = new Set(issues.filter((i) => i.severity === "error").map((i) => i.field));
    const chip = (value: string, index: number, last: boolean): string =>
      inputHtml({
        id: id(`options:${index}`),
        value,
        mono: true,
        label: last ? `Add option to engine ${base.engine}` : `Option ${index + 1} of engine ${base.engine}`,
        placeholder: last ? "+" : "",
        disabled: ro,
        className: last ? "chip add" : "chip",
        invalid: invalidAt.has(`options.${index}`),
        attrs: { action: "setOptions", ...base, index },
      });
    tokens = `<span class="chips" data-options-list data-agent="${esc(base.agent)}" data-engine="${esc(base.engine)}">${values.map((v, i) => chip(v, i, false)).join("")}${chip("", values.length, true)}</span>`;
  }
  return `<div class="c menu-host"><span class="k">Options</span>${trigger("Options", label, open, id("options-menu"), "options", base, ro)}${menu}${tokens}</div>`;
}

// --- Env ------------------------------------------------------------------------------------------

function envControl(ui: UiState, engine: EngineView, base: { agent: string; engine: string }, id: (field: string) => string, ro: boolean, issues: IssueView[], agentKey: string): string {
  const merge =
    engine.harness !== "claude" && engine.mergedPreset !== undefined
      ? `<div class="merge"><span class="ref">${esc(`<< ${engine.mergedPreset}`)}</span>${buttonHtml("Remove", "btn pill sm", { action: "removeMerge", ...base }, false, `Remove merged preset ${engine.mergedPreset}`)}</div>`
      : "";
  const addTarget: AddingState = { action: "addEnvVar", ...base };
  const add = ro ? "" : addControl(ui, addTarget, buttonHtml("+ Add Environment variable", "btn ghost sm", { action: "addEnvVar", ...base }, false, `Add environment variable to engine ${engine.name}`));
  // Replié quand l'engine n'a rien en propre : une petite action suffit (spec §5).
  if (engine.env.length === 0 && merge === "") return add === "" ? "" : `<div class="envadd">${add}</div>`;

  const rows = engine.env
    .map((v) => {
      const mine = take(issues, (i) => i.field === `env.${v.name}`);
      const row = varRow(v, {
        idBase: id(`env:${v.name}`),
        ...varInvalid(mine),
        disabled: ro,
        setAttrs: { action: "setEnvVar", ...base, name: v.name },
        deleteAttrs: { action: "deleteEnvVar", ...base, name: v.name },
        path: ["agents", agentKey, "engines", engine.name, "env", v.name],
      });
      return row + issuesHtml(mine);
    })
    .join("");
  return `<div class="mrow"><span class="k">Env</span><div class="envbox">${merge}${rows}${add}</div></div>`;
}

/** Un problème `env-name-form` cerne le champ du nom ; tout autre problème d'une variable cerne sa valeur. */
function varInvalid(issues: IssueView[]): { invalidName: boolean; invalidValue: boolean } {
  const errors = issues.filter((i) => i.severity === "error");
  return {
    invalidName: errors.some((i) => i.code === "env-name-form"),
    invalidValue: errors.some((i) => i.code !== "env-name-form"),
  };
}

interface VarRowOptions {
  idBase: string;
  invalidName: boolean;
  invalidValue: boolean;
  disabled: boolean;
  setAttrs: DataAttrs;
  deleteAttrs: DataAttrs;
  path: Path;
}

/** Une paire nom/valeur ; une valeur liée par ancre est en lecture seule avec Unlink. */
function varRow(v: EnvVarView, o: VarRowOptions): string {
  const value = inputHtml({
    id: `${o.idBase}:value`,
    value: v.value,
    mono: true,
    label: `${v.name} value`,
    placeholder: "empty",
    disabled: o.disabled,
    readonly: v.linked !== undefined,
    invalid: o.invalidValue,
    attrs: { ...o.setAttrs, field: "value" },
  });
  const name = inputHtml({
    id: `${o.idBase}:name`,
    value: v.name,
    mono: true,
    label: `Name of variable ${v.name}`,
    disabled: o.disabled || v.linked !== undefined,
    invalid: o.invalidName,
    attrs: { ...o.setAttrs, field: "name" },
  });
  const remove = `<button type="button" class="x" aria-label="Remove ${esc(v.name)}"${data(o.deleteAttrs)}${o.disabled ? " disabled" : ""}>−</button>`;
  const link = v.linked ? linkHtml(v.linked, o.path, `variable ${v.name}`) : "";
  return `<div class="kv">${name}${value}${remove}</div>${link}`;
}

// --- Vue Provider et Option set -------------------------------------------------------------------

/** Un badge par agent qui utilise le preset, trié par nom affiché ; un clic ouvre la fiche de l'agent. */
function usedBy(view: ConfigView, preset: PresetView): string {
  const users = preset.usedBy
    .map((user) => {
      const agent = view.agents.find((a) => a.key === user.agent);
      return { ...user, name: agent ? displayName(agent) : user.agent };
    })
    .sort((a, b) => compareNames(a.name, b.name) || compareNames(a.agent, b.agent));
  const badges = users
    .map((user) => buttonHtml(user.name, "badge", { action: "openAgent", key: user.agent, harness: user.harness }, false, `Open agent ${user.name}`))
    .join("");
  const body = badges ? `<div class="badges">${badges}</div>` : '<p class="hint">No agent uses this yet.</p>';
  return `<div class="sect used-head"><span>Used by</span></div>${body}`;
}

function presetPane(view: ConfigView, ui: UiState, preset: PresetView): string {
  const general = issuesIn(view.issues, { preset: preset.name });
  const head =
    `<div class="head"><h2>${esc(preset.name)}</h2>${preset.builtIn ? '<span class="tag">Built-in</span>' : ""}` +
    (preset.inFile ? "" : '<span class="info">Written to the file when first used</span>') +
    (preset.inFile ? `<span class="acts">${buttonHtml("Delete", "btn pill sm", { action: "deletePreset", preset: preset.name }, false, `Delete ${preset.name}`)}</span>` : "") +
    "</div>";
  const name = preset.inFile
    ? `<div class="ident"><div class="fld"><label class="lbl" for="preset:${esc(preset.name)}:name">Name</label>${inputHtml({ id: `preset:${preset.name}:name`, value: preset.name, mono: true, attrs: { action: "renamePreset", preset: preset.name } })}</div></div>`
    : "";

  let body: string;
  if (preset.kind === "provider") body = providerBody(ui, preset, general);
  else if (preset.kind === "options") body = optionsBody(ui, preset, general);
  else body = `<p class="hint">This preset is neither a table of variables nor a list of options. Edit the file directly.</p>`;
  return `<main class="main">${head}${name}${body}${issuesHtml(general)}${usedBy(view, preset)}</main>`;
}

function providerBody(ui: UiState, preset: PresetView, general: IssueView[]): string {
  const rows = preset.vars
    .map((v) => {
      const mine = take(general, (i) => i.field === `env.${v.name}`);
      const row = varRow(v, {
        idBase: `preset:${preset.name}:var:${v.name}`,
        ...varInvalid(mine),
        disabled: false,
        setAttrs: { action: "setPresetVar", preset: preset.name, name: v.name },
        deleteAttrs: { action: "deletePresetVar", preset: preset.name, name: v.name },
        path: ["presets", preset.name, v.name],
      });
      return row + issuesHtml(mine);
    })
    .join("");
  const add = buttonHtml("+ Add variable", "btn ghost sm", { action: "addPresetVar", preset: preset.name }, false, `Add variable to ${preset.name}`);
  return (
    `<div class="sect"><span>Environment</span></div>${rows}` +
    addControl(ui, { action: "addPresetVar", preset: preset.name }, add) +
    '<p class="hint">Values are written as typed. A <span class="ref">$VARIABLE</span> stays a reference, read from your shell when the agent starts.</p>'
  );
}

function optionsBody(ui: UiState, preset: PresetView, general: IssueView[]): string {
  const last = preset.options.length - 1;
  const rows = preset.options
    .map((value, index) => {
      const mine = take(general, (i) => i.field === `options.${index}`);
      const attrs = { preset: preset.name, index };
      const n = index + 1;
      return (
        `<div class="tok">${inputHtml({ id: `preset:${preset.name}:option:${index}`, value, mono: true, label: `Option ${n} of ${preset.name}`, invalid: hasError(mine), attrs: { action: "setPresetOptions", ...attrs } })}` +
        buttonHtml("↑", "btn pill sm", { action: "moveOption", ...attrs, dir: -1 }, index === 0, `Move option ${n} of ${preset.name} up`) +
        buttonHtml("↓", "btn pill sm", { action: "moveOption", ...attrs, dir: 1 }, index === last, `Move option ${n} of ${preset.name} down`) +
        buttonHtml("−", "btn pill sm", { action: "removeOption", ...attrs }, false, `Remove option ${n} of ${preset.name}`) +
        `</div>${issuesHtml(mine)}`
      );
    })
    .join("");
  const add = buttonHtml("+ Add option", "btn ghost sm", { action: "addOption", preset: preset.name }, false, `Add option to ${preset.name}`);
  return `<div class="sect"><span>Options</span></div><div data-options-list data-preset="${esc(preset.name)}">${rows}</div>${addControl(ui, { action: "addOption", preset: preset.name }, add)}`;
}

// --- Écran d'erreur de syntaxe --------------------------------------------------------------------

function parseErrorScreen(view: ConfigView): string {
  const error = view.parseError;
  if (!error) return "";
  return (
    `<main class="main parse-error"><h2>This file cannot be read</h2>` +
    `<p class="path">${esc(view.displayPath)}</p><p class="message" role="alert">${esc(error.message)}</p>` +
    `<p class="where">Line ${error.line}, column ${error.col}</p>` +
    `<p class="hint">Fix the file in your editor, then reload. Nothing can be edited until it parses.</p>` +
    `${buttonHtml("Reload", "btn sec", { action: "reload" })}</main>`
  );
}

// --- Page -----------------------------------------------------------------------------------------

/** Fichier sans agent : la page d'accueil d'un nouvel utilisateur, le formulaire de création en est le contenu. */
function firstAgentPane(): string {
  return (
    '<main class="main first-agent"><h2>Add your first agent</h2>' +
    '<p class="hint">An agent is a model: give it a key, then choose how it runs.</p>' +
    `${addForm({ action: "addAgent" }, true)}</main>`
  );
}

export function renderApp(view: ConfigView, state: UiState): string {
  if (view.parseError) return `<div class="win">${toolbar(view)}<div class="body single">${parseErrorScreen(view)}</div></div>`;

  // Sans agent, la création d'agent vit dans le panneau principal : la ligne de la barre latérale ne la double pas.
  const noAgents = state.tab === "agents" && view.agents.length === 0;
  const ui: UiState = noAgents && state.adding?.action === "addAgent" ? { ...state, adding: undefined } : state;

  // Sélection par défaut : la première rangée affichée, pour que le panneau et la rangée en surbrillance s'accordent.
  const names = shownKeys(view, ui);
  const selected = ui.selected !== undefined && names.includes(ui.selected) ? ui.selected : names[0];

  let main: string;
  if (ui.tab === "agents") {
    const agent = view.agents.find((a) => a.key === selected);
    main = agent ? agentPane(view, ui, agent) : firstAgentPane();
  } else {
    const preset = view.presets.find((p) => p.name === selected);
    main = preset ? presetPane(view, ui, preset) : '<main class="main empty"><p class="hint">Nothing here yet.</p></main>';
  }
  return `<div class="win">${toolbar(view)}<div class="body">${sidebar(view, ui, selected)}${main}</div></div>`;
}
