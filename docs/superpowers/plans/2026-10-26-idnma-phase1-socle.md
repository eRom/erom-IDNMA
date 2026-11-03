# IdnmA phase 1 (socle) : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer le socle d'IdnmA : `idnma run` qui lit `network.yml`, l'inscription d'un pair étranger dans le bus de Claude Code, l'envoi signé, la réception en file, et le CLI agent `idnma peer send|list` et `idnma read`, sans encore de livraison proactive par harnais.

**Architecture:** Un CLI Bun unique (`src/cli.ts`). La couche `bus/` reproduit le protocole pair de Claude Code 2.1.310 (registre `~/.claude/sessions/`, clé, socket Unix, trames JSON par ligne). Pour un agent `claude`, `idnma run` fait `execve` de `claude` ; pour `codex`, `grok`, `agy`, le process reste en vie comme doublure : il s'inscrit dans le bus, lance le harnais en enfant (stdio hérité ; le PTY arrive en phase 3 avec la sonnette), met les messages reçus en file et sert un canal de contrôle local au CLI de l'agent.

**Tech Stack:** Bun 1.4.0, TypeScript 7.0.2, `@types/bun` 1.4.0, `zod` ^4.0.0, `yaml` ^2.8.0, `bun test` (mêmes versions que `erom-agence-control-plane/package.json`, relu le 26/10).

**Spec:** `docs/superpowers/specs/2026-10-26-idnma-design.md` (§5, §6, §7.1 à §7.3, §7.7, §8). Faits de protocole : `.claude/notes/2026-10-26-sondes-bus.md`.

## Global Constraints

- Identifiants, noms de fichiers, clés JSON, messages de log techniques en anglais ; commentaires et messages affichés à Romain en français, sans tiret cadratin.
- Chemins de prod : `~/.config/idema/` (config), `~/.claude/sessions/` (registre), `/tmp/cc-socks/` (sockets du bus), `/tmp/idnma-<uid>/` (sockets de contrôle). Chacun est redirigeable par variable d'environnement (`IDNMA_CONFIG_DIR`, `IDNMA_CLAUDE_DIR`, `IDNMA_SOCKETS_DIR`, `IDNMA_CONTROL_DIR`), lue à chaque appel : c'est le seul mécanisme de redirection des chemins (l'injection de dépendances de `runAgent`, tâche 10, reste permise).
- Toute écriture sur un socket passe par `node:net` (`createConnection` puis `end(data)`, ou `socket.end(data)` côté serveur), jamais par `Bun.connect` ni `socket.write` de `Bun.listen` : mesuré sur Bun 1.4.0, `Bun.connect` n'écrit que 8 192 octets et ferme, le reste est perdu en silence.
- Le code produit retire ses fichiers avec `unlinkSync` ou `rmSync({ force: true })`. La règle « jamais `rm`, toujours `trash` » vaut pour le shell de l'agent, pas pour le code.
- Hygiène de test : tout sous-process de test reçoit un environnement purgé de `IDNMA_NAME`, `IDNMA_CONTROL_SOCKET`, `IDNMA_CONTROL_TOKEN` ; un test qui exige l'absence d'une variable (ex. `OPENROUTER_API_KEY`, présente dans le shell de Romain) la retire de `process.env` et la restaure en `afterEach`.
- Les tests n'écrivent jamais dans les chemins de prod. Dossiers de test sous `/tmp` (`mkdtempSync("/tmp/idnma-t-")`) : un chemin de socket Unix ne dépasse pas 103 octets.
- `procStart` = sortie de `ps -o lstart= -p <pid>` avec `TZ=UTC` et `LC_ALL=C`, `trim()` seul (les espaces internes restent, comme chez Claude).
- Aucun secret affiché : ni jeton (`peerToken`, `IDNMA_CONTROL_TOKEN`), ni valeur de `secrets.yml`, ni dans un log, ni dans un message d'erreur, ni dans un test qui échoue.
- Un fichier `.key` et un socket sont en mode 600 ; une entrée de registre en mode 644, écrite de façon atomique (temporaire puis renommage).
- Commits : préfixe conventionnel, sujet en français (style du dépôt caserne), terminés par les deux lignes `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` et `Claude-Session: https://claude.ai/code/session_0189TfTMuBVjg7nDJyATe5Mr`.
- Travail sur la branche `feat/idnma-phase1-socle`, créée par la tâche 1.

## Review Focus

1. `network.yml` contient `info: 4.7` et `info: 3.8` (nombres YAML) : le chargement doit l'accepter (test dans la tâche 1).
2. Un agent mal formé ailleurs dans `network.yml` ne doit pas empêcher de lancer un agent correct (test dans la tâche 1).
3. Une entrée de registre dont le pid est mort, ou dont le pid a été réutilisé (`procStart` différent), n'est ni un nom pris ni un pair listé (test dans la tâche 2).
4. Fermer le pane (`SIGHUP` reçu par la doublure) retire entrée, clé et sockets, même si le harnais ignore `SIGHUP` (test dans la tâche 8).
5. Le 51e message en attente est refusé proprement, sans planter la doublure ni perdre les 50 premiers (test dans la tâche 7).

---

### Task 1: Projet et configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/paths.ts`, `src/config/network.ts`, `src/config/secrets.ts`
- Test: `tests/config.test.ts`, fixture `tests/fixtures/network.yml` (copie de `docs/superpowers/specs/network.example.yml`)

**Interfaces:**
- Produces:
  - `configDir(): string`, `sessionsDir(): string`, `socketsDir(): string`, `controlDir(): string` (`src/paths.ts` ; défauts `~/.config/idema`, `~/.claude/sessions`, `/tmp/cc-socks`, `/tmp/idnma-${process.getuid()}`).
  - `type Harness = "claude" | "codex" | "grok" | "agy"` ; `type ForeignHarness = Exclude<Harness, "claude">`.
  - `interface Engine { harness: Harness; model?: string; options: string[]; env: Record<string, string> }`.
  - `class ConfigError extends Error`.
  - `loadAgentEngine(agentKey: string, engineKey?: string): { engine: Engine; engineKey: string }` (`src/config/network.ts`).
  - `loadSecretsEnv(): Record<string, string>` et `resolveEnv(engineEnv: Record<string, string>, secretsEnv: Record<string, string>, baseEnv: Record<string, string | undefined>): Record<string, string>` (`src/config/secrets.ts`).

- [ ] **Step 1: Vérifier la branche et créer le projet.** `git branch --show-current` doit rendre `feat/idnma-phase1-socle` (commit initial et branche déjà faits ; `.gitignore` contient déjà `node_modules/`). `package.json` : `"name": "idnma"`, `"type": "module"`, `"private": true`, `"bin": { "idnma": "src/cli.ts" }`, scripts `"test": "bun test"` et `"typecheck": "tsc --noEmit"`, dépendances `zod`, `yaml`, dépendances de dev `@types/bun`, `typescript` (versions de l'en-tête), `tsconfig.json` repris de caserne (`types: ["bun"]`, `include: ["src", "tests", "scripts"]`). `bun install`.

- [ ] **Step 2: Écrire les tests qui échouent** (`tests/config.test.ts`, `IDNMA_CONFIG_DIR` pointé sur un dossier temporaire qui contient la fixture) :

```ts
test("charge chaque agent de l'exemple de Romain", () => {
  for (const key of ["claude", "glm", "deepseek", "qwen", "kimi", "muse", "grok", "agy", "codex"]) {
    expect(loadAgentEngine(key).engineKey).toBe("default");
  }
  expect(loadAgentEngine("grok").engine).toEqual({
    harness: "grok", model: "grok-4.7", options: ["--effort", "high", "--always-approve"], env: {},
  });
  expect(loadAgentEngine("codex").engine.model).toBeUndefined();
});
test("un agent cassé n'empêche pas d'en lancer un autre", () => {
  // fixture + `broken: { engines: { default: { harness: "nope" } } }`
  expect(loadAgentEngine("claude").engine.harness).toBe("claude");
  expect(() => loadAgentEngine("broken")).toThrow(/harness.*claude, codex, grok, agy/);
});
test("agent ou engine inconnu : message qui liste les choix", () => {
  expect(() => loadAgentEngine("nobody")).toThrow(/agy.*claude.*codex/);
  expect(() => loadAgentEngine("claude", "turbo")).toThrow(/default/);
});
test("resolveEnv : secrets.yml#env puis environnement, jamais de valeur dans l'erreur", () => {
  expect(resolveEnv({ A: "$K", B: "plain", C: "" }, { K: "s3cret" }, {})).toEqual({ A: "s3cret", B: "plain", C: "" });
  expect(resolveEnv({ A: "$K" }, {}, { K: "from-env" })).toEqual({ A: "from-env" });
  expect(() => resolveEnv({ A: "$MISSING" }, { OTHER: "s3cret" }, {})).toThrow(/\$MISSING/);
  try { resolveEnv({ A: "$MISSING" }, { OTHER: "s3cret" }, {}); } catch (e) { expect(String(e)).not.toContain("s3cret"); }
});
test("secrets.yml absent : table vide ; lisible par d'autres : refusé avec la commande chmod", () => {
  expect(loadSecretsEnv()).toEqual({});
  // écrire secrets.yml mode 644 avec `env: { K: v }`
  expect(() => loadSecretsEnv()).toThrow(/chmod 600/);
  // même fichier passé en 600
  expect(loadSecretsEnv()).toEqual({ K: "v" });
});
test("secrets.yml mal formé : position seulement, jamais de valeur", () => {
  // écrire en 600 : "env:\n  K: s3cret\n  bad: [unclosed\n"
  expect(() => loadSecretsEnv()).toThrow(/ligne \d+/);
  try { loadSecretsEnv(); } catch (e) { expect(String(e)).not.toContain("s3cret"); }
});
```

- [ ] **Step 3: Vérifier l'échec.** Run: `bun test tests/config.test.ts` ; Expected: FAIL (modules absents).

- [ ] **Step 4: Implémenter.** `loadAgentEngine` lit `network.yml` entier en YAML puis valide **seulement** `agents[agentKey]` avec zod (`label`, `info` (string ou number), `cell`, `avatar` tolérés et ignorés ; `engines` : record d'objets `{ harness: enum, model?: string, options?: string[], env?: record<string,string> }`, `options` et `env` normalisés à `[]` et `{}`). Un agent ou un engine inconnu liste les clés disponibles, triées. Messages d'erreur en français, sur le modèle de `frenchIssueReason` de caserne (`erom-agence-control-plane/src/registry/load.ts`). `loadSecretsEnv` reprend `assertSecretsPermissions` et la lecture YAML masquée de caserne (en cas d'erreur de syntaxe, seulement ligne et colonne), adaptés : fichier absent = `{}` (caserne levait). `resolveEnv` reprend `buildEnv` de caserne (`src/cli/run.ts:16`, motif `^\$([A-Z0-9_]+)$`).

- [ ] **Step 5: Vérifier.** Run: `bun test tests/config.test.ts && bun run typecheck` ; Expected: PASS, 0 erreur de type.

- [ ] **Step 6: Commit** (`feat(config): lecture de network.yml et des secrets`).

### Task 2: Registre de Claude (lecture, écriture, vivacité)

**Files:**
- Create: `src/bus/proc.ts`, `src/bus/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `sessionsDir()` (tâche 1).
- Produces:
  - `procStarts(pids: number[]): Map<number, string>` : un seul appel `ps -o pid=,lstart= -p <liste>` (`TZ=UTC`, `LC_ALL=C`) ; chaque ligne `^\s*(\d+)\s+(.*\S)\s*$` donne pid et `lstart` ; un pid absent est omis (format capturé le 26/10 : `" 5795 Mon Oct 26 14:39:38 2026    "`) ; liste vide : `ps` n'est pas appelé ; `ps` sort en code 1 quand aucun pid n'existe : rendre une `Map` vide, sans lever. `procStart(pid: number): string | undefined`.
  - `interface SessionEntry { pid: number; sessionId: string; cwd: string; startedAt: number; procStart: string; version: string; peerProtocol: number; peerFeatures: string[]; kind: string; entrypoint: string; pidDomain: string; messagingSocketPath: string; name: string; nameSource: string; nameSince: number; status: "idle" | "busy" | "waiting"; updatedAt: number; statusUpdatedAt: number; tmux?: string }`.
  - `listLiveEntries(): SessionEntry[]` : lit `<pid>.json` (nom de fichier `^\d+\.json$`), ignore les fichiers illisibles ou sans `pid`/`procStart`/`name`, garde une entrée si `procStarts` rend pour son pid exactement son `procStart`.
  - `writeEntry(entry: SessionEntry): string` (atomique, 644 ; le fichier temporaire ne se termine pas par `.json`, ex. `<pid>.json.tmp`) et `removeEntry(pid: number): void` (sans erreur si absent).

- [ ] **Step 1: Écrire les tests qui échouent.** Les entrées de test utilisent le pid d'un `sleep 600` lancé par le test (vivant, `procStart` réel) :
  - `listLiveEntries` rend l'entrée vivante, avec tous ses champs.
  - Entrée au pid d'un process terminé (`proc.kill()` puis `await proc.exited` : avant, `ps` montre encore le zombie) : absente.
  - Entrée au pid vivant mais `procStart` faux (`"Thu Jan  1 00:00:00 1970"`) : absente (pid réutilisé).
  - Fichier `123.json` invalide et fichier `x.key` : ignorés sans erreur.
  - `writeEntry` puis relecture : JSON identique, mode 644, aucun fichier temporaire restant ; `removeEntry` deux fois : pas d'erreur.
  - `procStarts([pidDuSleep, 1])` : deux entrées ; `procStart(pidDuSleep)` égal à `TZ=UTC LC_ALL=C ps -o lstart= -p <pid>` trimé.

- [ ] **Step 2: Vérifier l'échec.** Run: `bun test tests/registry.test.ts` ; Expected: FAIL.

- [ ] **Step 3: Implémenter** dans `src/bus/proc.ts` et `src/bus/registry.ts` (`Bun.spawnSync` pour `ps`).

- [ ] **Step 4: Vérifier.** Run: `bun test tests/registry.test.ts` ; Expected: PASS.

- [ ] **Step 5: Commit** (`feat(bus): lecture et écriture du registre de Claude`).

### Task 3: Noms uniques sur la machine

**Files:**
- Create: `src/naming/nicknames.ts` (copie de `erom-agence-control-plane/src/swarm/nicknames.ts`), `src/naming/lock.ts` (copie de `src/swarm/lock.ts`, variables `IDNMA_LOCK_MAX_RETRIES` et `IDNMA_LOCK_RETRY_MS`), `src/naming/choose.ts`
- Test: `tests/naming.test.ts` (reprendre aussi `tests/swarm-nicknames.test.ts` de caserne, où `assertValidName` est remplacé par la regex `^[A-Za-z0-9_-]+$`)

**Interfaces:**
- Consumes: `listLiveEntries()` (tâche 2), `configDir()` (tâche 1).
- Produces:
  - `nickname(base: string, opts?: { taken?: Set<string>; rand?: () => number }): string` (inchangé).
  - `withNameLock<T>(fn: () => Promise<T>): Promise<T>` : `withLock(join(configDir(), "names"), fn)`, dossier créé au besoin.
  - `chooseName(base: string, explicit?: string): string` : `taken` = noms des entrées vivantes ; un nom explicite doit vérifier `^[A-Za-z0-9_-]+$` et ne pas être pris (sinon `ConfigError` qui nomme le pid du détenteur).

- [ ] **Step 1: Écrire les tests qui échouent.**
  - Avec une entrée vivante `claude-vulcain`, `chooseName("claude", undefined)` ne rend jamais `claude-vulcain` (100 tirages, `rand` injecté non requis) et rend un nom court `^claude-[a-z]+$`.
  - `chooseName("claude", "claude-vulcain")` : erreur qui contient le pid du détenteur ; `chooseName("claude", "a b")` : erreur de format.
  - Une entrée **morte** nommée `codex-janus` ne bloque pas `chooseName("codex", "codex-janus")`.
  - Deux `withNameLock` concurrents ne se chevauchent pas (compteur partagé, comme `tests/swarm-lock.test.ts` de caserne).

- [ ] **Step 2: Vérifier l'échec.** Run: `bun test tests/naming.test.ts` ; Expected: FAIL.

- [ ] **Step 3: Implémenter** `chooseName` et `withNameLock` ; copier les deux modules de caserne avec une ligne d'origine en tête.

- [ ] **Step 4: Vérifier.** Run: `bun test tests/naming.test.ts` ; Expected: PASS.

- [ ] **Step 5: Commit** (`feat(naming): noms uniques sur la machine`).

### Task 4: Enveloppe, clé et envoi signé

**Files:**
- Create: `src/bus/envelope.ts`, `src/bus/key.ts`, `src/bus/send.ts`, `tests/helpers/fake-peer.ts`
- Test: `tests/envelope.test.ts`, `tests/send.test.ts`

**Interfaces:**
- Consumes: `listLiveEntries`, `SessionEntry`, `procStart` (tâche 2), `sessionsDir()` (tâche 1).
- Produces:
  - `type FromMode = "bypass" | "prompting"` ; `addressOf(socketPath: string): string` (`"uds:" + socketPath`).
  - `escapeBody(body: string): string`, `buildEnvelope(a: { from: string; fromName: string; fromMode: FromMode; body: string }): string`, `buildUserFrame(a: { msgId: string; from: string; content: string; priority?: "now" | "next" | "later" }): string` (une ligne JSON sans `\n` final), `authFrame(token: string): string`.
  - `keyFileName(pid: number, socketPath: string): string`, `publishKey(pid: number, socketPath: string, peerToken: string, procStart: string): string`, `readPeerToken(targetSocketPath: string): string | undefined`.
  - `class PeerError extends Error` ; `writeFrames(socketPath: string, lines: string[], timeoutMs?: number): Promise<void>` ; `sendPeerMessage(a: { fromSocketPath: string; fromName: string; fromMode: FromMode; to: string; body: string }): Promise<{ msgId: string; target: SessionEntry }>`.
  - Test helper `startFakePeer(name: string, overrides?: Partial<SessionEntry>): Promise<{ entry: SessionEntry; socketPath: string; lines: unknown[]; stop(): void }>` : entrée au pid d'un `sleep 600` (pour ne pas heurter le `<pid>.json` du test), clé publiée, serveur Unix qui journalise chaque ligne JSON reçue ; une ligne `auth` est journalisée `{ type: "auth", tokenMatches: boolean }`, jamais avec le jeton (comme la sonde).

Code normatif, exécuté le 26/10 contre les échantillons de sonde (l'enveloppe est octet pour octet celle qu'un vrai Claude a acceptée ; le nom de clé est celui que Claude a lu) :

```ts
// Claude 2.1.310 reconstruit l'enveloppe reçue et la compare octet par octet : hors forme
// canonique, `from-mode` est perdu et le message est retenu. Ordre des attributs imposé.
const TAG = "cross-session-message";
export function escapeBody(body: string): string {
  // Comme `Vrt` de Claude pour le cas ASCII : le « < » d'une balise fermante devient « <\ ».
  return body.replace(/<(?!\\)(?=\/cross-session-message)/gi, "<\\");
}
export function buildEnvelope(a: { from: string; fromName: string; fromMode: FromMode; body: string }): string {
  return `<${TAG} from="${a.from}" from-name="${a.fromName}" from-mode="${a.fromMode}">\n${escapeBody(a.body)}\n</${TAG}>`;
}
export function keyFileName(pid: number, socketPath: string): string {
  return `${pid}.${createHash("sha256").update(resolve(socketPath)).digest("hex")}.key`;
}
```

- [ ] **Step 1: Écrire les tests qui échouent.** `tests/envelope.test.ts` :

```ts
expect(buildEnvelope({ from: "uds:/tmp/cc-socks/83379.sock", fromName: "probe-janus", fromMode: "bypass",
  body: "Sonde 1 retour A : probe-janus répond en attestant bypass." })).toBe(
  '<cross-session-message from="uds:/tmp/cc-socks/83379.sock" from-name="probe-janus" from-mode="bypass">\n'
  + "Sonde 1 retour A : probe-janus répond en attestant bypass.\n</cross-session-message>");
expect(escapeBody("a </cross-session-message> b </Cross-Session-Message> c <\\/cross-session-message>"))
  .toBe("a <\\/cross-session-message> b <\\/Cross-Session-Message> c <\\/cross-session-message>");
expect(keyFileName(83379, "/tmp/cc-socks/83379.sock"))
  .toBe("83379.d16f155bad8be9857e0bcb8f17e5a7e1b65bed5d678079314a5c4105079bb7da.key");
expect(JSON.parse(buildUserFrame({ msgId: "m1", from: "uds:/x.sock", content: "c" }))).toEqual(
  { msgV: 1, msg_id: "m1", type: "user", message: { role: "user", content: "c" }, priority: "next", from: "uds:/x.sock" });
```

`tests/send.test.ts`, avec `startFakePeer("claude-vulcain")` :
  - `sendPeerMessage({ to: "claude-vulcain", body: "hello", fromName: "codex-janus", fromMode: "bypass", fromSocketPath: "/tmp/cc-socks/1.sock" })` : le faux pair journalise d'abord `{ type: "auth", tokenMatches: true }`, puis une trame `user` dont `content` vaut `buildEnvelope(...)` avec `from: "uds:/tmp/cc-socks/1.sock"` et `from-name="codex-janus"`.
  - Corps de 200 Kio (`"x".repeat(200 * 1024)`) : le faux pair reçoit une trame dont le corps décodé fait exactement 200 Kio (garde contre la troncature à 8 192 octets).
  - `to` inconnu : `PeerError` « aucun pair vivant nommé … » ; deux pairs vivants du même nom : `PeerError` qui liste leurs pids.
  - `readPeerToken` d'un socket sans clé : `undefined`, et l'envoi part sans ligne `auth` (l'auth est facultative sur macOS).
  - `publishKey` : mode 600, contenu `{ peerToken, procStart, pidDomain: "darwin" }`.

- [ ] **Step 2: Vérifier l'échec.** Run: `bun test tests/envelope.test.ts tests/send.test.ts` ; Expected: FAIL.

- [ ] **Step 3: Implémenter.** `writeFrames` : `node:net` `createConnection(socketPath)` puis `end(lignes jointes par \n + \n final)`, résolu sur `close` (voir Global Constraints) ; erreur de connexion ou délai dépassé : `PeerError` qui nomme le socket. `readPeerToken` : cherche `*.${hash}.key` dans `sessionsDir()`, garde celui dont le pid est vivant avec le même `procStart` (`procStarts`), rend son `peerToken`. `msgId` : `crypto.randomUUID()`.

- [ ] **Step 4: Vérifier.** Run: `bun test tests/envelope.test.ts tests/send.test.ts` ; Expected: PASS.

- [ ] **Step 5: Commit** (`feat(bus): enveloppe canonique, clé et envoi signé`).

### Task 5: Boîte de réception

**Files:**
- Create: `src/bus/inbox.ts`
- Test: `tests/inbox.test.ts`

**Interfaces:**
- Consumes: `writeFrames`, `authFrame`, `buildUserFrame` (tâche 4).
- Produces:
  - `interface InboundMessage { msgId?: string; from?: string; priority: "now" | "next" | "later"; content: string; authenticated: boolean; receivedAt: number }`.
  - `startInboxServer(o: { socketPath: string; peerToken: string; onMessage: (m: InboundMessage) => void; onControl?: (frame: Record<string, unknown>) => void; firstLineDeadlineMs?: number }): { stop(): void }`.

Comportement figé par la sonde et le binaire de Claude (`.claude/notes/2026-10-26-sondes-bus.md`) : lignes JSON ; `auth` facultative en première ligne (marque la connexion `authenticated` si le jeton correspond) ; `type: "user"` avec `message.content` chaîne non vide → `onMessage` (contenu transmis tel quel, sans réécriture) ; `type: "control"` → `onControl` ; tout le reste ignoré ; aucune réponse écrite sur la connexion ; connexion vide acceptée puis fermée par le client (sonde de vivacité) ; connexion sans ligne complète sous `firstLineDeadlineMs` (défaut 30 000) fermée ; ligne de plus de 2 Mio : connexion fermée ; `priority` absente ou inconnue → `"next"`. Socket en mode 600.

- [ ] **Step 1: Écrire les tests qui échouent.**
  - `writeFrames(sock, [authFrame(token), buildUserFrame({ msgId: "m1", from: "uds:/a.sock", content: "x" })])` : `onMessage` reçu une fois, `toMatchObject({ msgId: "m1", from: "uds:/a.sock", content: "x", authenticated: true, priority: "next" })`.
  - Mauvais jeton : `authenticated: false`, message tout de même rendu.
  - Ligne non JSON, puis une trame valide sur la même connexion : seule la trame valide est rendue.
  - Trame `control` (`{ type: "control", action: "peer_message_status", status: "held" }`) : `onControl` appelé, pas `onMessage`.
  - Connexion ouverte sans données, avec `firstLineDeadlineMs: 200` : fermée par le serveur en moins de 1 s.
  - Mode du fichier socket : `0o600`.

- [ ] **Step 2: Vérifier l'échec.** Run: `bun test tests/inbox.test.ts` ; Expected: FAIL.

- [ ] **Step 3: Implémenter** avec `Bun.listen({ unix })`, un tampon par connexion.

- [ ] **Step 4: Vérifier.** Run: `bun test tests/inbox.test.ts` ; Expected: PASS.

- [ ] **Step 5: Commit** (`feat(bus): boîte de réception sur socket Unix`).

### Task 6: Inscription d'un pair

**Files:**
- Create: `src/bus/register.ts`
- Test: `tests/register.test.ts`

**Interfaces:**
- Consumes: tâches 2, 4, 5 ; `socketsDir()`.
- Produces:
  - `class ProtocolMismatchError extends Error`.
  - `interface Registration { socketPath: string; address: string; entry: SessionEntry; peerToken: string; unregister(): void }`.
  - `registerPeer(o: { name: string; cwd: string; tmux?: string; onMessage: (m: InboundMessage) => void; onControl?: (f: Record<string, unknown>) => void }): Promise<Registration>`.
  - `claudeVersion(live: SessionEntry[]): string` : la plus haute `version` (comparaison numérique par segments) parmi les entrées vivantes ; à défaut, le premier mot de `claude --version` ; à défaut, `"0.0.0"`.

Contenu de l'entrée (spec §7.2) : `pid: process.pid`, `sessionId: randomUUID()`, `cwd`, `startedAt` et `nameSince` et `updatedAt` et `statusUpdatedAt` à `Date.now()`, `procStart: procStart(process.pid)`, `version: claudeVersion(...)`, `peerProtocol: 1`, `peerFeatures: []`, `kind: "interactive"`, `entrypoint: "cli"`, `pidDomain: "darwin"`, `messagingSocketPath: join(socketsDir(), \`${process.pid}.sock\`)`, `name`, `nameSource: "user"`, `status: "idle"`, `tmux` si fourni. Ordre : refuser si une entrée vivante a un `peerProtocol` numérique différent de 1 (`ProtocolMismatchError` qui cite la valeur vue ; champ absent : ignoré, Claude le lit comme 0) ; créer `socketsDir()` en mode 700 s'il manque ; retirer un `<pid>.sock` déjà présent (c'est notre pid : reste d'un crash avant réutilisation du pid ; `Bun.listen` refuse un chemin existant) ; démarrer la boîte ; publier la clé (32 hex aléatoires, `chmodSync` 600 après écriture : le `mode` de `writeFileSync` ne vaut qu'à la création) ; écrire l'entrée. `unregister()` : arrête la boîte, puis retire l'entrée, la clé, le socket, dans cet ordre ; idempotent.

- [ ] **Step 1: Écrire les tests qui échouent.**
  - Après `registerPeer({ name: "codex-janus", cwd: "/w", tmux: "idema-1:@4.%6", onMessage })` : `listLiveEntries()` contient l'entrée avec chacun des champs ci-dessus ; la clé existe sous `keyFileName(process.pid, socketPath)` ; `sendPeerMessage` depuis un faux expéditeur vers `codex-janus` déclenche `onMessage` avec `authenticated: true`.
  - `unregister()` deux fois : plus d'entrée, plus de clé, plus de socket, aucune erreur.
  - Entrée vivante (faux pair) à `peerProtocol: 2` : `registerPeer` rejette `ProtocolMismatchError` et n'a rien écrit.
  - `claudeVersion(["2.1.9", "2.1.310", "2.1.30"].map((version) => ({ version }) as SessionEntry))` rend `"2.1.310"`.
  - Un `<pid>.sock` périmé à notre pid ne bloque pas `registerPeer`.

- [ ] **Step 2: Vérifier l'échec.** Run: `bun test tests/register.test.ts` ; Expected: FAIL.

- [ ] **Step 3: Implémenter** `src/bus/register.ts`.

- [ ] **Step 4: Vérifier.** Run: `bun test tests/register.test.ts` ; Expected: PASS.

- [ ] **Step 5: Commit** (`feat(bus): inscription d'un pair dans le registre de Claude`).

### Task 7: File d'attente et classe de permissions

**Files:**
- Create: `src/doublure/queue.ts`, `src/doublure/from-mode.ts`
- Test: `tests/doublure-units.test.ts`

**Interfaces:**
- Consumes: `InboundMessage` (tâche 5), `FromMode` (tâche 4), `ForeignHarness` (tâche 1).
- Produces:
  - `class MessageQueue { constructor(cap?: number /* 50 */); push(m: InboundMessage): boolean; shift(): InboundMessage | undefined; get size(): number }` : `push` rend `false` et n'ajoute rien quand la file est pleine.
  - `inferFromMode(harness: ForeignHarness, argv: string[]): FromMode` : `bypass` si `argv` contient le flag de son harnais (`codex` : `--dangerously-bypass-approvals-and-sandbox`, `grok` : `--always-approve`, `agy` : `--dangerously-skip-permissions`), sinon `prompting` (code exécuté le 26/10).

- [ ] **Step 1: Écrire les tests qui échouent.**
  - 50 `push` rendent `true`, le 51e rend `false`, `size` vaut 50, puis `shift` rend les messages dans l'ordre d'arrivée (Review Focus 5).
  - `inferFromMode("codex", ["--dangerously-bypass-approvals-and-sandbox"])` vaut `"bypass"` ; `inferFromMode("agy", ["--model", "gemini-4-argon-medium"])` vaut `"prompting"` ; `inferFromMode("grok", ["--dangerously-skip-permissions"])` vaut `"prompting"` (le flag d'un autre harnais ne compte pas).

- [ ] **Step 2: Vérifier l'échec.** Run: `bun test tests/doublure-units.test.ts` ; Expected: FAIL.

- [ ] **Step 3: Implémenter** les deux modules.

- [ ] **Step 4: Vérifier.** Run: `bun test tests/doublure-units.test.ts` ; Expected: PASS.

- [ ] **Step 5: Commit** (`feat(doublure): file d'attente et classe de permissions`).

### Task 8: Doublure et canal de contrôle

**Files:**
- Create: `src/doublure/control.ts`, `src/doublure/doublure.ts`
- Test: `tests/doublure.test.ts`

**Interfaces:**
- Consumes: `Registration`, `registerPeer` (tâche 6), `MessageQueue` (tâche 7), `sendPeerMessage` (tâche 4), `controlDir()`.
- Produces:
  - `type ControlCall = { op: "send"; to: string; body: string } | { op: "read" }` ; `type ControlRequest = ControlCall & { token: string }` (`Omit` n'est pas distributif sur une union : `tsc` 7.0.2 perd `to` et `body`) ; `type ControlResponse = { ok: true; msgId: string } | { ok: true; message: string | null } | { ok: false; error: string }`.
  - `startControlServer(o: { socketPath: string; token: string; handle: (r: ControlRequest) => Promise<ControlResponse> }): { stop(): void }` : serveur `node:net` (`createServer`, réponse par `socket.end(ligne)`) ; une ligne de requête, une ligne de réponse, puis fermeture ; jeton faux → `{ ok: false, error: "jeton de contrôle invalide" }` ; socket 600 dans `controlDir()` (créé en 700), nommé `join(controlDir(), \`${process.pid}.sock\`)`, un reste au même chemin retiré avant écoute.
  - `controlRequest(r: ControlCall, env?: Record<string, string | undefined>): Promise<ControlResponse>` : client `node:net` ; lit `IDNMA_CONTROL_SOCKET` et `IDNMA_CONTROL_TOKEN` ; s'ils manquent, lève `PeerError("idnma : aucune doublure ici. Cette commande se lance depuis un agent démarré par idnma run.")`.
  - `runDoublure(o: { name: string; argv: string[]; env: Record<string, string>; fromMode: FromMode; registration: Registration | null; queue: MessageQueue; onControlReady?: (c: { socketPath: string; token: string }) => void }): Promise<number>`.

Comportement de `runDoublure`, dans cet ordre : installe ses gestionnaires de signaux **avant** de créer le canal de contrôle ; démarre le canal (`send` → `sendPeerMessage` avec `fromSocketPath: registration.socketPath`, `fromName: name`, `fromMode` ; `read` → `queue.shift()?.content ?? null` ; sans inscription, `send` rend `{ ok: false, error: "pas d'inscription au bus" }`) et appelle `onControlReady` ; lance `argv` avec `Bun.spawn`, stdio hérité, `env` complété par `IDNMA_NAME`, `IDNMA_CONTROL_SOCKET`, `IDNMA_CONTROL_TOKEN` (32 hex aléatoires) ; ignore `SIGINT` (l'enfant le reçoit par le terminal) ; sur `SIGHUP` ou `SIGTERM`, transmet le signal à l'enfant, nettoie, sort avec 129 ou 143 ; à la sortie de l'enfant, nettoie et rend son code (enfant tué par un signal : 128 + n). Nettoyer = `registration?.unregister()`, arrêt du canal, retrait de son socket, `process.off` des trois gestionnaires ; idempotent.

- [ ] **Step 1: Écrire les tests qui échouent** (`tests/doublure.test.ts`, inscription réelle dans les dossiers de test, faux pair `claude-vulcain` ; chaque test qui lance un enfant porte `{ timeout: 15_000 }`) :
  - Enfant `["sleep", "2"]`, un message pré-chargé, `onControlReady` capture socket et jeton : `controlRequest({ op: "read" }, { IDNMA_CONTROL_SOCKET, IDNMA_CONTROL_TOKEN })` rend le message, puis `{ ok: true, message: null }`.
  - Même montage, message pré-chargé de 200 Kio : `read` le rend intact (garde contre la troncature).
  - `controlRequest({ op: "send", to: "claude-vulcain", body: "bonjour" }, …)` : le faux pair reçoit une enveloppe avec `from-name="codex-janus"` et `from-mode="bypass"`.
  - Jeton faux : `{ ok: false, error: "jeton de contrôle invalide" }`.
  - `controlRequest` sans variables : `PeerError` avec le message ci-dessus.
  - Code de sortie : enfant `["sh", "-c", "exit 3"]` → `runDoublure` rend 3 ; après retour, plus d'entrée, plus de clé, plus de socket, et `process.listenerCount("SIGHUP")` est revenu à sa valeur d'avant.
  - Review Focus 4 : `runDoublure` lancé dans un sous-process `bun -e` avec l'enfant `["sh", "-c", "echo $$ > <tmp>/child.pid; trap '' HUP; exec sleep 30"]` ; le test attend que le socket de contrôle existe, envoie `SIGHUP` au sous-process : en moins de 2 s, plus d'entrée, plus de clé, plus de socket de bus ni de contrôle ; le test tue ensuite le `sleep` orphelin par son pid.

- [ ] **Step 2: Vérifier l'échec.** Run: `bun test tests/doublure.test.ts` ; Expected: FAIL.

- [ ] **Step 3: Implémenter** `src/doublure/control.ts` et `src/doublure/doublure.ts`.

- [ ] **Step 4: Vérifier.** Run: `bun test tests/doublure.test.ts` ; Expected: PASS.

- [ ] **Step 5: Commit** (`feat(doublure): canal de contrôle et cycle de vie`).

### Task 9: CLI agent

**Files:**
- Create: `src/cli.ts` (shebang `#!/usr/bin/env bun`, exécutable : `chmod +x`, mode git `100755`, sinon `bun link` ne sert pas le binaire)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `controlRequest` (tâche 8), `listLiveEntries` (tâche 2), `runAgent` (tâche 10, branché dans cette tâche-là).
- Produces: les commandes `idnma peer send <nom> <texte…>`, `idnma peer list`, `idnma read` (alias `idnma peer read`), `idnma --help`. Codes de sortie : 0 succès, 1 erreur (message en français sur stderr), 2 usage incorrect.

Sorties : `peer send` affiche `envoyé à <nom> (<msgId>)` ; `read` affiche le message brut, ou rien et code 0 si la file est vide ; `peer list` affiche une ligne par pair vivant, hors soi-même (`IDNMA_NAME`) : `<nom>  <status>  <tmux ou ->`, triée par nom.

- [ ] **Step 1: Écrire les tests qui échouent** (sous-process `bun src/cli.ts …` avec les variables de test et l'environnement purgé de la Global Constraint) :
  - Intégration avec la doublure (tâche 8) : `runDoublure` avec `argv = ["sh", "-c", "bun <repo>/src/cli.ts read > <tmp>/read.txt && bun <repo>/src/cli.ts peer send claude-vulcain bonjour"]`, un message pré-chargé dans la file : rend 0 ; `read.txt` contient le `content` du message ; le faux pair a reçu une enveloppe avec `from-name="codex-janus"` et `from-mode="bypass"`.
  - `peer send x y` sans doublure : code 1, stderr contient « aucune doublure ici ».
  - `peer send --help` : la sortie ne contient aucune option de nom (`--name`, `--from`, `--as`) (AC-9).
  - `peer list` avec deux faux pairs : deux lignes, triées, colonnes ci-dessus.
  - `peer send` avec plusieurs mots : le texte envoyé est la jonction par espaces.
  - Commande inconnue : code 2 et aide.

- [ ] **Step 2: Vérifier l'échec.** Run: `bun test tests/cli.test.ts` ; Expected: FAIL.

- [ ] **Step 3: Implémenter** `src/cli.ts` (dispatch à la main, sans dépendance de parsing).

- [ ] **Step 4: Vérifier.** Run: `bun test tests/cli.test.ts tests/doublure.test.ts` ; Expected: PASS.

- [ ] **Step 5: Commit** (`feat(cli): peer send, peer list et read`).

### Task 10: `idnma run`

**Files:**
- Create: `src/run/args.ts`, `src/run/pane.ts`, `src/run/run.ts`
- Modify: `src/cli.ts` (commande `run`)
- Test: `tests/run.test.ts`

**Interfaces:**
- Consumes: tâches 1, 3, 6, 7, 8.
- Produces:
  - `interface RunArgs { agent?: string; engine?: string; model?: string; name?: string; passthrough: string[] }` ; `parseRunArgs(argv: string[]): RunArgs` : `--here` consommé et ignoré où qu'il soit (IdemA tape `caserne run --here agy`) ; `--engine`, `--model`, `--name` en `--x v` ou `--x=v` ; premier positionnel = agent ; tout autre jeton inconnu et tout ce qui suit `--` va dans `passthrough`.
  - `type PaneProbe` et `assertOwnPane(probe?: PaneProbe): void` (repris de `erom-agence-control-plane/src/cli/wrap.ts:58-96`, `CASERNE_ALIAS` remplacé par `IDNMA_NAME`, messages adaptés à `idnma run`) ; `tmuxTarget(paneId: string): string` (`tmux display-message -p -t <pane> '#{session_name}:#{window_id}.#{pane_id}'`).
  - `isResume(passthrough: string[]): boolean` : repris de caserne (`src/cli/run.ts:87-93`, drapeaux `--resume`, `-r`, `--continue`, `-c`, et `--resume=…`).
  - `buildHarnessArgv(engine: Engine, o: { model?: string; name: string; passthrough: string[] }): string[]` : `[binaire, ...(model ? ["--model", model] : []), ...engine.options, ...(harness === "claude" && !isResume(passthrough) ? ["--name", name] : []), ...passthrough]`, binaire = nom du harnais. Pas de `--name` en reprise : une reprise par nom renommait la session et invalidait le nom affiché (incident caserne du 23/08).
  - `interface RunDeps { probe?: PaneProbe; which: (bin: string) => string | null; execve: (file: string, argv: string[], env: Record<string, string>) => never; runDoublure: typeof runDoublure; tmuxTarget: (paneId: string) => string }` ; `runAgent(a: RunArgs, deps?: Partial<RunDeps>): Promise<number>`.

Ordre de `runAgent` (spec §6) : agent requis ; `loadAgentEngine` ; modèle = `--model` sinon `engine.model` ; `resolveEnv(engine.env, loadSecretsEnv(), process.env)` (toute erreur part **avant** le reste) ; `assertOwnPane` ; binaire résolu par `which` (absent : erreur qui le nomme). `TMUX_PANE` se lit dans `(deps.probe?.env ?? process.env)`. Puis :
  - `claude` : hors reprise, `name = await withNameLock(async () => chooseName(agentKey, a.name))`, verrou relâché ; en reprise, pas de choix de nom et `name = agentKey` ; puis `execve(chemin, argv, { ...process.env, ...env, IDNMA_NAME: name })`.
  - harnais étranger : dans `withNameLock`, `chooseName` puis `registerPeer({ name, cwd: process.cwd(), tmux: tmuxTarget(TMUX_PANE), onMessage: (m) => { if (!queue.push(m)) /* file pleine : une ligne `queue-full` avec `msgId` et `from` dans idnma.log */ }, onControl: (f) => /* une ligne JSON horodatée */ appendFileSync(join(configDir(), "logs", "idnma.log"), …) })` (dossier `logs` créé au besoin ; jamais d'écriture sur stdout ou stderr, qui appartiennent à la TUI du harnais) ; une `ProtocolMismatchError` affiche un avertissement en français et continue avec `registration: null` ; puis `runDoublure({ name, argv, env: { ...process.env, ...env }, fromMode: inferFromMode(harness, [...engine.options, ...a.passthrough]), registration, queue })`.

- [ ] **Step 1: Écrire les tests qui échouent.**
  - `parseRunArgs(["--here", "agy"])` vaut `{ agent: "agy", passthrough: [] }` ; `parseRunArgs(["codex", "--model=x", "--resume", "--", "-c", "y"])` vaut `{ agent: "codex", model: "x", passthrough: ["--resume", "-c", "y"] }`.
  - `buildHarnessArgv` sur l'engine `claude` de la fixture, `name: "claude-vulcain"`, sans passthrough : `["claude", "--model", "opus", "--effort", "medium", "--dangerously-skip-permissions", "--remote-control", "--name", "claude-vulcain"]` ; sur `codex` : `["codex", "--dangerously-bypass-approvals-and-sandbox"]`.
  - `runAgent({ agent: "qwen", passthrough: [] })` avec `OPENROUTER_API_KEY` retirée de `process.env` (restaurée en `afterEach`) et absente de `secrets.yml` : rejette en nommant `$OPENROUTER_API_KEY`, et `execve` comme `probe.paneTty` n'ont jamais été appelés.
  - `runAgent({ agent: "glm", passthrough: [] }, deps factices ; le faux `execve` enregistre ses arguments puis lève une erreur sentinelle)` : `execve` appelé une fois ; `IDNMA_NAME` vaut un nom `^glm-[a-z]+$` absent des entrées vivantes ; l'env contient `ANTHROPIC_BASE_URL: "http://localhost:11434"` ; l'argv se termine par `["--name", IDNMA_NAME]`.
  - `runAgent({ agent: "claude", passthrough: ["--resume", "abc"] }, deps factices)` : l'argv ne contient pas `--name`.
  - `runAgent({ agent: "codex", passthrough: [] }, deps factices)` : `runDoublure` appelé avec `fromMode: "bypass"`, une inscription dont l'entrée porte le `tmux` rendu par `tmuxTarget` ; aucune entrée ne reste après (le faux `runDoublure` appelle `registration.unregister()`).
  - `assertOwnPane` avec `IDNMA_NAME` défini : erreur « ce pane a déjà son incarnation ».

- [ ] **Step 2: Vérifier l'échec.** Run: `bun test tests/run.test.ts` ; Expected: FAIL.

- [ ] **Step 3: Implémenter** les trois modules et brancher `run` dans `src/cli.ts`.

- [ ] **Step 4: Vérifier toute la suite.** Run: `bun test 2>&1 | tee /tmp/idnma-phase1-tests.log && bun run typecheck` ; Expected: toutes les suites PASS, 0 erreur de type ; le journal `/tmp/idnma-phase1-tests.log` est cité dans le rapport.

- [ ] **Step 5: Commit** (`feat(run): idnma run, exec de claude et doublure`).

### Task 11: Installation et recette avec un vrai Claude

**Files:**
- Create: `scripts/shell-doublure.ts`, `scripts/install-config.ts`

**Interfaces:**
- Consumes: `withNameLock`, `chooseName`, `registerPeer`, `MessageQueue`, `runDoublure`, `tmuxTarget`.
- Produces:
  - `scripts/shell-doublure.ts [bypass|prompting]` : inscrit le pane courant sous `chooseName("shell")` et lance `$SHELL` en doublure (outil de recette de la phase 1, pas une commande produit).
  - `scripts/install-config.ts` : copie `docs/superpowers/specs/network.example.yml` vers `~/.config/idema/network.yml` **seulement s'il n'existe pas** ; crée `~/.config/idema/secrets.yml` (mode 600) à partir du bloc `env:` de `~/.config/caserne/secrets.yml`, n'écrase rien d'existant, et n'affiche que les **noms** des clés recopiées.

- [ ] **Step 1: Installer le binaire.** Run: `cd /Users/recarnot/dev/erom-agence-network && bun link && command -v idnma` ; Expected: un chemin sous `~/.bun/bin/idnma` (même mécanisme que `caserne`, lien vers `install/global/node_modules`).

- [ ] **Step 2: Demander le feu vert de Romain**, puis lancer `bun scripts/install-config.ts`. Expected: `network.yml` créé (ou « déjà présent, rien touché ») ; liste des noms de variables recopiées ; `stat -f '%Lp' ~/.config/idema/secrets.yml` rend `600`.

- [ ] **Step 3: Recette AC-2 (unicité).** Dans deux sessions tmux différentes, `idnma run claude`. Expected: depuis un troisième pane, `idnma peer list` (qui ne montre que les entrées vivantes) affiche les deux sessions sous deux noms distincts au format `claude-<divinité>`.

- [ ] **Step 4: Recette pair étranger (base d'AC-1, AC-9, AC-10, AC-12).** Dans un pane tmux : `bun scripts/shell-doublure.ts bypass`. Depuis une session Claude en bypass :
  - `ListAgents` montre `shell-<divinité>` en `interactive`, avec son pane tmux ;
  - `SendMessage(to: "shell-<divinité>", "recette phase 1")`, puis dans le pane `idnma read` affiche l'enveloppe ;
  - dans le pane, `idnma peer send <nom du Claude> "retour phase 1"` : le message arrive dans Claude sans dialogue, `from-name` égal au nom de la doublure ;
  - relancer avec `prompting` : le même retour est retenu derrière un dialogue chez le Claude en bypass ;
  - fermer le pane : `ls ~/.claude/sessions/<pid>.* /tmp/cc-socks/<pid>.sock` ne trouve plus rien, et `ListAgents` ne la montre plus.

- [ ] **Step 5: Recette AC-11.** `env -u OPENROUTER_API_KEY idnma run qwen` dans un pane (variable absente de `secrets.yml`) : échec immédiat qui nomme `$OPENROUTER_API_KEY`, sans afficher aucune valeur.

- [ ] **Step 6: Vérifier puis commit.** Run: `bun run typecheck` (les scripts sont dans `include`) ; Expected: 0 erreur. Commit (`chore: scripts d'installation et de recette de la phase 1`), puis rapport : chaque recette avec la commande lancée et sa sortie réelle.
