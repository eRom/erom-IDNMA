import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { constants } from "node:os";
import type { FromMode } from "../bus/envelope.ts";
import type { Registration } from "../bus/register.ts";
import { reachablePeers, summarizePeer } from "../bus/peers.ts";
import { sendPeerMessage } from "../bus/send.ts";
import { errorMessage, logEvent } from "../log.ts";
import { controlSocketPath, startControlServer, type ControlCall, type ControlResponse, type VerifyCaller } from "./control.ts";
import { CourierUnavailableError, rejectQueuedMessages, waitBounded, type Courier } from "./courier.ts";
import { spawnUnderPty, type PtyChild } from "./pty.ts";
import type { MessageQueue } from "./queue.ts";

type CleanupSignal = "SIGINT" | "SIGHUP" | "SIGTERM";
const SIGNALS: CleanupSignal[] = ["SIGINT", "SIGHUP", "SIGTERM"];
const CONTROL_ENV_KEYS = ["IDNMA_NAME", "IDNMA_CONTROL_SOCKET", "IDNMA_CONTROL_TOKEN"];
const DEFAULT_FAREWELL_WAIT_MS = 3_000;

/**
 * Process parent de longue durée d'un agent étranger : garde l'inscription au bus, sert le canal
 * de contrôle, lance l'agent et rend son code de sortie. Tout est retiré à la sortie, quelle
 * qu'en soit la cause (fin de l'enfant, SIGHUP, SIGTERM, échec du lancement).
 */
export async function runUnderstudy(o: {
  name: string;
  argv: string[];
  env: Record<string, string>;
  fromMode: FromMode;
  registration: Registration | null;
  queue: MessageQueue;
  /**
   * Livreur du harnais : il prépare le lancement, reçoit les messages du bus et admet les commandes
   * du harnais. Avec lui, la file lui appartient et l'op `read` du canal rend ce que sa méthode `read` rend.
   */
  courier?: Courier;
  /** Admission des commandes lancées par le daemon Codex ; par défaut celle du livreur, sinon seule la voie du jeton ouvre le canal. */
  verifyCaller?: VerifyCaller;
  onControlReady?: (c: { socketPath: string; token: string }) => void;
  /**
   * Exporte le canal de contrôle à l'enfant (`IDNMA_NAME`, `IDNMA_CONTROL_SOCKET`, `IDNMA_CONTROL_TOKEN`) ;
   * vrai par défaut. Faux pour Codex : ses commandes descendent du daemon, jamais de la TUI, et ne doivent
   * pas hériter du jeton d'un agent.
   */
  exportControlEnv?: boolean;
  /**
   * Lance l'agent derrière un PTY relayé (stdin et stdout du process) ; le livreur reçoit le `Terminal`
   * à `afterSpawn` pour taper dans l'agent et observer les frappes. Faux par défaut : stdio hérité.
   */
  pty?: boolean;
  /** Entrée du terminal de l'utilisateur pour le PTY ; le stdin du process par défaut, injectable pour les tests. */
  ptyStdin?: NodeJS.ReadStream;
  /** Sortie du terminal de l'utilisateur pour le PTY ; le stdout du process par défaut, injectable pour les tests. */
  ptyStdout?: NodeJS.WriteStream;
  /** Nom du harnais dans les messages de repli hors du bus (« Codex », « Grok », « agy ») ; « Codex » par défaut. */
  harnessLabel?: string;
  /** Attente maximale des adieux du livreur après la fin de l'enfant ou un signal ; 3 000 ms par défaut, réglable pour les tests. */
  farewellWaitMs?: number;
}): Promise<number> {
  const socketPath = controlSocketPath();
  const token = randomBytes(16).toString("hex");
  let control: { stop(): void } | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let ptyChild: PtyChild | undefined;
  let cleaned = false;
  const courier = o.courier;
  const label = o.harnessLabel ?? "Codex";
  // Le livreur en service (il possède la file) ; abandonné (`undefined`) quand il se déclare indisponible.
  let activeCourier = courier;
  const verifyCaller: VerifyCaller | undefined = o.verifyCaller ?? (courier === undefined ? undefined : (claim, peerPid) => courier.verifyCaller(claim, peerPid));

  const handlers: Record<CleanupSignal, () => void> = { SIGINT: () => {}, SIGHUP: () => {}, SIGTERM: () => {} };
  // Chaque étape du nettoyage dans son propre essai : une étape qui lève ne saute pas les suivantes,
  // ni la sortie sur signal. L'erreur part au journal (le harnais tient stdout et stderr).
  const attempt = (step: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      logEvent("cleanup-error", { step, message: errorMessage(error) });
    }
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const signal of SIGNALS) process.off(signal, handlers[signal]);
    // Le livreur d'abord : son arrêt abandonne une attente de verrou et libère ce que `beforeSpawn` a pris.
    attempt("courier-stop", () => courier?.stop());
    // Le PTY après le livreur : plus personne n'y écrit quand il est fermé.
    attempt("pty-release", () => ptyChild?.release());
    attempt("unregister", () => o.registration?.unregister());
    attempt("control-stop", () => control?.stop());
    attempt("control-socket", () => rmSync(socketPath, { force: true }));
  };

  // Adieux du livreur en service, attente bornée. Une erreur (levée ou rejetée) part au journal et ne
  // change jamais le code de sortie.
  const sayFarewell = async (): Promise<void> => {
    const farewell = activeCourier?.farewell;
    if (farewell === undefined) return;
    const work = (async () => farewell.call(activeCourier))().catch((error: unknown) => {
      logEvent("farewell-error", { message: errorMessage(error) });
    });
    await waitBounded(work, o.farewellWaitMs ?? DEFAULT_FAREWELL_WAIT_MS);
  };

  // Sortie sur signal : l'enfant est prévenu, mais on n'attend pas qu'il parte (il peut ignorer HUP).
  let resolveSignalExit!: (code: number) => void;
  const signalExit = new Promise<number>((resolveExit) => {
    resolveSignalExit = resolveExit;
  });
  // Code du signal reçu (129 ou 143) : lu après l'attente du canal pour ne pas lancer l'enfant.
  let signalExitCode: number | undefined;
  const exitOn = (signal: "SIGHUP" | "SIGTERM"): (() => void) => {
    return () => {
      const code = 128 + (constants.signals[signal] ?? 0);
      signalExitCode = code;
      attempt("kill-child", () => child?.kill(signal));
      cleanup();
      resolveSignalExit(code);
    };
  };
  // Ctrl-C : le terminal l'envoie aussi à l'enfant, la doublure survit pour le voir finir.
  handlers.SIGINT = () => {};
  handlers.SIGHUP = exitOn("SIGHUP");
  handlers.SIGTERM = exitOn("SIGTERM");
  // Les gestionnaires précèdent le canal de contrôle : aucun signal ne tombe dans la fenêtre de création.
  for (const signal of SIGNALS) process.on(signal, handlers[signal]);

  try {
    let startFailure: unknown;
    try {
      control = await startControlServer({
        socketPath,
        token,
        verifyCaller,
        handle: async (request: ControlCall): Promise<ControlResponse> => {
          if (request.op === "read") return { ok: true, message: activeCourier !== undefined ? activeCourier.read() : (o.queue.shift()?.content ?? null) };
          // Les pairs joignables hors la doublure elle-même (elle s'inscrit sous son propre pid) : l'agent,
          // enfant de la doublure, n'a parfois pas le droit de lancer `ps` (sandbox de dst).
          if (request.op === "list") return { ok: true, peers: reachablePeers((entry) => entry.pid === process.pid).map(summarizePeer) };
          if (request.op === "hook") {
            return { ok: true, reply: activeCourier !== undefined ? await activeCourier.hook(request.harness, request.event, request.payload) : {} };
          }
          if (o.registration === null) return { ok: false, error: "pas d'inscription au bus" };
          const { msgId } = await sendPeerMessage({
            fromSocketPath: o.registration.socketPath,
            fromName: o.name,
            fromMode: o.fromMode,
            to: request.to,
            body: request.body,
          });
          return { ok: true, msgId };
        },
      });
    } catch (error) {
      startFailure = error;
    }
    // Un signal pendant l'attente du canal : le nettoyage a déjà eu lieu (socket retiré, démarrage
    // éventuellement en échec). On arrête le canal s'il s'est ouvert et on rend le code du signal,
    // sans lancer l'agent.
    if (signalExitCode !== undefined) {
      attempt("control-stop", () => control?.stop());
      return signalExitCode;
    }
    if (startFailure !== undefined) throw startFailure;
    o.onControlReady?.({ socketPath, token });

    if (courier !== undefined) {
      const beforeSpawn = courier.beforeSpawn();
      // Un `beforeSpawn` abandonné par un signal rejette plus tard : ce rejet-là n'intéresse personne.
      beforeSpawn.catch(() => {});
      try {
        // `beforeSpawn` peut durer (daemon à démarrer, verrou d'adoption) : un signal sort aussitôt.
        await Promise.race([beforeSpawn, signalExit]);
      } catch (error) {
        if (signalExitCode === undefined) {
          if (!(error instanceof CourierUnavailableError)) throw error;
          // Le harnais n'a pas encore le terminal : la doublure parle encore sur stderr.
          process.stderr.write(`idnma : ${error.message}. ${label} démarre hors du bus (il ne recevra ni n'enverra de messages).\n`);
          activeCourier = undefined;
          // Les messages déjà en file ne seront jamais lus : leurs expéditeurs l'apprennent avant le retrait de l'inscription.
          if (o.registration !== null) {
            const registration = o.registration;
            await Promise.race([
              rejectQueuedMessages({ queue: o.queue, registration, name: o.name, fromMode: o.fromMode, label }),
              signalExit,
            ]);
          }
          attempt("unregister", () => o.registration?.unregister());
        }
      }
      if (signalExitCode !== undefined) return signalExitCode;
    }

    const childEnv = (): Record<string, string> => {
      if (o.exportControlEnv !== false) return { ...o.env, IDNMA_NAME: o.name, IDNMA_CONTROL_SOCKET: socketPath, IDNMA_CONTROL_TOKEN: token };
      // Rien du canal ne passe à l'enfant, pas même ce que l'environnement du parent en portait déjà.
      const env = { ...o.env };
      for (const key of CONTROL_ENV_KEYS) delete env[key];
      return env;
    };
    if (o.pty === true) {
      ptyChild = spawnUnderPty({
        argv: o.argv,
        env: childEnv(),
        ...(o.ptyStdin === undefined ? {} : { stdin: o.ptyStdin }),
        ...(o.ptyStdout === undefined ? {} : { stdout: o.ptyStdout }),
      });
      child = ptyChild.process;
    } else {
      child = Bun.spawn(o.argv, {
        env: childEnv(),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    }
    // Un `afterSpawn` qui lève ne doit pas orpheliner la TUI déjà lancée.
    const spawnedTerminal = ptyChild?.terminal;
    attempt("courier-after-spawn", () => activeCourier?.afterSpawn(spawnedTerminal));
    // Un enfant qui survit à une sortie sur signal ne doit pas retenir le process.
    child.unref();
    const exited = child.exited.then((code) => {
      // `@types/bun` 1.4.4 type `signalCode` en `number | Signals` : un numéro sert tel quel.
      const signal = child?.signalCode;
      const signalNumber = typeof signal === "number" ? signal : signal ? (constants.signals[signal] ?? 0) : 0;
      return code ?? 128 + signalNumber;
    });
    const code = await Promise.race([exited, signalExit]);
    await sayFarewell();
    return code;
  } finally {
    cleanup();
  }
}
