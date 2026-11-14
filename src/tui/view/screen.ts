// Écran unifié plein écran : en-tête, fil défilant, saisie multiligne, ligne d'état.
// Seul `src/tui/view/` importe OpenTUI ; aucun type d'OpenTUI ne sort d'ici, hors l'option `renderer` de `createScreen`.
import { homedir } from "node:os";
import { logEvent } from "../../log.ts";
import { BoxRenderable, type CliRenderer, createCliRenderer, SyntaxStyle, TextareaRenderable, TextRenderable, bold, fg, t } from "@opentui/core";
import { fitStatusLeft, headerParts, statusHints } from "../format.ts";
import { type Context, type Intent, intentOf } from "../keys.ts";
import type { Pending, SessionState, Status } from "../state.ts";
import { ACCENT, LABEL, SURFACE, WINDOW } from "../theme.ts";
import type { CommandInfo } from "../../acp/events.ts";
import { createOverlays, createTail, type OverlayKind } from "./overlays.ts";
import { createThread } from "./thread.ts";

export interface ScreenHandlers {
  /**
   * `input` est le contenu de la saisie au moment de l'intention. Les intentions de pure vue (palette, plan, réglages,
   * défilement, sélection dans une surcouche) sont traitées par l'écran et ne remontent jamais ici.
   */
  onIntent(intent: Intent, input: string): void;
}

export interface Screen {
  /** Idempotent : ne reconstruit que ce qui a changé. */
  render(state: SessionState): void;
  clearInput(): void;
  setInput(text: string): void;
  inputText(): string;
  /** Une seule surcouche à la fois : en ouvrir une ferme l'autre. */
  openOverlay(kind: OverlayKind): void;
  closeOverlay(): void;
  overlay(): OverlayKind | undefined;
  /** Commande sélectionnée de la palette, `undefined` si elle est fermée ou ne filtre rien. */
  paletteChoice(): CommandInfo | undefined;
  /** Texte tapé dans la palette, `/` initial compris ; `undefined` si elle est fermée. */
  paletteText(): string | undefined;
  /** Valeur sélectionnée des réglages, repérée par la `category` de son option. */
  settingsChoice(): { category: string; value: string } | undefined;
  /** `destroy()` du moteur puis attente de `closed`. */
  destroy(): Promise<void>;
}

export interface ScreenOptions {
  renderer: CliRenderer;
  cwd: string;
  branch?: string;
  handlers: ScreenHandlers;
  /** Horloge des durées d'outil ; injectable pour des tests déterministes. */
  now?: () => number;
  /** Système de l'hôte, `process.platform` par défaut ; injectable pour tester les deux chemins de copie. */
  platform?: NodeJS.Platform;
  /** Copie vers `pbcopy` ; injectable pour que les tests ne touchent jamais le vrai presse-papiers. Rend vrai si la copie a réussi. */
  pbcopy?: (text: string) => boolean;
}

const SCROLL_INTENTS: ReadonlySet<Intent> = new Set(["scrollPageUp", "scrollPageDown", "scrollTop", "scrollBottom"]);

/** Un second ⌃C ne quitte que dans cette fenêtre : au-delà, c'est un nouveau premier ⌃C. */
const CTRL_C_WINDOW_MS = 1000;
/** Un ⏎ n'a pas de sens sur une demande apparue depuis moins de ce délai : c'était de la frappe d'avance. */
const CONFIRM_GUARD_MS = 500;
const CTRL_C_HINT = "⌃C again to quit";

/** Identité d'une demande à l'écran : changer le choix sélectionné ne la change pas, une nouvelle demande oui. */
function pendingKeyOf(pending: Pending | undefined): unknown {
  if (pending === undefined) return undefined;
  return pending.kind === "permission" ? pending.request : `${pending.from}\n${pending.text}`;
}

/** Style du Markdown : une gradation de gris, la couleur reste réservée aux états. */
function markdownStyle(renderer: CliRenderer): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      default: { fg: LABEL.primary },
      "markup.heading": { fg: LABEL.strong, bold: true },
      "markup.strong": { fg: LABEL.strong, bold: true },
      "markup.italic": { italic: true },
      "markup.raw": { fg: LABEL.strong },
      "markup.link": { fg: LABEL.strong, underline: true },
      "markup.link.url": { fg: LABEL.secondary, underline: true },
      "markup.link.label": { fg: LABEL.strong },
      "markup.list": { fg: LABEL.secondary },
      "markup.quote": { fg: LABEL.secondary, italic: true },
      conceal: { fg: LABEL.disabled },
      comment: { fg: LABEL.tertiary, italic: true },
      keyword: { fg: LABEL.strong },
      function: { fg: LABEL.strong },
      type: { fg: LABEL.strong },
      string: { fg: LABEL.secondary },
      number: { fg: LABEL.secondary },
      variable: { fg: LABEL.primary },
      punctuation: { fg: LABEL.secondary },
    },
    renderer.nativeScene,
  );
}

function statusDot(status: Status) {
  switch (status) {
    case "idle":
      return fg(LABEL.tertiary)("○");
    case "running":
      return fg(ACCENT.green)("●");
    case "waiting":
      return fg(ACCENT.yellow)("●");
    case "exited":
      return fg(ACCENT.red)("●");
  }
}

/**
 * Copie dans le presse-papiers de macOS : `pbcopy` sans shell, le texte sur son entrée standard, jamais sur la ligne de
 * commande. `executable` ne change que pour les tests, qui lui substituent un script. Un exécutable absent rend faux.
 */
export function pbcopyText(text: string, executable = "pbcopy"): boolean {
  try {
    const result = Bun.spawnSync([executable], { stdin: Buffer.from(text), stdout: "ignore", stderr: "ignore" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Le dossier de départ s'écrit `~`. */
function displayCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export function createScreen(options: ScreenOptions): Screen {
  const { renderer, handlers } = options;
  const now = options.now ?? Date.now;
  const syntaxStyle = markdownStyle(renderer);
  const keep = { wrapMode: "none" as const };

  // En-tête : une ligne, jamais enroulée (sinon deux lignes à 104 colonnes).
  const header = new BoxRenderable(renderer, { flexDirection: "row", justifyContent: "space-between", flexShrink: 0, height: 1, backgroundColor: SURFACE.header, paddingLeft: 1, paddingRight: 1 });
  const headerLeft = new TextRenderable(renderer, { content: "", fg: LABEL.primary, flexShrink: 1, ...keep });
  const headerRight = new TextRenderable(renderer, { content: "", fg: LABEL.secondary, flexShrink: 0, marginLeft: 2, ...keep });
  header.add(headerLeft);
  header.add(headerRight);

  const thread = createThread(renderer, syntaxStyle, now);

  // Une rangée de marge au-dessus et au-dessous du texte ; la palette y prend la place du textarea, avec les mêmes marges.
  const inputBox = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, backgroundColor: SURFACE.input, paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1 });
  inputBox.add(new TextRenderable(renderer, { content: t`${fg(ACCENT.blueText)("❯")} `, flexShrink: 0, ...keep }));
  // Aucune liaison `submit` : l'envoi passe par l'intention, jamais par la saisie.
  const textarea = new TextareaRenderable(renderer, {
    flexGrow: 1,
    minHeight: 1,
    maxHeight: 6,
    wrapMode: "word",
    textColor: LABEL.strong,
    backgroundColor: SURFACE.input,
    focusedBackgroundColor: SURFACE.input,
    placeholder: "Message",
    placeholderColor: LABEL.disabled,
    keyBindings: [
      { name: "return", shift: true, action: "newline" },
      { name: "linefeed", action: "newline" },
      { name: "j", ctrl: true, action: "newline" },
    ],
  });
  inputBox.add(textarea);

  const status = new BoxRenderable(renderer, { flexDirection: "row", justifyContent: "space-between", flexShrink: 0, height: 1, paddingLeft: 1, paddingRight: 1 });
  const statusLeft = new TextRenderable(renderer, { content: "", fg: LABEL.tertiary, flexShrink: 1, ...keep });
  const statusRight = new TextRenderable(renderer, { content: "", fg: LABEL.tertiary, flexShrink: 0, marginLeft: 2, ...keep });
  status.add(statusLeft);
  status.add(statusRight);
  const shownCwd = displayCwd(options.cwd);

  renderer.root.add(header);
  renderer.root.add(thread.scroll);
  renderer.root.add(inputBox);
  renderer.root.add(status);
  textarea.focus();

  const tail = createTail(renderer, thread.tail);
  const overlays = createOverlays({ renderer, inputBox, textarea, onChange: () => syncHints() });

  // ---- état mémorisé entre deux rendus ----
  let state: SessionState | undefined;
  let ctrlCArmedUntil = 0;
  let pendingKey: unknown;
  let pendingSince = 0;
  let shownHeader = "";
  let shownRight = "";
  let shownHints = "";
  let shownLeft = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  /** Arrête la cadence des durées d'outil ; le minuteur de la fenêtre ⌃C n'est pas concerné (un rendu ne doit pas le tuer). */
  function stopTimer(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function clearArmTimer(): void {
    if (armTimer !== undefined) clearTimeout(armTimer);
    armTimer = undefined;
  }

  const ctrlCArmed = (): boolean => now() < ctrlCArmedUntil;

  /** Le dossier cède de la place à la branche et aux libellés ; recalculé à chaque changement de l'un ou de la largeur. */
  function layoutStatusLeft(): void {
    // Marges de la ligne (1 + 1) et espace de séparation devant la partie droite (2).
    const room = renderer.width - 4 - shownHints.length;
    const left = fitStatusLeft(shownCwd, options.branch, room);
    if (left !== shownLeft) {
      shownLeft = left;
      statusLeft.content = left;
    }
  }

  function armCtrlC(): void {
    ctrlCArmedUntil = now() + CTRL_C_WINDOW_MS;
    syncHints();
    clearArmTimer();
    // La mention s'efface seule à la fin de la fenêtre.
    armTimer = setTimeout(() => {
      armTimer = undefined;
      if (!renderer.isDestroyed) syncHints();
    }, CTRL_C_WINDOW_MS + 20);
    armTimer.unref?.();
  }

  function disarmCtrlC(): void {
    const wasArmed = ctrlCArmedUntil > 0;
    ctrlCArmedUntil = 0;
    clearArmTimer();
    if (wasArmed) syncHints();
  }

  /** Une seconde de cadence, seulement tant qu'une rangée d'outil en cours affiche sa durée. */
  function syncTimer(): void {
    if (thread.hasRunningTools()) {
      if (timer === undefined && !renderer.isDestroyed) {
        timer = setInterval(() => thread.tick(), 1000);
        timer.unref?.();
      }
    } else {
      stopTimer();
    }
  }

  /** Les libellés de la ligne d'état suivent l'état et la surcouche ouverte. */
  function syncHints(): void {
    if (!state) return;
    const hints = ctrlCArmed() && state.exit === undefined ? CTRL_C_HINT : statusHints(state, overlays.kind());
    if (hints !== shownHints) {
      shownHints = hints;
      statusRight.content = hints;
      layoutStatusLeft();
    }
  }

  // ---- historique de la saisie : les prompts du fil, sans état propre au-delà du dernier rappel ----

  let recalledAt: number | undefined;
  let recalledText: string | undefined;

  /** Le dernier texte rappelé n'est plus « celui du rappel » : envoyé, vidé ou remplacé, il redevient de la frappe. */
  function forgetRecall(): void {
    recalledAt = undefined;
    recalledText = undefined;
  }

  /** Les messages de l'utilisateur dans l'ordre du fil (tapés, de la palette, de la file, rejoués), doublons consécutifs réduits. */
  function promptHistory(): string[] {
    const prompts: string[] = [];
    for (const item of state?.thread ?? []) {
      if (item.kind === "user" && prompts.at(-1) !== item.text) prompts.push(item.text);
    }
    return prompts;
  }

  /** Les flèches rappellent l'historique sur une saisie vide ou sur l'entrée rappelée telle quelle ; jamais pendant une demande ni une surcouche. */
  function canRecall(): boolean {
    if (state === undefined || state.pending !== undefined || state.exit !== undefined || overlays.kind() !== undefined) return false;
    const typed = textarea.plainText;
    return typed === "" || (recalledText !== undefined && typed === recalledText);
  }

  /** `-1` remonte vers le plus ancien, `1` redescend vers le plus récent ; au-delà du plus récent, la saisie redevient vide. */
  function recall(direction: -1 | 1): void {
    const history = promptHistory();
    const from = textarea.plainText === "" || recalledAt === undefined ? history.length : Math.min(recalledAt, history.length);
    const to = Math.min(Math.max(from + direction, 0), history.length);
    const entry = history[to];
    if (entry === undefined) {
      forgetRecall();
      textarea.setText("");
      return;
    }
    recalledAt = to;
    recalledText = entry;
    textarea.setText(entry);
    textarea.gotoBufferEnd();
  }

  function context(): Context {
    const overlay = overlays.kind();
    // La palette et le filtre des réglages occupent la rangée de saisie : c'est leur texte qui compte, pas celui du textarea caché.
    const typed = overlay === "palette" || overlay === "settings" ? overlays.typedText() : textarea.plainText;
    return {
      status: state ? headerParts(state).left.dot : "idle",
      turnActive: state?.turnActive ?? false,
      pending: state?.pending !== undefined,
      ...(overlay === undefined ? {} : { overlay }),
      inputEmpty: typed === "",
      lastWasCtrlC: ctrlCArmed(),
      recall: canRecall(),
    };
  }

  /** Une demande en attente ou l'arrêt de l'agent passent avant la palette et les réglages. */
  function blocksSelectionOverlay(): boolean {
    return state?.pending !== undefined || state?.exit !== undefined;
  }

  // Le gestionnaire global passe avant la saisie : `preventDefault` lui retire la touche.
  const onKeypress = (key: Parameters<typeof intentOf>[0] & { preventDefault(): void }): void => {
    // Une saisie vide n'a plus de rappel en cours : retaper un texte rappelé plus tôt ne rend pas les flèches à l'historique.
    if (textarea.plainText === "") forgetRecall();
    const intent = intentOf(key, context());
    if (intent === "submit") forgetRecall();
    if (key.ctrl && key.name === "c" && state?.exit === undefined) armCtrlC();
    else disarmCtrlC();
    // Un ⏎ qui arrive pile après l'apparition d'une demande est de la frappe d'avance : on l'avale, la touche ne va pas non plus à la saisie.
    if (intent === "confirm" && state?.pending !== undefined && now() - pendingSince < CONFIRM_GUARD_MS) {
      key.preventDefault();
      return;
    }
    if (intent === "none") return;
    key.preventDefault();
    if (SCROLL_INTENTS.has(intent)) {
      thread.scroll.handleKeyPress(key as Parameters<typeof thread.scroll.handleKeyPress>[0]);
      return;
    }
    // Intentions de vue : traitées ici, jamais transmises.
    switch (intent) {
      case "openPalette":
        if (!blocksSelectionOverlay()) overlays.open("palette");
        return;
      case "togglePlan":
      case "toggleSettings": {
        const kind = intent === "togglePlan" ? "plan" : "settings";
        if (overlays.kind() === kind) overlays.close();
        else if (kind === "plan" || !blocksSelectionOverlay()) overlays.open(kind);
        return;
      }
      case "closeOverlay":
        overlays.close();
        return;
      case "complete":
        overlays.complete();
        return;
      case "historyPrevious":
      case "historyNext":
        recall(intent === "historyPrevious" ? -1 : 1);
        return;
      case "clearInput":
        // ⌃C vide la saisie : avec la palette ouverte, c'est elle qui se ferme (son texte est perdu, le brouillon revient).
        if (overlays.kind() === "palette") {
          overlays.close();
          return;
        }
        break;
      case "selectUp":
      case "selectDown": {
        const overlay = overlays.kind();
        if (state?.pending === undefined && (overlay === "palette" || overlay === "settings")) {
          overlays.move(intent === "selectDown" ? 1 : -1);
          return;
        }
      }
    }
    handlers.onIntent(intent, textarea.plainText);
  };
  renderer.keyInput.on("keypress", onKeypress);

  // Sélection relâchée : sur macOS `pbcopy` (OSC 52 est souvent muet sous tmux et `copyToClipboardOSC52` ne dit rien
  // quand le moteur le croit non pris en charge), ailleurs OSC 52. Un échec est journalisé, jamais levé.
  const viaPbcopy = (options.platform ?? process.platform) === "darwin";
  const pbcopy = options.pbcopy ?? pbcopyText;
  const onSelection = (selection: { getSelectedText(): string }): void => {
    const selected = selection.getSelectedText();
    if (selected === "") return;
    let ok = false;
    try {
      ok = viaPbcopy ? pbcopy(selected) : renderer.copyToClipboardOSC52(selected);
    } catch {
      ok = false;
    }
    logEvent("unified-copy", { length: selected.length, via: viaPbcopy ? "pbcopy" : "osc52", ok });
  };
  renderer.on("selection", onSelection);
  // La largeur change la coupe des titres du fil autant que celle de la ligne d'état.
  const onResize = (): void => {
    layoutStatusLeft();
    thread.tick();
  };
  renderer.on("resize", onResize);

  renderer.once("destroy", () => {
    stopTimer();
    clearArmTimer();
    renderer.keyInput.off("keypress", onKeypress);
    renderer.off("selection", onSelection);
    renderer.off("resize", onResize);
  });

  return {
    render(next) {
      const wasTurnActive = state?.turnActive === true;
      state = next;
      // Un tour qui s'ouvre (le prochain ⌃C vise ce tour) et une demande qui apparaît (garde de ⏎) repartent de zéro.
      if (next.turnActive && !wasTurnActive) disarmCtrlC();
      const key = pendingKeyOf(next.pending);
      if (key !== pendingKey) {
        pendingKey = key;
        pendingSince = now();
      }
      const parts = headerParts(next);
      const headerKey = `${parts.left.dot}|${parts.left.name}|${parts.left.settings}`;
      if (headerKey !== shownHeader) {
        shownHeader = headerKey;
        headerLeft.content = t`${statusDot(parts.left.dot)} ${bold(fg(LABEL.strong)(parts.left.name))}  ${fg(LABEL.secondary)(parts.left.settings)}`;
      }
      if (parts.right !== shownRight) {
        shownRight = parts.right;
        headerRight.content = parts.right;
      }

      // La palette et les réglages cèdent la place à une demande en attente ou à l'arrêt de l'agent.
      const overlay = overlays.kind();
      if ((overlay === "palette" || overlay === "settings") && (next.pending !== undefined || next.exit !== undefined)) overlays.close();
      overlays.sync(next);
      // Pendant une demande, la saisie reste active mais sans curseur : la sélection est ailleurs.
      textarea.showCursor = next.pending === undefined;

      syncHints();
      thread.update(next);
      tail.update(next);
      syncTimer();
    },
    openOverlay(kind) {
      overlays.open(kind);
    },
    closeOverlay() {
      overlays.close();
    },
    overlay: () => overlays.kind(),
    paletteChoice: () => overlays.paletteChoice(),
    paletteText: () => overlays.paletteText(),
    settingsChoice: () => overlays.settingsChoice(),
    clearInput() {
      forgetRecall();
      textarea.setText("");
    },
    setInput(value) {
      forgetRecall();
      textarea.setText(value);
      textarea.gotoBufferEnd();
    },
    inputText() {
      return textarea.plainText;
    },
    async destroy() {
      stopTimer();
      clearArmTimer();
      renderer.destroy();
      await renderer.closed;
    },
  };
}

/** Ouvre l'écran plein écran sur le vrai terminal. Les gestionnaires de signaux restent à idnma (Task 12). */
export async function openScreen(options: { cwd: string; branch?: string; handlers: ScreenHandlers }): Promise<Screen> {
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    useMouse: true,
    exitOnCtrlC: false,
    exitSignals: [],
    // `console-overlay` (défaut) remplace `console` ; `openConsoleOnError` ouvrirait un panneau sur toute erreur non gérée.
    consoleMode: "disabled",
    openConsoleOnError: false,
    backgroundColor: WINDOW,
  });
  return createScreen({ renderer, ...options });
}
