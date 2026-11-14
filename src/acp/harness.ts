// Fiches des harnais de l'écran unifié et traduction d'un engine en plan de lancement (design §6.2, §6.3).
// Traduction pure : rien n'est lancé ici, la tâche de l'orchestrateur exécute le plan sur ACP.
// Ce module n'importe ni le SDK ACP ni OpenTUI : il sert aussi aux commandes courtes.
import type { Engine } from "../config/network.ts";
import { flagName } from "../config/engine-rules.ts";
import { UsageError } from "../run/args.ts";
import { buildHarnessArgv } from "../run/run.ts";

export type UnifiedHarness = "claude" | "agy";
/** `auto` : le message d'un pair devient un tour tout de suite ; `held` : il attend la validation de l'humain. */
export type DeliveryRule = "auto" | "held";
export type ResumeRequest = { kind: "new" } | { kind: "continue" } | { kind: "id"; id: string };

/** Un réglage à poser après `session/new`. `origin` est le jeton de l'engine, repris dans l'annonce à l'écran. */
export interface ConfigStep {
  category: "model" | "thought_level" | "mode";
  value: string;
  origin: string;
}

export interface LaunchPlan {
  harness: UnifiedHarness;
  label: "Claude" | "agy";
  delivery: DeliveryRule;
  argv: string[];
  env: Record<string, string>;
  newSessionMeta?: Record<string, unknown>;
  loadSessionMeta?: Record<string, unknown>;
  configSteps: ConfigStep[];
  /** Les jetons de l'engine ou de la ligne de commande que l'écran unifié ne peut pas honorer, tels que tapés. */
  ignored: string[];
  resume: ResumeRequest;
}

export function adapterBinary(harness: UnifiedHarness): "claude-agent-acp" | "agy" {
  return harness === "claude" ? "claude-agent-acp" : "agy";
}

// Le bus coupe les noms à 64 caractères (`MAX_NAME_LENGTH` dans `naming/choose.ts`) : on rogne le nom
// d'idnma, jamais le suffixe, pour que la session interne reste distincte et valide.
const MAX_SESSION_NAME_LENGTH = 64;
const INTERNAL_SUFFIX = "-acp";

/** Nom de la session Claude interne : celui d'idnma plus `-acp`, rogné pour tenir en 64 caractères. */
export function internalSessionName(name: string): string {
  return `${name.slice(0, MAX_SESSION_NAME_LENGTH - INTERNAL_SUFFIX.length)}${INTERNAL_SUFFIX}`;
}

// Consigne ajoutée à Claude par `_meta.systemPrompt.append` (plan, « Choix du constructeur »).
export const PEER_INSTRUCTION = `You are running inside idnma's unified screen. To reach other agents, list them with \`idnma peer list\` and write to one with \`idnma peer send <name> "<text>"\`. Do not use ListAgents or SendMessage to reach other sessions; SendMessage stays for your own subagents.`;

// Réglages de la session interne (design §6.3, F10, F12, F14) : elle refuse les messages de pairs et
// perd l'outil `ListAgents`, pour que Claude découvre les pairs par `idnma peer list`.
export const CLAUDE_SESSION_SETTINGS: { crossSessionInbound: "refuse"; permissions: { deny: ["ListAgents"] } } = {
  crossSessionInbound: "refuse",
  permissions: { deny: ["ListAgents"] },
};

// Flags de Claude que l'écran unifié ne passe jamais à l'adaptateur : l'adaptateur les possède déjà
// (nom, réglages, mode, session) ou ils n'ont pas de sens sans le terminal de Claude (`--print`, formats).
// Ceux de la première liste prennent une valeur, ceux de la seconde non.
const CLAUDE_IGNORED_VALUE_FLAGS = new Set([
  "--name",
  "--output-format",
  "--input-format",
  "--permission-mode",
  "--settings",
  "--setting-sources",
  "--system-prompt",
  "--append-system-prompt",
  "--mcp-config",
  "--session-id",
  "--from-pr",
]);
const CLAUDE_IGNORED_BARE_FLAGS = new Set(["--remote-control", "--print", "-p", "--fork-session"]);

// Flags que `agy acp` accepte (F5) : les deux premiers prennent une valeur.
const AGY_VALUE_FLAGS = new Set(["--agent", "--add-dir"]);
const AGY_BARE_FLAGS = new Set(["--dangerously-skip-permissions", "--sandbox"]);

interface FlagValue {
  /** `undefined` quand le flag n'a pas de valeur utilisable (fin de ligne, ou jeton suivant qui est un flag). */
  value: string | undefined;
  /** Index du premier jeton non consommé. */
  next: number;
}

/**
 * Valeur du flag en position `i` : `--x=v`, `-nv` (alias court collé) ou le jeton suivant quand ce
 * n'est pas lui-même un flag.
 */
function readValue(harness: UnifiedHarness, tokens: string[], i: number): FlagValue {
  const token = tokens[i]!;
  const equals = token.indexOf("=");
  if (equals !== -1) {
    const value = token.slice(equals + 1);
    return { value: value === "" ? undefined : value, next: i + 1 };
  }
  if (!token.startsWith("--") && token.length > 2) return { value: token.slice(2), next: i + 1 };
  const following = tokens[i + 1];
  if (following !== undefined && flagName(harness, following) === undefined) return { value: following, next: i + 2 };
  return { value: undefined, next: i + 1 };
}

/**
 * Traduit un engine et les flags tapés en plan de lancement. Un flag tapé remplace celui de l'engine
 * exactement comme en mode natif (`buildHarnessArgv`). Lève `UsageError` pour `-r`/`--resume` sans identifiant.
 */
export function buildLaunchPlan(o: {
  harness: UnifiedHarness;
  binary: string;
  engine: Engine;
  passthrough: string[];
  name: string;
  /** Env complet de l'agent : process, engine résolu, canal de contrôle. */
  env: Record<string, string>;
  /** `claude` du PATH ; posé en `CLAUDE_CODE_EXECUTABLE` sauf si `env` le fixe déjà. */
  claudeExecutable?: string;
}): LaunchPlan {
  const { harness } = o;
  // Le premier élément est le nom du harnais : l'adaptateur n'en a pas besoin.
  const tokens = buildHarnessArgv(o.engine, { passthrough: o.passthrough }).slice(1);
  const steps = new Map<ConfigStep["category"], ConfigStep>();
  const ignored: string[] = [];
  const agyArgs: string[] = [];
  const claudeExtra: Record<string, string | null> = {};
  const claudeExtraTyped = new Map<string, string>();
  let resume: ResumeRequest = { kind: "new" };

  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i]!;
    const flag = flagName(harness, token);
    if (flag === undefined) {
      // Un positionnel : il n'y a pas de prompt à passer au lancement d'un écran.
      ignored.push(token);
      i += 1;
      continue;
    }

    if (flag === "--model" || flag === "--effort") {
      const { value, next } = readValue(harness, tokens, i);
      if (value === undefined) ignored.push(token);
      else if (flag === "--model") steps.set("model", { category: "model", value, origin: `--model ${value}` });
      else steps.set("thought_level", { category: "thought_level", value, origin: `--effort ${value}` });
      i = next;
      continue;
    }

    if (flag === "-c" || flag === "--continue") {
      resume = { kind: "continue" };
      i += 1;
      continue;
    }

    if (flag === "-r" || flag === "--resume") {
      const { value, next } = readValue(harness, tokens, i);
      if (value === undefined) throw new UsageError(`${token} demande l'identifiant de la session à reprendre.`);
      resume = { kind: "id", id: value };
      i = next;
      continue;
    }

    if (flag === "--dangerously-skip-permissions") {
      if (harness === "claude") steps.set("mode", { category: "mode", value: "bypassPermissions", origin: "--dangerously-skip-permissions" });
      else agyArgs.push(flag);
      i += 1;
      continue;
    }

    if (harness === "agy") {
      if (AGY_VALUE_FLAGS.has(flag)) {
        const { value, next } = readValue(harness, tokens, i);
        if (value === undefined) ignored.push(token);
        else agyArgs.push(flag, value);
        i = next;
      } else if (AGY_BARE_FLAGS.has(flag)) {
        agyArgs.push(flag);
        i += 1;
      } else {
        ignored.push(token);
        i += 1;
      }
      continue;
    }

    // Claude : les flags de l'adaptateur et ceux du terminal sont ignorés, tout autre `--flag [valeur]` part en extraArgs.
    if (CLAUDE_IGNORED_VALUE_FLAGS.has(flag)) {
      const { next } = readValue(harness, tokens, i);
      ignored.push(tokens.slice(i, next).join(" "));
      i = next;
    } else if (CLAUDE_IGNORED_BARE_FLAGS.has(flag) || !flag.startsWith("--")) {
      // Un flag court inconnu : l'adaptateur préfixe chaque clé d'extraArgs par `--`, il ne saurait pas le rendre.
      ignored.push(token);
      i += 1;
    } else {
      const { value, next } = readValue(harness, tokens, i);
      const key = flag.slice(2);
      // extraArgs est une table : la dernière occurrence l'emporte, les précédentes sont annoncées, jamais perdues en silence.
      const earlier = claudeExtraTyped.get(key);
      if (earlier !== undefined) ignored.push(earlier);
      claudeExtraTyped.set(key, tokens.slice(i, next).join(" "));
      claudeExtra[key] = value ?? null;
      i = next;
    }
  }

  const configSteps = (["model", "thought_level", "mode"] as const).flatMap((category) => steps.get(category) ?? []);
  const env = { ...o.env };

  if (harness === "agy") {
    return { harness, label: "agy", delivery: "held", argv: [o.binary, "acp", ...agyArgs], env, configSteps, ignored, resume };
  }

  if (env.CLAUDE_CODE_EXECUTABLE === undefined && o.claudeExecutable !== undefined) env.CLAUDE_CODE_EXECUTABLE = o.claudeExecutable;
  const meta = (extraArgs: Record<string, string | null>): Record<string, unknown> => ({
    systemPrompt: { append: PEER_INSTRUCTION },
    claudeCode: { options: { extraArgs: { ...extraArgs, settings: JSON.stringify(CLAUDE_SESSION_SETTINGS) } } },
  });
  return {
    harness,
    label: "Claude",
    delivery: "auto",
    argv: [o.binary],
    env,
    // Une session neuve reçoit le nom interne ; une reprise garde celui qu'elle avait (la renommer a déjà causé
    // un incident, voir `RESUME_FLAGS` dans `run.ts`). Les deux sont fournis : `-c` sans session retombe sur une neuve.
    newSessionMeta: meta({ ...claudeExtra, name: internalSessionName(o.name) }),
    loadSessionMeta: meta(claudeExtra),
    configSteps,
    ignored,
    resume,
  };
}

/**
 * La session la plus récente du dossier `cwd` : filtre sur le dossier, tri par `updatedAt` décroissant,
 * les sessions sans date en dernier. `undefined` quand aucune ne correspond.
 */
export function pickLatestSession(sessions: { sessionId: string; cwd: string; updatedAt?: string | null }[], cwd: string): string | undefined {
  const timeOf = (session: { updatedAt?: string | null }): number => {
    const time = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
  };
  const inFolder = sessions.filter((session) => session.cwd === cwd);
  let best: (typeof inFolder)[number] | undefined;
  for (const session of inFolder) if (best === undefined || timeOf(session) > timeOf(best)) best = session;
  return best?.sessionId;
}
