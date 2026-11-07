import { parseModelRef } from "../opencode/model.ts";
import { dstRefusal } from "../run/dst-argv.ts";
import { piRefusal } from "../run/pi-argv.ts";
import { OPENCODE_SHORT_ALIASES, parseOpencodeArgv, type OpencodeArgv } from "../run/opencode-argv.ts";
import type { Engine, Harness } from "./network.ts";

// Alias courts des flags à valeur qu'un engine peut porter (relevés sur `--help` : Claude 2.1.312,
// Codex 0.164.0, Grok 1.0.70, opencode 2.2.0). Sans eux, `-m x` tapé laisserait le `--model` de l'engine
// en place, et Codex comme Grok refusent un flag donné deux fois. Tous prennent une valeur, collée ou non,
// sauf `-c` d'opencode et de dst (`--continue`) et `-p` de dst (`--print`, refusé de toute façon) : ils n'en prennent pas.
export const SHORT_ALIASES: Record<Harness, Record<string, string>> = {
  claude: { "-n": "--name" },
  codex: { "-m": "--model", "-c": "--config", "-C": "--cd", "-p": "--profile", "-s": "--sandbox", "-a": "--ask-for-approval" },
  grok: { "-m": "--model" },
  agy: {},
  opencode: OPENCODE_SHORT_ALIASES,
  dst: { "-c": "--continue", "-p": "--print" },
  // Pi a des flags courts de plusieurs lettres (`-ne`, `-nt`, `-xt`) : aucun alias, sinon `-ne` passerait pour `-n e`.
  pi: {},
};

/**
 * Nom long d'un flag : `--x=v` vaut `--x`, un alias court, seul ou collé à sa valeur (`-mgpt-x`),
 * vaut sa forme longue ; `undefined` pour une valeur ou un positionnel.
 */
export function flagName(harness: Harness, token: string): string | undefined {
  if (!token.startsWith("-") || token === "-" || token === "--") return undefined;
  if (token.startsWith("--")) return token.split("=", 1)[0]!;
  return SHORT_ALIASES[harness][token.slice(0, 2)] ?? token.split("=", 1)[0]!;
}

// Flags qui font tourner Codex hors du daemon local : son thread n'existe alors pas pour le daemon,
// la doublure ne peut plus l'adopter ni lui livrer le bus (`codex-adoption-timeout` du 27/10 après
// un `--config` posé). Codex 0.164.0, mesuré dans un pane (« Running without the shared background
// server: … requires embedded mode ») : `-c/--config` (collé compris), `--enable`, `--disable`,
// `--search`, `--profile`, `--strict-config`, `--dangerously-bypass-hook-trust`. Lu dans `--help` :
// `--no-daemon` (« Run without the shared background server »), `--remote` (serveur distant).
// Listé par le binaire parmi les mêmes causes, non mesuré : `--oss`.
export const CODEX_EMBEDDED_FLAGS = new Set([
  "--config",
  "--enable",
  "--disable",
  "--search",
  "--profile",
  "--strict-config",
  "--dangerously-bypass-hook-trust",
  "--no-daemon",
  "--remote",
  "--oss",
]);
export const CODEX_EMBEDDED_REASON =
  "fait démarrer Codex sans son serveur partagé : idnma ne pourrait plus lui livrer les messages du bus. Règle ce réglage dans le config.toml de Codex.";

export function codexEmbeddedFlag(argv: string[]): string | undefined {
  return argv.map((token) => flagName("codex", token)).find((name) => name !== undefined && CODEX_EMBEDDED_FLAGS.has(name));
}

// Le modèle de dst se règle dans la TUI (`/model`), qui le retient : il n'existe pas de flag de lancement (F16).
export const DST_MODEL_REASON = "dst ne prend pas de modèle au lancement ; choisis-le avec /model dans dst, la TUI le retient";

export const OPENCODE_STANDALONE_REASON = "fait démarrer opencode hors de son service partagé : idnma ne pourrait plus lui livrer les messages du bus.";

export type EngineIssueCode = "codex-embedded-flag" | "opencode-refused-flag" | "opencode-session-form" | "opencode-model-form" | "dst-model" | "dst-refused-flag" | "pi-refused-flag";

export interface EngineIssue {
  code: EngineIssueCode;
  /** Champ de l'engine où l'erreur se corrige. */
  field: "model" | "options";
  /** `config` : erreur du fichier (`ConfigError`) ; `usage` : erreur d'usage (`UsageError`) telle que `runAgent` la lève. */
  error: "config" | "usage";
  /** Le message français que `runAgent` lève. */
  message: string;
  /** Le flag ou le modèle fautif. */
  token?: string;
}

/**
 * Contrôles opencode qui ne lisent que l'argv de la TUI (options de l'engine, ou options puis arguments tapés)
 * et le `model:` de l'engine : forme de `-s`, puis forme du modèle. Un `-m` de l'argv l'emporte sur `model:`.
 * Une forme invalide est une erreur d'usage pour un `-m`, de configuration pour le `model:` de l'engine.
 */
export function opencodeArgvIssues(parsed: OpencodeArgv, engineModel: string | undefined, source: string): EngineIssue[] {
  const issues: EngineIssue[] = [];
  if (parsed.session !== undefined && !parsed.session.startsWith("ses")) {
    issues.push({ code: "opencode-session-form", field: "options", error: "usage", message: "-s : un id de session opencode commence par ses.", token: parsed.session });
  }
  if (parsed.model !== undefined) {
    if (parseModelRef(parsed.model) === undefined) {
      issues.push({
        code: "opencode-model-form",
        field: "options",
        error: "usage",
        message: `--model : « ${parsed.model} » n'a pas la forme <fournisseur>/<modèle>.`,
        token: parsed.model,
      });
    }
  } else if (engineModel !== undefined && parseModelRef(engineModel) === undefined) {
    issues.push({
      code: "opencode-model-form",
      field: "model",
      error: "config",
      message: `${source} : model « ${engineModel} » n'a pas la forme <fournisseur>/<modèle>.`,
      token: engineModel,
    });
  }
  return issues;
}

/**
 * Tout contrôle d'`idnma run` qui ne lit que l'engine (pas le disque, le réseau ni le service).
 * `source` nomme l'engine dans les messages : `.idnma.yml (agents.<a>.engines.<e>)`.
 */
export function engineIssues(engine: Engine, source: string): EngineIssue[] {
  const issues: EngineIssue[] = [];
  if (engine.harness === "codex") {
    const flag = codexEmbeddedFlag(engine.options);
    if (flag !== undefined) {
      issues.push({ code: "codex-embedded-flag", field: "options", error: "config", message: `${source} : ${flag} ${CODEX_EMBEDDED_REASON}`, token: flag });
    }
  } else if (engine.harness === "opencode") {
    const parsed = parseOpencodeArgv(engine.options);
    if (parsed.refused !== undefined) {
      issues.push({
        code: "opencode-refused-flag",
        field: "options",
        error: "config",
        message: `${source} : ${parsed.refused} ${OPENCODE_STANDALONE_REASON}`,
        token: parsed.refused,
      });
    }
    issues.push(...opencodeArgvIssues(parsed, engine.model, source));
  } else if (engine.harness === "dst") {
    if (engine.model !== undefined) {
      issues.push({ code: "dst-model", field: "model", error: "config", message: `${source} : ${DST_MODEL_REASON}.`, token: engine.model });
    }
    const refusal = dstRefusal(engine.options);
    if (refusal !== undefined) issues.push({ code: "dst-refused-flag", field: "options", error: "config", message: `${source} : ${refusal}` });
  } else if (engine.harness === "pi") {
    const refusal = piRefusal(engine.options);
    if (refusal !== undefined) issues.push({ code: "pi-refused-flag", field: "options", error: "config", message: `${source} : ${refusal}` });
  }
  return issues;
}
