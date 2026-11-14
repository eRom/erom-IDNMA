// Fiches des harnais de l'écran unifié et traduction d'un engine en plan de lancement (design §6.2, §6.3).
// Traduction pure : rien n'est lancé ici, la tâche de l'orchestrateur exécute le plan sur ACP.
// Ce module n'importe ni le SDK ACP ni OpenTUI : il sert aussi aux commandes courtes.
import type { FromMode } from "../bus/envelope.ts";
import type { Engine } from "../config/network.ts";
import { flagName } from "../config/engine-rules.ts";
import { UsageError } from "../run/args.ts";
import { buildHarnessArgv } from "../run/run.ts";

// La liste d'entrée de l'écran unifié est `UNIFIED_HARNESSES` (engine-rules.ts) : retirer un harnais = le retirer des deux.
export type UnifiedHarness = "claude" | "agy" | "opencode" | "codex" | "grok" | "pi" | "dst";
/** `auto` : le message d'un pair devient un tour tout de suite ; `held` : il attend la validation de l'humain. */
export type DeliveryRule = "auto" | "held";
export type ResumeRequest = { kind: "new" } | { kind: "continue" } | { kind: "id"; id: string };

/**
 * Le mode de permission que le bus annonce aux pairs : fixe (`fixed`), ou lu dans l'option de session dont la
 * valeur `bypassValue` vaut « tout autorisé » (`option`).
 */
export type PeerModeRule = { kind: "fixed"; mode: FromMode } | { kind: "option"; bypassValue: string };

export interface HarnessProfile {
  /** Nom affiché à l'écran et dans les messages. */
  label: string;
  /** Programme que `idnma` lance : l'adaptateur ACP (claude, codex, pi) ou le harnais lui-même. */
  launchBinary: string;
  /** Le binaire de l'agent que l'adaptateur pilote, et la variable d'env qui le lui désigne. */
  agentBinary?: { name: string; required: boolean; env?: string };
  delivery: DeliveryRule;
}

export const HARNESS_PROFILES: Record<UnifiedHarness, HarnessProfile> = {
  claude: { label: "Claude", launchBinary: "claude-agent-acp", agentBinary: { name: "claude", required: false, env: "CLAUDE_CODE_EXECUTABLE" }, delivery: "auto" },
  agy: { label: "agy", launchBinary: "agy", delivery: "held" },
  opencode: { label: "opencode", launchBinary: "opencode", delivery: "auto" },
  codex: { label: "Codex", launchBinary: "codex-acp", agentBinary: { name: "codex", required: true, env: "CODEX_PATH" }, delivery: "auto" },
  grok: { label: "Grok", launchBinary: "grok", delivery: "auto" },
  pi: { label: "Pi", launchBinary: "pi-acp", agentBinary: { name: "pi", required: true }, delivery: "auto" },
  dst: { label: "dst", launchBinary: "dsh", delivery: "auto" },
};

/** Un réglage à poser après `session/new`. `origin` est le jeton de l'engine, repris dans l'annonce à l'écran. */
export interface ConfigStep {
  category: "model" | "thought_level" | "mode";
  value: string;
  origin: string;
}

export interface LaunchPlan {
  harness: UnifiedHarness;
  label: string;
  delivery: DeliveryRule;
  /** Vrai pour `--auto` d'opencode : idnma répond lui-même « allow once » à chaque demande de permission. */
  autoApprove: boolean;
  peerMode: PeerModeRule;
  argv: string[];
  env: Record<string, string>;
  newSessionMeta?: Record<string, unknown>;
  loadSessionMeta?: Record<string, unknown>;
  configSteps: ConfigStep[];
  /** Les jetons de l'engine ou de la ligne de commande que l'écran unifié ne peut pas honorer, tels que tapés. */
  ignored: string[];
  resume: ResumeRequest;
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

type ProfileHarness = Exclude<UnifiedHarness, "claude" | "agy">;

// Ce que chaque flag d'un harnais autre que claude et agy devient. Un flag absent de la table est annoncé, tel que tapé.
type FlagAction =
  /** `--x <valeur>` : la valeur devient le réglage de la catégorie. */
  | { kind: "step"; category: ConfigStep["category"] }
  /** Flag sans valeur qui pose un réglage de mode. */
  | { kind: "mode"; value: string }
  /** Flag sans valeur qui dispense de demander les permissions (`--auto` d'opencode, `--always-approve` de Grok). */
  | { kind: "approve" }
  | { kind: "continue" }
  /** `--x <id>` reprend cette session ; sans valeur, reprend la dernière. */
  | { kind: "resume" }
  /** `--x <id>` reprend cette session ; sans valeur, annoncé. */
  | { kind: "session" }
  /** Annoncé, avec sa valeur s'il en a une (`withValue`). */
  | { kind: "skip"; withValue: boolean };

// Les clés sont des noms longs, ou des flags courts que `SHORT_ALIASES` ne résout pas pour ce harnais (`-r` de Grok).
const PROFILE_FLAGS: Record<ProfileHarness, Map<string, FlagAction>> = {
  opencode: new Map<string, FlagAction>([
    ["--model", { kind: "step", category: "model" }],
    ["--agent", { kind: "step", category: "mode" }],
    ["--auto", { kind: "approve" }],
    ["--continue", { kind: "continue" }],
    ["--session", { kind: "session" }],
  ]),
  codex: new Map<string, FlagAction>([
    ["--model", { kind: "step", category: "model" }],
    ["--dangerously-bypass-approvals-and-sandbox", { kind: "mode", value: "agent-full-access" }],
    // `-c` de Codex est `--config` : un réglage du binaire, jamais une reprise.
    ["--config", { kind: "skip", withValue: true }],
  ]),
  grok: new Map<string, FlagAction>([
    ["--model", { kind: "step", category: "model" }],
    ["--effort", { kind: "step", category: "thought_level" }],
    ["--reasoning-effort", { kind: "step", category: "thought_level" }],
    ["--always-approve", { kind: "approve" }],
    ["-c", { kind: "continue" }],
    ["--continue", { kind: "continue" }],
    ["-r", { kind: "resume" }],
    ["--resume", { kind: "resume" }],
    // Nommer une session neuve : l'adaptateur ne sait pas la nommer.
    ["-s", { kind: "skip", withValue: true }],
    ["--session-id", { kind: "skip", withValue: true }],
  ]),
  pi: new Map<string, FlagAction>([
    ["--model", { kind: "step", category: "model" }],
    ["--thinking", { kind: "step", category: "thought_level" }],
    ["-c", { kind: "continue" }],
    ["--continue", { kind: "continue" }],
    ["--session", { kind: "session" }],
    // Le sélecteur de session de Pi est interactif : pas de sens dans un écran.
    ["-r", { kind: "skip", withValue: false }],
    ["--resume", { kind: "skip", withValue: false }],
  ]),
  dst: new Map<string, FlagAction>([
    ["--continue", { kind: "continue" }],
    ["--resume", { kind: "resume" }],
  ]),
};

/** Argv de lancement et règle de pairs de chaque harnais « profil », hors réglages tirés des jetons. */
function profileLaunch(harness: ProfileHarness, binary: string, approve: boolean, env: Record<string, string>): { argv: string[]; peerMode: PeerModeRule } {
  const bypassWhen = (condition: boolean): PeerModeRule => ({ kind: "fixed", mode: condition ? "bypass" : "prompting" });
  switch (harness) {
    case "opencode":
      return { argv: [binary, "acp"], peerMode: bypassWhen(approve) };
    case "codex":
      return { argv: [binary], peerMode: { kind: "option", bypassValue: "agent-full-access" } };
    case "grok":
      return { argv: [binary, "agent", "--no-leader", ...(approve ? ["--always-approve"] : []), "stdio"], peerMode: bypassWhen(approve) };
    case "pi":
      return { argv: [binary], peerMode: { kind: "fixed", mode: "bypass" } };
    case "dst":
      return { argv: [binary, "--profile", "acp"], peerMode: bypassWhen(env.DSH_PERMISSION_MODE === "danger-full-access") };
  }
}

/** Traduit les jetons d'un harnais « profil » : réglages, reprise, approbation, et ce qui est annoncé. */
function translateProfileTokens(harness: ProfileHarness, tokens: string[], engineModel: string | undefined) {
  const actions = PROFILE_FLAGS[harness];
  const steps = new Map<ConfigStep["category"], ConfigStep>();
  const ignored: string[] = [];
  let resume: ResumeRequest = { kind: "new" };
  let approve = false;

  // Le modèle d'opencode ne passe pas par l'argv (`buildHarnessArgv`) : l'engine le pose, un `-m` tapé le remplace.
  if (harness === "opencode" && engineModel !== undefined) steps.set("model", { category: "model", value: engineModel, origin: `model: ${engineModel}` });

  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i]!;
    const flag = flagName(harness, token);
    if (flag === undefined) {
      // `resume` de Codex est un positionnel : `resume --last` reprend la dernière, `resume <id>` cette session.
      const following = tokens[i + 1];
      if (harness === "codex" && token === "resume" && following !== undefined) {
        if (following === "--last") {
          resume = { kind: "continue" };
          i += 2;
          continue;
        }
        if (flagName(harness, following) === undefined) {
          resume = { kind: "id", id: following };
          i += 2;
          continue;
        }
      }
      // Un positionnel : il n'y a pas de prompt à passer au lancement d'un écran.
      ignored.push(token);
      i += 1;
      continue;
    }

    const action = actions.get(flag);
    if (action === undefined) {
      ignored.push(token);
      i += 1;
      continue;
    }
    switch (action.kind) {
      case "step": {
        const { value, next } = readValue(harness, tokens, i);
        if (value === undefined) ignored.push(token);
        else steps.set(action.category, { category: action.category, value, origin: `${flag} ${value}` });
        i = next;
        break;
      }
      case "mode":
        steps.set("mode", { category: "mode", value: action.value, origin: flag });
        i += 1;
        break;
      case "approve":
        approve = true;
        i += 1;
        break;
      case "continue":
        resume = { kind: "continue" };
        i += 1;
        break;
      case "resume":
      case "session": {
        const { value, next } = readValue(harness, tokens, i);
        if (value !== undefined) resume = { kind: "id", id: value };
        else if (action.kind === "resume") resume = { kind: "continue" };
        else ignored.push(token);
        i = next;
        break;
      }
      case "skip": {
        const { next } = action.withValue ? readValue(harness, tokens, i) : { next: i + 1 };
        ignored.push(tokens.slice(i, next).join(" "));
        i = next;
        break;
      }
    }
  }
  return { steps, ignored, resume, approve };
}

/** Désigne à l'adaptateur le binaire de l'agent du PATH, sauf si l'env le fixe déjà. */
function setAgentExecutable(env: Record<string, string>, profile: HarnessProfile, executable: string | undefined): void {
  const name = profile.agentBinary?.env;
  if (name !== undefined && env[name] === undefined && executable !== undefined) env[name] = executable;
}

/**
 * Traduit un engine et les flags tapés en plan de lancement. Un flag tapé remplace celui de l'engine
 * exactement comme en mode natif (`buildHarnessArgv`). Lève `UsageError` pour `-r`/`--resume` sans identifiant
 * (claude et agy seulement : les autres harnais lisent un `-r` nu comme une reprise de la dernière session, ou l'annoncent).
 */
export function buildLaunchPlan(o: {
  harness: UnifiedHarness;
  binary: string;
  engine: Engine;
  passthrough: string[];
  name: string;
  /** Env complet de l'agent : process, engine résolu, canal de contrôle. */
  env: Record<string, string>;
  /** Le binaire de l'agent du PATH (`claude`, `codex`) ; posé dans `agentBinary.env` sauf si `env` le fixe déjà. */
  agentExecutable?: string;
}): LaunchPlan {
  const { harness } = o;
  const profile = HARNESS_PROFILES[harness];
  // Le premier élément est le nom du harnais : l'adaptateur n'en a pas besoin.
  const tokens = buildHarnessArgv(o.engine, { passthrough: o.passthrough }).slice(1);

  if (harness !== "claude" && harness !== "agy") {
    const { steps, ignored, resume, approve } = translateProfileTokens(harness, tokens, o.engine.model);
    const env = { ...o.env };
    setAgentExecutable(env, profile, o.agentExecutable);
    const { argv, peerMode } = profileLaunch(harness, o.binary, approve, env);
    return {
      harness,
      label: profile.label,
      delivery: profile.delivery,
      // Grok honore `--always-approve` lui-même (argv) : idnma ne répond à rien pour lui, seul opencode le demande.
      autoApprove: harness === "opencode" && approve,
      peerMode,
      argv,
      env,
      configSteps: (["model", "thought_level", "mode"] as const).flatMap((category) => steps.get(category) ?? []),
      ignored,
      resume,
    };
  }

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
    return {
      harness,
      label: profile.label,
      delivery: profile.delivery,
      autoApprove: false,
      peerMode: { kind: "fixed", mode: agyArgs.includes("--dangerously-skip-permissions") ? "bypass" : "prompting" },
      argv: [o.binary, "acp", ...agyArgs],
      env,
      configSteps,
      ignored,
      resume,
    };
  }

  setAgentExecutable(env, profile, o.agentExecutable);
  const meta = (extraArgs: Record<string, string | null>): Record<string, unknown> => ({
    systemPrompt: { append: PEER_INSTRUCTION },
    claudeCode: { options: { extraArgs: { ...extraArgs, settings: JSON.stringify(CLAUDE_SESSION_SETTINGS) } } },
  });
  return {
    harness,
    label: profile.label,
    delivery: profile.delivery,
    autoApprove: false,
    peerMode: { kind: "option", bypassValue: "bypassPermissions" },
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
