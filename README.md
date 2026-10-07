# pi-extensions

Extensions personnelles pour Pi.

## Extensions

| Extension | Fonction | Configuration |
| --- | --- | --- |
| [activity-indicator](packages/activity-indicator/README.md) | Barre TUI partagée : durée Graphite et compteurs des travaux actifs, quel que soit l’ordre de chargement | Les producteurs conservent leur widget autonome si la barre est absente |
| [code-intelligence](packages/code-intelligence/README.md) | Navigation LSP TypeScript/JavaScript à la demande via l’unique tool `code_nav` | Aucune ; serveur et TypeScript embarqués, versions locales du projet prioritaires |
| [graphite-ui](packages/graphite-ui/README.md) | Thème sombre, en-tête compact, chronomètres d’exécution, footer responsive avec contexte, consommation, Git local et statuts | Appliquée automatiquement en mode TUI ; `/graphite-ui` permet de basculer les composants ou rafraîchir Git |
| [session-compaction](packages/session-compaction/README.md) | Compaction volontaire dès 60 %, couleur du pourcentage de contexte dans Graphite et mémoire temporaire par fichiers hors dépôt | Seuil automatique natif inchangé ; mémoire supprimée à la fermeture, index et lectures ciblées après compaction |
| [web](packages/web/README.md) | Recherche Brave, lecture Markdown et documentation versionnée Context7 | `BRAVE_API_KEY` et/ou `CONTEXT7_API_KEY` dans `~/.config/pi-extensions/.env` ou l’environnement |
| [ui-check](packages/ui-check/README.md) | Navigateur Chromium à la demande : interactions, captures et diagnostics UI | Installer Chromium via Playwright ; modèle acceptant les images pour les captures |
| [subagents](packages/subagents/README.md) | Délégation asynchrone généraliste vers des sessions Pi enfants | macOS ou Linux (`ps` de procps) ; modèle parent disponible ; les missions consomment des appels modèle supplémentaires |
| [background-tasks](packages/background-tasks/README.md) | Commandes shell non interactives en arrière-plan, suivies par ID | Processus arrêtés à la fermeture ou au changement de session ; logs privés temporaires |
| [ask-user](packages/ask-user/README.md) | Questions de l’agent : choix unique/multiple, réponse libre et récapitulatif avant envoi | Terminal interactif uniquement ; aucune configuration |

Les extensions existantes (hors `subagents`) ne font aucun appel à un modèle
secondaire et ne dépendent pas du fournisseur IA utilisé dans Pi. `subagents`
utilise le modèle choisi pour chaque mission enfant. L’extraction des pages est locale.
Le thème Graphite est livré par le package et l’extension UI le sélectionne au démarrage.

## Développement

Node.js >=22.22.2 et pnpm 10.26.2 :

```sh
pnpm install --frozen-lockfile
pnpm --filter @clement_chsn/pi-ui-check exec playwright install chromium
pnpm check
pnpm test
pnpm check:pi
```

`pnpm check` enchaîne ESLint, TypeScript (`checkJs`) et Prettier ; `pnpm format` applique
le formatage. Les limites de taille et de complexité s’appliquent à tout le code : la
baseline `eslint-suppressions.json` est vide et doit le rester ; une violation se corrige en
découpant le code, pas en l’ajoutant à la baseline. De même, aucun module ne porte
`// @ts-nocheck` : une erreur de type se corrige par une annotation JSDoc, pas en excluant
le module.

Biome 2.5 a été évalué pour remplacer ESLint et Prettier, puis écarté : il n’a pas
d’équivalent à `max-depth`, ne mesure que la complexité cognitive et ne peut pas interdire
les commentaires de suppression comme `noInlineConfig`. Le gain de vitesse est négligeable à
cette taille.

### Packages

Chaque extension est un package npm autonome dans `packages/<nom>/`, nommé
`@clement_chsn/pi-<nom>` et publié sous licence MIT.
Il déclare son manifeste `pi`, ses propres dépendances et, en `peerDependencies`, les
packages fournis par Pi. Les extensions fonctionnent seules et se complètent quand elles
sont chargées ensemble, uniquement par les événements `pi.events`.

Le code commun vit dans `@clement_chsn/pi-shared` (`packages/shared/`) : des
modules sans état, un fichier par sujet, importés par leur nom avec une version exacte.
Une extension n’importe jamais un autre package par chemin relatif (règle ESLint) ;
`tests/packages.test.mjs` vérifie que chaque import est déclaré par son package et que
chaque extension se charge seule. Les
versions des packages fournis par Pi et de TypeScript sont centralisées dans le catalogue
de `pnpm-workspace.yaml`. La racine reste un package Pi privé qui charge toutes les
extensions pour le développement (`pi -e .`).

Les tests utilisent un faux serveur LSP stdio, le serveur TypeScript local pour quelques
régressions d’intégration, des réponses Brave et Context7 simulées, des serveurs HTTP
locaux isolés et Chromium réel pour `ui-check`. Ils ne consomment aucune clé réelle,
aucun quota distant ni appel modèle. Les dépendances d’exécution sont locales au
package ; `typebox` est fourni par Pi et installé en développement pour les tests.
Cela ne garantit pas une exécution sans réseau : Corepack peut acquérir pnpm si son
cache est vide, et les tests du vrai TypeScript peuvent déclencher une acquisition npm.
Pour bloquer ces acquisitions, utiliser des caches privés, npm offline et
`COREPACK_ENABLE_NETWORK=0` avec un pnpm déjà disponible ; `PI_OFFLINE` seul ne suffit pas.

Le manifeste `pi.extensions` ne charge que les points d’entrée déclarés, pas les
modules auxiliaires.

### Publication

`pnpm -r publish --dry-run` vérifie les dix packages (la racine est privée) ; `pnpm -r publish`
les publie avec un accès public. pnpm remplace `workspace:*` et `catalog:` par des versions
exactes dans les manifestes publiés.

### Sous-agents

`packages/subagents/` fournit le mécanisme de délégation et son moteur interne.
Il lance avec Node une session Pi RPC indépendante utilisant le SDK de l’installation
Pi du parent, conserve son contexte entre deux missions et distingue l’acceptation RPC de la fin réelle
(`agent_settled`). Son bootstrap passe par IPC, tandis que stdin/stdout restent réservés
au JSONL RPC ; stderr est borné à 64 Kio.

Un instantané versionné peut reproduire le modèle et le raisonnement effectifs, les outils
actifs avec leur provenance, les extensions locales rechargeables, les skills, les
instructions et les réglages opérationnels du parent. La découverte implicite est
neutralisée, l’allowlist d’outils reste un plafond et toute incompatibilité requise bloque
le worker avant la mission. Les overrides d’authentification restent dans la charge IPC
privée, hors des métadonnées de capacités. Chaque worker recharge ses propres instances
LSP et navigateur, tout en conservant le même répertoire de travail.

Une mise à jour compatible de Pi ne nécessite pas de réaligner les dépendances de
développement ni de modifier une version autorisée. Le parent transmet au worker une
entrée SDK ESM canonique par IPC ; les contrats nécessaires et l’état RPC réel sont
vérifiés avant la mission. Une empreinte des fichiers runtime est observée dès le chargement
de l’extension et revalidée au lancement, même si le numéro de version n’a pas changé.
Aucun SDK local de remplacement n’est utilisé. **Après une mise à jour de Pi pendant
une session ouverte, redémarrer Pi avant tout nouveau démarrage ou reprise d’enfant.**
La session garde l’ancien code en mémoire ; le contrôle refuse de lui associer un nouvel
SDK sur disque. Les enfants déjà actifs ne sont pas migrés et les archives restent lisibles.
Ce contrôle inclut aussi les assets du répertoire SDK surveillé, pas les fichiers du projet.

`pnpm check:pi` examine l’installation Pi externe, hors des shims `node_modules/.bin` ;
un launcher shell est identifié par une sonde Pi privée sans prompt, dans un HOME temporaire.
Ce diagnostic ne décrit pas une session déjà ouverte et ne remplace pas les tests d’intégration.
La frontière actuelle est Node sur macOS ou Linux, avec une installation npm/pnpm dont le SDK ESM
est accessible ; Bun compilé et Node SEA ne sont pas pris en charge. Après une mise à jour,
rejouer les intégrations : la présence des exports ne garantit pas toute compatibilité future.

L’arrêt coopératif puis forcé des groupes de processus est vérifié et autorisé sur macOS et
Linux. Il lit l’arbre des processus avec `/bin/ps` : sous Linux, celui de procps (absent des
images `slim`, remplacé par BusyBox sur Alpine). Sans `ps` compatible ou sur une autre
plateforme, le lancement d’un enfant est refusé avant tout processus. Le point d’entrée `packages/subagents/index.js` est déclaré dans
`pi.extensions` : les outils `subagent_*` et `/subagents` sont donc disponibles dans une
session parent. En TUI, `/subagents` ouvre la liste et le détail, et
`/subagents settings` édite les réglages utilisateur ; un widget nommé coexiste avec
Graphite sans remplacer son footer. Consulter le [guide dédié](packages/subagents/README.md)
pour les confirmations, la conservation privée des artefacts, les limites et les modes sans UI.

Les tests du moteur utilisent des fournisseurs OpenAI-compatibles locaux et déterministes,
des services web factices et les vraies extensions LSP/navigateur. Les tests de l’orchestration
et du point d’entrée sont également inclus dans `pnpm test` :

```sh
node --test tests/subagents-runtime.test.mjs tests/subagents-worker.test.mjs \
  tests/subagents-capabilities.test.mjs tests/subagents-extensions.test.mjs \
  tests/subagents-ui.test.mjs tests/subagents-e2e.test.mjs \
  tests/subagents-parent-e2e.test.mjs tests/subagents-lifecycle.test.mjs \
  tests/subagents-sdk-host.test.mjs
```

Pour cibler une installation Pi externe plutôt que le SDK de développement, consulter la
[matrice de compatibilité](packages/subagents/README.md#runtime-pi-et-diagnostic).

## Utilisation

Voir la [configuration de web](packages/web/README.md#configuration-et-utilisation).
Pour essayer l’ensemble localement :

```sh
pi -e .
```

### Installation depuis npm

Chaque extension s’installe seule, avec le npm par défaut de Pi, sous le nom
`@clement_chsn/pi-<nom>` où `<nom>` est son dossier dans `packages/` :

```sh
pi install npm:@clement_chsn/pi-subagents
```

`@clement_chsn/pi-shared` est installé automatiquement par les extensions qui en dépendent.

### Installation depuis Git

Pi installe un dépôt Git avec npm par défaut (`npm install --omit=dev`), qui ne connaît
ni le workspace pnpm ni ses protocoles `catalog:` et `workspace:*` : l’installation échoue
sur `EUNSUPPORTEDPROTOCOL`. Déclarer pnpm comme gestionnaire de packages de Pi avant
`pi install git:…` :

```json
{ "npmCommand": ["pnpm"] }
```

Ce réglage de `~/.pi/agent/settings.json` est global : Pi utilise alors pnpm pour tous
ses packages npm et Git. Il lance `pnpm install --prod` dans le clone, ce qui installe les
dépendances de chaque package du workspace. Un dossier local référencé par
`pi install /chemin` n’est jamais installé par Pi : exécuter soi-même `pnpm install`.
