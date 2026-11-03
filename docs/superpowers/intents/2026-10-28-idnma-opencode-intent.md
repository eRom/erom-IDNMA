# Trace d'intention : opencode dans idnma

Date : 2026-10-28. Point de départ : la demande de Romain, puis l'étude `.claude/notes/2026-10-28-etude-opencode.md` (sondes et captures dans `.claude/notes/probes/opencode/`).

## Intention

Ajouter opencode aux agents qu'IdnmA sait installer et lancer, au même rang que Codex, Grok et agy : `idnma install --agent opencode` et `idnma run …` sur un engine `harness: opencode`. Pour Romain, le succès, c'est un agent opencode qui parle et répond sur le bus comme les autres, lancé par IdemA.

## Ce que Romain a dit

- « Fait une etude pour apporter "opencode" dans les agents supportés "idnma install --agent opencode" et "idnma run ..." »
- « Tu es autonome pour cette tâche. »
- « Sur le Mac: opencode v2.2.0 (Modèle Big Pickle qui est gratuit) »
- Après l'étude, à la question « A1 ou A2 » : « A1 go »

## Hypothèses (les miennes, non contredites)

- Le périmètre est celui de l'étude : doublure qui reçoit et livre, renvoi automatique, `peer send`/`peer list` depuis opencode, installation réversible. `notify_when_idle` (phase 4) reste hors périmètre, comme pour les autres doublures.
- Les règles communes des doublures (un message par tour de pair, marque `[réponse automatique idnma]`, tour mêlé, message non livré, rappel de réponse) s'appliquent à opencode sans débat.
- Big Pickle est le modèle que Romain veut pouvoir utiliser ; son palier gratuit étant épuisé le soir de l'étude, l'échec d'un tour doit revenir à l'expéditeur.

## Objectifs, non-objectifs, anti-objectifs, contraintes

- Objectif : opencode est un pair du bus (reçoit, répond, écrit) lancé par `idnma run`, installé par `idnma install --agent opencode`.
- Non-objectif : suivre la session quand Romain fait `/new` ou change de session dans la TUI (option A2, écartée par « A1 go »).
- Anti-objectifs hérités du design principal : bus à nous, lecture d'écran, poll, frappe dans le brouillon de Romain, écriture dans un fichier de Romain là où le harnais offre mieux.
- Contrainte : opencode 2.2.0, API HTTP étiquetée expérimentale.

## Comment c'est fait

- Choisi par Romain : A1 (session fixe, `/new` = doublure sourde, limite déjà acceptée pour Codex).
- Laissé à moi, annoncé dans l'étude : doublure API sur le service de fond partagé ; jeton de contrôle passé par l'environnement de session ; bloc coéquipier dans `~/.config/opencode/AGENTS.md` et skill générique dans `~/.config/opencode/skills/`.

## Questions et réponses

- « A1 ou A2 ? » → « A1 go ».

## Approches considérées

- A1, doublure API, session fixe : retenue par Romain.
- A2, A1 + plugin TUI qui suit la session : vue par Romain, écartée.
- B, hooks et PTY (famille Grok/agy) : vue dans l'étude, battue (refait ce que l'API fournit, retape dans le brouillon).
- C, serveur privé par pane : vue dans l'étude, battue (deux process par pane, plusieurs serveurs sur une base SQLite), gardée en repli.
- D, ACP : vue dans l'étude, battue (plus de TUI dans le pane).
- Règle coéquipier par entrée d'instructions de session : battue par sonde (refusée comme injection).

## Compréhension rejouée

L'étude, envoyée à Romain, a servi de restitution : verdict, faits F1 à F18, options, conception A1, AC. Aucune correction de Romain.

## Points ouverts

- Comportements non sondés, laissés à la sonde de tête de phase : délivrance par défaut d'un prompt tapé dans la TUI pendant un tour, effacement de l'environnement de session, redémarrage du service (port, mot de passe), filtre `types=` à plusieurs valeurs.
- Ajout du 28/10 au soir (sonde faite pendant la relecture du builder) : tous fermés sauf le redémarrage du service, renvoyé à la recette pour ne pas couper les TUI opencode de Romain. Résultats au §11 de la spec.

## Relecture du builder (28/10, 21 h 57) et suites

Sept questions, toutes tranchées sans Romain (parité avec les doublures existantes, ou sonde) ; chaque réponse est dans la spec :
1. Prévenir les expéditeurs à la sortie normale : non, parité avec Codex, Grok et agy qui ne le font pas (§7.5). L'étendre à toutes les doublures serait un changement de périmètre, laissé à une décision future de Romain.
2. Un `now` d'un pair livré en `steer` pendant le segment d'un autre pair : le segment continue, son renvoi part au pair qui l'a ouvert, comme chez Codex (§7.3).
3. Tour de Romain au repos : sondé, son prompt passe aussi par la boîte (`inbox.enqueued` sans `metadata`) ; propriétaire inconnu après resynchronisation : traité comme un tour de Romain (§7.1).
4. Échecs après l'inscription : la session est créée avant l'inscription ; un échec de l'environnement ou du flux passe par `CourierUnavailableError` (TUI hors bus). Sondé ensuite : le service accepte un modèle inconnu et un dossier inexistant, d'où une vérification par idnma (`GET /api/model`, `existsSync`) et l'AC-13 réécrit.
5. Capture d'échec absente du dépôt : ajoutée (`captures/free-limit-failed.events.jsonl`), plus une interruption sondée.
6. `-c` : première session sans `parentID` ; flags à valeur de la TUI listés depuis `opencode --help`.
7. `--auto` vaut `bypass` : à confirmer en recette (§11).
