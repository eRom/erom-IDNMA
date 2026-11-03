import { listLiveEntries, type SessionEntry } from "./registry.ts";

/** Ce qu'`idnma peer list` montre d'un pair : le nom, le statut et le pane tmux s'il y en a un. */
export interface PeerSummary {
  name: string;
  status: SessionEntry["status"];
  tmux?: string;
}

/**
 * Pairs vivants auxquels on peut écrire : une entrée sans socket de messagerie n'est pas joignable
 * (même filtre que `peer send`). `exclude` retire l'appelant lui-même ; le résultat est trié par nom.
 */
export function reachablePeers(exclude: (entry: SessionEntry) => boolean): SessionEntry[] {
  return listLiveEntries()
    .filter((entry) => typeof entry.messagingSocketPath === "string")
    .filter((entry) => !exclude(entry))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Réduit une entrée du registre à ce que la doublure rend à l'agent : rien d'autre ne sort. */
export function summarizePeer(entry: SessionEntry): PeerSummary {
  return entry.tmux === undefined ? { name: entry.name, status: entry.status } : { name: entry.name, status: entry.status, tmux: entry.tmux };
}
