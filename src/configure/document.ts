import {
  type Document,
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  type Pair,
  parseDocument,
  Scalar,
  visit,
  type YAMLMap,
} from "yaml";
import { NEW_FILE_TEMPLATE } from "./builtins.ts";
import type { EditOp, ParseErrorView } from "./types.ts";

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

/** Où une ancre est définie et où elle est reprise par alias, en chemins lisibles. */
export interface AnchorSites {
  definedAt?: string;
  aliases: string[];
}

type PathItem = Document | Node | Pair;

/**
 * Chemin lisible d'un nœud à partir de ses ancêtres : `agents.glm.engines.default.env`.
 * La clé de fusion `<<` et l'indice d'une liste de fusion n'y figurent pas : un alias fusionné
 * se lit comme appartenant à l'`env` qui le fusionne.
 */
function readablePath(ancestors: readonly PathItem[], node: unknown): string {
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

/**
 * Le fichier de configuration tel que l'app le tient : le texte lu et son `Document` (AST), jamais un
 * objet JavaScript reconverti. Toute lecture et toute écriture passe par l'AST, pour que les ancres,
 * les alias, les clés de fusion et les commentaires survivent à l'aller-retour.
 */
export class ConfigDocument {
  readonly isNew: boolean;
  readonly parseError?: ParseErrorView;
  readonly doc: Document;
  private readonly source: string;
  private modified = false;

  private constructor(source: string, isNew: boolean) {
    const lineCounter = new LineCounter();
    this.source = source;
    this.isNew = isNew;
    this.doc = parseDocument(source, { merge: true, lineCounter });
    const first = this.doc.errors[0];
    if (first) {
      const start = first.linePos?.[0];
      this.parseError = { message: first.message.split("\n")[0] ?? first.message, line: start?.line ?? 1, col: start?.col ?? 1 };
    } else {
      this.parseError = findUnresolvedAlias(this.doc, lineCounter);
    }
  }

  /** `undefined` ouvre un fichier neuf (le gabarit des presets fournis) ; une chaîne vide est un fichier vide. */
  static parse(text: string | undefined): ConfigDocument {
    return new ConfigDocument(text ?? NEW_FILE_TEMPLATE, text === undefined);
  }

  /**
   * Tant qu'aucune opération n'a réussi, le texte reçu ressort tel quel, à l'octet : la lib ne garde ni
   * les espaces de fin, ni l'absence de saut de ligne final, ni les fins de ligne CRLF, ni les lignes
   * vides en queue, et un fichier vide ou fait de commentaires s'écrirait `null`. Un fichier qui ne se lit
   * pas n'est jamais re-sérialisé non plus.
   */
  toText(): string {
    if (!this.modified || this.parseError) return this.source;
    return this.doc.toString({ flowCollectionPadding: false });
  }

  /** Applique une modification au `Document` ; `modified` ne passe à vrai que si elle a réussi. */
  apply(op: EditOp): void {
    this.applyOp(op);
    this.modified = true;
  }

  // Les opérations arrivent aux tâches 3 à 5 ; d'ici là, aucune n'aboutit et `modified` reste faux.
  private applyOp(op: EditOp): void {
    switch (op.op) {
      case "addAgent":
      case "duplicateAgent":
      case "deleteAgent":
      case "renameAgent":
      case "setAgentField":
      case "addEngine":
      case "deleteEngine":
      case "renameEngine":
      case "makeDefault":
      case "setHarness":
      case "setModel":
      case "setProvider":
      case "setOptions":
      case "setEnvVar":
      case "deleteEnvVar":
      case "removeMerge":
      case "unlink":
      case "quoteValue":
      case "addPreset":
      case "renamePreset":
      case "deletePreset":
      case "setPresetVar":
      case "deletePresetVar":
      case "setPresetOptions":
        throw new EditRefused(`Not implemented yet: ${op.op}`);
      default: {
        const unreachable: never = op;
        throw new EditRefused(`Unknown operation: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /** La table `agents:` ; `undefined` si elle est absente ou n'est pas une table. */
  agentsMap(): YAMLMap | undefined {
    const agents = this.doc.get("agents", true);
    return isMap(agents) ? agents : undefined;
  }

  /** La table `presets:` ; `undefined` si elle est absente ou n'est pas une table. */
  presetsMap(): YAMLMap | undefined {
    const presets = this.doc.get("presets", true);
    return isMap(presets) ? presets : undefined;
  }

  agentMap(key: string): YAMLMap | undefined {
    const agent = this.agentsMap()?.get(key, true);
    return isMap(agent) ? agent : undefined;
  }

  engineMap(agent: string, engine: string): YAMLMap | undefined {
    const engines = this.agentMap(agent)?.get("engines", true);
    const found = isMap(engines) ? engines.get(engine, true) : undefined;
    return isMap(found) ? found : undefined;
  }

  /** Le nœud valeur d'un preset (celui qui porte l'ancre), pas son alias. */
  presetNode(name: string): Node | undefined {
    const node = this.presetsMap()?.get(name, true);
    return isNode(node) ? node : undefined;
  }

  /** Définition et reprises de chaque ancre du document, en une seule traversée. */
  anchorSites(): Map<string, AnchorSites> {
    const sites = new Map<string, AnchorSites>();
    const entry = (anchor: string): AnchorSites => {
      let site = sites.get(anchor);
      if (!site) {
        site = { aliases: [] };
        sites.set(anchor, site);
      }
      return site;
    };
    visit(this.doc, (_key, node, path) => {
      if (isAlias(node)) {
        entry(node.source).aliases.push(readablePath(path, node));
      } else if (isNode(node) && node.anchor) {
        entry(node.anchor).definedAt = readablePath(path, node);
      }
    });
    return sites;
  }

  /** Chemins lisibles des alias de l'ancre, par exemple `agents.glm.engines.default.env`. */
  aliasUsers(anchor: string): string[] {
    return this.anchorSites().get(anchor)?.aliases ?? [];
  }
}

/** Premier alias dont l'ancre n'est pas définie avant lui (la lib ne le signale qu'à la conversion). */
function findUnresolvedAlias(doc: Document, lineCounter: LineCounter): ParseErrorView | undefined {
  const seen = new Set<string>();
  let found: ParseErrorView | undefined;
  visit(doc, (_key, node) => {
    if (found) return visit.BREAK;
    if (isAlias(node)) {
      if (!seen.has(node.source)) {
        const pos = lineCounter.linePos(node.range?.[0] ?? 0);
        found = {
          message: `Alias *${node.source} refers to an anchor that is not defined before it.`,
          line: pos.line,
          col: pos.col,
        };
        return visit.BREAK;
      }
    } else if (isNode(node) && node.anchor) {
      seen.add(node.anchor);
    }
    return undefined;
  });
  return found;
}
