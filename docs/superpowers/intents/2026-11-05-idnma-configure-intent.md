# Intent record : `idnma configure`, le builder de `.idnma.yml`

Session du 05/11/2026 (Opus 5.5, brainstorming). Design associé : `docs/superpowers/specs/2026-11-05-idnma-configure-design.md`.

## Intention

Donner une interface visuelle pour créer et modifier `~/.idnma.yml`, maintenant que le dépôt est public : un nouvel utilisateur doit pouvoir écrire son premier fichier sans connaître YAML, les ancres ni les options de chaque harnais, et Romain doit pouvoir maintenir le sien sans que l'outil abîme ce qu'il a écrit à la main. Réussite : on règle un agent à l'écran, on voit la commande qui servira à le tester, et le fichier écrit est celui qu'on aurait écrit soi-même.

## Ce que Romain a dit

- Ouverture : « je veux construire un "builder" de ".idnma.yml". Vu qu'il est maintenant partagé en public, ça serait bien pratique d'avoir un style WYSIWYG. On pourrai l'appeler en `idnma configure`, lancer soit un server + site, soit une app Rust ou Electron. On reprend erom-design version "aoo" et on voit comment et quoi faire ? »
- Cible : « on cible les deux » (le nouvel utilisateur qui part de zéro, et Romain avec son fichier existant).
- Bornes :
  - « Pas de lectures de fichiers env. Les variables env qu'on veut mettre dans la config sont stockées comme le simple chaine "$OPENROUTER_API_KEY" (pas de link, pas de validation = on laisse l'excatitude à l'utilisateur). »
  - « La App Config ne lance aucun agent, il traite/valide (syntaxe) le fichier, c'est tout. »
- Champs : « "label" et "avatar" doit etre suivi par l'app. "label" obligatoire, "avatar" optionnel. »
- Sur les maquettes A/B/C : « j'ai un doute entre A et C (B poubelle) ».
- Sur A' et C' : « Je ne suis pas sastifait. Faut dire que la tâche est compliquée "trouver l'interface qui fera mouche". »
- Presets : « On peut les compartimenter en 2 catégories : 1. Providers 2. Options. Avec de base (nouvelle config) les ollama, lmstudio, openrouter de claude-max déjà intégré (comme des items par défaut, disponible). »
- Agents : « un "agent" est défini par : une key, un label, un ou des harais (engines) ; les engines définissent : harnais, model, options et env. Donc, on peut calé l'égalité : "agent = modèle" ». Exemple donné : l'agent `deepseek-flash` et ses engines `default` (claude via ollama), `dst`, `opencode`.
- Aperçu : « On ne veut pas voir (apercu) les lignes YAML. Mais juste la commande qui sert de test, par exemple : `idnma run deepseek-flash`, `idnma run deepseek-flash --engine dst`, `idnma run deepseek-flash --engine opencode` ».
- Sur la direction « la commande comme titre » : « oui ».

## Suppositions (de Claude, non contredites)

- « aoo » se lit « app » : profil Application d'erom-design (dark natif macOS).
- Par « valider la syntaxe », Romain entend : le YAML se lit, et chaque engine passe les règles que `idnma run` applique.
- L'app ne détecte pas les harnais installés sur la machine (déduit de « c'est tout »).
- `info` et `cell` (champs d'IdemA) sont conservés tels quels, jamais modifiés ; `info` peut s'afficher en sous-titre.
- Seule l'app exige `label` ; `idnma run` continue d'accepter un agent sans `label`.
- Le serveur local est verrouillé (127.0.0.1, jeton, contrôle d'origine) parce que le fichier pilote `--dangerously-skip-permissions`.
- Ajouts montrés dans la dernière maquette et couverts par le « oui » : actions Duplicate et Delete, « Anthropic » (sans proxy) et « Custom env… » dans le menu Provider, liste « Used by » des commandes qui utilisent un preset, `info` en sous-titre non modifiable, correction « Quote it » d'une valeur d'env numérique.

## Objectifs, non-objectifs, anti-objectifs, contraintes

- Objectifs : créer et modifier agents, engines, providers et options à l'écran ; montrer pour chaque engine la commande de test ; valider en direct ; écrire un fichier fidèle.
- Non-objectifs : lancer un agent ; lire un fichier d'env ou résoudre une `$VARIABLE` ; vérifier qu'une variable existe ; détecter les harnais installés ; afficher le YAML.
- Anti-objectifs : abîmer le fichier de Romain (ancres, alias, `<<`, commentaires, style en ligne) ; montrer la valeur d'un secret.
- Contraintes : TypeScript sous Bun (dépôt existant, dépendances `yaml` et `zod`), macOS 26 et plus, Linux toléré ; DS Application d'erom-design.

## Comment ça se construit

- Choix de Romain : commande `idnma configure` ; design system erom-design Application ; presets en deux catégories ; agent = modèle ; aperçu réduit aux commandes.
- Confié à Claude : le véhicule (Romain proposait serveur + site, Rust ou Electron). Défaut annoncé et non contesté : serveur Bun local plus page dans le navigateur, sans nouvelle dépendance.

## Questions et réponses

- Qui vise-t-on en premier ? « les deux ».
- Ce cadrage est-il juste ? Correction : « label » et « avatar » suivis par l'app, « label » obligatoire, « avatar » optionnel.
- Maquettes ? « oui ».
- Quelle disposition (A, B, C) ? Doute entre A et C, B écartée, puis mise à jour du fichier.
- C' ou A' ? Ni l'une ni l'autre : nouveau modèle de données (presets en deux catégories, agent = modèle, commandes seules).
- La direction « la commande comme titre » fait-elle mouche ? « oui ».

## Approches considérées

- Véhicule : serveur Bun local + navigateur (retenu) ; Electron (écarté par Claude : second programme à livrer et signer pour un outil public, environ 150 Mo) ; Rust (écarté par Claude : nouvelle chaîne de compilation pour éditer un fichier). Romain n'a pas contesté.
- A, Inspector (liste, formulaire, aperçu commande/YAML) : dans le doute de Romain, puis dépassée.
- B, Form + file (arbre éditable et YAML synchronisé) : « poubelle ».
- C, Overview + drawer (tableau d'engines, tiroir) : dans le doute de Romain, puis dépassée.
- A', Families (familles par `label`, variantes par `info`) et C', Matrix (variantes par harnais) : « pas satisfait ». Le fichier a ensuite rendu chaque `label` unique, ce qui retire la notion de famille.
- « La commande comme titre » (chaque engine a pour titre sa ligne `idnma run`, trois onglets Agents / Providers / Options) : retenue.

## Compréhension rejouée

- Cadrage (agent non lancé, env non lu, `$VAR` écrite telle quelle, validation de syntaxe, cibles les deux) : corrigé sur `label` et `avatar`, le reste accepté.
- Analyse du fichier du 05/11 à 13 h : valide de bout en bout, sans réaction.
- Analyse du fichier du 05/11 à 14 h : une erreur (`CLAUDE_CODE_ATTRIBUTION_HEADER: 0`, nombre là où l'env attend du texte), `oss20` qui gardait le label de `luna` ; sans réaction, Romain a renommé `oss20` ensuite (« GTP OSS 20B »).

## Points ouverts

- Langue du texte de l'interface : le DS Application la veut en anglais, la CLI d'idnma parle français.
- Forme du champ `avatar` (nom de fichier libre, ou choix dans un dossier d'IdemA).

## Ajouts après la relecture du builder (05/11, 14 h 20 - 14 h 51)

Un relecteur neuf (sous-agent Opus) a lu le design comme s'il devait le construire et posé 7 questions.

- Tranchées par Claude, inscrites dans le design comme ses choix : langue de l'interface en anglais (prémisse corrigée : le README est en anglais, seule la CLI est en français) ; avatar en texte libre sans image livrée ; preset partagé jamais modifié depuis un engine, « Custom » détache par copie ; changer de harnais retire ce qu'il n'utilise pas ; valeurs liées par ancre en lecture seule avec « Unlink » ; parité de validation étendue à tous les contrôles d'engine de `runAgent` et `prepareOpencode` ; style des listes nouvelles calqué sur le fichier ; polices système, sans les `.otf` d'Apple.
- Posée à Romain : premier lancement d'un nouvel utilisateur (l'installeur copiait l'exemple, qui liait des valeurs par ancres). Options : a) l'installeur ne crée plus le fichier et renvoie à `idnma configure` ; b) il copie l'exemple réécrit ; c) rien ne change. Réponse : « J'ai mis à jour '~/dev/erom-agence-network/.idnma.example.yml' pour refléter mes changements avec juste les harnais/modèles communs. Je vote pour a ! »
- Conséquence : les presets built-in reprennent les valeurs du nouvel exemple (lmstudio sans `CLAUDE_CODE_ATTRIBUTION_HEADER`) ; l'exemple passe les validateurs d'idnma sans erreur (5 agents, 6 engines).
