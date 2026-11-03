// Dérivé de erom-agence-control-plane/src/swarm/nicknames.ts (vocabulaire des surnoms de session) ;
// ici le suffixe est systématique, et la détection des surnoms d'avant-plan n'a pas été reprise.
// Panthéon romain : ASCII strict, car un surnom traverse le charset A-Za-z0-9_-,
// un nom de pane tmux et un flag CLI, où « vénus » ou « cérès » se feraient rejeter ou mutiler.
export const ROMAN_DEITIES = [
  "jupiter", "junon", "neptune", "minerve", "mars", "venus", "mercure",
  "apollon", "diane", "vulcain", "ceres", "vesta", "bacchus", "pluton",
  "janus", "quirinus", "saturne", "fortuna", "flora",
] as const;

// La base n'est pas toujours une clé d'agent : un `basename` de dossier peut y passer.
// `~/.claude` donnait `.claude-venus`, et tmux réécrit en silence `.` et `:` en `_` :
// le nom qu'on croit détenir n'existe alors nulle part. On ramène donc toute base
// au charset A-Za-z0-9_- avant de la servir.
export function sanitizeBase(base: string): string {
  const ascii = base.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return ascii.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function suffix4(rand: () => number): string {
  return rand().toString(36).slice(2, 6).padEnd(4, "0");
}

// Surnom de session : `<base>-<divinite>-<4 base36>`, toujours suffixé. Un nom court
// (`claude-fortuna`) libéré à la mort d'une session serait resservi à la suivante, et un
// pair qui l'a gardé en tête écrirait à une autre session sans le savoir.
//
// `taken` (noms des sessions vivantes, lu sous verrou) écarte en plus une collision du suffixe.
export function nickname(
  base: string,
  opts: { taken?: Set<string>; rand?: () => number } = {},
): string {
  base = sanitizeBase(base);
  const rand = opts.rand ?? Math.random;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  for (let i = 0; i < 100; i++) {
    const candidate = `${base}-${pick(ROMAN_DEITIES)}-${suffix4(rand)}`;
    if (!opts.taken?.has(candidate)) return candidate;
  }
  throw new Error(`Impossible de générer un surnom unique pour ${base}.`);
}
