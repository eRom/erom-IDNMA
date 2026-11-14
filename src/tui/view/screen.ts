// Écran unifié plein écran : en-tête, fil défilant, saisie multiligne, ligne d'état.
// Seul `src/tui/view/` importe OpenTUI ; aucun type d'OpenTUI ne sort d'ici, hors l'option `renderer` de `createScreen`.
import { homedir } from "node:os";
import { BoxRenderable, type CliRenderer, createCliRenderer, SyntaxStyle, TextareaRenderable, TextRenderable, bold, fg, t } from "@opentui/core";
import { headerParts, statusHints } from "../format.ts";
import { type Context, type Intent, intentOf } from "../keys.ts";
import type { SessionState, Status } from "../state.ts";
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
}

const SCROLL_INTENTS: ReadonlySet<Intent> = new Set(["scrollPageUp", "scrollPageDown", "scrollTop", "scrollBottom"]);

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

  const inputBox = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, backgroundColor: SURFACE.input, paddingLeft: 1, paddingRight: 1 });
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
  statusLeft.content = options.branch === undefined ? displayCwd(options.cwd) : `${displayCwd(options.cwd)}  ⎇ ${options.branch}`;

  renderer.root.add(header);
  renderer.root.add(thread.scroll);
  renderer.root.add(inputBox);
  renderer.root.add(status);
  textarea.focus();

  const tail = createTail(renderer, thread.tail);
  const overlays = createOverlays({ renderer, inputBox, textarea, onChange: () => syncHints() });

  // ---- état mémorisé entre deux rendus ----
  let state: SessionState | undefined;
  let lastWasCtrlC = false;
  let shownHeader = "";
  let shownRight = "";
  let shownHints = "";
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopTimer(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
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
    const hints = statusHints(state, overlays.kind());
    if (hints !== shownHints) {
      shownHints = hints;
      statusRight.content = hints;
    }
  }

  function context(): Context {
    const overlay = overlays.kind();
    // La palette occupe la rangée de saisie : c'est son texte qui compte, pas celui du textarea caché.
    const typed = overlay === "palette" ? overlays.paletteText() : textarea.plainText;
    return {
      status: state ? headerParts(state).left.dot : "idle",
      turnActive: state?.turnActive ?? false,
      pending: state?.pending !== undefined,
      ...(overlay === undefined ? {} : { overlay }),
      inputEmpty: typed === "",
      lastWasCtrlC,
    };
  }

  /** Une demande en attente ou l'arrêt de l'agent passent avant la palette et les réglages. */
  function blocksSelectionOverlay(): boolean {
    return state?.pending !== undefined || state?.exit !== undefined;
  }

  // Le gestionnaire global passe avant la saisie : `preventDefault` lui retire la touche.
  const onKeypress = (key: Parameters<typeof intentOf>[0] & { preventDefault(): void }): void => {
    const intent = intentOf(key, context());
    lastWasCtrlC = key.ctrl && key.name === "c";
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

  const onSelection = (selection: { getSelectedText(): string }): void => {
    const selected = selection.getSelectedText();
    if (selected !== "") renderer.copyToClipboardOSC52(selected);
  };
  renderer.on("selection", onSelection);

  renderer.once("destroy", () => {
    stopTimer();
    renderer.keyInput.off("keypress", onKeypress);
    renderer.off("selection", onSelection);
  });

  return {
    render(next) {
      state = next;
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
    settingsChoice: () => overlays.settingsChoice(),
    clearInput() {
      textarea.setText("");
    },
    setInput(value) {
      textarea.setText(value);
      textarea.gotoBufferEnd();
    },
    inputText() {
      return textarea.plainText;
    },
    async destroy() {
      stopTimer();
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
