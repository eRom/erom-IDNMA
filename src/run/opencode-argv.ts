// Lecture de l'argv de la TUI d'opencode (2.2.0, `opencode --help`). Flags à valeur : `-s`/`--session`,
// `--prompt`, `--server`, `--log-level`, `-m`/`--model` ; sans valeur : `-c`/`--continue`, `--auto`,
// `--standalone`, `--wizard`, `--print-logs`. Le premier jeton qui n'est ni un flag ni la valeur d'un
// flag à valeur est l'argument positionnel `<directory>`.

/** Alias courts des flags qu'idnma lit ou remplace. */
export const OPENCODE_SHORT_ALIASES: Record<string, string> = { "-s": "--session", "-c": "--continue", "-m": "--model" };

// Flags à valeur : la valeur est le jeton suivant (même s'il commence par `-`), ou la partie après `=` / collée.
const VALUE_FLAGS = new Set(["--session", "--prompt", "--server", "--log-level", "--model"]);
// Flags qui font tourner opencode hors de son service partagé : la doublure ne pourrait plus lui livrer le bus.
const REFUSED_FLAGS = new Set(["--standalone", "--server"]);

type Kind = "session" | "continue" | "model" | "directory" | "other";

interface Entry {
  kind: Kind;
  tokens: string[];
  value?: string;
}

export interface OpencodeArgv {
  /** Argv sans `-s`, `-c`, `-m` (avec leurs valeurs) ni `<directory>`. */
  rest: string[];
  session?: string;
  resume: boolean;
  model?: string;
  directory?: string;
  /** Premier flag refusé rencontré (`--standalone` ou `--server`, en forme longue). */
  refused?: string;
}

function scan(argv: string[]): { entries: Entry[]; refused?: string } {
  const entries: Entry[] = [];
  let refused: string | undefined;
  let hasDirectory = false;
  let afterSeparator = false;

  const positional = (token: string): void => {
    if (hasDirectory) {
      entries.push({ kind: "other", tokens: [token] });
    } else {
      hasDirectory = true;
      entries.push({ kind: "directory", tokens: [token], value: token });
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (afterSeparator) {
      positional(token);
      continue;
    }
    if (token === "--") {
      entries.push({ kind: "other", tokens: [token] });
      afterSeparator = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positional(token);
      continue;
    }

    // Nom long du flag et valeur collée éventuelle (`--x=v`, `-xv`, `-x=v`).
    let name: string;
    let inline: string | undefined;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq < 0 ? token : token.slice(0, eq);
      if (eq >= 0) inline = token.slice(eq + 1);
    } else {
      const alias = OPENCODE_SHORT_ALIASES[token.slice(0, 2)];
      if (alias === undefined || (alias === "--continue" && token.length > 2)) {
        entries.push({ kind: "other", tokens: [token] });
        continue;
      }
      name = alias;
      if (token.length > 2) inline = token.startsWith("-" + token[1] + "=") ? token.slice(3) : token.slice(2);
    }

    if (REFUSED_FLAGS.has(name) && refused === undefined) refused = name;
    if (name === "--continue") {
      entries.push({ kind: "continue", tokens: [token] });
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      entries.push({ kind: "other", tokens: [token] });
      continue;
    }
    const tokens = [token];
    let value = inline;
    if (value === undefined && i + 1 < argv.length) {
      value = argv[i + 1]!;
      tokens.push(value);
      i += 1;
    }
    const kind: Kind = name === "--session" ? "session" : name === "--model" ? "model" : "other";
    // Un `-s` ou `-m` sans valeur rend une chaîne vide : l'appelant le refuse comme une forme invalide.
    entries.push({ kind, tokens, ...(kind === "other" ? {} : { value: value ?? "" }) });
  }
  return { entries, ...(refused === undefined ? {} : { refused }) };
}

/** Lit l'argv de la TUI ; la dernière occurrence de `-s` ou de `-m` l'emporte. */
export function parseOpencodeArgv(argv: string[]): OpencodeArgv {
  const { entries, refused } = scan(argv);
  const out: OpencodeArgv = { rest: [], resume: false };
  for (const entry of entries) {
    if (entry.kind === "other") out.rest.push(...entry.tokens);
    else if (entry.kind === "continue") out.resume = true;
    else if (entry.kind === "session") out.session = entry.value;
    else if (entry.kind === "model") out.model = entry.value;
    else out.directory = entry.value;
  }
  if (refused !== undefined) out.refused = refused;
  return out;
}

/** L'argv tel quel, sans `-m`/`--model` ni leur valeur : le repli hors service, où la TUI ne sait pas lire de modèle. */
export function stripOpencodeModel(argv: string[]): string[] {
  return scan(argv)
    .entries.filter((entry) => entry.kind !== "model")
    .flatMap((entry) => entry.tokens);
}
