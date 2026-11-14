// Couleurs de l'écran unifié, recopiées de la maquette validée (design system Application d'eRom).

export const WINDOW = "#151516";

/** Blanc à une opacité, posé sur le fond de fenêtre : un terminal ne compose pas l'alpha lui-même. */
function white(alpha: number): string {
  const channel = (base: number): string =>
    Math.round(base + (255 - base) * alpha)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0x15)}${channel(0x15)}${channel(0x16)}`;
}

export const LABEL = { strong: "#FFFFFF", primary: white(0.88), secondary: white(0.6), tertiary: white(0.42), disabled: white(0.25) };
export const SURFACE = { header: "#1C1C1E", input: "#0F0F10", popover: "#28282A", userRow: white(0.05), addedRow: "#17261C" };
export const ACCENT = { blue: "#0A84FF", blueText: "#409CFF", green: "#30D158", red: "#FF453A", yellow: "#FFD60A" };
