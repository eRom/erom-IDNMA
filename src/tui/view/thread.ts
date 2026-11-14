// Fil de l'écran unifié : une boîte défilante dont chaque item de `SessionState.thread` a sa rangée.
// Les items sont indexés ; un `update` ne reconstruit que ceux dont la référence a changé (le réducteur
// garde les références des items inchangés). Seul `src/tui/view/` importe OpenTUI.
import { BoxRenderable, type CliRenderer, MarkdownRenderable, type Renderable, ScrollBoxRenderable, type StyledText, type SyntaxStyle, TextRenderable, bold, fg, t } from "@opentui/core";
import type { SessionState, ThreadItem } from "../state.ts";
import { truncateLines } from "../format.ts";
import { ACCENT, LABEL, SURFACE } from "../theme.ts";

const DIFF_LINES = 12;
const OUTPUT_LINES = 5;
const THOUGHT_LINES = 3;

type ToolItem = Extract<ThreadItem, { kind: "tool" }>;

export interface Thread {
  readonly scroll: ScrollBoxRenderable;
  /** Dernier enfant de la boîte défilante, après les items : demande en attente ou ligne d'agent arrêté. Masqué tant qu'il est vide. */
  readonly tail: BoxRenderable;
  /** Aligne les rangées sur l'état : reconstruit les items changés, rafraîchit points et durées en place. */
  update(state: SessionState): void;
  /** Rafraîchit les durées des outils en cours (appelé chaque seconde par l'écran). */
  tick(): void;
  /** Vrai tant qu'une rangée d'outil en cours affiche une durée. */
  hasRunningTools(): boolean;
}

interface Env {
  pendingToolId: string | undefined;
  now: number;
}

interface ItemView {
  source: ThreadItem;
  root: Renderable;
  /** Met à jour l'item en place ; absent quand l'item se reconstruit. */
  updateInPlace?(item: ThreadItem): boolean;
  /** Points et durées : dépendent de l'environnement, pas seulement de l'item. */
  refresh?(env: Env): void;
}

const CLEAR = { backgroundColor: "transparent", shouldFill: false } as const;

/** Retire les séquences d'échappement et les caractères de contrôle : une sortie d'outil ne doit pas piloter le terminal. */
export function plain(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function text(renderer: CliRenderer, content: StyledText | string, color: string, extra: Record<string, unknown> = {}): TextRenderable {
  return new TextRenderable(renderer, { content, fg: color, flexShrink: 0, wrapMode: "word", ...extra });
}

function hiddenCount(renderer: CliRenderer, hidden: number): TextRenderable {
  return text(renderer, `… ${hidden} more ${hidden === 1 ? "line" : "lines"}`, LABEL.tertiary, { marginLeft: 2 });
}

function column(renderer: CliRenderer, id: string, marginTop: number): BoxRenderable {
  return new BoxRenderable(renderer, { id, flexDirection: "column", flexShrink: 0, marginTop, ...CLEAR });
}

/** Nombre de lignes de texte (saut de ligne final ignoré) : la troncature compte les lignes, pas les rangées enroulées. */
function textLines(value: string): string[] {
  const lines = plain(value).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function dotColor(item: ToolItem, pendingToolId: string | undefined): string {
  if (item.id === pendingToolId) return ACCENT.yellow;
  switch (item.status) {
    case "pending":
    case "in_progress":
      return ACCENT.green;
    case "failed":
      return ACCENT.red;
    case "completed":
    case "cancelled":
      return LABEL.disabled;
  }
}

function isRunning(item: ToolItem): boolean {
  return item.status === "pending" || item.status === "in_progress";
}

// ---- items ----

function buildUser(renderer: CliRenderer, id: string, marginTop: number, item: Extract<ThreadItem, { kind: "user" }>): ItemView {
  const root = new BoxRenderable(renderer, { id, flexDirection: "row", flexShrink: 0, marginTop, backgroundColor: SURFACE.userRow });
  root.add(text(renderer, "❯ ", LABEL.tertiary, { wrapMode: "none" }));
  root.add(text(renderer, plain(item.text), LABEL.strong, { flexShrink: 1, flexGrow: 1 }));
  return { source: item, root };
}

function buildPeer(renderer: CliRenderer, id: string, marginTop: number, item: Extract<ThreadItem, { kind: "peer" }>): ItemView {
  const root = column(renderer, id, marginTop);
  root.add(text(renderer, t`${bold(fg(LABEL.strong)("Message"))}  from ${plain(item.from)}`, LABEL.primary));
  root.add(text(renderer, plain(item.text), LABEL.secondary, { marginLeft: 2 }));
  return { source: item, root };
}

function buildAgent(renderer: CliRenderer, syntaxStyle: SyntaxStyle, id: string, marginTop: number, item: Extract<ThreadItem, { kind: "agent" }>): ItemView {
  const markdown = new MarkdownRenderable(renderer, { id, content: item.text, syntaxStyle, streaming: item.streaming, fg: LABEL.primary, flexShrink: 0, marginTop });
  return {
    source: item,
    root: markdown,
    updateInPlace(next) {
      if (next.kind !== "agent") return false;
      if (markdown.content !== next.text) markdown.content = next.text;
      if (markdown.streaming !== next.streaming) markdown.streaming = next.streaming;
      this.source = next;
      return true;
    },
  };
}

function buildThought(renderer: CliRenderer, id: string, marginTop: number, item: Extract<ThreadItem, { kind: "thought" }>): ItemView {
  const root = column(renderer, id, marginTop);
  const lines = textLines(item.text);
  const { shown, hidden } = item.done ? truncateLines(lines, THOUGHT_LINES) : { shown: lines, hidden: 0 };
  root.add(text(renderer, shown.join("\n"), LABEL.tertiary));
  if (hidden > 0) root.add(hiddenCount(renderer, hidden));
  return { source: item, root };
}

function buildNotice(renderer: CliRenderer, id: string, marginTop: number, item: Extract<ThreadItem, { kind: "notice" }>): ItemView {
  const root = column(renderer, id, marginTop);
  root.add(text(renderer, plain(item.text), item.tone === "error" ? ACCENT.red : LABEL.tertiary));
  return { source: item, root };
}

/** Une ligne de diff : `+` sur le fond des lignes ajoutées, `−` en rouge sans fond, le texte en retrait de deux colonnes. */
function diffRow(renderer: CliRenderer, line: string): BoxRenderable {
  const sign = line.slice(0, 1);
  const body = plain(line.slice(1));
  const added = sign === "+";
  const row = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, paddingLeft: 2, ...(added ? { backgroundColor: SURFACE.addedRow } : CLEAR) });
  const signColor = added ? ACCENT.green : ACCENT.red;
  row.add(text(renderer, `${sign} `, signColor, { wrapMode: "none" }));
  row.add(text(renderer, body, added ? LABEL.primary : LABEL.secondary, { flexShrink: 1, flexGrow: 1 }));
  return row;
}

function buildTool(renderer: CliRenderer, id: string, marginTop: number, item: ToolItem, seenAt: (id: string) => number | undefined): ItemView {
  const root = column(renderer, id, marginTop);
  const head = new BoxRenderable(renderer, { flexDirection: "row", justifyContent: "space-between", flexShrink: 0, ...CLEAR });
  const title = plain(item.title.split("\n")[0] ?? "");
  const headContent = (color: string) => t`${fg(color)("●")} ${bold(fg(LABEL.strong)(plain(item.name)))}  ${title}`;
  const left = text(renderer, headContent(LABEL.disabled), LABEL.primary, { flexShrink: 1 });
  const right = text(renderer, "", LABEL.tertiary, { marginLeft: 2, wrapMode: "none" });
  head.add(left);
  head.add(right);
  root.add(head);

  if (item.diff) {
    const { shown, hidden } = truncateLines(item.diff.lines, DIFF_LINES);
    for (const line of shown) root.add(diffRow(renderer, line));
    if (hidden > 0) root.add(hiddenCount(renderer, hidden));
  } else if (item.output) {
    const { shown, hidden } = truncateLines(item.output.flatMap((entry) => plain(entry).split("\n")), OUTPUT_LINES);
    for (const line of shown) root.add(text(renderer, line, LABEL.secondary, { marginLeft: 2 }));
    if (hidden > 0) root.add(hiddenCount(renderer, hidden));
  }

  let shownColor: string | undefined;
  let shownMeta: string | undefined;
  return {
    source: item,
    root,
    refresh(env) {
      const color = dotColor(item, env.pendingToolId);
      if (color !== shownColor) {
        left.content = headContent(color);
        shownColor = color;
      }
      const started = seenAt(item.id);
      const meta = item.meta !== "" ? item.meta : isRunning(item) && item.id !== env.pendingToolId && started !== undefined ? `${Math.max(0, Math.floor((env.now - started) / 1000))}s` : "";
      if (meta !== shownMeta) {
        right.content = meta;
        shownMeta = meta;
      }
    },
  };
}

// ---- fil ----

export function createThread(renderer: CliRenderer, syntaxStyle: SyntaxStyle, now: () => number): Thread {
  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    backgroundColor: "transparent",
    contentOptions: { paddingLeft: 1, paddingRight: 1, paddingTop: 1 },
    scrollbarOptions: { showArrows: false, visible: false },
  });

  // La queue reste le dernier enfant : les items s'insèrent à leur index, donc devant elle.
  const tail = new BoxRenderable(renderer, { id: "thread-tail", flexDirection: "column", flexShrink: 0, marginTop: 1, visible: false, ...CLEAR });
  scroll.add(tail);

  const views: ItemView[] = [];
  const firstSeen = new Map<string, number>();
  let pendingToolId: string | undefined;
  let placeholder: TextRenderable | undefined;

  const seenAt = (id: string): number | undefined => firstSeen.get(id);

  function build(thread: ThreadItem[], index: number): ItemView {
    const item = thread[index]!;
    const id = `thread-item-${index}`;
    const previous = thread[index - 1];
    // Une ligne vide entre deux items, aucune entre deux rangées d'outil (le diff reste collé à sa rangée).
    const marginTop = index === 0 || (item.kind === "tool" && previous?.kind === "tool") ? 0 : 1;
    switch (item.kind) {
      case "user":
        return buildUser(renderer, id, marginTop, item);
      case "peer":
        return buildPeer(renderer, id, marginTop, item);
      case "agent":
        return buildAgent(renderer, syntaxStyle, id, marginTop, item);
      case "thought":
        return buildThought(renderer, id, marginTop, item);
      case "tool":
        return buildTool(renderer, id, marginTop, item, seenAt);
      case "notice":
        return buildNotice(renderer, id, marginTop, item);
    }
  }

  function drop(view: ItemView): void {
    scroll.remove(view.root);
    view.root.destroyRecursively();
  }

  function refreshAll(now: number): void {
    for (const view of views) view.refresh?.({ pendingToolId, now });
  }

  return {
    scroll,
    tail,
    update(state) {
      pendingToolId = state.pending?.kind === "permission" ? state.pending.request.toolCallId : undefined;
      const items = state.thread;

      // Première apparition d'un outil en cours : l'horloge de sa durée démarre là.
      const clock = now();
      const running = new Set<string>();
      for (const item of items) {
        if (item.kind === "tool" && isRunning(item)) {
          running.add(item.id);
          if (!firstSeen.has(item.id)) firstSeen.set(item.id, clock);
        }
      }
      for (const id of firstSeen.keys()) if (!running.has(id)) firstSeen.delete(id);

      while (views.length > items.length) drop(views.pop()!);
      items.forEach((item, index) => {
        const view = views[index];
        if (view?.source === item) return;
        if (view?.updateInPlace?.(item)) return;
        const next = build(items, index);
        if (view) {
          scroll.remove(view.root);
          scroll.add(next.root, index);
          view.root.destroyRecursively();
          views[index] = next;
        } else {
          scroll.add(next.root, index);
          views.push(next);
        }
      });

      if (items.length === 0 && placeholder === undefined) {
        placeholder = text(renderer, "New session", LABEL.tertiary, { id: "thread-empty" });
        scroll.add(placeholder, 0);
      } else if (items.length > 0 && placeholder !== undefined) {
        scroll.remove(placeholder);
        placeholder.destroyRecursively();
        placeholder = undefined;
      }
      refreshAll(clock);
    },
    tick() {
      refreshAll(now());
    },
    hasRunningTools() {
      return firstSeen.size > 0;
    },
  };
}
