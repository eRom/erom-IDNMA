# IdnmA phase 6 (doublure dst) : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un agent dont l'engine dit `harness: dst` est lancé par `idnma run`, reçoit les messages de pairs par un plugin Cordis chargé dans `dst` (`Agent.followup` / `Agent.steer`), renvoie à l'expéditeur la réponse finale d'un tour ouvert pour lui, écrit à ses pairs par `idnma peer send` (sandbox comprise), et s'installe par `idnma install --agent dst`.

**Architecture:** Doublure à pont plugin. La doublure (Bun) écoute un socket Unix privé ; le plugin (Node, dans le process de `dst`) s'y connecte, s'annonce par `hello` (jeton du pont), décide `followup` ou `steer` sur l'état vivant de l'agent du premier plan, et rapporte `delivered`, `claimed`, `result`, `dropped`. Le livreur côté doublure tient la file, les renvois automatiques, le statut du registre, les coupures et les adieux.

**Tech Stack:** Bun 1.4.0, TypeScript 7.0.2, `bun test`, `yaml` (déjà en dépendance). Le plugin : Node 24, modules `node:` seulement, TypeScript à syntaxe effaçable. Aucune dépendance nouvelle.

**Spec:** `docs/superpowers/specs/2026-10-29-idnma-dst-design.md` (§5 à §11, AC-1 à AC-11). Faits F1 à F23 : `.claude/notes/2026-10-28-etude-dst.md` ; captures brutes : `.claude/notes/probes/dsh/captures.md` ; plugin de sonde qui a marché : `.claude/notes/probes/dsh/idnma-dsh-probe.mjs` (forme exacte de `apply`, `ctx.on`, `ctx.effect`, `ctx.agents`, des messages et des événements).

## Global Constraints

- Identifiants, noms de fichiers, clés JSON, types de trame, événements de journal et titres de test en anglais ; commentaires, docstrings et messages pour Romain en français, sans tiret cadratin dans ce qu'un tiers lit (messages, aides, README).
- `src/dst/plugin.ts` et `src/dst/protocol.ts` tournent sous Node 24 : imports `node:` et `./protocol.ts` seulement (jamais `../log.ts`, jamais `bun:*`, jamais `Bun.*`), syntaxe effaçable (pas d'`enum`, pas de `namespace`, pas de propriétés de paramètre de constructeur, `import type` pour les types). Vérification : `node --experimental-strip-types -e "import('./src/dst/plugin.ts').then(m => console.log(typeof m.apply))"` doit afficher `function` (Node 24 l'accepte aussi sans le flag).
- Le plugin ne lève jamais vers dsh : chaque rappel (`ctx.on`, données du socket, minuteurs) est dans un `try/catch` qui envoie une trame `error`. **Tout socket du plugin porte un écouteur `error` posé avant toute autre opération** : un événement `error` sans écouteur fait planter toute la TUI de Romain (mesuré le 29/10 : `dsh-tui crashed: listen EINVAL` sur un chemin de socket trop long, puis l'invite du mode sans échec).
- Chemin d'un socket Unix : 104 octets au plus sous macOS. Les sockets de test vivent dans `/tmp/idnma-t-*/`, jamais dans un dossier long (scratchpad).
- Doublure : rien sur stdout ni stderr une fois `dst` lancé ; tout passe par `logEvent` (`src/log.ts`). Jamais de jeton ni de texte de message au journal (ids, modes, issues seulement).
- Écritures sur socket en `node:net` des deux côtés (`Bun.connect` tronque à 8 192 octets).
- Les tests ne lancent jamais le vrai `dst` ni `dsh` et ne touchent jamais `~/.dsh`, `~/.dsh-tui`, `~/.claude`, `~/.codex`, `~/.grok`, `~/.gemini`, `~/.config/opencode` : `IDNMA_DSH_HOME`, `IDNMA_CONFIG_DIR`, `IDNMA_CONTROL_DIR`, `IDNMA_CLAUDE_DIR`, `IDNMA_SOCKETS_DIR` redirigés ; le fichier `servers.json` du plugin est passé par `config.serversFile`.
- Dossiers de test : `mkdtempSync("/tmp/idnma-t-")`, retirés en `afterEach`. Après `bun test`, `ls -d /tmp/idnma-t-* 2>/dev/null | wc -l` rend 0.
- Aucun secret dans les tests : jetons non hexadécimaux (`bridge-token-test`), aucune chaîne de 32 caractères hexadécimaux.
- Interdits par nom : tests qui figent un compte ou un catalogue, tests qui lisent le code source. On teste un comportement : trames réellement écrites sur le socket, renvois réellement envoyés (`send` injecté), lignes réellement écrites au journal.
- Lire le code par le graphe, depuis la racine du worktree : `codegraph explore "<identifiants exacts>"` (exemple : `codegraph explore "runAgent buildHarnessArgv runUnderstudy Courier createOpencodeCourier"`).
- Travail dans le worktree `/Users/recarnot/dev/erom-agence-network-p6`, branche `feat/idnma-dst`. Le checkout principal reste sur `main` : les hooks Grok et agy installés exécutent son `src/cli.ts`.
- Chaque tâche finit par `bun test 2>&1 | tee /tmp/idnma-p6-tN.log` (N = numéro de tâche) et `bun run typecheck 2>&1 | tee -a /tmp/idnma-p6-tN.log`, suite verte et 0 erreur, puis un commit. Le rapport cite le fichier de log ; le contrôleur le relit.
- Commits : préfixe conventionnel (`feat(dst)`, `feat(install)`, `feat(run)`, `feat(cli)`, `test`, `docs`), sujet en français, terminés par les lignes d'attribution que la session d'exécution reçoit de son harnais.

## Review Focus

Grille du code creux, à passer sur chaque tâche : (1) export qui ne fait rien ; (2) bouche-trou ou suppression à la place d'un comportement (erreur avalée, contrôle désactivé) ; (3) texte, défaut ou constante sans ancre dans la spec ou une capture ; (4) test qui n'exerce pas le comportement (assertion sur un mock, sur le source, sur un compte) ; (5) branches moins profondes que la spec (chemin heureux seul) ; (6) état moins riche que la spec (transitions, persistance). En plus : aucune fuite de jeton ou de texte au journal ; le plugin reste importable par Node ; aucun test ne touche un vrai dossier de Romain.

---

### Task 1: Fondations (harnais, chemins, mode, protocole du pont)

**Files:**
- Modify: `src/config/network.ts` (`Harness` + `HARNESSES` : ajouter `"dst"`).
- Modify: `src/paths.ts` : `dshHome(env: Record<string, string | undefined> = process.env)` (`env.IDNMA_DSH_HOME`, sinon `env.DSH_HOME`, sinon `~/.dsh`) ; `dstBridgeSocketPath(pid = process.pid)` = `join(controlDir(), \`${pid}.dst.sock\`)`.
- Modify: `src/understudy/from-mode.ts` : `inferFromMode(harness, argv, env = {})` ; pour `dst`, `bypass` si `env.DSH_PERMISSION_MODE === "danger-full-access"`, sinon `prompting` ; les autres harnais inchangés (flag). Mettre à jour l'unique appelant (`src/run/run.ts`) sans changer son comportement pour les autres harnais.
- Modify: `src/run/run.ts` : `SHORT_ALIASES.dst = { "-c": "--continue", "-p": "--print" }` (requis par le type `Record<Harness, …>`), rien d'autre dans cette tâche.
- Create: `src/dst/protocol.ts` (Node-compatible) :
  - `export const BRIDGE_PROTOCOL_VERSION = 1;`, `export const MAX_FRAME_BYTES = 8 * 1024 * 1024;`
  - types : `DeliveryMode = "followup" | "steer"`, `DeliveryPriority = "now" | "next" | "later"`, `DeliverFrame`, `PluginFrame` (union des trames plugin → doublure de la spec §7.1 : `hello`, `state`, `delivered`, `claimed`, `result`, `dropped`, `error`), `CourierFrame` (`deliver`).
  - `encodeFrame(frame: object): string` (JSON + `"\n"`).
  - `createLineReader(onLine: (line: string) => void, onOverflow: () => void): (chunk: Buffer) => void` : accumule, coupe sur `\n`, décode en UTF-8 seulement des lignes entières (un caractère coupé entre deux paquets reste entier), appelle `onOverflow` au-delà de `MAX_FRAME_BYTES` sans ligne complète.
  - `parsePluginFrame(line: string): PluginFrame | undefined` et `parseCourierFrame(line: string): DeliverFrame | undefined` : validation des seuls champs utiles (types primitifs, valeurs d'énumération), **clés inconnues ignorées** (une trame plus riche qu'attendu passe), `undefined` pour une trame illisible ou dont un champ requis manque ou est mal typé. Champs exacts : spec §7.1 (`deliver` porte `hint?` et non `steerText` ; `result` porte `sources: string[]`, `mixed: boolean`, `error?: { message?: string; code?: string }` où le parseur ne garde que ces deux chaînes ; `error` porte `code: string`).
- Modify: `src/understudy/courier.ts` : exporter `replyHintFor(content: string): string | undefined` (la ligne `(idnma) Message reçu pendant ton tour : …` que `withReplyHint` ajoute aujourd'hui, `undefined` dans les cas où `withReplyHint` rend le contenu tel quel) et réécrire `withReplyHint` par-dessus, à comportement identique (ses tests existants restent verts).
- Test: `tests/dst-protocol.test.ts`, `tests/config.test.ts` (un engine `harness: dst` se charge), `tests/understudy-units.test.ts` ou nouveau test pour `inferFromMode`.

**Steps:**
- [ ] Tests d'abord : lecteur de lignes (deux trames dans un paquet, une trame en trois paquets, caractère multi-octet coupé, débordement), parsing (chaque trame valide, champ requis manquant ou mal typé refusé, type inconnu refusé, clé inconnue ignorée, `result.error` porteur d'autres champs réduit à `message`/`code`), `replyHintFor` (ligne rendue pour une enveloppe nommée, `undefined` pour un renvoi automatique et une enveloppe sans nom, `withReplyHint(c) === c + "\n" + replyHintFor(c)`), `inferFromMode("dst", [], { DSH_PERMISSION_MODE: "danger-full-access" })` → `bypass`, autre valeur ou absence → `prompting`, un flag Codex dans l'argv d'un dst ne compte pas ; `dshHome()` suit les trois sources ; `dstBridgeSocketPath(42)` est dans `controlDir()`.
- [ ] Implémenter, suite verte, typecheck, vérification Node du protocole (`node -e "import('./src/dst/protocol.ts').then(m => console.log(m.BRIDGE_PROTOCOL_VERSION))"` → `1`), commit `feat(dst): harnais dst, chemins et protocole du pont`.

---

### Task 2: Le plugin dans dst

**Files:**
- Create: `src/dst/plugin.ts` (Node-compatible ; imports : `node:net`, `node:fs`, `node:os`, `node:path`, `./protocol.ts`).
- Create: `tests/helpers/fake-dsh.ts` : faux `ctx` Cordis : `on(event, handler)` (rend un disposer), `emit(event, ...args)` pour les tests, `effect(fn)` (appelle `fn`, garde son disposer), `dispose()` (exécute les disposers d'effets et retire les écouteurs), `agents` (`roots()`, `get(id)`, `add(agent)`, `remove(id)`), `shellEnv` (`register(c)` qui garde le contributeur et rend un disposer). Faux agent : `{ id, status, session: { id, header: { id } }, inbox: { nextTurn: [], nextStep: [] }, followup(m), steer(m) }` qui enregistre les appels ; `followup`/`steer` peuvent être configurés pour lever.
- Create: `tests/dst-plugin.test.ts`.

**Interface:**
```ts
export const name = "idnma-bridge";
export const inject = ["agents", "shellEnv"];
export interface BridgePluginConfig {
  serversFile?: string;        // défaut ~/.dsh-tui/inject/servers.json
  env?: Record<string, string | undefined>; // défaut process.env
  pid?: number;                // défaut process.pid (entrée de servers.json et trame hello)
  refreshMs?: number;          // défaut 2000
  discardGraceMs?: number;     // défaut 1500
}
export function apply(ctx: unknown, config?: BridgePluginConfig): void;
```

**Comportement (spec §8, à suivre à la lettre) :**
- Sans `IDNMA_DST_BRIDGE` ou `IDNMA_DST_BRIDGE_TOKEN` dans `env` : rien (aucun écouteur, aucune connexion).
- `IDNMA_CONTROL_TOKEN` présent : `ctx.shellEnv.register({ name: "idnma", variables: { DSH_IDNMA_CONTROL_TOKEN: { description: "Jeton du canal de contrôle idnma (idnma peer send, idnma peer list)." } }, resolve: () => ({ DSH_IDNMA_CONTROL_TOKEN: token }) })`, dans un `try/catch` : s'il lève, `error { code: "register-failed" }` (envoyée dès la connexion) et le reste du plugin fonctionne.
- Dans `ctx.effect` : connexion `net.createConnection(IDNMA_DST_BRIDGE)`, **écouteur `error` posé dans la même instruction, avant tout le reste** ; à la connexion, `hello { type: "hello", v: BRIDGE_PROTOCOL_VERSION, token: IDNMA_DST_BRIDGE_TOKEN, pid, versions: { tui } }` (`tui` best effort : remonter depuis `process.argv[1]` jusqu'à un `package.json` nommé `@deepseek-harness-tui/dsh-tui`, sinon absent), puis la `state` courante. Minuteur de rafraîchissement (`refreshMs`, `unref`). Le disposer ferme la connexion et tous les minuteurs. Pas de reconnexion.
- Premier plan (spec §8.2, à la lettre) : entrée de `serversFile` (tableau JSON) dont `pid` vaut `pid` → **racine** de ce `sessionId` (`ctx.agents.get`, ou racine dont `id` ou `session.id` vaut ce `sessionId`) ; une lecture illisible garde la dernière valeur valide ; repli (fichier absent, sans entrée, `sessionId` sans racine vivante) : seule racine, sinon la dernière **racine** créée (ordre des `agent/created` vus, sous-agents exclus : un agent créé qui n'est pas dans `roots()` ne compte pas), sinon la dernière de `roots()`. Fichier relu au tick, sur `agent/created`, `agent/disposed`, `agent/status` et à chaque `deliver`, **jamais** sur `session/event`. Une `state { session: agent.id | null, status: "idle" | "running" }` part quand l'une des deux valeurs change, **et toujours** juste après un `dropped` `disposed` ou `no-agent`.
- `deliver` (spec §8.3) : message `{ id, role: "user", content: [{ type: "text", text: \`Team message from ${sender}:\` }, { type: "text", text }], source: { kind: "agent-message", form: "relay", senderSessionId: sender } }` ; choix du mode par la table de la spec sur l'agent du premier plan : `status === "idle"` → `followup` ; tour ouvert de propriétaire `peer` → `steer` pour `now`, `followup` sinon ; propriétaire `romain` ou `unknown` → `followup` pour `later`, `steer` sinon ; agent `running` sans tour ouvert → propriétaire de `inbox.nextTurn[0]` (`peer` si c'est un des nôtres, `romain` sinon), et `nextTurn` vide → `followup` quelle que soit la priorité. `steer` envoie `text + "\n" + hint` (ou `text` sans `hint`), `followup` envoie `text`. Puis `delivered { id, mode, session }`. Sans agent : `dropped { why: "no-agent" }`. Appel qui lève : `dropped { why: "rejected", error }`.
- Tours (spec §8.3 et §8.4) : `session/event` reçoit `(session, event)` ; `turn/start` ouvre le tour `event.data.turn` de `session.id` et **fixe son propriétaire par `inbox.nextTurn[0]` de la racine de cette session à cet instant** (un des nôtres → `peer`, un autre → `romain`, vide → `unknown`) ; un `followup` des nôtres réclamé au tour T confirme `peer`. `agent/inbox/claimed { agent, message, turn }` : un des nôtres → trame `claimed` ; un `followup` des nôtres ouvre le suivi `(agent.session.id, turn)` ; une **entrée de Romain** (source `kind` parmi `user`, `skill-invocation`, `dsh-tui-btw`, `dsh-tui-recap`) marque le tour, et son suivi (existant ou ouvert ensuite dans le même tour) est `mixed` ; tout message étranger réclamé ajoute son `source.kind` (chaîne, ou `"none"`) à l'ensemble `sources` du tour. `assistant/message` (`event.data.turn`, `event.data.message.content`, blocs `text` joints) : dernier texte non vide du tour suivi, après retrait d'une première ligne qui commence par `⏵` et des lignes vides qui suivent. `turn/end` (`event.data.turn`, `event.data.reason`) : `result { id, turn, reason: reason.kind, cause: reason.reason?.kind, mixed, sources, text, error }` où `error` = `{ message, code }` réduits aux chaînes présentes (champs absents omis), suivi fermé, tour fermé.
- Pertes : `agent/inbox/discarded` d'un des nôtres non réclamé → minuteur `discardGraceMs` ; `agent/disposed` du même agent avant l'échéance → `dropped disposed`, sinon `dropped discarded`. `agent/disposed` : nos messages non réclamés de cet agent → `dropped disposed` (minuteurs annulés) puis `state` ; suivi encore ouvert → `result { reason: "disposed", mixed, sources, text }`.
- Erreurs : chaque écouteur et chaque rappel dans `try/catch` ; une erreur envoie `error { code }` avec un code fixe (`listener-failed`, `bad-frame`, `register-failed`), **jamais** le message d'une exception (une erreur de `JSON.parse` cite l'entrée). Une trame reçue illisible : `error { code: "bad-frame" }`, rien d'autre.

**Steps:**
- [ ] Écrire `fake-dsh.ts` et les tests, contre un vrai serveur `node:net` de test qui joue la doublure (socket dans le dossier de test) :
  - inerte sans variables (aucune connexion reçue, aucun écouteur posé) ;
  - `hello` exact puis `state` ; `shellEnv` enregistré avec la bonne clé seulement quand `IDNMA_CONTROL_TOKEN` existe, `resolve()` rend le jeton ;
  - premier plan par `servers.json` (deux racines, l'entrée désigne la première), repli sans fichier (dernière créée), changement de premier plan → nouvelle `state` ;
  - table de choix complète : 3 priorités × (repos, tour de pair, tour de Romain, tour inconnu, entre deux tours avec `nextTurn[0]` à nous / pas à nous / vide) ; `steer` reçoit `text + "\n" + hint`, `followup` reçoit `text` ; message relay de la forme F8 (bloc `Team message from <sender>:`, source `agent-message`/`relay`) ;
  - propriétaire fixé au `turn/start` par `nextTurn[0]` : un steer des nôtres et un followup de Romain réclamés dans le même lot, dans les deux ordres, laissent le tour à Romain ; un steer de Romain et un followup des nôtres, dans les deux ordres, donnent un tour de pair `mixed` ;
  - entrées de Romain : `skill-invocation` mêle le tour comme `user` ; un `runtime-context` ou `skill-catalog` réclamé dans le tour ne le mêle pas et apparaît dans `sources` ;
  - repli de premier plan : un sous-agent créé après les racines n'est jamais choisi ; `servers.json` illisible après une lecture valide garde le premier plan ;
  - `dropped disposed` et `no-agent` sont toujours suivis d'une `state` (même inchangée) ;
  - un écouteur `agent/created` ne lève jamais (événement mal formé → `error { code }`) ; `shellEnv.register` qui lève → `error { code: "register-failed" }` et le pont marche ;
  - séquence F6 rejouée depuis `captures.md` (run 2, followup au repos) : `turn/start` → `claimed` → `assistant/message` (`⏵ Answering the team message\n\nParis`) → `turn/end completed` donne `result { reason: "completed", text: "Paris", mixed: false }` ;
  - séquence F7 (steer puis followup pendant un tour de Romain, tours 4 et 5) : `claimed` du steer au tour 4 sans `result`, `result` du followup au tour 5 seulement ;
  - `turn/end` `error` (run 4 : `{ kind: "error", error: { message: "DeepSeek Messages transport failed", code: "TRANSPORT" } }`) et `aborted` `{ reason: { kind: "user" } }` rapportés tels quels ;
  - tour mêlé : un message `user` réclamé dans le tour d'un de nos followups → `mixed: true` ;
  - `discarded` sans `disposed` → `dropped discarded` après le délai ; `discarded` puis `disposed` → `dropped disposed` ; `disposed` avec un followup en boîte → `dropped disposed` ; `disposed` avec un tour suivi ouvert → `result disposed` ;
  - `followup` qui lève → `dropped rejected` ; aucune exception ne sort d'un rappel (un événement mal formé envoie `error { code }`, sans texte) ; une trame `deliver` illisible → `error { code: "bad-frame" }` ;
  - `ctx.dispose()` ferme la connexion et coupe le minuteur (le serveur de test voit la fermeture).
- [ ] Implémenter, suite verte, typecheck, vérification Node (`node -e "import('./src/dst/plugin.ts').then(m => console.log(typeof m.apply, m.inject.join(',')))"` → `function agents,shellEnv`), commit `feat(dst): plugin idnma pour dst (pont, premier plan, livraison, tours)`.

---

### Task 3: Le livreur côté doublure

**Files:**
- Create: `src/dst/courier.ts`.
- Modify: `src/understudy/courier.ts` : exporter `senderNameOf(content: string): string | undefined` (le `from-name` de l'enveloppe, s'il a la forme d'un nom de pair ; réutilise `FROM_NAME` et `PEER_NAME` déjà présents), et ajouter `farewell?(): Promise<void>` à l'interface `Courier` (documenté ; personne ne l'appelle encore, Task 4 le fera).
- Create: `tests/helpers/fake-dst-plugin.ts` : client `node:net` qui joue le plugin (`hello`, `state`, trames arbitraires, lecture des `deliver` reçus, fermeture).
- Create: `tests/dst-courier.test.ts`.

**Interface:**
```ts
export interface DstCourierOptions {
  name: string;
  fromMode: FromMode;
  registration: Registration;
  queue: MessageQueue;
  socketPath: string;
  token: string;
  send?: typeof sendPeerMessage;
  /** Admission par pid noyau ; défaut : pid connu et descendant de ce process (`isDescendantOf`). */
  isAllowedPeer?: (pid: number | undefined) => boolean;
  admissionTimeoutMs?: number; // 5_000
  helloTimeoutMs?: number;     // 30_000, armé par afterSpawn
  graceMs?: number;            // 30_000
  maxAttempts?: number;        // 3
}
export function createDstCourier(o: DstCourierOptions): Courier;
```

**Comportement :** spec §7.2 (admission), §9.1 à §9.6, textes exacts du tableau §9.2 et de §9.4/§9.5 (un seul jeu de textes pour une coupure et une sortie : pas de délai `lossSettleMs`). Phases `waiting`, `up`, `down`, `gone`, `closed`. Serveur du pont comme `startControlServer` (dossier privé `ensureControlDir`, `umask 077` pendant `listen`, `chmod 600`, reste retiré avant l'écoute, écouteurs `error` sur le serveur et chaque connexion). `deliver { type: "deliver", id: randomUUID(), priority: message.priority, sender: senderNameOf(content) ?? "idnma", text: content, hint: replyHintFor(content) }` (`hint` omis s'il est `undefined`). La file est vidée vers le plugin à **chaque** `state` reçue de session non nulle, changée ou non, et à chaque message arrivé. Un nouveau `hello` admis remet le miroir à `{ session: null, status: "idle" }`. Une trame illisible : `dst-frame-invalid { length }`, jamais son contenu. `muted` = `isAutoReply(content)`. `read()` → `null`, `hook()` → `{}`, `verifyCaller()` → `false`. `farewell()` passe en phase `closed` : tout message arrivé ensuite (`onMessage`) est refusé tout de suite.

**Steps:**
- [ ] Tests d'abord (faux plugin sur un vrai socket, `send` injecté qui enregistre `{ to, body }`, journal relu) :
  - admission : bon `hello` → `dst-bridge-up` ; mauvais jeton, mauvaise version, première trame autre que `hello`, pas de trame sous `admissionTimeoutMs`, `isAllowedPeer` faux → `dst-bridge-refused` et connexion fermée, aucun `deliver` reçu ;
  - file retenue tant qu'aucune `state` de session non nulle, puis tout part en `deliver` (forme exacte, `hint` = `replyHintFor`, absent pour un renvoi automatique) ;
  - `delivered` → `dst-deliver { msgId, delivery }` ; `claimed` d'un `steer` → réglé sans renvoi ;
  - chaque ligne du tableau §9.2 : `result` → texte renvoyé exact et `dst-turn-end { outcome, sources }` ; message ouvrant déjà renvoi automatique → aucun renvoi, `outcome: "muted"` ; `result` dont `error` porte des clés inconnues → traité quand même ;
  - `dropped disposed` puis une `state` **de même session et même statut** que la précédente → relivré (le test n'envoie aucune autre trame) ; troisième échec → « non livré (dst ne l'a pas pris) » ; `dropped discarded` / `rejected` → textes exacts ;
  - statut : `running` → `busy`, `idle` → `idle`, seulement au changement ; `dst-foreground` au changement de session ;
  - coupure : envoi réclamé → « réponse perdue (dst arrêté ou relancé) », non réclamé → « message non livré (dst arrêté ou relancé) », tout de suite ; file gardée puis livrée si un nouveau `hello` puis une `state` arrivent dans `graceMs` ; au-delà, `dst-bridge-gone`, refusée « non livré (pont dst perdu) », et un message arrivé ensuite est refusé tout de suite ; un `hello` tardif rétablit la livraison ;
  - aucun `hello` dans `helloTimeoutMs` après `afterSpawn` → `dst-bridge-missing`, file refusée « le plugin idnma ne s'est pas chargé dans dst » ; si un `hello` a été refusé entre-temps → « pont dst refusé, voir le journal idnma » ;
  - un second `hello` admis remplace le premier (l'ancienne connexion est fermée, ses envois traités comme une coupure, miroir remis à zéro) ;
  - trame illisible → `dst-frame-invalid { length }`, sans le contenu (vérifié sur la ligne de journal) ;
  - `stop()` retire le socket, idempotent ; `farewell()` après `stop()` : envois en vol avec les textes de coupure, file « non livré (dst a quitté le bus) » ; un message arrivé après `farewell()` est refusé tout de suite avec ce même texte ;
  - `senderNameOf` : nom lu, enveloppe sans nom ou nom hors forme → `undefined`.
- [ ] Implémenter, suite verte, typecheck, commit `feat(dst): livreur dst (pont, admission, renvois, coupures, adieux)`.

---

### Task 4: Adieux à la sortie de la doublure

**Files:**
- Modify: `src/understudy/understudy.ts` : nouvelle option `farewellWaitMs?: number` (défaut 3 000) ; après `Promise.race([exited, signalExit])` (fin de l'enfant ou signal), attendre `waitBounded(courierFarewell, farewellWaitMs)`, où `courierFarewell` = `activeCourier?.farewell?.()` (rejet journalisé `farewell-error`, jamais remonté), puis rendre le code. Rien ne change pour un livreur sans `farewell`, ni pour le cas « signal pendant l'attente du canal ».
- Test: `tests/understudy.test.ts` (ou `understudy-units.test.ts`, selon le motif local).

**Steps:**
- [ ] Tests : un livreur factice avec `farewell` est appelé une fois à la fin normale de l'enfant et après SIGTERM, son travail est attendu (un envoi lent de 100 ms est vu terminé avant le retour) ; un `farewell` qui ne finit jamais est abandonné au bout de `farewellWaitMs` (50 ms dans le test) ; un `farewell` qui rejette ne change pas le code de sortie ; un livreur sans `farewell` garde le comportement actuel.
- [ ] Implémenter, suite verte, typecheck, commit `feat(understudy): adieux du livreur à la sortie`.

---

### Task 5: Installation (`idnma install --agent dst`)

**Files:**
- Create: `src/install/dst.ts`.
- Modify: `src/cli.ts` : `INSTALLERS.dst` (lignes de sortie dans le style des autres : « dst : plugin, ligne coéquipier et skill installés dans <home> », absent, à jour, retirés), aides `INSTALL_HELP` et `UNINSTALL_HELP` (ligne dst, et la phrase « Aucun fichier de Romain n'est modifié hors… » corrigée pour nommer aussi `AGENTS.md` et `cordis.patch.yml` de dst).
- Test: `tests/install-dst.test.ts` ; ajouter dst aux tests CLI d'installation existants si `tests/install-teammate.test.ts` les regroupe (lanceur à environnement redirigé, `IDNMA_DSH_HOME`).

**Interface:**
```ts
export const DST_PATCH_START = "# >>> idnma";            // préfixe de la ligne de début
export const DST_PATCH_END = "# <<< idnma";
export function dstPluginPath(): string;                  // chemin réel de src/dst/plugin.ts de ce checkout
export function installDstPatch(path: string, pluginPath?: string): "installed" | "updated" | "unchanged";
export function uninstallDstPatch(path: string): "removed" | "absent";
export type DstPluginState = { kind: "installed" } | { kind: "absent" } | { kind: "other-checkout"; path: string };
export function dstPluginState(home?: string, pluginPath?: string): DstPluginState; // home défaut : dshHome()
export function installDst(): "installed" | "updated" | "unchanged" | "absent";
export function uninstallDst(): "removed" | "absent";
```

**Comportement :** spec §11, à la lettre. Ligne de début exacte : `# >>> idnma<variante> (ne pas éditer : idnma uninstall --agent dst le retire)`, où `<variante>` vaut `""`, `" eol-added"`, `" created"` ou `" empty-list:<base64>"`. Corps exact :
```
- insert:
    - id: idnma-bridge
      name: ${JSON.stringify(pluginPath)}
      disabled: !!js '!process.env.IDNMA_DST_BRIDGE'
```
(gabarit littéral : `${JSON.stringify(pluginPath)}` produit lui-même les guillemets doubles, une seule paire ; le texte du bloc passe par la même conversion UTF-8 → latin1 que `toRaw` de `src/install/teammate.ts`, pour qu'un chemin non ASCII reste juste.) Détection du cas `[]` : une seule ligne non vide et non commentaire, de forme `/^\s*\[\s*\]\s*(#.*)?$/`. Relecture YAML avant écriture (`parseDocument` avec une balise personnalisée `tag:yaml.org,2002:js` qui rend la chaîne) : séquence attendue contenant `insert[0].id === "idnma-bridge"`, sinon `ConfigError` (« forme inattendue, ajoute le bloc à la main »). Marqueurs incohérents (deux débuts, fin sans début) : `ConfigError` sans écrire. Latin1, écriture atomique (temporaire + renommage, lien symbolique suivi), mode gardé (fichier créé : 0644). `installDst`/`uninstallDst` : patch, puis `installTeammateLine(<home>/AGENTS.md)`, puis `installSkill(<home>/skills, GENERIC_SKILL)` (et l'inverse). `dstPluginState` lit le bloc et compare le `name:` au chemin du plugin de ce checkout.

**Steps:**
- [ ] Tests d'abord : fichier absent (créé, puis retiré) ; patch de profil livré par dsh (trois lignes de commentaires + `[]`, copiées de `~/.dsh/profiles/dsh-tui/cordis.patch.yml` dans une fixture `tests/fixtures/dsh-profile-patch.yml` créée par `cp`) → bloc à la place de `[]`, commentaires gardés, désinstallation octet pour octet ; liste non vide finie par `\n` et sans `\n` final ; mise à jour du chemin (`updated`, ligne de début gardée) ; idempotence (`unchanged`) ; forme refusée (séquence en flux non vide, objet, YAML invalide) sans écriture ; marqueurs incohérents refusés ; contenu après le bloc gardé à l'install et à la désinstallation ; le YAML produit se relit en séquence avec `disabled` porteur de la balise `!!js` ; `dstPluginState` : absent, installé, autre checkout ; `idnma install --agent dst` puis `uninstall` par la CLI avec `IDNMA_DSH_HOME` redirigé (dossier absent → « absent, rien installé » ; présent → trois fichiers posés puis retirés, dossier `skills/` vide retiré).
- [ ] Implémenter, suite verte, typecheck, commit `feat(install): idnma install --agent dst (patch home, coéquipier, skill)`.

---

### Task 6: `idnma run` sur un engine dst

**Files:**
- Create: `src/run/dst-argv.ts` : `DST_SUBCOMMANDS` (liste exacte de la spec §6.1 : `run`, `cli`, `dsh`, `update`, `migrate`, `doctor`, `safe`, `version`, `help`, `session`, `models`, `skills`, `mcp`, `auth`, `capabilities`), `dstRefusal(argv: string[]): string | undefined` (spec §6.1 : sous-commande en premier positionnel, `-p`, `--print`, `-v`, `--version`, `-h`, `--help`, `--backend` ≠ `dsh` collé ou non, `--profile`, `--from-default-profile` ; les valeurs de `--backend`, `--patch` et l'id optionnel de `--resume` ne comptent pas comme positionnel), `withDshBackend(argv: string[]): string[]` (préfixe `--backend dsh` sauf si un `--backend` est déjà là), `dstWorkingDirectory(argv: string[]): string` (premier positionnel qui est un dossier existant, résolu, sinon `process.cwd()`).
- Modify: `src/run/run.ts` :
  - refus avant tout effet, à côté de ceux de Codex et d'opencode : `model:` (texte exact de la spec §5) et options de l'engine → `ConfigError` qui nomme l'engine ; ligne tapée → `UsageError` ; `DSH_TUI_BACKEND` n'est pas contrôlé (spec §6.1) ;
  - `RunDeps` : `createDstCourier: (o: DstCourierOptions) => Courier` et `dstPluginState: (home: string) => DstPluginState` (défaut réel : `dstPluginState(home)`), appelé avec `dshHome(childEnv)` où `childEnv` = `process.env` + `env:` de l'engine (un engine qui fixe `DSH_HOME` déplace le dossier que dst lira) ; plugin absent ou autre checkout → `ConfigError` (textes de la spec §6.2), toujours avant le pane et le nom ;
  - `buildHarnessArgv` : pas de `--model` injecté pour dst ;
  - argv de l'enfant : `withDshBackend(childArgv)` ; `workingDirectory` : `dstWorkingDirectory` ;
  - env de l'enfant : spec §6.4 (`DSH_TUI_NO_LAUNCHPAD=1` avant l'`env:` de l'engine ; `IDNMA_DST_BRIDGE` = `dstBridgeSocketPath()` et `IDNMA_DST_BRIDGE_TOKEN` = `randomBytes(16).toString("hex")` seulement si l'inscription a réussi) ;
  - `fromMode` : `inferFromMode(harness, childArgv, childEnv)` ;
  - livreur `createDstCourier({ name, fromMode, registration, queue, socketPath, token })` si inscrit ; `harnessLabel: "dst"` ; ni PTY, canal de contrôle exporté (défaut).
- Modify: `tests/fixtures/network.yml` : un agent `dst` (engine `default` nu, engine `full` avec `DSH_PERMISSION_MODE: danger-full-access`, engines de refus `withmodel`, `badbackend` (options `--backend codex`), et `otherhome` (env `DSH_HOME: /tmp/idnma-t-dsthome-from-engine`) pour vérifier que `dstPluginState` reçoit ce dossier).
- Modify: `tests/run.test.ts` : `fakeDeps` gagne `createDstCourier` (livreur compteur) et `dstPluginState: () => ({ kind: "installed" })`.

**Steps:**
- [ ] Tests d'abord : chaque refus de AC-10 (`--backend codex`, `--backend=codex`, `-p x`, `--print`, `--help`, `update`, `doctor`, `mcp`, `--profile x`, engine `withmodel`, `badbackend`, plugin absent, autre checkout) rend l'erreur attendue avec un message qui nomme la cause, et ni `runUnderstudy`, ni `execve`, ni `tagPane`, ni nom tiré (aucune entrée dans le dossier du registre) ; un dossier en positionnel et `--resume abc` passent ; argv `[binaire, "--backend", "dsh", ...]` et pas de doublon si `--backend dsh` tapé ; env : `DSH_TUI_NO_LAUNCHPAD=1`, valeur de l'engine prioritaire, variables du pont présentes et socket dans `controlDir()` ; `fromMode` `bypass` avec l'engine `full`, `prompting` avec `default` ; le livreur reçoit le même jeton et le même chemin que l'env ; `harnessLabel` « dst » ; engine `otherhome` : `dstPluginState` appelé avec son `DSH_HOME`.
- [ ] Implémenter, suite verte, typecheck, commit `feat(run): idnma run dst (refus, --backend dsh, pont, livreur)`.

---

### Task 7: CLI côté agent (op `list`, jeton dsh, `read`, aides)

**Files:**
- Modify: `src/understudy/control.ts` : `ControlCall` gagne `{ op: "list" }` (accepté par `asControlRequest`, voie du jeton et voie Codex) ; `ControlResponse` gagne `{ ok: true; peers: PeerSummary[] }` ; `controlRequest` lit le jeton dans `IDNMA_CONTROL_TOKEN`, sinon `DSH_IDNMA_CONTROL_TOKEN` ; socket présent sans aucun jeton → `PeerError` « idnma : canal de contrôle sans jeton (IDNMA_CONTROL_TOKEN ou DSH_IDNMA_CONTROL_TOKEN absent) », testé avant le cas Claude (`IDNMA_NAME`).
- Create or modify: `src/bus/peers.ts` (ou `src/bus/registry.ts`, selon ce qui se lit le mieux) : `PeerSummary { name, status, tmux }`, `reachablePeers(exclude: (entry: SessionEntry) => boolean): SessionEntry[]` (entrées vivantes avec `messagingSocketPath`, hors `exclude`, triées par nom) — extraite de `peerList` sans changer son filtre.
- Modify: `src/understudy/understudy.ts` : l'op `list` rend `reachablePeers((entry) => entry.pid === process.pid)` réduit à `PeerSummary`.
- Modify: `src/cli.ts` : `peerList` devient asynchrone ; avec un canal (socket et jeton, l'un ou l'autre nom, ou `CODEX_THREAD_ID` conforme), op `list`, et en cas d'échec (réponse `ok: false`, réponse sans `peers`, exception) la lecture locale actuelle ; formatage commun (largeurs, homonymes). `read` : `DSH_IDNMA_CONTROL_TOKEN` présent compte comme un harnais à tours poussés ; texte « chez Codex, opencode et dst… ». Messages et aides qui énumèrent les harnais (`CLAUDE_HAS_NO_UNDERSTUDY`, `runHelp` : ligne sur les refus de dst et sur le modèle choisi par `/model`, `NO_PENDING_PUSHED_TURNS`) : dst ajouté.
- Test: `tests/cli.test.ts`, `tests/understudy.test.ts` (op `list` contre une vraie doublure de test ou le canal de contrôle de test, selon le motif local).

**Steps:**
- [ ] Tests d'abord : l'op `list` exclut la doublure elle-même et garde les autres pairs joignables, triés ; voie Codex admise pour `list`, `hook` toujours réservé au jeton ; `controlRequest` avec seulement `DSH_IDNMA_CONTROL_TOKEN` atteint la doublure ; socket sans jeton (avec `IDNMA_NAME`) → le message « canal de contrôle sans jeton », pas celui du Claude ; `idnma peer list` avec canal passe par l'op (une doublure de test rend un pair que la lecture locale ne verrait pas : le prouver par la sortie) ; avec une doublure qui répond `ok: false`, repli local ; sans canal, lecture locale inchangée (tests existants verts) ; `idnma read` avec `DSH_IDNMA_CONTROL_TOKEN` et sans message : le texte des tours poussés.
- [ ] Implémenter, suite verte, typecheck, commit `feat(cli): op list servie par la doublure, jeton dsh, read et aides pour dst`.

---

### Task 8: Skill, README, design, exemple

**Files:**
- Modify: `skills/generic-idnma-network/SKILL.md` : description et corps nomment dst parmi les harnais (mêmes commandes) ; rien de recopié des aides.
- Modify: `README.md` : tableaux des harnais et de l'installation, ligne `install --agent dst`, prérequis (dst lié par `bun link` ou installé globalement, `/setup` terminé une fois, mode de permission par engine), limites (sandbox, `/kernel`, mémoire). Sans tiret cadratin.
- Modify: `docs/superpowers/specs/2026-10-26-idnma-design.md` §11 : phase 6, doublure dst, renvoi vers la spec du 29/10.
- Modify: `docs/superpowers/specs/network.example.yml` : agent `dst` (engines `default` et `full`).
- Test: aucun nouveau ; `tests/install-skill.test.ts` reste vert.

**Steps:**
- [ ] Rédiger, `rtk proxy grep -n '—' README.md skills/generic-idnma-network/SKILL.md` → rien, suite verte, commit `docs: dst dans la skill, le README, le design et l'exemple`.

---

### Task 9: Recette sur le vrai dst (contrôleur)

Hors subagent. Pré-recette dans un tmux privé (`tmux -L idnma-p6`) avec un `network.yml` temporaire (`IDNMA_CONFIG_DIR`) et un `DSH_HOME` temporaire qui relie par liens symboliques chaque entrée de `~/.dsh` (`profiles`, `sessions`, `storages`, `.credentials.yaml`, `.anonymous-user-id`, `settings.yaml.imported`) sauf `cordis.patch.yml`, `AGENTS.md` et `skills` (le patch « home », l'AGENTS.md et la skill de recette n'y touchent pas ; route `--backend dsh` et patch de ce dossier temporaire vérifiés par sonde le 29/10). AC-8 : un Échap simple garde nos messages en file (`keepInbox`) ; la recette vérifie l'interruption du tour de pair et le traitement du message suivant, et tente l'écart par Échap avec une saisie de Romain en attente. Puis AC-1 sur le vrai `~/.dsh` (copie avant, `cmp` après), fusion, réinstallation depuis le checkout principal. Chaque AC marqué avec la commande lancée et sa sortie réelle dans `.claude/notes/2026-10-29-recette-phase6.md`.
