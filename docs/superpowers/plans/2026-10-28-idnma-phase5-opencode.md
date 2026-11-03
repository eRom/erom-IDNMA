# IdnmA phase 5 (doublure opencode) : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un agent dont l'engine dit `harness: opencode` est lancé par `idnma run`, reçoit les messages de pairs sans frappe clavier, renvoie à l'expéditeur la réponse finale d'un tour ouvert pour lui, écrit à ses pairs par `idnma peer send`, et s'installe par `idnma install --agent opencode`.

**Architecture:** Doublure API, famille Codex. `idnma run` vérifie modèle et dossier, crée (ou reprend) une session sur le service de fond d'opencode avant l'inscription au bus, puis lance la TUI `opencode -s <id>` sans PTY. La TUI reçoit le canal de contrôle dans son environnement et le recopie dans celui de sa session, comme le sondage l'a montré. Le livreur opencode suit l'état par le flux SSE `GET /api/event`, livre par `POST /api/session/{id}/prompt` (`queue` ou `steer`) et renvoie le dernier texte du segment ouvert par le message d'un pair.

**Tech Stack:** Bun 1.4.0 (`fetch` et `Bun.serve` en TCP local pour le faux service), TypeScript 7.0.2, `bun test`. Aucune dépendance nouvelle.

**Spec:** `docs/superpowers/specs/2026-10-28-idnma-opencode-design.md` (§5 à §9, AC-1 à AC-13), qui complète `docs/superpowers/specs/2026-10-26-idnma-design.md` (§7.3 enveloppe, §7.4 rappel, §7.6 renvois). Faits et payloads capturés sur opencode 2.2.0 : `.claude/notes/2026-10-28-etude-opencode.md` et `.claude/notes/probes/opencode/captures/` (`sse-raw.txt` octets bruts du flux, `api-queue-steer.events.jsonl` livraison `queue`/`steer`, `free-limit-failed.events.jsonl` échec 429, `head-of-phase*.jsonl` prompt tapé par Romain, environnement, filtre `types=`, interruption, erreurs). OpenAPI du service : `opencode api GET /openapi.json`.

## Global Constraints

- Identifiants, noms de fichiers, clés JSON, événements de journal et titres de test en anglais ; commentaires et messages affichés à Romain en français, sans tiret cadratin.
- HTTP vers le service : `fetch` de Bun, auth Basic `opencode:<password>`. Toute écriture sur un socket Unix reste en `node:net` (`Bun.connect` tronque à 8 192 octets).
- Opérations du service utilisées, et elles seules : `GET /api/info`, `GET /api/model`, `GET|POST /api/session`, `GET /api/session/{id}`, `POST /api/session/{id}/model`, `POST /api/session/{id}/prompt`, `DELETE /api/session/{id}/inbox/{inboxID}` (retrait d'un élément garé de la doublure, spec §7.2), `GET /api/session/active`, `GET /api/event`. Jamais `PUT …/environment` (la TUI l'écrase, spec §6 point 8), jamais de route `/api/experimental/`, jamais `opencode service restart`, jamais de suppression de session. Toute requête hors flux SSE a un délai de 10 s (`AbortSignal.timeout`).
- Une fois la TUI lancée, rien sur stdout ni stderr : tout passe par `logEvent` (`src/log.ts`). Jamais de mot de passe, de jeton ni de texte de message au journal.
- Les tests ne touchent jamais au vrai service, à `~/.config/opencode`, à `~/.local/state/opencode` ni au binaire `opencode` : `IDNMA_OPENCODE_CONFIG_DIR` et `IDNMA_OPENCODE_SERVICE_FILE` pointent sur des dossiers de test, le service est le faux de la tâche 2, le démarrage du service est une dépendance injectée.
- Dossiers de test : `mkdtempSync("/tmp/idnma-t-")`, retirés en `afterEach`. Après `bun test`, `ls -d /tmp/idnma-t-* 2>/dev/null | wc -l` rend 0.
- Hygiène des sous-process de test : environnement purgé de `IDNMA_NAME`, `IDNMA_CONTROL_SOCKET`, `IDNMA_CONTROL_TOKEN`, `CODEX_THREAD_ID`, `OPENCODE_SESSION_ID`.
- Aucun secret dans les tests : mots de passe du faux service non hexadécimaux (`pw-test-not-secret`), aucune chaîne de 32 caractères hexadécimaux. Une fixture tirée d'une capture est produite par commande (`cp`, puis `sed -E -i '' 's/[0-9a-f]{32,}/hexscrubbed/g'`), jamais relue puis réécrite à la main : l'affichage masque ces chaînes. Les tests lisent `tests/fixtures/`, jamais `.claude/notes/`.
- Lire le code par le graphe : depuis la racine du worktree, après `codegraph init --yes`, `codegraph explore "<identifiants exacts>"` (exemple : `codegraph explore "runAgent buildHarnessArgv runUnderstudy Courier createCodexCourier"`).
- Travail dans le worktree `/Users/recarnot/dev/erom-agence-network-p5`, branche `feat/idnma-opencode`, créés à la mise en place depuis `main` 48edb53. Le checkout principal reste sur `main` : les hooks Grok et agy installés exécutent son `src/cli.ts`.
- Commits : préfixe conventionnel, sujet en français, terminés par les lignes d'attribution que la session d'exécution reçoit de son harnais.
- Suite de départ : 565 pass, 0 fail (`bun test`, 28/10).

## Review Focus

1. Romain tape un prompt pendant le tour ouvert par un pair, avant que le modèle ait fini : le pair reçoit « tour mêlé », jamais une réponse qui mélange les deux demandes (test dans la tâche 5).
2. Un pair B envoie un `now` pendant le tour du pair A : A garde son renvoi automatique, B n'en reçoit aucun et a le rappel de réponse (test dans la tâche 5).
3. Romain supprime la session dans opencode pendant que l'agent tourne : la doublure quitte le bus et prévient les expéditeurs en file, au lieu de réessayer sans fin (test dans la tâche 4).
4. Le service redémarre sur un autre port avec un autre mot de passe : la reconnexion relit `service.json` et livre de nouveau (test dans la tâche 5).
5. Un modèle dont l'id contient `/` et une variante (`openrouter/particle-ai/particle-1#high`) est lu, validé et passé à la session sans être tronqué (tests dans les tâches 2 et 6).

---

### Task 1: Harnais `opencode` dans la configuration

**Files:**
- Modify : `src/config/network.ts` (`Harness`, `HARNESSES`), `src/understudy/from-mode.ts` (`BYPASS_FLAGS`), `src/run/run.ts` (`SHORT_ALIASES`, `buildHarnessArgv`), `src/paths.ts`, `tests/fixtures/network.yml`.
- Test : `tests/config.test.ts`, `tests/run.test.ts`.

**Interfaces:**
- Produces :
  - `type Harness = "claude" | "codex" | "grok" | "agy" | "opencode"` ; `ForeignHarness` en hérite.
  - `opencodeConfigDir(): string` : `IDNMA_OPENCODE_CONFIG_DIR`, sinon `<XDG_CONFIG_HOME ou ~/.config>/opencode`.
  - `opencodeServiceFile(): string` : `IDNMA_OPENCODE_SERVICE_FILE`, sinon `<XDG_STATE_HOME ou ~/.local/state>/opencode/service.json` (opencode suit ces deux variables, vérifié par `opencode debug paths`).
  - `BYPASS_FLAGS.opencode = "--auto"` ; `SHORT_ALIASES.opencode = { "-s": "--session", "-c": "--continue", "-m": "--model" }`.
  - `buildHarnessArgv` n'injecte jamais `--model` pour `opencode` (la TUI n'a pas ce flag) ; un `-m` tapé reste dans l'argv rendu, la tâche 6 l'en retire.
  - Fixture : agent `opencode` avec `default: { harness: opencode, model: opencode/big-pickle }` et `auto: { harness: opencode, model: ollama-cloud/deepseek-v4.1-flash, options: [--auto] }`.

- [ ] **Step 1: Vérifier le worktree.** `cd /Users/recarnot/dev/erom-agence-network-p5 && git branch --show-current` rend `feat/idnma-opencode`.
- [ ] **Step 2: Tests qui échouent.**
  - `loadAgentEngine("opencode")` rend `{ engine: { harness: "opencode", model: "opencode/big-pickle", options: [], env: {} }, engineKey: "default" }`.
  - `inferFromMode("opencode", ["--auto"])` vaut `"bypass"` ; `inferFromMode("opencode", [])` vaut `"prompting"`.
  - `buildHarnessArgv({ harness: "opencode", model: "opencode/big-pickle", options: ["--auto"], env: {} }, { passthrough: ["-s", "ses_x"] })` vaut `["opencode", "--auto", "-s", "ses_x"]`.
  - `opencodeConfigDir()` : `IDNMA_OPENCODE_CONFIG_DIR=/a` → `/a` ; sans elle, `XDG_CONFIG_HOME=/x` → `/x/opencode`. `opencodeServiceFile()` : `XDG_STATE_HOME=/y` → `/y/opencode/service.json`.
- [ ] **Step 3: Vérifier l'échec.** Run : `bun test tests/config.test.ts tests/run.test.ts` ; Expected : FAIL sur les nouveaux tests.
- [ ] **Step 4: Implémenter.**
- [ ] **Step 5: Vérifier.** Run : `bun test 2>&1 | tee /tmp/idnma-p5-t1.log && bun run typecheck` ; Expected : PASS, 0 erreur de type.
- [ ] **Step 6: Commit** (`feat(config): harnais opencode dans network.yml`).

### Task 2: Modèles, service et client HTTP

**Files:**
- Create : `src/opencode/model.ts`, `src/opencode/service.ts`, `tests/helpers/fake-opencode-service.ts`.
- Test : `tests/opencode-service.test.ts`.

**Interfaces:**
- Consumes : `opencodeServiceFile()` (tâche 1).
- Produces :
  - `interface ModelRef { providerID: string; id: string; variant?: string }`.
  - `parseModelRef(text: string): ModelRef | undefined` : fournisseur jusqu'au **premier** `/`, variante après le dernier `#` ; `undefined` sans `/` ou avec une partie vide.
  - `interface ModelEntry { providerID: string; id: string; variants?: Array<{ id: string }> }` (forme de `GET /api/model`, `data` en tableau).
  - `hasModel(models: ModelEntry[], ref: ModelRef): boolean` : même `providerID` et `id` ; variante absente ou `"default"` acceptée, sinon présente dans `variants[].id`.
  - `interface ServiceInfo { url: string; pid: number; password: string }`.
  - `readServiceInfo(path = opencodeServiceFile()): ServiceInfo | undefined` (fichier absent, illisible ou champ manquant : `undefined`).
  - `ensureService(deps?: Partial<{ start(): void; isAlive(pid: number): boolean; sleep(ms: number): Promise<void>; read(): ServiceInfo | undefined; timeoutMs: number }>): Promise<ServiceInfo | undefined>`. Fichier lisible et pid vivant : rendu tel quel. Sinon `start()` une fois, puis relecture toutes les 200 ms jusqu'à `timeoutMs` (10 000) ; `undefined` au-delà. `start` par défaut : `Bun.spawn([opencode, "service", "start"])` détaché, stdio ignoré, sans l'attendre ; `isAlive` par défaut : `process.kill(pid, 0)` (EPERM vaut vivant). Journal `opencode-service-start`.
  - `class OpencodeHttpError extends Error { status: number; tag?: string }` (le `_tag` et le `message` du corps quand il est en JSON).
  - `interface OpencodeSession { id: string; parentID?: string; model?: ModelRef }`.
  - `createOpencodeClient(info: ServiceInfo, o?: { fetchImpl?: typeof fetch; requestTimeoutMs?: number }): OpencodeClient` (délai 10 000 ms par défaut, `AbortSignal.timeout` ; un délai dépassé ou une erreur réseau lève `OpencodeHttpError` de `status` 0), avec :
    - `info(): Promise<{ version: string }>` ;
    - `listModels(directory: string): Promise<ModelEntry[]>`, requête `?location[directory]=<dossier>` (paramètre `deepObject` de l'OpenAPI : la liste vue depuis ce dossier, config du projet comprise) ;
    - `getSession(id: string): Promise<OpencodeSession | undefined>` (404 : `undefined`) ;
    - `createSession(o: { id?: string; directory: string; model?: ModelRef }): Promise<OpencodeSession>`, corps `{ location: { directory }, model?, id? }` ;
    - `listSessions(directory: string): Promise<OpencodeSession[]>`, requête `?directory=<dossier>&order=desc` ;
    - `switchModel(id: string, model: ModelRef): Promise<void>`, corps `{ model }` ;
    - `cancelInbox(id: string, inboxID: string): Promise<void>` (`DELETE /api/session/{id}/inbox/{inboxID}`) ;
    - `prompt(id: string, p: { text: string; delivery: "queue" | "steer"; metadata: Record<string, unknown> }): Promise<{ inboxID: string }>`. `inboxID` est le `data.id` de la réponse, le même id que `inboxID` dans `session.inbox.*` (capture `api-queue-steer.events.jsonl`) ;
    - `activeSessions(): Promise<Set<string>>` (clés de `data`).
    - Toute réponse hors 2xx lève `OpencodeHttpError`.
  - Faux service `startFakeOpencodeService(o?: { password?: string }): FakeOpencodeService`, `Bun.serve` sur `127.0.0.1`, port 0. Basic `opencode:<password>` exigé, sinon 401 `{"_tag":"UnauthorizedError","message":"Authentication required"}` (forme mesurée). Membres :
    - `url` ;
    - `requests: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }>` ;
    - `handle(method, path, reply: (req) => { status: number; body?: unknown })` ;
    - `writeServiceFile(path, pid = process.pid)` ;
    - `stop()`.
    - Défauts : `GET /api/info` → `{ version: "2.2.0", pid, urls: [url] }` (sans enveloppe `data`, comme le vrai) ; route inconnue → 404 sans corps.

- [ ] **Step 1: Tests qui échouent.**
  - `parseModelRef("opencode/big-pickle")` → `{ providerID: "opencode", id: "big-pickle" }`.
  - `parseModelRef("openrouter/particle-ai/particle-1#high")` → `{ providerID: "openrouter", id: "particle-ai/particle-1", variant: "high" }`.
  - `parseModelRef("big-pickle")`, `parseModelRef("/x")` et `parseModelRef("x/")` → `undefined`.
  - `hasModel` sur `[{ providerID: "ollama-cloud", id: "deepseek-v4.1-flash", variants: [{ id: "low" }, { id: "high" }] }]` : variantes absente, `"default"` et `"high"` → `true` ; `"turbo"` → `false` ; autre fournisseur → `false`.
  - Le client envoie `authorization: Basic base64("opencode:pw-test-not-secret")`. Avec un mauvais mot de passe : `OpencodeHttpError`, `status` 401.
  - `getSession` sur 404 rend `undefined`. `prompt` sur une session inconnue : le faux rend `404 { _tag: "SessionNotFoundError", sessionID, message: "Session not found: ses_x" }`, et le client lève `status` 404, `tag` `"SessionNotFoundError"`.
  - `createSession({ directory: "/w", model: { providerID: "opencode", id: "big-pickle" } })` envoie exactement ce corps et rend la session ; sans `model`, le corps n'a pas de clé `model`.
  - `listSessions("/w")` envoie `directory=/w` et `order=desc` ; `listModels("/w")` envoie `location[directory]=/w`.
  - Un faux qui ne répond jamais à `GET /api/info` : avec `requestTimeoutMs: 50`, le client lève `status` 0 en moins d'une seconde.
  - `readServiceInfo` : fichier absent ou JSON invalide → `undefined`.
  - `ensureService` :
    - pid vivant → aucun appel à `start` ;
    - pid mort → `start` appelé une fois, puis le fichier réécrit par le faux `start` est rendu ;
    - fichier jamais réécrit → `undefined` après `timeoutMs` (`sleep` injecté, pas d'attente réelle).
- [ ] **Step 2: Vérifier l'échec.** Run : `bun test tests/opencode-service.test.ts` ; Expected : FAIL (modules absents).
- [ ] **Step 3: Implémenter** `model.ts`, `service.ts` et le faux service.
- [ ] **Step 4: Vérifier.** Run : `bun test tests/opencode-service.test.ts 2>&1 | tee /tmp/idnma-p5-t2.log && bun run typecheck` ; Expected : PASS.
- [ ] **Step 5: Commit** (`feat(opencode): client du service de fond et validation des modèles`).

### Task 3: Flux d'événements SSE

**Files:**
- Create : `src/opencode/events.ts`.
- Modify : `tests/helpers/fake-opencode-service.ts` (route `GET /api/event`).
- Test : `tests/opencode-events.test.ts`.

**Interfaces:**
- Consumes : `ServiceInfo`, `OpencodeHttpError` (tâche 2).
- Produces :
  - `interface OpencodeEvent { type: string; data: Record<string, unknown> }`.
  - `const COURIER_EVENT_TYPES` : `session.execution.started`, `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted`, `session.inbox.enqueued`, `session.inbox.delivered`, `session.inbox.cancelled`, `session.text.ended`, `session.step.ended`.
  - `openEventStream(o: { info: ServiceInfo; types: readonly string[]; onEvent(e: OpencodeEvent): void; onClose(error?: unknown): void; fetchImpl?: typeof fetch }): Promise<{ close(): void }>`. La promesse tient à la réception des en-têtes en 200 ; un autre statut la rejette en `OpencodeHttpError`. Les types partent en `types=` répétés (sondé : 200, seuls ces types plus `server.connected`). `onClose` est appelé une fois quand le serveur ferme ou que la lecture échoue, jamais après `close()`.
  - Format (capture `sse-raw.txt`) :
    - trames séparées par une ligne vide ;
    - lignes `data: <json>` et commentaires `: heartbeat`, sans ligne `event:` ;
    - le JSON vaut `{ id, type, data, created?, location?, durable? }`.
    - Une trame sans `data:` est ignorée ; un JSON invalide est ignoré et journalisé (`opencode-event-invalid`, longueur seule).
  - Faux service :
    - `emit(event: Record<string, unknown>)` écrit `data: <json>\n\n` à chaque flux ouvert ;
    - `emitRaw(text)` écrit `text` tel quel ;
    - `dropStreams()` ferme chaque flux ouvert ;
    - `openStreams(): number` ;
    - les flux ouverts sont lisibles dans `requests` (`path` `/api/event`, `query`).

- [ ] **Step 1: Tests qui échouent.**
  - Fixture : `cp .claude/notes/probes/opencode/captures/sse-raw.txt tests/fixtures/opencode-sse-raw.txt`, puis le `sed` des contraintes globales (le `projectID` est en hexadécimal). Rejouée par `emitRaw` en morceaux de 7 octets, elle donne dans l'ordre `server.connected`, `session.created`, `session.deleted`. `session.created.data.sessionID` vaut `ses_e7bae6e32ffetIyiqgxuXdM4sO`, et aucun événement ne naît des battements.
  - Une trame `session.text.ended` dont `text` vaut `réponse « ok » é`, rejouée en morceaux de 7 octets (coupures au milieu des caractères multi-octets), arrive avec ce texte exact.
  - Une trame `data: {pas du json` est ignorée ; la suivante arrive ; le journal porte une ligne `opencode-event-invalid`.
  - La requête du flux porte `types=session.execution.started` et `types=session.text.ended` (au moins), et l'auth Basic.
  - `dropStreams()` → `onClose` appelé une fois ; `close()` puis `dropStreams()` → `onClose` jamais appelé.
  - Mot de passe faux : la promesse rejette avec `status` 401.
- [ ] **Step 2: Vérifier l'échec.** Run : `bun test tests/opencode-events.test.ts` ; Expected : FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier.** Run : `bun test tests/opencode-events.test.ts 2>&1 | tee /tmp/idnma-p5-t3.log && bun run typecheck` ; Expected : PASS.
- [ ] **Step 5: Commit** (`feat(opencode): lecture du flux d'événements du service`).

### Task 4: Livreur opencode, état et livraison

**Files:**
- Create : `src/opencode/courier.ts`, `tests/helpers/opencode-events.ts`.
- Test : `tests/opencode-courier.test.ts`.

**Interfaces:**
- Consumes : tâches 2 et 3 ; `sendAutoReply`, `withReplyHint`, `rejectQueuedMessages`, `CourierUnavailableError` (`src/understudy/courier.ts`) ; `MessageQueue.first/remove/unshift` ; `Registration.setStatus`. L'interface `Courier` ne change pas.
- Produces :
  - `interface OpencodeCourierOptions`, avec :
    - `name: string ; fromMode: FromMode ; registration: Registration ; queue: MessageQueue ; sessionID: string` ;
    - `service?: () => ServiceInfo | undefined` (défaut `readServiceInfo`, relu à chaque connexion) ;
    - `client?: (info: ServiceInfo) => OpencodeClient` ;
    - `openEvents?: typeof openEventStream` ;
    - `send?: typeof sendPeerMessage` ;
    - `retryDelayMs?: number` (2 000, réessai d'un `prompt` en échec) et `reconnectDelayMs?: number` (2 000).
  - `createOpencodeCourier(o: OpencodeCourierOptions): Courier`.
  - `beforeSpawn()`, dans l'ordre : service lu (absent → `CourierUnavailableError("service opencode injoignable")`) ; flux ouvert sur `COURIER_EVENT_TYPES` ; `activeSessions()` pour l'état initial ; `info()` journalisé (`opencode-info`, `version`) ; puis livraison de ce qui attend déjà en file. Tout échec devient `CourierUnavailableError`, et un flux déjà ouvert est refermé. Aucun environnement de session n'est posé : la TUI transmet le sien (spec §6, point 8).
  - `afterSpawn` sans effet, `read()` rend `null`, `hook()` rend `{}`, `verifyCaller()` rend `false`.
  - Spec §7.1 et §7.2, à appliquer à la lettre :
    - état `idle | busy | unknown` ;
    - propriétaire du tour donné par l'élément livré qui l'ouvre : élément reconnu comme de la doublure (ci-dessous) → pair, sinon Romain, même s'il porte un `metadata.idnma` étranger ; inconnu après resynchronisation → Romain ;
    - exception : exécution démarrée pendant qu'un élément `queue` de la doublure attend sa livraison → pair jusqu'au premier `inbox.delivered` ;
    - table de livraison et une seule requête `prompt` en vol ;
    - au plus un élément `queue` de la doublure en attente chez opencode.
    - `metadata: { idnma: { msgId, from } }` ;
    - corps : l'enveloppe reçue telle quelle, plus `withReplyHint` en `steer` ;
    - statut du registre en miroir de `execution.*` ;
    - journal `opencode-deliver` (`msgId`, `delivery`) à chaque prompt accepté.
  - Reconnaissance des éléments de la doublure : par `item.payload.metadata.idnma.msgId` de `session.inbox.enqueued` ou par l'`inboxID` de la réponse de `prompt`, le premier arrivé. Un `delivered` dont l'`inboxID` n'est connu d'aucune des deux voies est un élément de Romain.
  - Échec de `prompt` :
    - `SessionNotFoundError` : la doublure quitte le bus, comme le `leaveBus` de Codex. Elle appelle `rejectQueuedMessages` avec le libellé « opencode », se désinscrit, journalise `opencode-lost` puis ferme le flux ;
    - autre erreur (délai compris) : le message revient en tête de file et repart au prochain événement d'état, au prochain `onMessage`, ou par un minuteur à un coup de `retryDelayMs` ;
    - deuxième erreur sur le même message : `<nom> : message non livré (<message>)` à son expéditeur.
  - `session.inbox.cancelled` d'un élément de la doublure : place libérée, et `<nom> : message non livré (annulé dans opencode)`.
  - `session.execution.interrupted` avec un élément `queue` de la doublure non livré : `cancelInbox`, place libérée, et `<nom> : message non livré (tour interrompu)`.
  - `stop()` synchrone, idempotent : ferme le flux, annule les minuteurs, plus aucune requête ensuite.
  - `tests/helpers/opencode-events.ts` : constructeurs des événements à émettre par le faux service, sur la forme des captures (`api-queue-steer.events.jsonl`, `head-of-phase*.jsonl`) :
    - `enqueued(sessionID, inboxID, { metadata?, delivery })` ;
    - `delivered(sessionID, inboxID)` ;
    - `started(sessionID)` et `succeeded(sessionID)` ;
    - `failed(sessionID, message)` et `interrupted(sessionID)` ;
    - `cancelled(sessionID, inboxID)` ;
    - `textEnded(sessionID, text)` et `stepEnded(sessionID, finish)`.
    - Chacun rend l'enveloppe `{ id, type, data }` que `emit` écrit.
    - Forme de `inbox.cancelled` non capturée : `data: { sessionID, inboxID }`, sur le modèle de `inbox.delivered`, à vérifier en recette.

- [ ] **Step 1: Tests qui échouent** (faux service, `tests/helpers/fake-registration.ts`, `send` factice qui enregistre les renvois) :
  - `beforeSpawn` ouvre le flux avec les types attendus et ne fait aucune requête `PUT`. Sans fichier de service : `CourierUnavailableError`, et le faux ne reçoit aucune requête. Si `activeSessions` échoue : `CourierUnavailableError`, et `openStreams()` revient à 0.
  - Un message arrivé avant la fin de `beforeSpawn` part en `POST …/prompt` dès qu'elle finit, sans autre événement.
  - Au repos, un message `next` donne `POST …/prompt` avec `{ text: <contenu>, delivery: "queue", metadata: { idnma: { msgId, from } } }`. Un corps de 200 Kio qui contient `</cross-session-message>` arrive octet pour octet.
  - Deux messages au repos : le second `POST` ne part qu'après `session.execution.succeeded` du premier (AC-9).
  - L'`inbox.enqueued` de l'élément de la doublure est émis avant la réponse HTTP de `prompt` (le faux retarde sa réponse de 50 ms) : il est reconnu, et son tour est un tour de pair.
  - Exécution démarrée alors que l'élément `queue` de la doublure n'est pas encore livré : un `next` arrivé là attend la fin du tour, sans `steer`.
  - Tour de Romain (`enqueued` puis `started` puis `delivered` d'un élément sans `metadata`) :
    - `next` part en `delivery: "steer"` avec `text` égal à `withReplyHint(contenu)` ;
    - `later` attend `execution.succeeded`, puis part en `queue`.
  - Tour d'un pair : `next` attend la fin du tour ; `now` part en `steer` avec le rappel.
  - `execution.started` publie `busy`, `execution.succeeded` publie `idle`.
  - Flux coupé : aucun `POST …/prompt`.
  - `prompt` en 404 `SessionNotFoundError` avec deux messages en file : chaque expéditeur reçoit `[réponse automatique idnma]\n<nom> : message non livré (opencode a quitté le bus)`, l'inscription est retirée, et aucun `POST` ne suit (Review Focus 3).
  - `prompt` en 500 au repos, sans aucun événement émis ensuite : un second `POST` part après `retryDelayMs` (20 ms en test). Après une deuxième 500, l'expéditeur reçoit `<nom> : message non livré (<message>)`, et le message suivant part normalement.
  - `inbox.cancelled` de l'élément en attente : son expéditeur reçoit `message non livré (annulé dans opencode)`, et le message suivant part.
  - `execution.interrupted` alors que l'élément `queue` de la doublure n'a pas été livré : `DELETE /api/session/<id>/inbox/<inboxID>`, puis `message non livré (tour interrompu)`.
  - `stop()` : `openStreams()` passe à 0, et aucun `POST` ne suit un message reçu après l'arrêt.
- [ ] **Step 2: Vérifier l'échec.** Run : `bun test tests/opencode-courier.test.ts` ; Expected : FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier.** Run : `bun test 2>&1 | tee /tmp/idnma-p5-t4.log && bun run typecheck` ; Expected : PASS (suites Codex et à hooks comprises).
- [ ] **Step 5: Commit** (`feat(opencode): livreur et politique de livraison`).

### Task 5: Segments, renvoi automatique et reconnexion

**Files:**
- Modify : `src/opencode/courier.ts`.
- Create : `tests/fixtures/opencode-peer-turn.jsonl`, `tests/fixtures/opencode-execution-failed.json`.
- Test : `tests/opencode-courier.test.ts`.

**Interfaces:**
- Consumes : tâche 4.
- Produces : comportement seul (spec §7.3 et §7.4, à la lettre).
  - Segment de pair : ouvert au `inbox.delivered` d'un élément `queue` de la doublure. Fermé au `delivered` d'un élément de Romain ou d'un autre élément `queue` de la doublure, ou à la fin de l'exécution. Un `steer` de la doublure ne le ferme pas.
  - Renvois :
    - dernier `text.ended.data.text` ;
    - `<nom> : tour terminé sans réponse` ;
    - `<nom> : tour mêlé à une entrée de Romain, pas de réponse automatique` ;
    - `<nom> : tour en échec (<data.error.message>)` ;
    - `<nom> : tour interrompu` ;
    - `<nom> : réponse perdue (service opencode redémarré)`.
  - Renvoi automatique entrant (`isAutoReply(contenu)` vrai : la deuxième ligne de l'enveloppe est `AUTO_REPLY_MARKER`) : son segment ne renvoie rien. Journal `opencode-segment-end` (`msgId`, issue).
  - Reconnexion : `reconnectDelayMs` après `onClose`, une seule reconnexion. Elle relit `service()` toutes les 200 ms pendant 10 s au plus, jusqu'à un fichier lisible dont le flux s'ouvre. Puis elle relit `activeSessions()` et journalise `opencode-reconnect`. Au-delà : départ du bus comme à la tâche 4.
  - Fixtures, produites par commande :
    - `opencode-peer-turn.jsonl` : les lignes de `captures/api-queue-steer.events.jsonl` (champ `data`, enveloppe SSE complète) du `session.inbox.enqueued` de `m-1` au `session.execution.succeeded`, réduites à `{ type, data }`, une par ligne ;
    - `opencode-execution-failed.json` : le `session.execution.failed` de `captures/free-limit-failed.events.jsonl`, réduit de même ;
    - passage par le `sed` des contraintes globales.

- [ ] **Step 1: Tests qui échouent.**
  - `opencode-peer-turn.jsonl` rejouée, son `inboxID` rattaché au message envoyé : l'expéditeur reçoit `[réponse automatique idnma]\n<texte du dernier session.text.ended précédant le premier step.ended "stop">`. Le `steer` `m-3` capturé n'est pas un élément de cette doublure dans le test : c'est un élément de Romain livré après le `stop`, donc le renvoi porte le texte d'avant lui.
  - `opencode-execution-failed.json` : `<nom> : tour en échec (Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.)`.
  - `interrupted(sessionID)` : `<nom> : tour interrompu`. Fin sans `text.ended` : `<nom> : tour terminé sans réponse`.
  - Élément de Romain livré avant tout `step.ended` `stop` du segment : `tour mêlé…` (Review Focus 1). Livré après un `step.ended` `stop` : renvoi du dernier texte d'avant.
  - Pair A au repos, puis `now` de B livré en `steer` dans le segment de A : A reçoit le texte final, B ne reçoit aucun renvoi (Review Focus 2).
  - Enveloppe dont le corps commence par `AUTO_REPLY_MARKER` (`isAutoReply` vrai) : segment ouvert, rien n'est renvoyé à sa fin.
  - Redémarrage (Review Focus 4) :
    - un second faux service démarre sur un autre port avec un autre mot de passe ;
    - le fichier de service est réécrit vers lui ;
    - le premier faux est arrêté, puis seulement `dropStreams()`.
    - Un segment ouvert renvoie `réponse perdue (service opencode redémarré)`. Après `reconnectDelayMs` (10 ms en test), un nouveau message est livré au second faux, et le premier n'a reçu aucun `prompt` après la coupure.
  - Reconnexion impossible (fichier de service retiré, attente de 10 s réduite par injection) : les messages en file reçoivent `message non livré (opencode a quitté le bus)` et l'inscription est retirée.
- [ ] **Step 2: Vérifier l'échec.** Run : `bun test tests/opencode-courier.test.ts` ; Expected : FAIL sur les nouveaux tests.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier.** Run : `bun test tests/opencode-courier.test.ts 2>&1 | tee /tmp/idnma-p5-t5.log && bun run typecheck` ; Expected : PASS.
- [ ] **Step 5: Commit** (`feat(opencode): renvoi automatique par segment et reconnexion`).

### Task 6: `idnma run` sur un engine opencode

**Files:**
- Create : `src/run/opencode-argv.ts`.
- Modify : `src/run/run.ts`, `tests/fixtures/network.yml` (engines `bare: { harness: opencode }` et `server: { harness: opencode, model: opencode/big-pickle, options: [--server, http://127.0.0.1:1] }`).
- Test : `tests/run.test.ts`.

**Interfaces:**
- Consumes : tâches 1 à 5 ; `listModels(directory)` de la tâche 2.
- Produces :
  - `parseOpencodeArgv(argv: string[]): { rest: string[]; session?: string; resume: boolean; model?: string; directory?: string; refused?: string }`.
    - Flags à valeur : `-s`/`--session`, `--prompt`, `--server`, `--log-level`, `-m`/`--model`, en forme séparée, `=` ou collée pour les alias courts.
    - `-s`, `-c`, `-m` et `<directory>` sont retirés de `rest` ; `--standalone` ou `--server` donnent `refused`.
    - Le premier jeton qui n'est ni un flag ni la valeur d'un flag à valeur est `directory`.
  - `RunDeps` gagne `ensureOpencodeService: () => Promise<ServiceInfo | undefined>`, `opencodeClient: (info: ServiceInfo) => OpencodeClient` et `createOpencodeCourier: (o: OpencodeCourierOptions) => Courier` ; leurs faux vont dans `fakeDeps`.
  - Branche `opencode` de `runAgent`, dans l'ordre du spec §6, avec ces textes :
    - flag refusé tapé : `UsageError("<flag> fait démarrer opencode hors de son service partagé : idnma ne pourrait plus lui livrer les messages du bus.")` ;
    - flag refusé dans l'engine : `ConfigError("network.yml (agents.<a>.engines.<e>) : <flag> fait démarrer …")` ;
    - modèle sans forme : `UsageError("--model : « <m> » n'a pas la forme <fournisseur>/<modèle>.")` ;
    - modèle absent du service (`listModels(<dossier de travail>)`) : `UsageError("modèle inconnu du service opencode : <m>")` ;
    - `-s` dont la valeur ne commence pas par `ses` : `UsageError("-s : un id de session opencode commence par ses.")` ;
    - dossier : `UsageError("dossier introuvable : <chemin>")` ;
    - service injoignable : ligne stderr `idnma : service opencode injoignable. opencode démarre hors du bus (il ne recevra ni n'enverra de messages).`, puis `execve(binaire, argv)` sans inscription. `argv` est celui de `buildHarnessArgv`, dont seuls `-m`/`--model` et leur valeur sont retirés : `-s`, `-c` et `<directory>` restent tels que tapés ;
    - erreur du service sur la session : `ConfigError("opencode a refusé la session (<message>)")`, avant l'inscription ;
    - session retenue : journal `opencode-session` (`sessionID`, `origin` : `created`, `typed` ou `continued`).
  - `runUnderstudy` est appelé avec :
    - `argv` : `[binaire, ...]` où `...` est la sortie de `buildHarnessArgv` (sans son premier jeton), donc dédoublonnée contre les options de l'engine, dont on retire `-s`, `-c`, `-m` avec leurs valeurs et `<directory>`, puis on ajoute `-s <id>` ;
    - `exportControlEnv` laissé à son défaut (vrai) : la TUI reçoit `IDNMA_NAME`, `IDNMA_CONTROL_SOCKET`, `IDNMA_CONTROL_TOKEN` et les transmet à l'environnement de sa session (spec §6, point 8) ; sans `pty` ;
    - `harnessLabel: "opencode"` ;
    - un livreur `createOpencodeCourier({ …, sessionID: <id> })` ;
    - le dossier de travail comme `cwd` d'inscription.

- [ ] **Step 1: Tests qui échouent** (faux service de la tâche 2 derrière `ensureOpencodeService` et `opencodeClient` ; `runUnderstudy` factice qui enregistre ses options) :
  - Engine `default`, sans argument :
    - `POST /api/session` avec `{ location: { directory: <cwd> }, model: { providerID: "opencode", id: "big-pickle" } }` ;
    - `runUnderstudy` reçoit `argv` `["/fake/bin/opencode", "-s", <id>]`, aucune clé `exportControlEnv` à `false`, `harnessLabel: "opencode"` ;
    - le livreur a `sessionID` égal à l'id et `fromMode` `"prompting"`.
  - Engine `auto` : `fromMode` `"bypass"` et `--auto` une seule fois dans l'argv, même si `--auto` est aussi tapé.
  - `-s abc` : `UsageError` de forme, sans requête au faux.
  - `-m openrouter/particle-ai/particle-1#high` (modèle présent dans le faux `GET /api/model`) : retiré de l'argv, passé à la session comme `{ providerID: "openrouter", id: "particle-ai/particle-1", variant: "high" }` (Review Focus 5).
  - `-m opencode/nope` : `UsageError` au texte exact, aucun `POST /api/session`, aucune entrée de registre (AC-13). Puis `-m nope` : `UsageError` de forme.
  - `--standalone` tapé et `--server x` dans un engine de fixture : refus, et le faux service ne reçoit aucune requête (AC-8).
  - `-s ses_known` (le faux rend la session) : aucun `POST /api/session`, `argv` contient `-s ses_known`. Avec `-m` en plus : `POST /api/session/ses_known/model`. `-s ses_new` (404) : `POST /api/session` avec `id: "ses_new"`.
  - `-c` : `GET /api/session?directory=<cwd>&order=desc` rend `[{ id: "ses_child", parentID: "ses_a" }, { id: "ses_a" }]`, donc `argv` porte `-s ses_a` et pas `-c`. Liste vide : session neuve.
  - `--prompt "-s x" <dossier existant>` : `directory` est ce dossier, `-s x` reste valeur de `--prompt` dans `rest`, et l'inscription porte ce `cwd`. Dossier inexistant : `UsageError`.
  - `ensureOpencodeService` rend `undefined` : la ligne stderr exacte, puis `execve` avec `["opencode"]` et sans `-m`, et aucune entrée de registre.
  - `POST /api/session` en 500 : erreur qui contient `opencode a refusé la session`, aucune entrée de registre.
  - Engine sans `model` (fixture `bare: { harness: opencode }`) : le corps de création n'a pas de clé `model`.
- [ ] **Step 2: Vérifier l'échec.** Run : `bun test tests/run.test.ts` ; Expected : FAIL sur les nouveaux tests.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier.** Run : `bun test 2>&1 | tee /tmp/idnma-p5-t6.log && bun run typecheck` ; Expected : PASS.
- [ ] **Step 5: Commit** (`feat(run): idnma run lance opencode sur une session du service partagé`).

### Task 7: Installation, `peer list`, `read`, skills et README

**Files:**
- Modify : `src/cli.ts` (dont `INSTALL_HELP`, `UNINSTALL_HELP` et l'aide de `run`), `skills/generic-idnma-network/SKILL.md`, `skills/claude-idnma-network/SKILL.md`, `README.md`.
- Test : `tests/cli.test.ts`, `tests/understudy.test.ts` (test de `read`, qui demande une doublure vivante).

**Interfaces:**
- Consumes : `opencodeConfigDir()` (tâche 1), `installTeammateLine`/`uninstallTeammateLine`, `installSkill`/`uninstallSkill`.
- Produces :
  - `INSTALLERS.opencode`, avec ces sorties : `opencode : ligne coéquipier <installée dans|mise à jour dans|déjà à jour dans> <dir>/AGENTS.md ; skill generic-idnma-network <…> <dir>/skills` ; `opencode : absent (<dir>), rien installé` ; pour `uninstall`, `opencode : ligne coéquipier retirée de … ; skill generic-idnma-network retirée de …` et `opencode : absent (<dir>), rien retiré`, sur le modèle de Codex.
  - Aides : `INSTALL_HELP` et `UNINSTALL_HELP` décrivent ce qu'opencode reçoit (`AGENTS.md` et skill dans le dossier de config d'opencode) ; l'aide de `run` cite opencode, ses flags refusés (`--standalone`, `--server`) et le `-m` lu par idnma.
  - `peer list` : si `IDNMA_CONTROL_SOCKET` vaut `…/<pid>.sock`, l'entrée de ce pid est exclue.
  - `read` sans message, quand `CODEX_THREAD_ID` ou `OPENCODE_SESSION_ID` est présent : `idnma : chez Codex et opencode, les messages de pairs arrivent d'eux-mêmes, chacun comme un nouveau tour : idnma read n'a rien à rendre.`
  - Skills :
    - la description de `generic-idnma-network` commence par `Codex, Grok, agy, opencode (tout harnais sauf Claude Code).`, et son corps compte opencode parmi les agents ;
    - la description de `claude-idnma-network` nomme opencode parmi les harnais qu'elle ne couvre pas.
  - README : opencode dans les prérequis, `idnma install --agent opencode`, et un exemple d'engine `harness: opencode`.

- [ ] **Step 1: Tests qui échouent.**
  - Install :
    - avec `IDNMA_OPENCODE_CONFIG_DIR` sur un dossier qui contient un `AGENTS.md` de test, `main(["install", "--agent", "opencode"])` rend 0 et la ligne exacte ;
    - le fichier finit par le bloc coéquipier, et la skill installée est identique à `skills/generic-idnma-network/SKILL.md` ;
    - un second `install` rend `déjà à jour dans` deux fois ;
    - `uninstall` laisse `AGENTS.md` identique à l'octet près (`Buffer.equals`), et la skill a disparu (AC-1).
  - Dossier de config absent : `opencode : absent (<dir>), rien installé`, rien n'est créé.
  - `main(["install"])` : le message d'usage liste `agy, claude, codex, grok, opencode`.
  - `peer list` : avec deux faux pairs vivants et `IDNMA_CONTROL_SOCKET` sur `<ctl>/<pid du premier>.sock`, seul le second est listé (AC-6).
  - `read` lancé par une doublure vivante sans message, avec `OPENCODE_SESSION_ID=ses_x` dans l'environnement de la commande : le texte exact, dans `tests/understudy.test.ts`, à côté du test Codex (`tests/understudy.test.ts:274`), qui passe au même texte exact.
- [ ] **Step 2: Vérifier l'échec.** Run : `bun test tests/cli.test.ts` ; Expected : FAIL.
- [ ] **Step 3: Implémenter**, puis mettre à jour les deux skills et le README.
- [ ] **Step 4: Vérifier.**
  - Run : `bun test 2>&1 | tee /tmp/idnma-p5-t7.log && bun run typecheck && ls -d /tmp/idnma-t-* 2>/dev/null | wc -l`. Expected : PASS, 0 erreur de type, `0`.
  - Puis `RTK_DISABLED=1 command grep -c 'opencode' skills/generic-idnma-network/SKILL.md skills/claude-idnma-network/SKILL.md README.md`. Expected : au moins 1 par fichier.
- [ ] **Step 5: Commit** (`feat(install): idnma install --agent opencode, peer list et read pour opencode`).

### Task 8: Recette sur le vrai opencode

Chaque geste qui touche un fichier ou un service de Romain attend son accord explicite, demandé avant le geste : écrire dans `~/.config/opencode/` (install), ajouter l'agent à `~/.config/idema/network.yml`, redémarrer le service opencode. Les commandes partent du worktree (`bun /Users/recarnot/dev/erom-agence-network-p5/src/cli.ts …`), dans un tmux isolé (`tmux -L idnma-p5`) sauf l'étape IdemA. Un modèle couvert par l'abonnement de Romain (`ollama-cloud/deepseek-v4.1-flash`) sert aux tours ; Big Pickle sert à AC-7 quand son palier est épuisé.

- [ ] **Step 1: Installation (accord de Romain).** Copie de `~/.config/opencode/AGENTS.md`, puis `install --agent opencode`, `opencode api skill.list` filtré sur `generic-idnma-network`, puis `uninstall` et `cmp` avec la copie, puis `install` de nouveau (AC-1).
- [ ] **Step 2: Lancement et message au repos.** D'abord le mécanisme dont dépend AC-6 : dans l'agent lancé, `env | grep '^IDNMA_'` montre les trois variables du canal (la TUI recopie son environnement dans sa session, `probe-env-tui2.ts`). Puis `run opencode <autre dossier>` : la TUI ouvre la session de ce dossier (Ruling 24 révisé). Lancer `run opencode` dans un pane, vérifier `peer list` depuis un autre pane (AC-2). Puis un `SendMessage` d'une session Claude : capture du pane opencode et transcript du Claude (AC-3). Puis brouillon tapé par `send-keys -l` et nouveau message : brouillon intact (AC-4).
- [ ] **Step 3: Tours mêlés.** Un message pendant un tour lancé depuis la TUI (AC-5). Deux messages au repos (AC-9). Sur un long tour de pair, noter si opencode livre des éléments de boîte `compaction`, `synthetic` ou `move` : le livreur les compterait comme une entrée de Romain (« tour mêlé » à tort). Vérifier aussi la forme réelle de `session.inbox.cancelled` (annuler un élément depuis la TUI). Demander à opencode « qui est sur le réseau ? » puis « demande à <pair> … » (AC-6).
- [ ] **Step 4: Échecs.** Engine sur un modèle gratuit épuisé (AC-7), `-m opencode/modele-invente` (AC-13), `--standalone` (AC-8). Vérifier aussi que `--auto` approuve les permissions d'un tour ouvert par un pair (étiquette `bypass`, spec §11) et que `-c` rend la session du `-c` natif.
- [ ] **Step 5: Service et repos (accord de Romain pour le redémarrage).** `opencode service restart` au repos, puis un message (AC-11). Dix minutes sans message, journal et `ps -o %cpu` (AC-12). Puis fermeture du pane (AC-10).
- [ ] **Step 6: Note de recette.** `.claude/notes/2026-10-28-recette-phase5.md` : chaque AC avec la commande lancée et la sortie réelle ; un AC non tenu y est dit tel quel. Commit (`docs: recette de la phase 5 (opencode)`).
- [ ] **Step 7: Revue finale et fusion.** Revue de toute la branche (Opus, effort xhigh), puis, sur le feu vert de Romain, fusion en avance rapide sans changer la branche du checkout principal : `cd /Users/recarnot/dev/erom-agence-network && git fetch . feat/idnma-opencode:main`. Ensuite, sur un nouvel accord de Romain, ajout de l'agent `opencode` à `~/.config/idema/network.yml` et lancement depuis IdemA.
