/** Ligne que la doublure tape dans le PTY pour sonner à la porte du harnais. */
export const DOORBELL_LINE = "📨 idnma read";

/** La sonnette est écrite en une seule écriture, validée par un retour chariot. */
export const DOORBELL_BYTES = DOORBELL_LINE + "\r";

export type TurnOutcome = "completed" | "interrupted" | "failed";

/**
 * Ce qu'un événement de hook veut dire pour le livreur, indépendamment du harnais.
 * `promptId` : Grok, sur `turn-start` et `turn-end` quand le payload le porte.
 * `conversationId` : sur tout signal quand le payload le porte (`conversationId` d'agy, `sessionId` de Grok) ;
 * un `grok -p` ou un `agy -p` lancé par l'agent parle aux mêmes hooks, il se reconnaît à cet identifiant.
 * `unknown` : événement ambigu (§7.5), l'état repasse à inconnu sans rien publier ; `reason` le nomme pour le journal.
 * `mid-turn.userInput` : agy, `lastUserInput` du `PreInvocation` (le texte qui a nourri cet appel au modèle).
 */
export type HookSignal = (
  | { kind: "session-start" }
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "turn-start"; prompt: string; canDeliver: boolean }
  | { kind: "mid-turn"; userInput?: string }
  | { kind: "unknown"; reason?: string }
  | {
      kind: "turn-end";
      outcome: TurnOutcome;
      reliableIdle: boolean;
      detail?: string;
      answer?: string;
      transcriptPath?: string;
    }
  | { kind: "ignore" }
) & { promptId?: string; conversationId?: string };

export interface HarnessAdapter {
  harness: "grok" | "agy";
  label: "Grok" | "agy";
  /** Plus long texte qu'un hook peut livrer en une fois. */
  textLimit: number;
  /** Traduit un événement de hook (nom reçu par `idnma hook`) et son payload en signal. */
  signal(event: string, payload: Record<string, unknown>): HookSignal;
  /** Réponse de hook qui injecte `text` dans le tour en cours. */
  deliveryReply(event: string, text: string): Record<string, unknown>;
  /** Réponse de hook qui empêche le tour de s'arrêter et le relance avec `text`. */
  continueReply(text: string): Record<string, unknown>;
  /** Réponse finale du tour terminé, quand le harnais permet de la retrouver. */
  finalAnswer(end: Extract<HookSignal, { kind: "turn-end" }>): string | undefined;
}

/** Chaîne non vide du payload, sinon `undefined`. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
