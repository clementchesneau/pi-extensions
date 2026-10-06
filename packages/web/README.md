# web

Quatre outils Pi indépendants du provider IA : recherche Brave, lecture locale des
pages, résolution de bibliothèque Context7 et lecture de documentation attribuée.
Aucun MCP, service auto-hébergé ou accès non public OpenAI.

## Configuration et utilisation

1. Créer une clé pour l’offre Search sur [Brave Search API](https://brave.com/search/api/).
2. Vérifier dans le compte Brave les crédits, quotas et possibilités de blocage des
   dépenses. **L’extension ne garantit pas l’absence de facturation et n’impose pas
   de plafond mensuel.** Ne pas l’utiliser si les limites disponibles ne satisfont
   pas le budget souhaité. Les crédits et tarifs peuvent changer.
3. Renseigner la clé dans **`~/.config/pi-extensions/.env`**, hors du dépôt :

   ```dotenv
   BRAVE_API_KEY=ta_cle
   ```

   Ce fichier doit appartenir à ton utilisateur et être privé (`chmod 600`).
   Il stocke la clé en clair sur disque. L’ouvrir dans un éditeur local, sans mettre
   la clé dans l’historique des commandes, le dépôt, un prompt ou une conversation.
   S’il n’existe pas encore, créer le dossier avec `mkdir -p ~/.config/pi-extensions`,
   puis le fichier avec des permissions privées avant d’y saisir la clé.
4. Pour Context7, créer manuellement une clé depuis le
   [dashboard Context7](https://context7.com/dashboard), puis l’ajouter au même
   fichier privé :

   ```dotenv
   CONTEXT7_API_KEY=ta_cle_context7
   ```

   La page officielle présente actuellement l’offre Free à 0 $ pour les dépôts
   publics, avec un quota bloquant. Le nombre d’appels et les conditions peuvent
   changer : vérifier la [page des plans](https://context7.com/plans) plutôt que de
   considérer un chiffre de ce document comme garanti.

Une variable d’environnement `BRAVE_API_KEY` ou `CONTEXT7_API_KEY` est
**prioritaire pour la clé correspondante**, même si elle est vide. Pour utiliser
les clés du fichier après un essai dans le terminal :

```sh
unset BRAVE_API_KEY CONTEXT7_API_KEY
```

Le fichier est relu à chaque appel Brave ou Context7 : modifier une clé ne demande
pas de redémarrer Pi. Après une mise à jour du code de l’extension, utiliser `/reload`
ou redémarrer Pi.
Seul ce fichier global est lu, jamais le `.env` du projet. Les commentaires,
guillemets et le préfixe `export` suivent le parseur dotenv de Node.js ; aucune
commande ni interpolation de variable n’est exécutée. Les autres variables ne sont
pas injectées dans l’environnement. Les liens symboliques et fichiers dépassant
16 KiB sont refusés. Les contrôles de permissions sont vérifiés sur macOS ; leur
compatibilité Windows n’est pas revendiquée.

`web_fetch` ne nécessite aucune clé et ne lit pas cette configuration. Les outils
Context7 ne sont destinés qu’à la documentation publique : ne jamais placer de
secret, code propriétaire, donnée personnelle ou autre information confidentielle
dans `libraryName` ou `query`.

Depuis la racine du dépôt, après `pnpm install --frozen-lockfile`, essai explicite
sans enregistrer l’extension dans les paramètres Pi :

```sh
pi -e ./packages/web/index.js
```

L’option `-e` n’isole pas les autres extensions déjà configurées dans Pi.

Installation locale persistante, seulement si souhaitée :

```sh
pi install /chemin/absolu/vers/pi-extensions
```

Pi référence alors ce dossier sans le copier. Les modifications seront prises en
compte au prochain chargement ou `/reload`. Ne pas charger simultanément cette
installation et le même point d’entrée via `-e`.

## Outils

### `web_search`

```json
{"query":"Node.js streams documentation","count":5,"language":"en","freshness":"py"}
```

- `query` : 1–400 caractères, au plus 50 mots.
- `count` : 1–20 résultats, 5 par défaut.
- `language` : code Brave facultatif, par exemple `en` ou `fr`.
- `freshness` : facultatif, `pd` / `pw` / `pm` / `py` (jour / semaine / mois / an).
  Brave décrit ce filtre comme une fenêtre de découverte, pas une preuve de la date
  de publication.

Retourne le titre, l’URL, l’extrait et l’âge si Brave le fournit. Aucun résultat est
un résultat valide, distinct d’une erreur API. Les extraits ne prouvent pas que
l’agent a lu les pages : utiliser `web_fetch` pour les sources pertinentes.

Chaque appel valide émet au plus une requête Brave. Aucun retry automatique,
préchargement, pagination ou téléchargement des résultats. Les erreurs 401/403 et
429 sont explicites ; les corps d’erreur distants et erreurs réseau brutes ne sont
pas exposés pour éviter de divulguer des secrets. La clé n’est envoyée qu’à
`api.search.brave.com` et les redirections de recherche sont refusées.
Les requêtes de recherche sont transmises à Brave : ne pas y inclure de secrets.

### `context7_resolve` puis `context7_docs`

Context7 s’utilise en deux appels explicites :

```json
{"libraryName":"react","query":"useEffect cleanup API for React 19"}
```

`context7_resolve` retourne les identifiants candidats, descriptions, nombres
d’extraits, scores de confiance et de benchmark, ainsi que les versions indexées
lorsqu’elles existent. Comparer ces versions avec la dépendance réellement
installée ; ne pas sélectionner silencieusement la version la plus proche.
Réutiliser un identifiant déjà résolu dans la conversation évite un nouvel appel.

```json
{"libraryId":"/facebook/react/v19.1.0","query":"How does useEffect cleanup work?"}
```

`context7_docs` exige l’identifiant choisi et retourne des extraits avec titre,
contenu et source. Il ne résout pas automatiquement la bibliothèque. Chaque outil
valide émet au plus une requête, avec un délai de 20 secondes, propagation de
l’annulation et **aucun retry** ; une résolution suivie d’une lecture coûte donc
deux appels du quota Context7. Il n’existe ni cache ni préchargement et aucun client
n’est créé au chargement de l’extension.

Les erreurs distinguent clé absente, authentification refusée, quota atteint,
délai, transport et réponse inattendue sans restituer le corps distant ou la clé.
Les résultats Context7 restent des extraits externes non fiables, même avec un bon
score : citer leurs sources et utiliser `web_fetch`, les types/sources locaux ou un
changelog officiel lorsqu’une version manque, qu’une source primaire exacte est
nécessaire ou que l’affirmation est conséquente. Les requêtes doivent rester des
questions techniques minimales, jamais des fragments du projet.

### `web_fetch`

```json
{"url":"https://nodejs.org/en/learn"}
```

Retourne l’URL finale, le titre, le mode d’extraction et le contenu en Markdown.
Readability extrait le contenu principal ; à défaut, le contenu de `main` ou du
corps sert de repli, signalé par `body-fallback`. Les liens HTML relatifs sont
résolus contre l’URL finale et les balises `base` ignorées. Les scripts, cadres,
formulaires, éléments de navigation et images sont retirés ; le texte alternatif
des images est conservé. Aucun script ni sous-ressource n’est exécuté ou téléchargé.

Limites intentionnelles :

- HTML, texte brut, Markdown et JSON (`application/json` et `application/*+json`) ;
  pas de PDF, OCR ou navigateur. Le JSON est conservé en texte sans parsing ni
  reformatage, pour préserver notamment les grands identifiants numériques.
- Pas d’authentification, cookies ou contournement de blocage. Une page demandant
  JavaScript peut être vide **ou ne fournir qu’un contenu partiel**.
- Extraction imparfaite possible, notamment pour les tableaux, menus de référence
  et mises en page atypiques. Ce n’est pas une capture fidèle de la page.
- HTTP(S) public uniquement, ports standards ; pas de localhost, réseau privé,
  adresses réservées ou redirection HTTPS vers HTTP.
- Toutes les adresses DNS sont vérifiées et l’adresse retenue est fixée pour la
  connexion, afin d’éviter une seconde résolution non contrôlée. Chaque
  redirection repasse par les mêmes contrôles.
- 4 redirections, 4 MiB téléchargés et 20 secondes au maximum pour le réseau,
  résolution DNS comprise. Recherche Brave : réponse limitée à 2 MiB.
- Les réponses compressées malgré `Accept-Encoding: identity` sont refusées.
  Pas de proxy HTTP d’environnement ni de fallback automatique vers un navigateur.
- Les erreurs HTTP indiquent le statut distant sans présumer un blocage ou une
  authentification. Une erreur 415 signale un format non accepté, potentiellement
  lié aux en-têtes de requête. Les corps d’erreur distants ne sont pas exposés.

## Sorties et confiance

Les quatre outils bornent le contenu à 24 000 octets ou 600 lignes, plus un court
avis de troncature. Le contenu complet tronqué est conservé sous le dossier
temporaire système `pi-web-*/source.txt`, dans un fichier privé (mode `0600`).
L’agent peut le relire avec son outil de lecture sans nouveau téléchargement.
Les gros contenus ne sont pas dupliqués dans les métadonnées des résultats.

Ces fichiers ne sont pas supprimés à la fermeture de la session, pour permettre
une reprise. Ils sont temporaires, peuvent disparaître avec le nettoyage système
et peuvent contenir des données sensibles ; les supprimer manuellement lorsqu’ils
ne servent plus. Il n’existe pas de cache persistant des recherches.

Les pages et extraits restent des données non fiables. Leurs instructions ne doivent
pas remplacer celles de l’utilisateur. Le filtrage HTML et cet avertissement ne
constituent pas une garantie contre les injections de prompt, ni une sandbox Pi.

## Vérifications

```sh
pnpm test
pnpm audit --prod
```

Les API Brave et Context7 sont testées avec des doubles de frontière : paramètres,
authentification, annulation, résultats et erreurs. Aucun test conversationnel
multi-provider n’est revendiqué. Les tests ne lisent aucune clé réelle et ne
consomment aucun quota Context7.

Références de contrat : [API officielle](https://brave.com/search/api/),
[paramètres du serveur MCP officiel Brave](https://github.com/brave/brave-search-mcp-server/blob/main/src/tools/web/params.ts)
et [format des résultats](https://github.com/brave/brave-search-mcp-server/blob/main/src/tools/web/index.ts).
Ce package appelle directement l’API HTTP ; il n’utilise pas ce serveur MCP.
Pour Context7, il utilise `@upstash/context7-sdk` 0.4.1 épinglé ; contrats officiels :
[initialisation et transport](https://context7.com/docs/sdks/ts/getting-started),
[recherche](https://context7.com/docs/sdks/ts/commands/search-library) et
[documentation](https://context7.com/docs/sdks/ts/commands/get-context).
