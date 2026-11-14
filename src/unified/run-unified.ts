// Assemblage d'`idnma run` en mode unifié (design §6.1, §6.3, §6.4) : contrôles du pane, nom, inscription au bus, canal
// de contrôle, session ACP, écran, intentions, permissions, messages de pair, signaux et sortie.
// Chargé par import dynamique depuis `runAgent`, sur le seul chemin unifié : il importe le SDK ACP et, par import
// dynamique à son tour, l'écran.
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { constants } from "node:os";
import { AgentNotConnectedError, AgentStartError, connectAgent, SessionNotFoundError, type AgentConnection, type OpenedSession } from "../acp/connection.ts";
import type { PermissionAnswer, PermissionRequest, StopReason } from "../acp/events.ts";
import { buildLaunchPlan, HARNESS_PROFILES, type LaunchPlan, type UnifiedHarness } from "../acp/harness.ts";
import type { FromMode } from "../bus/envelope.ts";
import { reachablePeers, summarizePeer } from "../bus/peers.ts";
import { ProtocolMismatchError, registerPeer, type Registration } from "../bus/register.ts";
import { sendPeerMessage } from "../bus/send.ts";
import { UNIFIED_HARNESSES } from "../config/engine-rules.ts";
import { ConfigError, type Engine } from "../config/network.ts";
import { resolveEnv } from "../config/secrets.ts";
import { errorMessage, logEvent } from "../log.ts";
import { chooseName, withNameLock } from "../naming/choose.ts";
import { assertOwnPane, tagPane, tmuxTarget, type PaneProbe } from "../run/pane.ts";
import { definedEnv, logControlFrame } from "../run/run.ts";
import type { Intent } from "../tui/keys.ts";
import { createSignals } from "../tui/signals.ts";
import { HELD_CHOICES, initialState, nextQueuedPrompt, reduce, type Action, type SessionState, type Status } from "../tui/state.ts";
import type { Screen, ScreenHandlers } from "../tui/view/screen.ts";
import { controlSocketPath, idnmaNesting, startControlServer, type ControlCall, type ControlResponse } from "../understudy/control.ts";
import { MessageQueue } from "../understudy/queue.ts";
import { createPeerDelivery, type PeerDelivery } from "./peer-delivery.ts";
import { missingAdapterMessage, notConnectedMessage } from "./preflight.ts";

export interface UnifiedDeps {
  probe?: PaneProbe;
  which: (bin: string) => string | null;
  tmuxTarget: (paneId: string) => string;
  tagPane: typeof tagPane;
  connectAgent: typeof connectAgent;
  /** Import dynamique de `src/tui/view/screen.ts` par défaut ; les tests injectent un faux `Screen`. */
  openScreen: (o: { cwd: string; branch?: string; handlers: ScreenHandlers }) => Promise<Screen>;
  /** Termine le process ; les tests injectent une fonction qui note le code et rend la main. */
  exit: (code: number) => never;
  /** Écrit les signaux de terminal (OSC 9) ; `process.stdout.write` par défaut. */
  write: (bytes: string) => void;
}

const defaultDeps: UnifiedDeps = {
  which: (bin) => Bun.which(bin),
  tmuxTarget,
  tagPane,
  connectAgent,
  // Jamais dans un try/catch : un échec de chargement de l'écran doit remonter.
  openScreen: async (o) => {
    const { openScreen } = await import("../tui/view/screen.ts");
    return openScreen(o);
  },
  exit: (code) => process.exit(code),
  write: (bytes) => {
    process.stdout.write(bytes);
  },
};

const EXIT_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT", "SIGQUIT"] as const;
const BYPASS_MODE = "bypassPermissions";
const CANCELLED: PermissionAnswer = { outcome: "cancelled" };
const LOG_HINT = "détail dans ~/.config/idema/logs/idnma.log";

/** Levée entre deux étapes du démarrage quand la sortie a commencé : le démarrage s'arrête, la sortie nettoie. */
class StartupAborted extends Error {}

/** Branche du dossier courant pour la ligne d'état ; au mieux (git absent, hors dépôt, tête détachée : rien). */
function currentBranch(cwd: string): string | undefined {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
    const branch = result.exitCode === 0 ? result.stdout.toString().trim() : "";
    return branch === "" || branch === "HEAD" ? undefined : branch;
  } catch {
    return undefined;
  }
}

/** Noms de drapeaux d'une liste de jetons ignorés : jamais leurs valeurs, qui peuvent porter un en-tête ou un réglage. */
function flagNamesOf(tokens: string[]): string[] {
  const names = new Set<string>();
  for (const token of tokens) {
    const first = token.trim().split(/\s+/)[0] ?? "";
    if (first.startsWith("-")) names.add(first.split("=")[0]!);
  }
  return [...names];
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface PermissionSlot {
  request: PermissionRequest;
  resolve: (answer: PermissionAnswer) => void;
  done: boolean;
}

export async function runUnified(o: { agentKey: string; engine: Engine; passthrough: string[]; deps?: Partial<UnifiedDeps> }): Promise<number> {
  const d: UnifiedDeps = { ...defaultDeps, ...o.deps };
  const { agentKey, engine } = o;
  const harness = engine.harness;
  if (harness !== "claude" && harness !== "agy") throw new ConfigError(`Le mode unifié ne vaut que pour ${UNIFIED_HARNESSES.join(", ")} (harnais ${harness}).`);

  // Toute erreur de résolution de l'env, de pane ou de binaire part avant le moindre effet.
  const resolvedEnv = resolveEnv(engine.env, process.env);
  assertOwnPane(d.probe);
  const binary = d.which(HARNESS_PROFILES[harness].launchBinary);
  if (binary === null) throw new ConfigError(missingAdapterMessage(harness));
  // Les contrôles ci-dessus ne se propagent pas aux fonctions déclarées plus bas : valeurs figées ici.
  const unifiedHarness: UnifiedHarness = harness;
  const adapterPath: string = binary;
  const paneId = (d.probe?.env ?? process.env).TMUX_PANE;

  // ---- état partagé du runner ----
  let state: SessionState = initialState(agentKey);
  let name = agentKey;
  let signals = createSignals(name, d.write);
  let lastStatus: Status = state.status;
  let registration: Registration | null = null;
  let control: { stop(): void } | undefined;
  let controlSocket: string | undefined;
  let connection: AgentConnection | undefined;
  let plan: LaunchPlan | undefined;
  let delivery: PeerDelivery | undefined;
  let screen: Screen | undefined;
  let screenDestroyed = false;
  let ready = false;
  let agentLost = false;
  let exiting = false;
  let earlyExit: { code: number | null; signal: string | null } | undefined;
  const queue = new MessageQueue();

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  let resolveStartupSettled!: () => void;
  const startupSettled = new Promise<void>((resolve) => {
    resolveStartupSettled = resolve;
  });
  let startupFinished = false;

  const attempt = async (step: string, action: () => unknown): Promise<void> => {
    try {
      await action();
    } catch (error) {
      logEvent("cleanup-error", { step, message: errorMessage(error) });
    }
  };

  // ---- rendu ----

  /** Rend l'état à l'écran, jamais après `destroy()` (OpenTUI ne survit pas à un rendu tardif), et suit les signaux. */
  function publish(): void {
    if (screen === undefined || screenDestroyed) return;
    screen.render(state);
    signals.onStatus(lastStatus, state.status);
    lastStatus = state.status;
  }

  function commit(action: Action): void {
    state = reduce(state, action);
    publish();
  }

  function notice(text: string, tone: "info" | "error"): void {
    commit({ type: "notice", text, tone });
  }

  // ---- sortie, idempotente : le terminal d'abord, puis l'inscription, le canal et l'agent ----

  let released: Promise<void> | undefined;
  /** Libère tout ce que le runner a pris, chaque étape dans son propre essai ; sert la sortie et l'échec de démarrage. */
  function releaseResources(): Promise<void> {
    released ??= (async () => {
      await attempt("peers-leave", () => delivery?.leave());
      await attempt("connection-close", () => connection?.close());
      await attempt("unregister", () => registration?.unregister());
      await attempt("control-stop", () => control?.stop());
      await attempt("control-socket", () => (controlSocket === undefined ? undefined : rmSync(controlSocket, { force: true })));
      removeProcessHandlers();
    })();
    return released;
  }

  let exitPromise: Promise<number> | undefined;
  function exitWith(code: number): Promise<number> {
    exitPromise ??= (async () => {
      exiting = true;
      settleAllPermissions();
      if (!startupFinished) {
        // Le démarrage attend peut-être l'agent : sa fermeture le débloque, puis il s'arrête de lui-même.
        void attempt("connection-close", () => connection?.close());
        await startupSettled;
      }
      // Le terminal revient tout de suite : plus aucun rendu après `destroy()`.
      screenDestroyed = true;
      if (screen !== undefined) {
        await attempt("screen-destroy", () => screen!.destroy());
        // Une progression restée allumée par un tour en cours est éteinte.
        signals.onStatus(lastStatus, "idle");
      }
      await releaseResources();
      resolveDone(code);
      d.exit(code);
      return code;
    })();
    return exitPromise;
  }

  // ---- gestionnaires de process : posés avant tout effet ----

  const signalHandlers = new Map<(typeof EXIT_SIGNALS)[number], () => void>();
  for (const signal of EXIT_SIGNALS) signalHandlers.set(signal, () => void exitWith(128 + (constants.signals[signal] ?? 0)));
  const onUncaught = (error: unknown): void => {
    logEvent("unified-crash", { message: errorMessage(error) });
    void exitWith(1);
  };
  // Dernier recours : le process s'arrête alors que l'agent vit encore, son groupe ne lui survit pas.
  const onProcessExit = (): void => {
    const pid = connection?.pid;
    if (pid === undefined || pid <= 0 || !groupAlive(pid)) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // groupe déjà vide
    }
  };
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
  process.on("exit", onProcessExit);
  function removeProcessHandlers(): void {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
    process.off("exit", onProcessExit);
  }

  // ---- permissions : une seule à l'écran, les suivantes attendent ----

  let shownPermission: PermissionSlot | undefined;
  const waitingPermissions: PermissionSlot[] = [];

  function showNextPermission(): void {
    if (shownPermission !== undefined) return;
    const next = waitingPermissions.shift();
    if (next === undefined) return;
    shownPermission = next;
    commit({ type: "permission", request: next.request });
  }

  /** Répond une fois à une demande, et ferme sa présentation une fois : `permissionResolved` par demande affichée. */
  function settlePermission(slot: PermissionSlot, answer: PermissionAnswer, promoteNext = true): void {
    if (slot.done) return;
    slot.done = true;
    slot.resolve(answer);
    if (shownPermission === slot) {
      shownPermission = undefined;
      commit({ type: "permissionResolved" });
      if (promoteNext) showNextPermission();
    } else {
      const index = waitingPermissions.indexOf(slot);
      if (index !== -1) waitingPermissions.splice(index, 1);
    }
  }

  /** Toutes les demandes à la fois : celles qui attendent sont closes sans jamais passer à l'écran (ni statut, ni notification). */
  function settleAllPermissions(): void {
    for (const slot of waitingPermissions.splice(0)) {
      slot.done = true;
      slot.resolve(CANCELLED);
    }
    if (shownPermission !== undefined) settlePermission(shownPermission, CANCELLED);
  }

  function onPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    return new Promise<PermissionAnswer>((resolve) => {
      if (screen === undefined || agentLost || exiting || signal.aborted) {
        resolve(CANCELLED);
        return;
      }
      const slot: PermissionSlot = { request, resolve, done: false };
      // ⌃C annule toutes les demandes dans la même boucle : la suivante n'est présentée qu'après, et seulement si l'une
      // d'elles a été retirée seule par l'agent (sinon elle est déjà close et plus rien n'attend).
      signal.addEventListener(
        "abort",
        () => {
          settlePermission(slot, CANCELLED, false);
          queueMicrotask(showNextPermission);
        },
        { once: true },
      );
      waitingPermissions.push(slot);
      if (shownPermission === undefined) showNextPermission();
    });
  }

  // ---- tours ----

  /** Ouvre un tour : `turnStarted` et l'appel à `connection.prompt` partent dans le même tour de boucle (C4). */
  function beginTurn(prompt: string, origin: "user" | "peer", msgId?: string): void {
    commit({ type: "turnStarted" });
    registration?.setStatus("busy");
    logEvent("unified-prompt", { origin, ...(msgId === undefined ? {} : { msgId }) });
    void runTurn(prompt);
  }

  async function runTurn(prompt: string): Promise<void> {
    let stopReason: StopReason;
    let failed = false;
    try {
      stopReason = await connection!.prompt(prompt);
    } catch (error) {
      // L'arrêt de l'agent dit déjà pourquoi (bandeau de sortie) : pas de seconde ligne.
      if (!agentLost) notice(`Turn failed: ${errorMessage(error)}`, "error");
      stopReason = "cancelled";
      failed = true;
    }
    endTurn(stopReason, failed);
  }

  function endTurn(stopReason: StopReason, failed = false): void {
    settleAllPermissions();
    commit({ type: "turnEnded", stopReason, ...(failed ? { failed } : {}) });
    registration?.setStatus("idle");
    // Après la perte de l'agent, plus rien n'est livré ni présenté (C5).
    if (agentLost || exiting) return;
    // Le renvoi au pair n'attend pas l'écran : sa promesse part au journal si elle échoue.
    void delivery?.onTurnEnded(stopReason).catch((error: unknown) => logEvent("unified-delivery-error", { step: "turn-ended", message: errorMessage(error) }));
    // La file locale d'abord ; le repos n'est annoncé au livreur que quand elle est vide.
    const [next, afterQueue] = nextQueuedPrompt(state);
    if (next !== undefined) {
      state = afterQueue;
      publish();
      beginTurn(next, "user");
    } else {
      delivery?.onIdle();
    }
  }

  function sendUserPrompt(text: string): void {
    if (agentLost || exiting) return;
    const wasActive = state.turnActive;
    commit({ type: "userPrompt", text });
    if (!wasActive) beginTurn(text, "user");
  }

  function startPeerTurn(prompt: string, display: { from: string; text: string }, msgId?: string): void {
    commit({ type: "peerTurn", from: display.from, text: display.text });
    beginTurn(prompt, "peer", msgId);
  }

  // ---- réglages ----

  async function changeOption(category: string, value: string): Promise<void> {
    try {
      const options = await connection!.setOption(category, value);
      // La réponse de l'agent fait foi : jamais un changement local optimiste.
      commit({ type: "event", event: { type: "config", options }, origin: "live" });
    } catch (error) {
      notice(`Could not change ${category}: ${errorMessage(error)}`, "error");
    }
  }

  function nextMode(): Promise<void> | undefined {
    const option = state.options.find((candidate) => candidate.category === "mode");
    if (option === undefined) return undefined;
    // Le cycle saute `bypassPermissions` : il ne s'atteint que par le panneau des réglages ou l'engine.
    const values = option.values.map((value) => value.value).filter((value) => value !== BYPASS_MODE);
    const next = values[(values.indexOf(option.currentValue) + 1) % Math.max(values.length, 1)];
    return next === undefined || next === option.currentValue ? undefined : changeOption("mode", next);
  }

  // ---- intentions ----

  /** `/quit` quitte, tout autre texte part comme prompt ; rend vrai si le texte a été envoyé (la saisie peut se vider). */
  function submitText(raw: string): boolean {
    if (raw.trim() === "/quit") {
      void exitWith(0);
      return false;
    }
    sendUserPrompt(raw);
    return true;
  }

  function confirm(): Promise<void> | undefined {
    const pending = state.pending;
    if (pending?.kind === "permission") {
      const choice = pending.request.choices[pending.selected];
      if (shownPermission !== undefined) settlePermission(shownPermission, choice === undefined ? CANCELLED : { outcome: "selected", optionId: choice.optionId });
      return undefined;
    }
    if (pending?.kind === "held") {
      const choice = HELD_CHOICES[pending.selected];
      if (choice === "Deliver") delivery?.deliverHeld();
      else if (choice === "Later") delivery?.laterHeld();
      else void settleDismissed();
      commit({ type: "heldResolved", queued: queue.size });
      return undefined;
    }
    const overlay = screen?.overlay();
    if (overlay === "settings") {
      const choice = screen!.settingsChoice();
      return choice === undefined ? undefined : changeOption(choice.category, choice.value);
    }
    if (overlay === "palette") {
      const command = screen!.paletteChoice();
      const typed = (screen!.paletteText() ?? "").replace(/^\//, "").trim();
      // Un texte qui n'est pas un nom de commande (argument, aucune correspondance, chemin collé) part tel que tapé :
      // `/quit` quitte, `/review 42` est envoyé. Le brouillon de la saisie reste en place.
      if (typed !== "" && (command === undefined || /\s/.test(typed))) {
        screen!.closeOverlay();
        submitText(`/${typed}`);
        return undefined;
      }
      if (command !== undefined) {
        screen!.closeOverlay();
        sendUserPrompt(`/${command.name}`);
      }
    }
    return undefined;
  }

  /** « Dismiss » : l'expéditeur apprend que son message n'a pas été livré ; la file continue de se présenter. */
  function settleDismissed(): Promise<void> {
    return (delivery?.dismissHeld() ?? Promise.resolve()).catch((error: unknown) => logEvent("unified-delivery-error", { step: "dismiss", message: errorMessage(error) }));
  }

  function refuse(): void {
    const pending = state.pending;
    if (pending?.kind === "permission") {
      // Le choix de refus : le premier `reject_once`, sinon `reject_always`, sinon l'annulation.
      const choices = pending.request.choices;
      const rejection = choices.find((choice) => choice.kind === "reject_once") ?? choices.find((choice) => choice.kind === "reject_always");
      if (shownPermission !== undefined) settlePermission(shownPermission, rejection === undefined ? CANCELLED : { outcome: "selected", optionId: rejection.optionId });
    } else if (pending?.kind === "held") {
      void settleDismissed();
      commit({ type: "heldResolved", queued: queue.size });
    }
  }

  function handleIntent(intent: Intent, input: string): Promise<void> | undefined {
    switch (intent) {
      case "submit": {
        if (input.trim() === "") return undefined;
        if (submitText(input)) screen!.clearInput();
        return undefined;
      }
      case "interrupt":
        // Annule le tour et répond `cancelled` à une permission en attente (leur signal est interrompu).
        connection!.cancel();
        return undefined;
      case "clearInput":
        screen!.clearInput();
        return undefined;
      case "quit":
        // Une touche après la mort de l'agent est une fin anormale.
        void exitWith(state.exit === undefined ? 0 : 1);
        return undefined;
      case "confirm":
        return confirm();
      case "refuse":
        refuse();
        return undefined;
      case "selectUp":
      case "selectDown":
        commit({ type: "select", delta: intent === "selectDown" ? 1 : -1 });
        return undefined;
      case "reopenHeld":
        delivery?.reopenHeld();
        return undefined;
      case "nextMode":
        return nextMode();
      default:
        // Palette, plan, réglages, défilement, fermeture de surcouche : l'écran les traite lui-même.
        return undefined;
    }
  }

  /** Ce qui sort d'ici ne remonte jamais à OpenTUI (il écrirait sur l'écran) : une erreur part au journal. */
  const handlers: ScreenHandlers = {
    onIntent(intent, input) {
      const logFailure = (error: unknown): void => logEvent("unified-intent-error", { intent, message: errorMessage(error) });
      try {
        const pending = handleIntent(intent, input);
        if (pending !== undefined) pending.catch(logFailure);
      } catch (error) {
        logFailure(error);
      }
    },
  };

  // ---- agent ----

  function handleAgentExit(code: number | null, signal: string | null): void {
    if (agentLost || exiting) return;
    agentLost = true;
    settleAllPermissions();
    commit({ type: "agentExited", code, signal });
    registration?.setStatus("idle");
    void delivery?.agentLost().catch((error: unknown) => logEvent("unified-delivery-error", { step: "agent-lost", message: errorMessage(error) }));
  }

  function fromMode(): FromMode {
    if (plan?.harness === "agy") return plan.argv.includes("--dangerously-skip-permissions") ? "bypass" : "prompting";
    return state.options.find((option) => option.category === "mode")?.currentValue === BYPASS_MODE ? "bypass" : "prompting";
  }

  // ---- démarrage ----

  const assertNotExiting = (): void => {
    if (exiting) throw new StartupAborted();
  };

  /** Ce que le démarrage dit à l'utilisateur quand l'ouverture échoue, sur le terminal encore libre. */
  function startFailureMessage(error: unknown, launchPlan: LaunchPlan): string {
    if (error instanceof AgentNotConnectedError) return notConnectedMessage(launchPlan.harness);
    if (error instanceof SessionNotFoundError) {
      const id = launchPlan.resume.kind === "id" ? launchPlan.resume.id : "la plus récente";
      return `Session « ${id} » introuvable pour ${launchPlan.label}.`;
    }
    const code = error instanceof AgentStartError ? error.code : null;
    return `${launchPlan.label} n'a pas démarré (${code ?? "sans code"}) ; ${LOG_HINT}.`;
  }

  async function startup(): Promise<"ready" | "failed" | "aborted"> {
    const busNotes: string[] = [];
    let opened!: OpenedSession;
    try {
      name = await withNameLock(async () => {
        const chosen = chooseName(agentKey);
        try {
          registration = await registerPeer({
            name: chosen,
            cwd: process.cwd(),
            ...(paneId === undefined ? {} : { tmux: d.tmuxTarget(paneId) }),
            onMessage: (message) => {
              if (!queue.push(message)) logEvent("queue-full", { msgId: message.msgId, from: message.from });
              // Après la perte de l'agent, plus rien n'est présenté : la file est refusée à la sortie (C5).
              if (!agentLost || exiting) delivery?.onMessage();
            },
            onControl: logControlFrame,
            onError: (error) => logEvent("inbox-error", { message: errorMessage(error) }),
          });
        } catch (error) {
          if (!(error instanceof ProtocolMismatchError)) throw error;
          busNotes.push(`Not on the peer bus: ${error.message}`);
        }
        return chosen;
      });
      state = initialState(name);
      lastStatus = state.status;
      signals = createSignals(name, d.write);
      assertNotExiting();

      const token = randomBytes(16).toString("hex");
      controlSocket = controlSocketPath();
      control = await startControlServer({
        socketPath: controlSocket,
        token,
        handle: async (request: ControlCall): Promise<ControlResponse> => {
          if (request.op === "read") return { ok: true, message: null };
          if (request.op === "hook") return { ok: true, reply: {} };
          if (request.op === "list") return { ok: true, peers: reachablePeers((entry) => entry.pid === process.pid, idnmaNesting()).map(summarizePeer) };
          if (registration === null) return { ok: false, error: "pas d'inscription au bus" };
          const { msgId } = await sendPeerMessage({ fromSocketPath: registration.socketPath, fromName: name, fromMode: fromMode(), to: request.to, body: request.body });
          return { ok: true, msgId };
        },
      });
      assertNotExiting();

      const agentExecutable = unifiedHarness === "claude" ? d.which("claude") : null;
      const launchPlan = buildLaunchPlan({
        harness: unifiedHarness,
        binary: adapterPath,
        engine,
        passthrough: o.passthrough,
        name,
        env: definedEnv(process.env, resolvedEnv, { IDNMA_NAME: name, IDNMA_CONTROL_SOCKET: controlSocket, IDNMA_CONTROL_TOKEN: token }),
        ...(agentExecutable === null ? {} : { agentExecutable }),
      });
      plan = launchPlan;

      if (registration !== null) {
        delivery = createPeerDelivery({
          rule: launchPlan.delivery,
          name,
          label: launchPlan.label,
          queue,
          registration,
          fromMode,
          // Rien n'est livré avant que la session soit ouverte et l'écran prêt.
          isIdle: () => ready && !state.turnActive && state.exit === undefined && !agentLost && !exiting,
          startPeerTurn,
          showHeld: (message, queued) => commit({ type: "held", from: message.from, text: message.text, queued }),
          heldCountChanged: (queued) => commit({ type: "heldCount", queued }),
        });
      }

      try {
        connection = d.connectAgent(launchPlan, {
          onEvent(event, origin) {
            commit({ type: "event", event, origin });
            // Les événements rejoués n'alimentent que l'état ; seuls les vivants nourrissent la réponse au pair.
            if (origin !== "live" || delivery === undefined) return;
            if (event.type === "chunk" && event.role === "agent") delivery.onTurnText(event.text);
            else if (event.type === "tool") delivery.onTurnTool();
          },
          onPermission: onPermission,
          onExit(code, signal) {
            // Pendant le démarrage, `open()` rapporte lui-même la mort de l'agent.
            if (screen === undefined || !ready) earlyExit = { code, signal };
            else handleAgentExit(code, signal);
          },
        });
        opened = await connection.open(process.cwd());
      } catch (error) {
        assertNotExiting();
        const message = startFailureMessage(error, launchPlan);
        // Le journal ne garde que la classe et le code : le texte d'une erreur de l'agent peut porter l'e-mail du compte.
        logEvent("unified-start-failed", {
          error: error instanceof Error ? error.name : "unknown",
          ...(error instanceof AgentStartError && error.code !== null ? { code: error.code } : {}),
        });
        process.stderr.write(`${message}\n`);
        await releaseResources();
        return "failed";
      }
      assertNotExiting();

      // L'état des options à l'ouverture : celui que l'agent annonce après les réglages de l'engine.
      state = reduce(state, { type: "event", event: { type: "config", options: opened.options }, origin: "live" });
      const branch = currentBranch(process.cwd());
      screen = await d.openScreen({ cwd: process.cwd(), ...(branch === undefined ? {} : { branch }), handlers });
      assertNotExiting();

      // Les annonces de l'ouverture, dans le fil.
      for (const text of busNotes) state = reduce(state, { type: "notice", text, tone: "info" });
      const ignoredTokens = [...launchPlan.ignored, ...opened.ignored];
      for (const token of ignoredTokens) {
        // Seul claude-agent-acp traite `/remote-control` : sur agy, le drapeau ignoré n'a pas de remplaçant.
        const instead = unifiedHarness === "claude" && token === "--remote-control" ? " (type /remote-control instead)" : "";
        state = reduce(state, { type: "notice", text: `Ignored in unified mode: ${token}${instead}`, tone: "info" });
      }
      if (ignoredTokens.length > 0) logEvent("unified-ignored", { flags: flagNamesOf(ignoredTokens) });
      if (opened.noPreviousSession) state = reduce(state, { type: "notice", text: "No previous session in this folder: new session.", tone: "info" });
      if (opened.resumed && opened.replayed === 0) state = reduce(state, { type: "notice", text: "The agent replayed nothing from this session.", tone: "info" });

      // Le pane reste marqué pour IdemA ; un échec n'empêche rien.
      if (paneId !== undefined) {
        try {
          d.tagPane(paneId, agentKey, name);
        } catch (error) {
          logEvent("pane-tag-failed", { pane: paneId, message: errorMessage(error) });
        }
      }

      ready = true;
      publish();
      if (earlyExit !== undefined) handleAgentExit(earlyExit.code, earlyExit.signal);
      // Ce qui a attendu l'ouverture dans la file (messages arrivés pendant le démarrage).
      else delivery?.onIdle();
      return "ready";
    } catch (error) {
      if (error instanceof StartupAborted) return "aborted";
      // Une erreur d'usage ou de chargement : rien ne reste pris, l'erreur remonte telle quelle. Un écran déjà ouvert
      // rend d'abord le terminal : l'erreur imprimée par l'appelant ne doit pas tomber dessus.
      if (screen !== undefined) {
        screenDestroyed = true;
        logEvent("unified-crash", { message: errorMessage(error) });
        await attempt("screen-destroy", () => screen!.destroy());
      }
      await releaseResources();
      throw error;
    } finally {
      startupFinished = true;
      resolveStartupSettled();
    }
  }

  const outcome = await startup();
  if (outcome === "failed") return 1;
  return done;
}
