// Enveloppe et trames du bus de pairs de Claude Code (forme capturée le 26/10/2026, Claude 2.1.310).
import { escapeClosingTag } from "./claude-escape.ts";

export type FromMode = "bypass" | "prompting";

/** Adresse d'un pair : le chemin de son socket, préfixé `uds:`. */
export function addressOf(socketPath: string): string {
  return "uds:" + socketPath;
}

// Claude 2.1.310 reconstruit l'enveloppe reçue et la compare octet par octet : hors forme
// canonique, `from-mode` est perdu et le message est retenu. Ordre des attributs imposé.
const TAG = "cross-session-message";

/** Échappe le corps exactement comme `Vrt(TAG, corps)` de Claude 2.1.310 (voir claude-escape.ts). */
export function escapeBody(body: string): string {
  return escapeClosingTag(TAG, body);
}

export function buildEnvelope(a: { from: string; fromName: string; fromMode: FromMode; body: string }): string {
  return `<${TAG} from="${a.from}" from-name="${a.fromName}" from-mode="${a.fromMode}">\n${escapeBody(a.body)}\n</${TAG}>`;
}

/** Trame `user` : une ligne JSON, sans `\n` final (le `\n` est ajouté à l'écriture). */
export function buildUserFrame(a: { msgId: string; from: string; content: string; priority?: "now" | "next" | "later" }): string {
  return JSON.stringify({
    msgV: 1,
    msg_id: a.msgId,
    type: "user",
    message: { role: "user", content: a.content },
    priority: a.priority ?? "next",
    from: a.from,
  });
}

/** Première ligne d'une connexion vers un pair qui publie une clé. */
export function authFrame(token: string): string {
  return JSON.stringify({ type: "auth", token });
}
