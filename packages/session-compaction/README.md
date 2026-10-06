# Backend de compaction de session

Extension indépendante du fournisseur, utilisant le résumé natif de Pi. Aucun
appel modèle dédié à la décision ou à la mémoire : seule la compaction demande
le résumé natif. Pas de résumé personnalisé, de changement des réglages natifs
ou de code d’interface.

## Outils et contexte du modèle

- `session_compaction_status({})` : pourcentage estimé, disponibilité volontaire à
  60 %, seuil automatique natif effectif, phase, index mémoire et `unavailableNotes`.
- `session_memory_write({id,title,content})` : créer ou actualiser une note factuelle.
  Identifiant slug en minuscules (64 caractères), titre sur une ligne
  (80 caractères), contenu limité à 32768 octets UTF-8 ; 32 notes actives maximum.
- `session_memory_read({id,offset?,limit?})` : lecture ciblée, au plus 8000 caractères
  JavaScript UTF-16 par page. `nextOffset: null` indique la fin.
- `session_memory_delete({id})` : retirer une note de l’index de cette branche.
- `session_compact({reason})` : demander une compaction native volontaire lorsque
  l’usage connu atteint 60 %. Utiliser comme seul appel du lot, après mise à jour
  de la mémoire, à une frontière utile : investigation terminée, étape achevée ou
  changement de sujet. Disponibilité ne signifie pas compaction immédiate.
  Ne pas relancer automatiquement une demande échouée.

Chaque requête modèle reçoit un petit message éphémère indiquant le budget restant
et le seuil automatique inchangé. Après une compaction sur la branche active, ce
message contient aussi l’index mémoire actuel, jamais le contenu complet des notes.
Le hook `context` ne persiste pas ce message. Lire uniquement les notes pertinentes
pour la suite et revérifier les faits périmés. Conserver contraintes approuvées,
preuves vérifiées, décisions motivées, questions ouvertes et prochaines étapes ;
pas de secrets, conclusions spéculatives présentées comme des faits, logs bruts ou
transcripts complets.

L’extension ajoute uniquement des références dans ses entrées de session
personnalisées. **Pi enregistre néanmoins les arguments et résultats des outils** :
le contenu passé à write et les pages retournées par read peuvent rester dans le
JSONL, l’historique et les exports natifs. Supprimer les fichiers mémoire temporaires
n’efface pas le transcript de Pi.

## Stockage et cycle de vie

Un dossier privé aléatoire `pi-session-compaction-<pid>-<suffix>` est créé dans le
dossier temporaire système de Node, hors workspace. Un parent temporaire situé dans
le workspace est refusé. La canonicalisation du parent accepte les liens système,
comme `/var` sur macOS ; la racine privée du store ne peut pas être un lien symbolique.

Les fichiers sont des révisions immuables aléatoires, écrites avec ouverture
exclusive sans suivi de lien, permissions 0600, fsync et renommage atomique. Le
dossier est en 0700. Les lectures vérifient identité de racine, fichier régulier à
lien unique, propriétaire, permissions, taille bornée et métadonnées de référence.
Le type est contrôlé avant ouverture, puis l’identité du descripteur est revérifiée.
L’ouverture non bloquante empêche aussi une FIFO substituée entre ces contrôles
de suspendre la lecture ou la collecte ; le nombre d’octets effectivement lus est borné.
Le nettoyage valide toutes les entrées avant suppression, revalide leurs identités
et supprime seulement les fichiers réguliers connus, avec `owner.json` en dernier.
Jamais de suppression récursive.

Ce mécanisme ne sandboxe pas du code malveillant exécuté sous le même utilisateur
OS : les API portables Node ne proposent pas `openat`/`unlinkat` relatifs à un
file descriptor de dossier. Une mutation concurrente hostile par le même utilisateur
ne peut donc pas être totalement exclue. Les garanties filesystem nécessitent les
permissions POSIX et les ouvertures sans suivi de lien.

Les snapshots de branche référencent des révisions immuables et sont reconstruits
avec `getBranch()`, jamais depuis toutes les entrées. `/tree` restaure la révision
sélectionnée et invalide les anciennes continuations de compaction. `/reload`
conserve les fichiers grâce à un registre de symboles local au processus. Un
remplacement de session nettoie le store sortant ; reprendre cette session plus tard
ne ressuscite pas les fichiers. `unavailableNotes` compte les références expirées.
Un `/fork` vivant copie uniquement les notes de la branche sélectionnée dans un
nouveau store privé avant nettoyage de l’ancien. Une fermeture normale supprime
le store actif. Les fichiers de session et du dépôt ne sont jamais des cibles de
nettoyage.

Au démarrage, la collecte prudente d’orphelins exige le préfixe exact de l’extension,
un marqueur privé ouvert sans suivi de lien, pid/uid concordants, version reconnue,
et un propriétaire pour lequel `kill(pid,0)` rapporte **ESRCH**. Elle valide tous les
noms et stats avant suppression, refuse fichiers inconnus, liens, permissions
modifiées ou ownership ambigu, et conserve le marqueur jusqu’à la fin. Propriétaires
vivants, pids réutilisés et EPERM sont conservés. SIGKILL/crash n’exécutent pas le
shutdown ; le nettoyage est tenté au prochain démarrage sous le même parent
temporaire. Les marqueurs absents/invalides et les fichiers non identifiés restent
volontairement sur disque plutôt que d’être supposés supprimables. L’OS peut aussi
nettoyer son dossier temporaire indépendamment.

## Choix des API Pi et versions vérifiées

Les déclarations et sources utilisées sont celles de `@earendil-works/pi-coding-agent`
**0.99.2**, le SDK de développement épinglé : il explique le runtime utilisé par défaut
dans les tests locaux, pas la version cible de Pi. Les scénarios RPC peuvent aussi
tourner sur une installation Pi globale, notamment le croisement d’une demande
volontaire avec le seuil automatique. Pour sélectionner le global, `PI_TEST_HOST_ENTRY`
doit contenir le chemin de son `dist/index.js` ; `global` seul n’est pas une valeur
reconnue.

- `pi.getSettings()` fournit les réglages effectifs, incluant confiance projet,
  fusion et overrides runtime. L’API publique
  `SettingsManager.inMemory(snapshot).getCompactionSettings(ctx.model)` applique
  exactement les overrides fournisseur/modèle et leur validation, sans I/O disque
  ni écriture. Un second manager basé sur les fichiers manquerait les overrides
  runtime.
- Le seuil natif est strictement `tokens > contextWindow - reserveTokens`.
  `highPercent` reflète ce calcul, même avec overrides spécifiques ou compaction
  automatique désactivée. L’extension ne modifie jamais `enabled`, la réserve ou
  les tokens récents conservés. Aucun seuil n’est inventé si les réglages sont
  invalides.
- `ctx.compact(options)` est explicitement non-attendu ; la compaction manuelle
  native appelle `abort()` puis attend idle. Attendre ses callbacks dans `execute()`
  ou une frontière de cycle de vie bloquerait le run actif.
- `session_compact` retourne `terminate: true`. Une fois tous les résultats d’outils
  persistés, `agent_before_settle` appelle `ctx.compact` sans l’attendre et retourne
  immédiatement. Le settlement libère l’attente idle native ; Pi génère ensuite son
  résumé habituel. `onComplete` reprend via un message personnalisé de suivi avec
  `triggerTurn: true`. Aucune mutation dans `agent_settled`, notification seule.
  Identité de session, génération de branche et garde de callback unique empêchent
  les continuations périmées ou doubles. Le drapeau natif
  `session_compact_failed.aborted` prévaut sur le texte d’erreur : une annulation
  ne reprend jamais, même avec un message fournisseur sans mention d’annulation.
  Un échec ordinaire informe le modèle et continue sans retry automatique. Le texte
  d’erreur ne sert de fallback que si aucun résultat terminal explicite n’a été reçu.
- Si une compaction native satisfait une demande volontaire encore en attente,
  son résultat est conservé jusqu’à `agent_before_settle` tant que le modèle n’a
  pas déjà repris naturellement. Cette frontière ajoute alors un message de reprise
  et `continue: true` : le `terminate: true` de l’outil ne laisse pas la tâche arrêtée
  et aucun second résumé n’est demandé. Un nouveau `turn_start` consomme cette
  obligation, avant ou après la compaction : un follow-up utilisateur déjà traité
  ne reçoit ni réponse supplémentaire ni instruction de reprendre l’ancienne tâche.
  Ce garde s’applique aussi aux callbacks tardifs de compaction manuelle. Une annulation
  invalide la reprise ; un échec ordinaire est signalé sans nouvelle compaction.
  Les hooks ne remplacent jamais le résumé et n’annulent jamais la compaction native.

**Limite one-shot :** l’outil volontaire refuse les modes `print`/`json`. Leur host
ferme le runtime dès que `prompt()` termine ; les callbacks post-idle de compaction
manuelle ne peuvent pas garantir achèvement/reprise avant cette fermeture. La
compaction automatique native reste inchangée en one-shot ; `/compact` manuel reste
disponible en Pi interactif. Les outils mémoire et l’injection éphémère budget/index
ne dépendent pas du rendu TUI/RPC. Un host SDK personnalisé doit garder le runtime
vivant jusqu’à achèvement et continuation de la compaction manuelle ; la résolution
du `prompt()` initial ne signifie pas que cette continuation a terminé.

## Contrat UI

`pi.events.emit('session-compaction:state', state)` publie :

```js
{ percent: number | null, lowPercent: 60, highPercent: number | null,
  phase: 'below' | 'available' | 'automatic' | 'compacting' | 'unknown',
  enabled: boolean | null }
```

`enabled` représente le réglage automatique natif, pas un interrupteur de
compaction volontaire. `null` signifie résolution des réglages échouée, pas
compaction automatique désactivée. L’UI demande un nouvel état par
`session-compaction:request-state`. Aucun event bus n’est nécessaire au
fonctionnement des outils sans UI.

## Validation

```sh
node --test tests/session-compaction*.test.mjs tests/compaction-runtime.test.mjs
PI_TEST_HOST_ENTRY="$(npm root -g)/@earendil-works/pi-coding-agent/dist/index.js" node --test tests/compaction-runtime.test.mjs
```

Les tests ciblés utilisent de vrais fichiers et SessionManager : réglages/overrides,
stockage privé atomique, liens/remplacement de racine, nettoyage prudent, orphelins,
reload/tree/fork/switch, pagination, injection de l’index seul, frontières volontaires,
mutations concurrentes et continuations périmées/annulées. Les tests RPC réels
vérifient résumé natif, préservation des résultats d’outils,
reprise modèle, index sans contenu complet, lecture ciblée, compaction automatique
pendant une boucle d’outils, croisement volontaire/automatique, priorité d’un
follow-up utilisateur sans reprise supplémentaire de la tâche remplacée, et
nettoyage à la fermeture. Les régressions de fichiers spéciaux utilisent de vraies FIFO dans des
processus isolés avec arrêt forcé borné ; les parents internes nommés `..cache`
et leurs alias symboliques sont également refusés.
