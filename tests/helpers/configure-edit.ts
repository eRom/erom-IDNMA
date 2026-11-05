import { ConfigDocument, EditRefused } from "../../src/configure/document.ts";
import type { EditOp } from "../../src/configure/types.ts";

/** Diff ligne à ligne (plus longue sous-suite commune) : les lignes retirées et les lignes ajoutées. */
export function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      removed.push(a[i] as string);
      i++;
    } else {
      added.push(b[j] as string);
      j++;
    }
  }
  return { removed, added };
}

/** Applique des opérations à une copie du texte et rend le texte obtenu. */
export function edit(text: string | undefined, ...ops: EditOp[]): { config: ConfigDocument; text: string } {
  const config = ConfigDocument.parse(text);
  for (const op of ops) config.apply(op);
  return { config, text: config.toText() };
}

export function refusal(config: ConfigDocument, op: EditOp): string {
  try {
    config.apply(op);
  } catch (e) {
    if (e instanceof EditRefused) return e.message;
    throw e;
  }
  throw new Error(`l'opération ${op.op} aurait dû être refusée`);
}
