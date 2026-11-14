// Demandes en attente, ligne d'agent arrêté, palette, plan et réglages de l'écran unifié.
// Seul `src/tui/view/` importe OpenTUI. Tout texte venu de l'agent ou d'un pair passe par `plain()`.
import { BoxRenderable, type CliRenderer, InputRenderable, InputRenderableEvents, type Renderable, type TextareaRenderable, bold, fg, t } from "@opentui/core";
import type { CommandInfo, ConfigOption, PermissionRequest, PlanEntry } from "../../acp/events.ts";
import { HELD_CHOICES, type Pending, type SessionState } from "../state.ts";
import { ACCENT, LABEL, SURFACE } from "../theme.ts";
import { plain, text } from "./thread.ts";

export type OverlayKind = "palette" | "plan" | "settings";

const CLEAR = { backgroundColor: "transparent", shouldFill: false } as const;
const PALETTE_ROWS = 8;
const SETTINGS_MAX_ROWS = 18;
const NAME_COLUMNS = 22;

/** Première ligne seulement : une rangée de liste ne s'enroule pas. */
function firstLine(value: string): string {
  return plain(value).split("\n")[0] ?? "";
}

// ---- demande en attente et agent arrêté ----

function questionOf(state: SessionState, request: PermissionRequest): string {
  const hasToolRow = state.thread.some((item) => item.kind === "tool" && item.id === request.toolCallId);
  if (!hasToolRow) return plain(request.title);
  switch (request.kind) {
    case "execute":
      return "Allow this command?";
    case "edit":
      return "Allow this edit?";
    default:
      return "Allow this action?";
  }
}

/** Indice du choix que `esc` envoie : le premier `reject_once`, sinon le premier `reject_always`, sinon aucun. */
function escapeChoiceIndex(request: PermissionRequest): number {
  const once = request.choices.findIndex((choice) => choice.kind === "reject_once");
  return once >= 0 ? once : request.choices.findIndex((choice) => choice.kind === "reject_always");
}

function choiceRow(renderer: CliRenderer, label: string, selected: boolean, escapeChoice: boolean): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "space-between",
    flexShrink: 0,
    paddingLeft: 2,
    paddingRight: 1,
    ...(selected ? { backgroundColor: ACCENT.blue } : CLEAR),
  });
  row.add(text(renderer, label, selected ? LABEL.strong : LABEL.primary, { flexShrink: 1 }));
  row.add(text(renderer, selected ? "⏎" : escapeChoice ? "esc" : "", selected ? LABEL.strong : LABEL.tertiary, { marginLeft: 2, wrapMode: "none" }));
  return row;
}

function exitLine(exit: NonNullable<SessionState["exit"]>): string {
  const cause = exit.code !== null ? ` (code ${exit.code})` : exit.signal !== null ? ` (signal ${plain(exit.signal)})` : "";
  return `Agent exited${cause}. Press any key to leave.`;
}

export interface Tail {
  /** Reconstruit la queue du fil quand la demande, sa question ou l'arrêt de l'agent ont changé. */
  update(state: SessionState): void;
}

/** La queue du fil : la demande en attente (permission ou message retenu), ou la ligne d'agent arrêté. */
export function createTail(renderer: CliRenderer, mount: BoxRenderable): Tail {
  let shownPending: Pending | undefined;
  let shownQuestion: string | undefined;
  let shownExit: SessionState["exit"];

  function clear(): void {
    for (const child of mount.getChildren()) {
      mount.remove(child);
      child.destroyRecursively();
    }
  }

  function buildPermission(pending: Extract<Pending, { kind: "permission" }>, question: string): void {
    mount.add(text(renderer, question, LABEL.strong));
    const escapeIndex = escapeChoiceIndex(pending.request);
    pending.request.choices.forEach((choice, index) => mount.add(choiceRow(renderer, plain(choice.name), index === pending.selected, index === escapeIndex)));
  }

  function buildHeld(pending: Extract<Pending, { kind: "held" }>): void {
    const head = new BoxRenderable(renderer, { flexDirection: "row", justifyContent: "space-between", flexShrink: 0, ...CLEAR });
    head.add(text(renderer, t`${fg(ACCENT.yellow)("●")} ${bold(fg(LABEL.strong)("Message"))}  from ${plain(pending.from)}`, LABEL.primary, { flexShrink: 1 }));
    head.add(text(renderer, "held", LABEL.tertiary, { marginLeft: 2, wrapMode: "none" }));
    mount.add(head);
    mount.add(text(renderer, plain(pending.text), LABEL.secondary, { marginLeft: 2 }));
    const choices = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, marginTop: 1, ...CLEAR });
    HELD_CHOICES.forEach((choice, index) => choices.add(choiceRow(renderer, choice, index === pending.selected, choice === "Dismiss")));
    mount.add(choices);
  }

  return {
    update(state) {
      const pending = state.exit ? undefined : state.pending;
      const question = pending?.kind === "permission" ? questionOf(state, pending.request) : undefined;
      if (pending === shownPending && question === shownQuestion && state.exit === shownExit) return;
      shownPending = pending;
      shownQuestion = question;
      shownExit = state.exit;

      clear();
      if (state.exit) mount.add(text(renderer, exitLine(state.exit), ACCENT.red));
      else if (pending?.kind === "permission" && question !== undefined) buildPermission(pending, question);
      else if (pending?.kind === "held") buildHeld(pending);
      mount.visible = mount.getChildrenCount() > 0;
    },
  };
}

// ---- palette, plan, réglages ----

export interface Overlays {
  open(kind: OverlayKind): void;
  close(): void;
  kind(): OverlayKind | undefined;
  /** Déplace la sélection de la palette ou des réglages ; sans effet ailleurs. */
  move(delta: 1 | -1): void;
  paletteChoice(): CommandInfo | undefined;
  /** Texte de la saisie de la palette (barre oblique comprise), `undefined` quand elle est fermée. */
  paletteText(): string | undefined;
  /** Texte de la rangée de saisie qui a remplacé le textarea : celui de la palette ou le filtre des réglages ; `undefined` sinon. */
  typedText(): string | undefined;
  /**
   * ⇥ : ferme la palette et met `/<nom> ` dans la saisie, curseur au bout, pour y taper les arguments. Sans effet si
   * la palette est fermée ou ne filtre rien.
   */
  complete(): void;
  settingsChoice(): { category: string; value: string } | undefined;
  /** Aligne l'overlay ouvert sur l'état (commandes, options, plan). */
  sync(state: SessionState): void;
}

interface OverlayOptions {
  renderer: CliRenderer;
  /** Rangée de saisie : la palette y prend la place du textarea. */
  inputBox: BoxRenderable;
  textarea: TextareaRenderable;
  /** Appelé à chaque ouverture ou fermeture (la ligne d'état en dépend). */
  onChange(): void;
}

/** Noms qui commencent par le texte d'abord, puis ceux qui le contiennent, chaque groupe dans l'ordre de l'agent. */
function filterCommands(commands: CommandInfo[], filter: string): CommandInfo[] {
  const needle = filter.toLowerCase();
  if (needle === "") return commands;
  const starting = commands.filter((command) => command.name.toLowerCase().startsWith(needle));
  const containing = commands.filter((command) => !starting.includes(command) && command.name.toLowerCase().includes(needle));
  return [...starting, ...containing];
}

const SECTIONS = [
  { category: "model", title: "Model" },
  { category: "thought_level", title: "Effort" },
  { category: "mode", title: "Mode" },
] as const;

export type SettingsEntry = { kind: "title"; label: string } | { kind: "value"; category: string; value: string; name: string; current: boolean };

export function settingsEntries(options: ConfigOption[]): SettingsEntry[] {
  const entries: SettingsEntry[] = [];
  for (const section of SECTIONS) {
    const option = options.find((candidate) => candidate.category === section.category);
    if (!option) continue;
    entries.push({ kind: "title", label: section.title });
    for (const value of option.values) entries.push({ kind: "value", category: section.category, value: value.value, name: value.name, current: value.value === option.currentValue });
  }
  return entries;
}

/**
 * Filtre des réglages, sans tenir compte de la casse : un choix reste s'il contient le texte dans son nom ou sa valeur,
 * un titre de section qui le contient garde toute sa section. Dans chaque section, les noms qui commencent par le texte
 * passent d'abord ; une section sans correspondance disparaît avec son titre.
 */
export function filterSettings(entries: SettingsEntry[], filter: string): SettingsEntry[] {
  const needle = filter.toLowerCase();
  if (needle === "") return entries;
  const kept: SettingsEntry[] = [];
  let title: Extract<SettingsEntry, { kind: "title" }> | undefined;
  let section: Array<Extract<SettingsEntry, { kind: "value" }>> = [];
  const flush = (): void => {
    if (title && section.length > 0) {
      const starting = section.filter((entry) => entry.name.toLowerCase().startsWith(needle));
      kept.push(title, ...starting, ...section.filter((entry) => !starting.includes(entry)));
    }
    section = [];
  };
  let wholeSection = false;
  for (const entry of entries) {
    if (entry.kind === "title") {
      flush();
      title = entry;
      wholeSection = entry.label.toLowerCase().includes(needle);
    } else if (wholeSection || entry.name.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle)) {
      section.push(entry);
    }
  }
  flush();
  return kept;
}

export function createOverlays(o: OverlayOptions): Overlays {
  const { renderer, inputBox, textarea } = o;

  let current: OverlayKind | undefined;
  let commands: CommandInfo[] = [];
  let options: ConfigOption[] = [];
  let plan: PlanEntry[] = [];
  let listBox: BoxRenderable | undefined;
  let planBox: BoxRenderable | undefined;
  let selected = 0;
  let offset = 0;
  let settingsKey: { category: string; value: string } | undefined;
  /** Vrai pendant une écriture du programme dans la saisie de la palette : l'événement n'est pas une frappe. */
  let writing = false;

  const paletteInput = new InputRenderable(renderer, {
    id: "palette-input",
    flexGrow: 1,
    visible: false,
    wrapMode: "none",
    textColor: LABEL.strong,
    backgroundColor: SURFACE.input,
    focusedBackgroundColor: SURFACE.input,
    // Les réglages y ouvrent un filtre vide, sans barre oblique : le texte de remplacement le dit tant qu'il est vide.
    placeholder: "Filter",
    placeholderColor: LABEL.disabled,
  });
  inputBox.add(paletteInput);

  const matches = (): CommandInfo[] => filterCommands(commands, paletteInput.value.replace(/^\//, ""));
  /** Les entrées des réglages que le filtre laisse voir ; toutes tant que le panneau n'est pas ouvert. */
  const shownEntries = (): SettingsEntry[] => filterSettings(settingsEntries(options), current === "settings" ? paletteInput.value : "");
  const values = (): Array<Extract<SettingsEntry, { kind: "value" }>> => shownEntries().filter((entry): entry is Extract<SettingsEntry, { kind: "value" }> => entry.kind === "value");

  // ---- liste commune à la palette et aux réglages ----

  function mountList(): BoxRenderable {
    const box = new BoxRenderable(renderer, { id: "overlay-list", flexDirection: "column", flexShrink: 0, backgroundColor: SURFACE.popover });
    // Entre le fil et la saisie : devant la rangée de saisie dans la racine.
    renderer.root.add(box, renderer.root.getChildren().indexOf(inputBox));
    return box;
  }

  function emptyList(box: BoxRenderable): void {
    for (const child of box.getChildren()) {
      box.remove(child);
      child.destroyRecursively();
    }
  }

  /**
   * Garde les rangées `first` (borne haute : un titre de section) et `last` (la rangée sélectionnée) dans la fenêtre
   * de `max` rangées, `max` valant au moins 2 ; rend l'indice de la première rangée visible.
   */
  function windowStart(total: number, first: number, last: number, max: number): number {
    let start = Math.min(offset, Math.max(total - max, 0));
    if (first < start) start = first;
    if (last >= start + max) start = last - max + 1;
    offset = start;
    return start;
  }

  /** Commande choisie (⇥ ou clic sur sa rangée) : la saisie la reçoit, elle ne part pas. */
  function completeWith(command: CommandInfo | undefined): void {
    if (current !== "palette" || command === undefined) return;
    close();
    textarea.setText(`/${firstLine(command.name)} `);
    textarea.gotoBufferEnd();
  }

  function paletteRow(command: CommandInfo, isSelected: boolean): Renderable {
    const row = new BoxRenderable(renderer, {
      flexDirection: "row",
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      ...(isSelected ? { backgroundColor: ACCENT.blue } : CLEAR),
      onMouseDown: (event) => {
        // Pas de début de sélection de texte : la rangée disparaît avec la palette.
        event.preventDefault();
        completeWith(command);
      },
    });
    row.add(text(renderer, `/${firstLine(command.name)}`.padEnd(NAME_COLUMNS), LABEL.strong, { flexShrink: 0, wrapMode: "none" }));
    row.add(text(renderer, firstLine(command.description), isSelected ? LABEL.strong : LABEL.secondary, { flexShrink: 1, wrapMode: "none" }));
    return row;
  }

  function renderPalette(): void {
    if (!listBox) return;
    emptyList(listBox);
    const found = matches();
    selected = Math.min(selected, Math.max(found.length - 1, 0));
    const start = windowStart(found.length, selected, selected, PALETTE_ROWS);
    found.slice(start, start + PALETTE_ROWS).forEach((command, index) => listBox?.add(paletteRow(command, start + index === selected)));
  }

  function settingsRow(entry: SettingsEntry, isSelected: boolean): Renderable {
    if (entry.kind === "title") {
      const row = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, paddingLeft: 1, paddingRight: 1, ...CLEAR });
      row.add(text(renderer, entry.label, LABEL.secondary, { wrapMode: "none" }));
      return row;
    }
    const row = new BoxRenderable(renderer, { flexDirection: "row", justifyContent: "space-between", flexShrink: 0, paddingLeft: 3, paddingRight: 1, ...(isSelected ? { backgroundColor: ACCENT.blue } : CLEAR) });
    row.add(text(renderer, firstLine(entry.name), isSelected ? LABEL.strong : LABEL.primary, { flexShrink: 1, wrapMode: "none" }));
    row.add(text(renderer, entry.current ? "✓" : "", isSelected ? LABEL.strong : LABEL.secondary, { marginLeft: 2, wrapMode: "none" }));
    return row;
  }

  function renderSettings(): void {
    if (!listBox) return;
    emptyList(listBox);
    const entries = shownEntries();
    const all = values();
    if (all.length === 0) {
      selected = 0;
      settingsKey = undefined;
      const offered = settingsEntries(options).length > 0;
      listBox.add(text(renderer, offered ? "No matching settings" : "No settings available", LABEL.tertiary, { paddingLeft: 1 }));
      return;
    }
    // La sélection suit sa valeur quand les options changent ; sinon elle retombe sur la première.
    const kept = settingsKey ? all.findIndex((entry) => entry.category === settingsKey?.category && entry.value === settingsKey?.value) : -1;
    selected = kept >= 0 ? kept : Math.min(selected, all.length - 1);
    const choice = all[selected];
    settingsKey = choice && { category: choice.category, value: choice.value };

    const selectedRow = entries.findIndex((entry) => entry.kind === "value" && entry.category === choice?.category && entry.value === choice?.value);
    // Le premier choix d'une section garde son titre dans la fenêtre.
    const focus = entries[selectedRow - 1]?.kind === "title" ? selectedRow - 1 : selectedRow;
    // Tout tient d'ordinaire ; sur un terminal bas, la fenêtre laisse de la place au fil et à la saisie.
    const settingsRows = Math.max(4, Math.min(SETTINGS_MAX_ROWS, renderer.height - 8));
    const start = windowStart(entries.length, focus, selectedRow, settingsRows);
    entries.slice(start, start + settingsRows).forEach((entry, index) => listBox?.add(settingsRow(entry, start + index === selectedRow)));
  }

  function renderPlan(): void {
    if (!planBox) return;
    for (const child of planBox.getChildren()) {
      planBox.remove(child);
      child.destroyRecursively();
    }
    planBox.add(text(renderer, t`${bold("Plan")}`, LABEL.secondary));
    if (plan.length === 0) planBox.add(text(renderer, "No plan yet", LABEL.tertiary));
    for (const entry of plan) {
      const content = plain(entry.content);
      if (entry.status === "completed") planBox.add(text(renderer, t`${fg(LABEL.disabled)("✓")} ${content}`, LABEL.tertiary));
      else if (entry.status === "in_progress") planBox.add(text(renderer, t`${fg(ACCENT.green)("●")} ${content}`, LABEL.strong));
      else planBox.add(text(renderer, t`${fg(LABEL.disabled)("○")} ${content}`, LABEL.primary));
    }
  }

  // ---- palette : la saisie prend la place du textarea ----

  paletteInput.on(InputRenderableEvents.INPUT, () => {
    if (writing) return;
    // Réglages : chaque frappe renvoie la sélection sur la première correspondance.
    if (current === "settings") {
      selected = 0;
      offset = 0;
      settingsKey = undefined;
      renderSettings();
      return;
    }
    if (current !== "palette") return;
    // Effacer le `/` ferme la palette.
    if (!paletteInput.value.startsWith("/")) {
      close();
      return;
    }
    selected = 0;
    offset = 0;
    renderPalette();
  });

  /** La saisie prend la place du textarea, avec `initial` dedans : `/` pour la palette, rien pour le filtre des réglages. */
  function takeInputRow(initial: string): void {
    textarea.blur();
    textarea.visible = false;
    writing = true;
    paletteInput.value = initial;
    writing = false;
    paletteInput.visible = true;
    paletteInput.focus();
    paletteInput.gotoBufferEnd();
  }

  function openPalette(): void {
    takeInputRow("/");
    selected = 0;
    offset = 0;
    listBox = mountList();
    renderPalette();
  }

  function closePalette(): void {
    paletteInput.blur();
    paletteInput.visible = false;
    textarea.visible = true;
    textarea.focus();
  }

  function openSettings(): void {
    takeInputRow("");
    const all = values();
    const model = all.findIndex((entry) => entry.category === "model" && entry.current);
    selected = Math.max(model, 0);
    settingsKey = undefined;
    offset = 0;
    listBox = mountList();
    renderSettings();
  }

  function openPlan(): void {
    planBox = new BoxRenderable(renderer, {
      id: "plan-panel",
      position: "absolute",
      // Comme la maquette, où `top: 2` se compte depuis le haut du fil (rangée 1 de l'écran) : rangée 3.
      top: 3,
      right: 0,
      width: 42,
      flexDirection: "column",
      backgroundColor: SURFACE.popover,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      zIndex: 10,
    });
    renderer.root.add(planBox);
    renderPlan();
  }

  function close(): void {
    if (current === undefined) return;
    const was = current;
    current = undefined;
    if (was === "palette" || was === "settings") closePalette();
    if (listBox) {
      renderer.root.remove(listBox);
      listBox.destroyRecursively();
      listBox = undefined;
    }
    if (planBox) {
      renderer.root.remove(planBox);
      planBox.destroyRecursively();
      planBox = undefined;
    }
    o.onChange();
  }

  return {
    open(kind) {
      if (current === kind) return;
      close();
      current = kind;
      if (kind === "palette") openPalette();
      else if (kind === "settings") openSettings();
      else openPlan();
      o.onChange();
    },
    close,
    kind: () => current,
    move(delta) {
      if (current === "palette") {
        selected = Math.min(Math.max(selected + delta, 0), Math.max(matches().length - 1, 0));
        renderPalette();
      } else if (current === "settings") {
        const all = values();
        const index = Math.min(Math.max(selected + delta, 0), Math.max(all.length - 1, 0));
        const next = all[index];
        selected = index;
        settingsKey = next && { category: next.category, value: next.value };
        renderSettings();
      }
    },
    paletteChoice: () => (current === "palette" ? matches()[selected] : undefined),
    paletteText: () => (current === "palette" ? paletteInput.value : undefined),
    typedText: () => (current === "palette" || current === "settings" ? paletteInput.value : undefined),
    complete: () => completeWith(current === "palette" ? matches()[selected] : undefined),
    settingsChoice: () => {
      if (current !== "settings") return undefined;
      const choice = values()[selected];
      return choice && { category: choice.category, value: choice.value };
    },
    sync(state) {
      const changed = { commands: state.commands !== commands, options: state.options !== options, plan: state.plan !== plan };
      commands = state.commands;
      options = state.options;
      plan = state.plan;
      if (current === "palette" && changed.commands) renderPalette();
      else if (current === "settings" && changed.options) renderSettings();
      else if (current === "plan" && changed.plan) renderPlan();
    },
  };
}
