import { statSync } from "node:fs";
import { resolve } from "node:path";

// Lecture de l'argv de `dst` (DeepSeek Harness TUI, lanceur `bin/dsh-tui.js`). Flags à valeur :
// `--backend` et `--patch` (valeur collée ou jeton suivant). `--resume` prend un id optionnel : le jeton
// suivant, s'il n'est pas un flag. `-c`/`--continue` n'en prennent pas. Le premier jeton qui n'est ni un flag
// ni la valeur d'un flag est le premier positionnel : une sous-commande du lanceur, sinon un dossier de travail.

/** Commandes du lanceur de `dst` : sans objet dans un pane du bus (spec §6.1). */
export const DST_SUBCOMMANDS: readonly string[] = [
  "run",
  "cli",
  "dsh",
  "update",
  "migrate",
  "doctor",
  "safe",
  "version",
  "help",
  "session",
  "models",
  "skills",
  "mcp",
  "auth",
  "capabilities",
];

// Alias courts lus ici : `-p` (prompt, collé ou non), `-v`, `-h` et `-c`.
const SHORT_FLAGS: Record<string, string> = { "-p": "--print", "-v": "--version", "-h": "--help", "-c": "--continue" };
// Flags du lanceur, sans objet dans un pane du bus.
const LAUNCHER_FLAGS = new Set(["--print", "--version", "--help"]);
// Autre composition que celle d'idnma (spec §6.1).
const OTHER_COMPOSITION_FLAGS = new Set(["--profile", "--from-default-profile"]);
const VALUE_FLAGS = new Set(["--backend", "--patch"]);

const LAUNCHER_REASON = "est une commande du lanceur de dst, sans objet dans un pane du bus.";

interface DstScan {
  positionals: string[];
  /** `--backend` rencontré : sa valeur, `undefined` s'il n'en a pas. */
  backend?: { value: string | undefined };
  refused?: string;
}

function scan(argv: string[]): DstScan {
  const out: DstScan = { positionals: [] };
  let afterSeparator = false;

  const positional = (token: string): void => {
    if (out.positionals.length === 0 && DST_SUBCOMMANDS.includes(token) && out.refused === undefined) {
      out.refused = `« ${token} » est une commande du lanceur de dst : elle n'a pas sa place dans un pane du bus (le lanceur la prendrait pour un dossier de travail derrière --backend dsh).`;
    }
    out.positionals.push(token);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (afterSeparator || !token.startsWith("-") || token === "-") {
      positional(token);
      continue;
    }
    if (token === "--") {
      afterSeparator = true;
      continue;
    }

    // Nom long du flag et valeur collée éventuelle (`--x=v`, `-pv`).
    let name: string;
    let inline: string | undefined;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq < 0 ? token : token.slice(0, eq);
      if (eq >= 0) inline = token.slice(eq + 1);
    } else {
      name = SHORT_FLAGS[token.slice(0, 2)] ?? token;
      if (token.length > 2 && name !== token) inline = token.slice(2);
    }

    if (out.refused === undefined) {
      if (LAUNCHER_FLAGS.has(name)) out.refused = `${token.startsWith("--") ? name : token} ${LAUNCHER_REASON}`;
      else if (OTHER_COMPOSITION_FLAGS.has(name)) out.refused = `${name} compose dst autrement que le fait idnma : sans objet dans un pane du bus.`;
    }

    if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === undefined && i + 1 < argv.length) {
        value = argv[i + 1]!;
        i += 1;
      }
      if (name === "--backend") {
        out.backend = { value };
        if (value !== "dsh" && out.refused === undefined) {
          out.refused = `--backend ${value ?? "sans valeur"} : le plugin idnma de dst ne démarrerait pas, seul --backend dsh est accepté.`;
        }
      }
    } else if (name === "--resume" && inline === undefined) {
      // L'id de session est optionnel : un flag qui suit n'est pas un id.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
    }
  }
  return out;
}

/**
 * Pourquoi cet argv n'a pas sa place dans un pane du bus (spec §6.1), ou `undefined` : sous-commande du
 * lanceur en premier positionnel, `-p`/`--print`, `-v`/`--version`, `-h`/`--help`, `--backend` autre que
 * `dsh`, `--profile`, `--from-default-profile`. La valeur de `--backend` ou de `--patch` et l'id optionnel
 * de `--resume` ne sont pas des positionnels.
 */
export function dstRefusal(argv: string[]): string | undefined {
  return scan(argv).refused;
}

/** L'argv préfixé de `--backend dsh`, sauf si un `--backend` y est déjà (il ne peut alors être que `dsh`). */
export function withDshBackend(argv: string[]): string[] {
  return scan(argv).backend === undefined ? ["--backend", "dsh", ...argv] : argv;
}

/** Dossier où `dst` travaille : le premier positionnel qui est un dossier existant, résolu depuis le dossier courant ; sinon celui-ci. */
export function dstWorkingDirectory(argv: string[]): string {
  for (const token of scan(argv).positionals) {
    const candidate = resolve(process.cwd(), token);
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Absent ou illisible : ce positionnel n'est pas un dossier.
    }
  }
  return process.cwd();
}
