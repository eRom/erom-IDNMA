// Traduction des trames ACP (types du SDK) vers les événements du domaine de `events.ts`.
// Fonctions pures : l'écran ne voit jamais un type du SDK, Task 6 appelle ces fonctions depuis les handlers.
// Import de types uniquement : ce module ne charge rien du SDK à l'exécution.

import type {
  ContentBlock,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentEvent, CommandInfo, ConfigOption, PermissionRequest, PlanEntry, ToolContent, ToolStatus } from "./events.ts";

const PLAN_STATUSES: readonly string[] = ["pending", "in_progress", "completed"];

/** Texte d'un bloc de contenu ; un marqueur lisible pour ce que le terminal ne sait pas afficher. */
export function textOfContent(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return `[resource: ${block.uri}]`;
    case "resource":
      return `[resource: ${block.resource.uri}]`;
    default:
      return "";
  }
}

/** Sortie brute d'un outil : chaîne telle quelle, champ `output` d'un objet (forme agy), sinon JSON. */
function rawOutputText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const output = (raw as { output?: unknown }).output;
    if (typeof output === "string") return output;
  }
  return JSON.stringify(raw);
}

function toToolContent(items: ToolCallContent[]): ToolContent[] {
  const out: ToolContent[] = [];
  for (const item of items) {
    if (item.type === "content") out.push({ kind: "text", text: textOfContent(item.content) });
    else if (item.type === "diff") {
      const diff: ToolContent = { kind: "diff", path: item.path, newText: item.newText };
      if (typeof item.oldText === "string") diff.oldText = item.oldText;
      out.push(diff);
    }
    // `terminal` : l'écran n'embarque pas de terminal, la sortie arrive par rawOutput et le contenu texte.
  }
  return out;
}

/** Un `tool_call` et un `tool_call_update` partagent leurs champs : seuls ceux présents sortent. */
function toToolEvent(update: ToolCall | ToolCallUpdate, created: boolean): AgentEvent {
  const event: Extract<AgentEvent, { type: "tool" }> = { type: "tool", id: update.toolCallId, created };
  if (typeof update.name === "string") event.name = update.name;
  if (typeof update.title === "string") event.title = update.title;
  if (typeof update.kind === "string") event.kind = update.kind;
  if (typeof update.status === "string") event.status = update.status as ToolStatus;
  if (Array.isArray(update.content)) event.content = toToolContent(update.content);
  const rawOutput = rawOutputText(update.rawOutput);
  if (rawOutput !== undefined) event.rawOutput = rawOutput;
  return event;
}

/** Options de configuration : seuls les `select` passent, les groupes sont aplatis dans l'ordre. */
export function toConfigOptions(raw: SessionConfigOption[] | null | undefined): ConfigOption[] {
  const out: ConfigOption[] = [];
  for (const option of raw ?? []) {
    if (option.type !== "select") continue;
    const values: ConfigOption["values"] = [];
    for (const entry of option.options) {
      const choices = "group" in entry ? entry.options : [entry];
      for (const choice of choices) values.push({ value: choice.value, name: typeof choice.name === "string" ? choice.name : choice.value });
    }
    const converted: ConfigOption = { id: option.id, name: option.name, currentValue: option.currentValue, values };
    if (typeof option.category === "string") converted.category = option.category;
    out.push(converted);
  }
  return out;
}

export function toPermissionRequest(params: RequestPermissionRequest): PermissionRequest {
  const { toolCall } = params;
  const request: PermissionRequest = {
    toolCallId: toolCall.toolCallId,
    title: toolCall.title ?? toolCall.name ?? "",
    choices: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
  };
  if (typeof toolCall.kind === "string") request.kind = toolCall.kind;
  return request;
}

function toChunk(role: "user" | "agent" | "thought", update: { content: ContentBlock; messageId?: string | null }): AgentEvent {
  const event: AgentEvent = { type: "chunk", role, text: textOfContent(update.content) };
  if (typeof update.messageId === "string") event.messageId = update.messageId;
  return event;
}

function toCommands(update: Extract<SessionUpdate, { sessionUpdate: "available_commands_update" }>): CommandInfo[] {
  return update.availableCommands.map((c) => {
    const command: CommandInfo = { name: c.name, description: c.description };
    if (c.input?.hint) command.hint = c.input.hint;
    return command;
  });
}

/** Traduit une mise à jour de session en zéro, un ou plusieurs événements du domaine. */
export function translateUpdate(update: SessionUpdate): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return [toChunk("user", update)];
    case "agent_message_chunk":
      return [toChunk("agent", update)];
    case "agent_thought_chunk":
      return [toChunk("thought", update)];
    case "tool_call":
      return [toToolEvent(update, true)];
    case "tool_call_update":
      return [toToolEvent(update, false)];
    case "plan": {
      // Un statut inconnu est ignoré plutôt que levé : le SDK tolère déjà les champs optionnels mal formés.
      const entries: PlanEntry[] = update.entries
        .filter((e) => PLAN_STATUSES.includes(e.status))
        .map((e) => ({ content: e.content, status: e.status, priority: e.priority }));
      return [{ type: "plan", entries }];
    }
    case "available_commands_update":
      return [{ type: "commands", commands: toCommands(update) }];
    case "config_option_update":
      return [{ type: "config", options: toConfigOptions(update.configOptions) }];
    case "current_mode_update":
      return [{ type: "mode", modeId: update.currentModeId }];
    case "usage_update": {
      const event: AgentEvent = { type: "usage", used: update.used, size: update.size };
      if (update.cost) event.cost = { amount: update.cost.amount, currency: update.cost.currency };
      return [event];
    }
    case "session_info_update":
      return typeof update.title === "string" ? [{ type: "title", title: update.title }] : [];
    case "notice": {
      const event: AgentEvent = { type: "notice", severity: update.severity, title: update.title };
      if (typeof update.description === "string") event.description = update.description;
      return [event];
    }
    default:
      // compaction_* et toute variante inconnue : rien à afficher.
      return [];
  }
}
