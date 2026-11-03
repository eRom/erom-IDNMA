---
status: implemented
date: 2026-10-29
---

# IdnmA : la doublure dst (DeepSeek Harness TUI) (design)

Complète `docs/superpowers/specs/2026-10-26-idnma-design.md` (§7.3 enveloppe, §7.4 rappel, §7.6 renvois automatiques). Faits F1 à F23 sondés le 28/10 sur dsh 0.2.1-rc.3 et dst 0.17.0 : `.claude/notes/2026-10-28-etude-dst.md` ; sorties brutes : `.claude/notes/probes/dsh/captures.md`.

## 1. Intention

Un agent dont l'engine dit `harness: dst` entre sur le bus de pairs comme Codex et opencode : lancé par `idnma run dst`, il reçoit les messages de pairs sans frappe simulée, renvoie à l'expéditeur la réponse finale d'un tour ouvert pour lui, écrit à ses pairs par `idnma peer send`, et s'installe par `idnma install --agent dst`. La voie est celle que dsh documente : un plugin Cordis chargé dans le process de `dst`, qui parle à l'objet `Agent` du noyau.

## 2. Objectifs, non-objectifs, anti-objectifs

- Objectifs : livraison typée (`followup`, `steer`), réponse exacte par tour, bulle native `✉ <pair> · team message`, brouillon de Romain jamais touché, `/new` suivi, échecs nommés à l'expéditeur, `peer list` vivant sous la sandbox par défaut.
- Non-objectifs (v1) : modèle par engine (F16), champ de pied `tuiStatus`, noyaux Claude et Codex de `dst` (F17), distribution du plugin à d'autres que Romain.
- Anti-objectifs : aucun PTY, aucune frappe dans la TUI, aucun usage du socket d'injection de la TUI (F18), aucune écriture dans le profil `dsh-tui` de Romain, aucune règle de permission.

## 3. Contraintes

- Le plugin tourne sous Node 24 (process de `dst`), pas sous Bun : modules `node:` seulement, TypeScript à syntaxe effaçable (F23), aucun import hors de `src/dst/`.
- Le plugin ne lève jamais vers dsh : chaque rappel est enveloppé, une erreur part en trame `error` vers la doublure. Un événement `error` sans écouteur sur un socket du plugin fait planter toute la TUI (mesuré le 29/10, `dsh-tui crashed: listen EINVAL`) : chaque socket a son écouteur avant toute opération.
- Doublure : rien sur stdout ni stderr une fois `dst` lancé, tout passe par `logEvent`. Jamais de jeton ni de texte de message au journal.
- Écritures sur socket en `node:net` des deux côtés.

## 4. Vue d'ensemble

```
pair ──bus──▶ doublure (Bun) ──pont Unix, lignes JSON──▶ plugin idnma (Node, dans dst) ──▶ Agent.followup / Agent.steer
                 ▲                                              │
                 └──────── state, delivered, claimed, result, dropped ◀─┘
```

- `idnma run dst` garde le schéma commun : doublure parente, inscription au bus, canal de contrôle, `dst` lancé en enfant, stdio hérité, sans PTY.
- La doublure **écoute** le pont (`/tmp/idnma-<uid>/<pid>.dst.sock`, dossier privé existant), le plugin s'y connecte : le nettoyage reste à la doublure (F20).
- Le plugin est activé par le patch « home » de dsh (`$DSH_HOME/cordis.patch.yml`), conditionné par `IDNMA_DST_BRIDGE` : inerte hors idnma (F4).
- Partage des rôles : le **plugin** porte la sémantique de dst (premier plan, choix `followup`/`steer` sur l'état vivant, tours, réponses, pertes) ; le **livreur** porte celle du bus (file, admission, renvois automatiques, statut du registre, coupures, adieux).

## 5. Configuration

```yaml
agents:
  dst:
    engines:
      default:
        harness: dst
      full:
        harness: dst
        env: { DSH_PERMISSION_MODE: danger-full-access }
```

- `harness: dst` rejoint `HARNESSES`. Le binaire est résolu par son nom (`dst`).
- `model:` dans un engine dst : `ConfigError` « dst ne prend pas de modèle au lancement ; choisis-le avec /model dans dst, la TUI le retient » (F16).
- `options:` passent à `dst` après `--backend dsh` ; `env:` atteint le process de `dst` et, sauf les noms filtrés par dsh (F13), le shell de l'agent.

## 6. `idnma run` sur un engine dst

Dans l'ordre, tout refus avant le moindre effet (ni pane, ni nom, ni bus) :

1. Refus (engine : `ConfigError` qui nomme l'engine ; tapé : `UsageError`) :
   - premier positionnel parmi `run`, `cli`, `dsh`, `update`, `migrate`, `doctor`, `safe`, `version`, `help`, `session`, `models`, `skills`, `mcp`, `auth`, `capabilities`, ou présence de `-p`, `--print`, `-v`, `--version`, `-h`, `--help` : commandes du lanceur de `dst` (`bin/dsh-tui.js:623-642`), sans objet dans un pane du bus (derrière le `--backend dsh` d'idnma, le lanceur les prendrait pour un dossier de travail) ;
   - `--backend <x>` (ou `--backend=<x>`) avec `x` différent de `dsh` : le plugin ne démarrerait pas (F17). `DSH_TUI_BACKEND` n'est pas contrôlé : le `--backend dsh` posé par idnma le réécrit (`bin/dsh-tui.js:1635-1647`) ;
   - `--profile`, `--from-default-profile` : autre composition ;
   - `model:` dans l'engine (§5).
2. Plugin installé : le patch « home » du dossier que `dst` lira (`IDNMA_DSH_HOME`, sinon `DSH_HOME` de l'env de l'enfant, sinon `~/.dsh`) doit contenir le bloc idnma qui pointe vers le `src/dst/plugin.ts` **de ce checkout**. Sinon `ConfigError` : « le plugin idnma n'est pas installé dans dst : lance idnma install --agent dst » (ou « installé depuis un autre checkout (<chemin>) : relance idnma install --agent dst depuis celui-ci »).
3. Argv de l'enfant : `dst`, puis `--backend dsh` sauf si un `--backend dsh` est déjà tapé ou dans l'engine, puis les options de l'engine et la ligne tapée (`buildHarnessArgv`). `--resume [id]`, `-c`, un dossier et `--patch` passent tels quels.
4. Env de l'enfant : `process.env`, puis `DSH_TUI_NO_LAUNCHPAD=1` (F10), puis l'`env:` de l'engine (qui peut le changer), puis `IDNMA_DST_BRIDGE=<socket du pont>` et `IDNMA_DST_BRIDGE_TOKEN=<jeton du pont>` (tiré à chaque lancement, 16 octets hexadécimaux), puis le canal de contrôle habituel posé par `runUnderstudy`. Les variables du pont ne sont posées que si la doublure est inscrite au bus.
5. `fromMode` : `bypass` si l'env de l'enfant porte `DSH_PERMISSION_MODE=danger-full-access`, `prompting` sinon (pas de flag, F14).
6. Inscription, nom `dst-<divinité>-<4 base36>`, `tagPane`, libellé de repli « dst » : inchangés.

## 7. Le pont

### 7.1 Trames

Une trame = un objet JSON sur une ligne, dans les deux sens. Ligne de plus de 8 Mio : connexion fermée. Module partagé `src/dst/protocol.ts` (types, encodage, lecteur de lignes, validation), importable par le plugin. La validation n'exige que les champs utiles et ignore les clés inconnues ; une trame illisible est écartée et journalisée par sa seule longueur (`dst-frame-invalid { length }`), jamais par son contenu.

| Sens | Trame | Sens métier |
|---|---|---|
| plugin → doublure | `hello { v, token, pid, versions }` | première trame obligatoire ; `v` = version du protocole (1), `versions.tui` best effort |
| plugin → doublure | `state { session, status }` | premier plan (`null` sans agent) et son statut `idle`/`running` ; envoyée à chaque changement, et toujours juste après un `dropped disposed` ou `no-agent` |
| doublure → plugin | `deliver { id, priority, sender, text, hint? }` | un message de pair ; `id` neuf par envoi (UUID) ; `hint` = la ligne de rappel de réponse, absente pour un renvoi automatique ou une enveloppe sans nom ; le texte d'un `steer` est `text + "\n" + hint` |
| plugin → doublure | `delivered { id, mode, session }` | `mode` choisi : `followup` ou `steer` |
| plugin → doublure | `claimed { id, turn }` | le message est entré dans le tour `turn` |
| plugin → doublure | `result { id, turn, reason, cause?, mixed, sources, text?, error? }` | fin du tour ouvert par ce `followup` ; `reason` = `turn/end.reason.kind` (ou `disposed`), `cause` = `reason.reason.kind` d'un `aborted`, `sources` = types de source (`kind`) des messages étrangers réclamés dans le tour, `text` = dernier texte non vide de l'assistant du tour sans la ligne `⏵`, `error` = `{ message?, code? }` réduit à ces deux chaînes |
| plugin → doublure | `dropped { id, why, error? }` | `why` : `discarded` (écarté de la boîte), `disposed` (session fermée avant réclamation), `no-agent`, `rejected` (dsh a levé ; `error` = message de l'exception) |
| plugin → doublure | `error { code }` | erreur interne du plugin, par code fixe (`bad-frame`, `listener-failed`, `register-failed`…), jamais un texte qui pourrait citer un message |

### 7.2 Admission

Première trame lue sous 5 s, sinon fermeture. Admise si : `type: hello`, `v` égal à la version de la doublure, `token` égal au jeton du pont (comparaison à temps constant), pid noyau de la connexion (`peerPidOf`) descendant de la doublure (`isDescendantOf`). Sinon `dst-bridge-refused { reason }` et fermeture. Une nouvelle connexion admise remplace l'ancienne (rechargement du plugin, relance du process par `/update`) : l'ancienne est traitée comme une coupure (§8.4).

## 8. Le plugin (`src/dst/plugin.ts`)

`export const name = "idnma-bridge"`, `export const inject = ["agents", "shellEnv"]`, `export function apply(ctx, config)`. Sans `IDNMA_DST_BRIDGE` ou `IDNMA_DST_BRIDGE_TOKEN`, il ne fait rien.

### 8.1 Environnement des commandes de l'agent

Si `IDNMA_CONTROL_TOKEN` est présent : `ctx.shellEnv.register({ name: "idnma", variables: { DSH_IDNMA_CONTROL_TOKEN: … }, resolve: () => ({ DSH_IDNMA_CONTROL_TOKEN }) })`. dsh pose ces clés après son filtre des noms sensibles (vérifié dans `dsh-subprocess-local`, `childEnv` : les entrées explicites écrasent la base filtrée). `IDNMA_CONTROL_SOCKET` et `IDNMA_NAME` passent le filtre tels quels (F13). L'appel est enveloppé : un `register` qui lève (contributeur déjà inscrit après un rechargement) envoie `error { code: "register-failed" }` et le pont continue.

### 8.2 Premier plan

Entrée de `~/.dsh-tui/inject/servers.json` (tableau de `{ pid, sessionId, … }`) dont le `pid` est celui du process ; l'agent **racine** vivant de ce `sessionId` (`ctx.agents.get`, ou racine dont `id` ou `session.id` vaut ce `sessionId`). Le fichier est écrit sans atomicité par la TUI : une lecture illisible garde la dernière valeur valide. Repli (fichier absent, sans entrée pour ce pid, ou `sessionId` sans racine vivante) : la seule racine (`ctx.agents.roots()`), sinon la dernière racine créée (ordre des `agent/created` vus, sous-agents exclus), sinon la dernière de `roots()`. Le fichier est relu au tick (2 s) et aux événements de cycle de vie (`agent/created`, `agent/disposed`, `agent/status`) et à chaque `deliver`, jamais à chaque `session/event`. Une `state` part quand `session` ou `status` change. Le chemin du fichier est injectable (`config.serversFile`) pour les tests.

### 8.3 Livraison

Message construit : `{ id, role: "user", content: [{ type: "text", text: "Team message from <sender>:" }, { type: "text", text }], source: { kind: "agent-message", form: "relay", senderSessionId: <sender> } }` (F8). Choix sur l'agent du premier plan, au moment même :

| État du premier plan | `now` | `next` | `later` |
|---|---|---|---|
| `idle` | `followup` | `followup` | `followup` |
| tour d'un pair | `steer` + rappel | `followup` | `followup` |
| tour de Romain ou inconnu | `steer` + rappel | `steer` + rappel | `followup` |
| `running` sans tour ouvert, `nextTurn` vide | `followup` | `followup` | `followup` |

- Propriétaire d'un tour : fixé au `turn/start`, par le seul message `next-turn` que le tour va réclamer, `inbox.nextTurn[0]` de l'agent à cet instant (`turn/start` précède la réclamation) : l'un des nôtres → pair ; un autre → Romain ; aucun (tour ouvert par du steering) → inconnu. Jamais par un `steer` : une frontière de tour réclame d'un coup tout le `next-step` et un seul `next-turn`, dans un ordre non spécifié. Un de nos `followup` réclamé au tour T confirme le propriétaire pair.
- Agent `running` sans tour ouvert (entre deux tours, F7) : propriétaire de `inbox.nextTurn[0]` ; `nextTurn` vide → `followup` (un `steer` à cet instant ouvrirait un tour sans suivi).
- `steer` envoie `text + "\n" + hint` (ou `text` sans `hint`). Puis trame `delivered`. Sans agent : `dropped no-agent`. `followup`/`steer` qui lève : `dropped rejected`.

### 8.4 Suivi

- Entrées de Romain : messages de source `user`, `skill-invocation` (un `/<skill>` tapé), `dsh-tui-btw`, `dsh-tui-recap`. Les autres sources (contextes injectés par dsh à chaque tour : `runtime-context`, `skill-catalog`…, relais étrangers) ne sont pas des entrées de Romain ; leur `kind` est rapporté dans `result.sources` pour la recette.
- `agent/inbox/claimed` d'un des nôtres : trame `claimed`. Un `followup` réclamé au tour T ouvre le suivi du tour (session, T). Une entrée de Romain réclamée au tour T marque ce tour `mixed` (que le suivi existe déjà ou s'ouvre ensuite dans le même tour).
- `session/event` `assistant/message` du tour suivi : dernier texte non vide, ligne de tête `⏵ …` et lignes vides qui la suivent retirées (F21).
- `session/event` `turn/end` du tour suivi : trame `result`.
- `agent/inbox/discarded` d'un des nôtres non réclamé : décision différée de 1,5 s ; si `agent/disposed` de cet agent arrive entre-temps, `dropped disposed`, sinon `dropped discarded` (on ne sait pas si `/new` écarte la boîte avant de disposer l'agent). Un Échap simple n'écarte rien (`agent.cancel({ kind: "user" }, { keepInbox: true })`, `backend/session.js:270`) : nos messages en file passent au tour suivant. Écartent la boîte : Échap avec une saisie de Romain en attente, l'envoi en placement `now`, le changement de session, le retour arrière.
- `agent/disposed` : chaque message suivi de cet agent non réclamé → `dropped disposed`, puis `state` ; tour suivi encore ouvert → `result { reason: "disposed" }`. Les arrêts de la TUI ont tous la cause `user` : un `/new` en plein tour de pair donnera plutôt `aborted`/`user`.
- Écouteurs : aucun ne lève (`agent/created` est un événement en série dont un écouteur qui lève ferait échouer la création de la session) ; une erreur part en `error { code: "listener-failed" }`.
- Pont fermé : le plugin ne se reconnecte pas (une nouvelle instance le fera si le process est relancé). Le disposer de `ctx.effect` ferme la connexion et les minuteurs.

## 9. Le livreur (`src/dst/courier.ts`)

### 9.1 Phases du pont

`waiting` (avant le premier `hello`), `up` (admis), `down` (coupé, fenêtre de grâce), `gone` (fenêtre expirée ou plugin jamais venu), `closed` (après `farewell`, terminale). `beforeSpawn` ouvre le serveur du pont (socket 600) ou lève `CourierUnavailableError` ; `afterSpawn` arme l'attente du `hello` (30 s). Un `hello` admis fait passer à `up` depuis toute phase sauf `closed`, et remet le miroir à `{ session: null, status: idle }` jusqu'à la première `state`.

### 9.2 Livraison et renvois

- En `up` avec une `state` de session non nulle : chaque message de la file part aussitôt en `deliver` et passe dans la table des envois ; la file est vidée ainsi à chaque `state` reçue de session non nulle (changée ou non) et à chaque message arrivé. Sinon il attend en file. En `gone` et `closed` : refusé tout de suite (textes de §9.4 et §9.5).
- `hint` = `replyHintFor(content)` : la ligne que `withReplyHint` ajoute, absente pour un renvoi automatique ou une enveloppe sans nom lisible.
- `delivered` : journal `dst-deliver { msgId, delivery }`. `claimed` d'un `steer` : réglé, rien ne revient (le rappel dit de répondre par `idnma peer send`).
- `dropped disposed` / `no-agent` : le message reprend la tête de file ; il repart dès la `state` que le plugin envoie juste après (§7.1) ; au troisième essai, « message non livré (dst ne l'a pas pris) ».
- Renvois (préfixés `[réponse automatique idnma]` par `sendAutoReply`), sauf si le message ouvrant est lui-même un renvoi automatique (`muted`) :

| Cas | Texte | `outcome` journalisé |
|---|---|---|
| `result` mêlé | `<nom> : tour mêlé à une entrée de Romain, pas de réponse automatique` | `mixed` |
| `completed` avec texte | le texte | `replied` |
| `completed` sans texte | `<nom> : tour terminé sans réponse` | `no-text` |
| `error` | `<nom> : tour en échec (<message>, <code>)` | `failed` |
| `aborted`, cause `user` | `<nom> : tour interrompu par Romain` | `interrupted` |
| `aborted` cause `disposed`, ou `disposed` | `<nom> : réponse perdue (session fermée dans dst)` | `lost` |
| `aborted`, autre cause | `<nom> : tour interrompu (<cause>)` | `interrupted` |
| `max-tokens` | le texte suivi de `(<nom> : réponse tronquée, limite de tokens atteinte)`, ou `<nom> : tour coupé (limite de tokens atteinte)` | `truncated` |
| autre `reason` | `<nom> : tour terminé sans réponse (<reason>)` | `other` |
| `dropped discarded` | `<nom> : message écarté (Romain a interrompu dst)` | `discarded` |
| `dropped rejected` | `<nom> : message non livré (dst l'a refusé : <error>)` | `rejected` |

### 9.3 Statut du registre

`state.status` `running` → `busy`, `idle` → `idle`, publié seulement au changement ; coupure du pont → `idle`. Journal `dst-foreground { session }` quand le premier plan change.

### 9.4 Coupures

Un seul jeu de textes pour une coupure et une sortie : le disposer du plugin ferme le pont dès la libération de la racine, et la fin de la TUI peut durer plus d'une seconde ; distinguer les deux ne tiendrait pas.

- Pont fermé : phase `down`, journal `dst-bridge-lost`, statut `idle`. Envois en vol tout de suite : réclamés `<nom> : réponse perdue (dst arrêté ou relancé)`, non réclamés `<nom> : message non livré (dst arrêté ou relancé)`. La file attend 30 s un nouveau `hello` ; au-delà, phase `gone`, journal `dst-bridge-gone`, file refusée `<nom> : message non livré (pont dst perdu)`, comme tout message arrivé ensuite.
- Aucun `hello` admis 30 s après le lancement : phase `gone`, journal `dst-bridge-missing`, file refusée `<nom> : message non livré (le plugin idnma ne s'est pas chargé dans dst)`, ou, si un `hello` a été refusé entre-temps, `<nom> : message non livré (pont dst refusé, voir le journal idnma)`.
- L'inscription au bus reste : un plugin qui revient (`/kernel dsh` après un détour) reprend la livraison.

### 9.5 Arrêt et adieux

- `stop()` (synchrone, idempotent) : ferme le serveur et la connexion, retire le socket, coupe les minuteurs ; garde la file et la table des envois.
- `farewell()` (nouveau, optionnel dans l'interface `Courier`) : appelé par `runUnderstudy` après la fin de l'enfant ou un signal, attente bornée à 3 s. Passe en phase `closed` (un message arrivé ensuite reçoit tout de suite `<nom> : message non livré (dst a quitté le bus)`). Envois encore en vol : textes de §9.4 ; file : `rejectQueuedMessages` (libellé « dst »). Les autres livreurs ne l'implémentent pas (comportement inchangé).

### 9.6 Journal

`dst-bridge-listening`, `dst-bridge-up { pid, versions, reconnect }`, `dst-bridge-refused { reason }`, `dst-bridge-lost`, `dst-bridge-missing`, `dst-bridge-gone`, `dst-frame-invalid { length }`, `dst-foreground { session }`, `dst-deliver { msgId, delivery }`, `dst-claimed { msgId, turn }`, `dst-turn-end { msgId, outcome, sources }`, `dst-dropped { msgId, why }`, `dst-plugin-error { code }`.

## 10. CLI côté agent

- `controlRequest` : jeton lu dans `IDNMA_CONTROL_TOKEN`, sinon `DSH_IDNMA_CONTROL_TOKEN`. Socket présent sans aucun des deux jetons : erreur dédiée « idnma : canal de contrôle sans jeton (IDNMA_CONTROL_TOKEN ou DSH_IDNMA_CONTROL_TOKEN absent) », avant le cas « cet agent est un Claude ».
- Nouvelle op de contrôle `list` : la doublure rend les pairs vivants joignables hors elle-même (`entry.pid !== process.pid`), triés par nom, `{ name, status, tmux }`. Voie du jeton et voie Codex admises, comme `send`.
- `idnma peer list` : si un canal est présent (socket et jeton, ou `CODEX_THREAD_ID`), op `list` ; en cas d'échec (doublure ancienne qui ne connaît pas l'op, doublure injoignable), lecture locale actuelle. Même format de sortie, homonymes compris. Sous la sandbox de dst, `ps` est refusé (F14) : seule l'op `list` marche.
- `idnma read` chez dst (`DSH_IDNMA_CONTROL_TOKEN` présent) : « les messages de pairs arrivent d'eux-mêmes ». Textes d'aide et messages qui énumèrent les harnais : dst ajouté.

## 11. Installation (`idnma install --agent dst`)

Dossier : `IDNMA_DSH_HOME`, sinon `$DSH_HOME`, sinon `~/.dsh`. Absent : « dst : absent (<dossier>), rien installé ».

- **Patch « home »** `<home>/cordis.patch.yml`, bloc délimité :
  ```yaml
  # >>> idnma <variante> (ne pas éditer : idnma uninstall --agent dst le retire)
  - insert:
      - id: idnma-bridge
        name: <JSON.stringify(chemin réel de src/dst/plugin.ts du checkout)>
        disabled: !!js '!process.env.IDNMA_DST_BRIDGE'
  # <<< idnma
  ```
  (`name:` reçoit la sortie de `JSON.stringify`, guillemets compris, une seule paire : chaîne YAML entre guillemets doubles valide pour tout chemin.) Variantes de la ligne de début, qui disent comment rendre le fichier : rien (bloc ajouté à un fichier fini par un saut de ligne), `eol-added` (saut de ligne ajouté avant), `created` (fichier créé), `empty-list:<base64 de la ligne d'origine>` (fichier dont la seule ligne utile est `[]`, forme du gabarit de patch livré par dsh, que l'étude a signalée comme piège : cette ligne est remplacée par le bloc, commentaires gardés). Un fichier d'une autre forme (séquence en flux non vide, objet, YAML invalide) : `ConfigError` « forme inattendue, ajoute le bloc à la main ». Le résultat est relu par le parseur YAML (balise `!!js` déclarée) avant l'écriture : séquence attendue, avec l'entrée `idnma-bridge`. Lecture et écriture en latin1 (le texte du bloc converti comme celui du coéquipier, octets UTF-8 vus en latin1 : un chemin non ASCII reste juste), écriture atomique, mode d'origine gardé. Relancer l'installation met à jour le chemin.
- **Coéquipier** `<home>/AGENTS.md` : `installTeammateLine` (F15).
- **Skill** `<home>/skills/generic-idnma-network/SKILL.md` : `installSkill`. Rien dans `~/.agents/skills`.
- `uninstall` rend chaque fichier octet pour octet, ou le retire s'il a été créé par idnma.

## 12. Limites acceptées

- `servers.json` est un fichier interne de la TUI (premier plan) ; repli sur les racines.
- `/kernel` vers Claude ou Codex : plus de plugin, la doublure le dit aux expéditeurs (§9.4).
- Sandbox par défaut : écriture limitée au dossier de lancement et à `/tmp` ; `peer list` passe par l'op `list`.
- Assistant de premier lancement (F22) tant que Romain n'a pas fini `/setup` : un tour de pair y tourne sans se voir.
- 250 à 450 Mo par pane (F1). Jeton de contrôle visible des commandes de l'agent (`DSH_IDNMA_CONTROL_TOKEN`), comme chez Grok et agy.
- Un message de pair en file dans dst au moment d'une coupure du pont peut encore être traité alors que l'expéditeur a reçu « non livré (dst arrêté ou relancé) ».
- Un descendant de dsh qui porte le jeton du pont (env complet) pourrait remplacer la connexion du plugin ; les commandes de l'agent ne le voient pas (dsh retire les noms en `TOKEN`).
- Texte renvoyé : dernier texte non vide du tour ; si la dernière étape n'a pas de texte, c'est celui d'une étape antérieure (même règle que pour opencode).
- Entrées de Romain reconnues par une liste fermée de sources (§8.4) : une source nouvelle de dst qui serait une saisie de Romain ne marquerait pas le tour mêlé ; `result.sources` au journal permet de la repérer.

## 13. Arbitrages

- **Le plugin choisit `followup` ou `steer`.** Battu : le livreur choisit sur un miroir de l'état, en retard d'une trame, et un `now` arrivé juste à l'ouverture d'un tour de pair partirait en `followup`.
- **Jeton de pont distinct** (`IDNMA_DST_BRIDGE_TOKEN`). Battu : réutiliser le jeton de contrôle, que `runUnderstudy` tire en interne et qu'il aurait fallu remonter jusqu'au livreur ; le nom contient `TOKEN`, dsh le retire des commandes de l'agent.
- **Refus de `idnma run dst` sans plugin installé.** Battu : démarrer hors du bus avec une ligne sur stderr, que l'écran de la TUI efface aussitôt.
- **`farewell` optionnel, dst seulement.** Battu : rejeter la file à la sortie pour tous les harnais, changement de comportement hors périmètre (noté pour plus tard).
- **Op `list` générique avec repli local.** Battu : op réservée à dst, alors que tout harnais sous Seatbelt (Codex sans bypass) a le même refus de `ps`.
- **Doublure qui écoute, plugin qui se connecte.** Battu : plugin qui écoute (socket orphelin au SIGHUP, F20).
- **Entrées de Romain par liste fermée** (`user`, `skill-invocation`, `dsh-tui-btw`, `dsh-tui-recap`). Battu : « source inconnue = Romain », la règle d'opencode (commit 3169418) : dsh injecte des contextes à chaque tour (`runtime-context`, `skill-catalog`, mesurés), tous les tours de pair seraient marqués mêlés.
- **Propriétaire du tour lu dans `inbox.nextTurn[0]` au `turn/start`.** Battu : premier message réclamé, que l'ordre non spécifié d'un lot rend faux quand un steer et un followup partent ensemble.
- **Textes de coupure et de sortie confondus.** Battu : les distinguer par un délai d'une seconde, que la fin réelle de la TUI dépasse.
- Voir aussi la section « Battu » de l'étude (options B à E, `--patch` par lancement, paquet de plugin, libproc).

## Critères d'acceptation

**AC-1 - Installation réversible.** Quand Romain lance `idnma install --agent dst`, alors le bloc du plugin est dans `~/.dsh/cordis.patch.yml`, le bloc coéquipier dans `~/.dsh/AGENTS.md`, la skill dans `~/.dsh/skills/generic-idnma-network/` ; `uninstall` rend chaque fichier à l'octet près, ou le retire s'il n'existait pas. *Vérifié par* : tests `tests/install-dst.test.ts` (fichier absent, `[]` commenté, liste non vide, mise à jour du chemin, forme refusée) ; puis sur la machine : `cp` avant, `install`, `uninstall`, `cmp` et `test -e`, réinstallation.

**AC-2 - Inerte hors idnma.** Quand Romain lance `dst` hors idnma après l'installation, alors aucun plugin idnma ne se charge. *Vérifié par* : `dst` lancé dans un tmux privé, aucune ligne `dst-*` ajoutée au journal idnma, aucun `*.dst.sock`, aucune connexion.

**AC-3 - Lancement.** Quand Romain lance `idnma run dst` dans un pane, alors la TUI s'ouvre en chat sur le noyau DSH et un autre agent voit `dst-<divinité>-xxxx  idle  <pane>` dans `idnma peer list`. *Vérifié par* : `tmux capture-pane`, `idnma peer list` d'un autre agent, journal `dst-bridge-up`.

**AC-4 - Tour de pair au repos.** Quand un Claude envoie un message pendant que dst est au repos, alors la bulle `✉ <claude> · team message` s'affiche, dst traite le message et sa réponse finale revient au Claude marquée `[réponse automatique idnma]`, sans la ligne `⏵`. *Vérifié par* : capture du pane, message reçu par la session Claude, journal `dst-deliver followup` puis `dst-turn-end replied`.

**AC-5 - Brouillon intact.** Quand un message arrive pendant que Romain tape un brouillon, au repos comme en plein tour, alors le brouillon est intact. *Vérifié par* : `tmux capture-pane` avant et après, ligne de saisie identique.

**AC-6 - Message pendant un tour de Romain.** Quand un message `next` arrive pendant un tour de Romain, alors il est livré en `steer` avec le rappel, dst répond par `idnma peer send`, et le tour de Romain continue. *Vérifié par* : journal `dst-deliver steer`, réception chez l'expéditeur, capture du pane ; test de la table de choix sur faux `ctx`.

**AC-7 - dst écrit au réseau.** Quand Romain demande à dst « qui est sur le réseau ? » puis « demande à <pair> … », sous sandbox par défaut comme en `danger-full-access`, alors dst lance `idnma peer list` (sans s'y lister) puis `idnma peer send`, et le pair reçoit le message. *Vérifié par* : capture du pane dst (sortie de `peer list`), réception chez le pair ; tests de l'op `list` et du repli `DSH_IDNMA_CONTROL_TOKEN`.

**AC-8 - Échec et interruption nommés.** Quand le tour ouvert pour un pair échoue (API injoignable) ou que Romain l'interrompt (Échap), alors le pair reçoit une réponse automatique qui nomme l'échec ou l'interruption ; un message de pair encore en file survit à un Échap simple et passe au tour suivant ; s'il est écarté de la boîte, son expéditeur reçoit « écarté ». *Vérifié par* : tests plugin et livreur rejouant `turn/end error` et `aborted` de `captures.md`, et `discarded` ; recette Échap (tour de pair interrompu, message en file traité ensuite).

**AC-9 - `/new` suivi.** Quand Romain fait `/new`, alors le pair suivant atteint la nouvelle session ; un message de pair encore dans la boîte d'une session disposée est relivré à la nouvelle. *Vérifié par* : test plugin (`dropped disposed` puis relivraison) ; recette, journal `dst-foreground` avec le nouvel id puis tour 1 de la nouvelle session. (Mesuré le 29/10 : dst 0.17.0 refuse `/new` en plein tour, « Cannot start a new session while a turn is running », et la boîte est vide au repos : la relivraison n'a pas de déclencheur réel aujourd'hui, elle reste une garde testée. Rédaction d'origine, battue : « avec un message de pair en file, le message est traité dans la nouvelle session », intestable sur cette version.)

**AC-10 - Refus avant effet.** Quand Romain lance `idnma run dst --backend codex`, `idnma run dst -p "x"`, `idnma run dst update`, un engine avec `model:`, ou dst sans plugin installé, alors idnma refuse avec la raison, avant tout effet (ni inscription, ni lancement). *Vérifié par* : tests `tests/run.test.ts`.

**AC-11 - Sortie et pont perdu.** Quand Romain quitte dst avec des messages de pairs non livrés, ou que le pont est perdu, alors chaque expéditeur reçoit « non livré » (ou « réponse perdue » pour un tour en cours), et l'entrée du registre comme les sockets de la doublure disparaissent à sa sortie. *Vérifié par* : tests du livreur (`farewell`, coupure, fenêtre de grâce) ; recette : sortie de dst, `ls /tmp/idnma-$UID`, `idnma peer list`.
