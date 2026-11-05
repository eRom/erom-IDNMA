---
status: proposed
date: 2026-11-05
---

# IdnmA : `idnma configure`, le builder de `.idnma.yml` (design)

Intent record : `docs/superpowers/intents/2026-11-05-idnma-configure-intent.md`. Maquette validée (« la commande comme titre ») : `.superpowers/brainstorm/42320-1793874589/content/commands.html` (hors dépôt, ignoré par git).

## 1. Intention

Le dépôt est public : un nouvel utilisateur doit pouvoir écrire son premier `~/.idnma.yml` sans connaître YAML, les ancres ni les options de chaque harnais, et Romain doit pouvoir maintenir le sien (18 agents, presets, ancres, alias, commentaires) sans que l'outil l'abîme. `idnma configure` ouvre une page locale où l'on règle les agents, et où **chaque engine a pour titre la commande qui sert à le tester** (`idnma run deepseek-flash --engine opencode`). L'app ne lance rien : elle lit, valide et écrit le fichier.

## 2. Objectifs, non-objectifs, anti-objectifs

- Objectifs : créer, modifier, dupliquer et supprimer des agents et leurs engines ; créer et modifier des presets rangés en Providers et Options ; montrer la commande de test de chaque engine, avec un bouton de copie ; valider en direct avec les mêmes règles que `idnma run` ; écrire un fichier identique à l'octet près hors des endroits modifiés.
- Non-objectifs : lancer un agent ; lire un fichier d'env ou l'environnement pour résoudre une `$VARIABLE` ; vérifier qu'une variable existe ; détecter les harnais installés ; afficher le YAML ; modifier `info` ou `cell` ; gérer les `presets` dont la forme n'est ni une table de chaînes ni une liste de chaînes (affichés, pas modifiables).
- Anti-objectifs : perdre une ancre, un alias, une clé de fusion `<<`, un commentaire ou le style en ligne d'une liste ; afficher ou journaliser la valeur d'une variable d'environnement ; écraser une modification faite à la main pendant que l'app était ouverte ; accepter une requête d'une autre origine que la page servie.

## 3. Contraintes

- TypeScript sous Bun (`engines.bun >= 1.4.0`), dépendances actuelles `yaml` et `zod`. Toute nouvelle dépendance d'exécution se justifie dans le plan.
- Identifiants en anglais, commentaires et textes de CLI en français, comme le reste du dépôt.
- macOS 26 et plus ; Linux comme pour le reste d'idnma (même comportement, ouverture du navigateur par `xdg-open`).
- Interface : profil **Application** d'erom-design (dark uniquement, blanc à opacité, accents système à sens fixe, contrôles de 28 px, filets inset, pas de cards, pas d'animation, SF Pro et SF Mono). Tokens à reprendre de `/Users/recarnot/dev/erom-design-system-application/design-system/tokens/*.css` (export `8d8ee42`), consommés par `var()`, jamais en dur. Les composants JSX du DS sont une référence visuelle : la page rend de vrais `<button>`, `<input>` et `<select>` utilisables au clavier.
- Polices : la pile système du DS (`-apple-system`, `ui-monospace`…) ; `tokens/fonts.css` et ses `.otf` SF Pro ne sont pas repris (fichiers Apple non redistribuables dans un dépôt MIT).
- Texte de l'interface en anglais (règle du DS Application, et langue du README) ; la CLI garde le français.
- Note pour les briefs d'exécution : dans la sortie des outils, `[REDACTED:env_secret]` masque les valeurs `ANTHROPIC_AUTH_TOKEN` de `~/.idnma.yml`, qui sont `"lmstudio"` et `"$OPENROUTER_API_KEY"` (vérifié par `grep -c`). Un exécutant ne recopie jamais le masque ; il vérifie par `grep -c` sur le littéral.
- Rien n'est écrit sur le disque avant un Save explicite.

## 4. Modèle de données vu par l'app

Le format du fichier ne change pas. L'app lit ce qu'`idnma run` lit déjà, et range le reste par sa forme.

**Agent = modèle.** Une entrée de `agents:` : sa clé (ce qu'on tape après `idnma run`), `label` (obligatoire dans l'app), `avatar` (facultatif, une chaîne libre : `gemini.png` dans le fichier de Romain, `claude`, `gemini`, `codex` dans l'exemple ; saisie dans un champ texte ; aucune image livrée, aucun aperçu, aucun parcours de dossier ; l'avatar affiché dans l'app est l'initiale du label sur fond neutre), `engines`. `info` et `cell` appartiennent à IdemA : conservés tels quels, jamais écrits pour un nouvel agent ; `info` s'affiche en sous-titre de l'en-tête d'agent quand il existe.

**Engine.** Une entrée de `engines:` : `harness` (`claude`, `codex`, `grok`, `agy`, `opencode`, `dst`), `model`, `options`, `env`. L'engine `default` est celui de `idnma run <clé>` ; les autres se lancent par `--engine <nom>`.

**Presets, rangés par leur forme :**
- **Provider** : un preset dont la valeur est une table de chaînes (un gabarit d'env, comme `ollama`). Un engine l'utilise par `env: { <<: *ollama }`, plus ses propres clés.
- **Option set** : un preset dont la valeur est une liste de chaînes (comme `claude-max`). Un engine l'utilise par `options: *claude-max`.
- Toute autre forme : listée à part, en lecture seule, avec un signalement.

**Presets fournis (built-in).** Quatre presets livrés avec idnma, valeurs reprises de `.idnma.example.yml` mis à jour par Romain le 05/11 (source de vérité ; son fichier personnel ajoute `CLAUDE_CODE_ATTRIBUTION_HEADER` à lmstudio, ce qui reste son choix) :

| Nom | Catégorie | Valeur |
|---|---|---|
| `ollama` | Provider | `ANTHROPIC_BASE_URL: "http://localhost:11434"`, `ANTHROPIC_AUTH_TOKEN: "ollama"`, `ANTHROPIC_API_KEY: ""` |
| `lmstudio` | Provider | `ANTHROPIC_BASE_URL: "http://localhost:1234"`, `ANTHROPIC_AUTH_TOKEN: "lmstudio"`, `ANTHROPIC_API_KEY: ""` |
| `openrouter` | Provider | `ANTHROPIC_BASE_URL: "https://openrouter.ai/api"`, `ANTHROPIC_AUTH_TOKEN: "$OPENROUTER_API_KEY"`, `ANTHROPIC_API_KEY: ""` |
| `claude-max` | Option set | `[--effort, max, --dangerously-skip-permissions]` |

Un fichier neuf est créé avec ces quatre presets dans `presets:`. Dans un fichier existant, un built-in absent reste proposé dans les menus et dans les onglets (marqué « Built-in », non encore écrit) ; il est ajouté à `presets:` au premier usage ou à la première modification. Un preset du fichier qui porte le nom d'un built-in est marqué « Built-in » mais garde la valeur du fichier.

## 5. L'écran

Maquette de référence : `commands.html` (deux états : un agent, un provider). Le texte de l'interface est en anglais (§3). Le menu Avatar et les pastilles colorées de la maquette sont de la décoration : le champ est un texte libre (§4).

**Barre d'outils.** Nom du produit en texte brut, chemin du fichier en mono, état de validation (point vert et « Valid · 18 agents », ou point rouge et « N issues »), Revert (secondaire), Save `⌘S` (seule action primaire bleue). Pour un fichier neuf, le chemin porte la mention « New file » et le bouton s'intitule « Create ».

**Barre latérale.** Un contrôle segmenté à trois onglets : **Agents** (nombre), **Providers** (nombre), **Options** (nombre). Agents : une rangée par agent dans l'ordre du fichier, avatar (initiale si pas d'image connue), `label`, et en méta le harnais de l'engine `default` suivi de `+N` s'il en a d'autres ; un point rouge si l'agent porte une erreur. En bas, « + Add agent ». Providers et Options : une rangée par preset, marque « Built-in » le cas échéant, point rouge en cas d'erreur, « + Add provider » ou « + Add option set ».

**Vue Agent.**
- En-tête : avatar, `label` en titre, `info` en sous-titre s'il existe, actions Duplicate et Delete.
- Identité : trois champs côte à côte, Label, Key (mono), Avatar.
- « Engines » et « + Add engine ». Chaque engine est un bloc séparé du précédent par un filet, sans cadre :
  - **Titre = commande de test**, dans une bande en retrait façon terminal : `❯ idnma run <clé>` pour `default` (avec la mention « default »), `❯ idnma run <clé> --engine <nom>` pour les autres, bouton Copy qui copie exactement cette ligne. Le nom de l'engine se modifie dans cette ligne ; la clé de l'agent se modifie dans le champ Key et la ligne suit à chaque frappe.
  - Réglages, selon le harnais : Harness (menu) ; **Provider** (menu, harnais `claude` seulement : « Anthropic » pour aucun proxy, chaque Provider avec son nombre d'agents, « Custom env… », « Edit providers… ») ; **Options** (menu des option sets, ou liste libre en jetons pour « Custom ») ; **Model** (champ mono ; pour `dst`, remplacé par la mention que le modèle se choisit dans dst avec `/model` ; pour `opencode`, forme `<fournisseur>/<modèle>`) ; **Env** (paires clé/valeur propres à l'engine, repliées s'il n'y en a pas).
  - Une action « Make default » sur un engine non `default` échange les noms des deux engines.
- **Un preset partagé ne se modifie jamais depuis un engine.** Sur un engine, choisir un autre provider ou option set remplace l'alias ; choisir « Custom » (options) ou « Custom env… » détache l'engine en recopiant les valeurs du preset comme point de départ. Le contenu d'un preset ne se modifie que dans son onglet, où « Used by » montre l'effet. Un engine claude qui pose `ANTHROPIC_BASE_URL` lui-même, sans `<<`, s'affiche en « Custom env… ».
- **Changer le harnais** retire ce que le nouveau harnais n'utilise pas : quitter `claude` retire le `<<` du provider ; les options repartent vides (les flags sont propres à chaque harnais) ; passer à `dst` retire `model`. Les clés d'env propres à l'engine restent. Revert rend l'état d'avant. Un engine non claude qui porte déjà un `<<` l'affiche en tête de sa section Env (« << ollama »), avec une action pour le retirer.
- **Valeurs liées par ancre.** Un champ dont la valeur porte une ancre (`model: &glm …`) ou est un alias (`ANTHROPIC_DEFAULT_OPUS_MODEL: *glm`) s'affiche « linked », en lecture seule, avec les autres endroits qui partagent la valeur et une action « Unlink » qui remplace l'alias par son texte (et retire l'ancre devenue inutile).
- Aucun aperçu YAML, aucun panneau de droite.

**Vue Provider.** Titre, marque Built-in, « Environment » : paires clé/valeur en mono, « + Add variable ». Une valeur est écrite telle que tapée ; une `$VARIABLE` reste une référence (texte d'aide en ce sens). « Used by » : la commande de test de chaque engine qui utilise ce provider, avec Copy.

**Vue Option set.** Titre, marque Built-in, la liste des options en jetons modifiables et réordonnables, « Used by » comme pour un provider.

**Un fichier qui ne se lit pas.** Si le YAML ne se parse pas, la page affiche l'erreur du parseur (ligne et colonne), le chemin, et un bouton Reload ; rien n'est modifiable tant que le fichier n'a pas été corrigé à la main.

**Duplicate.** Crée un nouvel agent à la suite, avec les mêmes engines et le même avatar, sans `info` ni `cell`, une clé `<clé>-copy` et un label `<label> copy` sélectionnés pour être réécrits (le 05/11, `oss20` copié à la main de `luna` avait gardé label et info de l'original).

**Delete.** Retire l'agent ou l'engine de la copie en mémoire ; Revert le rend tant que rien n'est sauvé.

## 6. Validation

**Une seule source de règles.** Aujourd'hui, le schéma est dans `src/config/network.ts` (`EngineSchema` strict, `AgentSchema`) mais quatre règles ne vivent que dans `runAgent` (`src/run/run.ts:322-341`) : flags qui sortent Codex de son serveur partagé (`CODEX_EMBEDDED_FLAGS`), flags refusés par opencode (`parseOpencodeArgv(...).refused`), `model` en `<fournisseur>/<modèle>` pour opencode (`parseModelRef`, `run.ts:236`), pas de `model` ni d'option refusée pour dst (`DST_MODEL_REASON`, `dstRefusal`). Ces contrôles qui ne dépendent que de l'engine sont extraits dans un module pur de `src/config/` (par exemple `engineIssues(engine)`), appelé par `runAgent` pour le contenu du fichier et par l'app ; les contrôles des arguments tapés (`a.passthrough`) restent dans `runAgent`. Le périmètre est **tout** contrôle de `runAgent` et de `prepareOpencode` qui ne lit que l'engine, avec ses priorités exactes : pour opencode, un `-m` dans les options l'emporte sur `model:` (`parsed.model ?? engine.model`), un `-s` ou un `-m` mal formé est refusé. Ce qui dépend du disque, du réseau ou du service (dossier positionnel d'opencode, présence du plugin dst, modèle connu du service) reste hors du module. Les classes d'erreur (`ConfigError`, `UsageError`) et les messages actuels sont conservés : `tests/run.test.ts` passe sans modification. Critère : un fichier que l'app dit valide est accepté par `loadAgentEngine` et par ces contrôles pour chacun de ses engines, et réciproquement.

**Règles propres à l'app** (en plus) : `label` présent et non vide ; clé d'agent non vide, unique, de forme `[A-Za-z0-9._-]+` et ne commençant pas par `-` (elle se tape en argument) ; nom d'engine de même forme, unique dans l'agent ; valeurs d'env et d'options en texte (un nombre YAML comme `0` est une erreur, correction proposée « Quote it ») ; tout alias pointe vers une ancre existante. Avertissement, non bloquant : deux agents portent le même `label`.

**Moment.** *(Écart assumé à la tâche 1 du plan.)* La validation tourne côté serveur, à chaque opération, avec le module partagé `src/config/engine-rules.ts` ; le serveur renvoie les erreurs à la page, qui ne valide rien elle-même. Raisons : un seul runtime, aucun module Node à empaqueter pour le navigateur (`dst-argv.ts` lit le disque), tout testable par `bun test`. Le serveur revalide au Save.

**Affichage.** L'erreur apparaît là où elle se corrige : point rouge sur la rangée de l'agent ou du preset, anneau rouge sur le champ, message sous le champ. Le compte total est dans la barre d'outils. Save reste possible avec des erreurs : `idnma run` valide agent par agent, un agent cassé n'empêche pas d'en lancer un autre.

## 7. Lecture et écriture du fichier

- Lecture : `networkPath()` (respecte `IDNMA_CONFIG_DIR`), `parseDocument(text, { merge: true })`.
- Toute modification passe par l'AST du `Document` de la lib `yaml`, jamais par un objet JavaScript reconverti. Écriture : `doc.toString({ flowCollectionPadding: false })`.
- Sonde du 05/11 sur le fichier de Romain (`yaml` installé dans le dépôt) : sans modification, la sortie est identique à l'octet près ; avec trois modifications (un label, une valeur d'env passée en `"0"`, un engine ajouté), `diff` ne montre que ces lignes, ancres, alias, `<<` et commentaires intacts. Sans `flowCollectionPadding: false`, chaque liste en ligne prend des espaces (`[ --auto ]`).
- Un nœud créé par `doc.createNode` sort en style bloc : une liste d'options nouvelle suit le style majoritaire des listes d'options déjà présentes dans le fichier (en ligne chez Romain, en bloc dans `.idnma.example.yml`), en ligne pour un fichier neuf ; les valeurs d'env sont écrites entre guillemets doubles.
- Sonde refaite par le relecteur du 05/11 : l'aller-retour sans modification est aussi identique à l'octet près sur `.idnma.example.yml`.
- **Ancres.** Un nœud qui porte une ancre (`&nom`) se modifie en place (sa `value`), jamais par remplacement, sinon l'ancre disparaît et les alias pointent dans le vide. Supprimer un agent, un engine ou un preset dont une ancre est utilisée ailleurs est refusé, avec la liste des utilisateurs. Renommer un preset renomme son ancre et tous ses alias. *(Écart assumé à la tâche 1 du plan.)* Renommer la clé d'un agent ou d'un engine ne casse aucune ancre, car les ancres vivent sur les valeurs : seules les suppressions sont gardées (AC-12 en tient compte).
- Renommer une clé (agent, engine, preset) remplace le nœud de clé de la paire, à sa place, sans déplacer la paire.
- Ordre : conservé ; un nouvel agent va en fin de `agents:`, un nouveau preset en fin de `presets:`, qui reste avant `agents:`.
- **Écriture atomique** : fichier temporaire dans le même dossier, puis `rename`, mode du fichier d'origine conservé (`0644` pour un fichier neuf).
- **Modification concurrente** : l'app garde l'empreinte du texte lu. Au Save, le serveur relit le fichier ; s'il a changé, il refuse d'écrire et la page propose Reload, qui abandonne les modifications de l'app. Pas de fusion. (Le 05/11, le fichier a changé trois fois sur le disque pendant la session de brainstorming.)

## 8. Serveur local et sécurité

- `Bun.serve` sur `127.0.0.1`, port libre choisi par le système.
- Jeton aléatoire de 32 octets dans l'URL imprimée. *(Écart assumé à la tâche 1 du plan.)* Pas de cookie : le jeton passe par l'en-tête `x-idnma-token` (et `?token=` pour le flux SSE), la page le garde en `sessionStorage` pour survivre à un rechargement. La page et ses fichiers statiques ne portent aucune donnée et ne sont pas gardés par le jeton ; toutes les routes `/api/` le sont (403 sans jeton valide).
- En-tête `Host` restreint à `127.0.0.1:<port>` et `localhost:<port>` (rebinding DNS) ; requête modifiante dont l'`Origin` n'est pas celle de la page : 403. Pas de CORS.
- API minimale : lire le fichier (texte et empreinte), écrire (texte et empreinte de base). Le serveur ne lit jamais l'environnement pour le renvoyer, ne lit aucun fichier d'env, ne lance aucun processus hormis l'ouverture du navigateur.
- Cycle de vie : la page garde une connexion ouverte (SSE ou WebSocket) ; quand plus aucune page n'est connectée pendant 10 secondes (marge pour un rechargement), le serveur s'arrête ; Ctrl-C l'arrête aussitôt. Modifications non sauvées à la fermeture de l'onglet : demande de confirmation native du navigateur (`beforeunload`).

## 9. CLI

`idnma configure [--no-open]`, ajoutée à `MAIN_HELP` et dotée de son `--help`. Elle imprime en français l'URL complète (jeton compris) et la façon d'arrêter ; elle ouvre le navigateur par défaut (`open` sur macOS, `xdg-open` sur Linux) sauf avec `--no-open`. Codes de sortie habituels (0, 1, 2).

## 9 bis. Premier lancement et installation

Choix de Romain du 05/11 (option « a ») : `idnma configure` devient l'accueil d'un nouvel utilisateur.

- `scripts/install.sh` ne crée plus `~/.idnma.yml` ; son message final dit de lancer `idnma configure`. Un `~/.idnma.yml` existant n'est jamais touché.
- `scripts/install-config.ts`, dont c'était le seul rôle, est retiré, avec sa mention dans le README (installation manuelle).
- Le README remplace « creates `~/.idnma.yml` from the example » (installation, désinstallation) par l'appel à `idnma configure`, et gagne une courte section sur la commande.
- `.idnma.example.yml` reste dans le dépôt comme documentation du format (lien du README conservé). Version du 05/11 : 5 agents, 6 engines, quatre presets, aucune valeur liée par ancre ; passée dans les validateurs d'idnma le 05/11, aucune erreur.

## 10. Architecture du code

- `src/config/` : le module de règles partagé (§6), `src/config/engine-rules.ts` (tâche 1 du plan), importé par `runAgent` et par le serveur de l'app. *(Écart assumé.)* Il n'est pas importé par la page : il réutilise `dst-argv.ts`, qui lit le disque. L'état du fichier (texte, `Document`, erreurs) est tenu par le serveur ; la page ne fait que l'afficher et envoyer des opérations.
- `src/configure/` : le serveur (jeton, garde-fous, cycle de vie), les opérations sur le `Document` (lecture, modifications typées, écriture), les presets built-in, et la page (`index.html`, son script, sa feuille de styles avec les tokens du DS).
- `src/cli.ts` : la commande `configure`.
- La page est servie par le bundler HTML de Bun (à vérifier dans le brief avant plan : import d'un `.html` dans `Bun.serve` sous Bun 1.4.0). Pas de framework imposé ; s'il en faut un, le plan le justifie.

## 11. Laissé au builder

Découpage des modules et noms exacts ; forme de l'API HTTP ; SSE ou WebSocket ; framework de la page ou DOM direct ; réordonnancement des agents (glisser ou non) ; détail des textes d'aide ; raccourcis clavier au-delà de `⌘S`.

## 12. Limites acceptées

- Un `<<` vers plusieurs presets (`<<: [*a, *b]`) s'affiche, mais l'engine concerné passe en lecture seule.
- Les commentaires attachés à un nœud supprimé partent avec lui.
- Un fichier en fins de ligne CRLF modifié est réécrit en LF.
- Aucune vérification que le modèle existe chez le provider ni que le harnais est installé.

## 13. Arbitrages

- **Serveur Bun local + navigateur.** Battu : Electron (un second programme à livrer et signer pour un outil public, environ 150 Mo) ; app Rust (nouvelle chaîne de compilation pour éditer un fichier).
- **« La commande comme titre ».** Battu : A, Inspector (liste, formulaire, aperçu commande/YAML) et C, tableau + tiroir, puis leurs reprises A' (familles par `label`) et C' (matrice variantes × harnais), jugées insuffisantes par Romain ; B, formulaire + YAML synchronisés, écartée (« poubelle »). Le fichier du 05/11 a rendu chaque `label` unique (agent = modèle), ce qui retire la notion de famille qui portait A' et C'.
- **Presets rangés par leur forme, sans changer le format du fichier.** Battu : ajouter des sections `providers:` et `options:` au YAML (changement de format pour tous les utilisateurs, et `idnma run` à adapter).
- **Validation partagée avec `idnma run`.** Battu : un validateur propre à l'app (deux sources de règles qui divergeront, et un « valide » qui ne garantit rien).
- **Save permis avec des erreurs.** Battu : Save bloqué (empêche d'enregistrer un travail en cours alors qu'`idnma run` tolère un agent cassé parmi d'autres).
- **Refus en cas de modification concurrente.** Battu : fusion automatique (complexe, et un mauvais résultat abîme le fichier de Romain).
- **Interface en anglais.** Battu : en français, comme la CLI (le DS Application prescrit l'anglais, et le README public est en anglais).
- **Preset partagé modifié seulement dans son onglet ; « Custom » détache par copie.** Battu : modifier le preset depuis l'engine (changerait en silence les 11 agents qui utilisent `claude-max`) ; « Custom » parti d'une liste vide (perd le proxy d'un engine claude, qui partirait alors vers Anthropic).
- **Changer de harnais nettoie.** Battu : garder provider et options en état caché (l'env réel de l'engine différerait de ce que l'app montre).
- **L'installeur ne crée plus le fichier ; `idnma configure` accueille (choix de Romain).** Battu : l'installeur copie l'exemple réécrit, que `configure` ouvre (le nouvel utilisateur part des agents de quelqu'un d'autre) ; rien ne change (l'exemple d'alors liait des valeurs par ancres, en lecture seule dans l'app).
- **Avatar en texte libre, sans image livrée.** Battu : livrer des images (logos de marques dans un dépôt public) ou une table nom → couleur en dur.

## Critères d'acceptation

**AC-1 - Lancement.** Quand Romain tape `idnma configure`, alors le navigateur s'ouvre sur la page, qui montre ses 18 agents dans l'onglet Agents, et le terminal affiche l'URL avec son jeton. *Vérifié par* : lancement sur le Mac de Romain, capture de la page ; `lsof -iTCP -sTCP:LISTEN -P | grep <port>` montre `127.0.0.1` seulement.

**AC-2 - Aller-retour fidèle.** Quand on ouvre le fichier de Romain et qu'on sauve sans rien changer, alors le fichier est identique à l'octet près. *Vérifié par* : `cp ~/.idnma.yml /tmp/x && <Save> && cmp ~/.idnma.yml /tmp/x` ; test sur une copie de ce fichier en fixture.

**AC-3 - Modification chirurgicale.** Quand on change le modèle d'un engine, renomme un engine ou ajoute un engine, alors `diff` entre avant et après ne montre que les lignes concernées ; ancres, alias, `<<`, commentaires et listes en ligne sont intacts. *Vérifié par* : tests sur fixture (`diff` attendu ligne à ligne) ; une fois sur le fichier réel, `diff` lu par Romain.

**AC-4 - Commande titre.** Quand on renomme l'engine `opencode` de `deepseek-flash` en `oc`, alors son titre devient `❯ idnma run deepseek-flash --engine oc` avant le Save, et après le Save la ligne copiée, collée dans un pane tmux, lance opencode avec le modèle de cet engine. *Vérifié par* : recette par Romain dans un pane tmux ; test de la fonction qui construit la ligne.

**AC-5 - Parité de validation.** Quand un engine enfreint une règle d'`idnma run` (clé inconnue, harnais hors liste, valeur d'env numérique, modèle opencode sans `/`, option refusée par opencode, flag qui sort Codex de son serveur, `model` sur dst), alors l'app le signale sur l'agent et sur le champ, et `idnma run` refuse ce même fichier pour cet engine ; un fichier que l'app dit valide passe `loadAgentEngine` et les contrôles d'engine pour tous ses engines. *Vérifié par* : tests table par règle sur le module partagé (`tests/engine-rules.test.ts`) et `tests/run.test.ts` inchangé. *(Écart assumé à la tâche 1 du plan.)* La parité est garantie par construction (`runAgent` et l'app appellent les mêmes fonctions), pas par un test qui traverse `runAgent` avec chaque fixture.

**AC-6 - Valeur numérique.** Quand le fichier contient `CLAUDE_CODE_ATTRIBUTION_HEADER: 0` dans un provider, alors la barre affiche « 1 issue », le provider porte un point rouge, et « Quote it » écrit `"0"` ; après le Save, `idnma run oss20` ne refuse plus le fichier. *Vérifié par* : fixture reprenant le fichier de Romain du 05/11 à 14 h ; test du validateur et de l'écriture.

**AC-7 - Premier lancement.** Quand un nouvel utilisateur lance `idnma configure` sans `~/.idnma.yml` (cas normal après installation), alors la barre affiche « New file », l'onglet Providers montre ollama, lmstudio et openrouter, l'onglet Options montre claude-max, tous « Built-in » ; après création d'un agent et Create, le fichier contient les quatre presets et l'agent, et `loadAgentEngine` l'accepte. *Vérifié par* : test sur dossier temporaire (`IDNMA_CONFIG_DIR`) ; recette visuelle.

**AC-14 - Installation sans fichier.** Quand `scripts/install.sh` s'exécute pour un utilisateur sans `~/.idnma.yml`, alors aucun `~/.idnma.yml` n'est créé et le message final nomme `idnma configure` ; un `~/.idnma.yml` existant reste identique à l'octet près. *Vérifié par* : exécution de l'installeur avec un `HOME` temporaire (ou sur la VM Linux de recette), `test ! -e "$HOME/.idnma.yml"`, message lu ; `cmp` sur un fichier existant.

**AC-8 - Aucune valeur d'environnement exposée.** Quand le serveur tourne avec `OPENROUTER_API_KEY` fixé à une valeur témoin, alors aucune réponse HTTP ne contient cette valeur, et `$OPENROUTER_API_KEY` est écrit tel que tapé. *Vérifié par* : test qui démarre le serveur avec la valeur témoin et parcourt toutes les routes.

**AC-9 - Modification concurrente.** Quand le fichier change sur le disque après l'ouverture de la page, alors Save refuse, le fichier garde le contenu écrit à la main, et la page propose Reload. *Vérifié par* : test (écriture externe entre lecture et Save) ; recette à la main.

**AC-10 - Origine et jeton.** Quand une requête arrive sans jeton ni cookie, avec un `Host` autre que `127.0.0.1:<port>` ou `localhost:<port>`, ou avec une `Origin` étrangère sur une route modifiante, alors le serveur répond 403 et n'écrit rien. *Vérifié par* : tests HTTP sur le serveur démarré ; `curl -H 'Host: evil.test'` en recette.

**AC-11 - Arrêt.** Quand on ferme le dernier onglet, alors le serveur s'arrête en moins de 15 secondes et libère son port ; Ctrl-C l'arrête aussitôt. *Vérifié par* : test du cycle de vie (connexion fermée, délai) ; `lsof` après fermeture en recette.

**AC-12 - Ancres protégées.** Quand on supprime un preset, un agent ou un engine dont une ancre est utilisée ailleurs, alors l'app refuse en nommant les utilisateurs ; renommer un preset renomme son ancre et ses alias (renommer la clé d'un agent ou d'un engine ne casse aucune ancre et n'est pas gardé). *Vérifié par* : tests sur fixture.

**AC-13 - Rendu.** Quand la page est ouverte sur le fichier de Romain, alors elle passe le juge vision sur la grille du DS Application, puis Romain la valide à l'œil. *Vérifié par* : `/erom-vision:gate-vision ds=application` sur des captures de l'app réelle (vue Agent, vue Provider, menu Provider ouvert, champ en erreur), puis Romain.
