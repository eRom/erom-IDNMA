import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Chaque chemin est relu à l'appel : les variables IDNMA_* sont le seul mécanisme
// de redirection (tests, sandbox), les défauts sont les chemins de prod.

/** Dossier d'état d'idnma (verrou des noms, journaux). */
export function configDir(): string {
  return process.env.IDNMA_CONFIG_DIR ?? join(homedir(), ".config", "idema");
}

/** Catalogue d'agents : `~/.idnma.yml`, ou `.idnma.yml` dans `IDNMA_CONFIG_DIR` (la sandbox redirige tout d'un seul geste). */
export function networkPath(): string {
  return join(process.env.IDNMA_CONFIG_DIR ?? homedir(), ".idnma.yml");
}

/** Registre de sessions de Claude Code, où chaque pair du bus s'inscrit. */
export function sessionsDir(): string {
  return process.env.IDNMA_CLAUDE_DIR ?? join(homedir(), ".claude", "sessions");
}

/**
 * Sockets du bus de pairs, là où Claude Code met les siens : `$XDG_RUNTIME_DIR/cc-socks`, sinon
 * `$CLAUDE_CODE_TMPDIR/cc-socks`, sinon `/tmp/cc-socks` sous macOS et `<os.tmpdir()>/cc-socks` sous Linux
 * (lu dans les binaires macOS et Linux de Claude Code 2.1.317, sondé sous Linux, 03/11/2026).
 * Une variable vide compte comme absente, comme chez Claude.
 */
export function socketsDir(): string {
  if (process.env.IDNMA_SOCKETS_DIR !== undefined) return process.env.IDNMA_SOCKETS_DIR;
  const fallback = process.platform === "darwin" ? "/tmp" : tmpdir();
  return join(process.env.XDG_RUNTIME_DIR || process.env.CLAUDE_CODE_TMPDIR || fallback, "cc-socks");
}

// Longueur maximale d'un chemin de socket retenue par Claude Code (`sun_path` : 104 octets sous macOS, 108 sous Linux).
const MAX_SOCKET_PATH_BYTES = 103;

/** Socket du bus pour `pid` ; trop long, il se replie comme chez Claude sur `/tmp/cc-socks-<uid>`. */
export function peerSocketPath(pid: number = process.pid): string {
  const path = join(socketsDir(), `${pid}.sock`);
  if (Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES) return path;
  return join("/tmp", `cc-socks-${process.getuid?.() ?? 0}`, `${pid}.sock`);
}

/** Sockets de contrôle privés d'idnma, un dossier par utilisateur. */
export function controlDir(): string {
  return process.env.IDNMA_CONTROL_DIR ?? `/tmp/idnma-${process.getuid?.() ?? 0}`;
}

/**
 * Dossier que `dst` lira pour ses patchs : `IDNMA_DSH_HOME`, sinon `DSH_HOME`, sinon `~/.dsh`.
 * `env` est injectable : c'est aussi l'env de l'enfant que le lancement inspecte.
 */
export function dshHome(env: Record<string, string | undefined> = process.env): string {
  return env.IDNMA_DSH_HOME ?? env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * Dossier d'état de la TUI de dst (`~/.dsh-tui`), où elle retient le dernier mode de permission choisi.
 * `IDNMA_DST_PREFS_DIR` le redirige (tests, sandbox) ; `env` est injectable comme pour `dshHome`.
 */
export function dstPrefsDir(env: Record<string, string | undefined> = process.env): string {
  return env.IDNMA_DST_PREFS_DIR ?? join(homedir(), ".dsh-tui");
}

/** Socket du pont d'une doublure dst, dans le dossier de contrôle d'idnma (chemin court : 104 octets au plus sous macOS). */
export function dstBridgeSocketPath(pid: number = process.pid): string {
  return join(controlDir(), `${pid}.dst.sock`);
}

/** Pont entre la doublure et l'extension idnma chargée dans Pi, à côté des sockets de contrôle. */
export function piBridgeSocketPath(pid: number = process.pid): string {
  return join(controlDir(), `${pid}.pi.sock`);
}

/** Dossier d'agent de Pi (`PI_CODING_AGENT_DIR`, défaut `~/.pi/agent`), où vivent son `AGENTS.md` et ses skills. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Dossier de Claude Code lui-même (`CLAUDE_CONFIG_DIR`, défaut `~/.claude`), où vivent ses skills. */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Dossier de Codex lui-même (`CODEX_HOME`, défaut `~/.codex`). */
export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Socket de contrôle du daemon app-server de Codex (WebSocket sur Unix). */
export function codexDaemonSocket(): string {
  return join(codexHome(), "app-server-control", "app-server-control.sock");
}

/** Dossier de Grok lui-même (`GROK_HOME`, défaut `~/.grok`). */
export function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), ".grok");
}

/** Dossier de configuration d'opencode (`IDNMA_OPENCODE_CONFIG_DIR`, sinon `$XDG_CONFIG_HOME/opencode` ou `~/.config/opencode`). */
export function opencodeConfigDir(): string {
  return process.env.IDNMA_OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
}

/** Fichier d'état du service opencode (`IDNMA_OPENCODE_SERVICE_FILE`, sinon `$XDG_STATE_HOME/opencode/service.json` ou `~/.local/state/opencode/service.json`). */
export function opencodeServiceFile(): string {
  return process.env.IDNMA_OPENCODE_SERVICE_FILE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "service.json");
}

/** Dossier des plugins d'agy, où le plugin `idnma` est posé par la CLI `agy`. */
export function agyPluginsDir(): string {
  return process.env.IDNMA_AGY_PLUGINS_DIR ?? join(homedir(), ".gemini", "config", "plugins");
}

/** Binaire d'agy (`IDNMA_AGY_BIN`, défaut `agy` résolu dans le PATH). */
export function agyBinary(): string {
  return process.env.IDNMA_AGY_BIN ?? "agy";
}
