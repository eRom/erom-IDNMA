// Registre des frappes de l'utilisateur dans le volet de l'agent.
//
// La doublure ne tape la ligne de sonnette que si l'utilisateur n'a pas de brouillon en cours.
// Le module classe chaque bloc d'octets reçu du terminal : une Entrée qui soumet, une
// frappe qui salit le brouillon, ou du bruit (rapports du terminal, focus, souris) qui
// ne dit rien de ce que l'utilisateur tape. Module pur : aucune E/S, aucun journal.

export type InputKind = "enter" | "keystroke" | "noise";

const ESC = "\x1b";

// Séquences émises par le terminal ou par la souris, jamais par le clavier de l'utilisateur.
// Chaque famille est ancrée sur sa forme exacte pour ne pas avaler une vraie frappe.
const NOISE_PATTERNS: readonly RegExp[] = [
  // Rapport de focus : \x1b[I (gagné) et \x1b[O (perdu).
  /\x1b\[[IO]/g,
  // Souris SGR : \x1b[<bouton;colonne;ligne suivi de M (appui) ou m (relâchement).
  /\x1b\[<\d+;\d+;\d+[Mm]/g,
  // Souris X10 : \x1b[M suivi d'exactement trois octets.
  /\x1b\[M[\s\S]{3}/g,
  // Position du curseur (CPR) : \x1b[ligne;colonneR.
  /\x1b\[\d+;\d+R/g,
  // Attributs du terminal (DA1 avec « ? », DA2 avec « > ») : \x1b[?…c et \x1b[>…c.
  /\x1b\[[?>][\d;]*c/g,
  // Rapport de mode DEC (DECRPM) : \x1b[?mode;état$y.
  /\x1b\[\?[\d;]*\$y/g,
  // Drapeaux du protocole clavier kitty : \x1b[?<n>u.
  /\x1b\[\?\d+u/g,
  // Relâchement de touche kitty : \x1b[…:3u (l'appui, lui, reste une frappe).
  /\x1b\[[\d;:]*:3u/g,
  // OSC (couleurs, titre…) terminé par BEL ou par ST (\x1b\).
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,
  // DCS terminé par ST (\x1b\).
  /\x1bP[^\x1b]*\x1b\\/g,
];

// Collage entre crochets : bloc complet, puis début de collage dont la fin n'est pas
// encore arrivée (collage coupé entre deux blocs). Un \r à l'intérieur ne soumet rien.
const COMPLETE_PASTE = /\x1b\[200~[\s\S]*?\x1b\[201~/g;
const OPEN_PASTE = /\x1b\[200~[\s\S]*$/;

// Entrée en protocole kitty : \x1b[13u et \x1b[13;1u (sans modificateur).
const KITTY_ENTER_SUFFIXES = ["\x1b[13u", "\x1b[13;1u"] as const;

/** Classe un bloc d'octets tapé dans le volet : Entrée, frappe ou bruit. */
export function classifyInput(chunk: string): InputKind {
  let rest = chunk;
  for (const pattern of NOISE_PATTERNS) rest = rest.replace(pattern, "");
  if (rest === "") return "noise";

  // Ce qui se trouve hors collage : seule cette partie peut finir par une Entrée.
  const outsidePaste = rest.replace(COMPLETE_PASTE, "").replace(OPEN_PASTE, "");
  if (endsWithEnter(outsidePaste)) return "enter";
  return "keystroke";
}

// Un \r final soumet, sauf s'il suit un ESC (Alt+Entrée chez Grok : nouvelle ligne).
function endsWithEnter(text: string): boolean {
  if (text.endsWith("\r")) return text.at(-2) !== ESC;
  return KITTY_ENTER_SUFFIXES.some((suffix) => text.endsWith(suffix));
}

export type ChunkShape = "escape" | "mouse-fragment" | "text";

// Fin d'un rapport de souris SGR coupé entre deux blocs (« 0;10M », « 10M ») : chiffres et points-virgules, puis M ou m.
const MOUSE_FRAGMENT = /^[\d;<]*\d[Mm]$/;

/** Forme d'un bloc pour le journal, sans aucun de ses octets : séquence d'échappement, fin de rapport de souris, ou texte. */
export function chunkShape(chunk: string): ChunkShape {
  if (chunk.includes(ESC)) return "escape";
  if (MOUSE_FRAGMENT.test(chunk)) return "mouse-fragment";
  return "text";
}

/** Suit si l'utilisateur a un brouillon en cours dans le volet de l'agent. */
export class DraftTracker {
  private pending = false;

  /** Classe le bloc et met à jour le brouillon : frappe = sale, Entrée = propre, bruit = inchangé. */
  feed(chunk: string): InputKind {
    const kind = classifyInput(chunk);
    if (kind === "keystroke") this.pending = true;
    else if (kind === "enter") this.pending = false;
    return kind;
  }

  /** Oublie le brouillon. */
  reset(): void {
    this.pending = false;
  }

  get dirty(): boolean {
    return this.pending;
  }
}
