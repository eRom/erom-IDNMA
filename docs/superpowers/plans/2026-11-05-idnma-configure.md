# idnma configure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `idnma configure` ouvre une page locale qui crée et modifie `~/.idnma.yml` (agents, engines, providers, option sets), montre pour chaque engine sa commande de test, valide avec les règles d'`idnma run`, et écrit un fichier identique à l'octet près hors des endroits modifiés.

**Architecture:** Le serveur Bun tient l'état : un `ConfigDocument` (AST `Document` de la lib `yaml`) auquel la page envoie des opérations typées (`EditOp`) ; chaque réponse renvoie une vue complète (`ConfigView`) avec les problèmes de validation. La page est une vue mince (rendu HTML pur, testable sans navigateur, et un câblage DOM). Les contrôles d'engine d'`idnma run` sortent de `src/run/run.ts` dans `src/config/engine-rules.ts`, partagé par `runAgent` et par l'app.

**Tech Stack:** Bun 1.4.0 (`Bun.serve`, import HTML dans `routes`), TypeScript strict, `yaml` 2.9.1 (installé ; `package.json` : `^2.8.0`), `zod` 4, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-05-idnma-configure-design.md` (intent : `docs/superpowers/intents/2026-11-05-idnma-configure-intent.md`). Maquette validée : `.superpowers/brainstorm/42320-1793874589/content/commands.html` (hors git, ne pas committer).

**Écarts assumés avec la spec, à reporter dans la spec à la tâche 1 :**
- La validation tourne côté serveur à chaque opération (et non dans la page) : un seul runtime, aucun module Node à empaqueter pour le navigateur, tout testable par `bun test`.
- La page et ses fichiers statiques ne portent aucune donnée et ne sont pas gardés par le jeton ; toutes les routes `/api/` le sont. Le jeton passe par l'en-tête `x-idnma-token` (et `?token=` pour le flux SSE), pas par un cookie ; la page le garde en `sessionStorage` pour survivre à un rechargement.
- Renommer une clé (agent, engine, preset) ne casse aucune ancre (les ancres vivent sur les valeurs) : seuls les suppressions sont gardées.
- Un fichier en fins de ligne CRLF modifié est réécrit en LF (limite à ajouter au §12).
- AC-5 : la parité est garantie par construction (`runAgent` et l'app appellent les mêmes fonctions) et par `tests/run.test.ts` inchangé, pas par un test qui traverse `runAgent` avec chaque fixture.

## Global Constraints

- Bun `>= 1.4.0` ; dépendances d'exécution `yaml` et `zod` seulement (toute autre se justifie et se demande à Romain).
- Identifiants en anglais ; commentaires et docstrings en français ; textes de la CLI en français ; **texte de l'interface en anglais** (sentence case, verbe d'abord, pas de point d'exclamation, aucun emoji).
- DS Application d'erom-design : tokens copiés de `/Users/recarnot/dev/erom-design-system-application/design-system/tokens/{colors,typography,geometry,base}.css` (export `8d8ee42`), consommés par `var()`, jamais de hex ni de px en dur hors de la feuille de tokens ; **pas** de `fonts.css` ni de `.otf` ; pas de cards, filets en `box-shadow` inset 1px, une seule action primaire bleue par panneau, aucune animation.
- Lecture et écriture uniquement par l'AST `Document` ; sortie par `doc.toString({ flowCollectionPadding: false })`.
- Une clé de fusion se crée par `const k = new Scalar("<<"); k.type = Scalar.PLAIN; map.items.push(new Pair(k, doc.createAlias(presetNode, presetName)))`. **Jamais** `map.set("<<", …)` : la sonde du 05/11 montre qu'il écrit `"<<":` entre guillemets, qui n'est plus une fusion. Une paire est une fusion si `isScalar(pair.key) && (pair.key.source === "<<" || pair.key.value === "<<")`.
- `doc.createAlias(node)` sans nom invente une ancre `&a1` : toujours passer le nom (`createAlias(node, name)`). L'identité d'un preset suit son ancre (`node.anchor === alias.source`), pas sa clé. Toute ancre nouvelle (preset ajouté ou renommé) dont le nom existe déjà dans le document est refusée.
- Renommer une clé : `(pair.key as Scalar).value = newKey`, jamais remplacer `pair.key` (la sonde du 05/11 montre que le remplacement efface le commentaire et la ligne vide au-dessus de la clé).
- `doc.toString()` lève sur un document qui porte des erreurs, et un alias non résolu n'apparaît pas dans `doc.errors` mais fait lever `toString()` et `toJS()` : ne jamais appeler `toText()` ni `toJS()` global sur un document en `parseError`.
- Rien n'est écrit sur le disque avant un Save ; aucune lecture de fichier d'env ; aucune lecture de `process.env` renvoyée au client ; aucun agent lancé.
- `tests/run.test.ts` passe **sans modification**.
- `[REDACTED:env_secret]` dans la sortie des outils masque des valeurs `ANTHROPIC_AUTH_TOKEN` qui sont `"lmstudio"` et `"$OPENROUTER_API_KEY"` : ne jamais recopier le masque, vérifier par `grep -c` sur le littéral.
- Jamais `rm` : `trash <chemin>`. Chaque commande qui écrit commence par `cd /Users/recarnot/dev/erom-agence-network &&`.
- Chaque run de test cité dans un rapport passe par `tee` vers un fichier nommé dans le rapport.
- Travail sur la branche `feat/configure` ; fusion en avance rapide sur `main` seulement après la revue finale et le feu vert de Romain.

## Review Focus

1. **Texte venu du fichier injecté dans la page** : un `label` comme `<img src=x onerror=alert(1)>` ou une valeur d'env avec `"` doivent s'afficher tels quels, sans s'exécuter (la page tient le jeton). Test : tâche 10, `escapes file-provided text`.
2. **Valeurs tapées que YAML retyperait** : `4.7`, `0`, `yes`, `null`, `~`, `#x`, `a: b`, `*x`, `&x`, `- x` saisis comme modèle, valeur d'env ou option doivent se relire comme la même chaîne. Test : tâche 4, `typed values read back as the same strings`.
3. **Save sans modification** : sur un fichier existant non modifié, Save n'écrit rien (date de modification inchangée), même pour un fichier en fins de ligne CRLF que la lib réécrirait en LF. Test : tâche 8, `save without changes writes nothing`.
4. **Navigateur impossible à ouvrir** (pas d'`xdg-open`, session SSH) : l'URL est imprimée, le serveur continue. Test : tâche 9, `prints the url when the browser cannot be opened`.
5. **Écriture impossible au Save** (fichier supprimé, dossier en lecture seule) : message dans la page, aucun fichier partiel, le serveur continue. Test : tâche 7, `reports a failed write without leaving a partial file`.

---

### Task 1: Règles d'engine partagées

**Files:**
- Create: `src/config/engine-rules.ts`
- Modify: `src/run/run.ts` (déplacer `SHORT_ALIASES` l.73-80, `flagName` l.86-90, `CODEX_EMBEDDED_FLAGS` l.136-147, `CODEX_EMBEDDED_REASON` l.148, `codexEmbeddedFlag` l.151-153, `DST_MODEL_REASON` l.194, `OPENCODE_STANDALONE_REASON` l.196 ; brancher `runAgent` l.323-343 et `prepareOpencode` l.227-237)
- Modify: `src/config/network.ts` (exporter `EngineSchema`, `AgentSchema`)
- Modify: `docs/superpowers/specs/2026-11-05-idnma-configure-design.md` (§6 « Moment », §8, §10 : l'écart assumé ci-dessus)
- Test: `tests/engine-rules.test.ts`

**Interfaces:**
- Produces :
  - `type EngineIssueCode = "codex-embedded-flag" | "opencode-refused-flag" | "opencode-session-form" | "opencode-model-form" | "dst-model" | "dst-refused-flag"`
  - `interface EngineIssue { code: EngineIssueCode; field: "model" | "options"; error: "config" | "usage"; message: string; token?: string }` (`message` = le message français exact que `runAgent` lève aujourd'hui ; `token` = le flag ou le modèle fautif)
  - `engineIssues(engine: Engine, source: string): EngineIssue[]` (`source` = `.idnma.yml (agents.<a>.engines.<e>)`)
  - `opencodeArgvIssues(parsed: OpencodeArgv, engineModel: string | undefined, source: string): EngineIssue[]`
  - `flagName(harness: Harness, token: string): string | undefined`, `codexEmbeddedFlag(argv: string[]): string | undefined`, et les constantes déplacées, exportées.

- [ ] **Step 1: Créer la branche.** `cd /Users/recarnot/dev/erom-agence-network && git switch -c feat/configure` ; `git branch --show-current` affiche `feat/configure`.
- [ ] **Step 2: Écrire les tests** dans `tests/engine-rules.test.ts`, une ligne de table par règle, `source = ".idnma.yml (agents.x.engines.y)"` :
  - codex, `options: ["-c", "a=b"]` → un issue `{ code: "codex-embedded-flag", field: "options", error: "config", token: "--config" }`, `message` = `` `${source} : --config ${CODEX_EMBEDDED_REASON}` ``
  - opencode, `options: ["--standalone"]` → `opencode-refused-flag`, config, message `` `${source} : --standalone ${OPENCODE_STANDALONE_REASON}` ``
  - opencode, `options: ["-s", "abc"]` → `opencode-session-form`, usage, message `"-s : un id de session opencode commence par ses."`
  - opencode, `model: "big-pickle"` sans `-m` → `opencode-model-form`, field `model`, config, message `` `${source} : model « big-pickle » n'a pas la forme <fournisseur>/<modèle>.` ``
  - opencode, `model: "bad"`, `options: ["-m", "a/b"]` → aucun issue (le `-m` des options l'emporte)
  - opencode, `options: ["-m", "bad"]` → `opencode-model-form`, field `options`, usage, message `"--model : « bad » n'a pas la forme <fournisseur>/<modèle>."`
  - dst, `model: "x"` → `dst-model`, config, message `` `${source} : ${DST_MODEL_REASON}.` ``
  - dst, `options: ["--backend", "codex"]` → `dst-refused-flag`, config, message `` `${source} : ${dstRefusal(["--backend","codex"])}` ``
  - claude, grok, agy avec options quelconques → `[]`
- [ ] **Step 3: Lancer** `bun test tests/engine-rules.test.ts 2>&1 | tee /tmp/idnma-t1-red.log` : FAIL (module absent).
- [ ] **Step 4: Implémenter `src/config/engine-rules.ts`** : y déplacer les symboles listés (corps inchangés), écrire `opencodeArgvIssues` (ordre : forme de `-s`, puis modèle : `parsed.model` invalide → usage sur `options`, sinon `engineModel` invalide → config sur `model`, selon `parseModelRef`) et `engineIssues` (codex : `codexEmbeddedFlag(options)` ; opencode : `parseOpencodeArgv(options).refused`, puis `opencodeArgvIssues(parseOpencodeArgv(options), model, source)` ; dst : `model` défini, puis `dstRefusal(options)`).
- [ ] **Step 5: Brancher `run.ts`** : importer depuis `../config/engine-rules.ts` ; dans `runAgent`, les trois blocs `fromEngine` (codex, opencode refusé, dst) lèvent le **premier** issue des codes correspondants de `engineIssues(engine, engineSource)`, en `ConfigError` ; dans `prepareOpencode`, remplacer la décision d'erreur des lignes 228 et 231-237 par `opencodeArgvIssues(parsed, engine.model, engineSource)[0]` levé en `UsageError` ou `ConfigError` selon `error`, puis calculer `wanted` par `parseModelRef` (désormais sûr). Les contrôles de `a.passthrough` ne bougent pas.
- [ ] **Step 6: Lancer** `bun test tests/engine-rules.test.ts tests/run.test.ts 2>&1 | tee /tmp/idnma-t1-green.log` : tout PASS, `tests/run.test.ts` non modifié (`git diff --stat tests/run.test.ts` vide).
- [ ] **Step 7: Reporter les écarts dans la spec** (tous ceux du paragraphe « Écarts assumés » en tête du plan : §6 « Moment » ; §7 et AC-12, seules les suppressions sont gardées ; §8 jeton par en-tête et `sessionStorage`, page non gardée ; §10 `src/config/engine-rules.ts` et état tenu par le serveur ; §12 limite CRLF ; AC-5 « Vérifié par »).
- [ ] **Step 8: Commit** `git add src/config/engine-rules.ts src/run/run.ts src/config/network.ts tests/engine-rules.test.ts docs/superpowers/specs/2026-11-05-idnma-configure-design.md && git commit -m "refactor(run): extract engine rules shared with configure"`

### Task 2: Types, presets fournis, lecture du document et vue

**Files:**
- Create: `src/configure/types.ts`, `src/configure/builtins.ts`, `src/configure/command.ts`, `src/configure/document.ts`, `src/configure/view.ts`
- Create: `tests/fixtures/configure/romain.yml` (copie de `~/.idnma.yml` du jour : `cp ~/.idnma.yml tests/fixtures/configure/romain.yml`, puis `grep -c 'ANTHROPIC_AUTH_TOKEN: "\$OPENROUTER_API_KEY"'` = 1 et aucune autre valeur de jeton que `"ollama"`, `"lmstudio"`), `tests/fixtures/configure/linked-values.yml` (`git show eb46c8c:.idnma.example.yml > …` : valeurs liées par ancres)
- Test: `tests/configure-view.test.ts`

**Interfaces:**
- Produces (`types.ts`, types seuls, importables par la page) : `IssueView`, `LinkView { anchor: string; sharedWith: string[] }`, `EnvVarView { name: string; value: string; linked?: LinkView }`, `ProviderChoice = { kind: "anthropic" } | { kind: "preset"; name: string } | { kind: "custom" } | { kind: "none" }`, `OptionsChoice = { kind: "none" } | { kind: "preset"; name: string; values: string[] } | { kind: "custom"; values: string[] }`, `EngineView { name; isDefault; command; harness: string; model?: string; modelLinked?: LinkView; provider: ProviderChoice; mergedPreset?: string; options: OptionsChoice; env: EnvVarView[]; readOnly?: string }`, `AgentView { key; label?; info?; avatar?; engines: EngineView[] }`, `PresetView { name; kind: "provider" | "options" | "other"; builtIn: boolean; inFile: boolean; vars: EnvVarView[]; options: string[]; usedBy: string[] }`, `ConfigView { path; isNew; dirty; parseError?: { message; line; col }; agents: AgentView[]; presets: PresetView[]; issues: IssueView[] }`, `IssueView { severity: "error" | "warning"; code: string; message: string; agent?; engine?; preset?; field?; fix?: "quote" }`, et `EditOp` (union complète des opérations des tâches 3 à 5, déclarée ici en entier, chaque membre discriminé par `op`).
- Produces (`builtins.ts`) : `BUILTIN_PRESET_NAMES = ["ollama", "lmstudio", "openrouter", "claude-max"]`, `NEW_FILE_TEMPLATE: string` (texte exact ci-dessous), `builtinPresetText(name): string` (le bloc YAML d'un preset, pour l'insérer au premier usage).
- Produces (`command.ts`) : `commandLine(agentKey: string, engineName: string): string` → `idnma run <clé>` pour `default`, sinon `idnma run <clé> --engine <nom>`.
- Produces (`document.ts`) : `class ConfigDocument { static parse(text: string | undefined): ConfigDocument; readonly isNew: boolean; readonly parseError?: { message: string; line: number; col: number }; readonly doc: Document; toText(): string; apply(op: EditOp): void }` (`apply` lève `EditRefused` ; implémenté aux tâches 3 à 5), `class EditRefused extends Error`, helpers `agentMap(key)`, `engineMap(agent, engine)`, `presetNode(name)`, `isMergePair(pair)`, `aliasUsers(anchor): string[]` (chemins lisibles, ex. `agents.glm.engines.default.env`).
- Produces (`view.ts`) : `buildView(doc: ConfigDocument, path: string, dirty: boolean): ConfigView` (sans `issues`, remplies à la tâche 6).

`NEW_FILE_TEMPLATE` (sortie identique à l'octet près quand rien ne change, vérifié le 05/11 par sonde sur ce gabarit) :

```yaml
presets:
  ollama: &ollama
    ANTHROPIC_BASE_URL: "http://localhost:11434"
    ANTHROPIC_AUTH_TOKEN: "ollama"
    ANTHROPIC_API_KEY: ""
  lmstudio: &lmstudio
    ANTHROPIC_BASE_URL: "http://localhost:1234"
    ANTHROPIC_AUTH_TOKEN: "lmstudio"
    ANTHROPIC_API_KEY: ""
  openrouter: &openrouter
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api"
    ANTHROPIC_AUTH_TOKEN: "$OPENROUTER_API_KEY"
    ANTHROPIC_API_KEY: ""
  claude-max: &claude-max [--effort, max, --dangerously-skip-permissions]

agents:
```

- [ ] **Step 1: Créer les deux fixtures** (commandes ci-dessus) et vérifier la ligne `$OPENROUTER_API_KEY` par `grep -c`.
- [ ] **Step 2: Écrire les tests** (`tests/configure-view.test.ts`) :
  - `round-trips the real files byte for byte` : pour `romain.yml`, `linked-values.yml` et `.idnma.example.yml`, `ConfigDocument.parse(text).toText() === text`.
  - `new file starts from the template` : `ConfigDocument.parse(undefined)` → `isNew === true`, `toText() === NEW_FILE_TEMPLATE`.
  - `lists agents in file order with their commands` : sur `romain.yml`, `view.agents.length === 18`, l'agent `deepseek-flash` a trois engines, `commands` = `["idnma run deepseek-flash", "idnma run deepseek-flash --engine dst", "idnma run deepseek-flash --engine opencode"]`, son engine `default` a `provider = { kind: "preset", name: "ollama" }`, `options = { kind: "preset", name: "claude-max", values: ["--effort","max","--dangerously-skip-permissions"] }`, l'engine `dst` a `env = [{ name: "DSH_PERMISSION_MODE", value: "danger-full-access" }]`.
  - `classifies presets by shape` : `ollama`, `lmstudio`, `openrouter` → `provider` ; `claude-max` → `options` ; tous `builtIn: true, inFile: true` ; un fichier sans `lmstudio` montre quand même `lmstudio` avec `inFile: false`.
  - `lists who uses a preset as commands` : `usedBy` d'`openrouter` contient `"idnma run argon --engine claude"`.
  - `reads anthropic and custom providers` : engine claude sans `env` → `{ kind: "anthropic" }` ; engine claude avec `env: { ANTHROPIC_BASE_URL: "x" }` sans fusion → `{ kind: "custom" }` ; engine opencode avec `<<: *ollama` → `provider.kind === "none"`, `mergedPreset === "ollama"`.
  - `marks linked values` : sur `linked-values.yml`, l'engine `default` de `glm` a `modelLinked.anchor === "glm-flash"`, et sa variable `ANTHROPIC_DEFAULT_OPUS_MODEL` a `linked.anchor === "glm"`.
  - `keeps multi-merge engines read-only` : `env: { <<: [*ollama, *openrouter] }` → `readOnly` non vide.
  - `reports a syntax error with its position` : texte `"agents:\n  a: [\n"` → `parseError` avec `line` et `col` numériques (`linePos` rend un couple : lire `[0]`), `buildView(...).agents` vide, et `buildView` ne lève pas.
  - `reports an unresolved alias as a parse error` : `"agents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: claude\n        env:\n          <<: *nope\n"` et un alias écrit avant son ancre → `parseError` dont le message nomme l'alias, avec ligne et colonne (position par `range` et un `LineCounter`).
  - `survives an empty or comment-only file` : `""`, `"# rien\n"`, `"agents:\n"` → vue sans agents, sans exception.
- [ ] **Step 3: Lancer** `bun test tests/configure-view.test.ts 2>&1 | tee /tmp/idnma-t2-red.log` : FAIL.
- [ ] **Step 4: Implémenter** `types.ts`, `builtins.ts` (valeurs du §4 de la spec, identiques au gabarit), `command.ts`, `document.ts` (`parse` : `parseDocument(text ?? NEW_FILE_TEMPLATE, { merge: true })`, première erreur de `doc.errors` → `parseError` via `linePos(...)[0]` ; sinon, parcours par `visit` : le premier alias dont l'ancre n'existe pas avant lui → `parseError`), `view.ts` (lecture des nœuds, jamais de `toJS` pour l'identité des presets : un alias se reconnaît par `isAlias` et son `source`). Un fichier vide ou fait de commentaires a un `contents` nul : la première opération qui écrit crée la table racine.
- [ ] **Step 5: Lancer** les tests : PASS (`tee /tmp/idnma-t2-green.log`).
- [ ] **Step 6: Commit** `git add src/configure tests/configure-view.test.ts tests/fixtures/configure && git commit -m "feat(configure): read config document into a view"`

### Task 3: Opérations de structure (agents, engines) et ancres protégées

**Files:**
- Create: `src/configure/agent-ops.ts`
- Modify: `src/configure/document.ts` (`apply` délègue)
- Test: `tests/configure-agent-ops.test.ts`

**Interfaces:**
- Consumes : `ConfigDocument`, helpers et `EditOp` de la tâche 2.
- Produces : la prise en charge par `apply` de :
  `{ op: "addAgent"; key; label }`, `{ op: "duplicateAgent"; key }`, `{ op: "deleteAgent"; key }`, `{ op: "renameAgent"; key; newKey }`, `{ op: "setAgentField"; key; field: "label" | "avatar"; value: string | null }`, `{ op: "addEngine"; agent; name; harness }`, `{ op: "deleteEngine"; agent; engine }`, `{ op: "renameEngine"; agent; engine; newName }`, `{ op: "makeDefault"; agent; engine }`.

- [ ] **Step 1: Écrire les tests**, chacun sur une copie de `romain.yml`, en comparant `toText()` au texte d'origine par un `diff` ligne à ligne (helper `changedLines(before, after): { removed: string[]; added: string[] }` dans le fichier de test) :
  - `renaming an engine touches one line` : `renameEngine deepseek-flash opencode → oc` → removed `["      opencode:"]`, added `["      oc:"]`, et `buildView` donne la commande `idnma run deepseek-flash --engine oc`.
  - `renaming an agent keeps its place` : `renameAgent glm → glm-53` → une seule ligne changée, ordre des agents inchangé.
  - `renaming keeps the comment above the key` : texte `"agents:\n  a:\n    label: A\n\n  # the b agent\n  b:\n    label: B\n"`, `renameAgent b → c` → seule la ligne `  b:` devient `  c:`, le commentaire et la ligne vide restent.
  - `adds an agent at the end in block style` : sur `ConfigDocument.parse(undefined)`, `addAgent opus "Opus"` puis `addEngine opus default claude` → le texte se termine par `"agents:\n  opus:\n    label: Opus\n    engines:\n      default:\n        harness: claude\n"`.
  - `duplicate copies engines and avatar, not info nor cell` : sur `linked-values.yml`, `duplicateAgent agy` (`info: 3.8`, `cell: 0`, `avatar: gemini.png`) → nouvel agent `agy-copy` en fin de liste, `label: <label d'agy> copy`, mêmes engines, `avatar` copié, ni `info` ni `cell`.
  - `duplicate unlinks anchored values in the copy` : sur `linked-values.yml`, `duplicateAgent glm` → la copie porte les valeurs en clair (aucun `&` ni `*` vers une ancre interne à `glm`), l'original garde les siennes, chaque ancre du document reste unique, et `parseDocument(toText()).toJS()` donne pour la copie les mêmes valeurs résolues que pour l'original.
  - `make default swaps engine names` : `makeDefault argon claude` → l'engine claude s'appelle `default`, l'ancien `default` s'appelle `claude`.
  - `refuses to delete an anchor used elsewhere` : texte `"agents:\n  a:\n    label: A\n    engines:\n      default:\n        harness: claude\n        model: &shared m/x\n  b:\n    label: B\n    engines:\n      default:\n        harness: claude\n        model: *shared\n"`, `deleteAgent a` → `EditRefused` dont le message contient `agents.b.engines.default.model` ; le texte est inchangé. Même refus pour `deleteEngine a default`.
  - `deletes an agent whose anchors stay inside it` : sur `linked-values.yml`, `deleteAgent glm` réussit et `parseDocument(toText())` n'a aucune erreur.
  - `refuses duplicate or malformed keys` : `renameAgent opus → sonnet` (existe), `addAgent "-x"`, `renameEngine … → "a b"` lèvent `EditRefused`.
  - `setting the avatar to null removes the key` et `setting the label writes it in place`.
- [ ] **Step 2: Lancer** `bun test tests/configure-agent-ops.test.ts 2>&1 | tee /tmp/idnma-t3-red.log` : FAIL.
- [ ] **Step 3: Implémenter `agent-ops.ts`.** Renommer une clé = `(pair.key as Scalar).value = newKey`. Refus de forme : clés et noms `^[A-Za-z0-9._-]+$`, sans `-` initial, uniques. Garde des ancres : avant `deleteAgent` et `deleteEngine`, collecter les ancres du sous-arbre et refuser si `aliasUsers(anchor)` contient un chemin hors du sous-arbre (les renommages ne sont pas gardés : ils ne touchent pas les ancres). `duplicateAgent` : dans la copie, chaque alias vers une ancre interne au sous-arbre copié est remplacé par le texte de sa valeur, puis ces ancres sont retirées de la copie. Un nouvel agent : `YAMLMap` en bloc ajoutée à `agents` (créée si `agents` vaut `null` ou si le document est vide).
- [ ] **Step 4: Lancer** les tests : PASS (`tee /tmp/idnma-t3-green.log`).
- [ ] **Step 5: Commit** `git add src/configure tests/configure-agent-ops.test.ts && git commit -m "feat(configure): agent and engine structure operations"`

### Task 4: Opérations de champs d'engine

**Files:**
- Create: `src/configure/engine-ops.ts`
- Modify: `src/configure/document.ts`
- Test: `tests/configure-engine-ops.test.ts`

**Interfaces:**
- Consumes : tâches 2 et 3.
- Produces : `apply` prend en charge `setHarness`, `setModel { value: string | null }`, `setProvider { provider: { kind: "anthropic" } | { kind: "preset"; name } | { kind: "custom" } }`, `setOptions { options: { kind: "none" } | { kind: "preset"; name } | { kind: "custom"; values: string[] } }`, `setEnvVar { name; value; previousName? }`, `deleteEnvVar { name }`, `removeMerge`, `unlink { path: (string | number)[] }`, `quoteValue { path }` (tous avec `agent`, `engine` sauf `unlink`/`quoteValue`). Utilise `ensurePresetInFile(name)` de la tâche 5 pour un built-in absent (déclarer la signature ici, l'implémenter en tâche 5 ; d'ici là, un built-in absent lève `EditRefused`).

- [ ] **Step 1: Écrire les tests** (copie de `romain.yml` sauf mention) :
  - `changing a model touches one line` : `setModel deepseek-flash opencode "ollama-cloud/deepseek-v4.2"` → une ligne.
  - `typed values read back as the same strings` (Review Focus 2) : pour chaque `v` de `["4.7", "0", "yes", "null", "~", "#x", "a: b", "*x", "&x", "- x"]`, sur l'engine `default` de `opus` : `setModel(v)`, `setEnvVar("X", v)` et `setOptions({ kind: "custom", values: [v] })`, puis `parseDocument(toText()).toJS()` relit `model === v`, `env.X === v`, `options[0] === v` ; les valeurs d'env sont écrites entre guillemets doubles.
  - `picking another provider swaps the alias` : `setProvider qwen-max default { kind: "preset", name: "ollama" }` → la ligne `<<: *openrouter` devient `<<: *ollama`, rien d'autre.
  - `anthropic removes the merge and an empty env` : sur `mistral` → plus de clé `env`.
  - `custom env copies the preset values` : `setProvider muse default { kind: "custom" }` → l'env contient les trois clés d'`openrouter` en clair (dont `"$OPENROUTER_API_KEY"`), plus de `<<`.
  - `custom options copy the preset values in the file's list style` : `setOptions glm default { kind: "custom", values: […] }` écrit une liste **en ligne** dans `romain.yml` ; dans `linked-values.yml` (listes en bloc), une liste **en bloc**.
  - `changing harness drops what the new one cannot use` : `setHarness deepseek-flash default opencode` → plus de `<<`, plus d'`options`, plus de clé `env` si elle reste vide, `model` gardé ; `setHarness … dst` → plus de `model` ; les clés d'env propres restent.
  - `removeMerge on a non-claude engine` retire seulement la paire `<<`.
  - `unlink replaces an alias by its text and drops an unused anchor` : sur `linked-values.yml`, `unlink ["agents","glm","engines","default","env","ANTHROPIC_DEFAULT_OPUS_MODEL"]` → la valeur devient `glm-5.3:cloud[1m]` en clair ; l'ancre `&glm` disparaît si plus aucun alias ne la vise.
  - `quoteValue turns a number into text` : fichier `presets:\n  lmstudio: &lmstudio\n    CLAUDE_CODE_ATTRIBUTION_HEADER: 0\n` → `quoteValue ["presets","lmstudio","CLAUDE_CODE_ATTRIBUTION_HEADER"]` écrit `CLAUDE_CODE_ATTRIBUTION_HEADER: "0"`.
  - `editing an anchored value keeps the anchor` : sur `linked-values.yml`, `setModel` sur un champ lié lève `EditRefused` (« linked, unlink first »), le texte est inchangé.
- [ ] **Step 2: Lancer** `bun test tests/configure-engine-ops.test.ts 2>&1 | tee /tmp/idnma-t4-red.log` : FAIL.
- [ ] **Step 3: Implémenter `engine-ops.ts`.** Fusion créée par la recette des Global Constraints. Style de liste : `preferredOptionsFlow(doc)` = vrai si la majorité des séquences sous une clé `options` sont en ligne, vrai aussi s'il n'y en a aucune. Une valeur se modifie en place sur son `Scalar` (jamais de remplacement d'un nœud ancré).
- [ ] **Step 4: Lancer** les tests : PASS (`tee /tmp/idnma-t4-green.log`).
- [ ] **Step 5: Commit** `git add src/configure tests/configure-engine-ops.test.ts && git commit -m "feat(configure): engine field operations"`

### Task 5: Opérations de presets et presets fournis

**Files:**
- Create: `src/configure/preset-ops.ts`
- Modify: `src/configure/document.ts`, `src/configure/engine-ops.ts` (brancher `ensurePresetInFile`)
- Test: `tests/configure-preset-ops.test.ts`

**Interfaces:**
- Produces : `ensurePresetInFile(doc: ConfigDocument, name: string): Node` (insère le bloc d'un built-in absent en fin de `presets:`, créant `presets:` en tête du document s'il manque) ; `apply` prend en charge `addPreset { name; kind: "provider" | "options" }`, `renamePreset { name; newName }`, `deletePreset { name }`, `setPresetVar { name; varName; value; previousName? }`, `deletePresetVar { name; varName }`, `setPresetOptions { name; values: string[] }`.

- [ ] **Step 1: Écrire les tests** :
  - `using an absent built-in writes it first` : sur le texte `presets:\n  ollama: &ollama\n    ANTHROPIC_BASE_URL: "http://localhost:11434"\n\nagents:\n`, `addAgent t "T"`, `addEngine t default claude`, `setProvider t default { kind: "preset", name: "lmstudio" }` → `presets:` gagne le bloc `lmstudio: &lmstudio` (valeurs du gabarit) après `ollama`, avant `agents:`, et l'engine porte `<<: *lmstudio` ; sur un texte sans section `presets:`, elle est créée en tête du document.
  - `renaming a preset renames its anchor and every alias` : sur `romain.yml`, `renamePreset ollama → ollama-cloud` → la clé, l'ancre `&ollama-cloud` et les 7 `*ollama-cloud` (8 lignes changées) ; `parseDocument(toText()).toJS()` donne les mêmes env résolus qu'avant pour chaque engine.
  - `refuses an anchor name already taken` : sur `linked-values.yml`, `renamePreset ollama → glm` et `addPreset glm provider` → `EditRefused` (l'ancre `&glm` existe), texte inchangé.
  - `refuses to delete a preset in use` : `deletePreset claude-max` → `EditRefused` qui nomme au moins `idnma run glm` ; un preset inutilisé se supprime.
  - `editing a preset variable changes every user` : `setPresetVar openrouter ANTHROPIC_BASE_URL "https://x"` → une ligne changée.
  - `option set values are edited in place and keep their style` : `setPresetOptions claude-max [...]` garde la forme en ligne.
- [ ] **Step 2: Lancer** `bun test tests/configure-preset-ops.test.ts 2>&1 | tee /tmp/idnma-t5-red.log` : FAIL.
- [ ] **Step 3: Implémenter `preset-ops.ts`** (renommer : clé par `(pair.key as Scalar).value`, ancre par `node.anchor = newName`, puis chaque `Alias` dont `source === oldAnchor` reçoit `source = newName` ; un preset ajouté reçoit l'ancre de son nom ; tout nom d'ancre déjà présent est refusé).
- [ ] **Step 4: Lancer** les tests des tâches 2 à 5 : PASS (`tee /tmp/idnma-t5-green.log`).
- [ ] **Step 5: Commit** `git add src/configure tests/configure-preset-ops.test.ts && git commit -m "feat(configure): preset operations and built-in presets"`

### Task 6: Validation de l'app

**Files:**
- Create: `src/configure/validate.ts`
- Modify: `src/configure/view.ts` (remplir `issues`)
- Test: `tests/configure-validate.test.ts`

**Interfaces:**
- Consumes : `EngineSchema`, `AgentSchema` (exportés en tâche 1), `engineIssues` (tâche 1), `ConfigDocument` (tâche 2).
- Produces : `collectIssues(doc: ConfigDocument): IssueView[]` ; `buildView` remplit `issues`.

Codes et messages (anglais, exacts) :

| code | sévérité | message |
|---|---|---|
| `label-missing` | error | `Label is required.` |
| `key-form` | error | `Use letters, digits, dot, dash or underscore, without a leading dash.` |
| `no-engine` | error | `Add at least one engine.` |
| `no-default-engine` | error | `No default engine: idnma run <key> would fail.` (avec la clé) |
| `not-text` | error, `fix: "quote"` | `A number. Values must be text: write it as "<valeur>".` |
| `env-name-form` | error | `Not a valid variable name.` |
| `schema` | error | `Unknown key "<k>".` / `Harness must be one of claude, codex, grok, agy, opencode, dst.` / `Must be text.` |
| `codex-embedded-flag` | error | `<flag> starts Codex outside its shared server: idnma could not deliver bus messages.` |
| `opencode-refused-flag` | error | `<flag> starts opencode outside its shared service: idnma could not deliver bus messages.` |
| `opencode-session-form` | error | `An opencode session id starts with "ses".` |
| `opencode-model-form` | error | `The model must read <provider>/<model>.` |
| `dst-model` | error | `dst takes no model at launch: pick it with /model inside dst.` |
| `dst-refused-flag` | error | `This option has no place in a bus pane for dst.` |
| `label-duplicate` | warning | `Same label as <autre clé>.` |
| `preset-shape` | warning | `Neither a provider nor an option set.` |

- [ ] **Step 1: Écrire les tests** :
  - `the real files are clean` : `romain.yml` et `.idnma.example.yml` → aucune erreur.
  - `a number in a provider is one quotable issue` (AC-6) : fixture en ligne `presets:\n  lmstudio: &lmstudio\n    ANTHROPIC_BASE_URL: "http://localhost:1234"\n    CLAUDE_CODE_ATTRIBUTION_HEADER: 0\nagents:\n  oss20:\n    label: GPT OSS 20B\n    engines:\n      default:\n        harness: claude\n        model: openai/gpt-oss-20b\n        env:\n          <<: *lmstudio\n` → exactement une erreur, `code: "not-text"`, `preset: "lmstudio"`, `fix: "quote"` ; après `quoteValue`, zéro erreur, et `loadAgentEngine("oss20")` (avec `IDNMA_CONFIG_DIR` sur un dossier temporaire contenant `toText()`) ne lève pas.
  - `engine rules match idnma run` (AC-5) : pour chaque ligne de la table de la tâche 1, un document d'un agent `x` avec cet engine en `default` → une erreur du même `code`, `agent: "x"`, `engine: "default"`, `field` identique.
  - `app rules` : label absent, clé `-x`, agent sans engine, agent sans `default`, variable `MY VAR`, `harness: foo`, `option:` (clé inconnue) → une erreur chacun avec le bon code.
  - `duplicate labels warn` : deux agents `label: Luna` → deux avertissements, aucune erreur.
- [ ] **Step 2: Lancer** `bun test tests/configure-validate.test.ts 2>&1 | tee /tmp/idnma-t6-red.log` : FAIL.
- [ ] **Step 3: Implémenter `validate.ts`** : **une faute, une issue**. Règles d'app sur les nœuds d'abord (`not-text` = `Scalar` non chaîne sous `env`, `options` ou une valeur de preset, signalé là où il se corrige, sur le preset s'il vient d'un preset) ; schéma ensuite sur le JS résolu de chaque engine (`toJS` engine par engine dans un `try/catch` qui produit une issue, jamais un `toJS` global), en ignorant les issues zod `invalid_type` sur `env.*` et `options.*` déjà couvertes par `not-text`, et sans schéma pour un agent déjà en `no-engine` ; `engineIssues(engine, source)` pour chaque engine dont le schéma passe ; codes zod traduits par la table.
- [ ] **Step 4: Lancer** les tests des tâches 1 à 6 : PASS (`tee /tmp/idnma-t6-green.log`).
- [ ] **Step 5: Commit** `git add src/configure tests/configure-validate.test.ts && git commit -m "feat(configure): validation shared with idnma run"`

### Task 7: Lecture et écriture du fichier

**Files:**
- Create: `src/configure/store.ts`
- Test: `tests/configure-store.test.ts`

**Interfaces:**
- Produces : `textHash(text: string | undefined): string` (sha256 hex ; `"absent"` pour `undefined`), `readConfig(path: string): { text: string | undefined; hash: string }`, `type SaveResult = { kind: "written"; hash: string } | { kind: "changed-on-disk" } | { kind: "failed"; message: string }`, `saveConfig(path: string, text: string, baseHash: string): SaveResult`.

- [ ] **Step 1: Écrire les tests** (dossier temporaire) :
  - `writes atomically and keeps the mode` : fichier en `0600`, `saveConfig` → contenu nouveau, mode `0600`, aucun fichier `*.idnma-tmp-*` restant ; fichier neuf → mode `0644`.
  - `refuses when the file changed on disk` (AC-9) : lire, écrire autre chose à la main, `saveConfig(path, x, oldHash)` → `changed-on-disk`, contenu manuel intact.
  - `refuses when a new file appeared` : `baseHash = "absent"` et un fichier créé entre-temps → `changed-on-disk`.
  - `reports a failed write without leaving a partial file` (Review Focus 5) : dossier en `0500` → `kind: "failed"`, message qui cite le chemin et pas de contenu, aucun fichier temporaire.
- [ ] **Step 2: Lancer** `bun test tests/configure-store.test.ts 2>&1 | tee /tmp/idnma-t7-red.log` : FAIL.
- [ ] **Step 3: Implémenter `store.ts`** (temporaire `${path}.idnma-tmp-${process.pid}` dans le même dossier, `chmodSync` avant `renameSync`, `trash` interdit dans le code : nettoyage par `unlinkSync` du seul temporaire créé par ce process en cas d'échec).
- [ ] **Step 4: Lancer** les tests : PASS (`tee /tmp/idnma-t7-green.log`).
- [ ] **Step 5: Commit** `git add src/configure/store.ts tests/configure-store.test.ts && git commit -m "feat(configure): atomic config write with change detection"`

### Task 8: Serveur local

**Files:**
- Create: `src/configure/server.ts`, `src/configure/page/index.html` (coquille minimale : `<div id="app"></div>`, `<link rel="stylesheet" href="./styles.css">`, `<script type="module" src="./app.ts">` ; contenu réel en tâches 10 et 11), `src/configure/page/app.ts` et `styles.css` vides
- Test: `tests/configure-server.test.ts`

**Interfaces:**
- Consumes : tâches 2 à 7.
- Produces : `startConfigureServer(o: { path: string; idleMs?: number; token?: string }): { url: string; port: number; token: string; stop(): void; done: Promise<void> }` (`idleMs` par défaut `10_000` ; `url` = `http://127.0.0.1:<port>/?token=<token>` ; `done` se résout à **tout** arrêt, inactivité ou `stop()`).
- API (JSON, en-tête `x-idnma-token` ; SSE par `?token=`) : `GET /api/state` → `{ view }` ; `POST /api/op` `{ op: EditOp }` → `{ view }` ou 409 `{ refused: string }` ; `POST /api/revert` → `{ view }` ; `POST /api/save` → `{ view }`, 409 `{ changedOnDisk: true }` ou 500 `{ failed: string }` ; `POST /api/reload` → `{ view }` ; `GET /api/events` → flux SSE (commentaire `: ping` toutes les 5 s).

Fait capturé le 05/11 (sonde Bun 1.4.0, `development: false`) : `import page from "./page/index.html"` dans `routes: { "/": page }` sert le HTML avec ses ressources réécrites en `/chunk-<hash>.js` et `/chunk-<hash>.css`, TypeScript transpilé ; le `fetch` du même `Bun.serve` reçoit les autres chemins.

- [ ] **Step 1: Écrire les tests** (serveur démarré sur une copie de fixture, `fetch` réel) :
  - `serves the page without data` : `GET /` → 200, HTML qui référence un `/chunk-*.js`.
  - `guards the api` (AC-10) : `GET /api/state` sans jeton → 403 ; avec un `Host: evil.test` → 403 ; `POST /api/op` avec `Origin: http://evil.test` → 403 ; `POST` sans `content-type: application/json` → 415 ; chaque refus laisse le fichier intact.
  - `applies an op and saves` : `POST /api/op` (renommer un engine) → `view.dirty === true` ; `POST /api/save` → fichier écrit, `view.dirty === false`.
  - `save without changes writes nothing` (Review Focus 3) : `POST /api/save` sans op sur un fichier en fins de ligne `\r\n` → date de modification et contenu inchangés.
  - `saves a file that still has errors` : une op qui laisse une erreur (label vidé), puis `POST /api/save` → écrit, `view.issues` non vide.
  - `refuses a stale save` (AC-9) : modification manuelle du fichier puis `POST /api/save` → 409 `changedOnDisk`, fichier manuel intact ; `POST /api/reload` → vue du fichier manuel.
  - `never sends environment values` (AC-8) : dans le test, `const sentinel = ["sentinel", "7f3a"].join("-")` puis `process.env["OPENROUTER" + "_API_KEY"] = sentinel` (écrit ainsi pour que l'affichage des outils ne masque pas la ligne ; restaurer en `afterEach`) ; le corps de chaque réponse (`/`, chunks, `/api/state`, `/api/op`, `/api/save`, `/api/revert`, `/api/reload`) ne contient pas `sentinel`. Vérifier `grep -c '"7f3a"' tests/configure-server.test.ts` = 1.
  - `serves the parse-error view` : fichier `"agents:\n  a: [\n"` → `GET /api/state` 200 avec `view.parseError`, `view.dirty === false` ; `POST /api/op` → 409.
  - `stops when the last page leaves` (AC-11) : `idleMs: 200` ; ouvrir puis fermer `/api/events` → `done` se résout en moins de 1 s et le port ne répond plus.
  - `creates a new file on save` (AC-7) : chemin inexistant → `view.isNew === true` ; `POST /api/save` → le fichier vaut `NEW_FILE_TEMPLATE`.
- [ ] **Step 2: Lancer** `bun test tests/configure-server.test.ts 2>&1 | tee /tmp/idnma-t8-red.log` : FAIL.
- [ ] **Step 3: Implémenter `server.ts`** : `Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, routes: { "/": page }, fetch })` ; jeton `randomBytes(32).toString("hex")` ; `dirty` = `false` si `parseError`, sinon `isNew || doc.toText() !== ConfigDocument.parse(baseText).toText()` (comparer à la base relue et non au texte brut : un fichier CRLF relu sort en LF et ne doit pas paraître modifié) ; Save sur `!dirty` ne touche pas le disque ; minuteur d'inactivité armé quand le nombre de flux SSE retombe à zéro, annulé à la connexion suivante, jamais armé avant la première connexion.
- [ ] **Step 4: Lancer** les tests : PASS (`tee /tmp/idnma-t8-green.log`).
- [ ] **Step 5: Commit** `git add src/configure tests/configure-server.test.ts && git commit -m "feat(configure): local server with token, origin and idle guards"`

### Task 9: Commande `idnma configure`

**Files:**
- Modify: `src/cli.ts` (`MAIN_HELP`, nouvelle aide `CONFIGURE_HELP`, `case "configure"` dans `main`, sortie par `process.exit(code)` comme `run`)
- Create: `src/configure/command-line.ts`
- Test: `tests/configure-cli.test.ts`

**Interfaces:**
- Produces : `configureCommand(args: string[], deps?: { start?: typeof startConfigureServer; open?: (url: string) => boolean; write?: (text: string) => void }): Promise<number>` ; `openInBrowser(url: string): boolean` (`open` sur darwin, `xdg-open` sinon, par `Bun.spawn` ; `false` si le binaire manque ou échoue au lancement).

Texte exact (stdout) :
```
idnma configure : <url>
Ctrl-C pour arrêter ; s'arrête seul quand la page est fermée.
```
Si l'ouverture échoue, ligne en plus : `Ouvre cette adresse dans ton navigateur.`
Ligne de `MAIN_HELP` : `  idnma configure [--no-open]         ouvre l'éditeur de ~/.idnma.yml dans le navigateur`.

- [ ] **Step 1: Écrire les tests** : `--help` → 0 et l'aide ; argument inconnu → 2 ; `--no-open` → `open` jamais appelé ; `prints the url when the browser cannot be opened` (Review Focus 4) : `open` renvoie `false` → les trois lignes, le serveur tourne (`GET` de l'URL → 200), puis `stop()` → code 0.
- [ ] **Step 2: Lancer** `bun test tests/configure-cli.test.ts 2>&1 | tee /tmp/idnma-t9-red.log` : FAIL.
- [ ] **Step 3: Implémenter** `command-line.ts` et le branchement dans `cli.ts` (chemin : `networkPath()`).
- [ ] **Step 4: Lancer** `bun test tests/configure-cli.test.ts tests/cli.test.ts 2>&1 | tee /tmp/idnma-t9-green.log` : PASS.
- [ ] **Step 5: Commit** `git add src/cli.ts src/configure/command-line.ts tests/configure-cli.test.ts && git commit -m "feat(cli): add idnma configure"`

### Task 10: Rendu de la page

**Files:**
- Create: `src/configure/page/render.ts`
- Test: `tests/configure-render.test.ts`

**Interfaces:**
- Consumes : types de la tâche 2, `commandLine`.
- Produces : `interface UiState { tab: "agents" | "providers" | "options"; selected?: string; menu?: { agent: string; engine: string; kind: "harness" | "provider" | "options" } }`, `escapeHtml(s: string): string`, `renderApp(view: ConfigView, ui: UiState): string`. Chaque contrôle porte `data-action` (nom de l'`EditOp` ou action d'UI : `tab`, `select`, `menu`, `copy`, `save`, `revert`, `reload`) et les `data-*` qui la complètent ; chaque champ porte un `data-focus-id` stable pour rendre le focus après un nouveau rendu.

Composition (maquette `commands.html`, état 1 et état 2) : barre d'outils (nom en texte brut, chemin mono, mention `New file` et bouton `Create` pour un fichier neuf, état `Valid · N agents` ou `N issues`, `Revert`, `Save ⌘S` seule action primaire, désactivé si `!dirty`) ; barre latérale à contrôle segmenté `Agents N`, `Providers N`, `Options N`, rangées avec initiale du label, label, méta (harnais de `default` et `+N`), point rouge si erreur, `+ Add agent` / `+ Add provider` / `+ Add option set` ; vue Agent (en-tête avec `info` en sous-titre, `Duplicate`, `Delete` ; champs `Label`, `Key`, `Avatar` texte ; `Engines`, `+ Add engine` ; par engine : bande de commande `❯ idnma run …`, mention `default`, `Copy`, `Make default` hors `default`, réglages selon le harnais : Provider pour `claude`, phrase `Model is chosen inside dst with /model` pour `dst`, `Env` avec `<< preset` pour un engine non claude fusionné, champs liés en lecture seule avec `Unlink`) ; vues Provider et Option set (`Built-in`, variables ou jetons, `Used by` en commandes avec `Copy`) ; écran d'erreur de syntaxe (message, ligne, colonne, `Reload`) ; message et anneau rouge sous le champ fautif, bouton `Quote it` pour `fix: "quote"`.

- [ ] **Step 1: Écrire les tests** (sur des vues construites depuis les fixtures) :
  - `escapes file-provided text` (Review Focus 1) : label `<img src=x onerror=alert(1)>` → la sortie contient `&lt;img` et aucune balise `<img`.
  - `heads each engine with its command` : vue de `romain.yml`, `selected: "deepseek-flash"` → la sortie contient les trois commandes, dans l'ordre.
  - `shows the dst model sentence instead of a model field`.
  - `shows the provider menu only for claude engines`.
  - `marks errors where they are fixed` : vue de la fixture AC-6, onglet Providers, `selected: "lmstudio"` → `Quote it` présent, point d'erreur sur la rangée `lmstudio`, barre `1 issue`.
  - `new file toolbar` : vue de `ConfigDocument.parse(undefined)` → `New file` et `Create`.
  - `parse error screen` : vue avec `parseError` → message, ligne, colonne, `Reload`, aucun champ.
- [ ] **Step 2: Lancer** `bun test tests/configure-render.test.ts 2>&1 | tee /tmp/idnma-t10-red.log` : FAIL.
- [ ] **Step 3: Implémenter `render.ts`** (gabarits de chaînes, `escapeHtml` sur toute valeur venue de la vue, vrais `<button>`, `<input>`, `<select>`).
- [ ] **Step 4: Lancer** les tests : PASS (`tee /tmp/idnma-t10-green.log`).
- [ ] **Step 5: Commit** `git add src/configure/page/render.ts tests/configure-render.test.ts && git commit -m "feat(configure): render the configure page"`

### Task 11: Page vivante et feuille de styles

**Files:**
- Modify: `src/configure/page/index.html`, `src/configure/page/app.ts`, `src/configure/page/styles.css`

**Interfaces:**
- Consumes : API de la tâche 8, `renderApp` de la tâche 10.

- [ ] **Step 1: `styles.css`** : coller les tokens des quatre fichiers du DS (sans `fonts.css`), puis les styles des composants repris de la maquette `commands.html`, réécrits avec `var()` seulement.
- [ ] **Step 2: `app.ts`** : jeton lu dans `location.search`, rangé en `sessionStorage` (relu de là après un rechargement), puis retiré de la barre d'adresse (`history.replaceState`) ; `fetch` avec `x-idnma-token` et `content-type: application/json` ; `EventSource('/api/events?token=…')` ; délégation d'événements sur `data-action` ; champs envoyés au `change` (la bande de commande suit la clé et le nom d'engine à chaque `input`, par `commandLine`) ; `Copy` par `navigator.clipboard.writeText` ; `⌘S` / `Ctrl-S` → Save ; `beforeunload` si `dirty` ; à `visibilitychange` visible → `GET /api/state` ; refus (`409`) affiché sous le contrôle ; focus rendu par `data-focus-id`.
- [ ] **Step 3: Vérifier** : `bun run typecheck 2>&1 | tee /tmp/idnma-t11-tsc.log` sans erreur (si les types DOM manquent, ajouter `/// <reference lib="dom" />` en tête d'`app.ts` et de `render.ts`) ; `bun test 2>&1 | tee /tmp/idnma-t11-all.log` : toute la suite PASS.
- [ ] **Step 4: Recette visuelle** : `IDNMA_CONFIG_DIR=<dossier temporaire avec une copie de romain.yml> bun src/cli.ts configure --no-open`, ouvrir l'URL dans Chrome sans tête (`--headless=new --window-size=1340,900 --screenshot=…`) pour quatre captures : vue Agent `deepseek-flash`, vue Provider `lmstudio` sur la fixture AC-6, menu Provider ouvert, fichier neuf ; puis la session principale (pas l'exécutant) lance `/erom-vision:gate-vision ds=application` sur ces captures. Verdict FAIL → corriger et refaire.
- [ ] **Step 5: Commit** `git add src/configure/page && git commit -m "feat(configure): interactive page with the application design system"`

### Task 12: Installation et documentation

**Files:**
- Modify: `scripts/install.sh` (étape « Creating ~/.idnma.yml if missing » retirée ; « Next steps » : `1. Describe your agents:  idnma configure`)
- Delete (`trash`) : `scripts/install-config.ts`, `tests/install-config.test.ts`
- Modify: `README.md` (l.67 : plus de création du fichier ; l.90 : `idnma configure` à la place de `bun scripts/install-config.ts` ; section courte « Configure your agents » près de la l.152 ; lien vers `.idnma.example.yml` conservé)

- [ ] **Step 1: Modifier** l'installeur et le README ; retirer les deux fichiers par `trash`.
- [ ] **Step 2: Vérifier** : `grep -rn "install-config" scripts README.md src tests` ne renvoie rien ; `bash -n scripts/install.sh` sans erreur ; `bun test 2>&1 | tee /tmp/idnma-t12-all.log` : PASS.
- [ ] **Step 3: AC-14 sur la VM Linux de recette** si elle est recréée (mode d'emploi `.claude/notes/vm-linux-orbstack.md`), sinon sur le Mac avec un `HOME` temporaire : après l'installeur, `test ! -e "$HOME/.idnma.yml"` et message final lu ; avec un `~/.idnma.yml` existant, `cmp` avant/après. Si l'exécution réelle n'est pas faite, le rapport le dit.
- [ ] **Step 4: Commit** `git add -A scripts README.md tests && git commit -m "feat(install): leave ~/.idnma.yml to idnma configure"`

### Task 13: Passe d'acceptation

- [ ] **Step 1:** Parcourir AC-1 à AC-14 de la spec ; pour chacun, noter la vérification faite et sa sortie réelle (fichiers `/tmp/idnma-t*.log`), ou « non joué » avec la raison.
- [ ] **Step 2: Sur le vrai chemin, avec Romain** : AC-1 (`idnma configure` sur son `~/.idnma.yml`), AC-2 (`cp` puis Save sans changement puis `cmp`), AC-4 (commande copiée collée dans un pane tmux), AC-13 (œil de Romain après le juge vision).
- [ ] **Step 3:** Revue finale de la branche (Opus, effort xhigh), puis feu vert de Romain, puis avance rapide sur `main`.
