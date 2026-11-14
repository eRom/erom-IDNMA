import { listLiveEntries, type SessionEntry } from "./registry.ts";

/** Ce qu'`idnma peer list` montre d'un pair : le nom, le statut et le pane tmux s'il y en a un. */
export interface PeerSummary {
  name: string;
  status: SessionEntry["status"];
  tmux?: string;
}

/**
 * Ce qu'il faut savoir des process pour masquer les sessions imbriquées : le parent d'un pid, et
 * si un pid est un process idnma. `src/bus/` ne sait pas ce qu'est un process idnma : l'appelant le dit.
 */
export interface Nesting {
  parentOf: (pid: number) => number | undefined;
  isIdnmaProcess: (pid: number) => boolean;
}

const MAX_ANCESTOR_STEPS = 64;

/**
 * Retire les entrées dont le pid descend du pid d'une autre entrée vivante qui est un process idnma :
 * la session interne d'un Claude lancé en mode unifié n'est pas une adresse utile. Un Claude natif
 * (lancé par execve, sans process idnma) n'est jamais un ancêtre qui masque : ce qui en descend reste visible.
 * Table des parents illisible (`parentOf` ne connaît personne) : rien n'est retiré.
 */
export function hideNestedEntries(entries: SessionEntry[], parentOf: Nesting["parentOf"], isIdnmaProcess: Nesting["isIdnmaProcess"]): SessionEntry[] {
  const idnmaPids = new Set(entries.filter((entry) => isIdnmaProcess(entry.pid)).map((entry) => entry.pid));
  if (idnmaPids.size === 0) return entries;
  const descendsFromIdnma = (pid: number): boolean => {
    let current = pid;
    for (let step = 0; step < MAX_ANCESTOR_STEPS; step++) {
      const parent = parentOf(current);
      if (parent === undefined || parent <= 1) return false;
      if (idnmaPids.has(parent)) return true;
      current = parent;
    }
    return false;
  };
  return entries.filter((entry) => !descendsFromIdnma(entry.pid));
}

/**
 * Pairs vivants auxquels on peut écrire : une entrée sans socket de messagerie n'est pas joignable
 * (même filtre que `peer send`). `exclude` retire l'appelant lui-même ; le résultat est trié par nom.
 * Avec `nesting`, les sessions imbriquées sous un process idnma sont masquées avant `exclude` : le
 * process idnma doit encore figurer dans la liste pour que ses descendants soient reconnus.
 */
export function reachablePeers(exclude: (entry: SessionEntry) => boolean, nesting?: Nesting): SessionEntry[] {
  const reachable = listLiveEntries().filter((entry) => typeof entry.messagingSocketPath === "string");
  const visible = nesting === undefined ? reachable : hideNestedEntries(reachable, nesting.parentOf, nesting.isIdnmaProcess);
  return visible.filter((entry) => !exclude(entry)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Réduit une entrée du registre à ce que la doublure rend à l'agent : rien d'autre ne sort. */
export function summarizePeer(entry: SessionEntry): PeerSummary {
  return entry.tmux === undefined ? { name: entry.name, status: entry.status } : { name: entry.name, status: entry.status, tmux: entry.tmux };
}
