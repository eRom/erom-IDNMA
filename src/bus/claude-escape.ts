// Port de l'échappement des balises fermantes de Claude Code 2.1.310 (`Vrt` et ses aides `w`, `X`,
// `UKe`, `eKt`). Un Claude qui reçoit une enveloppe la reconstruit avec `Vrt` et la compare octet
// par octet : notre échappement doit donc être exactement le sien, sosies Unicode compris.
//
// Source : binaire /Users/recarnot/.local/share/claude/versions/2.1.310, lu en latin1 (jamais
// exécuté). Les tables ci-dessous sont recopiées à l'octet près depuis le texte du binaire ; les
// offsets sont ceux de chaque déclaration dans le fichier. Une montée de version de Claude impose
// de refaire l'extraction et de comparer.

/** `JVt` (offset 217664578) : caractères invisibles (formats, sélecteurs de variante, remplissages). */
const INVISIBLE_CHARS = "\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u{110bd}\\u{110cd}\\u{13430}-\\u{1343f}\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{16fe4}\\u{e0000}-\\u{e0fff}";

/** `L` (offset 217664912) : sosies Unicode de « < », « > » et « / », vers leur caractère ASCII. */
const LOOKALIKES: Record<string, string> = {"\uFF1C":"<","\uFF1E":">","\uFE64":"<","\uFE65":">","\u2329":"<","\u232A":">","\u27E8":"<","\u27E9":">","\u3008":"<","\u3009":">","\u2039":"<","\u203A":">","\u02C2":"<","\u02C3":">","\u1438":"<","\u1433":">","\u276C":"<","\u276D":">","\u276E":"<","\u276F":">","\u2770":"<","\u2771":">","\u29FC":"<","\u29FD":">","\u226E":"<","\u226F":">","\u227A":"<","\u227B":">","\u22D6":"<","\u22D7":">","\uFF0F":"/","\u2215":"/","\u2044":"/"};

/** `du` (offset 217665345) : diacritiques combinants. */
const COMBINING_MARKS = "\\u0300-\\u0344\\u0346-\\u036f\\u0483-\\u0489\\u0591-\\u05bd\\u05bf\\u05c1\\u05c2\\u05c4\\u05c5\\u05c7\\u0610-\\u061a\\u064b-\\u065f\\u0670\\u06d6-\\u06dc\\u06df-\\u06e4\\u06e7\\u06e8\\u06ea-\\u06ed\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\u3099\\u309a\\ufe20-\\ufe2f";

/** `zrt` (offset 217665623) : ce que Claude tolère entre deux lettres du nom de balise. */
const INTRA_TAG_CHARS = `${INVISIBLE_CHARS}${COMBINING_MARKS}\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f\\u2028\\u2029`;

/** `QVt` (offset 217665772) : caractères d'un nom de balise. */
const WORD_CHARS = "A-Za-z0-9_\\-";

/** `F` (offset 217665792) : fin du nom de balise, tout sauf un caractère de nom. */
const TAG_END = `(?:[^${WORD_CHARS}]|$)`;

/** `ZVt` (offset 217665812) : tirets et leurs sosies. */
const DASH_CHARS = "\\p{Pd}\\u2212\\u207b\\u208b\\u02d7\\u2796\\u2043\\u30fc\\uff70";

/** `O4r` (offset 217666125) puis `v` (offset 217666174) : ce qui peut tenir lieu de « - » ou « _ ». */
const SEPARATOR_CHARS = `_\\p{Pc}\\u2017\\u02cd\\u07fa\\u0640${DASH_CHARS}`;
const SEPARATOR_CLASS = `[${SEPARATOR_CHARS}]`;

/** `s` (offset 217666187) : classes « < », « > », « / » étendues à leurs sosies, et remplissage. */
const CLASSES = (() => {
  const byTarget: Record<string, string> = { "<": "<", ">": ">", "/": "/" };
  for (const [lookalike, target] of Object.entries(LOOKALIKES)) byTarget[target] += lookalike;
  const open = byTarget["<"]!;
  const close = byTarget[">"]!;
  return { open, slash: byTarget["/"]!, filler: `^${WORD_CHARS}${open}${close}` };
})();

/** `UKe` (offset 217666597) : suite de caractères de la classe, sans retour arrière (groupe atomique émulé). */
function atomicRun(charClass: string, group: number): string {
  return `(?=([${charClass}]*))(?:\\${group})`;
}

/** `eKt` (offset 217666647). */
function intraTagRun(group: number): string {
  return atomicRun(INTRA_TAG_CHARS, group);
}

/** `spell` passé par `w` (offset 217666701) : « - » et « _ » acceptent tous leurs sosies. */
function spell(char: string): string {
  return char === "-" || char === "_" ? SEPARATOR_CLASS : char;
}

/** `X` (offset 217666907) dans le cas de `w(tag, true)` : balise fermante seule, sans `tail`. */
function closingTagPattern(tag: string): RegExp {
  const { open, slash, filler } = CLASSES;
  let group = 0;
  const prefix = `${atomicRun(`${filler}${slash}`, ++group)}[${slash}]${atomicRun(filler, ++group)}`;
  const spelled = [...tag].map((char, index) => (index === 0 ? "" : intraTagRun(++group)) + spell(char)).join("");
  return new RegExp(`[${open}](?!\\\\)(?=${prefix}(?:${spelled})${TAG_END})`, "giu");
}

const patterns = new Map<string, RegExp>();

/**
 * `Vrt` (offset 217667226) : neutralise toute balise fermante `tag` du texte, sosies compris.
 * Le « < » (ou son sosie) devient « <\ » ; un « < » déjà suivi de « \ » reste tel quel.
 */
export function escapeClosingTag(tag: string, text: string): string {
  let pattern = patterns.get(tag);
  if (pattern === undefined) {
    pattern = closingTagPattern(tag);
    patterns.set(tag, pattern);
  }
  return text.replace(pattern, "<\\");
}
