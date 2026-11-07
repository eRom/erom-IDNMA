import { timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { peerPidOf } from "../bus/peer-pid.ts";
import type { PeerSummary } from "../bus/peers.ts";
import { PeerError } from "../bus/send.ts";
import { errorMessage, logEvent } from "../log.ts";
import { controlDir } from "../paths.ts";

// Canal de contrôle local : l'agent étranger appelle `idnma peer send` / `idnma read`, qui parlent
// à la doublure sur un socket Unix privé. Une ligne JSON de requête, une ligne JSON de réponse,
// puis fermeture. Toute écriture passe par `node:net` (`Bun.connect` tronque à 8 192 octets).

export type ControlCall =
  | { op: "send"; to: string; body: string }
  | { op: "read" }
  | { op: "list" }
  | { op: "hook"; harness: "grok" | "agy"; event: string; payload: Record<string, unknown> };
// `Omit` n'est pas distributif sur une union : tsc perdrait `to` et `body`, d'où l'intersection.
// Un appelant se présente par le jeton (agent lancé par la doublure) ou par l'id de thread Codex
// (commande lancée par le daemon Codex, qui ne voit pas l'environnement de la doublure).
export type ControlRequest = ControlCall & ({ token: string } | { codexThreadId: string });
/** Dit si le process au bout de la connexion (pid noyau, `undefined` si inconnu) descend bien du thread revendiqué. */
export type VerifyCaller = (claim: { codexThreadId: string }, peerPid: number | undefined) => Promise<boolean>;
export type ControlResponse =
  | { ok: true; msgId: string }
  | { ok: true; message: string | null }
  | { ok: true; reply: Record<string, unknown> }
  | { ok: true; peers: PeerSummary[] }
  | { ok: false; error: string };

/** Plafond d'une requête : un corps de message très long reste possible, pas un flux sans fin. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 10_000;
const CLIENT_TIMEOUT_MS = 15_000;

/** Forme mesurée d'un id de thread Codex : seule une valeur conforme entre dans un chemin. */
export const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CALLER_REFUSED = "appelant refusé : cette commande ne descend pas du thread Codex de cette doublure";
const HOOK_NEEDS_TOKEN = "op hook réservée à la voie du jeton de contrôle";

function tokenMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function asControlRequest(value: unknown): ControlRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  let call: ControlCall;
  if (frame.op === "read") call = { op: "read" };
  else if (frame.op === "list") call = { op: "list" };
  else if (frame.op === "send" && typeof frame.to === "string" && typeof frame.body === "string") call = { op: "send", to: frame.to, body: frame.body };
  else if (
    frame.op === "hook" &&
    (frame.harness === "grok" || frame.harness === "agy") &&
    typeof frame.event === "string" &&
    typeof frame.payload === "object" &&
    frame.payload !== null &&
    !Array.isArray(frame.payload)
  ) {
    call = { op: "hook", harness: frame.harness, event: frame.event, payload: frame.payload as Record<string, unknown> };
  } else return undefined;
  // Le jeton prime : une trame qui porte les deux passe par la vérification du jeton, jamais par l'autre voie.
  if (typeof frame.token === "string") return { ...call, token: frame.token };
  if (typeof frame.codexThreadId === "string") return { ...call, codexThreadId: frame.codexThreadId };
  return undefined;
}

/**
 * Le dossier du socket doit être à nous et fermé au groupe comme aux autres : un dossier préexistant
 * (`/tmp/idnma-<uid>` créé par un autre compte, ou laissé en 755) exposerait le canal. Refus sans
 * réparation silencieuse ; un lien symbolique est refusé aussi.
 */
function assertPrivateDirectory(dir: string): void {
  const stats = lstatSync(dir);
  const uid = process.getuid?.();
  if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw new Error(
      `Dossier de contrôle non sûr : ${dir} (il doit être un vrai dossier, à vous, en mode 700). Corrigez ses droits ou supprimez-le.`,
    );
  }
}

/**
 * Crée le dossier de contrôle en 700 au besoin et vérifie qu'il est privé ; rend son chemin. Le
 * paramètre ne sert qu'au serveur, dont le socket peut vivre ailleurs que dans `controlDir()`.
 */
export function ensureControlDir(dir: string = controlDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(dir);
  return dir;
}

/** Socket de contrôle d'une doublure : un fichier par pid dans le dossier de contrôle. */
export function controlSocketPath(pid: number = process.pid): string {
  return join(controlDir(), `${pid}.sock`);
}

/** Fichier pointeur d'un thread Codex vers la doublure qui le porte ; lève sur un id non conforme. */
export function codexPointerPath(threadId: string): string {
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) throw new Error("identifiant de thread Codex invalide");
  return join(controlDir(), `codex-${threadId}.json`);
}

/** Écrit le pointeur (600) par fichier temporaire puis renommage : un lecteur ne voit jamais un fichier à moitié écrit. */
export function writeCodexPointer(threadId: string, socketPath: string): void {
  const path = codexPointerPath(threadId);
  ensureControlDir();
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ socketPath }), { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Retire le pointeur d'un thread, sans erreur s'il est déjà absent. */
export function removeCodexPointer(threadId: string): void {
  rmSync(codexPointerPath(threadId), { force: true });
}

/** Ouvre le canal ; rejette si le dossier n'est pas privé ou si l'écoute échoue. */
export async function startControlServer(o: {
  socketPath: string;
  token: string;
  handle: (call: ControlCall) => Promise<ControlResponse>;
  verifyCaller?: VerifyCaller;
}): Promise<{ stop(): void }> {
  ensureControlDir(dirname(o.socketPath));

  const answer = async (line: Buffer, peerPid: number | undefined): Promise<ControlResponse> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      return { ok: false, error: "requête de contrôle invalide" };
    }
    const request = asControlRequest(parsed);
    if (request === undefined) return { ok: false, error: "requête de contrôle invalide" };
    let call: ControlCall;
    if ("token" in request) {
      if (!tokenMatches(request.token, o.token)) return { ok: false, error: "jeton de contrôle invalide" };
      const { token: _token, ...rest } = request;
      call = rest;
    } else {
      // Les hooks des harnais descendent de la doublure et portent son jeton : jamais la voie Codex.
      if (request.op === "hook") return { ok: false, error: HOOK_NEEDS_TOKEN };
      // Un échec de vérification refuse : jamais d'admission par défaut.
      let admitted = false;
      if (o.verifyCaller !== undefined && CODEX_THREAD_ID_PATTERN.test(request.codexThreadId)) {
        try {
          admitted = await o.verifyCaller({ codexThreadId: request.codexThreadId }, peerPid);
        } catch (error) {
          logEvent("control-verify-error", { message: errorMessage(error) });
        }
      }
      if (!admitted) return { ok: false, error: CALLER_REFUSED };
      const { codexThreadId: _claim, ...rest } = request;
      call = rest;
    }
    try {
      return await o.handle(call);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "erreur inconnue" };
    }
  };

  // `allowHalfOpen` : le client ferme son côté écriture après sa ligne, la réponse part ensuite.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    // Le pid noyau se lit dès l'acceptation, avant que la connexion ait pu se fermer.
    const peerPid = peerPidOf(socket);
    let pending = Buffer.alloc(0);
    let handled = false;
    const timer = setTimeout(() => socket.destroy(), REQUEST_DEADLINE_MS);
    socket.on("error", () => {});
    socket.on("close", () => clearTimeout(timer));
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline === -1) {
        if (pending.length > MAX_REQUEST_BYTES) socket.destroy();
        return;
      }
      handled = true;
      clearTimeout(timer);
      void answer(pending.subarray(0, newline), peerPid).then((response) => {
        // Le corps entier part d'un seul `end` : un client lent ne perd rien.
        if (!socket.destroyed) socket.end(JSON.stringify(response) + "\n");
      });
    });
  });

  // Un échec d'écoute arrive en événement `error`, pas en exception : avant l'écoute il rejette le
  // démarrage ; après, il part au journal (le harnais tient alors stdout et stderr).
  let listening = false;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (!listening) {
        rejectReady(new Error(`Impossible d'ouvrir le canal de contrôle sur ${o.socketPath} (${error.code ?? error.message}).`));
        return;
      }
      logEvent("control-server-error", { message: errorMessage(error) });
    });
    server.once("listening", () => {
      listening = true;
      resolveReady();
    });
  });

  // Un reste au même chemin (crash d'un process au pid réutilisé) empêcherait l'écoute.
  rmSync(o.socketPath, { force: true });
  // Masque 077 le temps de la création du socket (liaison synchrone sous Bun), puis chmod 600.
  const previousMask = process.umask(0o077);
  try {
    server.listen(o.socketPath);
  } finally {
    process.umask(previousMask);
  }
  await ready;
  try {
    chmodSync(o.socketPath, 0o600);
  } catch (error) {
    // Le serveur écoute déjà : sans fermeture il resterait ouvert (et retiendrait le process) alors que l'appelant reçoit l'échec.
    server.close();
    throw error;
  }

  return {
    stop() {
      server.close();
      rmSync(o.socketPath, { force: true });
    },
  };
}

/** Dit pourquoi aucune doublure n'est joignable depuis cette commande. */
const NO_UNDERSTUDY_HERE = "idnma : aucune doublure ici. Cette commande se lance depuis un agent démarré par idnma run.";
const NO_CONTROL_TOKEN = "idnma : canal de contrôle sans jeton (IDNMA_CONTROL_TOKEN ou DSH_IDNMA_CONTROL_TOKEN absent)";
const NO_UNDERSTUDY_FOR_THREAD = "idnma : aucune doublure pour ce thread Codex. Lance Codex par idnma run.";
// Sans le nom : `IDNMA_NAME` peut être périmé, une reprise dans la TUI rend son ancien nom à la session.
const CLAUDE_HAS_NO_UNDERSTUDY =
  "idnma : cet agent est un Claude, sans doublure : il écrit à ses pairs avec son outil SendMessage et reçoit leurs messages directement. idnma peer send et idnma read servent aux agents Codex, Grok, agy, opencode, dst et pi.";

/** Socket de la doublure qui porte ce thread Codex, lu dans le pointeur ; `undefined` si absent, illisible ou dans un dossier non sûr. */
function codexSocketOf(threadId: string): string | undefined {
  try {
    assertPrivateDirectory(controlDir());
    const pointer = JSON.parse(readFileSync(codexPointerPath(threadId), "utf8")) as { socketPath?: unknown };
    return typeof pointer.socketPath === "string" && pointer.socketPath !== "" ? pointer.socketPath : undefined;
  } catch {
    return undefined;
  }
}

/** Pid de la doublure qui porte ce thread Codex : son socket de contrôle est nommé d'après lui (`controlSocketPath`). */
export function codexUnderstudyPid(threadId: string): number | undefined {
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) return undefined;
  const socketPath = codexSocketOf(threadId);
  const match = socketPath === undefined ? null : /^(\d+)\.sock$/.exec(basename(socketPath));
  return match === null ? undefined : Number(match[1]);
}

/**
 * Appelle la doublure du process courant. Un agent lancé par `idnma run` porte `IDNMA_CONTROL_SOCKET`
 * et `IDNMA_CONTROL_TOKEN` ; dsh retire de l'environnement des commandes de dst tout nom qui contient
 * TOKEN, le plugin de dst re-expose donc le jeton sous `DSH_IDNMA_CONTROL_TOKEN`. Une commande lancée
 * par le daemon Codex ne voit rien de tout cela et se présente par `CODEX_THREAD_ID`, que la doublure
 * vérifie par le pid noyau de la connexion.
 */
export function controlRequest(
  r: ControlCall,
  env: Record<string, string | undefined> = process.env,
  o: { timeoutMs?: number } = {},
): Promise<ControlResponse> {
  const timeoutMs = o.timeoutMs ?? CLIENT_TIMEOUT_MS;
  const socketPath = env.IDNMA_CONTROL_SOCKET;
  const hasSocket = socketPath !== undefined && socketPath !== "";
  const token = [env.IDNMA_CONTROL_TOKEN, env.DSH_IDNMA_CONTROL_TOKEN].find((candidate) => candidate !== undefined && candidate !== "");
  if (hasSocket && token !== undefined) return sendFrame(socketPath, { ...r, token }, timeoutMs);
  const threadId = env.CODEX_THREAD_ID;
  if (threadId === undefined || !CODEX_THREAD_ID_PATTERN.test(threadId)) {
    // Un socket sans jeton : l'environnement a perdu le jeton en route, ce n'est ni un Claude ni une absence de doublure.
    if (hasSocket) return Promise.reject(new PeerError(NO_CONTROL_TOKEN));
    // Un Claude lancé par `idnma run` porte `IDNMA_NAME` sans canal : il n'a pas de doublure, il a son outil natif.
    if (env.IDNMA_NAME !== undefined && env.IDNMA_NAME !== "") return Promise.reject(new PeerError(CLAUDE_HAS_NO_UNDERSTUDY));
    return Promise.reject(new PeerError(NO_UNDERSTUDY_HERE));
  }
  const pointed = codexSocketOf(threadId);
  if (pointed === undefined) return Promise.reject(new PeerError(NO_UNDERSTUDY_FOR_THREAD));
  return sendFrame(pointed, { ...r, codexThreadId: threadId }, timeoutMs);
}

function sendFrame(socketPath: string, frame: ControlRequest, timeoutMs: number): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      rejectResponse(new PeerError(`idnma : la doublure ne répond pas (délai de ${timeoutMs} ms dépassé)`));
    }, timeoutMs);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      rejectResponse(new PeerError(`idnma : doublure injoignable (${error.message})`));
    });
    socket.once("close", () => {
      clearTimeout(timer);
      try {
        resolveResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ControlResponse);
      } catch {
        rejectResponse(new PeerError("idnma : réponse illisible de la doublure"));
      }
    });
    socket.end(JSON.stringify(frame) + "\n");
  });
}
