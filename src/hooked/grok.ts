import { type HarnessAdapter, type HookSignal, nonEmptyString } from "./signals.ts";

// Forme d'un type de notification Grok (`idle_prompt`, `permission_prompt`).
const NOTIFICATION_TYPE = /^[a-z_]{1,40}$/;

/** Traduit un événement de hook de Grok (nom PascalCase) en signal. */
function grokSignal(event: string, payload: Record<string, unknown>): HookSignal {
  const conversationId = nonEmptyString(payload.sessionId);
  const tag = <T extends HookSignal>(signal: T): T => (conversationId === undefined ? signal : { ...signal, conversationId });
  // Une invite d'approbation, même d'un sous-agent, occupe le pane de l'utilisateur.
  if (event === "Notification" && payload.notificationType === "permission_prompt") return tag({ kind: "busy" });
  // Un sous-agent peut survivre au tour parent et ses tours ne comptent pas.
  if (nonEmptyString(payload.subagentType) !== undefined) return { kind: "ignore" };
  const promptId = nonEmptyString(payload.promptId);
  const withPrompt = <T extends HookSignal>(signal: T): T => tag(promptId === undefined ? signal : { ...signal, promptId });
  switch (event) {
    case "SessionStart":
      return tag({ kind: "session-start" });
    case "UserPromptSubmit":
      // Grok jette la sortie de ce hook : rien ne peut y être livré.
      return withPrompt({
        kind: "turn-start",
        prompt: typeof payload.prompt === "string" ? payload.prompt : "",
        canDeliver: false,
      });
    case "PreToolUse":
      return tag({ kind: "busy" });
    case "PostToolUse":
    case "PostToolUseFailure":
      return tag({ kind: "mid-turn" });
    case "Stop": {
      if (payload.reason !== "end_turn") return { kind: "ignore" };
      const answer = nonEmptyString(payload.lastAssistantMessage);
      // Une tâche de fond en cours : Grok réveille l'agent tout seul à sa fin, ce n'est pas un repos.
      const hasBackgroundTasks = Array.isArray(payload.backgroundTasks) && payload.backgroundTasks.length > 0;
      return withPrompt({
        kind: "turn-end",
        outcome: "completed",
        reliableIdle: !hasBackgroundTasks,
        ...(answer === undefined ? {} : { answer }),
      });
    }
    case "StopCancelled":
      return withPrompt({ kind: "turn-end", outcome: "interrupted", reliableIdle: false });
    case "StopFailure": {
      const detail = nonEmptyString(payload.errorDetails) ?? nonEmptyString(payload.error);
      return withPrompt({
        kind: "turn-end",
        outcome: "failed",
        reliableIdle: false,
        ...(detail === undefined ? {} : { detail }),
      });
    }
    case "Notification": {
      if (payload.notificationType === "idle_prompt") return tag({ kind: "idle" });
      // Toute autre notification est ambiguë (§7.5) : retour à l'état inconnu. Son type part au journal,
      // un libellé libre y est remplacé par « other ».
      const type = nonEmptyString(payload.notificationType);
      if (type === undefined) return tag({ kind: "unknown" });
      return tag({ kind: "unknown", reason: NOTIFICATION_TYPE.test(type) ? type : "other" });
    }
    default:
      return { kind: "ignore" };
  }
}

export const grokAdapter: HarnessAdapter = {
  harness: "grok",
  label: "Grok",
  // Grok coupe `additionalContext` et la raison d'un `Stop` à 10 000 caractères.
  textLimit: 9_500,
  signal: grokSignal,
  deliveryReply: (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }),
  continueReply: (text) => ({ decision: "block", reason: text }),
  finalAnswer: (end) => end.answer,
};
