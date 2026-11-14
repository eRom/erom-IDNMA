import type { CommandInfo } from "../../src/acp/events.ts";
import type { Intent } from "../../src/tui/keys.ts";
import type { SessionState } from "../../src/tui/state.ts";
import type { OverlayKind } from "../../src/tui/view/overlays.ts";
import type { Screen, ScreenHandlers } from "../../src/tui/view/screen.ts";

/**
 * Faux écran : il enregistre chaque rendu, laisse le test déclencher des intentions et compte les rendus
 * arrivés après `destroy()` (il ne doit y en avoir aucun). Ni OpenTUI ni terminal.
 */
export class FakeScreen implements Screen {
  readonly renders: SessionState[] = [];
  rendersAfterDestroy = 0;
  destroyed = false;
  input = "";
  overlayKind: OverlayKind | undefined;
  /** Ce que `paletteChoice()` rend quand la palette est ouverte. */
  palette: CommandInfo | undefined;
  /** Ce que `paletteText()` rend quand la palette est ouverte (`/` initial compris). */
  paletteInput: string | undefined;
  /** Ce que `settingsChoice()` rend quand les réglages sont ouverts. */
  setting: { category: string; value: string } | undefined;
  /** Fait lever `clearInput()` : le gestionnaire d'intentions ne doit jamais laisser remonter l'erreur. */
  failClearInput = false;

  constructor(readonly handlers: ScreenHandlers) {}

  get state(): SessionState {
    const last = this.renders.at(-1);
    if (last === undefined) throw new Error("no render yet");
    return last;
  }

  render(state: SessionState): void {
    if (this.destroyed) this.rendersAfterDestroy++;
    this.renders.push(state);
  }

  clearInput(): void {
    if (this.failClearInput) throw new Error("clear failed");
    this.input = "";
  }

  setInput(text: string): void {
    this.input = text;
  }

  inputText(): string {
    return this.input;
  }

  openOverlay(kind: OverlayKind): void {
    this.overlayKind = kind;
  }

  closeOverlay(): void {
    this.overlayKind = undefined;
  }

  overlay(): OverlayKind | undefined {
    return this.overlayKind;
  }

  paletteChoice(): CommandInfo | undefined {
    return this.overlayKind === "palette" ? this.palette : undefined;
  }

  paletteText(): string | undefined {
    return this.overlayKind === "palette" ? this.paletteInput : undefined;
  }

  settingsChoice(): { category: string; value: string } | undefined {
    return this.overlayKind === "settings" ? this.setting : undefined;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  /** Le geste de Romain : l'écran transmet l'intention avec le contenu de la saisie. */
  fire(intent: Intent, input = ""): void {
    this.handlers.onIntent(intent, input);
  }
}
