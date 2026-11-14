// Modèle d'état de l'écran unifié : un réducteur pur, sans rendu ni E/S.
// La vue (src/tui/view/) lit `SessionState` et ne l'écrit jamais autrement que par `reduce`.
import type { AgentEvent, CommandInfo, ConfigOption, PermissionRequest, PlanEntry, ToolStatus } from "../acp/events.ts";

export type Status = "idle" | "running" | "waiting" | "exited";

export type ThreadItem =
  | { kind: "user"; text: string }
  | { kind: "peer"; from: string; text: string }
  | { kind: "agent"; text: string; streaming: boolean }
  | { kind: "thought"; text: string; done: boolean }
  | { kind: "tool"; id: string; name: string; title: string; status: ToolStatus; meta: string; diff?: { path: string; lines: string[] }; output?: string[]; outputText?: string; toolKind?: string }
  | { kind: "notice"; text: string; tone: "info" | "error" };

/** Choix du message retenu, dans l'ordre du design §6.3. */
export const HELD_CHOICES = ["Deliver", "Later", "Dismiss"] as const;

export type Pending = { kind: "permission"; request: PermissionRequest; selected: number } | { kind: "held"; from: string; text: string; selected: number };

export interface SessionState {
  name: string;
  status: Status;
  thread: ThreadItem[];
  pending?: Pending;
  options: ConfigOption[];
  commands: CommandInfo[];
  plan: PlanEntry[];
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
  localQueue: string[];
  heldCount: number;
  interrupted: boolean;
  turnActive: boolean;
  exit?: { code: number | null; signal: string | null };
}

export type Action =
  | { type: "event"; event: AgentEvent; origin: "replay" | "live" }
  | { type: "userPrompt"; text: string }
  | { type: "turnStarted" }
  /** `failed` : le tour s'est arrêté sur une erreur déjà annoncée dans le fil, il n'a pas été interrompu par Romain. */
  | { type: "turnEnded"; stopReason: string; failed?: boolean }
  | { type: "peerTurn"; from: string; text: string }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permissionResolved" }
  | { type: "held"; from: string; text: string; queued: number }
  | { type: "heldResolved"; queued: number }
  | { type: "heldCount"; queued: number }
  | { type: "select"; delta: 1 | -1 }
  | { type: "notice"; text: string; tone: "info" | "error" }
  | { type: "agentExited"; code: number | null; signal: string | null };

type ToolItem = Extract<ThreadItem, { kind: "tool" }>;
type ToolEvent = Extract<AgentEvent, { type: "tool" }>;

export function initialState(name: string): SessionState {
  return { name, status: "idle", thread: [], options: [], commands: [], plan: [], localQueue: [], heldCount: 0, interrupted: false, turnActive: false };
}

/** Le statut se déduit toujours du reste de l'état : `exited` est collant, puis permission/retenu en attente, puis tour actif. */
function derive(state: SessionState): SessionState {
  const status: Status = state.exit ? "exited" : state.pending ? "waiting" : state.turnActive ? "running" : "idle";
  return status === state.status ? state : { ...state, status };
}

/** Ferme le Markdown et la réflexion en cours, sans recréer les items déjà fermés. */
function closeOpen(thread: ThreadItem[]): ThreadItem[] {
  if (!thread.some((item) => (item.kind === "agent" && item.streaming) || (item.kind === "thought" && !item.done))) return thread;
  return thread.map((item) => {
    if (item.kind === "agent" && item.streaming) return { ...item, streaming: false };
    if (item.kind === "thought" && !item.done) return { ...item, done: true };
    return item;
  });
}

function appendItem(state: SessionState, item: ThreadItem): SessionState {
  return { ...state, thread: [...closeOpen(state.thread), item] };
}

function withoutPending(state: SessionState, kind: Pending["kind"]): SessionState {
  if (state.pending?.kind !== kind) return state;
  const { pending: _dropped, ...rest } = state;
  return rest;
}

// ---- outils ----

const MINUS = "−"; // U+2212, le signe de la maquette

/** Découpe en lignes en ignorant le saut de ligne final (il ne démarre pas une ligne de plus). */
function splitLines(text: string | undefined): string[] {
  if (text === undefined || text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Lignes `−` puis `+` d'un diff, sans les lignes communes en tête et en queue. */
function diffLines(oldText: string | undefined, newText: string): { lines: string[]; added: number; removed: number } {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const removed = before.slice(start, endBefore).map((line) => MINUS + line);
  const added = after.slice(start, endAfter).map((line) => `+${line}`);
  return { lines: [...removed, ...added], added: added.length, removed: removed.length };
}

/** Texte de sortie porté par un événement : la sortie brute, sinon les contenus texte joints. */
function outputSource(event: ToolEvent): string {
  return event.rawOutput ?? (event.content ?? []).flatMap((item) => (item.kind === "text" ? [item.text] : [])).join("\n");
}

function toolRow(event: ToolEvent, base?: ToolItem): ToolItem {
  const toolKind = event.kind ?? base?.toolKind;
  const row: ToolItem = {
    kind: "tool",
    id: event.id,
    name: event.name ?? base?.name ?? event.kind ?? "Tool",
    title: event.title ?? base?.title ?? "",
    status: event.status ?? base?.status ?? "pending",
    meta: base?.meta ?? "",
  };
  if (toolKind !== undefined) row.toolKind = toolKind;
  if (base?.diff) row.diff = base.diff;
  if (base?.output) row.output = base.output;
  if (base?.outputText !== undefined) row.outputText = base.outputText;
  if (event.content === undefined && event.rawOutput === undefined && event.outputDelta === undefined) return row;

  const diffItem = event.content?.find((item) => item.kind === "diff");
  let diffCounts: { added: number; removed: number } | undefined;
  if (diffItem?.kind === "diff") {
    const { lines, added, removed } = diffLines(diffItem.oldText, diffItem.newText);
    row.diff = { path: diffItem.path, lines };
    diffCounts = { added, removed };
  }
  const received = outputSource(event);
  let lines = splitLines(received);
  if (toolKind === "execute") {
    // Le texte brut s'accumule : une sortie non vide reçue ensuite le remplace, un contenu vide ne le remet pas à zéro.
    if (lines.length > 0) row.outputText = received;
    else if (event.outputDelta !== undefined) row.outputText = (row.outputText ?? "") + event.outputDelta;
    lines = splitLines(row.outputText);
    if (lines.length > 0) row.output = lines;
  }
  if (diffCounts) row.meta = `+${diffCounts.added} ${MINUS}${diffCounts.removed}`;
  else if (lines.length > 0 && !row.diff) row.meta = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  return row;
}

function applyTool(state: SessionState, event: ToolEvent): SessionState {
  const bare = event.name === undefined && event.title === undefined && event.kind === undefined && event.status === undefined && event.content === undefined && event.rawOutput === undefined && event.outputDelta === undefined;
  if (!event.created && bare) return state; // mise à jour de métadonnées seules (Claude)
  const index = state.thread.findIndex((item) => item.kind === "tool" && item.id === event.id);
  const existing = index >= 0 ? state.thread[index] : undefined;
  if (existing?.kind === "tool") {
    const thread = state.thread.slice();
    thread[index] = toolRow(event, existing);
    return { ...state, thread };
  }
  return appendItem(state, toolRow(event));
}

// ---- événements ----

function applyChunk(state: SessionState, event: Extract<AgentEvent, { type: "chunk" }>, origin: "replay" | "live"): SessionState {
  const last = state.thread.at(-1);
  const replaceLast = (item: ThreadItem): SessionState => ({ ...state, thread: [...state.thread.slice(0, -1), item] });
  switch (event.role) {
    case "user":
      if (origin === "live") return state; // l'écho en direct d'agy : déjà affiché par `userPrompt` ou `peerTurn`
      return appendItem(state, { kind: "user", text: event.text }); // agy rejoue un chunk par message utilisateur
    case "agent":
      return last?.kind === "agent" && last.streaming ? replaceLast({ ...last, text: last.text + event.text }) : appendItem(state, { kind: "agent", text: event.text, streaming: true });
    case "thought":
      return last?.kind === "thought" && !last.done ? replaceLast({ ...last, text: last.text + event.text }) : appendItem(state, { kind: "thought", text: event.text, done: false });
  }
}

function applyEvent(state: SessionState, event: AgentEvent, origin: "replay" | "live"): SessionState {
  switch (event.type) {
    case "chunk":
      return applyChunk(state, event, origin);
    case "tool":
      return applyTool(state, event);
    case "plan":
      return { ...state, plan: event.entries };
    case "commands":
      return { ...state, commands: event.commands };
    case "config":
      return { ...state, options: event.options };
    case "mode":
      return { ...state, options: state.options.map((option) => (option.category === "mode" ? { ...option, currentValue: event.modeId } : option)) };
    case "usage":
      return { ...state, usage: event.cost ? { used: event.used, size: event.size, cost: event.cost } : { used: event.used, size: event.size } };
    case "title":
      return state; // l'en-tête montre le nom idnma, pas le titre de l'agent
    case "notice":
      return appendItem(state, { kind: "notice", text: event.description ? `${event.title}: ${event.description}` : event.title, tone: event.severity === "error" ? "error" : "info" });
  }
}

function selectChoice(state: SessionState, delta: 1 | -1): SessionState {
  const pending = state.pending;
  if (!pending) return state;
  const choices = pending.kind === "permission" ? pending.request.choices.length : HELD_CHOICES.length;
  const selected = Math.min(Math.max(pending.selected + delta, 0), Math.max(choices - 1, 0));
  return selected === pending.selected ? state : { ...state, pending: { ...pending, selected } };
}

/** Les outils encore en cours passent à `cancelled` : ni point vert ni durée qui court. */
function cancelOpenTools(thread: ThreadItem[]): ThreadItem[] {
  return thread.map((item) => (item.kind === "tool" && (item.status === "pending" || item.status === "in_progress") ? { ...item, status: "cancelled" as const } : item));
}

function reduceRaw(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event, action.origin);
    case "userPrompt":
      if (state.exit) return state;
      if (state.turnActive) return { ...state, localQueue: [...state.localQueue, action.text] };
      return appendItem(state, { kind: "user", text: action.text });
    case "turnStarted":
      return { ...state, thread: closeOpen(state.thread), turnActive: true, interrupted: false };
    case "turnEnded": {
      const cancelled = action.stopReason === "cancelled";
      const thread = closeOpen(state.thread).map((item) => (cancelled && item.kind === "tool" && (item.status === "pending" || item.status === "in_progress") ? { ...item, status: "cancelled" as const } : item));
      const ended = { ...withoutPending(state, "permission"), thread, turnActive: false };
      if (!cancelled) return ended;
      // Le tour d'un agent mort ou en erreur n'est pas « interrompu » : le bandeau de sortie ou l'erreur dit déjà ce qui s'est passé.
      const marked = { ...ended, interrupted: true };
      return state.exit || action.failed ? marked : appendItem(marked, { kind: "notice", text: "Interrupted", tone: "info" });
    }
    case "peerTurn":
      return appendItem(state, { kind: "peer", from: action.from, text: action.text });
    case "permission":
      return { ...state, pending: { kind: "permission", request: action.request, selected: 0 } };
    case "permissionResolved":
      return withoutPending(state, "permission");
    case "held": {
      const counted = { ...state, heldCount: action.queued };
      return derive(state).status === "idle" ? { ...counted, pending: { kind: "held", from: action.from, text: action.text, selected: 0 } } : counted;
    }
    case "heldResolved":
      return { ...withoutPending(state, "held"), heldCount: action.queued };
    case "heldCount":
      return { ...state, heldCount: action.queued };
    case "select":
      return selectChoice(state, action.delta);
    case "notice":
      return appendItem(state, { kind: "notice", text: action.text, tone: action.tone });
    case "agentExited": {
      const { pending: _dropped, ...rest } = state;
      const closed = cancelOpenTools(closeOpen(state.thread));
      // La file locale ne part plus : elle est perdue, et l'écran le dit au lieu de la taire.
      const lost = state.localQueue.length;
      const thread: ThreadItem[] = lost === 0 ? closed : [...closed, { kind: "notice", text: `${lost} queued ${lost === 1 ? "message" : "messages"} not sent`, tone: "error" }];
      return { ...rest, thread, turnActive: false, exit: { code: action.code, signal: action.signal } };
    }
  }
}

/** Réducteur pur : ne mute jamais son entrée. */
export function reduce(state: SessionState, action: Action): SessionState {
  return derive(reduceRaw(state, action));
}

/** Retire le premier prompt de la file locale et l'affiche dans le fil ; l'appelant l'envoie à ce moment. */
export function nextQueuedPrompt(state: SessionState): [string | undefined, SessionState] {
  const [head, ...rest] = state.localQueue;
  if (head === undefined) return [undefined, state];
  return [head, derive(appendItem({ ...state, localQueue: rest }, { kind: "user", text: head }))];
}
