// Constructeurs des événements que le faux service d'opencode émet (`emit`), sur la forme des
// captures (`api-queue-steer.events.jsonl`, `head-of-phase*.jsonl`). Chacun rend l'enveloppe
// `{ id, type, data }` ; le livreur ne lit que `type` et `data`.

// Alias de type et non interface : l'enveloppe doit être assignable à `Record<string, unknown>` (`emit`).
export type OpencodeEnvelope = {
  id: string;
  type: string;
  data: Record<string, unknown>;
};

let counter = 0;

function envelope(type: string, data: Record<string, unknown>): OpencodeEnvelope {
  counter++;
  return { id: `evt_helper_${String(counter).padStart(6, "0")}`, type, data };
}

/** Un prompt entre dans la boîte de la session (au repos comme en plein tour, y compris ce que l'utilisateur tape dans la TUI). */
export function enqueued(
  sessionID: string,
  inboxID: string,
  o: { delivery: "queue" | "steer"; metadata?: Record<string, unknown>; text?: string },
): OpencodeEnvelope {
  const payload: Record<string, unknown> = { text: o.text ?? "message" };
  if (o.metadata !== undefined) payload.metadata = o.metadata;
  return envelope("session.inbox.enqueued", { inboxID, sessionID, item: { type: "user", payload, delivery: o.delivery } });
}

/**
 * Élément de boîte d'un autre type que `user` (schéma `Session.Inbox.Item` d'opencode 2.2.0) : `compaction`
 * (`<leader>c`, capturé : `payload: {}`), `move` (`session.cd`, non capturé), `synthetic` (fin d'une commande
 * de fond, capturé : `payload: { text: "<shell …>", description, metadata: { source: "shell", … } }`), ou un
 * type inconnu de cette version.
 */
export function enqueuedItem(
  sessionID: string,
  inboxID: string,
  type: string,
  payload: Record<string, unknown>,
): OpencodeEnvelope {
  return envelope("session.inbox.enqueued", { inboxID, sessionID, item: { type, payload, delivery: "steer" } });
}

export function delivered(sessionID: string, inboxID: string): OpencodeEnvelope {
  return envelope("session.inbox.delivered", { sessionID, inboxID });
}

/** Forme non capturée : `{ sessionID, inboxID }`, sur le modèle de `inbox.delivered` (à vérifier en recette). */
export function cancelled(sessionID: string, inboxID: string): OpencodeEnvelope {
  return envelope("session.inbox.cancelled", { sessionID, inboxID });
}

export function started(sessionID: string): OpencodeEnvelope {
  return envelope("session.execution.started", { sessionID });
}

export function succeeded(sessionID: string): OpencodeEnvelope {
  return envelope("session.execution.succeeded", { sessionID });
}

/** Échec d'exécution, sur la forme de `free-limit-failed.events.jsonl` (429 du palier gratuit). */
export function failed(sessionID: string, message: string): OpencodeEnvelope {
  return envelope("session.execution.failed", { sessionID, error: { type: "provider.free-limit", message, status: 429 } });
}

export function interrupted(sessionID: string): OpencodeEnvelope {
  return envelope("session.execution.interrupted", { sessionID, reason: "user" });
}

export function textEnded(sessionID: string, text: string): OpencodeEnvelope {
  return envelope("session.text.ended", { sessionID, assistantMessageID: "msg_helper_assistant", ordinal: 0, text });
}

export function stepEnded(sessionID: string, finish: "stop" | "tool-calls" | string): OpencodeEnvelope {
  return envelope("session.step.ended", { sessionID, assistantMessageID: "msg_helper_assistant", finish, rawFinish: finish });
}
