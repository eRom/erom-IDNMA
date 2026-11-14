// Écran unifié plein écran : en-tête, fil défilant, saisie multiligne, ligne d'état.
// Seul `src/tui/view/` importe OpenTUI ; aucun type d'OpenTUI ne sort d'ici, hors l'option `renderer` de `createScreen`.
import { homedir } from "node:os";
import { BoxRenderable, type CliRenderer, createCliRenderer, SyntaxStyle, TextareaRenderable, TextRenderable, bold, fg, t } from "@opentui/core";
import { headerParts, statusHints } from "../format.ts";
import { type Context, type Intent, intentOf } from "../keys.ts";
import type { SessionState, Status } from "../state.ts";
import { ACCENT, LABEL, SURFACE, WINDOW } from "../theme.ts";
import { createThread } from "./thread.ts";

export interface ScreenHandlers {
  /** `input` est le contenu de la saisie au moment de l'intention. */
  onIntent(intent: Intent, input: string): void;
}

export interface Screen {
  /** Idempotent : ne reconstruit que ce qui a changé. */
  render(state: SessionState): void;
  clearInput(): void;
  setInput(text: string): void;
  inputText(): string;
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

  function context(): Context {
    return {
      status: state ? headerParts(state).left.dot : "idle",
      turnActive: state?.turnActive ?? false,
      pending: state?.pending !== undefined,
      inputEmpty: textarea.plainText === "",
      lastWasCtrlC,
    };
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

      const hints = statusHints(next, undefined);
      if (hints !== shownHints) {
        shownHints = hints;
        statusRight.content = hints;
      }

      thread.update(next);
      syncTimer();
    },
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
