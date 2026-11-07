import { randomBytes } from "node:crypto";
import { isChildOf } from "../bus/peer-pid.ts";
import { ProtocolMismatchError, registerPeer, type Registration } from "../bus/register.ts";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexCourier, type CodexCourierOptions } from "../codex/courier.ts";
import { CODEX_EMBEDDED_REASON, codexEmbeddedFlag, engineIssues, flagName, OPENCODE_STANDALONE_REASON, opencodeArgvIssues, type EngineIssue, type EngineIssueCode } from "../config/engine-rules.ts";
import { ConfigError, loadAgentEngine, type Engine, type ForeignHarness, type Harness } from "../config/network.ts";
import { createBridgeCourier, type BridgeCourierOptions } from "../bridge/courier.ts";
import { dstPluginState, type DstPluginState } from "../install/dst.ts";
import { dshHome, dstBridgeSocketPath, dstPrefsDir, piBridgeSocketPath } from "../paths.ts";
import { createHookedCourier, type HookedCourierOptions } from "../hooked/courier.ts";
import { agyAdapter } from "../hooked/agy.ts";
import { grokAdapter } from "../hooked/grok.ts";
import { agyPreflight, grokPreflight } from "../hooked/preflight.ts";
import { createOpencodeCourier, type OpencodeCourierOptions } from "../opencode/courier.ts";
import { hasModel, parseModelRef, type ModelRef } from "../opencode/model.ts";
import { createOpencodeClient, ensureService, OpencodeHttpError, type OpencodeClient, type OpencodeSession, type ServiceInfo } from "../opencode/service.ts";
import { resolveEnv } from "../config/secrets.ts";
import type { Courier } from "../understudy/courier.ts";
import { runUnderstudy } from "../understudy/understudy.ts";
import { inferFromMode } from "../understudy/from-mode.ts";
import { MessageQueue } from "../understudy/queue.ts";
import { errorMessage, logEvent } from "../log.ts";
import { assertNameFree, chooseName, nameFormatProblem, withNameLock } from "../naming/choose.ts";
import { UsageError, type RunArgs } from "./args.ts";
import { dstRefusal, dstWorkingDirectory, withDshBackend } from "./dst-argv.ts";
import { parseOpencodeArgv, stripOpencodeModel } from "./opencode-argv.ts";
import { piRefusal } from "./pi-argv.ts";
import { assertOwnPane, PaneError, tagPane, tmuxTarget, type PaneProbe } from "./pane.ts";

export interface RunDeps {
  probe?: PaneProbe;
  which: (bin: string) => string | null;
  execve: (file: string, argv: string[], env: Record<string, string>) => never;
  runUnderstudy: typeof runUnderstudy;
  createCodexCourier: (o: CodexCourierOptions) => Courier;
  createHookedCourier: (o: HookedCourierOptions) => Courier;
  /** Coordonnées d'un service opencode vivant (démarré au besoin) ; `undefined` s'il reste injoignable. */
  ensureOpencodeService: () => Promise<ServiceInfo | undefined>;
  opencodeClient: (info: ServiceInfo) => OpencodeClient;
  createOpencodeCourier: (o: OpencodeCourierOptions) => Courier;
  /** Livreur des harnais à pont (dst, pi). */
  createBridgeCourier: (o: BridgeCourierOptions) => Courier;
  /** État du plugin idnma dans le dossier de dst (`home`) ; lève `ConfigError` si ses marqueurs sont incohérents. */
  dstPluginState: (home: string) => DstPluginState;
  tmuxTarget: (paneId: string) => string;
  tagPane: (paneId: string, agentKey: string, name: string | undefined) => void;
}

/** L'extension idnma de Pi, dans ce checkout : `idnma run` la passe à Pi par `-e` (spec pi §2, D2). */
export const PI_EXTENSION_PATH = fileURLToPath(new URL("../pi/extension.ts", import.meta.url));

/** Pose les options de pane d'IdemA ; un échec est journalisé et ne bloque jamais le lancement. */
function markPane(d: RunDeps, agentKey: string, name: string | undefined): void {
  const paneId = (d.probe?.env ?? process.env).TMUX_PANE;
  if (paneId === undefined) return;
  try {
    d.tagPane(paneId, agentKey, name);
  } catch (error) {
    logEvent("pane-tag-failed", { pane: paneId, message: errorMessage(error) });
  }
}

// Drapeaux de reprise d'une session existante. Volontairement large (`-c` et `-r` compris) : un
// faux positif ne coûte qu'un `--name` en moins, un faux négatif renomme la session reprise et
// invalide le nom que le harnais vient d'afficher (incident caserne du 23/08/2026). `--from-pr`
// reprend la session liée à une PR (« Resume a session linked to a PR », aide de Claude 2.1.312).
const RESUME_FLAGS = new Set(["--resume", "-r", "--continue", "-c", "--from-pr"]);

/** Le passthrough demande-t-il la reprise d'une session ? `--resume=<id>` et `--from-pr=<pr>` comptent aussi. */
export function isResume(passthrough: string[]): boolean {
  return passthrough.some((arg) => RESUME_FLAGS.has(arg) || arg.startsWith("--resume=") || arg.startsWith("--from-pr="));
}

/** Valeur de la dernière occurrence de `flag` (nom long, à valeur) dans `argv` : `--x v`, `--x=v`, `-a v` ou `-av`. */
function flagValue(harness: Harness, argv: string[], flag: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (flagName(harness, token) !== flag) continue;
    if (token.startsWith("--")) value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[i + 1];
    else value = token.length > 2 ? token.slice(2) : argv[i + 1];
  }
  return value;
}

/**
 * Argv du harnais : le modèle et les options de l'engine, le `--name` donné par idnma (`name`,
 * claude seulement), puis la ligne de commande, qui a le dernier mot. Un flag tapé retire le même
 * flag des valeurs par défaut, avec sa valeur : le jeton suivant quand il n'est pas lui-même un flag.
 */
export function buildHarnessArgv(engine: Engine, o: { name?: string; passthrough: string[] }): string[] {
  // La TUI d'opencode n'a pas de `--model` : son modèle passe par le service (tâche 6), jamais par l'argv. Dst non plus :
  // son modèle se choisit dans la TUI, et un `model:` d'engine est refusé avant d'arriver ici.
  const injectsModel = engine.model && engine.harness !== "opencode" && engine.harness !== "dst";
  const defaults = [...(injectsModel ? ["--model", engine.model!] : []), ...engine.options, ...(o.name === undefined ? [] : ["--name", o.name])];
  const typed = new Set(o.passthrough.map((token) => flagName(engine.harness, token)));
  const kept: string[] = [];
  for (let i = 0; i < defaults.length; i++) {
    const token = defaults[i]!;
    const name = flagName(engine.harness, token);
    if (name === undefined || !typed.has(name)) {
      kept.push(token);
      continue;
    }
    const next = defaults[i + 1];
    if (!token.includes("=") && next !== undefined && flagName(engine.harness, next) === undefined) i += 1;
  }
  return [engine.harness, ...kept, ...o.passthrough];
}

/**
 * Dossier où la TUI Codex va tourner : la valeur du dernier `-C <dir>`, `--cd <dir>` ou `--cd=<dir>`
 * (flag de Codex 0.164.0), résolue depuis le dossier courant ; sans flag, le dossier courant.
 */
export function codexWorkingDirectory(argv: string[]): string {
  let directory: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-C" || arg === "--cd") {
      const value = argv[i + 1];
      if (value !== undefined) directory = value;
    } else if (arg.startsWith("--cd=")) {
      directory = arg.slice("--cd=".length);
    }
  }
  return resolve(process.cwd(), directory ?? ".");
}

function definedEnv(...layers: Record<string, string | undefined>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Spec §7.3 : des trames `control`, seule `peer_message_status` (accusé d'un Claude destinataire)
 * est journalisée, réduite à `status` et `orig_msg_id`. Les autres sont ignorées jusqu'à la phase 4.
 */
export function logControlFrame(frame: Record<string, unknown>): void {
  if (frame.action !== "peer_message_status") return;
  logEvent("peer_message_status", {
    ...(typeof frame.status === "string" ? { status: frame.status } : {}),
    ...(typeof frame.orig_msg_id === "string" ? { orig_msg_id: frame.orig_msg_id } : {}),
  });
}

/** Message du service montrable à l'utilisateur : son champ `message` s'il en a un, sinon la requête en échec. */
function serviceFailure(error: unknown): string {
  return error instanceof OpencodeHttpError ? (error.serviceMessage ?? error.message) : errorMessage(error);
}

/** Lève l'erreur d'un contrôle d'engine, de la classe que `runAgent` a toujours employée pour lui. */
function throwIssue(issue: EngineIssue): never {
  if (issue.error === "usage") throw new UsageError(issue.message);
  throw new ConfigError(issue.message);
}

/** Lève le premier contrôle d'engine échoué parmi `codes`, s'il y en a un. */
function throwFirstIssue(engine: Engine, engineSource: string, codes: EngineIssueCode[]): void {
  const issue = engineIssues(engine, engineSource).find((candidate) => codes.includes(candidate.code));
  if (issue !== undefined) throwIssue(issue);
}

/** Lit une référence de modèle `fournisseur/modèle[#variante]` ou refuse sa forme. */
function modelRefOrThrow(text: string): ModelRef {
  const ref = parseModelRef(text);
  if (ref === undefined) throw new UsageError(`--model : « ${text} » n'a pas la forme <fournisseur>/<modèle>.`);
  return ref;
}

interface OpencodeLaunch {
  sessionID: string;
  directory: string;
  /** Argv de la TUI sans le nom du harnais : `-s <id>`, le `<directory>` tapé, puis les options et arguments restants. */
  childArgv: string[];
}

/**
 * Tout ce qui peut échouer avant l'inscription au bus (spec §6) : dossier, modèle, service, session.
 * `undefined` quand le service reste injoignable : l'appelant lance alors opencode hors du bus.
 */
async function prepareOpencode(d: RunDeps, engine: Engine, engineSource: string, typed: string[], builtArgv: string[]): Promise<OpencodeLaunch | undefined> {
  const parsed = parseOpencodeArgv(builtArgv);
  // Formes de `-s` et du modèle : règles partagées avec `idnma configure`. Une forme invalide est une erreur d'usage
  // pour un `-m` tapé, de configuration pour le modèle de l'engine.
  const argvIssue = opencodeArgvIssues(parsed, engine.model, engineSource)[0];
  if (argvIssue !== undefined) throwIssue(argvIssue);
  // Le modèle de l'engine ne vaut que sans modèle tapé ; seul un modèle tapé change celui d'une session reprise.
  const wantedText = parsed.model ?? engine.model;
  const wanted = wantedText === undefined ? undefined : modelRefOrThrow(wantedText);
  const typedText = parseOpencodeArgv(typed).model;
  const typedModel = typedText === undefined ? undefined : modelRefOrThrow(typedText);

  const directory = resolve(process.cwd(), parsed.directory ?? ".");
  if (parsed.directory !== undefined) {
    let found = false;
    try {
      found = statSync(directory).isDirectory();
    } catch {
      // Absent ou illisible : même message.
    }
    if (!found) throw new UsageError(`dossier introuvable : ${directory}`);
  }

  const info = await d.ensureOpencodeService();
  if (info === undefined) return undefined;
  const client = d.opencodeClient(info);

  const checkModel = async (ref: ModelRef, text: string): Promise<void> => {
    if (!hasModel(await client.listModels(directory), ref)) throw new UsageError(`modèle inconnu du service opencode : ${text}`);
  };

  let session: OpencodeSession;
  let origin: "created" | "typed" | "continued";
  try {
    let existing: OpencodeSession | undefined;
    if (parsed.session !== undefined) existing = await client.getSession(parsed.session);
    else if (parsed.resume) existing = (await client.listSessions(directory)).find((candidate) => candidate.parentID === undefined);
    if (existing !== undefined) {
      session = existing;
      origin = parsed.session === undefined ? "continued" : "typed";
      if (typedModel !== undefined) {
        await checkModel(typedModel, typedText!);
        await client.switchModel(session.id, typedModel);
      }
    } else {
      if (wanted !== undefined) await checkModel(wanted, wantedText!);
      session = await client.createSession({
        directory,
        ...(parsed.session === undefined ? {} : { id: parsed.session }),
        ...(wanted === undefined ? {} : { model: wanted }),
      });
      // Un id tapé que le service ne connaissait pas reste « typed » : l'id est celui de l'utilisateur.
      origin = parsed.session === undefined ? "created" : "typed";
    }
  } catch (error) {
    if (!(error instanceof OpencodeHttpError)) throw error;
    throw new ConfigError(`opencode a refusé la session (${serviceFailure(error)})`);
  }
  logEvent("opencode-session", { sessionID: session.id, origin });
  // Seuls `-s` et `-c` sont remplacés (spec §6 point 7) : le `<directory>` tapé reste dans l'argv de la TUI. Placé avant
  // les autres arguments, aucune option sans valeur ne risque de l'absorber ; un dossier venu après `--` y reste.
  const typedDirectory = parsed.directory === undefined ? [] : [parsed.directory];
  const afterSeparator = parsed.directory?.startsWith("-") === true;
  return {
    sessionID: session.id,
    directory,
    childArgv: ["-s", session.id, ...(afterSeparator ? [] : typedDirectory), ...parsed.rest, ...(afterSeparator ? typedDirectory : [])],
  };
}

const defaultDeps: RunDeps = {
  which: (bin) => Bun.which(bin),
  execve: (file, argv, env) => {
    // Les types de Bun déclarent `execve` optionnel ; Bun 1.4.0 le fournit (vérifié).
    if (process.execve === undefined) throw new ConfigError("process.execve est indisponible dans ce runtime.");
    return process.execve(file, argv, env);
  },
  runUnderstudy,
  createCodexCourier,
  createHookedCourier,
  ensureOpencodeService: () => ensureService(),
  opencodeClient: (info) => createOpencodeClient(info),
  createOpencodeCourier,
  createBridgeCourier,
  dstPluginState: (home) => dstPluginState(home),
  tmuxTarget,
  tagPane,
};

export async function runAgent(a: RunArgs, deps: Partial<RunDeps> = {}): Promise<number> {
  const d: RunDeps = { ...defaultDeps, ...deps };
  if (a.agent === undefined) throw new UsageError("un agent est requis.");
  const agentKey = a.agent;

  const { engine, engineKey } = loadAgentEngine(agentKey, a.engine);
  const engineSource = `.idnma.yml (agents.${agentKey}.engines.${engineKey})`;
  // Le contenu du fichier : règles partagées avec `idnma configure`. Les arguments tapés se contrôlent ici.
  if (engine.harness === "codex") {
    throwFirstIssue(engine, engineSource, ["codex-embedded-flag"]);
    const typed = codexEmbeddedFlag(a.passthrough);
    if (typed !== undefined) throw new UsageError(`${typed} ${CODEX_EMBEDDED_REASON}`);
  }
  if (engine.harness === "opencode") {
    throwFirstIssue(engine, engineSource, ["opencode-refused-flag"]);
    const typed = parseOpencodeArgv(a.passthrough).refused;
    if (typed !== undefined) throw new UsageError(`${typed} ${OPENCODE_STANDALONE_REASON}`);
  }
  if (engine.harness === "dst") {
    throwFirstIssue(engine, engineSource, ["dst-model", "dst-refused-flag"]);
    const typed = dstRefusal(a.passthrough);
    if (typed !== undefined) throw new UsageError(typed);
  }
  if (engine.harness === "pi") {
    throwFirstIssue(engine, engineSource, ["pi-refused-flag"]);
    const typed = piRefusal(a.passthrough);
    if (typed !== undefined) throw new UsageError(typed);
  }
  // Un `--name` tapé pour Claude devient le nom de la session sur le bus : même contrôle de forme qu'un nom d'idnma.
  const typedName = engine.harness === "claude" ? flagValue("claude", a.passthrough, "--name") : undefined;
  const nameProblem = typedName === undefined ? undefined : nameFormatProblem(typedName);
  if (nameProblem !== undefined) throw new UsageError(`--name : ${nameProblem}`);
  // Toute erreur de résolution de l'env part avant le moindre effet (pane, nom, bus).
  const env = resolveEnv(engine.env, process.env);
  // Env de l'enfant : celui d'idnma, `DSH_TUI_NO_LAUNCHPAD=1` pour dst (F10) avant l'`env:` de l'engine, qui peut le changer.
  const baseEnv = definedEnv(process.env, engine.harness === "dst" ? { DSH_TUI_NO_LAUNCHPAD: "1" } : {}, env);
  if (engine.harness === "dst") {
    // Le dossier que dst lira : un engine qui fixe `DSH_HOME` le déplace. Avant le pane et le nom (AC-10).
    const plugin = d.dstPluginState(dshHome(baseEnv));
    if (plugin.kind === "absent") throw new ConfigError("le plugin idnma n'est pas installé dans dst : lance idnma install --agent dst");
    if (plugin.kind === "other-checkout") {
      throw new ConfigError(`le plugin idnma est installé dans dst depuis un autre checkout (${plugin.path}) : relance idnma install --agent dst depuis celui-ci`);
    }
  }
  assertOwnPane(d.probe);
  const harness = engine.harness;
  const binary = d.which(harness);
  if (binary === null) throw new ConfigError(`Binaire « ${harness} » introuvable dans le PATH.`);

  if (harness === "claude") {
    // Un `--name` tapé impose le sien, s'il est libre ; une session reprise garde le sien : idnma n'en tire pas.
    let name: string | undefined;
    if (typedName !== undefined) await withNameLock(async () => assertNameFree(typedName));
    else if (!isResume(a.passthrough)) name = await withNameLock(async () => chooseName(agentKey));
    const argv = buildHarnessArgv(engine, { ...(name === undefined ? {} : { name }), passthrough: a.passthrough });
    markPane(d, agentKey, name ?? typedName);
    // Le nom de la session : celui d'idnma, sinon le `--name` tapé, sinon (reprise) la clé d'agent.
    return d.execve(binary, argv, definedEnv(process.env, env, { IDNMA_NAME: name ?? typedName ?? agentKey }));
  }

  const paneId = (d.probe?.env ?? process.env).TMUX_PANE;
  if (paneId === undefined) throw new PaneError("idnma run : $TMUX_PANE est absent.");
  const queue = new MessageQueue();
  // Argv de l'enfant sans le nom du harnais : ce que Codex, Grok ou agy recevront vraiment.
  let childArgv = buildHarnessArgv(engine, { passthrough: a.passthrough }).slice(1);
  if (harness === "dst") childArgv = withDshBackend(childArgv);
  // Où l'agent travaille : celui de Codex suit `-C`/`--cd`, celui de dst son premier positionnel dossier ; le registre de Claude doit le montrer.
  let workingDirectory = harness === "codex" ? codexWorkingDirectory(childArgv) : harness === "dst" ? dstWorkingDirectory(childArgv) : process.cwd();
  // Opencode : dossier, modèle et session sont réglés auprès du service avant l'inscription au bus (spec §6).
  let opencodeSessionID: string | undefined;
  if (harness === "opencode") {
    const launch = await prepareOpencode(d, engine, engineSource, a.passthrough, childArgv);
    if (launch === undefined) {
      // Service injoignable : opencode part tel que tapé, sans modèle (la TUI n'en lit pas), hors du bus.
      process.stderr.write("idnma : service opencode injoignable. opencode démarre hors du bus (il ne recevra ni n'enverra de messages).\n");
      markPane(d, agentKey, undefined);
      return d.execve(binary, [harness, ...stripOpencodeModel(childArgv)], definedEnv(process.env, env));
    }
    opencodeSessionID = launch.sessionID;
    workingDirectory = launch.directory;
    childArgv = launch.childArgv;
  }
  let registration: Registration | null = null;
  // Créé après l'inscription ; le rappel de la boîte le réveille à chaque message déposé en file.
  let courier: Courier | undefined;
  const name = await withNameLock(async () => {
    const chosen = chooseName(agentKey);
    try {
      registration = await registerPeer({
        name: chosen,
        cwd: workingDirectory,
        tmux: d.tmuxTarget(paneId),
        onMessage: (message) => {
          if (!queue.push(message)) logEvent("queue-full", { msgId: message.msgId, from: message.from });
          courier?.onMessage();
        },
        onControl: logControlFrame,
        onError: (error) => logEvent("inbox-error", { message: errorMessage(error) }),
      });
    } catch (error) {
      if (!(error instanceof ProtocolMismatchError)) throw error;
      process.stderr.write(`idnma : ${error.message}. L'agent démarre sans inscription au bus (il ne recevra ni n'enverra de messages).\n`);
    }
    return chosen;
  });

  const fromMode = inferFromMode(harness as ForeignHarness, childArgv, baseEnv, dstPrefsDir(baseEnv));
  const registered: Registration | null = registration;
  if (harness === "codex" && registered !== null) {
    courier = d.createCodexCourier({
      name,
      fromMode,
      registration: registered,
      queue,
      cwd: workingDirectory,
    });
  }
  if (harness === "opencode" && registered !== null) {
    courier = d.createOpencodeCourier({
      name,
      fromMode,
      registration: registered,
      queue,
      sessionID: opencodeSessionID!,
      client: d.opencodeClient,
    });
  }
  // Le pont de dst : socket et jeton tirés à chaque lancement, posés seulement si la doublure est inscrite au bus.
  let childEnv = baseEnv;
  if (harness === "dst" && registered !== null) {
    const socketPath = dstBridgeSocketPath();
    const token = randomBytes(16).toString("hex");
    childEnv = { ...baseEnv, IDNMA_DST_BRIDGE: socketPath, IDNMA_DST_BRIDGE_TOKEN: token };
    courier = d.createBridgeCourier({ harness: "dst", name, fromMode, registration: registered, queue, socketPath, token });
  } else if (harness === "dst") {
    // Doublure non inscrite : des variables du pont héritées d'un parent n'ont pas à atteindre le plugin.
    const { IDNMA_DST_BRIDGE: _bridge, IDNMA_DST_BRIDGE_TOKEN: _token, ...withoutBridge } = baseEnv;
    childEnv = withoutBridge;
  }
  // Pi : même pont, rejoint par l'extension passée en `-e`, seulement si la doublure est inscrite au bus.
  if (harness === "pi" && registered !== null) {
    const socketPath = piBridgeSocketPath();
    const token = randomBytes(16).toString("hex");
    childEnv = { ...baseEnv, IDNMA_PI_BRIDGE: socketPath, IDNMA_PI_BRIDGE_TOKEN: token };
    childArgv = ["-e", PI_EXTENSION_PATH, ...childArgv];
    // Seul le process de Pi, enfant direct de la doublure (son lanceur fait `exec`), rejoint le pont : une
    // commande du bash de Pi hérite du jeton mais descend d'un cran plus bas, elle est refusée.
    courier = d.createBridgeCourier({
      harness: "pi",
      name,
      fromMode,
      registration: registered,
      queue,
      socketPath,
      token,
      isAllowedPeer: (pid) => {
        if (pid === undefined) return false;
        try {
          return isChildOf(pid, process.pid);
        } catch {
          return false;
        }
      },
    });
  } else if (harness === "pi") {
    const { IDNMA_PI_BRIDGE: _bridge, IDNMA_PI_BRIDGE_TOKEN: _token, ...withoutBridge } = baseEnv;
    childEnv = withoutBridge;
  }
  if (courier === undefined && registered !== null && (harness === "grok" || harness === "agy")) {
    const adapter = harness === "grok" ? grokAdapter : agyAdapter;
    courier = d.createHookedCourier({
      adapter,
      name,
      fromMode,
      registration: registered,
      queue,
      preflight: harness === "grok" ? () => grokPreflight({ env: childEnv, argv: childArgv }) : agyPreflight,
    });
  }
  markPane(d, agentKey, name);
  return d.runUnderstudy({
    name,
    // Le binaire déjà résolu : c'est celui qu'on a vérifié, pas celui que l'enfant retrouverait dans son PATH.
    argv: [binary, ...childArgv],
    env: childEnv,
    fromMode,
    registration,
    queue,
    ...(courier === undefined ? {} : { courier }),
    // Les commandes de Codex descendent du daemon, jamais de la TUI : elles n'héritent pas du jeton de contrôle.
    ...(harness === "codex" ? { exportControlEnv: false } : {}),
    // Opencode : sans PTY, et sa TUI recopie son environnement (canal de contrôle compris) dans celui de sa session.
    ...(harness === "opencode" ? { harnessLabel: "opencode" } : {}),
    // Dst : sans PTY, et ses commandes descendent de la TUI et héritent du canal de contrôle (défaut).
    ...(harness === "dst" ? { harnessLabel: "dst" } : {}),
    // Pi : sans PTY, et ses commandes héritent de son environnement, canal de contrôle compris (F10).
    ...(harness === "pi" ? { harnessLabel: "pi" } : {}),
    // Grok et agy tournent derrière un PTY relayé : la sonnette et les frappes de l'utilisateur y passent.
    // Leurs commandes et leurs hooks descendent de la TUI et héritent du canal de contrôle (défaut).
    ...(harness === "grok" || harness === "agy" ? { pty: true, harnessLabel: (harness === "grok" ? grokAdapter : agyAdapter).label } : {}),
  });
}
