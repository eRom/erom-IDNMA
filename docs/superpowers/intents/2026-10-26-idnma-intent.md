# Trace d'intention : IdnmA, le bus inter-agents par doublures

Date : 2026-10-26. Point de départ : la fiche d'idéation `~/.claude/erom-store/ideations/2026-10-26-bus-inter-agents-doublures.md` (sortie `brainstorm`). Faits de sonde : `.claude/notes/2026-10-26-sondes-bus.md`.

## Intention

Ne garder de caserne que la parole entre agents, efficace, économe en tokens et sans passer par le clavier ni l'écran, entre Claude Code, Codex, Grok et agy. La thèse de la fiche : pas de nouveau bus. Le bus pair natif de Claude Code devient le bus ; Codex, Grok et agy y entrent par une doublure qui porte leur nom et livre par le canal natif de chaque harnais. Pour Romain, le succès, c'est le scénario de la fiche joué de bout en bout dans IdemA. À terme, IdnmA remplace la CLI `caserne` et le plugin `erom-caserne`.

## Ce que Romain a dit

- « salut, on va bosser depuis /Users/recarnot/.claude/erom-store/ideations/2026-10-26-bus-inter-agents-doublures.md »
- Sur la sonde point 1 : « oui, lance la sonde. Je prépare ma doc en parallèle si jamais c'est viable »
- Sur le résultat Codex : « Tu veux dire que pour grok et agy c'est bon, mais pour codex il y a un soucis ? », puis « c » (Q2).
- Sur le retour de réponse : « c ».
- Sur le repo et le dossier `plugin/` : « c'est ça... Après, il faut quand même, à terme, remplacer "caserne" et le plugin "erom-caserne". Pour le plugin c'est simple, vu qu'on supprime le mail, slack, linear et cie. Pour la cli "caserne", il faut reprendre le "run". Il doit lire : » suivi du contenu de `/Users/recarnot/.config/idema/network.yml` (agents `claude`, `glm`, `deepseek`, `qwen`, `kimi`, `muse`, `grok`, `agy`, `codex` ; champs `label`, `info`, `cell`, `avatar`, `engines.default.{harness, model, options, env}` ; `$OPENROUTER_API_KEY` « résolu depuis secrets.yml#env ou l'environnement »). « Mais peut être que ça sera vu dans le branstorming »
- Sur IdemA : « IdemA connais la commande "caserne run..." pour preuve il l'utilise (`/Users/recarnot/.config/idema/config.toml`) et il rajoute le flag "--here" pour le moment. On peut, vu que l'on refait le moteur, dire à la session "claude-mars" (qui dédié a IdemA) de faire des modifs pour que ça soit plus simple un fois que l'on a basculer de moteur. »
- « Nom de la CLI : IdnmA (Integrated Development Network Multi Agents). Nom plugin : "erom-idnma" »
- « oui » au résumé joué en retour, « oui » à la règle de sonnette, « oui » au découpage en 4 phases et au critère de succès.

## Hypothèses (les miennes, non contredites)

- La ligne « coéquipier » vit dans le fichier d'instructions global de chaque harnais étranger, pas dans chaque repo (validé avec le résumé).
- La v1 couvre les quatre harnais, avec la sonnette pour Grok et agy au repos (validé avec le résumé).
- On réutilise le daemon app-server de Codex tel quel, sans daemon à nous (validé avec le résumé).
- `erom-agence-network` est le produit et `erom-agence-control-plane` s'archive en entier ; `plugin/` est le paquet installé une fois dans chaque harnais étranger (validé : « c'est ça »).
- Le binaire s'appelle `idnma`, en minuscules (annoncé, non discuté).
- `secrets.yml` vit à côté de `network.yml`, dans `~/.config/idema/` (choix posé dans la spec, non discuté).

## Objectifs, non-objectifs, anti-objectifs, contraintes

- Objectif : un agent écrit à un autre par son nom, quel que soit le harnais, et le message arrive pendant un tour ou réveille l'agent au repos, sans lecture d'écran.
- Objectif : remplacer `caserne run` par `idnma run`, qui lit `network.yml`.
- Non-objectif : Linear, Slack, mail, `caserne-mcp`, tasks, rappels, `fire`, `onboard`, l'embauche, le serveur HTTP (supprimés, fiche et message de Romain).
- Anti-objectif (fiche) : un bus à nous, le poll, l'amorçage tapé au lancement, les regex busy/idle, des messages de pair qui portent l'autorité de Romain.
- Contrainte (fiche) : IdemA possède les sessions tmux et les panes ; la couche de communication ne crée, ne déplace et ne tue rien.
- Contrainte : local-first. Toute porte qui passe par un relais distant est exclue (`agy remote-control`, leader Grok).

## Comment c'est fabriqué

- Choisi par Romain : les noms (IdnmA, `erom-idnma`), le fichier `network.yml` et son format, le remplacement de `caserne` et d'`erom-caserne`, le passage par `claude-mars` pour adapter IdemA après la bascule.
- Laissé à moi et annoncé : Bun et TypeScript (comme caserne), `--here` accepté sans effet, `exec` de `claude` pour les agents Claude, la doublure comme process parent qui relaie un PTY pour les harnais étrangers, la règle de `from-mode`.

## Questions et réponses

- Lancer la sonde point 1 ? Oui. Dans une session IdemA ? Oui, sur un serveur tmux séparé.
- Lancer la sonde point 2 (Codex) ? Oui.
- Sonde point 3 (Grok et agy) ou brainstorm d'abord ? « a » : la sonde.
- Q2, autorité d'un message de pair : « c », l'enveloppe partout plus la ligne « coéquipier ». Vérifiée ensuite par une mini-sonde (Codex agit, 2 sur 2).
- Retour de réponse : « c », la doublure renvoie la réponse finale d'un tour lancé par un pair, et `peer send` explicite après un steer.
- Lecture du repo et de `plugin/` : « c'est ça », avec le remplacement de caserne et d'`erom-caserne`, et `network.yml`.
- Nom : IdnmA, plugin `erom-idnma`.
- Sonnette (ne sonner qu'au repos, et seulement si rien n'a été tapé depuis le dernier Entrée ; ligne constante `📨 idnma read`) : « oui ».
- Découpage (1 socle, 2 Codex, 3 Grok et agy puis bascule, 4 `notify_when_idle`) et critère de succès (scénario de la fiche) : « oui ».

## Approches envisagées

- Q2 : a) enveloppe partout, Codex en lecture seule face aux pairs ; b) Codex sans enveloppe, le pair parle avec l'autorité de Romain ; c) enveloppe plus ligne « coéquipier ». Choisie : c. a perd parce qu'un pair ne pourrait rien demander à Codex ; b perd parce qu'un pair hériterait de l'autorité de Romain.
- Retour de réponse : a) renvoi automatique seul, faux pour un steer (la réponse de fin de tour mélange la tâche de Romain et la demande du pair) ; b) consigne seule, aléatoire (Codex n'a pas utilisé `peer send` spontanément) ; c) les deux. Choisie : c.
- Branches tuées par la fiche, reprises sans être rediscutées : un bus à nous, l'étage clavier et écran (sauf la sonnette), tout faire tourner dans Claude Code, ACP comme transport, sessions tmux cloisonnées, `agy remote-control`.
- Jamais montrées à Romain : un hook `Stop` en attente longue pour éviter la sonnette (laissé comme piste dans la spec), et la rétro-ingénierie de la route daemon de Grok (`grok host-server`).

## Résumés joués en retour

1. Ce que c'est, ce que fait la doublure par harnais, l'enveloppe, la ligne « coéquipier », le retour ; plus trois hypothèses marquées. Réponse : « oui ».
2. Le remplaçant de `run` (lecture de `network.yml`, `--here` implicite, `exec` pour Claude, doublure pour les autres, liste de ce qui meurt). Correction de Romain : IdemA reconnaît `caserne run` dans sa `config.toml` et ajoute `--here` ; c'est `claude-mars` qui adaptera IdemA après la bascule.

## Points ouverts

- Le format de plugin de Codex, Grok et agy permet-il à `erom-idnma` de livrer les hooks et la ligne « coéquipier » ? Sinon, comment installer une seule fois.
- Le compte Codex est vu en plan `free` et le `model = "gpt-5.5"` de `~/.codex/config.toml` est refusé : sujet de configuration de Romain, hors spec.
- Les approbations Codex avec plusieurs clients n'ont pas été testées.
- La route daemon de Grok (`grok host-server`) pourrait un jour remplacer la sonnette : à creuser.

## Ajout après la relecture builder (2026-10-26, 17 h 45)

Un relecteur à froid a posé 7 questions. Aucune n'a été renvoyée à Romain : deux sont tranchées par une sonde, les autres sont des choix pris à mon compte et listés à la remise de la spec.
- Sonde : une TUI Codex lancée avec `--dangerously-bypass-approvals-and-sandbox` s'attache bien au daemon. Une variable posée dans l'environnement de la TUI n'atteint pas les commandes de Codex, qui descendent du daemon et reçoivent `CODEX_THREAD_ID`. Conséquences : identité de l'expéditeur par `CODEX_THREAD_ID` vérifiée par pid noyau, AC-9 reformulé (raison : une variable d'environnement est toujours forgeable par l'agent ; le modèle de menace du §3 l'accepte déjà).
- Preuve déjà en main : un émetteur Claude n'attend aucun accusé sur la connexion.
- Choix pris à mon compte : `turn/start` partout chez Codex (à vérifier en tête de phase 2) ; règle d'état sûr pour la sonnette (jamais en état inconnu, liste des événements fiables) ; un message par tour et un seul destinataire de retour ; pas de règle d'autorisation posée par `idnma install` (IdnmA n'élargit aucune permission) ; sondes en tête des phases 2 et 3 ; `network.yml` recopié tel quel dans `docs/superpowers/specs/network.example.yml`, création du fichier réel en phase 1 avec le feu vert de Romain.
- Constat : Romain a déjà réglé le modèle Codex (`model = "gpt-6-luna"` dans `~/.codex/config.toml`).
