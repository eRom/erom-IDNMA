# IdnmA phase 3 : doublures Grok et agy - plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grok et agy entrent dans le bus de pairs de Claude Code par une doublure sous PTY : livraison par leurs hooks en plein tour, sonnette `📨 idnma read` au repos, renvoi automatique de la réponse, installation réversible par `idnma install`.

**Architecture:** La doublure lance Grok ou agy dans un PTY qu'elle relaie (`src/understudy/pty.ts`) et voit chaque frappe de Romain. Les hooks des harnais appellent `idnma hook <grok|agy> <événement>`, qui passe par le canal de contrôle de la doublure (nouvelle op `hook`) et rend `{}` sans doublure. Un livreur commun aux deux harnais (`src/hooked/courier.ts`) tient l'état (repos, occupé, inconnu), livre en plein tour, sonne au repos et renvoie la réponse ; deux adaptateurs (`src/hooked/grok.ts`, `src/hooked/agy.ts`) traduisent les événements et les réponses de chaque harnais.

**Tech Stack:** Bun 1.4.0 (`Bun.Terminal`, `Bun.TOML`), TypeScript 7, `bun:test`. Aucune dépendance nouvelle.

**Spec:** `docs/superpowers/specs/2026-10-26-idnma-design.md` (§7.1, §7.4 à §7.6, §8, §9, AC-5 à AC-8, AC-12, AC-13, AC-15, AC-17 à AC-19). Faits mesurés et décisions de Romain : `.claude/notes/2026-10-27-entree-phase3.md`. Hors de ce plan : la bascule d'IdemA (§12, AC-16), plan séparé après la recette.

## Global Constraints

- Identifiants, clés, événements de journal et titres de tests en anglais ; commentaires, docstrings et messages pour Romain en français ; messages d'erreur préfixés `idnma : `.
- Une fois le harnais lancé, jamais rien sur stdout ni stderr de la doublure : tout va au journal par `logEvent("<domaine>-<événement>", { … })`.
- Écritures sur socket par `node:net`, jamais `Bun.connect`.
- Ligne de sonnette exacte : `📨 idnma read` ; écrite dans le PTY en une seule écriture `📨 idnma read\r` (octets `f09f93a82069646e6d6120726561640d`). Jamais de nom ni de contenu de pair dans ce que la doublure tape.
- Hooks : transport par commande uniquement ; `idnma hook …` rend un objet JSON sur une ligne et le code 0 en toutes circonstances, `{}` sans doublure.
- agy : jamais de hook `PreToolUse` (un `{}` y bloque l'outil, `allow` approuverait d'office).
- Grok : jamais de route daemon ni de mode leader (`GROK_AGENT_HOST_BACKEND`, `--leader`, `[cli] use_leader = true`).
- Aucune écriture dans un fichier de Romain : `~/.grok/config.toml`, `~/.gemini/config/hooks.json` et `~/.gemini/GEMINI.md` ne sont jamais ouverts en écriture. Fichiers à nous : `~/.grok/hooks/idnma.json`, `~/.grok/rules/idnma-teammate.md`, plugin agy `idnma` (posé et retiré par la CLI `agy`).
- Un tour ouvert par la sonnette reçoit un seul message, quel que soit le canal (décision de Romain du 27/10).
- Tests : `bun test`, dossiers temporaires `mkdtempSync("/tmp/idnma-t-")` nettoyés en `afterEach` ; `ls -d /tmp/idnma-t-* 2>/dev/null | wc -l` rend 0 après la suite. Tout nouveau fichier de test redirige `IDNMA_CONFIG_DIR` (journal) vers un dossier temporaire ; un test qui passe par `idnma install` redirige aussi `CODEX_HOME`, `GROK_HOME`, `IDNMA_AGY_PLUGINS_DIR` et `IDNMA_AGY_BIN` (jamais les vrais `~/.grok`, `~/.gemini` ni le vrai `agy`). Aucun test ne lance le vrai `grok`, `agy` ni `codex` (faux binaires ou exécuteurs injectés) ; seules les tâches 1, 2 (étape de sonde), 10 (`agy plugin validate`, sans modèle) et 11 touchent les vrais harnais.
- Chaque exécution de tests citée dans un rapport passe par `tee` vers un fichier nommé dans le rapport.
- Versions mesurées le 27/10 : Claude Code 2.1.311, Grok 1.0.70, agy 1.4.7, Codex 0.164.0.

## Review Focus

1. **Octets qui ne sont pas des frappes** : réponses du terminal (DA, CPR, OSC), événements de focus et de molette arrivent sur stdin de la doublure. Comptés comme une frappe, ils bloqueraient la sonnette pour toujours. À l'inverse, un Entrée encodé en CSI u (`\x1b[13u`) doit compter comme Entrée. Tests à la tâche 5.
2. **Message plus long que le plafond d'un hook** : Grok coupe `additionalContext` et la raison d'un `Stop` à 10 000 caractères. Un message qui dépasse ne passe jamais par un hook : il attend la sonnette (Grok le lit en entier par `idnma read`). Test à la tâche 6.
3. **Transcript d'agy en retard sur son `Stop`** : ne jamais renvoyer la réponse d'un tour précédent. La réponse est le dernier `PLANNER_RESPONSE` non vide après le dernier `USER_INPUT` de source `USER_EXPLICIT` ; sinon « tour terminé sans réponse ». Test à la tâche 4.
4. **Sonnette ignorée** : l'agent ouvre le tour mais ne lit pas le message. Le message revient en tête de file ; au troisième échec, l'expéditeur reçoit « message non livré » et la doublure cesse de sonner pour lui. Test à la tâche 7.
5. **Entrée de Romain sans tour derrière** (dialogue, `/model`, invite vide) : l'état devient inconnu, aucune sonnette avant le prochain repos fiable, même si plus aucune frappe n'arrive. Test à la tâche 7.

Résidus assumés, à observer en recette : en mode `/multiline` de Grok, Entrée insère une nouvelle ligne et serait pris pour une validation ; une souris X10 (rare, le SGR est la norme) serait mal classée ; les sous-agents d'agy déclenchent-ils les hooks du plugin (sonde à la tâche 11) ?

---

### Task 1: Le bus face à Claude 2.1.311 (contrôleur, sans sous-agent)

Claude est passé de 2.1.310 à 2.1.311 depuis la phase 2 (risque §14). Contrôle en réel avant tout code ; un écart arrête le plan et part en rapport à Romain.

**Files:** aucun (constats dans le rapport de recette de la tâche 11).

- [ ] **Step 1: Inscrire une doublure de shell** : `tmux -L idnma-p3 new-session -d -s shell -x 200 -y 50 -c /Users/recarnot/dev/erom-agence-network "bun scripts/shell-understudy.ts bypass"`. Attendu : `shell-<divinité>` dans `~/.claude/sessions/<pid>.json`.
- [ ] **Step 2: Découverte** : `ListAgents` depuis la session contrôleur. Attendu : `shell-<divinité>`, `interactive`, avec son pane.
- [ ] **Step 3: Aller** : `SendMessage` à `shell-<divinité>` (« test 2.1.311 ») ; dans le pane, `idnma read`. Attendu : l'enveloppe `<cross-session-message from="uds:…" from-name="<session contrôleur>" from-mode="bypass">` et le texte.
- [ ] **Step 4: Retour** : dans le pane, `idnma peer send <session contrôleur> 'retour 2.1.311'`. Attendu : message reçu par la session contrôleur, `from-name="shell-<divinité>"`, `from-mode="bypass"`, sans dialogue.
- [ ] **Step 5: Nettoyage** : `tmux -L idnma-p3 kill-server`, puis `test -e` sur l'entrée, la clé et les deux sockets relevés au step 1. Attendu : aucun ne reste.

### Task 2: PTY de la doublure

**Files:**
- Create: `src/understudy/pty.ts`, `scripts/pty-probe.ts`
- Modify: `src/understudy/understudy.ts` (option `pty`, terminal transmis au livreur, terminal rendu au nettoyage), `src/understudy/courier.ts` (signature d'`afterSpawn`)
- Test: `tests/pty.test.ts`, `tests/understudy.test.ts`
- Fixtures (étape de sonde) : `tests/fixtures/pty/grok-input.json`, `tests/fixtures/pty/agy-input.json`

**Interfaces:**
- Produces :
  - `interface Terminal { write(data: string): void; onInput(listener: (chunk: string) => void): () => void }` dans `src/understudy/pty.ts` : `write` écrit dans le PTY comme une frappe ; `onInput` abonne aux octets tapés dans le pane, décodés en UTF-8 par un `StringDecoder` (un caractère multioctet coupé entre deux blocs n'est jamais abîmé), rend le désabonnement.
  - `interface PtyChild { process: Bun.Subprocess; terminal: Terminal; release(): void }`, `release` idempotent : désabonne stdin et `resize`, rend le mode du terminal d'origine, met stdin en pause (`stdin.pause()`, sinon le process reste retenu), ferme le PTY.
  - `function spawnUnderPty(o: { argv: string[]; env: Record<string, string>; stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream }): PtyChild`.
  - `Courier.afterSpawn(terminal?: Terminal): void` (le livreur Codex l'ignore).
  - `runUnderstudy({ …, pty?: boolean; ptyStdin?: NodeJS.ReadStream; ptyStdout?: NodeJS.WriteStream })` : avec `pty: true`, l'enfant naît par `spawnUnderPty` (stdin et stdout du process par défaut, injectables pour les tests) et son `terminal` passe à `afterSpawn`.

Reprendre `runUnderPty` de caserne (`~/dev/erom-agence-control-plane/src/cli/pty.ts`) : `new Bun.Terminal({ cols, rows, name: TERM ?? "xterm-256color", data })`, stdin en mode raw s'il est un TTY, relais `stdout.write(data)`, et le correctif du spike D1 tel quel (au `resize` : `terminal.resize(cols, rows)` puis `proc.kill("SIGWINCH")`, les deux ensemble). Sans son serveur d'injection.

- [ ] **Step 1: Tests du PTY** dans `tests/pty.test.ts`, avec stdin et stdout factices (`PassThrough`, `isTTY` faux, `columns` 80, `rows` 24) :
  - `relays child output to stdout` : enfant `["/bin/sh", "-c", "printf ready"]` ; la sortie relayée contient `ready` ; `await child.process.exited` vaut 0.
  - `terminal writes reach the child` : enfant `["/bin/sh", "-c", "read line; printf 'got:%s' \"$line\""]` ; `terminal.write("hello\r")` ; la sortie contient `got:hello`.
  - `stdin chunks reach input listeners and the child` : même enfant ; un écouteur `onInput` ; `stdin.write("abc\r")` ; l'écouteur reçoit `"abc\r"`, la sortie contient `got:abc`.
  - `release is idempotent and detaches stdin` : `release()` deux fois sans exception ; `stdin.listenerCount("data")` revient à sa valeur d'avant.
- [ ] **Step 2: Lancer** `bun test tests/pty.test.ts`. Attendu : FAIL (module absent).
- [ ] **Step 3: Implémenter** `spawnUnderPty` dans `src/understudy/pty.ts`.
- [ ] **Step 4: Tests de la doublure** dans `tests/understudy.test.ts`, toujours avec `ptyStdin` et `ptyStdout` factices (jamais le vrai stdin de `bun test`) :
  - `runs the agent under a PTY and hands its terminal to the courier` : `pty: true`, argv `["/bin/sh", "-c", "printf x"]`, faux livreur qui garde l'argument d'`afterSpawn` ; cet argument a `write` et `onInput` ; code rendu 0.
  - `PTY child killed by SIGTERM yields 143` : argv `["/bin/sh", "-c", "kill -TERM $$"]` ; code rendu 143.
  - `cleanup releases the PTY` : après la sortie, `stdin.listenerCount("data")` revient à sa valeur d'avant.
- [ ] **Step 5: Implémenter** l'option `pty` dans `runUnderstudy` (le `release` rejoint `cleanup`, après l'arrêt du livreur) et la nouvelle signature d'`afterSpawn` ; les faux livreurs des tests existants restent valides.
- [ ] **Step 6: Lancer** `bun test 2>&1 | tee /tmp/idnma-phase3-t2.log` et `bun run typecheck`. Attendu : tout passe.
- [ ] **Step 7: Commit** `feat(understudy): lancer l'agent sous un PTY relayé`.
- [ ] **Step 8 (contrôleur, vrais harnais) : sonde des frappes et de la sonnette brute.** Écrire `scripts/pty-probe.ts` (outil de sonde, pas une commande produit) : lance `argv` sous `spawnUnderPty`, ajoute chaque bloc reçu de `onInput` à `<journal>` (une ligne JSON `{ "hex": …, "text": … }`), et sur `SIGUSR1` écrit `"📨 idnma read\r"` par `terminal.write`. Dans `tmux -L idnma-p3`, lancer `bun scripts/pty-probe.ts <journal> -- grok --model grok-4.7 --effort high --always-approve`, puis `tmux send-keys` : `abc`, `Enter`, `Up`, `C-c`, un collage (`tmux set-buffer` puis `paste-buffer -p`), et `select-pane` vers un autre pane puis retour (focus). Puis `kill -USR1 <pid de la sonde>` à l'invite vide. Ajouter `M-Enter` (Alt+Entrée, nouvelle ligne chez Grok). Attendus : la ligne `📨 idnma read` apparaît soumise dans la TUI (`capture-pane`) ; le journal montre comment Entrée arrive (`\r` ou `\x1b[13u`), Alt+Entrée, les séquences de focus et de réponse du terminal, et d'éventuels relâchements de touche du protocole kitty (`…:3u`). Même chose avec `agy --model gemini-4-argon-medium`. Écrire `tests/fixtures/pty/<harnais>-input.json` : tableau `[{ "hex": …, "expected": "enter" | "keystroke" | "noise" }]`, `expected` posé à la main d'après la touche envoyée. Si l'écriture brute ne soumet pas la ligne, arrêter et faire un rapport à Romain (le §7.5 suppose qu'elle soumet).

### Task 3: Op `hook` du canal de contrôle, lecture par le livreur, commande `idnma hook`

**Files:**
- Modify: `src/understudy/control.ts`, `src/understudy/courier.ts`, `src/understudy/understudy.ts`, `src/codex/courier.ts`, `src/cli.ts`
- Test: `tests/cli.test.ts`, `tests/understudy.test.ts`, `tests/codex-courier.test.ts` ; faux livreurs de `tests/understudy.test.ts` et `tests/run.test.ts` complétés

**Interfaces:**
- Produces :
  - `ControlCall` gagne `{ op: "hook"; harness: "grok" | "agy"; event: string; payload: Record<string, unknown> }` ; `ControlResponse` gagne `{ ok: true; reply: Record<string, unknown> }`. Un `payload` qui n'est pas un objet est refusé comme requête invalide.
  - `controlRequest(r, env = process.env, o: { timeoutMs?: number } = {})` : délai client `o.timeoutMs ?? 15_000`.
  - `Courier.read(): string | null` (message que le livreur remet à `idnma read`) et `Courier.hook(harness: "grok" | "agy", event: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>`. Livreur Codex : `read()` rend `null`, `hook()` rend `{}`.
  - `runUnderstudy` : op `read` → `activeCourier.read()` s'il y a un livreur actif, sinon `queue.shift()?.content ?? null` (comme aujourd'hui) ; op `hook` → `{ ok: true, reply: await activeCourier.hook(…) }`, ou `{ ok: true, reply: {} }` sans livreur actif.
  - CLI : `idnma hook <grok|agy> <événement>` lit l'événement sur stdin (JSON), appelle `controlRequest({ op: "hook", … }, process.env, { timeoutMs: 3_000 })` et écrit la réponse sur une ligne. Sans `IDNMA_CONTROL_SOCKET` et `IDNMA_CONTROL_TOKEN` (cas normal d'un Grok ou d'un agy lancé hors IdnmA) : écrit `{}`, code 0, rien sur stderr, rien au journal. Harnais inconnu, stdin illisible, doublure injoignable, délai dépassé ou réponse en erreur : écrit `{}`, code 0, rien sur stderr ; l'erreur va au journal (`hook-error`, champs `harness`, `event`, `message`).
  - CLI : `idnma read` sans message écrit `idnma : aucun message en attente.` puis un saut de ligne, code 0 (spec §8). Aide de `read` mise à jour ; aide principale : ligne `idnma hook <grok|agy> <événement>   (interne) point d'entrée des hooks de Grok et d'agy`.

- [ ] **Step 1: Tests** :
  - `tests/cli.test.ts` `hook without an understudy prints {} and exits 0` : `bun <CLI> hook grok PostToolUse` avec stdin = `tests/fixtures/hooks/grok-post-tool-use.json`, sans variables de contrôle → stdout `{}\n`, stderr vide, code 0. Idem `hook agy PreInvocation` avec `agy-pre-invocation-doorbell.json`.
  - `hook with an unknown harness prints {}` : `hook zed Stop` → `{}\n`, code 0.
  - `hook prints {} when the understudy does not answer in time` : faux serveur de contrôle qui ne répond jamais ; stdout `{}\n` en moins de 5 000 ms, et une ligne `hook-error` au journal.
  - `hook without an understudy writes nothing to the log` : après le premier test, le fichier de journal du dossier `IDNMA_CONFIG_DIR` du test n'existe pas ou ne contient aucune ligne `hook-error`.
  - `hook forwards the payload and prints the courier reply` : `runUnderstudy` avec un faux livreur dont `hook` rend `{ decision: "block", reason: "x" }` et garde ses arguments ; l'enfant lance `bun <CLI> hook grok Stop` avec stdin = `grok-stop-end-turn.json` → stdout `{"decision":"block","reason":"x"}\n` ; le livreur a reçu `"grok"`, `"Stop"` et un payload égal au contenu de la fixture.
  - `read without a message prints the no-pending line` → stdout `idnma : aucun message en attente.\n`, code 0. Ce test remplace l'existant `read prints nothing and exits 0 when the queue is empty` (`tests/cli.test.ts:92`, qui attend `""`).
  - `tests/understudy.test.ts` `read asks the active courier` : `read()` rend `"M"` → la réponse de l'op `read` porte `message: "M"`.
  - `tests/codex-courier.test.ts` `codex courier reads null and answers hooks with {}`.
- [ ] **Step 2: Lancer** `bun test tests/cli.test.ts tests/understudy.test.ts tests/codex-courier.test.ts`. Attendu : FAIL.
- [ ] **Step 3: Implémenter** l'op, l'interface du livreur, le livreur Codex et la CLI.
- [ ] **Step 4: Lancer** `bun test 2>&1 | tee /tmp/idnma-phase3-t3.log` et `bun run typecheck`. Attendu : tout passe.
- [ ] **Step 5: Commit** `feat(cli): point d'entrée idnma hook et lecture par le livreur`.

### Task 4: Adaptateurs Grok et agy

Les formes viennent des charges utiles réelles capturées le 27/10 (`tests/fixtures/hooks/`, Grok 1.0.70 et agy 1.4.7, sonde de la fiche d'entrée) et de la doc locale (`~/.grok/docs/user-guide/10-hooks.md` ; doc des hooks embarquée dans `agy`).

**Files:**
- Create: `src/hooked/signals.ts`, `src/hooked/grok.ts`, `src/hooked/agy.ts`
- Test: `tests/hooked-adapters.test.ts`

**Interfaces:**
- Produces, dans `src/hooked/signals.ts` :
  - `const DOORBELL_LINE = "📨 idnma read"`, `const DOORBELL_BYTES = DOORBELL_LINE + "\r"`.
  - `type TurnOutcome = "completed" | "interrupted" | "failed"`.
  - `type HookSignal = ({ kind: "session-start" } | { kind: "idle" } | { kind: "busy" } | { kind: "turn-start"; prompt: string; canDeliver: boolean } | { kind: "mid-turn" } | { kind: "turn-end"; outcome: TurnOutcome; reliableIdle: boolean; detail?: string; answer?: string; transcriptPath?: string } | { kind: "ignore" }) & { promptId?: string; conversationId?: string }`. `promptId` : Grok, sur `turn-start` et `turn-end` quand le payload le porte. `conversationId` : agy, sur tout signal.
  - `interface HarnessAdapter { harness: "grok" | "agy"; label: "Grok" | "agy"; textLimit: number; signal(event: string, payload: Record<string, unknown>): HookSignal; deliveryReply(event: string, text: string): Record<string, unknown>; continueReply(text: string): Record<string, unknown>; finalAnswer(end: Extract<HookSignal, { kind: "turn-end" }>): string | undefined }`. `textLimit` : plus long texte livrable par un hook ; Grok `9_500` (Grok coupe `additionalContext` et la raison d'un `Stop` à 10 000 caractères, doc 10-hooks) ; agy `Number.POSITIVE_INFINITY` (aucun plafond documenté pour `injectSteps`).
- Produces : `grokAdapter` (`src/hooked/grok.ts`), `agyAdapter` et `agyFinalAnswer(transcriptPath: string): string | undefined` (`src/hooked/agy.ts`).

Traduction Grok (`event` = nom PascalCase reçu en argument de `idnma hook`). Tout événement dont le payload porte un `subagentType` non vide est `ignore` : il vient d'un sous-agent, dont les tours ne comptent pas (§7.5) et qui peut survivre au tour parent (doc 10-hooks).

| Événement | Condition | Signal |
|---|---|---|
| `SessionStart` | | `session-start` |
| `UserPromptSubmit` | | `turn-start`, `prompt` = `payload.prompt` (chaîne, sinon `""`), `canDeliver: false` (Grok jette la sortie de ce hook) |
| `PreToolUse` | | `busy` |
| `PostToolUse`, `PostToolUseFailure` | | `mid-turn` |
| `Stop` | `reason === "end_turn"` | `turn-end`, `completed`, `reliableIdle: true`, `answer` = `lastAssistantMessage` |
| `Stop` | autre `reason` (`shutdown`, `channel_closed`) | `ignore` |
| `StopCancelled` | | `turn-end`, `interrupted`, `reliableIdle: false` |
| `StopFailure` | | `turn-end`, `failed`, `reliableIdle: false`, `detail` = `errorDetails` sinon `error` |
| `Notification` | `notificationType === "idle_prompt"` | `idle` |
| `Notification` | `notificationType === "permission_prompt"` | `busy` |
| tout autre | | `ignore` |

Grok : `deliveryReply(event, text)` = `{ hookSpecificOutput: { hookEventName: event, additionalContext: text } }` ; `continueReply(text)` = `{ decision: "block", reason: text }` ; `finalAnswer(end)` = `end.answer`.

Traduction agy :

| Événement | Condition | Signal |
|---|---|---|
| `SessionStart` | | `busy` (il part avec le premier prompt) |
| `PreInvocation` | `invocationNum === 0` | `turn-start`, `prompt` = `lastUserInput`, `canDeliver: true` |
| `PreInvocation` | `invocationNum >= 1` | `mid-turn` |
| `Stop` | `terminationReason` parmi `NO_TOOL_CALL`, `TERMINAL_STEP_TYPE`, `INJECTED_RESPONSE`, `TERMINAL_CUSTOM_HOOK` | `turn-end`, `completed`, `reliableIdle` = `fullyIdle === true`, `transcriptPath` |
| `Stop` | `terminationReason === "USER_CANCELED"` | `turn-end`, `interrupted`, `reliableIdle: false` |
| `Stop` | autre | `turn-end`, `failed`, `reliableIdle: false`, `detail` = `error` non vide sinon `terminationReason` |
| tout autre | | `ignore` |

Tout signal agy porte le `conversationId` du payload quand il est présent.

agy : `deliveryReply(_, text)` = `{ injectSteps: [{ userMessage: text }] }` ; `continueReply(text)` = `{ decision: "continue", reason: text }` ; `finalAnswer(end)` = `agyFinalAnswer(end.transcriptPath)` si le chemin est présent. `agyFinalAnswer` lit le JSONL (une ligne illisible est sautée, pas fatale), repère la dernière ligne `type === "USER_INPUT"` et `source === "USER_EXPLICIT"`, et rend le `content` du dernier `type === "PLANNER_RESPONSE"` placé après elle dont le `content` est une chaîne non vide ; sinon, ou si le fichier est illisible, `undefined`.

- [ ] **Step 1: Tests** dans `tests/hooked-adapters.test.ts`, chaque fixture lue par `JSON.parse(readFileSync(...))` :
  - `grok doorbell prompt is a turn start that cannot deliver` : `UserPromptSubmit` + `grok-user-prompt-submit-doorbell.json` → `{ kind: "turn-start", prompt: "📨 idnma read", canDeliver: false }`.
  - `grok end_turn stop carries the final answer` : `grok-stop-end-turn.json` → `kind` `turn-end`, `outcome` `completed`, `reliableIdle` vrai, `answer` `"MANGUE-42"`.
  - `grok shutdown stop is ignored` : `grok-stop-shutdown.json` → `{ kind: "ignore" }`.
  - `grok tool events and notifications` : `PreToolUse` → `busy` ; `PostToolUse` → `mid-turn` ; `SessionStart` → `session-start` ; `grok-notification-idle.json` → `idle` ; `{ notificationType: "permission_prompt" }` → `busy` ; `StopCancelled` → `turn-end` `interrupted` ; `StopFailure` avec `{ error: "rate_limit" }` → `failed`, `detail` `"rate_limit"`.
  - `grok subagent events are ignored` : copie de `grok-post-tool-use.json` et de `grok-stop-end-turn.json` avec `subagentType: "explore"` → `{ kind: "ignore" }` pour les deux.
  - `grok turn signals carry the promptId` : `UserPromptSubmit` et `Stop` des fixtures → `promptId` égal au `promptId` du payload.
  - `adapter text limits` : `grokAdapter.textLimit` vaut `9_500`, `agyAdapter.textLimit` vaut `Number.POSITIVE_INFINITY`.
  - `agy doorbell invocation is a turn start that can deliver` : `agy-pre-invocation-doorbell.json` → `{ kind: "turn-start", prompt: "📨 idnma read", canDeliver: true }` et `conversationId` égal à celui du payload.
  - `agy later invocation is mid-turn` : `agy-pre-invocation-after-injection.json` → `mid-turn` ; `agy-session-start.json` → `busy`.
  - `agy stop maps termination reasons` : `agy-stop-doorbell-turn.json` → `completed`, `reliableIdle` vrai, `transcriptPath` chaîne ; `{ terminationReason: "TERMINAL_STEP_TYPE", fullyIdle: true }` → `completed` ; `{ terminationReason: "NO_TOOL_CALL", fullyIdle: false }` → `completed`, `reliableIdle` faux ; `{ terminationReason: "USER_CANCELED" }` → `interrupted` ; `{ terminationReason: "ERROR", error: "quota" }` → `failed`, `detail` `"quota"`.
  - `agy final answer skips an unreadable line` : copie de la fixture transcript avec une ligne `{coupée` insérée avant la dernière → `"MANGUE-42\nKIWI-17"`.
  - `agy final answer is read from the transcript` : `agyFinalAnswer("tests/fixtures/hooks/agy-transcript-doorbell-turn.jsonl")` → `"MANGUE-42\nKIWI-17"`.
  - `agy final answer never returns a previous turn's answer` (Review Focus 3) : fichier temporaire = les 7 premières lignes de la fixture (jusqu'au `PLANNER_RESPONSE` vide du step 6) → `undefined`, alors que le step 3 porte une réponse non vide.
  - `agy final answer of a missing transcript is undefined`.
  - `replies have the harness shapes` : `grokAdapter.deliveryReply("PostToolUse", "t")` → `{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "t" } }` ; `agyAdapter.deliveryReply("PreInvocation", "t")` → `{ injectSteps: [{ userMessage: "t" }] }` ; `continueReply("t")` → `{ decision: "block", reason: "t" }` (Grok), `{ decision: "continue", reason: "t" }` (agy).
  - `doorbell bytes are exact` (AC-7) : `Buffer.from(DOORBELL_BYTES).toString("hex")` vaut `"f09f93a82069646e6d6120726561640d"`.
- [ ] **Step 2: Lancer** `bun test tests/hooked-adapters.test.ts`. Attendu : FAIL.
- [ ] **Step 3: Implémenter** les trois modules.
- [ ] **Step 4: Lancer** `bun test tests/hooked-adapters.test.ts` et `bun run typecheck`. Attendu : PASS.
- [ ] **Step 5: Commit** `feat(hooked): adaptateurs des hooks de Grok et d'agy`.

### Task 5: Registre des frappes de Romain

**Files:**
- Create: `src/hooked/draft.ts`
- Test: `tests/hooked-draft.test.ts`

**Interfaces:**
- Produces : `type InputKind = "enter" | "keystroke" | "noise"` ; `function classifyInput(chunk: string): InputKind` ; `class DraftTracker { feed(chunk: string): InputKind; reset(): void; get dirty(): boolean }`.

Règle (§7.5 et Review Focus 1) : on retire d'abord les séquences qui ne sont pas des frappes (focus `\x1b[I` et `\x1b[O`, souris SGR `\x1b[<…M` ou `\x1b[<…m`, souris X10 `\x1b[M` suivi de 3 octets, CPR `\x1b[<n>;<n>R`, attributs `\x1b[?…c` et `\x1b[>…c`, DECRPM `\x1b[?…$y`, drapeaux kitty `\x1b[?<n>u`, relâchement de touche kitty `\x1b[…:3u`, OSC terminé par BEL ou ST, DCS terminé par ST). Reste vide : `noise`. Reste qui se termine par un `\r` non précédé d'ESC, par `\x1b[13u` ou par `\x1b[13;1u`, hors collage entre crochets : `enter`. Tout autre reste est `keystroke` : collage compris, Alt+Entrée (`\x1b\r`, nouvelle ligne chez Grok) et `\n` (Ctrl+J, qui ne soumet rien chez Grok, doc 03-keyboard-shortcuts). `DraftTracker` : `keystroke` rend `dirty` vrai, `enter` le rend faux, `noise` ne change rien ; `reset()` le rend faux.

- [ ] **Step 1: Tests** dans `tests/hooked-draft.test.ts` :
  - `classifies typed input` sur la table : `"\r"` enter ; `"abc\r"` enter ; `"\x1b[13u"` enter ; `"\x1b[13;1u"` enter ; `"a"` keystroke ; `"\x1b[A"` keystroke ; `"\x03"` keystroke ; `"\x1b"` keystroke ; `"\x1b[13;2u"` keystroke ; `"\x1b\r"` keystroke ; `"abc\x1b\r"` keystroke ; `"\n"` keystroke ; `"\x1b[200~collé\x1b[201~"` keystroke ; `"\x1b[200~ligne1\rligne2\x1b[201~"` keystroke.
  - `ignores terminal reports, focus and mouse` : `"\x1b[I"`, `"\x1b[O"`, `"\x1b[<64;10;5M"`, `"\x1b[12;40R"`, `"\x1b[?62;22c"`, `"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\"`, `"\x1b]10;rgb:ffff/ffff/ffff\x07"`, `"\x1b[?1u"`, `"\x1b[13;1:3u"` → noise.
  - `noise is stripped before classifying the rest` : `"\x1b[Ia"` keystroke ; `"\x1b[O\r"` enter.
  - `classifies the recorded harness input` : chaque entrée de `tests/fixtures/pty/grok-input.json` et `agy-input.json` (tâche 2, step 8) → `classifyInput(Buffer.from(hex, "hex").toString("utf8"))` vaut `expected`.
  - `draft tracker follows keystrokes and Enter` : `feed("a")` → `dirty` vrai ; `feed("\x1b[I")` → vrai ; `feed("\r")` → faux ; `feed("b")` puis `reset()` → faux.
- [ ] **Step 2: Lancer** `bun test tests/hooked-draft.test.ts`. Attendu : FAIL.
- [ ] **Step 3: Implémenter** `src/hooked/draft.ts`.
- [ ] **Step 4: Lancer** `bun test tests/hooked-draft.test.ts`. Attendu : PASS.
- [ ] **Step 5: Commit** `feat(hooked): registre des frappes de Romain`.

### Task 6: Livreur des harnais à hooks (état, livraison en plein tour, relance au `Stop`)

**Files:**
- Create: `src/hooked/courier.ts`, `tests/helpers/fake-registration.ts` (y déplacer `fakeRegistration` de `tests/codex-courier.test.ts`, qui l'importe ensuite)
- Test: `tests/hooked-courier.test.ts`

**Interfaces:**
- Consumes : `HarnessAdapter`, `HookSignal` (tâche 4) ; `Courier`, `CourierUnavailableError`, `sendAutoReply`, `isAutoReply` (`src/understudy/courier.ts`) ; `MessageQueue`.
- Produces :
  - `interface HookedCourierOptions { adapter: HarnessAdapter; name: string; fromMode: FromMode; registration: Registration; queue: MessageQueue; send?: typeof sendPeerMessage; preflight?: () => string | undefined; doorbellDelayMs?: number; doorbellAnswerMs?: number; maxReadAttempts?: number; hookTextLimit?: number; maxContinuations?: number; now?: () => number }`, défauts `1_500`, `15_000`, `3`, `adapter.textLimit`, `3`, `Date.now`.
  - `function createHookedCourier(o: HookedCourierOptions): Courier`.

Règles de cette tâche :
- État `unknown` au départ. `session-start`, `idle` et `turn-end` avec `reliableIdle` → repos, `registration.setStatus("idle")`. `busy`, `turn-start`, `mid-turn` → occupé, `setStatus("busy")`. `turn-end` sans `reliableIdle` → inconnu, statut publié inchangé.
- Tour courant : ouvert par `turn-start` (heure `now()` et `promptId` notés), fermé par son `turn-end`. Un `turn-end` dont le `promptId` diffère de celui du tour courant (les deux présents) est ignoré : `{}`, aucun changement d'état (Grok peut livrer un `StopCancelled` après le `UserPromptSubmit` suivant, doc 10-hooks).
- Messages livrables dans un tour de Romain : priorité `now` toujours ; priorité `next` seulement si `receivedAt` est postérieur ou égal à l'ouverture du tour ; `later` jamais (il attend la sonnette). Un message qui attendait déjà au repos (brouillon, état inconnu) garde donc sa place pour la sonnette, même en `next` (spec AC-8 : « la sonnette part à la fin du tour qui suit »).
- Livraison en plein tour : à `mid-turn`, et à `turn-start` si `canDeliver`, les messages livrables, du plus ancien au plus récent, tant que leurs enveloppes jointes par `"\n\n"` tiennent dans `hookTextLimit` ; un message qui dépasse seul la limite est sauté (il reste en file, journal `hook-text-too-long` une fois par message) sans bloquer les suivants. Les messages livrés quittent la file ; réponse `adapter.deliveryReply(event, texte)` ; journal `hook-delivered` (`harness`, `event`, `msgIds`).
- `turn-end` `completed` d'un tour de Romain ouvert par un `turn-start` vu : s'il reste des messages livrables et moins de `maxContinuations` relances dans ce tour, réponse `adapter.continueReply(texte)`, l'état reste occupé, journal `hook-continued`. Le compteur repart à zéro à chaque `turn-start`. Un `turn-end` sans `turn-start` vu ne relance jamais. Sinon `{}`.
- agy : le livreur retient le `conversationId` du dernier `session-start` ou `turn-start` ; un signal qui en porte un autre est traité normalement mais journalisé (`agy-conversation-changed`, champs `from`, `to`, `event`), preuve pour la sonde des sous-agents de la tâche 11.
- `hook()` d'un autre harnais que `adapter.harness` : `{}` et journal `hook-wrong-harness`. Un signal `ignore` : `{}`.
- `beforeSpawn()` : `preflight?.()` rend une raison → `CourierUnavailableError(raison)`. `verifyCaller` rend toujours `false` (seule la voie du jeton ouvre le canal). `stop()` arrête tout minuteur, idempotent.

- [ ] **Step 1: Tests** dans `tests/hooked-courier.test.ts` (fixtures de `tests/fixtures/hooks/`, faux `Registration` qui enregistre `statuses`) :
  - `publishes idle at session start, busy during a turn, idle at end_turn` (Grok : `SessionStart`, `UserPromptSubmit`, `Stop` end_turn) → `statuses` = `["idle", "busy", "idle"]`.
  - `delivers next and now messages at PostToolUse of Romain's turn and keeps later` : `UserPromptSubmit` (prompt « fais X »), puis arrivent `m1` next, `m2` now, `m3` later, puis `PostToolUse` → `hookSpecificOutput.additionalContext` = `m1.content + "\n\n" + m2.content` ; la file ne garde que `m3`.
  - `a next message waiting before the turn keeps its place for the doorbell` : `m0` next reçu avant le `UserPromptSubmit`, `m1` now reçu avant aussi ; `PostToolUse` → seul `m1.content` est livré, `m0` reste en file ; le `Stop` end_turn rend `{}` (rien de livrable) et publie `idle`.
  - `agy injects deliverable messages at its invocations` : `m1` now en file avant le tour ; `PreInvocation` 0 d'un prompt de Romain → `injectSteps[0].userMessage` = `m1.content` ; puis `m2` next arrive ; `PreInvocation` 1 → `injectSteps[0].userMessage` = `m2.content`.
  - `continues Romain's turn at Stop at most three times` : un `UserPromptSubmit`, puis avant chaque `Stop` end_turn (même `promptId`), un message `next` arrive ; les trois premiers `Stop` rendent `{ decision: "block", reason: <enveloppe> }`, le quatrième `{}` et publie `idle`.
  - `a stop without a seen turn start never continues` : message `next` en file, `Stop` end_turn sans `UserPromptSubmit` → `{}`, `idle`.
  - `a late StopCancelled of a previous prompt is ignored` : `UserPromptSubmit` `promptId` `"p2"`, puis `StopCancelled` `promptId` `"p1"` → `{}`, statut toujours `busy`.
  - `never delivers a message longer than the hook limit, without blocking the next ones` (Review Focus 2) : `hookTextLimit` 50 ; pendant un tour, `m1` de 60 caractères puis `m2` court → `PostToolUse` livre `m2` seul ; `m1` reste en file.
  - `StopCancelled leaves the state unknown without publishing idle`.
  - `preflight reason makes beforeSpawn throw CourierUnavailableError` : `preflight: () => "hooks absents"` → rejet `CourierUnavailableError`, message `hooks absents`.
  - `hook for another harness answers {}`.
- [ ] **Step 2: Lancer** `bun test tests/hooked-courier.test.ts`. Attendu : FAIL.
- [ ] **Step 3: Implémenter** `createHookedCourier` (sans sonnette ; `read()` rend `null` pour l'instant).
- [ ] **Step 4: Lancer** `bun test 2>&1 | tee /tmp/idnma-phase3-t6.log` et `bun run typecheck`. Attendu : tout passe.
- [ ] **Step 5: Commit** `feat(hooked): état et livraison en plein tour pour Grok et agy`.

### Task 7: Sonnette, tours de pair et renvoi automatique

**Files:**
- Modify: `src/hooked/courier.ts`, `src/understudy/queue.ts` (ajout de `unshift`)
- Test: `tests/hooked-courier.test.ts`, `tests/queue.test.ts` (ou le fichier qui teste déjà `MessageQueue`)

**Interfaces:**
- Consumes : `Terminal` (tâche 2), `DraftTracker` (tâche 5), `DOORBELL_LINE`, `DOORBELL_BYTES` (tâche 4).
- Produces : `MessageQueue.unshift(message: InboundMessage): void` (remet en tête, même file pleine).

Règles :
- `afterSpawn(terminal)` garde le terminal et s'abonne à `onInput` → `DraftTracker.feed`. Une frappe (`keystroke`) annule une sonnette programmée. Un `enter` l'annule aussi et met l'état à inconnu jusqu'au prochain repos fiable (Review Focus 5) ; pendant un tour de pair, il le marque mélangé (journal `peer-turn-mixed`, champ `harness`) : pas de renvoi automatique à sa fin. `session-start` remet le brouillon à zéro (une session neuve a une zone de saisie vide).
- Sonnette : seulement à l'état repos, file non vide, brouillon propre, aucune sonnette en attente de tour, et aucun événement de hook ni frappe pendant `doorbellDelayMs`. Elle fait `terminal.write(DOORBELL_BYTES)`, une fois, journal `doorbell-rung` (`msgId` du plus ancien), puis attend un `turn-start` ; sans lui dans `doorbellAnswerMs`, l'état devient inconnu (journal `doorbell-unanswered`). Programmée à chaque passage au repos et à chaque `onMessage()` au repos ; tout événement de hook annule une sonnette programmée et non encore partie.
- Tour de pair : un `turn-start` dont `prompt === DOORBELL_LINE` **et** qu'une sonnette tapée attend son tour. Le drapeau « sonnette en attente » se pose à l'écriture, survit au délai `doorbellAnswerMs` (un tour tardif reste reconnu) et tombe au `turn-start` suivant, quel qu'il soit. Une ligne de sonnette rappelée par Romain depuis l'historique, sans sonnette en attente, ouvre un tour de Romain.
- Le tour de pair prend le plus ancien message de la file (toute priorité), muet si `isAutoReply(content)`. File vide à ce moment : tour de pair sans message, qui ne renvoie rien. Si `canDeliver` (agy) et que le message tient dans `hookTextLimit` : réponse `deliveryReply` avec ce seul message, marqué lu. Sinon : `{}`, et le premier `read()` le rend et le marque lu.
- `read()` : dans un tour de pair, son message s'il n'est pas encore lu (puis lu), sinon `null` (« aucun message en attente », AC-18). Hors tour de pair : retire et rend le plus ancien message de la file, toute priorité (spec §8), ou `null` si la file est vide.
- Pendant un tour de pair, `mid-turn` ne livre que la priorité `now` ; un `turn-end` de tour de pair ne relance jamais.
- Un `turn-start`, `idle` ou `session-start` reçu alors qu'un tour de pair est encore ouvert le clôt d'abord comme un `turn-end` `interrupted` sans `reliableIdle` (sa fin a été perdue).
- `turn-end` d'un tour de pair :
  - message lu, tour ni mélangé ni muet → `sendAutoReply` à son expéditeur : `completed` → `adapter.finalAnswer(end) ?? "<nom> : tour terminé sans réponse"` ; `interrupted` → `"<nom> : tour interrompu"` ; `failed` → `"<nom> : tour en échec (<detail ou erreur inconnue>)"`. Le renvoi part après la réponse au hook (jamais de retard sur le harnais) ; si `finalAnswer` rend `undefined`, une seule relecture 500 ms plus tard.
  - message non lu → `queue.unshift(message)` et une tentative de plus ; à `maxReadAttempts`, il quitte la file, journal `doorbell-unread`, et son expéditeur reçoit `"<nom> : message non livré (<label> n'a pas lu le message)"`, sauf si le message est muet (un renvoi automatique n'appelle jamais de réponse, spec §7.6).
  - puis repos ou inconnu selon `reliableIdle` ; au repos, la sonnette repart pour le message suivant.

Dans les tests, un « tour doorbell » = sonnette réellement tapée (repos, message en file, attendre 60 ms) puis `turn-start` portant la ligne de sonnette. Les tests nomment le livreur `grok-test` (ou `agy-test`), injectent des délais courts (`doorbellDelayMs` 20, `doorbellAnswerMs` 200) et un faux terminal `{ writes: string[]; write(d) { writes.push(d) }; onInput(l) { listener = l; return () => {} }; type(chunk) { listener(chunk) } }`, et `send` factice qui enregistre `{ to, body }`.

- [ ] **Step 1: Tests** :
  - `queue unshift puts a message back at the head even when full`.
  - AC-7 `rings with the exact doorbell bytes and nothing from the message` : Grok au repos (`SessionStart`), message dont le texte contient `"rm -rf ~\r"`, `"claude-mars"` et `"\x1b[A"` ; après 60 ms → `writes` = `["📨 idnma read\r"]`.
  - AC-8 `a draft blocks the doorbell until Enter and the end of the turn it starts` : repos ; `type("brouillon")` ; message `next` ; 100 ms → `writes` vide ; `type("\r")` → toujours vide ; `UserPromptSubmit` (prompt `"brouillon"`), `PostToolUse` → `{}` (le message attendait avant le tour), puis `Stop` end_turn → `{}` ; 60 ms → `writes` = `[DOORBELL_BYTES]`.
  - Review Focus 4 bis `a doorbell line recalled from history is Romain's turn` : repos, aucune sonnette tapée ; message en file mais brouillon sale ; `UserPromptSubmit` avec `prompt` `"📨 idnma read"` → tour de Romain : `read()` rend le message (hors tour de pair, plus ancien message) et, au `Stop`, aucun renvoi automatique.
  - `terminal reports and focus do not block the doorbell` : repos ; `type("\x1b[I")`, `type("\x1b[12;40R")` ; message ; 60 ms → une sonnette.
  - `agy never rings before its first reliable stop` : aucun événement ; message ; 100 ms → `writes` vide ; `Stop` (`agy-stop-doorbell-turn.json`) → 60 ms → une sonnette.
  - Review Focus 5 `Enter without a turn behind it leaves the courier unknown` : repos ; `type("\r")` ; message ; 300 ms → `writes` vide.
  - `Grok doorbell turn reads once and replies with the final answer` : repos, message `m` ; `UserPromptSubmit` doorbell → `{}` ; `read()` = `m.content` ; `read()` = `null` ; `Stop` end_turn (`answer` `MANGUE-42`) → `send` reçoit `to.address` = `m.from` et `body` = `"[réponse automatique idnma]\nMANGUE-42"`.
  - AC-18 `agy doorbell turn gets exactly one message and the next one rings again` : agy au repos (un `Stop` fiable), file `m1`, `m2` ; 60 ms → une sonnette ; `PreInvocation` doorbell → `injectSteps` ne porte que `m1.content` ; `read()` = `null` ; `Stop` de la fixture avec `transcriptPath` remplacé par `tests/fixtures/hooks/agy-transcript-doorbell-turn.jsonl` → réponse à `m1.from` = `"[réponse automatique idnma]\nMANGUE-42\nKIWI-17"` ; 60 ms → `writes` porte deux sonnettes, la seconde pour `m2`.
  - `an auto-reply opens a silent turn` : message dont le corps commence par la marque → tour de pair, `read()` le rend, `Stop` → aucun envoi.
  - `an unread silent message is dropped without a reply` : message muet, trois tours doorbell Grok finis sans `read()` → file vide, aucun envoi, journal `doorbell-unread`.
  - `a new turn start closes an open peer turn and requeues its unread message` : tour doorbell Grok ouvert, message non lu ; nouveau `UserPromptSubmit` (autre `promptId`) → le message est revenu en tête de file.
  - `read outside a peer turn returns the oldest message` : tour de Romain, file `m1` later, `m2` next → `read()` = `m1.content`, puis `m2.content`, puis `null`.
  - `Enter during a peer turn cancels the auto-reply` : tour de pair lu ; `type("ok\r")` ; `Stop` → aucun envoi ; journal `peer-turn-mixed`.
  - Review Focus 4 `an unread doorbell message is requeued, then rejected after three attempts` : trois tours doorbell Grok finis sans `read()` ; après le premier et le deuxième, le message est en tête de file ; après le troisième, `send` reçoit `"[réponse automatique idnma]\ngrok-test : message non livré (Grok n'a pas lu le message)"` et la file est vide.
  - `an unanswered doorbell leaves the courier unknown` : sonnette, aucun `turn-start` ; 400 ms → une seule écriture.
  - `interrupted peer turn replies tour interrompu` : tour doorbell lu, `StopCancelled` → `"<nom> : tour interrompu"`.
- [ ] **Step 2: Lancer** `bun test tests/hooked-courier.test.ts`. Attendu : les nouveaux tests échouent.
- [ ] **Step 3: Implémenter** la sonnette, les tours de pair, `read()` et `MessageQueue.unshift`.
- [ ] **Step 4: Lancer** `bun test 2>&1 | tee /tmp/idnma-phase3-t7.log` et `bun run typecheck`. Attendu : tout passe.
- [ ] **Step 5: Commit** `feat(hooked): sonnette, tours de pair et renvoi automatique`.

### Task 8: `idnma run grok|agy` et garde-fous de lancement

**Files:**
- Create: `src/hooked/preflight.ts`
- Modify: `src/paths.ts`, `src/run/run.ts`, `src/understudy/understudy.ts`, `src/understudy/courier.ts`
- Test: `tests/hooked-preflight.test.ts`, `tests/run.test.ts`, `tests/understudy.test.ts`, `tests/auto-reply.test.ts` (texte de `rejectQueuedMessages`)

**Interfaces:**
- Produces :
  - `grokHome(): string` = `process.env.GROK_HOME ?? ~/.grok` ; `agyPluginsDir(): string` = `process.env.IDNMA_AGY_PLUGINS_DIR ?? ~/.gemini/config/plugins` ; `agyBinary(): string` = `process.env.IDNMA_AGY_BIN ?? "agy"` (dans `src/paths.ts`, relus à chaque appel comme les autres).
  - `rejectQueuedMessages({ …, label?: string })`, défaut `"Codex"` : les deux appels du livreur Codex (`src/codex/courier.ts`) restent inchangés.
  - `grokPreflight(o: { env: Record<string, string>; argv: string[] }): string | undefined` et `agyPreflight(): string | undefined`, raisons exactes :
    - `hooks idnma absents de Grok (<grokHome()>/hooks/idnma.json) : lance idnma install`
    - `route daemon de Grok active (GROK_AGENT_HOST_BACKEND) : ses commandes ne descendraient plus de la doublure` si la variable est présente, non vide et différente de `0`
    - `mode leader de Grok demandé (--leader) : ses commandes ne descendraient plus de la doublure`
    - `mode leader de Grok actif ([cli] use_leader dans config.toml) : ses commandes ne descendraient plus de la doublure` si `Bun.TOML.parse` de `<grokHome()>/config.toml` donne `cli.use_leader === true` (fichier absent ou illisible : pas de raison)
    - `plugin idnma absent d'agy (<agyPluginsDir()>/idnma) : lance idnma install` si `<agyPluginsDir()>/idnma/hooks.json` n'existe pas
  - `RunDeps.createHookedCourier: (o: HookedCourierOptions) => Courier`.
  - `runUnderstudy({ …, harnessLabel?: string })`, défaut `"Codex"` : la ligne de stderr devient `idnma : <raison>. <label> démarre hors du bus (il ne recevra ni n'enverra de messages).` ; `rejectQueuedMessages({ …, label })` répond `<nom> : message non livré (<label> a quitté le bus)`.
- `runAgent` pour `grok` et `agy` : livreur `createHookedCourier({ adapter, name, fromMode, registration, queue, preflight })` si l'inscription a réussi ; `runUnderstudy({ …, pty: true, harnessLabel: adapter.label })`, canal de contrôle exporté à l'enfant (défaut). Codex inchangé (pas de PTY).

- [ ] **Step 1: Tests** :
  - `tests/hooked-preflight.test.ts` : chaque raison ci-dessus, au texte exact, avec `GROK_HOME` et `IDNMA_AGY_PLUGINS_DIR` redirigés vers des dossiers temporaires ; `undefined` quand tout est en place ; `config.toml` illisible → `undefined`.
  - `tests/run.test.ts` `grok runs under a PTY with a hooked courier` : faux deps ; `runUnderstudy` reçoit `pty: true`, `harnessLabel: "Grok"`, pas d'`exportControlEnv: false` ; `createHookedCourier` reçoit `adapter.harness === "grok"`. Même test pour agy (`"agy"`). `codex keeps its courier and no PTY` : `pty` absent.
  - `tests/understudy.test.ts` `an unavailable courier starts Grok off the bus with its label` : livreur dont `beforeSpawn` rejette `CourierUnavailableError("hooks idnma absents")`, `harnessLabel: "Grok"` → stderr `idnma : hooks idnma absents. Grok démarre hors du bus (il ne recevra ni n'enverra de messages).\n`.
  - `tests/auto-reply.test.ts` : texte de rejet avec `label: "agy"` → `<nom> : message non livré (agy a quitté le bus)`.
- [ ] **Step 2: Lancer** les fichiers de tests touchés. Attendu : FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Lancer** `bun test 2>&1 | tee /tmp/idnma-phase3-t8.log` et `bun run typecheck`. Attendu : tout passe.
- [ ] **Step 5: Commit** `feat(run): doublures Grok et agy sous PTY`.

### Task 9: `idnma install` pour Grok, installation par harnais

**Files:**
- Create: `src/install/hook-command.ts`, `src/install/grok.ts`
- Modify: `src/cli.ts`
- Test: `tests/install-grok.test.ts`, `tests/install-teammate.test.ts`

**Interfaces:**
- Produces :
  - `hookCommand(): { bun: string; cli: string }` : `bun` = `process.execPath` ; `cli` = `realpathSync` du `src/cli.ts` de ce checkout (résolu depuis `import.meta.url`).
  - `const GROK_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopCancelled", "StopFailure", "Notification"] as const`.
  - `grokHooksConfig(c: { bun: string; cli: string })` → `{ hooks: { <événement>: [{ hooks: [{ type: "command", command: c.bun, args: [c.cli, "hook", "grok", <événement>], timeout: 10 }] }] } }` pour chaque événement (forme `command` + `args` exécutée par Grok 1.0.70 pendant la sonde du 27/10).
  - `installGrok(c = hookCommand()): "installed" | "updated" | "unchanged" | "absent"` : `absent` si `grokHome()` n'existe pas ; écrit `hooks/idnma.json` (`JSON.stringify(…, null, 2) + "\n"`) et `rules/idnma-teammate.md` (`TEAMMATE_TEXT + "\n"`), dossiers créés au besoin, écriture atomique ; `unchanged` si les deux sont déjà identiques, `installed` si aucun n'existait, `updated` sinon.
  - `uninstallGrok(): "removed" | "absent"` : retire ces deux fichiers seulement.
  - `hookCommand().cli` est le chemin réel du checkout qui lance `idnma install` : installer depuis le checkout lié par `bun link` (`~/dev/erom-agence-network`), jamais depuis un worktree jetable (ses hooks échoueraient une fois le worktree retiré, contre AC-17). Le dire dans l'aide d'`install`.
  - CLI `install` et `uninstall` : une ligne par harnais, Codex puis Grok (agy en tâche 10). Codex absent ne fait plus échouer la commande : `Codex : absent (<CODEX_HOME>), rien installé` ; à la désinstallation, `Codex : absent (<CODEX_HOME>), rien retiré`, code 0. Grok : `Grok : hooks et ligne coéquipier installés dans <grokHome()>` (`mis à jour dans`, `déjà à jour dans`), `Grok : absent (<grokHome()>), rien installé` ; désinstallation : `Grok : hooks et ligne coéquipier retirés de <grokHome()>`, `Grok : rien à retirer de <grokHome()>`. Aides de `install` et `uninstall` réécrites pour les trois harnais et la phrase « Aucun fichier de Romain n'est modifié hors de ~/.codex/AGENTS.md ».

- [ ] **Step 1: Tests** (`GROK_HOME` et `CODEX_HOME` temporaires) :
  - `writes one command hook per Grok event` : JSON relu égal à `grokHooksConfig(hookCommand())` ; pour chaque événement, `args.slice(1)` = `["hook", "grok", <événement>]`.
  - `writes the teammate rule` : contenu = `TEAMMATE_TEXT + "\n"`.
  - `second install is unchanged and byte-identical`.
  - AC-19 `install and uninstall never write config.toml nor neighbour files` : `GROK_HOME/config.toml`, `GROK_HOME/hooks/herdr.json` et `GROK_HOME/rules/autre.md` préexistants ; après install puis uninstall, octet pour octet identiques ; `hooks/idnma.json` et `rules/idnma-teammate.md` absents.
  - `absent Grok home installs nothing`.
  - AC-17 `the installed commands run the hook entry point for every event` : pour chaque événement de `GROK_HOOK_EVENTS`, lancer `[command, ...args]` relus du fichier installé, stdin = la fixture de l'événement quand elle existe, sinon `{}`, sans variables de contrôle → stdout `{}\n`, code 0.
  - `tests/install-teammate.test.ts` (B1 de la relecture du plan) : le helper `cli()` (lignes 217-222) pose aussi `GROK_HOME` et `IDNMA_AGY_PLUGINS_DIR` sur des chemins dont le parent n'existe pas (branches « absent ») et `IDNMA_AGY_BIN` sur un chemin inexistant, pour que ces tests ne touchent jamais les vrais `~/.grok`, `~/.gemini` ni le vrai `agy` ; les sorties attendues des tests CLI d'`install` et d'`uninstall` passent à une ligne par harnais (Codex, puis `Grok : absent (…), rien installé`) ; le test `install without CODEX_HOME folder exits 1 …` devient `install without Codex reports it absent and exits 0` (ligne `Codex : absent (<chemin>), rien installé`, rien créé) ; le test d'`uninstall` sans Codex (ligne 270, code 1) devient `uninstall without Codex reports it absent and exits 0`.
- [ ] **Step 2: Lancer** les deux fichiers. Attendu : FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Lancer** `bun test 2>&1 | tee /tmp/idnma-phase3-t9.log` et `bun run typecheck`. Attendu : tout passe.
- [ ] **Step 5: Commit** `feat(install): hooks et ligne coéquipier de Grok`.

### Task 10: `idnma install` pour agy, par son plugin

**Files:**
- Create: `src/install/agy.ts`
- Modify: `src/cli.ts`
- Test: `tests/install-agy.test.ts`, `tests/install-teammate.test.ts`

**Interfaces:**
- Consumes : `hookCommand()` (tâche 9), `TEAMMATE_TEXT`, `agyPluginsDir()` (tâche 8).
- Produces :
  - `const AGY_HOOK_EVENTS = ["SessionStart", "PreInvocation", "Stop"] as const` (jamais `PreToolUse`).
  - `agyPluginFiles(c: { bun: string; cli: string }): Record<string, string>` : `"plugin.json"` = `'{\n  "name": "idnma"\n}\n'` ; `"rules/AGENTS.md"` = `TEAMMATE_TEXT + "\n"` ; `"hooks.json"` = `JSON.stringify({ idnma: { <événement>: [{ type: "command", command: "<bun> <cli> hook agy <événement>", timeout: 10 }] } }, null, 2) + "\n"`, chemins entre apostrophes pour `sh -c` (une apostrophe interne devient `'\''`). Forme validée le 27/10 : `agy plugin validate --strict`, puis hooks exécutés en TUI comme en mode print.
  - `type AgyRunner = (args: string[]) => { exitCode: number; output: string }`, défaut `Bun.spawnSync([agyBinary(), ...args])` (stdout et stderr réunis).
  - `installAgy(o: { run?: AgyRunner; command?: { bun: string; cli: string } } = {}): "installed" | "updated" | "unchanged" | "absent"` : `absent` si le dossier parent d'`agyPluginsDir()` n'existe pas, ou si `Bun.which(agyBinary())` est nul alors qu'aucun `run` n'est injecté (le dossier `~/.gemini/config` peut exister sans agy : il est partagé avec Gemini CLI, et `Bun.spawnSync` d'un binaire introuvable lève) ; `unchanged` si `<agyPluginsDir()>/idnma/` porte déjà exactement ces fichiers ; sinon copie dans `<mkdtemp>/idnma`, `run(["plugin", "install", <copie>])`, code non nul → `ConfigError("agy plugin install a échoué : <première ligne de la sortie>")` ; la copie est retirée en toute issue.
  - `uninstallAgy(o: { run?: AgyRunner } = {}): "removed" | "absent"` : `absent` sans `<agyPluginsDir()>/idnma` ; sinon `run(["plugin", "uninstall", "idnma"])`, code non nul → `ConfigError("agy plugin uninstall a échoué : …")`.
  - CLI : ligne agy après Codex et Grok : `agy : plugin idnma installé (<agyPluginsDir()>/idnma)` (`mis à jour`, `déjà à jour`), `agy : absent (<parent d'agyPluginsDir()>), rien installé` ; `agy : plugin idnma retiré`, `agy : plugin idnma absent, rien touché`.

- [ ] **Step 1: Tests** (`IDNMA_AGY_PLUGINS_DIR` temporaire ; exécuteur factice qui, sur `install`, copie le dossier reçu dans `<plugins>/idnma` et, sur `uninstall`, le retire, en gardant ses arguments) :
  - `stages the plugin and calls agy plugin install` : arguments `["plugin", "install", <chemin finissant par /idnma>]` ; `plugin.json`, `hooks.json` et `rules/AGENTS.md` installés égaux à `agyPluginFiles`.
  - `hooks never declare PreToolUse` : clés de `hooks.json` → `idnma` → exactement `SessionStart`, `PreInvocation`, `Stop`.
  - `unchanged when the installed plugin matches` : second `installAgy` → `unchanged`, exécuteur non rappelé.
  - `reports agy's message when install fails` : exécuteur `{ exitCode: 1, output: "boom\nsuite" }` → `ConfigError` `agy plugin install a échoué : boom` ; dossier de copie retiré.
  - `uninstall calls agy plugin uninstall idnma`.
  - AC-19 `never touches Romain's agy files` : `hooks.json` et `../GEMINI.md` factices voisins du dossier de plugins → identiques octet pour octet après install puis uninstall.
  - AC-17 `the hook command strings run the hook entry point for every event` : pour chaque événement d'`AGY_HOOK_EVENTS`, `sh -c <command>` avec stdin = la fixture de l'événement, sans variables de contrôle → stdout `{}\n`, code 0.
  - `absent when the agy binary is missing` : `IDNMA_AGY_BIN` sur un chemin inexistant, dossier parent présent, sans `run` injecté → `absent`.
  - `tests/install-teammate.test.ts` : les sorties attendues passent à trois lignes (`agy : absent (…), rien installé` en dernier).
- [ ] **Step 2: Lancer** `bun test tests/install-agy.test.ts`. Attendu : FAIL.
- [ ] **Step 3: Implémenter** `src/install/agy.ts` et la ligne agy de la CLI.
- [ ] **Step 4: Valider avec le vrai agy, sans modèle** : écrire `agyPluginFiles(hookCommand())` dans un dossier temporaire `…/idnma`, puis `agy plugin validate <dossier> --strict`. Attendu : `rules 1 · hooks 1`, `Validation passed`.
- [ ] **Step 5: Lancer** `bun test 2>&1 | tee /tmp/idnma-phase3-t10.log`, `bun run typecheck`, `ls -d /tmp/idnma-t-* 2>/dev/null | wc -l`. Attendu : tout passe, 0 dossier.
- [ ] **Step 6: Commit** `feat(install): plugin agy de la doublure`.

### Task 11: Recette avec les vrais harnais (contrôleur et Romain)

Après la revue finale de la branche (Opus, xhigh). Romain lance les panes ; le contrôleur envoie les messages et relève les preuves. Rapport : `.claude/notes/<date>-recette-phase3.md`, même forme que celui de la phase 2 (étape, vérification lancée, résultat observé, verdict), écarts et constats à part.

- [ ] **Step 1: Préalables** : `bun test 2>&1 | tee /tmp/idnma-phase3-recette.log`, `bun run typecheck`, 0 dossier `/tmp/idnma-t-*` ; copies `cp -p ~/.grok/config.toml ~/.gemini/config/hooks.json ~/.gemini/GEMINI.md <scratchpad>/avant/` ; `idnma install` (trois lignes) ; `agy plugin list` montre `idnma`.
- [ ] **Step 2: AC-17** : Romain lance `grok` puis `agy` sans `idnma run` ; un tour qui lance `ls`. `tmux capture-pane -p -S -500` : zéro ligne « hook » ou « failed » chez Grok, sortie de `ls` visible chez les deux.
- [ ] **Step 3: Découverte** : `idnma run grok` et `idnma run agy` dans deux panes ; `ListAgents` montre `grok-<divinité>` et `agy-<divinité>`, `interactive`, avec leur pane.
- [ ] **Step 4: AC-6 et AC-7** : Grok au repos, zone de saisie vide ; `SendMessage` (« réponds avec le champ name de package.json ») → `📨 idnma read` dans le pane en moins de 5 s (capture horodatée), réponse reçue sous la marque `[réponse automatique idnma]`. Puis agy : un premier tour de Romain (état inconnu au lancement), puis le même envoi.
- [ ] **Step 5: AC-5** : Grok lancé par Romain sur « lance sleep 20 puis résume » ; `SendMessage` « ajoute le mot PAPAYE à ton résumé » pendant l'attente → résumé avec PAPAYE ; journal `hook-delivered` `event: "PostToolUse"`. Même chose chez agy, `event: "PreInvocation"`.
- [ ] **Step 6: AC-8** : `tmux send-keys -t <pane grok> 'brouillon de Romain'` sans Entrée ; `SendMessage` ; attente de 30 s ; `capture-pane` : brouillon intact, aucun `📨`. Puis Entrée : le message, arrivé avant ce tour, n'y entre pas ; la sonnette part à la fin du tour qui suit, et la réponse revient à l'expéditeur. Demander à Romain s'il utilise `/multiline` dans Grok (résidu : Entrée y insère une ligne) et noter sa réponse.
- [ ] **Step 7: AC-18** : deux `SendMessage` (deux expéditeurs) à agy au repos → deux tours de pair, chaque expéditeur reçoit sa propre réponse ; aucun tour ne porte les deux messages (transcript agy).
- [ ] **Step 7 bis: Sous-agents d'agy (sonde)** : Romain demande à agy une tâche qui délègue à un sous-agent ; un message arrive pendant ce tour. Relever au journal les lignes `agy-conversation-changed` : si les sous-agents déclenchent les hooks du plugin sous un autre `conversationId`, l'écrire en constat (correctif à suivre : filtrer par `conversationId`) ; sinon, le résidu est clos.
- [ ] **Step 8: AC-15** : depuis une session Claude, `SendMessage` à un Codex pendant un tour, puis à Grok au repos ; chaque réponse arrive sous le nom de l'agent ; captures des trois panes.
- [ ] **Step 9: AC-13** : 10 minutes sans message ; `ps -o %cpu=,time= -p <pid>` des deux doublures à trois relevés ; aucun tour nouveau (sessions Grok, transcripts agy).
- [ ] **Step 10: AC-12** : fermeture des panes ; `test -e` sur entrées, clés, sockets et sockets de contrôle relevés avant ; tous absents ; agents hors de `ListAgents`.
- [ ] **Step 11: AC-19** : `idnma uninstall` ; `cmp` des trois fichiers contre leurs copies ; `test -e ~/.grok/hooks/idnma.json ~/.grok/rules/idnma-teammate.md` faux ; `agy plugin list` sans `idnma` ; `idnma install` deux fois de suite (la seconde dit « déjà à jour ») pour laisser l'installation en place.
- [ ] **Step 12: Rapport** et commit `docs: rapport de recette de la phase 3`.
