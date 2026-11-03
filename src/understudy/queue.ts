import type { InboundMessage } from "../bus/inbox.ts";

/** File bornée des messages reçus, lus un par un par l'agent via `idnma read`. */
export class MessageQueue {
  private readonly items: InboundMessage[] = [];

  constructor(private readonly cap = 50) {}

  /** Ajoute en fin de file ; rend `false` sans rien ajouter quand la file est pleine. */
  push(message: InboundMessage): boolean {
    if (this.items.length >= this.cap) return false;
    this.items.push(message);
    return true;
  }

  /** Remet un message en tête de file, même pleine (un message déjà sorti retrouve sa place). */
  unshift(message: InboundMessage): void {
    this.items.unshift(message);
  }

  /** Retire et rend le plus ancien message, ou `undefined` si la file est vide. */
  shift(): InboundMessage | undefined {
    return this.items.shift();
  }

  /** Rend le plus ancien message qui satisfait `predicate`, sans le retirer. */
  first(predicate: (message: InboundMessage) => boolean): InboundMessage | undefined {
    return this.items.find(predicate);
  }

  /** Retire ce message-là (par identité) ; `false` s'il n'est plus en file. */
  remove(message: InboundMessage): boolean {
    const index = this.items.indexOf(message);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  get size(): number {
    return this.items.length;
  }
}
