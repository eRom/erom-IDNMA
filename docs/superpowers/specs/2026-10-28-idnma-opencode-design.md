Trace d'intention : [docs/superpowers/intents/2026-10-28-idnma-opencode-intent.md](../intents/2026-10-28-idnma-opencode-intent.md)

# IdnmA : la doublure opencode (design)

Date : 2026-10-28. Statut : proposé. Option A1 retenue par Romain (« A1 go »). Faits de sonde, avec leurs preuves : `.claude/notes/2026-10-28-etude-opencode.md` (faits F1 à F18), scripts et captures dans `.claude/notes/probes/opencode/`. Ce document complète le design principal `2026-10-26-idnma-design.md` : tout ce qu'il ne redit pas (bus, registre, enveloppe, marque de renvoi, nommage, `tagPane`, verrou des noms) s'applique tel quel.

## 1. Intention

opencode devient un pair du bus au même rang que Codex, Grok et agy : `idnma install --agent opencode` le prépare, `idnma run <agent>` le lance dans le pane quand l'engine dit `harness: opencode`. opencode 2.x est une TUI cliente d'un service de fond partagé qui expose une API HTTP + SSE avec une boîte de réception native par session : la doublure opencode est une doublure **API**, de la famille Codex, sans PTY, sans sonnette, sans hooks.

## 2. Objectifs, non-objectifs, anti-objectifs

**Objectifs**
- Un pair écrit à `opencode-<divinité>-<4 base36>` : le message s'affiche dans la TUI, opencode agit, sa réponse finale revient à l'expéditeur.
- Depuis opencode, `idnma peer list` et `idnma peer send` marchent comme chez les autres doublures.
- `idnma install --agent opencode` et `uninstall` sont réversibles à l'octet près.

**Non-objectifs**
- Suivre la session quand Romain fait `/new` ou change de session dans la TUI (option A2, écartée).
- `notify_when_idle` (phase 4 du design principal).
- Un plugin opencode, serveur ou TUI.
- Prévenir les expéditeurs à la sortie normale de la TUI : aucune doublure ne le fait aujourd'hui (§7.5).

**Anti-objectifs** (ceux du design principal, plus) :
- Toucher au brouillon de Romain ou taper quoi que ce soit dans le pane.
- Modifier `opencode.json`, `tui.jsonc` ou tout autre fichier de config d'opencode, hors le bloc marqué de `AGENTS.md`.
- Démarrer la TUI hors du service partagé (`--standalone`, `--server`) : la doublure ne pourrait plus livrer.

## 3. Contraintes

- opencode **2.2.0** (Homebrew), mesuré le 28/10. L'API HTTP s'annonce « Experimental HttpApi surface », version `0.0.1` (F2). On n'utilise que des opérations hors du préfixe `/api/experimental/`.
- Le palier gratuit d'opencode (Big Pickle et les `opencode/*-free`) répond 429 `provider.free-limit` une fois épuisé (F17) : un tour en échec est un cas nominal.
- Le service de fond est partagé par toutes les TUI opencode de Romain : la doublure y crée au plus une session par lancement, n'y supprime rien et ne le redémarre jamais.
- Mêmes règles de code que le reste du dépôt : Bun, TypeScript, identifiants en anglais, commentaires et messages en français, écritures sur socket Unix en `node:net`.

## 4. Vue d'ensemble

| Pièce | Rôle |
|---|---|
| `src/opencode/service.ts` | Découverte du service (`~/.local/state/opencode/service.json`), démarrage s'il ne tourne pas, client HTTP Basic, résolution de session. |
| `src/opencode/events.ts` | Flux SSE `GET /api/event` : découpe des trames, décodage, filtre `types=`. |
| `src/opencode/courier.ts` | Le livreur : état, propriétaire du tour, politique de livraison, segments, renvoi automatique, reconnexion. |
| `src/run/run.ts` | Branche `opencode` : flags refusés, modèle hors argv, dossier, service, session, lancement de la TUI. |
| `src/cli.ts`, `src/install/` | `INSTALLERS.opencode`, `peer list`, texte de `read`. |

## 5. Configuration

`network.yml` accepte `harness: opencode`. `model` vaut `<fournisseur>/<modèle>` avec un `#<variante>` facultatif, le format de `opencode run --model` (exemples : `opencode/big-pickle`, `ollama-cloud/deepseek-v4.1-flash`, `openrouter/particle-ai/particle-1`). Le fournisseur va jusqu'au **premier** `/` : un id de modèle peut en contenir (`particle-ai/particle-1` chez `openrouter`, vu dans `model.default`). Sans `model`, la session est créée sans modèle et le service applique son défaut, comme la TUI (sondé : `POST /api/session` sans `model` rend une session sans champ `model`). `options` porte les flags de la TUI (`--auto`). `env` atteint le process de la TUI, qui le recopie dans l'environnement de sa session (§6, point 8) : il arrive donc aussi aux commandes de l'agent, bien qu'elles descendent du service (F5). Un secret posé dans l'`env:` d'un engine opencode est visible du shell de l'agent.

```yaml
agents:
  opencode:
    engines:
      default: { harness: opencode, model: opencode/big-pickle }
      deepseek: { harness: opencode, model: ollama-cloud/deepseek-v4.1-flash, options: [--auto] }
```

## 6. `idnma run` sur un engine opencode

Ordre : tout ce qui peut échouer passe avant l'inscription au bus.

1. **Flags refusés**, tapés ou dans l'engine, avant tout effet : `--standalone` et `--server` (même logique que `CODEX_EMBEDDED_FLAGS`, message : « fait démarrer opencode hors de son service partagé : idnma ne pourrait plus lui livrer les messages du bus »).
2. **Lecture de l'argv de la TUI** (opencode 2.2.0, `opencode --help`). Flags à valeur : `-s`/`--session`, `--prompt`, `--server`, `--log-level`, plus `-m`/`--model` (à idnma, point 3). Flags sans valeur : `-c`/`--continue`, `--auto`, `--standalone`, `--wizard`, `--print-logs`. Alias courts pour le remplacement de flags : `-s` → `--session`, `-c` → `--continue`, `-m` → `--model`. Le premier jeton qui n'est ni un flag ni la valeur d'un flag à valeur est l'argument positionnel `<directory>`.
3. **Modèle hors argv.** La TUI n'a pas de `--model` (F12). `buildHarnessArgv` n'injecte pas `--model` pour ce harnais ; un `--model`/`-m` tapé est retiré de l'argv de la TUI et prime sur le `model` de l'engine. Un modèle sans `/` est une erreur d'usage (code 2).
4. **Dossier de travail** : `<directory>` s'il est donné (résolu depuis le dossier courant), sinon le dossier courant. Il sert au registre (`cwd`) et à la session (`location.directory`), comme `-C` chez Codex.
5. **Service.** Lire `~/.local/state/opencode/service.json` (`url`, `pid`, `password`). Fichier absent, illisible ou `pid` mort : lancer `opencode service start`, puis relire le fichier jusqu'à 10 s. Toujours injoignable : opencode se lance quand même, tel que tapé, hors bus et sans inscription, et idnma le dit sur stderr (`idnma : …`), comme Codex quand son daemon ne démarre pas.
6. **Session**, avant l'inscription :
   - `-s <id>` tapé : la doublure sert cette session ; un id qui ne commence pas par `ses` est une erreur d'usage (code 2 ; le service rendrait 400) ; `GET /api/session/{id}` 404 → `POST /api/session { id }` avec le dossier et le modèle.
   - `-c` tapé : `GET /api/session?directory=<dossier>&order=desc`, première session sans `parentID` (une session fille est celle d'un sous-agent) ; aucune → session neuve. `-c` est retiré de l'argv.
   - Sinon : `POST /api/session { location: { directory }, model }` (`model` omis sans modèle), **sans** `id` : l'id généré par opencode garde l'ordre de ses listes. La doublure prend `data.id`.
   - Le modèle d'une session reprise n'est changé que si un modèle a été tapé (`POST /api/session/{id}/model`).
   - Le service accepte à la création un modèle inconnu comme un dossier inexistant (sondé : 200 dans les deux cas, l'échec ne viendrait qu'au premier tour). idnma vérifie donc lui-même, avant toute création : le dossier de travail existe (sinon erreur d'usage, code 2) ; le modèle figure dans `GET /api/model?location[directory]=<dossier>` (liste vue depuis ce dossier, config du projet comprise ; entrée de même `providerID` et `id`, et la variante demandée parmi ses `variants`), sinon erreur d'usage, code 2, `idnma run : modèle inconnu du service opencode : <modèle>`.
   - Réponse d'erreur du service (4xx, 5xx, réseau) : `idnma run` s'arrête, code 1, `idnma : opencode a refusé la session (<message du service>)`. Rien n'est encore inscrit.
7. **Inscription au bus**, inchangée (nom `opencode-<divinité>-<4 base36>`, `tagPane`). L'argv de la TUI devient `opencode -s <id> [options] [arguments restants]` (`-s` et `-c` tapés remplacés par ce `-s`).
8. **Doublure** : `runUnderstudy` sans PTY, stdio hérité, libellé « opencode », et canal de contrôle exporté à la TUI comme pour Grok et agy (`IDNMA_NAME`, `IDNMA_CONTROL_SOCKET`, `IDNMA_CONTROL_TOKEN`, défaut de `runUnderstudy`). **La TUI recopie son propre environnement dans celui de sa session** en s'y attachant, et ce dernier passe aux commandes de l'agent (sondé le 28/10 au soir, `probe-env-tui.ts` et `probe-env-tui2.ts` : une variable posée sur le process de la TUI arrive dans le shell de l'agent ; une variable posée avant par `PUT …/environment` disparaît). Les commandes de l'agent joignent donc la doublure par la voie du jeton existante, sans `PUT …/environment` : idnma n'appelle jamais cette route, que la TUI écraserait.
9. **`beforeSpawn` du livreur** : ouvre le flux SSE, lit l'état initial, puis livre ce qui attend déjà en file. Un échec lève `CourierUnavailableError` (le flux ouvert est refermé) : la TUI démarre sur sa session, hors bus, par le chemin existant de `runUnderstudy`.
10. `from-mode="bypass"` si `--auto` est dans les options ou les arguments, `prompting` sinon (`BYPASS_FLAGS.opencode = "--auto"`), à confirmer en recette (§11).

## 7. Le livreur opencode

### 7.1 État et propriétaire du tour

Le livreur ne retient que les événements de **sa** session (`data.sessionID`). États : `idle`, `busy` (une exécution court), `unknown` (avant la lecture initiale, pendant une reconnexion). `session.execution.started` → `busy` ; `session.execution.succeeded|failed|interrupted` → `idle`. État initial et resynchronisation : `GET /api/session/active` (F8). Le statut du registre suit (`busy`/`idle`). `session.idle` et `session.status` ne sont jamais utilisés (jamais émis en sonde, F7).

Tout prompt passe par la boîte d'opencode, y compris ce que Romain tape dans la TUI, au repos comme en plein tour (sondé : `inbox.enqueued` en `steer`, sans `metadata`, puis `execution.started` et `inbox.delivered`). Le **propriétaire du tour** est l'auteur de l'élément livré qui l'ouvre : un élément qui porte `metadata.idnma` ouvre un tour de pair, tout autre élément un tour de Romain. Exception : une demande de Romain qui appelle sa propre réponse arrive toujours en élément `user` (prompt tapé, commandes slash). Les éléments `synthetic` (fin d'une commande ou d'un sous-agent de fond, capturé : `<shell … state="completed">`, `metadata.source: "shell"` ; sortie d'un `!cmd` ; `ctrl+b` ; contexte d'éditeur, toujours suivi du `user` de Romain), `compaction` (`<leader>c`) et `move` (`session.cd`) n'en sont pas : leur livraison ne compte pas comme une entrée de Romain et ne change pas le propriétaire (une exécution qu'ils ouvrent garde celui que fixe son démarrage, inconnu, ou pair si un élément `queue` de la doublure attend) (recette du 29/10, défauts D1 et D2). Un type inconnu de la version d'opencode compte, par prudence, comme une entrée de Romain. Propriétaire inconnu (resynchronisation en plein tour) : traité comme un tour de Romain pour `now` et `next`, `later` attend le repos. Exception : une exécution qui démarre pendant qu'un élément `queue` de la doublure attend encore sa livraison est traitée comme un tour de pair jusqu'au premier `inbox.delivered` (un `next` attend), pour qu'un message ne parte pas en `steer` dans le tour qu'il ouvre lui-même. Si ce premier élément livré est un `synthetic`, une `compaction` ou un `move`, le tour reste celui du pair jusqu'à la fin de l'exécution.

### 7.2 Politique de livraison

Une seule requête `POST …/prompt` à la fois, et au plus un élément de la doublure en attente dans la boîte d'opencode. La file des messages reçus reste celle de la doublure (`MessageQueue`) : opencode ne reçoit un message que quand la politique le dit, ce qui garde la règle « un message par tour de pair » du design principal (§7.5).

| État | `now` | `next` (défaut) | `later` |
|---|---|---|---|
| repos | `delivery: "queue"`, ouvre un tour de pair | idem | idem |
| tour de Romain | `delivery: "steer"` + rappel de réponse | `steer` + rappel | attend le repos |
| tour d'un pair | `steer` + rappel | attend la fin du tour | attend la fin du tour |

- Au repos, `queue` et non `steer` : si Romain lance un tour entre la lecture d'état et l'envoi, le message attend la fin de son tour au lieu de s'y mêler (un `queue` démarre un tour au repos, F6).
- Le rappel de réponse est `withReplyHint` (design principal §7.4) ; un renvoi automatique passe tel quel.
- Chaque prompt porte `metadata: { idnma: { msgId, from } }` (renvoyé dans les événements de la boîte, F6) : c'est ainsi que le livreur reconnaît ses éléments.
- Le corps du prompt est l'enveloppe reçue, telle quelle (design principal §7.3).
- Toute requête HTTP hors flux a un délai de 10 s ; un délai dépassé compte comme une erreur ordinaire.
- `POST …/prompt` en échec : 404 `SessionNotFoundError` (session supprimée par Romain) → la doublure quitte le bus (`rejectQueuedMessages`, libellé « opencode ») ; autre erreur → le message revient en tête de file et repart au prochain événement d'état, au prochain message reçu, ou après 2 s au plus (minuteur à un coup : au repos, aucun événement ne viendrait) ; une deuxième erreur sur le même message lui renvoie `<nom> : message non livré (<message du service>)`.
- `session.inbox.cancelled` d'un élément de la doublure (annulé depuis la TUI) : sa place se libère, son expéditeur reçoit `<nom> : message non livré (annulé dans opencode)`.
- Fin d'exécution `interrupted` alors qu'un élément `queue` de la doublure n'a pas été livré (l'OpenAPI dit que les prompts en file restent garés après une interruption) : la doublure le retire (`DELETE /api/session/{id}/inbox/{inboxID}`), libère sa place et répond `<nom> : message non livré (tour interrompu)`.

### 7.3 Segments et renvoi automatique

Un élément envoyé en `queue` ouvre un **segment de pair** à son `session.inbox.delivered`. Le segment se ferme au `session.inbox.delivered` d'un élément de Romain ou d'un autre élément `queue` de la doublure, ou à la fin de l'exécution. La livraison d'un élément `synthetic`, `compaction` ou `move` avant tout `step.ended` `stop` du segment ne le ferme pas : opencode continue le même tour (capturé, `tests/fixtures/opencode-compaction-mid-turn.jsonl` et `opencode-background-shell-mid-turn.jsonl`). Livré après, il le ferme avec renvoi du dernier texte, comme un élément de Romain (capturé, `opencode-compaction-after-stop.jsonl` : aucune étape ne suit la compaction). Un élément `steer` de la doublure (un `now` livré pendant le tour) ne ferme pas le segment : le pair qui ouvre le tour garde son renvoi, l'autre reçoit le rappel, comme chez Codex. Pendant le segment, le livreur garde le dernier `session.text.ended` (`text`) et note si un `session.step.ended` de `finish: "stop"` est passé.

À la fermeture :
- fin d'exécution `succeeded`, ou élément suivant livré **après** un `step.ended` `stop` du segment : renvoi du dernier texte ; aucun texte → `<nom> : tour terminé sans réponse` ;
- élément de Romain livré **avant** tout `step.ended` `stop` du segment (son prompt tapé en plein tour, sondé : une seule réponse pour les deux) : `<nom> : tour mêlé à une entrée de Romain, pas de réponse automatique` ;
- `session.execution.failed` : `<nom> : tour en échec (<data.error.message>)` (cas du 429, capture `free-limit-failed.events.jsonl`) ;
- `session.execution.interrupted` (`data.reason`, `"user"` sondé) : `<nom> : tour interrompu`.

Un élément envoyé en `steer` n'ouvre pas de segment et ne reçoit jamais de renvoi automatique : l'agent répond par `idnma peer send` (rappel). Un message marqué `[réponse automatique idnma]` ouvre son segment comme les autres, mais ne renvoie rien à sa fin (design principal §7.6). Tout renvoi passe par `sendAutoReply` (marque, adresse `from`).

### 7.4 Coupure du flux

Flux SSE fermé ou en erreur : état `unknown`, aucune livraison. Au bout de 2 s, une reconnexion : relire `service.json` toutes les 200 ms pendant 10 s au plus, jusqu'à un fichier lisible dont le pid vit et dont le flux s'ouvre (l'URL et le mot de passe peuvent changer au redémarrage du service, et le fichier peut désigner un moment l'ancien service), puis relire `GET /api/session/active`. Un segment ouvert avant la coupure renvoie `<nom> : réponse perdue (service opencode redémarré)`. Reconnexion en échec : la doublure quitte le bus (`rejectQueuedMessages`, libellé « opencode ») et le journalise ; la TUI continue sans bus.

### 7.5 Arrêt

`stop()` reste synchrone, comme pour les autres livreurs : il ferme le flux SSE et annule ses minuteurs. À la sortie normale de la TUI, la doublure ne prévient pas les expéditeurs dont le message attend encore (aucune doublure ne le fait aujourd'hui, design principal §7.6). Un élément de la doublure resté dans la boîte d'opencode y sera quand même traité, sans renvoi possible ; il ne peut s'agir que d'un message envoyé au repos qui a croisé un tour de Romain.

### 7.6 Journal

Préfixe `opencode-` : `opencode-service-start`, `opencode-session` (id, repris ou créé), `opencode-deliver` (msgId, `delivery`), `opencode-segment-end` (msgId, issue), `opencode-reconnect`, `opencode-lost`, `opencode-info` (version rendue par `GET /api/info` au démarrage). Jamais de mot de passe, de jeton ni de texte de message.

## 8. CLI côté agent

- `idnma peer send`, `idnma read` : inchangés, voie du jeton (§6, point 8). Le livreur opencode n'a pas de message à rendre à `read` (`read()` rend `null`) ; le texte de `idnma read` sans message, aujourd'hui propre à Codex (`CODEX_THREAD_ID`), couvre aussi opencode quand `OPENCODE_SESSION_ID` est présent : les messages arrivent d'eux-mêmes, chacun comme un tour.
- `idnma peer list` : la filiation n'exclut pas l'appelant opencode (ses shells descendent du service, F5). Ajout : si `IDNMA_CONTROL_SOCKET` est présent, l'entrée dont le pid est celui du nom du socket (`<pid>.sock`) est exclue.

## 9. Installation

Dossier de config d'opencode : `IDNMA_OPENCODE_CONFIG_DIR`, sinon `$XDG_CONFIG_HOME/opencode`, sinon `~/.config/opencode` (opencode suit `XDG_CONFIG_HOME`, vérifié). Absent : « opencode : absent (…), rien installé ».

- `idnma install --agent opencode` : bloc coéquipier en fin de `<config>/AGENTS.md` (`installTeammateLine`, texte commun `TEAMMATE_TEXT`) et skill `generic-idnma-network` dans `<config>/skills/` (`installSkill`). Une ligne de sortie, sur le modèle de Codex.
- `idnma uninstall --agent opencode` : `uninstallTeammateLine` et `uninstallSkill`.
- Les deux skills nomment opencode : la générique le compte parmi ses harnais (Codex, Grok, agy, opencode), la skill Claude rappelle qu'elle ne sert pas chez opencode, qui la voit aussi (F15).

## 10. Limites acceptées

- `/new` ou changement de session dans la TUI : la doublure continue de servir la session de départ, invisible dans le pane, jusqu'à la relance du pane (comme Codex).
- À la sortie, l'environnement de session garde les `IDNMA_*` de la dernière TUI jusqu'à ce qu'une autre TUI s'y attache et le remplace par le sien : entre-temps, un tour lancé par l'API ou depuis une autre interface voit `idnma peer send` échouer proprement (« doublure injoignable »).
- Message en attente à la sortie normale de la TUI : son expéditeur n'est pas prévenu (§7.5).
- Un `synthetic` déclenché par Romain (sortie d'un `!cmd`, fin de sa commande ou de son sous-agent de fond, `ctrl+b`) livré avant le `stop` d'un tour de pair ne le mêle pas : le dernier texte, qui peut en rendre compte, part au pair. Romain le voit dans sa TUI. L'inverse (D2) faisait perdre au pair la réponse à sa propre demande.
- `OPENCODE_API_KEY` est exportée par opencode à chaque commande de l'agent (F4) ; hors idnma.

## 11. Laissé au builder

Découpage du code et des tests, client SSE (fetch de Bun et découpe des trames, ou autre), libellé exact des erreurs d'usage, plafonds, cadence des écritures de `status`.

**Sondé pendant la revue adverse du plan** (`probes/opencode/probe-env-tui.ts`, `probe-env-tui2.ts`) : la TUI remplace l'environnement de sa session par le sien en s'y attachant. Une variable posée par `PUT …/environment` avant `opencode -s <id>` n'arrive pas au shell de l'agent ; une variable posée sur le process de la TUI y arrive. D'où le §6, point 8.

**Sondé le 28/10 au soir** (`probes/opencode/probe-head.ts`, `probe-head2.ts`, captures `head-of-phase*.jsonl`) :
- un prompt tapé par Romain dans la TUI arrive par la boîte en `delivery: "steer"`, sans `metadata` : au repos il ouvre une exécution, en plein tour il se mêle au tour en cours (une seule réponse finale pour les deux) ;
- `PUT …/environment` **remplace** l'environnement (poser `A` puis `B` ne laisse que `B`) et `{ variables: {} }` le vide ;
- `GET /api/event?types=a&types=b` est accepté (200) et ne rend que ces types, plus `server.connected` ;
- `POST …/prompt` sur une session inconnue : 404, `{ "_tag": "SessionNotFoundError", "sessionID", "message" }` ;
- `POST …/interrupt` : `session.execution.interrupted { sessionID, reason: "user" }` ;
- `POST /api/session` sans `model` : session sans champ `model` ; avec un modèle inconnu ou un dossier inexistant : 200, session créée quand même (`probe-badmodel.ts`) ;
- `GET /api/model` : `data` est un tableau d'entrées `{ id, modelID, providerID, variants, enabled, … }` (633 modèles sur la machine de Romain, `opencode/big-pickle` compris).

**Reste à vérifier, en recette seulement** (le service est celui de toutes les TUI de Romain : ne pas le redémarrer sans son accord) : port et mot de passe après `opencode service restart` (AC-11) ; erreur rendue quand le service est arrêté ; `--auto` approuve-t-il aussi les permissions d'un tour ouvert par l'API (étiquette `from-mode="bypass"`) ; `-c` rend-il la même session que le `-c` natif.

## 12. Risques

- API expérimentale et v2 jeune : une mise à jour peut rompre un payload. Les fixtures des tests sont les séquences capturées, et la recette se rejoue à chaque version majeure. `opencode-info` journalise la version.
- Modèles défensifs : l'AGENTS.md de Romain rend le modèle méfiant envers les blocs injectés (F16). Le bloc coéquipier et l'enveloppe doivent suffire, AC-3 le vérifie.
- Skill Claude visible chez opencode (F15) : AC-6 vérifie qu'opencode prend la skill générique.

## Critères d'acceptation

**AC-1 - Installation réversible**
- Comportement : quand Romain lance `idnma install --agent opencode`, alors le bloc coéquipier termine `~/.config/opencode/AGENTS.md` et opencode liste la skill `generic-idnma-network` ; après `idnma uninstall --agent opencode`, `AGENTS.md` est identique à l'octet près et la skill a disparu ; un second `install` d'affilée ne change rien.
- Vérifié par : `cp` avant, `cmp` après ; `opencode api skill.list` filtré sur `generic-idnma-network` ; tests automatisés avec `IDNMA_OPENCODE_CONFIG_DIR` redirigé.

**AC-2 - Lancement et inscription**
- Comportement : quand IdemA lance `idnma run opencode` dans un pane, alors la TUI s'ouvre sur une session neuve, avec le modèle de l'engine affiché sous la zone de saisie, et `opencode-<divinité>-<4 base36>` apparaît en `idle` dans `idnma peer list` d'un autre agent, avec son pane.
- Vérifié par : `tmux capture-pane` ; `idnma peer list` depuis un autre pane.

**AC-3 - Message au repos, réponse automatique**
- Comportement : quand un Claude envoie `SendMessage` à l'agent opencode au repos, alors le message s'affiche dans la TUI comme un tour, opencode le traite, et sa réponse finale arrive chez le Claude, précédée de `[réponse automatique idnma]`.
- Vérifié par : capture du pane opencode ; transcript du Claude.

**AC-4 - Le brouillon de Romain est intouchable**
- Comportement : quand Romain a tapé un brouillon sans Entrée et qu'un message de pair arrive, alors le message est livré et le brouillon reste intact dans la zone de saisie.
- Vérifié par : `tmux send-keys -l` d'un brouillon, envoi d'un message, `tmux capture-pane` avant et après.

**AC-5 - Message pendant un tour de Romain**
- Comportement : quand un message `next` arrive pendant un tour lancé par Romain, alors il entre dans ce tour (`steer`) avec le rappel de réponse, opencode répond au pair par `idnma peer send`, et aucun renvoi automatique ne part.
- Vérifié par : journal (`opencode-deliver` en `steer`) ; transcript du pair (une réponse, sans la marque) ; test automatisé du livreur.

**AC-6 - opencode écrit à ses pairs**
- Comportement : quand Romain demande à opencode « qui est sur le réseau ? » puis « demande à <pair> … », alors opencode lance `idnma peer list`, qui ne le liste pas lui-même, puis `idnma peer send`, jamais `ListAgents` ni `SendMessage`.
- Vérifié par : capture du pane opencode ; réception chez le pair avec `from-name` égal au nom de l'agent opencode ; test automatisé de `peer list` avec `IDNMA_CONTROL_SOCKET` posé.

**AC-7 - Échec d'un tour de pair**
- Comportement : quand le modèle d'opencode répond une erreur (429 du palier gratuit) sur un tour ouvert par un pair, alors le pair reçoit `[réponse automatique idnma]` puis `<nom> : tour en échec (<message d'erreur>)`, jamais le silence.
- Vérifié par : test automatisé qui rejoue `captures/free-limit-failed.events.jsonl` ; en recette, un engine sur un modèle gratuit épuisé.

**AC-8 - Flags hors service refusés**
- Comportement : quand Romain lance `idnma run opencode --standalone` ou `--server <url>`, ou qu'un engine les porte, alors idnma refuse avec la raison, avant toute inscription et sans créer de session.
- Vérifié par : tests automatisés (`run.test.ts`, faux service sans requête reçue).

**AC-9 - Un message par tour de pair**
- Comportement : quand deux messages arrivent pendant qu'opencode est au repos, alors le second n'est envoyé à opencode qu'après la fin du tour du premier, et chaque expéditeur reçoit sa propre réponse.
- Vérifié par : test automatisé du livreur (ordre des `POST …/prompt`) ; en réel, deux `SendMessage`, transcripts des deux expéditeurs.

**AC-10 - Sortie propre**
- Comportement : quand Romain quitte la TUI opencode, alors l'agent disparaît de `idnma peer list`, et son entrée de registre, sa clé et son socket de contrôle n'existent plus.
- Vérifié par : test automatisé ; `ls ~/.claude/sessions/<pid>.* /tmp/idnma-$UID/<pid>.sock` après fermeture.

**AC-11 - Redémarrage du service**
- Comportement : quand le service opencode redémarre pendant que l'agent est au repos, alors la doublure se reconnecte et le message suivant est livré et répondu.
- Vérifié par : `opencode service restart` en recette, avec l'accord de Romain, puis `SendMessage` ; journal `opencode-reconnect` ; test automatisé avec un faux service qui coupe le flux.

**AC-12 - Zéro au repos**
- Comportement : quand aucun message ne circule pendant 10 minutes, alors la doublure n'envoie aucune requête au service hors du flux SSE ouvert.
- Vérifié par : journal sans `opencode-deliver` sur la période ; CPU de la doublure proche de 0 (`ps -o %cpu`).

**AC-13 - Modèle inconnu refusé**
- Comportement : quand l'engine (ou un `--model` tapé) porte un modèle absent de la liste du service, alors `idnma run` s'arrête sur `idnma run : modèle inconnu du service opencode : <modèle>`, code 2, sans inscription au bus, sans session créée, sans TUI lancée.
- Vérifié par : test automatisé (faux service : `GET /api/model` sans ce modèle, aucun `POST /api/session` reçu) ; en réel, `idnma run opencode -m opencode/modele-invente` puis `opencode api session.list` inchangé.
