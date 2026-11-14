// Filtre des trames ACP inconnues et redirection de `console.error` (design §6, brief de recherche « SDK ACP 2.6.0 »).
// Le SDK rejette une variante `session/update` inconnue dans son routeur zod et écrit
// `console.error("Error handling notification", …)` : sans ce filtre, le texte atterrit dans l'écran plein format.
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { logEvent } from "../log.ts";

/** Les variantes stables de `SessionUpdate` (SDK 2.6.0), tenues à la main : toute autre est retirée avant le SDK. */
export const KNOWN_SESSION_UPDATES: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "notice",
  "compaction_update",
  "compaction_summary_chunk",
]);

export interface DroppedUpdate {
  method: string;
  sessionUpdate: string;
}

/** Valeur de `sessionUpdate` quand la trame n'en porte aucune de lisible : jamais un morceau du contenu. */
const UNREADABLE_VARIANT = "(unreadable)";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `null` si la trame passe, sinon le rapport à remettre à l'appelant (méthode et variante, rien d'autre). */
function droppedInfo(message: unknown): DroppedUpdate | null {
  if (!isRecord(message) || message["method"] !== "session/update") return null;
  const params = message["params"];
  const update = isRecord(params) ? params["update"] : undefined;
  const variant = isRecord(update) ? update["sessionUpdate"] : undefined;
  if (typeof variant === "string" && KNOWN_SESSION_UPDATES.has(variant)) return null;
  return { method: "session/update", sessionUpdate: typeof variant === "string" ? variant : UNREADABLE_VARIANT };
}

/**
 * Enveloppe le `readable` d'un `Stream` ACP : une notification `session/update` dont la variante est inconnue est
 * retirée et signalée par `onDropped` ; tout le reste (requêtes, réponses, autres notifications) passe tel quel.
 * Le filtre ne journalise pas : c'est le travail de l'appelant.
 */
export function filterUnknownUpdates(
  readable: ReadableStream<AnyMessage>,
  onDropped: (info: DroppedUpdate) => void,
): ReadableStream<AnyMessage> {
  return readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        const info = droppedInfo(message);
        if (info) onDropped(info);
        else controller.enqueue(message);
      },
    }),
  );
}

/**
 * Détourne `console.error` vers le journal pendant la vie de l'écran. Seul le premier argument est retenu, et
 * seulement s'il est une chaîne : les autres arguments peuvent porter des contenus de trame. Rend la restauration.
 */
export function silenceConsoleError(): () => void {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    logEvent("acp-sdk-error", { message: typeof first === "string" ? first : "non-string console.error" });
  };
  return () => {
    console.error = original;
  };
}
