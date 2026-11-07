---
status: proposed
date: 2026-11-07
---

# idnma : doublure Pi (harnais `pi`)

Objectif (goal de Romain, 07/11) : `idnma run deepseek-flash --engine pi` fonctionne et Claude et Pi se parlent sur le bus.

## 1. Faits sondés (Pi 1.5.0, sonde du 07/11, `scratchpad/probe/events.jsonl`)

- F1 : Pi est un paquet Node (`@earendil-works/pi-coding-agent` 1.5.0, lanceur `~/.pi/agent/bin/pi`, Node `/usr/local/bin/node`). Doc embarquée : `~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/`.
- F2 : `pi -e <fichier.ts>` charge une extension (jiti, TypeScript sans compilation). Elle est rechargée à `/new` (`session_shutdown` reason `new`, puis `session_start` reason `new`, même pid). `-ne` n'écarte pas un `-e` explicite (doc `cli.md`).
- F3 : `--model ollama/deepseek-v4.1-flash:cloud` est pris tel quel : le `:cloud` n'est pas lu comme un niveau de thinking (pied de page « (ollama) deepseek-v4.1-flash:cloud • medium »).
- F4 : Ollama se branche par `<agent-dir>/models.json` (fournisseur `ollama`, `api: openai-completions`, `baseUrl` `http://127.0.0.1:11434/v1`, `apiKey: ollama`). `ollama launch pi --config --model <m>` écrit exactement ce fichier, plus `defaultProvider`/`defaultModel` dans `settings.json` (relevé sous un HOME factice).
- F5 : `pi.sendMessage({ customType, content, display, details }, { deliverAs, triggerTurn })` : au repos avec `triggerTurn`, `before_agent_start` part de façon synchrone pendant l'appel, puis le tour s'ouvre. Le message entre dans le contexte au `message_start` de rôle `custom` (réclamation), `details` n'est pas envoyé au modèle.
- F6 : un `followUp` envoyé en plein tour reste dans le même run : aucun `agent_end` entre la réponse finale du tour en cours (`stopReason: stop`) et le `message_start` du followUp. Un `steer` entre après l'exécution des outils (`turn_end` d'un message `toolUse`).
- F7 : fin réelle : `agent_settled` (`aborted` vrai après Échap). Après Échap pendant un outil, le dernier message assistant porte `stopReason: error`, « This operation was aborted » : seul `aborted` dit l'interruption.
- F8 : Échap rend à l'éditeur l'entrée de l'utilisateur en file, mais **jette en silence** un followUp d'extension en file : jamais réclamé, `hasPendingMessages()` faux au `agent_settled`.
- F9 : entrées de l'utilisateur : événement `input` (`source: interactive`, `streamingBehavior` `steer`/`followUp`/absent) puis `message_start` de rôle `user` ; `!cmd` donne `user_bash`, et son message `bashExecution` entre dans la session sans `message_start` (code de Pi, revue finale).
- F13 (code de Pi 1.5.0, revue finale) : `/new`, `/resume` et `/fork` émettent `session_before_switch` ou `session_before_fork`, puis `teardownCurrent` avorte le tour en cours (`agent_settled` avec `aborted`) avant `session_shutdown`. `/reload` n'avorte rien. `ctx.hasPendingMessages()` ne compte que les entrées en file de l'utilisateur, jamais les messages d'extension. Avec `followUpMode: "all"`, Pi livre toute sa file d'un coup.
- F10 : les commandes du bash de Pi héritent de l'environnement de Pi (`env | grep` dans la sonde) : `idnma peer send` y trouve le canal de contrôle.
- F11 : Pi ne demande aucune permission avant un outil (`security.md` : « it does not ask for approval before every tool call »).
- F12 : contexte global `<agent-dir>/AGENTS.md`, skills `<agent-dir>/skills/` (et `~/.agents/skills/`), dossier d'agent déplacé par `PI_CODING_AGENT_DIR`.

## 2. Décisions

- D1 : **même famille que dst** : une extension chargée dans le process de Pi rejoint le pont de la doublure (socket Unix privé, jeton, pid noyau) et parle le protocole de pont v1 tel quel (`hello`, `state`, `delivered`, `claimed`, `result`, `dropped`, `error` ; `deliver`). Le livreur de dst devient générique (`src/bridge/courier.ts`, paramétré par le harnais pour ses textes et ses événements de journal) ; dst garde exactement ses textes et son journal.
  Battu : livreur pi recopié (560 lignes en double) ; RPC (`pi --mode rpc`), qui retire la TUI du pane.
- D2 : **extension passée par `-e` au lancement**, depuis le checkout qui lance `idnma run`, seulement si la doublure est inscrite. Rien n'est installé dans `~/.pi/agent/extensions`.
  Battu : extension installée dans `~/.pi/agent/extensions/idnma` (chargée par chaque Pi de la machine, inerte hors idnma, il faudrait un contrôle « autre checkout » comme dst).
- D3 : `idnma install --agent pi` pose le bloc coéquipier dans `<agent-dir>/AGENTS.md` et la skill `generic-idnma-network` dans `<agent-dir>/skills/` (agent-dir : `PI_CODING_AGENT_DIR`, sinon `~/.pi/agent`) ; `uninstall` les retire (AGENTS.md rendu octet pour octet), comme opencode.
- D4 : livraison dans Pi par `pi.sendMessage` (`customType: "idnma"`, `display: true`, texte « Team message from <pair>: » puis le message, comme dst), `triggerTurn: true`. Choix du mode, comme dst : au repos `followUp` ; en plein tour de pair `steer` pour `now`, sinon `followUp` ; en plein tour de l'utilisateur ou d'origine inconnue `followUp` pour `later`, sinon `steer` + rappel de réponse.
- D5 : suivi par **segments** de conversation, pas par runs (F6) : un segment s'ouvre à la réclamation d'un message qui ouvre un tour (le nôtre en followUp, ou une entrée de l'utilisateur alors que le dernier message assistant est final) et se ferme au segment suivant ou au `agent_settled`. Une entrée de l'utilisateur (`user`, `bashExecution`) pendant un segment de pair non final le rend mêlé. Résultat : dernier texte assistant du segment ; raison `aborted`/`user` si `agent_settled.aborted`, sinon d'après `stopReason` (`stop` → `completed`, `length` → `max-tokens`, `error` → `error`, autre → `interrupted`).
  Une réponse est complète quand le dernier message assistant n'appelle aucun outil et finit en `stop` ou `length` ; une `error` peut être réessayée et ne clôt le segment qu'au repos. Plusieurs followUp réclamés avant toute réponse (F13, `followUpMode: "all"`) partagent le segment et la même réponse.
- D6 : après un `agent_settled` avorté, un message des nôtres jamais réclamé est rendu `discarded` (F8). Sans abandon, il reste suivi (pas de relivraison, donc pas de doublon). Un repos avorté qui suit `session_before_switch`/`_fork` (F13) est mis de côté pour `session_shutdown`. Un remplacement annulé n'avorte rien (Pi rend la main avant `teardownCurrent`) : l'attente retombe au premier signe que le runtime continue (`agent_start`, `input`, repos sans abandon). Dernier recours, sans `session_shutdown` après 30 s (la grâce du livreur), la mise de côté est lue comme un Échap. Au `session_shutdown` (`/new`, `/resume`, `/fork`, `/reload`, sortie) : segment de pair suivi → `result` `disposed`, non réclamés → `dropped disposed` (relivrés à la nouvelle session), puis fermeture du socket.
- D7 : `from-mode="bypass"` pour Pi, toujours (F11).
- D10 : le pont pi n'admet que l'enfant direct de la doublure (le process de Pi : son lanceur fait `exec`). Une commande du bash de Pi hérite du jeton mais en descend d'un cran : elle est refusée (revue finale, m2). Contrainte : le `pi` du PATH doit faire `exec` (lanceur géré de Pi, Homebrew, installs globales npm/bun par lien) ; un lanceur maison qui garde Pi en enfant fait refuser le pont, et la doublure répond alors « message non livré (pont pi refusé, voir le journal idnma) ».
- D8 : `model:` est permis (`--model <fournisseur>/<modèle>`, F3). `idnma run` refuse ce qui sort Pi du pane ou de la TUI : `-p/--print`, `--mode` autre que `text` (et la forme `--mode=…`, que Pi ne lit pas), `--export`, `--list-models`, `-h/--help`, `-v/--version`, et une sous-commande (`install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth`, `mcp`) en premier positionnel. Même règle dans `idnma configure` (règles partagées `engine-rules.ts`).
- D9 : rendu : celui de Pi par défaut pour un message custom (bloc `[idnma]`). Un rendu dédié demanderait `@earendil-works/pi-tui`, absent des dépendances d'idnma.

## 3. Hors périmètre

Rendu dédié du message de pair, Linux (non sondé), `--mode rpc`.

## Critères d'acceptation

- AC-1 : Quand l'utilisateur lance `idnma run deepseek-flash --engine pi` dans un pane tmux, alors Pi démarre sur `(ollama) deepseek-v4.1-flash:cloud` et la doublure apparaît sur le bus sous `deepseek-flash-<divinité>-<4>`. Vérifié par : pré-recette en tmux privé, capture du pied de page de Pi et `ListAgents` depuis une session Claude.
- AC-2 : Quand un Claude envoie `SendMessage` à la doublure au repos, alors un tour s'ouvre dans Pi avec le bloc `[idnma]`, et la réponse finale de Pi revient au Claude préfixée `[réponse automatique idnma]`. Vérifié par : `SendMessage` réel depuis la session pilote, réponse reçue dans cette session.
- AC-3 : Quand Pi lance `idnma peer send <nom du Claude> "…"` depuis son bash, alors le Claude reçoit le message. Vérifié par : message reçu dans la session pilote pendant la pré-recette.
- AC-4 : Quand un message de pair `next` arrive pendant un tour de l'utilisateur, alors il entre en steer avec le rappel « réponds à <nom> par idnma peer send » et aucun renvoi automatique ne part. Vérifié par : test `tests/pi-extension.test.ts` sur la séquence sondée F6, et journal `pi-deliver` `delivery: steer` en pré-recette.
- AC-5 : Quand l'utilisateur appuie sur Échap pendant un tour de pair, alors l'expéditeur reçoit « tour interrompu par l'utilisateur », et un message de pair en file derrière reçoit « message écarté (l'utilisateur a interrompu pi) ». Vérifié par : test qui rejoue la séquence F7/F8.
- AC-6 : Quand l'utilisateur tape une entrée pendant un tour de pair en cours d'outils, alors l'expéditeur reçoit « tour mêlé à une entrée de l'utilisateur, pas de réponse automatique ». Vérifié par : test.
- AC-7 : Quand l'utilisateur fait `/new`, alors le message de pair suivant atteint la nouvelle session et un tour de pair coupé répond « réponse perdue (session fermée dans pi) ». Vérifié par : test de bout en bout (vrai livreur + vraie extension, faux Pi) et `/new` en pré-recette.
- AC-8 : Quand l'utilisateur lance `idnma install --agent pi` puis `idnma uninstall --agent pi`, alors le bloc coéquipier et la skill apparaissent puis disparaissent de `<agent-dir>`, `AGENTS.md` revenant octet pour octet ; sans dossier d'agent Pi, la commande le dit et ne crée rien. Vérifié par : tests CLI (`PI_CODING_AGENT_DIR` redirigé) et `shasum` d'`AGENTS.md` avant/après sur l'installation réelle.
- AC-9 : Quand un engine pi porte, ou que l'utilisateur tape, un des flags refusés de D8, alors `idnma run` refuse avant tout effet (erreur de configuration pour l'engine, d'usage pour la ligne de commande) et `idnma configure` signale l'option fautive. Vérifié par : tests `run` et `configure-validate`.
- AC-10 : Quand l'utilisateur ouvre `idnma configure`, alors `pi` figure dans la liste des harnais d'un engine, et un engine pi montre le champ modèle avec l'indication `provider/model`. Vérifié par : tests `configure-render` et capture Chrome de `scripts/configure-smoke.ts`.
- AC-11 : Quand la suite complète tourne, alors dst garde ses textes et son journal (`dst-*`) inchangés et tout est vert, typecheck compris. Vérifié par : `bun test` et `bun run typecheck`, journaux tee'd.
- AC-12 : Quand l'utilisateur lit le README, alors Pi y figure : tableau des harnais, `install --agent pi`, exemple d'engine, flags refusés, limites. Vérifié par : relecture du diff du README.
