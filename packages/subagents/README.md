# Sous-agents

Cette extension permet à une session Pi parent de déléguer des missions généralistes à des
sessions Pi enfants indépendantes. Chaque enfant utilise le répertoire de travail du parent :
l’extension ne crée ni worktree, ni sandbox, ni rollback des écritures déjà réalisées.

Plateformes : macOS et Linux. L’arrêt des enfants et de leurs descendants s’appuie sur les
groupes de processus et sur `/bin/ps` ; sous Linux, installer `procps` (`procps-ng` sur Alpine)
lorsqu’il manque, par exemple dans une image Docker `slim`. Sans `ps` compatible, ou sous
Windows, `subagent_start` refuse la mission avant de lancer un processus et indique la cause.

## Utilisation

Les outils du parent sont :

- `subagent_models` — consulte, par pages, les fiches du catalogue utilisateur qui correspondent
  aux modèles actuellement disponibles selon Pi, indépendamment de la liste de rotation des modèles.
  Il indique capacités et tarifs déclarés par Pi, mais ne mesure ni qualité réelle ni latence ;
- `subagent_start` — accepte une mission, son contexte sélectionné et, facultativement, un
  modèle, un niveau de raisonnement ou une liste d’outils restreinte. Le parent respecte les
  consignes explicites de la session ; sinon il peut consulter `subagent_models` pour choisir
  selon la mission, sans inventer un modèle ou un niveau de raisonnement ;
- `subagent_send` — précise une mission active ou ouvre une continuation admise pour le même
  enfant après son résultat ;
- `subagent_list`, `subagent_result` et `subagent_wait` — consultent les états, retrouvent
  les identifiants de tous les runs d’un enfant par `subagent_list({agentId, cursor, limit})`,
  lisent les résultats paginés et permettent une attente facultative. `subagent_wait` attend
  le dernier run de chaque `agentIds` par défaut ; `runIds`, dans le même ordre, cible des
  runs précis ;
- `subagent_stop` — arrête uniquement l’enfant désigné. Il ne restaure pas les fichiers que
  cet enfant a déjà modifiés.

Sans choix explicite, un enfant hérite du modèle et du niveau de raisonnement actifs du
parent au lancement. Il reçoit la mission et le contexte sélectionné, pas automatiquement
l’historique complet du parent. Il hérite des capacités reproductibles applicables, mais
ne peut pas déléguer à son tour via cette extension. Un outil absent ou non reproductible
est signalé plutôt que remplacé silencieusement.

Les recommandations sont lues dans `~/.config/pi-extensions/subagent-models.json`, relu à
chaque consultation. La première consultation le génère à partir du catalogue livré
(`packages/subagents/model-guide.json`), avec une empreinte de son contenu dans `generated`.
Tant que ses fiches ne sont pas modifiées, il suit les mises à jour du package ; un simple
reformatage ne compte pas comme une modification. Dès qu’une fiche est modifiée, ajoutée ou
supprimée, le fichier appartient à l’utilisateur : il n’est plus jamais réécrit, et
`subagent_models` signale une mise à jour ultérieure du catalogue livré. Supprimer le fichier
le régénère et reprend les mises à jour ; les modifications personnelles sont alors à reporter.

Format : `version: 1`, `models` avec `provider`, `id`, `preferFor`, `avoidFor`, `tradeoff` et,
facultativement, `effort` pour `simple`, `standard`, `complex`, `sources` (URL `https://`) et
`reviewedOn` (`AAAA-MM-JJ`). Une fiche sourcée renvoie à une documentation fabricant, pas à une
qualité démontrée par benchmark ; une fiche sans source est un avis personnel. Les fiches du
catalogue livré ont toujours une source et une date. Pour ajouter un modèle, vérifier d’abord
son identifiant exact. Un ancien champ `status` est ignoré. Les prix et la disponibilité viennent
de Pi, non de ce fichier : les tarifs API ne représentent pas nécessairement la facturation
d’un abonnement. Une fiche non disponible dans Pi n’est pas proposée ; un modèle disponible
sans fiche peut toujours être spécifié explicitement mais n’a pas d’avis qualitatif associé.
Un fichier illisible ou invalide produit une erreur explicite, sans choix automatique ni
remplacement par le catalogue livré.

L’état inséré dans l’historique du parent ne garde que les dix runs récents et leur nombre total ;
les identifiants plus anciens restent consultables par la pagination de `subagent_list`.

Les résultats sont toujours annoncés comme **disponibles et non vérifiés**. Le parent poursuit
son travail indépendant ; les notifications de fin suffisent à reprendre le travail dépendant,
sans appel systématique à `subagent_wait`. Cet outil est facultatif : il sert lorsque le parent
est bloqué sur une dépendance encore active ou souhaite synchroniser un groupe d’exécutions
actives. Il ne faut pas attendre un run déjà fini : lire directement sa sortie avec
`subagent_result`. Dans tous les cas, le parent doit lire et examiner les résultats dont sa
conclusion dépend avant de conclure ; une notification ou un retour de `wait` ne remplace pas
cette lecture. Un résultat enfant ne constitue pas une nouvelle instruction utilisateur ni une
autorisation d’élargir le travail. Les notifications non confirmées restent récupérables par
identifiant ; après un contexte compacté, un rappel borné à la branche active indique au parent
les résultats à relire, sans lancer un tour modèle supplémentaire.

## Suivi TUI et lecture des résultats

En TUI, `/subagents` ouvre une liste plein écran, puis le détail plein écran de la mission
choisie ; `/subagents settings` ouvre les réglages globaux, également en plein écran,
y compris la saisie de la limite de concurrence. Ces écrans recouvrent temporairement le
fil, l’éditeur et le footer, comme `/ps`, et s’adaptent au redimensionnement du terminal.
La liste sépare les missions **actives** et **terminées**, avec marqueurs d’état ; les
colonnes alias, état et durée restent alignées. ↑/↓, Page Up/Down, Home/End et la molette
naviguent dans la liste ; Entrée ouvre le détail et `s` arrête uniquement la mission active
sélectionnée, sans contourner les protections de branche. Une fin de mission conserve la
sélection même si elle change de section. Échap ferme la liste sans arrêter les agents.
Dans les réglages, Entrée change une valeur ; une limite invalide reste dans l’éditeur
avec une erreur. Échap annule la saisie puis revient aux réglages, sans enregistrer. Avec l’extension
`activity-indicator`, son widget partagé affiche le nombre de missions actives avec les tâches shell.
Sans cette extension, le widget autonome `subagents-status` affiche les missions actives
(au plus six) et disparaît dès qu’aucune mission ne travaille. Les archives restent
consultables dans `/subagents`. Aucun de ces widgets ne remplace le footer ni l’indicateur
Graphite. Le détail propose trois vues, sur tous les formats
de terminal :

- `r` — **Réponse finale** de la dernière exécution uniquement, à vérifier, rendue en Markdown dans une colonne de lecture de 100 caractères maximum. Les énumérations numérotées que le modèle a écrites sur une seule ligne sont séparées pour la lecture, sans modifier la réponse archivée ;
- `a` — **Activité totale**, le fil des messages et outils de la session enfant,
  toutes exécutions confondues, rendu avec les composants natifs Pi des messages et outils.
  Le Markdown, les listes et les blocs de code sont conservés pendant la génération ; les
  résultats intermédiaires des outils arrivent en direct. Ouvrir le détail en cours de travail
  récupère également le message et les outils déjà en cours. Le raisonnement interne n'est
  pas affiché et cette vue reste en lecture seule ;
- `i` — **Informations** : mission et contexte initiaux, configuration, consommation
  cumulée incluant l'exécution en cours et durée totale, puis la liste de toutes les exécutions avec leur état,
  leurs instructions (y compris les ajouts acceptés en cours), leur durée et leur consommation.
  Les tokens d'entrée, de sortie et de cache, le coût et l'occupation du contexte sont actualisés
  pendant le travail. L'occupation du contexte est l'estimation Pi, avec la limite du modèle et
  le pourcentage utilisé ; elle ne correspond pas au cumul des tokens facturés.
  Les sections et exécutions sont accentuées, les consignes indentées et les chiffres regroupés
  pour la lecture. Le modèle, le raisonnement et les outils effectifs sont affichés, sans
  ligne supplémentaire sur l’origine héritée ou explicite de ces choix.
  L’exécution 1 renvoie à la mission initiale
  lorsqu’elle est identique, plutôt que de la répéter ; les ajouts restent affichés.

La durée dans la liste et les informations globales est la somme des durées des exécutions,
y compris celle en cours, sans les pauses entre exécutions. Un historique incomplet affiche
« durée indisponible ». Le haut du détail affiche seulement l’état ; les durées individuelles
restent dans les blocs d’exécution.

L'activité réutilise les composants de présentation de Pi plutôt que des extraits limités à
quelques lignes. Les outils natifs réutilisent leurs fonctions de rendu ; les outils d'extensions
sans fonction de rendu accessible utilisent la carte native générique, et non une imitation
maison. `Ctrl+O` (ou le raccourci Pi d'expansion des outils) développe/replie leurs sorties.
Les images restent signalées comme artefacts sans être affichées dans ce plein écran.
Les coûts affichés dans Informations sont arrondis à trois chiffres significatifs ; les données
conservées ne sont pas modifiées. Tokens et coûts ne sont mis à jour que lorsque le fournisseur
les communique : pendant une génération sans nouvelle mesure, la dernière valeur connue
reste affichée. Une mesure absente est indiquée indisponible, jamais inventée. Le cumul d'une
exécution couvre tous ses appels au modèle, pas uniquement sa réponse finale. Les statistiques
RPC sont consultées aux frontières des messages/outils et de la compaction, sans appel modèle
supplémentaire ni lecture RPC à chaque fragment de texte. Après un arrêt ou une erreur de
lecture des statistiques, les compteurs connus sont conservés mais peuvent rester incomplets.

←/→ changent de vue ; ↑/↓, Page Up/Down et la molette défilent et chargent automatiquement
les pages suivantes de réponse ou d’activité en arrivant en bas. Home retourne au début de
la fenêtre de lecture conservée ; End charge les pages suivantes et rejoint la fin. Le suivi en direct défile automatiquement
à la fin à l'ouverture d'une mission active, puis seulement lorsque la lecture est déjà en bas ;
remonter conserve sa position. Chaque vue conserve sa position de défilement,
et le détail utilise toute la hauteur disponible, avec en-tête et raccourcis fixes. À l’ouverture, une mission active affiche
Activité ; sinon elle affiche Réponse. La fin d’une exécution ne force pas un changement de
vue. `s` est disponible uniquement tant que la mission est active et arrête seulement celle-ci ;
Échap retourne à la liste. L’arrêt n’annule pas les écritures déjà faites.

La consommation absente reste indiquée « indisponible ». Les anciennes archives sans
instructions enregistrées affichent « Instructions indisponibles » : l’historique manquant
n’est pas reconstitué depuis la mission globale. « Terminé » décrit uniquement la fin de
l’exécution : Pi n’effectue aucune vérification automatique du travail enfant. Une continuation
via `subagent_send` crée une nouvelle exécution si la précédente est finie ; sinon elle
transmet une instruction à l’exécution en cours. Les réponses antérieures restent consultables
par identifiant avec `subagent_list` puis `subagent_result`. La réponse affichée est à vérifier
par le parent : cette mention ne devient pas un statut « vérifié » après consultation.

Dans le fil parent, les cartes d'outils sont des résumés : `subagent_send` accuse réception
sans garantir la fin du travail ; `subagent_wait` rapporte les fins et leur durée ;
`subagent_result` lit une page de réponse. Le JSON complet reste transmis au modèle mais
n'est pas affiché brut dans les cartes TUI. Les notifications de résultat sont asynchrones
et peuvent donc arriver après un `wait` ou un `result` déjà affiché. Si le parent a déjà
lu la réponse de ce run, la notification de succès est masquée dans le TUI, tout en restant
transmise au modèle ; les échecs et annulations restent visibles. Une fin non encore lue
conserve une annonce compacte avec identifiant de run, heure de fin et durée. Une carte
visible de résultat terminé affiche un court extrait non vérifié de la réponse, également
conservé dans les métadonnées privées du run ; le résultat complet reste dans son artefact.
La vue garde une fenêtre bornée des pages déjà lues ; fermer et rouvrir le détail permet
de relire les pages antérieures. Les traces complètes restent dans les artefacts privés,
non dans le fil principal.

`/subagents list` affiche un résumé textuel. Hors TUI, `/subagents` affiche également
ce résumé et `/subagents settings` consulte les réglages sans les modifier. Les commandes
textuelles de détail, d’arrêt et de modification directe des réglages ne sont pas proposées :
en TUI, ces actions passent par les interfaces plein écran. Les outils `subagent_*` restent
disponibles au modèle dans tous les modes ; la communication RPC interne des enfants
n’est pas affectée.

Les deux réglages globaux modifiables — délégation automatique et limite de concurrence —
sont accessibles et sauvegardés depuis `/subagents settings`. Le champ `version` du fichier
est un marqueur de format, pas un réglage utilisateur. Le modèle, le raisonnement et les
outils sont sélectionnés par mission, explicitement ou par héritage du parent.

### Démonstration locale sans clé

Depuis la racine du dépôt, démarrer le fournisseur déterministe sur un profil et un HOME
isolés ; aucune mission de démonstration ne modifie le projet :

```sh
DEMO_ROOT=$(mktemp -d)
mkdir -p "$DEMO_ROOT/home" "$DEMO_ROOT/agent"
node tests/fixtures/subagents/demo-server.mjs > "$DEMO_ROOT/server.log" 2>&1 &
DEMO_SERVER_PID=$!
# Copier l'URL affichée dans server.log, par exemple http://127.0.0.1:54321/v1.
HOME="$DEMO_ROOT/home" PI_CODING_AGENT_DIR="$DEMO_ROOT/agent" PI_OFFLINE=1 \
  SUBAGENT_TEST_PROVIDER_URL="<URL de server.log>" \
  pi --offline --no-extensions -e . -e ./tests/fixtures/subagents/deterministic-provider.js \
  --model subagent-test/deterministic --no-session
kill "$DEMO_SERVER_PID"
rm -rf "$DEMO_ROOT"
```

Dans Pi, choisir la confiance **pour cette session seulement**, puis envoyer `DEMO_START`.
Ouvrir `/subagents` pour examiner les deux missions (la lente lit `README.md` avant de
terminer après environ dix secondes) ; défiler la vue Activité pendant l’attente puis appuyer
sur `r` pour lire la réponse finale, et sur `i` pour consulter les informations. Lors d’un
second essai, appuyer sur `s` dans son détail pour tester l’arrêt sélectif, puis consulter
`/subagents settings` et `/graphite-ui off`. Redimensionner le terminal à 120, 80 et
40 colonnes. Cette démonstration de protocole ne vérifie pas le jugement d’un modèle réel.

## Paramètres et confirmations

Les paramètres globaux sont enregistrés dans
`~/.config/pi-extensions/subagents.json` : `autoDelegate` vaut `true` et `maxConcurrent`
vaut `4` à la première création. Ils sont communs aux projets et ne modifient pas le
`/settings` natif de Pi.

Quand `autoDelegate` est désactivé, **chaque lancement**, y compris une continuation inactive,
demande une confirmation utilisateur. En RPC, une confirmation sans réponse est refusée après
30 secondes ; en modes print ou JSON, une confirmation impossible refuse explicitement la mission.
La limite de concurrence compte les runs en démarrage, actifs et en arrêt ; une demande
au-delà du plafond est refusée, elle n’est pas mise en file. Si l’arrêt du processus échoue,
le run reste en arrêt et occupe sa place jusqu’à une nouvelle tentative réussie via `subagent_stop`.

Une extension enfant peut demander un dialogue au parent. Les confirmations, sélections et
saisies simples sont relayées en TUI et en RPC avec une attente bornée. L’éditeur multiligne
est relayé en TUI, mais **refusé explicitement en RPC** : le contrat d’éditeur RPC utilisé ne
permet pas de fermer une demande restée sans réponse. Cela ne concerne ni l’édition des
fichiers du projet ni la commande `/subagents settings`.

## Runtime Pi et diagnostic

Chaque enfant charge le SDK ESM de l’installation Pi réellement utilisée par le parent,
pas le SDK de développement du package. L’entrée canonique, la version et une empreinte
SHA-256 du manifeste, de tous les fichiers réguliers sous le répertoire de l’entrée SDK
et du `bin` CLI sont transmises uniquement dans le bootstrap IPC privé, puis vérifiées
par le worker. Cette couverture est
conservatrice : modifier un asset, une source map ou un autre fichier de cette distribution
exige aussi un redémarrage, au prix d’une lecture initiale plus large (ensuite cachée).
La baseline est établie au chargement de l’extension, conservée lors de son rechargement,
puis contrôlée avant lancement et readiness : réécrire un module au même chemin avec la
même version refuse un nouvel enfant. Chaque lien interne de fichier ou répertoire est
empreinté par son chemin logique et sa cible, même si cette cible a déjà été parcourue ;
la déduplication des contenus borne toujours les cycles. Le cache des empreintes est invalidé par inode,
taille et timestamps mtime/ctime nanoseconde, même si une réécriture restaure le mtime.
Ce n’est pas une attestation de tout le processus ou des dépendances externes au package Pi.

La CLI `dist/bundle/cli.js` utilise des exports SDK virtuels distincts de ceux de
`dist/index.js` ; leur identité objet n’est pas un contrat. Le package hôte est lié à
l’exécutable Pi effectif, sélectionné avant tout import SDK afin qu’un SDK de développement
local ne contourne pas les alias du chargeur natif `.js`. Sa baseline est liée au processus
CLI, indépendamment de l’identité d’une nouvelle classe SDK : retargeter le launcher vers
une autre installation ne peut pas la renouveler au rechargement. Un launcher pointant
ailleurs ou devenu inaccessible exige un redémarrage ; la namespace SDK originale reste disponible pour les
archives/UI, sans devenir un fallback worker. Les tests CLI lancent le `bin` déclaré du
package. Dans une intégration SDK native sans point d’entrée CLI, fournir le
namespace hôte explicitement à `subagents(pi, { sdk })` si l’arbre de dépendances de
l’extension ne correspond pas à celui du parent. L’import du point d’entrée ne résout
pas le SDK : l’injection explicite peut précéder toute résolution locale. Sans injection,
l’initialisation est asynchrone et l’import par défaut reste dans le point d’entrée pour
bénéficier des aliases du chargeur SDK Pi ; les appelants directs doivent attendre
`await subagents(pi, options)` (le chargeur Pi le fait déjà).
Les contrats SDK, ressources, identité de session, modèle, raisonnement et état RPC inactif
sont contrôlés avant le premier prompt. Une entrée ou capacité manquante refuse le
lancement : aucun fallback local, téléchargement ou sondage par appel modèle.

### Mise à jour pendant une session ouverte

Le descripteur est recalculé lors de chaque création ou reprise, sans persister le chemin
SDK dans les agents. **Si Pi est mis à jour pendant que la session tourne, redémarrer Pi
avant un nouveau démarrage d’enfant.** Le parent garde l’ancien code en mémoire ; le
contrôle refuse de charger le nouveau SDK dans un enfant de ce parent.

Les enfants déjà actifs ne sont pas migrés par ce contrôle ; consulter les archives ne
nécessite aucun lancement de worker. Modifier une image, un fichier de données ou une
source map du répertoire SDK surveillé peut aussi provoquer ce refus, même sans changement
fonctionnel. Les fichiers du projet et les extensions installées hors de ce répertoire
ne sont pas inclus dans cette empreinte.
Les dépendances Pi de développement servent aux tests, pas de règle de compatibilité en
production.

### Diagnostic et revalidation

`pnpm check:pi` diagnostique la commande Pi externe trouvée dans PATH, en excluant les
shims `node_modules/.bin`. Une sonde privée chargée par le launcher effectif identifie le
SDK hôte, même si le launcher est un script shell hors du package. Elle utilise un HOME,
un cwd et un agentDir temporaires privés, aucune extension utilisateur et aucun prompt
modèle ; ces fichiers sont supprimés après le diagnostic. Il vérifie les contrats SDK et
la cohérence CLI/SDK, pas le runtime d’une session déjà ouverte ni une mission complète.
On peut aussi lancer `node scripts/check-pi-compat.mjs` depuis la racine du dépôt pour
éviter le bootstrap pnpm/Corepack ; cela ne télécharge pas de SDK.

Support actuel : Node sur macOS ou Linux, installation npm/pnpm avec SDK ESM accessible. Bun
compilé, Node SEA et nouvelles plateformes ne sont pas revendiqués. Les intégrations
locales se rejouent après une mise à jour, sans clés réelles :

```sh
# Entrée absolue dist/index.js du Pi à vérifier, hors du SDK de dev si souhaité.
PI_TEST_HOST_ENTRY="/chemin/vers/pi/dist/index.js" COREPACK_ENABLE_NETWORK=0 node --test \
  tests/pi-compatibility.test.mjs tests/check-pi-compat.test.mjs \
  tests/subagents-runtime.test.mjs tests/subagents-worker.test.mjs \
  tests/subagents-parent-e2e.test.mjs tests/subagents-e2e.test.mjs \
  tests/subagents-lifecycle.test.mjs tests/subagents-sdk-host.test.mjs
```

Les tests parent chargent un package temporaire sans SDK Pi, typebox ou pi-tui local,
avec chemin contenant des espaces et symlink ; les fournisseurs HTTP sont déterministes
et locaux. Des fixtures portant d’autres versions vérifient l’absence d’allowlist de
release, mais ne prouvent pas le comportement de versions futures réelles. Le parcours
SDK natif sans CLI, avec injection explicite ou aliases hôte, est couvert par
`tests/subagents-sdk-host.test.mjs`. Un TMPDIR privé évite de partager les registres de
processus entre exécutions de tests indépendantes.

## Données et cycle de vie

Les métadonnées et résultats sont écrits avant leur annonce sous
`<agentDir>/subagents/<session>/<agent>/`, avec répertoires `0700` et fichiers `0600`.
Les résultats et transcriptions enfant se lisent par pages bornées ; les sorties longues ne
sont pas dupliquées dans les métadonnées. Les résultats restent consultables à la reprise de
leur session. Les transcriptions et résultats peuvent contenir des informations sensibles et
doivent être supprimés manuellement lorsqu’ils ne sont plus nécessaires.

Une fermeture, un rechargement, un changement de session ou une navigation `/tree` tente d’arrêter les
missions actives. Si deux tentatives de nettoyage échouent à la fermeture, l’erreur est signalée et le
registre des processus et le gestionnaire restent disponibles pour de nouvelles tentatives, y compris
au démarrage ou à la fermeture d’une session suivante dans le même processus Pi. Si le nettoyage
échoue encore au démarrage, l’extension refuse de restaurer les missions ou d’en accepter de nouvelles :
une mission encore en cours n’est pas présentée comme annulée. Une nouvelle tentative de nettoyage
a lieu à la prochaine fermeture ou reprise de session. Ne pas considérer les processus comme arrêtés
avant confirmation ; quitter Pi après un échec peut encore laisser un processus survivant si le
watchdog ne parvient pas non plus à l’arrêter.
Après un arrêt réussi, les missions apparaissent interrompues, sans relance automatique. Les artefacts
obtenus restent privés et consultables ; une mission d’une branche abandonnée ne peut pas être
continuée depuis une autre branche. Une mission ancrée dans un ancêtre toujours visible
n’est pas arrêtée par `/tree`. Une continuation après reprise, arrêt ou échec de lancement
recrée le processus enfant à partir de sa transcription sauvegardée, si cette transcription
et les capacités autorisées sont encore disponibles ; sinon elle est refusée avant admission.
Une archive de métadonnées endommagée est signalée sans empêcher la restauration des autres
enfants ; elle n’est ni effacée ni réparée automatiquement. En parent `--no-session`, les
artefacts de l’extension sont éphémères et supprimés à la fermeture.

Les enfants héritent d’un instantané des capacités reproductibles du parent, avec leurs propres
instances navigateur/LSP. Les extensions héritées gardent l’ordre de chargement du parent.
Pour un parent lancé par le CLI Pi, cet ordre est recalculé depuis ses arguments et le
gestionnaire de packages de Pi : extensions `-e` locales d’abord, puis, sauf avec
`--no-extensions`, les extensions des réglages (`extensions` et `packages`) dans l’ordre que
Pi leur donne au chargement. Les réglages seuls ne font jamais foi. Ce calcul n’installe rien ; une source `-e` distante n’est pas
classée. Un hôte SDK peut charger d’autres chemins ou ignorer les réglages : aucun ordre
n’est supposé pour lui. Si la priorité relative de sources distinctes n’est pas attestée, le
lancement est refusé au lieu de charger des overrides dans un ordre supposé. Une capacité requise non reproductible est une erreur
explicite ; les outils de délégation ne sont jamais transmis à un enfant. Restreindre
les outils n’est pas une sandbox système.

## Coût et modes Pi

Chaque mission consomme des appels au modèle supplémentaires. Le plafond borne les exécutions
simultanées, pas le coût total ; les compteurs Graphite ne constituent pas un total garanti des
coûts enfants.

L’extension fonctionne dans les parents TUI, RPC, print et JSON. Seul le TUI fournit le suivi
visuel interactif ; RPC, print et JSON conservent la consultation textuelle. En mode sans UI,
les confirmations exigées sont refusées. Le parent attend les missions encore actives à la fin de son run afin de ne pas quitter
silencieusement avant leurs résultats ; annuler le parent libère cette attente sans redémarrer
le modèle.
