import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { addressOf, authFrame, buildEnvelope, buildUserFrame, type FromMode } from "./envelope.ts";
import { readPeerToken } from "./key.ts";
import { listLiveEntries, type SessionEntry } from "./registry.ts";

/** Échec d'envoi vers un pair : message en français, destiné à l'utilisateur. Ne contient jamais de jeton. */
export class PeerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerError";
  }
}

/**
 * Écrit les lignes (séparées par `\n`, avec un `\n` final) dans le socket d'un pair, puis attend
 * sa fermeture. Passe par `node:net` : `Bun.connect` tronque à 8 192 octets en silence.
 */
export function writeFrames(socketPath: string, lines: string[], timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new PeerError(`délai dépassé (${timeoutMs} ms) sur le socket ${socketPath}`));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(new PeerError(`connexion impossible au socket ${socketPath} : ${error.message}`));
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    // Les réponses éventuelles du pair sont lues pour laisser la connexion se fermer.
    socket.resume();
    socket.end(lines.join("\n") + "\n");
  });
}

/** Noms des pairs joignables hors l'expéditeur : une erreur de nom donne ainsi une piste à l'agent. */
function otherPeers(reachable: SessionEntry[], fromSocketPath: string): string {
  const names = [...new Set(reachable.filter((entry) => entry.messagingSocketPath !== fromSocketPath).map((entry) => entry.name))].sort();
  return names.length === 0 ? "aucun autre pair n'est vivant" : `pairs vivants : ${names.join(", ")}`;
}

/**
 * Envoie `body` à un pair vivant, sous l'enveloppe canonique, signé s'il publie une clé. `to` est
 * un nom (ambigu si deux pairs le portent) ou `{ address }`, l'adresse `uds:<socket>` d'une trame
 * reçue : elle désigne une seule session, même si deux portent le même nom.
 */
export async function sendPeerMessage(a: {
  fromSocketPath: string;
  fromName: string;
  fromMode: FromMode;
  to: string | { address: string };
  body: string;
}): Promise<{ msgId: string; target: SessionEntry }> {
  // Une entrée sans socket (forme inattendue) n'est pas joignable : elle ne compte ni comme cible
  // ni comme homonyme.
  const reachable = listLiveEntries().filter((entry) => typeof entry.messagingSocketPath === "string");
  let target: SessionEntry;
  if (typeof a.to === "string") {
    const name = a.to;
    const matches = reachable.filter((entry) => entry.name === name);
    if (matches.length === 0) throw new PeerError(`aucun pair vivant nommé « ${name} » ; ${otherPeers(reachable, a.fromSocketPath)}`);
    target = matches[0]!;
    if (matches.length > 1) {
      const pids = matches.map((entry) => entry.pid).join(", ");
      throw new PeerError(`plusieurs pairs vivants nommés « ${name} » (pids ${pids}) : nom ambigu`);
    }
  } else {
    const { address } = a.to;
    const found = reachable.find((entry) => addressOf(entry.messagingSocketPath) === address);
    if (found === undefined) throw new PeerError(`aucun pair vivant à l'adresse « ${address} »`);
    target = found;
  }
  // Un agent qui s'écrit recevrait son propre message dans sa file, comme celui d'un pair.
  if (target.messagingSocketPath === a.fromSocketPath) {
    throw new PeerError(`« ${target.name} » est l'expéditeur lui-même : idnma n'envoie pas de message à soi-même`);
  }

  const from = addressOf(a.fromSocketPath);
  const msgId = randomUUID();
  const frame = buildUserFrame({
    msgId,
    from,
    content: buildEnvelope({ from, fromName: a.fromName, fromMode: a.fromMode, body: a.body }),
  });
  const token = readPeerToken(target.messagingSocketPath);
  await writeFrames(target.messagingSocketPath, token === undefined ? [frame] : [authFrame(token), frame]);
  return { msgId, target };
}
