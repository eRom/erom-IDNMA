import { type Document, isAlias, isNode, isPair, isScalar, isSeq, type Node, type Pair, Scalar, visit, type YAMLMap } from "yaml";
import type { ConfigDocument } from "./document.ts";

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

export function keyIs(pair: Pair, name: string): boolean {
  return isScalar(pair.key) && pair.key.value === name;
}

export function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => keyIs(pair, key));
}

/** Forme d'un nom de variable d'environnement : ce que le shell sait exporter. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function asNode(value: unknown): Node | undefined {
  return isNode(value) ? value : undefined;
}

/** Variable propre à une table d'env ou de preset (la fusion `<<` n'en est pas une). */
export function ownVariable(map: YAMLMap, name: string): Pair | undefined {
  return map.items.find((item) => !isMergePair(item) && isScalar(item.key) && String(item.key.value) === name);
}

export function textNode(config: ConfigDocument, value: string, style: Scalar.Type): Scalar {
  const node = config.doc.createNode(value) as Scalar;
  node.type = style;
  return node;
}

/** Écrit le texte dans le scalaire en place (son ancre reste) ; `true` si quelque chose a changé. */
export function writeText(scalar: Scalar, value: string, style?: Scalar.Type): boolean {
  const changed = scalar.value !== value || (style !== undefined && scalar.type !== style);
  if (!changed) return false;
  scalar.value = value;
  if (style !== undefined) scalar.type = style;
  return true;
}

/** Un champ lié par ancre ne se modifie pas : l'ancre ou l'alias entraînerait les autres endroits. */
export function assertNotLinked(node: unknown, what: string): void {
  if (isAlias(node)) throw new EditRefused(`${what} is linked through &${node.source}; unlink it first.`);
  if (isNode(node) && node.anchor) throw new EditRefused(`${what} is linked through &${node.anchor}; unlink it first.`);
}

/**
 * Vrai si la majorité des listes sous une clé `options` sont écrites en ligne (`[a, b]`), et aussi s'il
 * n'y en a aucune : une liste neuve suit le style du fichier, en ligne pour un fichier neuf.
 */
export function preferredOptionsFlow(config: ConfigDocument): boolean {
  let flow = 0;
  let block = 0;
  visit(config.doc, {
    Pair(_key, pair) {
      if (keyIs(pair, "options") && isSeq(pair.value)) {
        if (pair.value.flow) flow++;
        else block++;
      }
    },
  });
  return flow >= block;
}
