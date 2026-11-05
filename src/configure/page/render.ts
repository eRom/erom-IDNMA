/**
 * Rendu de la page `idnma configure` : une fonction pure `ConfigView` + `UiState` -> chaîne HTML.
 * Aucun DOM, aucun `document`, aucun `window` ; toute valeur venue de la vue passe par `escapeHtml`,
 * attributs compris. Aucun style en ligne : la mise en forme est la feuille `styles.css` (tâche 11).
 *
 * CONTRAT DES ATTRIBUTS (la tâche 11 s'appuie dessus, `app.ts` délègue les événements sur `#app`)
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
 *      sans nom ni clé, la page doit les demander à l'utilisateur avant d'envoyer l'opération.
 *    - `duplicateAgent`, `deleteAgent`, `deleteEngine`, `makeDefault`, `removeMerge`, `deletePreset` :
 *      boutons, paramètres en `data-*`.
 *
 * 2. Action d'interface, sans `EditOp` direct :
 *    - `tab` : `data-tab` = `agents`|`providers`|`options`.
 *    - `select` : `data-key` = clé de l'agent ou nom du preset à afficher (l'onglet est celui d'`UiState`).
 *    - `menu` : ouvre (ou ferme) le menu d'un engine ; `data-agent`, `data-engine`, `data-kind` =
 *      `provider`|`options`. Le menu ouvert est celui d'`UiState.menu`.
 *    - `copy` : `data-text` = le texte exact à copier.
 *    - `save`, `revert`, `reload` : sans paramètre.
 *    - `quote` : bouton « Quote it », `data-path` = chemin de la valeur à passer en texte, à envoyer en
 *      `quoteValue`.
 *    - `addEnvVar` (`data-agent`, `data-engine`), `addPresetVar` (`data-preset`) : ajoutent une variable,
 *      le nom est à demander puis envoyé en `setEnvVar` / `setPresetVar`.
 *    - `addOption`, `removeOption`, `moveOption` (`data-preset`, `data-index`, `data-dir`) : sur un option
 *      set ; calculer le nouveau tableau à partir des champs et envoyer `setPresetOptions`.
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

export interface UiState {
  tab: "agents" | "providers" | "options";
  selected?: string;
  menu?: { agent: string; engine: string; kind: "harness" | "provider" | "options" };
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
const HARNESS_TABLE: Record<Harness, true> = { claude: true, codex: true, grok: true, agy: true, opencode: true, dst: true };
const HARNESS_NAMES = Object.keys(HARNESS_TABLE);

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

function buttonHtml(label: string, classes: string, attrs: DataAttrs, disabled = false): string {
  return `<button type="button" class="${classes}"${data(attrs)}${disabled ? " disabled" : ""}>${esc(label)}</button>`;
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
      const quote = path ? buttonHtml("Quote it", "btn pill sm", { action: "quote", path: JSON.stringify(path) }) : "";
      return `<div class="issue ${level}" role="${level === "err" ? "alert" : "status"}"><i class="dot ${level}"></i><span>${esc(issue.message)}</span>${quote}</div>`;
    })
    .join("");
}

function dotHtml(label: string): string {
  return `<i class="dot err" role="img" aria-label="${esc(label)}"></i>`;
}

// --- Barre d'outils -------------------------------------------------------------------------------

function toolbar(view: ConfigView): string {
  const path = `<span class="path">${esc(view.path)}</span>${view.isNew ? '<span class="tag">New file</span>' : ""}`;
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
    buttonHtml("Revert", "btn sec", { action: "revert" }, !dirty) +
    `<button type="button" class="btn pri"${data({ action: "save" })}${dirty ? "" : " disabled"}>${view.isNew ? "Create" : "Save"} <span class="kt">⌘S</span></button>` +
    "</header>"
  );
}

// --- Barre latérale -------------------------------------------------------------------------------

const providerLike = (preset: PresetView): boolean => preset.kind !== "options";

function sidebar(view: ConfigView, ui: UiState, selected: string | undefined): string {
  const providers = view.presets.filter(providerLike);
  const optionSets = view.presets.filter((p) => p.kind === "options");
  const tabs: [UiState["tab"], string, number][] = [
    ["agents", "Agents", view.agents.length],
    ["providers", "Providers", providers.length],
    ["options", "Options", optionSets.length],
  ];
  const seg = tabs
    .map(([tab, label, count]) => {
      const on = tab === ui.tab;
      return `<button type="button" role="tab" aria-selected="${on}" class="${on ? "on" : ""}"${data({ action: "tab", tab })}>${label} <i class="c">${count}</i></button>`;
    })
    .join("");

  let rows: string;
  let add: string;
  if (ui.tab === "agents") {
    rows = view.agents.map((agent) => agentRow(view, agent, agent.key === selected)).join("");
    add = buttonHtml("+ Add agent", "row add", { action: "addAgent" });
  } else {
    const list = ui.tab === "providers" ? providers : optionSets;
    rows = list.map((preset) => presetRow(view, preset, preset.name === selected)).join("");
    add =
      ui.tab === "providers"
        ? buttonHtml("+ Add provider", "row add", { action: "addPreset", kind: "provider" })
        : buttonHtml("+ Add option set", "row add", { action: "addPreset", kind: "options" });
  }
  return `<nav class="side"><div class="seg" role="tablist">${seg}</div><div class="rows">${rows}</div>${add}</nav>`;
}

function agentRow(view: ConfigView, agent: AgentView, selected: boolean): string {
  const lead = agent.engines.find((e) => e.isDefault) ?? agent.engines[0];
  const more = agent.engines.length - 1;
  const broken = hasError(view.issues.filter((i) => i.agent === agent.key));
  const name = agent.label || agent.key;
  return (
    `<button type="button" class="row${selected ? " sel" : ""}"${selected ? ' aria-current="true"' : ""}${data({ action: "select", key: agent.key })}>` +
    `<span class="av">${esc(initialOf(name))}</span><span class="name">${esc(name)}</span>` +
    `<span class="meta">${broken ? dotHtml("Has errors") : ""}${esc(lead?.harness ?? "")}${more > 0 ? ` <span class="more">+${more}</span>` : ""}</span></button>`
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
    `<span class="acts">${buttonHtml("Duplicate", "btn pill sm", { action: "duplicateAgent", agent: key })}${buttonHtml("Delete", "btn pill sm", { action: "deleteAgent", agent: key })}</span></div>`;

  const ident =
    `<div class="ident">` +
    identity(`agent:${key}:label`, "Label", { value: agent.label ?? "", attrs: { action: "setAgentField", agent: key, field: "label" } }, labelIssues) +
    identity(`agent:${key}:key`, "Key", { value: key, mono: true, attrs: { action: "renameAgent", agent: key } }) +
    identity(`agent:${key}:avatar`, "Avatar", { value: agent.avatar ?? "", placeholder: "None", attrs: { action: "setAgentField", agent: key, field: "avatar" } }) +
    "</div>";

  const engines = agent.engines.map((engine) => engineBlock(view, ui, agent, engine)).join("");
  return (
    `<main class="main">${head}${ident}${issuesHtml(general)}` +
    `<div class="sect"><span>Engines</span>${buttonHtml("+ Add engine", "btn ghost sm", { action: "addEngine", agent: key })}</div>` +
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
      : `<span class="fl">--engine</span>${inputHtml({ id: id("name"), value: engine.name, mono: true, label: "Engine name", className: "ek", disabled: ro, attrs: { action: "renameEngine", ...base } })}`);
  const strip =
    `<div class="cmd"><span class="p">❯</span>${line}` +
    (engine.isDefault ? '<span class="def">default</span>' : '<span class="push"></span>') +
    (engine.isDefault ? "" : buttonHtml("Make default", "btn pill sm", { action: "makeDefault", ...base })) +
    buttonHtml("Copy", "btn pill sm", { action: "copy", text: engine.command }) +
    (engine.isDefault ? "" : buttonHtml("Delete", "btn pill sm", { action: "deleteEngine", ...base })) +
    "</div>";

  // Harnais : un `<select>` natif suffit (six valeurs fixes, rien à légender).
  const known = HARNESS_NAMES.includes(engine.harness);
  const harnessOptions =
    (known ? "" : `<option value="${esc(engine.harness)}" selected>${esc(engine.harness || "(none)")}</option>`) +
    HARNESS_NAMES.map((h) => `<option value="${h}"${h === engine.harness ? " selected" : ""}>${h}</option>`).join("");
  const harnessIssues = take(issues, (i) => i.field === "harness");
  const harness =
    `<span class="c"><label class="k" for="${esc(id("harness"))}">Harness</label>` +
    `<select class="pop${hasError(harnessIssues) ? " invalid" : ""}" id="${esc(id("harness"))}" data-focus-id="${esc(id("harness"))}"${data({ action: "setHarness", ...base })}${ro ? " disabled" : ""}>${harnessOptions}</select></span>`;

  const provider = claude ? providerControl(view, ui, engine, base, id("provider"), ro) : "";
  const optionsIssues = take(issues, (i) => i.field === "options" || (i.field ?? "").startsWith("options."));
  const options = optionsControl(view, ui, engine, base, id, ro, optionsIssues);
  const dst = engine.harness === "dst" ? '<span class="c"><span class="k dim">Model is chosen inside dst with /model</span></span>' : "";
  const controls = `<div class="ctl">${harness}${provider}${dst}${options}</div>${issuesHtml(harnessIssues)}${issuesHtml(optionsIssues)}`;

  // Model : absent pour dst ; lié par ancre, il se montre en lecture seule avec son action Unlink.
  let model = "";
  if (engine.harness !== "dst") {
    const modelIssues = take(issues, (i) => i.field === "model");
    const place = engine.harness === "opencode" ? "provider/model" : "Default";
    const field = inputHtml({
      id: id("model"),
      value: engine.model ?? "",
      mono: true,
      label: "Model",
      placeholder: place,
      disabled: ro,
      readonly: engine.modelLinked !== undefined,
      invalid: hasError(modelIssues),
      attrs: { action: "setModel", ...base },
    });
    const link = engine.modelLinked ? linkHtml(engine.modelLinked, ["agents", agent.key, "engines", engine.name, "model"]) : "";
    model = `<div class="mrow"><label class="k" for="${esc(id("model"))}">Model</label><div class="val">${field}${link}</div></div>${issuesHtml(modelIssues)}`;
  }

  const env = envControl(engine, base, id, ro, issues, agent.key);
  const note = ro ? `<p class="hint">${esc(engine.readOnly ?? "")}</p>` : "";
  // Ce que ni un champ ni une commande n'a réclamé : problème de l'engine entier.
  return `<section class="eng" data-engine="${esc(engine.name)}">${strip}${issuesHtml(issues)}${note}${controls}${model}${env}</section>`;
}

function linkHtml(link: LinkView, path: Path): string {
  const others = link.sharedWith.length > 0 ? ` · also used by ${link.sharedWith.join(", ")}` : "";
  return (
    `<span class="linked"><span class="tag">linked</span><span class="hint">&amp;${esc(link.anchor)}${esc(others)}</span>` +
    `${buttonHtml("Unlink", "btn pill sm", { action: "unlink", path: JSON.stringify(path) })}</span>`
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

function trigger(label: string, open: boolean, id: string, kind: "provider" | "options", base: { agent: string; engine: string }, ro: boolean): string {
  return (
    `<button type="button" class="pop${open ? " open" : ""}" id="${esc(id)}" data-focus-id="${esc(id)}" aria-haspopup="menu" aria-expanded="${open}"` +
    `${data({ action: "menu", kind, ...base })}${ro ? " disabled" : ""}>${esc(label)} <span class="cv">⌄</span></button>`
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
    menu = menuHtml(
      "Providers",
      [
        { label: "Anthropic", checked: current.kind === "anthropic", right: "no proxy", attrs: act({ "provider-kind": "anthropic" }) },
        ...providers.map((p) => ({
          label: p.name,
          checked: current.kind === "preset" && current.name === p.name,
          right: plural(agentsUsing(view, p.name), "agent"),
          attrs: act({ "provider-kind": "preset", preset: p.name }),
        })),
      ],
      [
        { label: "Custom env…", checked: current.kind === "custom", attrs: act({ "provider-kind": "custom" }) },
        { label: "Edit providers…", checked: false, attrs: { action: "tab", tab: "providers" } },
      ],
    );
  }
  return `<span class="c menu-host"><span class="k">Provider</span>${trigger(label, open, id, "provider", base, ro)}${menu}</span>`;
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
    const sets = view.presets.filter((p) => p.kind === "options");
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
        label: last ? "Add option" : `Option ${index + 1}`,
        placeholder: last ? "+" : "",
        disabled: ro,
        className: last ? "chip add" : "chip",
        invalid: invalidAt.has(`options.${index}`),
        attrs: { action: "setOptions", ...base, index },
      });
    tokens = `<span class="chips" data-options-list data-agent="${esc(base.agent)}" data-engine="${esc(base.engine)}">${values.map((v, i) => chip(v, i, false)).join("")}${chip("", values.length, true)}</span>`;
  }
  return `<span class="c menu-host"><span class="k">Options</span>${trigger(label, open, id("options-menu"), "options", base, ro)}${menu}${tokens}</span>`;
}

// --- Env ------------------------------------------------------------------------------------------

function envControl(engine: EngineView, base: { agent: string; engine: string }, id: (field: string) => string, ro: boolean, issues: IssueView[], agentKey: string): string {
  const merge =
    engine.harness !== "claude" && engine.mergedPreset !== undefined
      ? `<div class="merge"><span class="ref">${esc(`<< ${engine.mergedPreset}`)}</span>${buttonHtml("Remove", "btn pill sm", { action: "removeMerge", ...base })}</div>`
      : "";
  const rows = engine.env
    .map((v) => {
      const mine = take(issues, (i) => i.field === `env.${v.name}`);
      const row = varRow(v, {
        idBase: id(`env:${v.name}`),
        invalid: hasError(mine),
        disabled: ro,
        setAttrs: { action: "setEnvVar", ...base, name: v.name },
        deleteAttrs: { action: "deleteEnvVar", ...base, name: v.name },
        path: ["agents", agentKey, "engines", engine.name, "env", v.name],
      });
      return row + issuesHtml(mine);
    })
    .join("");
  const add = ro ? "" : buttonHtml("+ Add variable", "btn ghost sm", { action: "addEnvVar", ...base });
  return `<div class="mrow"><span class="k">Env</span><div class="envbox">${merge}${rows}${add}</div></div>`;
}

interface VarRowOptions {
  idBase: string;
  invalid: boolean;
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
    invalid: o.invalid,
    attrs: { ...o.setAttrs, field: "value" },
  });
  const name = inputHtml({ id: `${o.idBase}:name`, value: v.name, mono: true, label: "Variable name", disabled: o.disabled || v.linked !== undefined, attrs: { ...o.setAttrs, field: "name" } });
  const remove = `<button type="button" class="x" aria-label="Remove ${esc(v.name)}"${data(o.deleteAttrs)}${o.disabled ? " disabled" : ""}>−</button>`;
  const link = v.linked ? linkHtml(v.linked, o.path) : "";
  return `<div class="kv">${name}${value}${remove}</div>${link}`;
}

// --- Vue Provider et Option set -------------------------------------------------------------------

function usedBy(preset: PresetView): string {
  const commands = preset.usedBy
    .map(
      (command) =>
        `<div class="cmd"><span class="p">❯</span><code class="line">${esc(command)}</code><span class="push"></span>${buttonHtml("Copy", "btn pill sm", { action: "copy", text: command })}</div>`,
    )
    .join("");
  const body = commands || '<p class="hint">No engine uses this yet.</p>';
  return `<div class="sect used-head"><span>Used by</span></div><div class="used">${body}</div>`;
}

function presetPane(view: ConfigView, preset: PresetView): string {
  const general = issuesIn(view.issues, { preset: preset.name });
  const head =
    `<div class="head"><h2>${esc(preset.name)}</h2>${preset.builtIn ? '<span class="tag">Built-in</span>' : ""}` +
    (preset.inFile ? "" : '<span class="info">Written to the file when first used</span>') +
    (preset.inFile ? `<span class="acts">${buttonHtml("Delete", "btn pill sm", { action: "deletePreset", preset: preset.name })}</span>` : "") +
    "</div>";
  const name = preset.inFile
    ? `<div class="ident"><div class="fld"><label class="lbl" for="preset:${esc(preset.name)}:name">Name</label>${inputHtml({ id: `preset:${preset.name}:name`, value: preset.name, mono: true, attrs: { action: "renamePreset", preset: preset.name } })}</div></div>`
    : "";

  let body: string;
  if (preset.kind === "provider") body = providerBody(preset, general);
  else if (preset.kind === "options") body = optionsBody(preset, general);
  else body = `<p class="hint">This preset is neither a table of variables nor a list of options. Edit the file directly.</p>`;
  return `<main class="main">${head}${name}${body}${issuesHtml(general)}${usedBy(preset)}</main>`;
}

function providerBody(preset: PresetView, general: IssueView[]): string {
  const rows = preset.vars
    .map((v) => {
      const mine = take(general, (i) => i.field === `env.${v.name}`);
      const row = varRow(v, {
        idBase: `preset:${preset.name}:var:${v.name}`,
        invalid: hasError(mine),
        disabled: false,
        setAttrs: { action: "setPresetVar", preset: preset.name, name: v.name },
        deleteAttrs: { action: "deletePresetVar", preset: preset.name, name: v.name },
        path: ["presets", preset.name, v.name],
      });
      return row + issuesHtml(mine);
    })
    .join("");
  return (
    `<div class="sect"><span>Environment</span></div>${rows}` +
    buttonHtml("+ Add variable", "btn ghost sm", { action: "addPresetVar", preset: preset.name }) +
    '<p class="hint">Values are written as typed. A <span class="ref">$VARIABLE</span> stays a reference, read from your shell when the agent starts.</p>'
  );
}

function optionsBody(preset: PresetView, general: IssueView[]): string {
  const last = preset.options.length - 1;
  const rows = preset.options
    .map((value, index) => {
      const mine = take(general, (i) => i.field === `options.${index}`);
      const attrs = { preset: preset.name, index };
      return (
        `<div class="tok">${inputHtml({ id: `preset:${preset.name}:option:${index}`, value, mono: true, label: `Option ${index + 1}`, invalid: hasError(mine), attrs: { action: "setPresetOptions", ...attrs } })}` +
        buttonHtml("↑", "btn pill sm", { action: "moveOption", ...attrs, dir: -1 }, index === 0) +
        buttonHtml("↓", "btn pill sm", { action: "moveOption", ...attrs, dir: 1 }, index === last) +
        buttonHtml("−", "btn pill sm", { action: "removeOption", ...attrs }) +
        `</div>${issuesHtml(mine)}`
      );
    })
    .join("");
  return `<div class="sect"><span>Options</span></div><div data-options-list data-preset="${esc(preset.name)}">${rows}</div>${buttonHtml("+ Add option", "btn ghost sm", { action: "addOption", preset: preset.name })}`;
}

// --- Écran d'erreur de syntaxe --------------------------------------------------------------------

function parseErrorScreen(view: ConfigView): string {
  const error = view.parseError;
  if (!error) return "";
  return (
    `<main class="main parse-error" role="alert"><h2>This file cannot be read</h2>` +
    `<p class="path">${esc(view.path)}</p><p class="message">${esc(error.message)}</p>` +
    `<p class="where">Line ${error.line}, column ${error.col}</p>` +
    `<p class="hint">Fix the file in your editor, then reload. Nothing can be edited until it parses.</p>` +
    `${buttonHtml("Reload", "btn sec", { action: "reload" })}</main>`
  );
}

// --- Page -----------------------------------------------------------------------------------------

export function renderApp(view: ConfigView, ui: UiState): string {
  if (view.parseError) return `<div class="win">${toolbar(view)}<div class="body single">${parseErrorScreen(view)}</div></div>`;

  const names = ui.tab === "agents" ? view.agents.map((a) => a.key) : view.presets.filter((p) => (ui.tab === "options" ? p.kind === "options" : p.kind !== "options")).map((p) => p.name);
  const selected = ui.selected !== undefined && names.includes(ui.selected) ? ui.selected : names[0];

  let main: string;
  if (ui.tab === "agents") {
    const agent = view.agents.find((a) => a.key === selected);
    main = agent ? agentPane(view, ui, agent) : '<main class="main empty"><p class="hint">No agents yet. Add one to get started.</p></main>';
  } else {
    const preset = view.presets.find((p) => p.name === selected);
    main = preset ? presetPane(view, preset) : '<main class="main empty"><p class="hint">Nothing here yet.</p></main>';
  }
  return `<div class="win">${toolbar(view)}<div class="body">${sidebar(view, ui, selected)}${main}</div></div>`;
}
