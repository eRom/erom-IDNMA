/**
 * Page `idnma configure` : le câblage du DOM autour de `renderApp` (voir le contrat des attributs dans
 * `render.ts`). La page ne valide rien : elle envoie des opérations au serveur, qui rend la vue complète,
 * et redessine. Tout passe par une délégation d'événements sur `document` : le HTML de `#app` est
 * remplacé à chaque rendu, aucun écouteur n'est posé sur un élément. Ce qui se décide sans DOM (jeton,
 * renommages, champ vers opération, formulaire de création, options) est dans `logic.ts`.
 */
import { commandLine } from "../command.ts";
import type { ConfigView, EditOp } from "../types.ts";
import { type AddingState, renderApp, shownKeys, type UiState } from "./render.ts";
import { addOps, type FieldInput, neighbourAfterDelete, opForField, PendingInputs, readToken, remapId, type Remap, renameEffect, reorderOptions, toolbarState } from "./logic.ts";

// --- Appels ---------------------------------------------------------------------------------------

interface ApiBody {
  view?: ConfigView;
  refused?: string;
  failed?: string;
  changedOnDisk?: boolean;
  error?: string;
}
interface ApiResult {
  /** 0 quand le serveur ne répond pas. */
  status: number;
  body: ApiBody;
}

const token = readToken(location, history, sessionStorage);

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult> {
  try {
    const response = await fetch(path, {
      method,
      headers: { "x-idnma-token": token ?? "", "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const parsed: unknown = await response.json().catch(() => ({}));
    return { status: response.status, body: typeof parsed === "object" && parsed !== null ? (parsed as ApiBody) : {} };
  } catch {
    return { status: 0, body: {} };
  }
}

// --- État de la page ------------------------------------------------------------------------------

const root = document.getElementById("app") as HTMLElement;

let view: ConfigView | undefined;
const ui: UiState = { tab: "agents" };

/** Un contrôle retrouvé après un rendu : par son `id` (champs, déclencheurs de menu) ou par ses `data-*` (boutons). */
type Anchor = { id: string } | { data: Record<string, string> };
/** `select` : le texte du champ est sélectionné à l'arrivée (une copie dont le label est à réécrire). */
type Focus = (Anchor & { select?: true }) | { menuFirst: true };

/** Le refus du serveur reste affiché sous son contrôle jusqu'à la prochaine opération acceptée. */
let refusal: { anchor: Anchor; message: string } | undefined;
/** Focus demandé pour le prochain rendu ; à défaut, celui du contrôle actif. */
let pendingFocus: Focus | undefined;
/** Renommages acceptés : le préfixe d'identifiant de focus change, le focus du contrôle actif le suit. */
let remaps: Remap[] = [];
let resetScroll = false;
/** La création affichée au dernier rendu : le texte tapé dans sa ligne ne survit qu'à un rendu de la même. */
let renderedAdding: string | undefined;

// Un rendu qui remplace `#app` pendant qu'un bouton de souris est enfoncé fait perdre le clic (l'élément
// pressé n'existe plus au relâchement) : il attend le relâchement, et passe après le `click`.
let pointerDown = false;
let renderDeferred = false;

/** Les champs où l'on a tapé sans que leur `change` soit parti : la page se tient alors pour sale (Save, Revert actifs). */
const pending = new PendingInputs();

/**
 * Active Save et Revert dès qu'une saisie est en attente. Jamais l'inverse ici : désactiver un bouton que
 * la souris est en train d'enfoncer lui ferait perdre son clic ; seul un rendu, qui suit la vue, les éteint.
 */
function syncToolbar(): void {
  if (!view) return;
  const state = toolbarState(view, pending.any);
  const save = root.querySelector<HTMLButtonElement>('[data-action="save"]');
  const revert = root.querySelector<HTMLButtonElement>('[data-action="revert"]');
  if (save && state.canSave) save.disabled = false;
  if (revert && state.canRevert) revert.disabled = false;
}

function anchorOf(el: HTMLElement): Anchor {
  // Un item de menu se referme avec son menu : le refus se montre sous le déclencheur.
  const trigger = el.closest(".menu") ? el.closest(".menu-host")?.querySelector<HTMLElement>("[aria-haspopup]") : null;
  const target = trigger ?? el;
  return target.id ? { id: target.id } : { data: { ...target.dataset } as Record<string, string> };
}

function findAnchor(anchor: Anchor): HTMLElement | null {
  if ("id" in anchor) return document.getElementById(anchor.id);
  for (const control of root.querySelectorAll<HTMLElement>("[data-action]")) {
    if (Object.entries(anchor.data).every(([key, value]) => control.dataset[key] === value)) return control;
  }
  return null;
}

// --- Rendu ----------------------------------------------------------------------------------------

function render(): void {
  if (!view) return;
  if (pointerDown) {
    renderDeferred = true;
    return;
  }
  renderDeferred = false;
  // Le rendu remplace chaque champ par la valeur de la vue : plus rien n'est en attente.
  pending.clear();
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : undefined;
  let focus: Focus | undefined = pendingFocus;
  if (!focus && active) {
    const anchor = anchorOf(active);
    focus = "id" in anchor ? { id: remapId(remaps, anchor.id) } : anchor;
  }
  const caret = !pendingFocus && active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : undefined;
  pendingFocus = undefined;
  remaps = [];

  // Ce qui se tape dans une ligne de création survit à un rendu venu d'ailleurs, pas au passage à une autre création.
  const sameAdding = JSON.stringify(ui.adding) === renderedAdding;
  const typed = sameAdding ? [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".addrow input, .addrow select")].map((el) => [el.id, el.value] as const) : [];
  const scroll = { main: root.querySelector(".main")?.scrollTop ?? 0, rows: root.querySelector(".rows")?.scrollTop ?? 0 };

  root.innerHTML = renderApp(view, ui);
  renderedAdding = JSON.stringify(ui.adding);

  for (const [id, value] of typed) {
    const el = document.getElementById(id);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = value;
  }
  if (!resetScroll) {
    const main = root.querySelector(".main");
    const rows = root.querySelector(".rows");
    if (main) main.scrollTop = scroll.main;
    if (rows) rows.scrollTop = scroll.rows;
  }
  resetScroll = false;

  // Le rendu retombe sur la première rangée si la sélection a disparu : la page suit ce qui est affiché.
  const shown = root.querySelector<HTMLElement>('.row[aria-current="true"]')?.dataset.key;
  if (shown !== undefined) ui.selected = shown;

  showRefusal();
  restoreFocus(focus, caret);
}

function restoreFocus(focus: Focus | undefined, caret?: (number | null)[]): void {
  if (!focus) return;
  const el = "menuFirst" in focus ? root.querySelector<HTMLElement>(".menu .mi") : findAnchor(focus);
  if (!el) return;
  el.focus();
  if (!(el instanceof HTMLInputElement)) return;
  if ("select" in focus && focus.select) el.select();
  else if (caret && caret[0] != null && caret[1] != null) el.setSelectionRange(caret[0], caret[1]);
}

/** Le refus du serveur, en texte brut (il peut citer un nom venu du fichier), sous le contrôle fautif. */
function showRefusal(): void {
  for (const old of root.querySelectorAll(".refusal")) old.remove();
  if (!refusal) return;
  const target = findAnchor(refusal.anchor);
  if (!target) {
    showNotice(refusal.message);
    refusal = undefined;
    return;
  }
  const message = document.createElement("div");
  message.className = "issue err refusal";
  message.setAttribute("role", "alert");
  const dot = document.createElement("i");
  dot.className = "dot err";
  const text = document.createElement("span");
  text.textContent = refusal.message;
  message.append(dot, text);
  if (target.classList.contains("field")) target.classList.add("invalid");
  const block = target.closest(".fld, .kv, .mrow, .cmd, .head, .sect, .tok, .ctl, .row, .merge, .addrow, .issue") ?? target;
  if (block.matches(".fld")) block.append(message);
  else block.after(message);
}

// --- Avis -----------------------------------------------------------------------------------------

const notice = document.createElement("div");
notice.className = "notice";
notice.setAttribute("role", "alert");
notice.hidden = true;
document.body.append(notice);
/** « Le fichier a changé sur le disque » vaut jusqu'à Reload ou Save : ni une opération ni un rafraîchissement ne l'effacent. */
let noticeSticky = false;

function showNotice(message: string, changedOnDisk = false): void {
  notice.replaceChildren();
  noticeSticky = changedOnDisk;
  const text = document.createElement("span");
  text.textContent = message;
  notice.append(text);
  const button = (label: string, action: string): void => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "btn pill sm";
    el.dataset.action = action;
    el.textContent = label;
    notice.append(el);
  };
  if (changedOnDisk) button("Reload", "reload");
  button("Dismiss", "dismissNotice");
  notice.hidden = false;
}

function hideNotice(force = false): void {
  if (noticeSticky && !force) return;
  noticeSticky = false;
  notice.hidden = true;
}

// --- Envoi des opérations -------------------------------------------------------------------------

/** Appelé avec la vue d'avant et celle d'après une opération acceptée, avant le rendu. */
type Hook = (before: ConfigView, after: ConfigView) => void;

/** Les opérations partent l'une après l'autre : la réponse de l'une est la base de la suivante. */
let queue: Promise<void> = Promise.resolve();

function enqueue(job: () => Promise<void>): void {
  queue = queue.then(job).catch((error: unknown) => {
    console.error(error);
    showNotice("Something went wrong in the page. Reload it.");
  });
}

function fail(result: ApiResult, anchor?: Anchor): void {
  const { status, body } = result;
  if (status === 409 && body.refused !== undefined) {
    if (anchor) {
      refusal = { anchor, message: body.refused };
      showRefusal();
    } else showNotice(body.refused);
  } else if (status === 403) showNotice("This page is no longer authorised. Open the address printed by idnma configure again.");
  else if (status === 0) showNotice("Cannot reach idnma configure. Is it still running?");
  else showNotice(body.failed ?? body.refused ?? body.error ?? `Request failed (${status}).`);
}

function accept(next: ConfigView): void {
  view = next;
  refusal = undefined;
  hideNotice();
}

/** Les identifiants de focus qui changent avec un renommage, et la sélection qui le suit. */
function followRename(op: EditOp): void {
  const effect = renameEffect(op);
  remaps.push(...effect.remaps);
  if (effect.selected && ui.selected === effect.selected.from) ui.selected = effect.selected.to;
}

/**
 * Envoie une opération, ou plusieurs qui partent l'une après l'autre (la création d'un agent crée aussi son
 * engine). `rerenderOnRefusal` : un refus rend sa valeur d'avant à un champ qui ne se retape pas (un `<select>`).
 */
function send(input: EditOp | EditOp[], anchor?: Anchor, hook?: Hook, rerenderOnRefusal = false): void {
  const ops = Array.isArray(input) ? input : [input];
  enqueue(async () => {
    const before = view;
    let last: ConfigView | undefined;
    for (const op of ops) {
      const result = await call("POST", "/api/op", { op });
      if (result.status !== 200 || !result.body.view) {
        // Ce qui a abouti avant le refus reste affiché ; le refus se montre sous son contrôle.
        if (last) {
          accept(last);
          ui.menu = undefined;
        }
        if (last || rerenderOnRefusal) render();
        return fail(result, anchor);
      }
      followRename(op);
      last = result.body.view;
    }
    if (!last) return;
    accept(last);
    ui.menu = undefined;
    if (before) hook?.(before, last);
    render();
  });
}

/**
 * Save, Revert, Reload rendent la vue entière. Save ne part que si le document est sale et lisible, ce
 * qu'on ne sait qu'une fois les opérations en attente passées : le test se fait dans la file.
 */
function sendAction(path: "/api/save" | "/api/revert" | "/api/reload"): void {
  enqueue(async () => {
    if (path === "/api/save" && (!view || view.parseError || !view.dirty)) return;
    const result = await call("POST", path);
    if (result.status === 200 && result.body.view) {
      accept(result.body.view);
      // Relu ou écrit : le fichier du disque n'est plus en avance sur la page.
      if (path !== "/api/revert") hideNotice(true);
      ui.adding = undefined;
      ui.menu = undefined;
      render();
    } else if (result.status === 409 && result.body.changedOnDisk) {
      showNotice("The file changed on disk since it was opened. Reload to read it again; your edits here are dropped.", true);
    } else fail(result);
  });
}

async function refetch(): Promise<void> {
  const result = await call("GET", "/api/state");
  if (result.status !== 200 || !result.body.view) return fail(result);
  hideNotice();
  // Rien n'a bougé : on ne touche ni au focus ni à ce qui se tape.
  if (JSON.stringify(result.body.view) === JSON.stringify(view)) return;
  view = result.body.view;
  render();
}

// --- Champs ---------------------------------------------------------------------------------------

const text = (value: string | undefined): string => value ?? "";

function fieldInput(el: HTMLInputElement | HTMLSelectElement): FieldInput {
  const list = el.closest<HTMLElement>("[data-options-list]");
  return {
    dataset: el.dataset,
    value: el.value,
    sibling: el.closest(".kv")?.querySelector<HTMLInputElement>('[data-field="value"]')?.value,
    group: list ? { dataset: list.dataset, values: [...list.querySelectorAll<HTMLInputElement>("input")].map((input) => input.value) } : undefined,
  };
}

function onFieldChange(el: HTMLInputElement | HTMLSelectElement): void {
  const op = opForField(fieldInput(el));
  if (!op) return;
  const wasLastToken = el instanceof HTMLInputElement && el.classList.contains("add") && el.value.trim() !== "" && document.activeElement === el;
  send(
    op,
    anchorOf(el),
    () => {
      // Entrée dans le jeton qui sert à en ajouter : le focus passe au nouveau jeton vide.
      if (wasLastToken && op.op === "setOptions" && op.options.kind === "custom") {
        pendingFocus = { id: `agent:${op.agent}:engine:${op.engine}:options:${op.options.values.length}` };
      }
    },
    el instanceof HTMLSelectElement,
  );
}

/** La bande de commande suit la clé et le nom d'engine à chaque frappe, sans attendre l'envoi. */
function followCommands(): void {
  const keyInput = root.querySelector<HTMLInputElement>('[data-action="renameAgent"]');
  if (!keyInput) return;
  const key = keyInput.value.trim() || text(keyInput.dataset.agent);
  for (const section of root.querySelectorAll<HTMLElement>(".eng")) {
    const name = section.querySelector<HTMLInputElement>('[data-action="renameEngine"]')?.value.trim() || text(section.dataset.engine);
    const keySpan = section.querySelector(".cmd .key");
    if (keySpan) keySpan.textContent = key;
    const copy = section.querySelector<HTMLElement>('.cmd [data-action="copy"]');
    if (copy) {
      copy.dataset.text = commandLine(key, name);
      copy.setAttribute("aria-label", `Copy ${commandLine(key, name)}`);
    }
  }
}

// --- Création : la ligne de saisie ----------------------------------------------------------------

const ADD_ACTIONS: ReadonlySet<string> = new Set(["addAgent", "addEngine", "addPreset", "addEnvVar", "addPresetVar", "addOption"]);

function startAdding(button: HTMLElement): void {
  const d = button.dataset;
  const action = text(d.action) as AddingState["action"];
  const adding: AddingState = { action };
  if (d.agent !== undefined) adding.agent = d.agent;
  if (d.engine !== undefined) adding.engine = d.engine;
  if (d.preset !== undefined) adding.preset = d.preset;
  if (d.kind === "provider" || d.kind === "options") adding.kind = d.kind;
  ui.adding = adding;
  ui.menu = undefined;
  pendingFocus = { id: action === "addAgent" ? "add:key" : action === "addOption" ? "add:option" : "add:name" };
  render();
}

function cancelAdding(): void {
  const adding = ui.adding;
  ui.adding = undefined;
  // Le bouton qui avait cédé la place à la ligne reprend le focus.
  if (adding) {
    const data: Record<string, string> = { action: adding.action };
    for (const key of ["agent", "engine", "preset", "kind"] as const) if (adding[key] !== undefined) data[key] = adding[key];
    pendingFocus = { data };
  }
  render();
}

function submitAdding(form: HTMLFormElement): void {
  const values: Record<string, string> = {};
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) values[el.id.replace(/^add:/, "")] = el.value.trim();
  const result = addOps({ add: text(form.dataset.add), dataset: form.dataset, values }, view);

  if (!result.ok) {
    refusal = { anchor: { id: result.field }, message: result.message };
    showRefusal();
    // Une variable qui existe déjà : le focus va à son champ, pas à la ligne de création.
    const target = document.getElementById(result.focus ?? result.field);
    target?.focus();
    if (result.focus) target?.scrollIntoView({ block: "nearest" });
    return;
  }
  send(result.ops, { id: `add:${form.dataset.add === "addAgent" ? "key" : form.dataset.add === "addOption" ? "option" : "name"}` }, () => {
    ui.adding = undefined;
    if (result.select !== undefined) {
      ui.selected = result.select;
      if (form.dataset.add === "addAgent") ui.tab = "agents";
      resetScroll = true;
    }
    if (result.focus) pendingFocus = { id: result.focus };
  });
}

// --- Clics ----------------------------------------------------------------------------------------

function engineOf(agent: string, engine: string): ConfigView["agents"][number]["engines"][number] | undefined {
  return view?.agents.find((a) => a.key === agent)?.engines.find((e) => e.name === engine);
}

function parsePath(raw: string | undefined): (string | number)[] {
  try {
    const path: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(path) ? path.filter((item): item is string | number => typeof item === "string" || typeof item === "number") : [];
  } catch {
    return [];
  }
}

function parseValues(raw: string | undefined): string[] {
  try {
    const values: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(values) ? values.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function copyText(button: HTMLElement): Promise<void> {
  const value = text(button.dataset.text);
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    showNotice(`Copy was refused by the browser. Select it by hand: ${value}`);
    return;
  }
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    if (button.isConnected) button.textContent = label;
  }, 1200);
}

function onAction(button: HTMLElement): void {
  const d = button.dataset;
  const agent = text(d.agent);
  const engine = text(d.engine);
  const preset = text(d.preset);
  const action = text(d.action);
  const anchor = anchorOf(button);

  if (ADD_ACTIONS.has(action)) return startAdding(button);

  switch (action) {
    case "tab": {
      // « Edit providers… » ouvre le provider de l'engine, quand c'est un preset.
      const from = ui.menu;
      const used = from ? engineOf(from.agent, from.engine)?.provider : undefined;
      ui.tab = d.tab === "providers" || d.tab === "options" ? d.tab : "agents";
      ui.selected = ui.tab === "providers" && used?.kind === "preset" ? used.name : undefined;
      ui.menu = undefined;
      ui.adding = undefined;
      refusal = undefined;
      resetScroll = true;
      return render();
    }
    case "select":
      ui.selected = d.key;
      ui.menu = undefined;
      ui.adding = undefined;
      refusal = undefined;
      resetScroll = true;
      return render();
    case "groupBy":
      ui.groupBy = ui.groupBy === "harness" ? undefined : "harness";
      return render();
    case "openAgent":
      // Un badge « Used by » : la fiche de l'agent s'ouvre sur l'onglet Agents, sa rangée amenée dans la vue.
      ui.tab = "agents";
      ui.selected = d.key;
      ui.menu = undefined;
      ui.adding = undefined;
      refusal = undefined;
      resetScroll = true;
      // Le badge disparaît avec l'onglet : le focus passe à la première rangée de l'agent (correspondance partielle).
      pendingFocus = { data: { action: "select", key: text(d.key) } };
      render();
      return void root.querySelector('.side .row[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
    case "menu": {
      const kind = d.kind === "options" ? "options" : "provider";
      const open = ui.menu?.agent === agent && ui.menu.engine === engine && ui.menu.kind === kind;
      ui.menu = open ? undefined : { agent, engine, kind };
      pendingFocus = open ? { id: button.id } : { menuFirst: true };
      return render();
    }
    case "cancelAdd":
      return cancelAdding();
    case "dismissNotice":
      return hideNotice(true);
    case "copy":
      return void copyText(button);
    case "save":
      return saveNow();
    case "revert":
      return sendAction("/api/revert");
    case "reload":
      return sendAction("/api/reload");
    case "quote":
      return send({ op: "quoteValue", path: parsePath(d.path) }, anchor);
    case "unlink":
      return send({ op: "unlink", path: parsePath(d.path) }, anchor);
    case "duplicateAgent":
      return send({ op: "duplicateAgent", key: agent }, anchor, (before, after) => {
        // La copie est sélectionnée, son label prêt à être réécrit (spec §5).
        const copy = after.agents.find((a) => !before.agents.some((b) => b.key === a.key));
        if (!copy) return;
        ui.selected = copy.key;
        resetScroll = true;
        pendingFocus = { id: `agent:${copy.key}:label`, select: true };
      });
    case "deleteAgent":
      return send({ op: "deleteAgent", key: agent }, anchor, (before, after) => {
        // La sélection passe au voisin qui prend la place de l'agent retiré, dans l'ordre affiché.
        ui.selected = neighbourAfterDelete(shownKeys(before, ui), shownKeys(after, ui), agent);
        resetScroll = true;
      });
    case "deleteEngine":
      return send({ op: "deleteEngine", agent, engine }, anchor);
    case "makeDefault":
      return send({ op: "makeDefault", agent, engine }, anchor);
    case "removeMerge":
      return send({ op: "removeMerge", agent, engine }, anchor);
    case "deleteEnvVar":
      return send({ op: "deleteEnvVar", agent, engine, name: text(d.name) }, anchor);
    case "deletePreset":
      return send({ op: "deletePreset", name: preset }, anchor, () => {
        ui.selected = undefined;
        resetScroll = true;
      });
    case "deletePresetVar":
      return send({ op: "deletePresetVar", name: preset, varName: text(d.name) }, anchor);
    case "setProvider": {
      // Le menu se referme tout de suite, le focus revient au déclencheur ; un refus s'affiche sous lui.
      const kind = d.providerKind;
      const provider = kind === "preset" ? ({ kind: "preset", name: preset } as const) : kind === "custom" ? ({ kind: "custom" } as const) : ({ kind: "anthropic" } as const);
      ui.menu = undefined;
      pendingFocus = anchor;
      render();
      return send({ op: "setProvider", agent, engine, provider }, anchor, () => void (pendingFocus = anchor));
    }
    case "setOptions": {
      // Seuls les items de menu sont des boutons ; les jetons sont des champs, traités au `change`.
      const kind = d.optionsKind;
      const options =
        kind === "preset" ? ({ kind: "preset", name: preset } as const) : kind === "custom" ? ({ kind: "custom", values: parseValues(d.values) } as const) : ({ kind: "none" } as const);
      ui.menu = undefined;
      pendingFocus = anchor;
      render();
      return send({ op: "setOptions", agent, engine, options }, anchor, () => void (pendingFocus = anchor));
    }
    case "removeOption":
    case "moveOption": {
      const current = view?.presets.find((p) => p.name === preset)?.options ?? [];
      const changed = reorderOptions(current, action, Number(d.index), Number(d.dir));
      if (!changed) return;
      return send({ op: "setPresetOptions", name: preset, values: changed.values }, anchor, () => {
        // Un déplacement garde le focus sur la même option, à sa nouvelle place.
        if (action === "moveOption") pendingFocus = { data: { action, preset, index: String(changed.target), dir: d.dir ?? "1" } };
      });
    }
  }
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  // Un clic hors du menu ouvert le referme ; il garde son effet sur ce qui a été cliqué.
  let closed = false;
  if (ui.menu && !event.target.closest(".menu, [aria-haspopup]")) {
    ui.menu = undefined;
    closed = true;
  }
  let control: HTMLElement | null = event.target.closest<HTMLElement>("[data-action]");
  if (!(control instanceof HTMLButtonElement) || control.disabled) {
    if (closed) render();
    return;
  }
  if (closed) {
    // Le menu part avec un rendu : le contrôle cliqué se retrouve dans le nouveau DOM avant d'agir.
    const clicked = anchorOf(control);
    render();
    control = findAnchor(clicked);
    if (!(control instanceof HTMLButtonElement)) return;
  }
  onAction(control);
});

// --- Autres événements ----------------------------------------------------------------------------

document.addEventListener("change", (event) => {
  const el = event.target;
  if ((el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && el.dataset.action) {
    pending.commit(el.id);
    onFieldChange(el);
  }
});

// Sortir d'un champ sans `change` (le texte est revenu à l'original) ne laisse rien en attente.
// Si la fenêtre perd le focus, le champ garde sa saisie : `beforeunload` doit encore avertir.
document.addEventListener("focusout", (event) => {
  if (!document.hasFocus()) return;
  if (event.target instanceof HTMLInputElement && event.target.dataset.action) pending.commit(event.target.id);
});

document.addEventListener("input", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLInputElement) || !el.dataset.action) return;
  pending.input(el.id);
  syncToolbar();
  if (el.dataset.action === "renameAgent" || el.dataset.action === "renameEngine") followCommands();
});

document.addEventListener("submit", (event) => {
  if (!(event.target instanceof HTMLFormElement) || !event.target.matches("form.addrow")) return;
  event.preventDefault();
  submitAdding(event.target);
});

// Seul le bouton principal compte : un clic droit n'est suivi ni de `click` ni toujours de `pointerup`.
document.addEventListener("pointerdown", (event) => void (event.button === 0 && (pointerDown = true)), true);
function releasePointer(): void {
  if (!pointerDown) return;
  pointerDown = false;
  // Après le `click`, qui suit le relâchement dans la même tâche.
  if (renderDeferred) setTimeout(() => void (renderDeferred && !pointerDown && render()), 0);
}
document.addEventListener("pointerup", releasePointer, true);
document.addEventListener("pointercancel", releasePointer, true);
document.addEventListener("contextmenu", releasePointer, true);
window.addEventListener("blur", releasePointer);

/** Valide d'abord le champ en cours de saisie (son `change` part au `blur`), puis enregistre si le document est sale. */
function saveNow(): void {
  const active = document.activeElement;
  if ((active instanceof HTMLInputElement || active instanceof HTMLSelectElement) && active.dataset.action) {
    active.blur();
    active.focus();
  }
  // Le test de saleté se fait dans la file, une fois l'opération du champ passée.
  sendAction("/api/save");
}

/** Clavier d'un menu ouvert : flèches, Début, Fin ; Tab le referme et rend le focus au déclencheur. */
function onMenuKey(event: KeyboardEvent, menu: Element): void {
  const items = [...menu.querySelectorAll<HTMLElement>(".mi")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const move = (index: number): void => {
    event.preventDefault();
    items[(index + items.length) % items.length]?.focus();
  };
  if (event.key === "ArrowDown") move(at + 1);
  else if (event.key === "ArrowUp") move(at < 0 ? items.length - 1 : at - 1);
  else if (event.key === "Home") move(0);
  else if (event.key === "End") move(items.length - 1);
  else if (event.key === "Tab") {
    event.preventDefault();
    closeMenu();
  }
}

function closeMenu(): void {
  const open = ui.menu;
  if (!open) return;
  ui.menu = undefined;
  pendingFocus = { id: `agent:${open.agent}:engine:${open.engine}:${open.kind === "options" ? "options-menu" : "provider"}` };
  render();
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveNow();
    return;
  }
  if (event.key === "Escape") {
    if (ui.menu) {
      event.preventDefault();
      closeMenu();
    } else if (ui.adding) {
      event.preventDefault();
      cancelAdding();
    }
    return;
  }
  const menu = event.target instanceof Element ? event.target.closest(".menu") : null;
  if (menu) onMenuKey(event, menu);
});

window.addEventListener("beforeunload", (event) => {
  if (!view?.dirty && !pending.any) return;
  event.preventDefault();
  event.returnValue = "";
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && view) void refetch();
});

// --- Démarrage ------------------------------------------------------------------------------------

function showMissingToken(): void {
  root.innerHTML = '<div class="win"><header class="bar"><span class="prod">idnma configure</span></header><div class="body single"><main class="main empty"><p class="hint" role="alert"></p></main></div></div>';
  const message = root.querySelector(".hint");
  if (message) message.textContent = "This page needs the address printed by idnma configure, which includes its access token. Open that address again.";
}

function openEvents(): void {
  // Le flux ne porte aucune donnée : sa connexion dit au serveur que la page est ouverte.
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token ?? "")}`);
  let lost = false;
  events.onopen = () => {
    if (!lost) return;
    lost = false;
    hideNotice();
    void refetch();
  };
  events.onerror = () => {
    lost = true;
    showNotice(events.readyState === EventSource.CLOSED ? "idnma configure stopped. Run it again to keep editing." : "Connection to idnma configure lost. Retrying…");
  };
}

async function start(): Promise<void> {
  if (!token) return showMissingToken();
  const result = await call("GET", "/api/state");
  if (result.status === 403) return showMissingToken();
  if (result.status !== 200 || !result.body.view) return fail(result);
  view = result.body.view;
  render();
  openEvents();
}

void start();
