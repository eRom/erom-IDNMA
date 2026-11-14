// Types du domaine de l'écran unifié : ce que l'écran comprend, indépendamment du SDK ACP.
// Aucun import ici : la couche protocole (`src/acp/`) traduit les trames vers ces types, l'écran ne voit qu'eux.

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export type ToolContent = { kind: "text"; text: string } | { kind: "diff"; path: string; oldText?: string; newText: string };

export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  values: { value: string; name: string }[];
}

export interface CommandInfo {
  name: string;
  description: string;
  hint?: string;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: string;
}

export type AgentEvent =
  | { type: "chunk"; role: "user" | "agent" | "thought"; text: string; messageId?: string }
  | { type: "tool"; id: string; created: boolean; name?: string; title?: string; kind?: string; status?: ToolStatus; content?: ToolContent[]; rawOutput?: string }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "commands"; commands: CommandInfo[] }
  | { type: "config"; options: ConfigOption[] }
  | { type: "mode"; modeId: string }
  | { type: "usage"; used: number; size: number; cost?: { amount: number; currency: string } }
  | { type: "title"; title: string }
  | { type: "notice"; severity: string; title: string; description?: string };

export interface PermissionChoice {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequest {
  toolCallId: string;
  title: string;
  kind?: string;
  choices: PermissionChoice[];
}

export type PermissionAnswer = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** Raison d'arrêt d'un tour : « end_turn », « cancelled », « max_tokens », « refusal »… */
export type StopReason = string;
