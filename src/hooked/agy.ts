import { readFileSync } from "node:fs";
import { type HarnessAdapter, type HookSignal, nonEmptyString } from "./signals.ts";

// Tour terminé normalement (donc renvoi de la réponse) ; seul `NO_TOOL_CALL` rend aussi le repos fiable (§7.5).
const COMPLETED_REASONS = new Set(["NO_TOOL_CALL", "TERMINAL_STEP_TYPE", "INJECTED_RESPONSE", "TERMINAL_CUSTOM_HOOK"]);

/** Traduit un événement de hook d'agy en signal ; tout signal porte le `conversationId` du payload. */
function agySignal(event: string, payload: Record<string, unknown>): HookSignal {
  const conversationId = nonEmptyString(payload.conversationId);
  const tag = <T extends HookSignal>(signal: T): T =>
    conversationId === undefined ? signal : { ...signal, conversationId };
  switch (event) {
    case "SessionStart":
      // agy démarre avec le premier prompt : la session est déjà occupée.
      return tag({ kind: "busy" });
    case "PreInvocation":
      if (payload.invocationNum === 0) {
        return tag({
          kind: "turn-start",
          prompt: typeof payload.lastUserInput === "string" ? payload.lastUserInput : "",
          canDeliver: true,
        });
      }
      if (typeof payload.invocationNum === "number" && payload.invocationNum >= 1) {
        const userInput = nonEmptyString(payload.lastUserInput);
        return tag({ kind: "mid-turn", ...(userInput === undefined ? {} : { userInput }) });
      }
      return tag({ kind: "ignore" });
    case "Stop": {
      const reason = typeof payload.terminationReason === "string" ? payload.terminationReason : "";
      if (COMPLETED_REASONS.has(reason)) {
        const transcriptPath = nonEmptyString(payload.transcriptPath);
        return tag({
          kind: "turn-end",
          outcome: "completed",
          reliableIdle: reason === "NO_TOOL_CALL" && payload.fullyIdle === true,
          ...(transcriptPath === undefined ? {} : { transcriptPath }),
        });
      }
      if (reason === "USER_CANCELED") return tag({ kind: "turn-end", outcome: "interrupted", reliableIdle: false });
      const detail = nonEmptyString(payload.error) ?? nonEmptyString(reason);
      return tag({
        kind: "turn-end",
        outcome: "failed",
        reliableIdle: false,
        ...(detail === undefined ? {} : { detail }),
      });
    }
    default:
      return tag({ kind: "ignore" });
  }
}

/**
 * Réponse finale du dernier tour d'un transcript agy (JSONL) : le `content` du dernier
 * `PLANNER_RESPONSE` non vide placé après la dernière entrée utilisateur explicite.
 * Une ligne illisible est sautée ; un fichier illisible ou sans réponse rend `undefined`,
 * jamais la réponse d'un tour précédent.
 */
export function agyFinalAnswer(transcriptPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return undefined;
  }
  let answer: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { type, source, content } = entry as Record<string, unknown>;
    if (type === "USER_INPUT" && source === "USER_EXPLICIT") answer = undefined;
    else if (type === "PLANNER_RESPONSE" && typeof content === "string" && content !== "") answer = content;
  }
  return answer;
}

export const agyAdapter: HarnessAdapter = {
  harness: "agy",
  label: "agy",
  // Aucun plafond documenté pour `injectSteps`.
  textLimit: Number.POSITIVE_INFINITY,
  signal: agySignal,
  deliveryReply: (_event, text) => ({ injectSteps: [{ userMessage: text }] }),
  continueReply: (text) => ({ decision: "continue", reason: text }),
  finalAnswer: (end) => (end.transcriptPath === undefined ? undefined : agyFinalAnswer(end.transcriptPath)),
};
