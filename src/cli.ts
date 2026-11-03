#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logEvent } from "./log.ts";
import { listAgentKeys } from "./config/network.ts";
import { reachablePeers, summarizePeer, type PeerSummary } from "./bus/peers.ts";
import { PeerError } from "./bus/send.ts";
import { isDescendantOf } from "./bus/peer-pid.ts";
import { codexUnderstudyPid, controlRequest } from "./understudy/control.ts";
import { parseRunArgs, UsageError } from "./run/args.ts";
import { installTeammateLine, uninstallTeammateLine } from "./install/teammate.ts";
import { installAgy, uninstallAgy } from "./install/agy.ts";
import { installDst, uninstallDst } from "./install/dst.ts";
import { installGrok, uninstallGrok } from "./install/grok.ts";
import { CLAUDE_SKILL, GENERIC_SKILL, installSkill, uninstallSkill } from "./install/skill.ts";
import { agyPluginsDir, claudeHome, codexHome, dshHome, grokHome, networkPath, opencodeConfigDir } from "./paths.ts";
import { PaneError } from "./run/pane.ts";
import { runAgent } from "./run/run.ts";

// CLI de l'agent : un agent étranger (Codex, Grok, agy, opencode, dst) l'appelle depuis son shell. L'identité de
// l'expéditeur vient de la doublure (variables d'environnement), jamais d'une option de ligne de commande.

const MAIN_HELP = `idnma : pont entre agents sur le bus de pairs de Claude Code

Usage :
  idnma peer send <nom> <texte...>   envoie un message à un pair
  idnma peer list                    liste les pairs vivants
  idnma read                         lit le prochain message reçu (dit « aucun message en attente » sinon)
  idnma run <agent> [options]        lance un agent dans ce pane tmux (voir idnma run --help)
  idnma hook <grok|agy> <événement>  (interne) point d'entrée des hooks de Grok et d'agy
  idnma install --agent <agent>      pose la skill, les hooks et la ligne coéquipier d'un agent (voir idnma install --help)
  idnma uninstall --agent <agent>    retire ce que install a posé pour cet agent
  idnma --help                       affiche cette aide

Codes de sortie : 0 succès, 1 erreur, 2 usage incorrect.
`;

const PEER_HELP = `Usage :
  idnma peer send <nom> <texte...>   envoie un message à un pair
  idnma peer list                    liste les pairs vivants
`;

const PEER_SEND_HELP = `Usage : idnma peer send <nom> <texte...>

Envoie <texte> (les mots sont joints par des espaces) au pair <nom>.
L'expéditeur est celui de la doublure qui lance cette commande.
`;

const PEER_LIST_HELP = `Usage : idnma peer list

Affiche une ligne par pair vivant joignable, hors vous-même : <nom>  <statut>  <tmux ou ->.
Un nom porté par plusieurs sessions est marqué homonyme : peer send le refuse.
`;

const NO_OTHER_PEER = "idnma : aucun autre pair vivant.\n";

const READ_HELP = `Usage : idnma read

Affiche le prochain message reçu, tel quel. Sans message en attente, affiche « idnma : aucun message en attente. » et sort avec 0.
`;

/** Aide de `idnma run` : les agents sont relus dans .idnma.yml ; s'il ne se lit pas, l'aide dit pourquoi. */
function runHelp(): string {
  let agentsLine: string;
  try {
    const agents = listAgentKeys();
    agentsLine = `Agents : ${agents.length > 0 ? agents.join(", ") : "aucun"} (${networkPath()})`;
  } catch (error) {
    agentsLine = `Agents : ${error instanceof Error ? error.message : String(error)}`;
  }
  return `Usage : idnma run <agent> [--engine <e>] [options du harnais...]

Lance <agent> dans le pane tmux courant, sous le nom <agent>-<divinité>-<4 caractères>
(un Claude repris garde le sien ; un --name tapé pour Claude doit être libre et fait de lettres,
chiffres, - et _, 64 caractères au plus).
${agentsLine}

  --engine <e>   engine de l'agent dans .idnma.yml (défaut : default)

Tout autre jeton, et tout ce qui suit --, va au harnais. Un flag tapé remplace le même flag de
l'engine (--model, --effort...) ; les autres options de l'engine restent.
Codex refuse les flags qui le font tourner hors de son daemon, donc hors du bus : -c/--config,
--enable, --disable, --search, -p/--profile, --strict-config, --dangerously-bypass-hook-trust,
--no-daemon, --remote et --oss.
opencode tourne sur le service d'opencode (jamais seul) : --standalone et --server sont refusés. Le modèle
vient de l'engine, ou du -m/--model tapé, que idnma lit et vérifie auprès du service avant de lancer la TUI.
dst refuse ses sous-commandes de lanceur, -p/--print, -v/--version, -h/--help, --profile, --from-default-profile et tout
--backend autre que dsh. Son modèle ne se donne pas au lancement (ni model: d'engine) : choisis-le avec /model dans dst,
la TUI le retient.
Un agent Claude prend la place de ce process ; Codex, Grok, agy, opencode et dst restent sous la doublure d'idnma.
`;
}

/** Ce qu'`install` et `uninstall` savent poser, par agent : un harnais de plus (ou une skill) = une entrée de plus. */
const INSTALLERS: Record<string, { install: () => string; uninstall: () => string }> = {
  agy: { install: installAgyLine, uninstall: uninstallAgyLine },
  claude: { install: installClaude, uninstall: uninstallClaude },
  codex: { install: installCodex, uninstall: uninstallCodex },
  dst: { install: installDstLine, uninstall: uninstallDstLine },
  grok: { install: installGrokLine, uninstall: uninstallGrokLine },
  opencode: { install: installOpencode, uninstall: uninstallOpencode },
};
const INSTALLABLE = Object.keys(INSTALLERS).sort().join(", ");

const INSTALL_HELP = `Usage : idnma install --agent <agent>

Pose ce qu'il faut à <agent> (${INSTALLABLE}) pour parler sur le bus ; un harnais absent est signalé,
jamais créé. Relancer la commande met à jour ce qui a changé.
  claude   écrit la skill <CLAUDE_CONFIG_DIR>/skills/claude-idnma-network/SKILL.md (défaut ~/.claude) ;
           Claude n'a besoin ni de hooks ni de ligne coéquipier.
  codex    ajoute à la fin de <CODEX_HOME>/AGENTS.md (défaut ~/.codex) le bloc qui apprend à traiter les
           messages de pairs, et écrit la skill <CODEX_HOME>/skills/generic-idnma-network/SKILL.md.
  grok     écrit <GROK_HOME>/hooks/idnma.json, <GROK_HOME>/rules/idnma-teammate.md et la skill
           <GROK_HOME>/skills/generic-idnma-network/SKILL.md (défaut ~/.grok).
  agy      installe par « agy plugin install » le plugin idnma (hooks, ligne coéquipier et skill) dans
           ~/.gemini/config/plugins/idnma ; il faut agy dans le PATH et ~/.gemini/config présent.
  opencode ajoute à la fin de <dossier de config d'opencode>/AGENTS.md le bloc qui apprend à traiter les
           messages de pairs, et écrit la skill <dossier de config>/skills/generic-idnma-network/SKILL.md ;
           le dossier est IDNMA_OPENCODE_CONFIG_DIR, sinon $XDG_CONFIG_HOME/opencode, sinon ~/.config/opencode.
  dst      ajoute à la fin de <DSH_HOME>/cordis.patch.yml un bloc qui active le plugin idnma de ce checkout
           (seulement sous idnma run : le plugin reste inerte pour un dst lancé seul) ; remplace le « [] » du
           gabarit de dsh s'il y est, commentaires gardés. Ajoute aussi le bloc coéquipier à <DSH_HOME>/AGENTS.md
           et écrit la skill <DSH_HOME>/skills/generic-idnma-network/SKILL.md ; le dossier est
           IDNMA_DSH_HOME, sinon $DSH_HOME, sinon ~/.dsh.
Aucun fichier de l'utilisateur n'est modifié hors des AGENTS.md de Codex, d'opencode et de dst, et du cordis.patch.yml
de dst. Aucune règle de permission n'est posée.

Les hooks installés pointent vers le checkout qui lance la commande : lance-la depuis le checkout lié par
bun link (~/dev/erom-agence-network), jamais depuis un worktree jetable (ses hooks échoueraient une fois
le worktree retiré).
`;

const UNINSTALL_HELP = `Usage : idnma uninstall --agent <agent>

Retire ce que idnma install a posé pour <agent> (${INSTALLABLE}) :
  claude   la skill claude-idnma-network de <CLAUDE_CONFIG_DIR>/skills, et rien d'autre.
  codex    le bloc de <CODEX_HOME>/AGENTS.md : le fichier redevient octet pour octet celui d'avant
           l'installation (un fichier créé par idnma et resté vide est supprimé) ; et la skill
           generic-idnma-network de <CODEX_HOME>/skills.
  grok     <GROK_HOME>/hooks/idnma.json, <GROK_HOME>/rules/idnma-teammate.md et la skill
           generic-idnma-network de <GROK_HOME>/skills, et rien d'autre.
  agy      le plugin idnma, par « agy plugin uninstall idnma » ; ~/.gemini/config/hooks.json et
           ~/.gemini/GEMINI.md ne sont pas touchés.
  opencode le bloc de <dossier de config d'opencode>/AGENTS.md (le fichier redevient octet pour octet celui
           d'avant l'installation ; un fichier créé par idnma et resté vide est supprimé), et la skill
           generic-idnma-network de <dossier de config>/skills.
  dst      le bloc de <DSH_HOME>/cordis.patch.yml et celui de <DSH_HOME>/AGENTS.md (chaque fichier redevient
           octet pour octet celui d'avant l'installation ; un fichier créé par idnma et resté vide est
           supprimé), et la skill generic-idnma-network de <DSH_HOME>/skills.
Aucun fichier de l'utilisateur n'est modifié hors des AGENTS.md de Codex, d'opencode et de dst, et du cordis.patch.yml
de dst.
`;

const NO_PENDING_MESSAGE = "idnma : aucun message en attente.\n";
const NO_PENDING_PUSHED_TURNS =
  "idnma : chez Codex, opencode et dst, les messages de pairs arrivent d'eux-mêmes, chacun comme un nouveau tour : idnma read n'a rien à rendre.\n";
/** Délai d'un hook : le harnais attend la réponse, une doublure muette ne doit pas figer son tour. */
const HOOK_TIMEOUT_MS = 3_000;

const isHelpFlag = (arg: string | undefined): boolean => arg === "--help" || arg === "-h";

/** Erreur d'usage : message sur stderr, code 2. */
function usage(message: string, help: string): number {
  process.stderr.write(`${message}\n\n${help}`);
  return 2;
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

async function peerSend(args: string[]): Promise<number> {
  if (isHelpFlag(args[0])) {
    process.stdout.write(PEER_SEND_HELP);
    return 0;
  }
  const [to, ...words] = args;
  if (to === undefined || words.length === 0) return usage("idnma peer send : un nom et un texte sont requis", PEER_SEND_HELP);
  const body = words.join(" ");
  if (body.trim() === "") return usage("idnma peer send : le texte est vide", PEER_SEND_HELP);
  const response = await controlRequest({ op: "send", to, body });
  if (!response.ok) return fail(`idnma : ${response.error}`);
  if (!("msgId" in response)) return fail("idnma : réponse inattendue de la doublure");
  process.stdout.write(`envoyé à ${to} (${response.msgId})\n`);
  return 0;
}

/** Pid de la doublure dont `socketPath` est le socket de contrôle (`<pid>.sock`) ; `undefined` sinon. */
function understudyPidOfControlSocket(socketPath: string | undefined): number | undefined {
  const match = socketPath === undefined ? null : /^(\d+)\.sock$/.exec(basename(socketPath));
  return match === null ? undefined : Number(match[1]);
}

/** Délai de l'op `list` : au-delà, la lecture locale prend le relais (une doublure muette ne fige pas la commande). */
const LIST_TIMEOUT_MS = 5_000;

/** Pairs rendus par la doublure ; `undefined` au moindre doute (échec, réponse sans `peers`, élément mal formé). */
async function understudyPeers(): Promise<PeerSummary[] | undefined> {
  try {
    const response = await controlRequest({ op: "list" }, process.env, { timeoutMs: LIST_TIMEOUT_MS });
    if (!response.ok || !("peers" in response) || !Array.isArray(response.peers)) return undefined;
    const wellFormed = response.peers.every(
      (peer) => typeof peer === "object" && peer !== null && typeof peer.name === "string" && typeof peer.status === "string" && (peer.tmux === undefined || typeof peer.tmux === "string"),
    );
    return wellFormed ? response.peers : undefined;
  } catch {
    return undefined;
  }
}

/** Lecture locale du registre, pour une commande qui n'a pas de doublure à interroger ou qui n'en tire rien. */
function localPeers(): PeerSummary[] {
  // L'agent appelant, repéré par filiation et non par `IDNMA_NAME`, qu'une reprise dans la TUI rend
  // périmé : son shell descend de son entrée (Claude, ou la doublure de Grok et d'agy) ; une commande
  // de Codex descend du daemon, sa doublure se retrouve par le pointeur de son thread.
  const threadId = process.env.CODEX_THREAD_ID;
  const codexSelf = threadId === undefined ? undefined : codexUnderstudyPid(threadId);
  // Une commande d'opencode descend du service d'opencode, pas de la doublure : la filiation ne l'exclut pas.
  // La TUI lui transmet le socket de contrôle de sa doublure, nommé `<pid>.sock`.
  const opencodeSelf = understudyPidOfControlSocket(process.env.IDNMA_CONTROL_SOCKET);
  return reachablePeers((entry) => entry.pid === codexSelf || entry.pid === opencodeSelf || isDescendantOf(process.pid, entry.pid)).map(summarizePeer);
}

async function peerList(args: string[]): Promise<number> {
  if (isHelpFlag(args[0])) {
    process.stdout.write(PEER_LIST_HELP);
    return 0;
  }
  if (args.length > 0) return usage("idnma peer list : aucun argument attendu", PEER_LIST_HELP);
  // La doublure d'abord : sous la sandbox de dst, `ps` est refusé et seule sa réponse est fiable. Sans canal
  // (Claude, commande lancée à la main) ou sur un échec quelconque, le registre se lit sur place, sans bruit.
  const peers = (await understudyPeers()) ?? localPeers();
  if (peers.length === 0) {
    process.stdout.write(NO_OTHER_PEER);
    return 0;
  }
  const counts = new Map<string, number>();
  for (const entry of peers) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const nameWidth = Math.max(...peers.map((entry) => entry.name.length));
  const statusWidth = Math.max(...peers.map((entry) => entry.status.length));
  for (const entry of peers) {
    const homonym = counts.get(entry.name)! > 1 ? "  (homonyme : injoignable par nom)" : "";
    process.stdout.write(`${entry.name.padEnd(nameWidth)}  ${entry.status.padEnd(statusWidth)}  ${entry.tmux ?? "-"}${homonym}\n`);
  }
  return 0;
}

async function read(args: string[]): Promise<number> {
  if (isHelpFlag(args[0])) {
    process.stdout.write(READ_HELP);
    return 0;
  }
  if (args.length > 0) return usage("idnma read : aucun argument attendu", READ_HELP);
  const response = await controlRequest({ op: "read" });
  if (!response.ok) return fail(`idnma : ${response.error}`);
  if (!("message" in response)) return fail("idnma : réponse inattendue de la doublure");
  // Une commande de Codex, d'opencode ou de dst (qui porte le jeton sous `DSH_IDNMA_CONTROL_TOKEN`) : ses messages
  // arrivent d'eux-mêmes comme des tours, `read` n'en rend jamais.
  const pushedTurns =
    process.env.CODEX_THREAD_ID !== undefined || process.env.OPENCODE_SESSION_ID !== undefined || process.env.DSH_IDNMA_CONTROL_TOKEN !== undefined;
  const text = response.message ?? (pushedTurns ? NO_PENDING_PUSHED_TURNS : NO_PENDING_MESSAGE);
  // Un saut de ligne final : l'enveloppe n'en porte pas, et l'invite du terminal s'y collerait.
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

/** Lit tout stdin, au plus jusqu'à `deadline` (ms epoch) : un harnais qui laisse le tube ouvert et muet ne fige pas le hook. */
async function readStdinUntil(deadline: number): Promise<string> {
  if (process.stdin.isTTY) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, rejectExpiry) => {
    timer = setTimeout(() => rejectExpiry(new Error("hook stdin not closed in time")), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([Bun.stdin.text(), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Point d'entrée des hooks de Grok et d'agy : l'événement arrive en JSON sur stdin, la réponse du
 * livreur repart sur une ligne. Toujours un objet JSON et le code 0 : un hook qui échoue abîme la TUI
 * du harnais. Hors doublure (variables de contrôle absentes), `{}` tout de suite : stdin n'est même
 * pas lu et rien ne part au journal. Dans une doublure, lecture de stdin et appel au canal tiennent
 * ensemble dans `HOOK_TIMEOUT_MS`.
 */
async function hook(args: string[]): Promise<number> {
  const [harness, event] = args;
  const reply = async (): Promise<Record<string, unknown>> => {
    const socket = process.env.IDNMA_CONTROL_SOCKET;
    const token = process.env.IDNMA_CONTROL_TOKEN;
    if (socket === undefined || socket === "" || token === undefined || token === "") return {};
    const deadline = Date.now() + HOOK_TIMEOUT_MS;
    try {
      if (harness !== "grok" && harness !== "agy") throw new Error(`unknown harness ${String(harness)}`);
      if (event === undefined || event === "") throw new Error("missing event name");
      const payload: unknown = JSON.parse(await readStdinUntil(deadline));
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("hook payload is not an object");
      const timeoutMs = Math.max(1, deadline - Date.now());
      const response = await controlRequest({ op: "hook", harness, event, payload: payload as Record<string, unknown> }, process.env, { timeoutMs });
      if (!response.ok) throw new Error(response.error);
      if (!("reply" in response)) throw new Error("unexpected control response");
      return response.reply;
    } catch (error) {
      // `hookEvent` et non `event` : `logEvent` y range déjà le nom de l'événement de journal, qu'un champ du même nom écraserait.
      logEvent("hook-error", { harness, hookEvent: event, message: error instanceof Error ? error.message : "unknown error" });
      return {};
    }
  };
  const line = JSON.stringify(await reply()) + "\n";
  // On attend la fin de l'écriture : l'entrée de programme sort ensuite sans attendre un stdin resté ouvert.
  await new Promise<void>((resolveWritten) => process.stdout.write(line, () => resolveWritten()));
  return 0;
}

async function run(args: string[]): Promise<number> {
  // `--here` est ignoré partout, y compris devant `--help`.
  if (isHelpFlag(args.find((arg) => arg !== "--here"))) {
    process.stdout.write(runHelp());
    return 0;
  }
  try {
    return await runAgent(parseRunArgs(args));
  } catch (error) {
    if (error instanceof UsageError) return usage(`idnma run : ${error.message}`, runHelp());
    // Les refus de pane nomment déjà « idnma run » : pas de second préfixe.
    if (error instanceof PaneError) return fail(error.message);
    throw error;
  }
}

/** Une ligne de sortie par agent installable, rangée dans `INSTALLERS`. */
function installCodex(): string {
  const home = codexHome();
  if (!existsSync(home)) return `Codex : absent (${home}), rien installé`;
  const path = join(home, "AGENTS.md");
  const label = { installed: "installée dans", updated: "mise à jour dans", unchanged: "déjà à jour dans" }[installTeammateLine(path)];
  const skills = join(home, "skills");
  return `Codex : ligne coéquipier ${label} ${path} ; skill ${GENERIC_SKILL} ${SKILL_INSTALL_LABEL[installSkill(skills, GENERIC_SKILL)]} ${skills}`;
}

function uninstallCodex(): string {
  const home = codexHome();
  if (!existsSync(home)) return `Codex : absent (${home}), rien retiré`;
  const path = join(home, "AGENTS.md");
  const line = uninstallTeammateLine(path) === "removed" ? `ligne coéquipier retirée de ${path}` : `ligne coéquipier absente de ${path}, rien touché`;
  const skills = join(home, "skills");
  return `Codex : ${line} ; skill ${GENERIC_SKILL} ${SKILL_UNINSTALL_LABEL[uninstallSkill(skills, GENERIC_SKILL)]} ${skills}`;
}

function installOpencode(): string {
  const home = opencodeConfigDir();
  if (!existsSync(home)) return `opencode : absent (${home}), rien installé`;
  const path = join(home, "AGENTS.md");
  const label = SKILL_INSTALL_LABEL[installTeammateLine(path)];
  const skills = join(home, "skills");
  return `opencode : ligne coéquipier ${label} ${path} ; skill ${GENERIC_SKILL} ${SKILL_INSTALL_LABEL[installSkill(skills, GENERIC_SKILL)]} ${skills}`;
}

function uninstallOpencode(): string {
  const home = opencodeConfigDir();
  if (!existsSync(home)) return `opencode : absent (${home}), rien retiré`;
  const path = join(home, "AGENTS.md");
  const line = uninstallTeammateLine(path) === "removed" ? `ligne coéquipier retirée de ${path}` : `ligne coéquipier absente de ${path}, rien touché`;
  const skills = join(home, "skills");
  return `opencode : ${line} ; skill ${GENERIC_SKILL} ${SKILL_UNINSTALL_LABEL[uninstallSkill(skills, GENERIC_SKILL)]} ${skills}`;
}

function installDstLine(): string {
  const home = dshHome();
  const outcome = installDst();
  if (outcome === "absent") return `dst : absent (${home}), rien installé`;
  const label = { installed: "installés dans", updated: "mis à jour dans", unchanged: "déjà à jour dans" }[outcome];
  return `dst : plugin, ligne coéquipier et skill ${label} ${home}`;
}

function uninstallDstLine(): string {
  const home = dshHome();
  return uninstallDst() === "removed" ? `dst : plugin, ligne coéquipier et skill retirés de ${home}` : `dst : rien à retirer de ${home}`;
}

const SKILL_INSTALL_LABEL = { installed: "installée dans", updated: "mise à jour dans", unchanged: "déjà à jour dans" } as const;
const SKILL_UNINSTALL_LABEL = { removed: "retirée de", absent: "absente de" } as const;

function installClaude(): string {
  const home = claudeHome();
  if (!existsSync(home)) return `Claude : absent (${home}), rien installé`;
  const skills = join(home, "skills");
  return `Claude : skill ${CLAUDE_SKILL} ${SKILL_INSTALL_LABEL[installSkill(skills, CLAUDE_SKILL)]} ${skills}`;
}

function uninstallClaude(): string {
  const skills = join(claudeHome(), "skills");
  return `Claude : skill ${CLAUDE_SKILL} ${SKILL_UNINSTALL_LABEL[uninstallSkill(skills, CLAUDE_SKILL)]} ${skills}`;
}

function installGrokLine(): string {
  const home = grokHome();
  const outcome = installGrok();
  if (outcome === "absent") return `Grok : absent (${home}), rien installé`;
  const label = { installed: "installés dans", updated: "mis à jour dans", unchanged: "déjà à jour dans" }[outcome];
  return `Grok : hooks, ligne coéquipier et skill ${label} ${home}`;
}

function uninstallGrokLine(): string {
  const home = grokHome();
  return uninstallGrok() === "removed" ? `Grok : hooks, ligne coéquipier et skill retirés de ${home}` : `Grok : rien à retirer de ${home}`;
}

function installAgyLine(): string {
  const outcome = installAgy();
  if (outcome === "absent") return `agy : absent (${dirname(agyPluginsDir())}), rien installé`;
  const label = { installed: "installé", updated: "mis à jour", unchanged: "déjà à jour" }[outcome];
  return `agy : plugin idnma ${label} (${join(agyPluginsDir(), "idnma")})`;
}

function uninstallAgyLine(): string {
  return uninstallAgy() === "removed" ? "agy : plugin idnma retiré" : "agy : plugin idnma absent, rien touché";
}

/** `--agent <a>` ou `--agent=<a>`, seul argument d'`install` et d'`uninstall` ; `undefined` si la ligne ne le donne pas ainsi. */
function agentArg(args: string[]): string | undefined {
  const [first, second, ...rest] = args;
  if (first === "--agent" && rest.length === 0) return second;
  if (first !== undefined && first.startsWith("--agent=") && second === undefined) return first.slice("--agent=".length);
  return undefined;
}

/** `install` et `uninstall` : un agent par appel, et seul cet agent est touché. */
function installCommand(command: "install" | "uninstall", args: string[]): number {
  const help = command === "install" ? INSTALL_HELP : UNINSTALL_HELP;
  if (isHelpFlag(args[0])) {
    process.stdout.write(help);
    return 0;
  }
  const agent = agentArg(args);
  if (agent === undefined || agent === "") return usage(`idnma ${command} : --agent <agent> est requis, seul (agents : ${INSTALLABLE})`, help);
  const installer = Object.hasOwn(INSTALLERS, agent) ? INSTALLERS[agent] : undefined;
  if (installer === undefined) return usage(`idnma ${command} : agent inconnu « ${agent} » (agents : ${INSTALLABLE})`, help);
  process.stdout.write(`${installer[command]()}\n`);
  return 0;
}

async function peer(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "send":
      return peerSend(rest);
    case "list":
      return peerList(rest);
    case "--help":
    case "-h":
      process.stdout.write(PEER_HELP);
      return 0;
    case undefined:
      return usage("idnma peer : une sous-commande est requise", PEER_HELP);
    default:
      return usage(`idnma peer : sous-commande inconnue « ${subcommand} »`, PEER_HELP);
  }
}

/** Point d'entrée testable : rend le code de sortie. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "peer":
        return await peer(rest);
      case "read":
        return await read(rest);
      case "hook":
        return await hook(rest);
      case "run":
        return await run(rest);
      case "install":
        return installCommand("install", rest);
      case "uninstall":
        return installCommand("uninstall", rest);
      case "--help":
      case "-h":
        process.stdout.write(MAIN_HELP);
        return 0;
      default:
        return usage(command === undefined ? "idnma : une commande est requise" : `idnma : commande inconnue « ${command} »`, MAIN_HELP);
    }
  } catch (error) {
    if (error instanceof PeerError) return fail(error.message);
    return fail(`idnma : ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const code = await main(argv);
  // `run` : la doublure rend 129 ou 143 sans attendre l'enfant, qui pourrait retenir le process.
  // `hook` : un stdin laissé ouvert et muet par le harnais ne doit pas retenir le process.
  if (argv[0] === "run" || argv[0] === "hook") process.exit(code);
  // Ailleurs, `exitCode` plutôt que `process.exit` : la sortie standard finit de se vider avant l'arrêt.
  process.exitCode = code;
}
