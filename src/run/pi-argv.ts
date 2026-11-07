// Lecture de l'argv de `pi` (Pi 1.5.0, `docs/cli.md`). Seuls comptent ici les flags qui prennent une
// valeur, pour que leur valeur ne passe pas pour le premier positionnel, et les flags ou sous-commandes
// qui sortent Pi de sa TUI : dans un pane du bus, Pi doit rester interactif, sinon l'extension idnma
// n'a ni tour à ouvrir ni utilisateur à servir.

/** Sous-commandes de `pi` : sans objet dans un pane du bus. */
export const PI_SUBCOMMANDS: readonly string[] = ["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"];

// Flags qui font sortir Pi de sa TUI ou le font quitter tout de suite.
const NON_INTERACTIVE = new Set(["-p", "--print", "--export", "--list-models", "-h", "--help", "-v", "--version"]);

// Flags à valeur (jeton suivant, ou `--x=v`). `--list-models` et `--export` sont refusés avant d'en lire une.
const VALUE_FLAGS = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--thinking",
  "--models",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "-n",
  "--name",
  "-t",
  "--tools",
  "-xt",
  "--exclude-tools",
  "-e",
  "--extension",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--system-prompt",
  "--append-system-prompt",
  "--tui-mode",
]);

const NON_INTERACTIVE_REASON = "fait sortir pi de sa TUI : l'extension idnma n'aurait plus de tour à ouvrir dans ce pane.";

/**
 * Pourquoi cet argv n'a pas sa place dans un pane du bus, ou `undefined` : `-p`/`--print`, `--mode` autre que `text`,
 * `--export`, `--list-models`, `-h`/`--help`, `-v`/`--version`, ou une sous-commande de `pi` en premier
 * positionnel. La valeur d'un flag à valeur n'est pas un positionnel ; après `--`, tout en est un.
 */
export function piRefusal(argv: string[]): string | undefined {
  let positionals = 0;
  let afterSeparator = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (afterSeparator || !token.startsWith("-") || token === "-") {
      if (positionals === 0 && PI_SUBCOMMANDS.includes(token)) {
        return `« ${token} » est une sous-commande de pi : elle n'a pas sa place dans un pane du bus.`;
      }
      positionals += 1;
      continue;
    }
    if (token === "--") {
      afterSeparator = true;
      continue;
    }
    const name = token.startsWith("--") ? token.split("=", 1)[0]! : token;
    if (name === "--mode") {
      // `--mode text` garde la TUI quand stdin et stdout sont des terminaux (doc cli.md) : seuls json et rpc en sortent.
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[i + 1];
      if (!token.includes("=")) i += 1;
      if (value !== "text") return `--mode ${value ?? "sans valeur"} ${NON_INTERACTIVE_REASON}`;
      continue;
    }
    if (NON_INTERACTIVE.has(name)) return `${name} ${NON_INTERACTIVE_REASON}`;
    if (VALUE_FLAGS.has(name) && !token.includes("=")) i += 1;
  }
  return undefined;
}
