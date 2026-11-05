import { type Document, isPair, isScalar, isSeq, type Node, type Pair, Scalar } from "yaml";

/** Opération refusée : le message est du texte d'interface (anglais, une phrase qui nomme l'obstacle). */
export class EditRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditRefused";
  }
}

/** Une paire est une fusion (`<<: *preset`) si sa clé est le scalaire `<<` non quoté. */
export function isMergePair(pair: Pair): boolean {
  const key = pair.key;
  if (!isScalar(key)) return false;
  if (key.type === Scalar.QUOTE_DOUBLE || key.type === Scalar.QUOTE_SINGLE) return false;
  const value = key.value;
  const isMergeValue = typeof value === "symbol" ? value.description === "<<" : value === "<<";
  return isMergeValue || key.source === "<<";
}

type PathItem = Document | Node | Pair;

/**
 * Chemin lisible d'un nœud à partir de ses ancêtres : `agents.glm.engines.default.env`.
 * La clé de fusion `<<` et l'indice d'une liste de fusion n'y figurent pas : un alias fusionné
 * se lit comme appartenant à l'`env` qui le fusionne.
 */
export function readablePath(ancestors: readonly PathItem[], node: unknown): string {
  const chain: unknown[] = [...ancestors, node];
  const parts: string[] = [];
  let inMerge = false;
  for (let i = 0; i < chain.length - 1; i++) {
    const item = chain[i];
    if (isPair(item)) {
      if (isMergePair(item)) {
        inMerge = true;
        continue;
      }
      inMerge = false;
      parts.push(String(isScalar(item.key) ? item.key.value : item.key));
    } else if (isSeq(item)) {
      if (inMerge) {
        inMerge = false;
        continue;
      }
      parts.push(String(item.items.indexOf(chain[i + 1])));
    }
  }
  return parts.join(".");
}
