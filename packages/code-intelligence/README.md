# code-intelligence

Navigation sémantique TypeScript/JavaScript légère pour Pi. L’extension enregistre un
seul tool, `code_nav`, avec cinq actions : `symbols`, `definition`, `references`,
`hover` et `diagnostics`.

## Dépendances

Le package Pi embarque `typescript-language-server` et `typescript` : aucun ajout n’est
nécessaire dans les projets qui utilisent `code_nav`. Pour respecter leur configuration,
la résolution préfère néanmoins un `node_modules/.bin/typescript-language-server` local,
depuis la racine détectée jusqu’au répertoire courant de Pi. Elle utilise ensuite le
serveur versionné du package, puis `PATH` uniquement comme dernier recours si
l’installation du package est incomplète.

Le serveur privilégie à son tour la version de TypeScript du workspace lorsqu’elle est
présente, puis utilise la version embarquée. Un projet peut donc verrouiller explicitement
ses propres versions sans que les autres projets aient à installer ces dépendances.

## Fonctionnement

Les fichiers `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` et `.cjs` sont pris
en charge. La racine la plus proche contenant, dans cet ordre, `tsconfig.json`,
`jsconfig.json` ou `package.json` est utilisée, sans remonter au-dessus du répertoire
courant de Pi. Aucune configuration propre à l’extension n’est nécessaire.

Le serveur ne démarre pas au chargement. Le premier appel le lance pour la racine
concernée ; les appels suivants réutilisent ce processus. Il s’arrête après cinq minutes
d’inactivité, au shutdown ou au reload de la session, après un crash irrécupérable, ou
lorsque le gestionnaire est fermé. Une requête active empêche l’expiration et Esc annule
la requête LSP en cours.

`code_nav` relit le fichier sur disque avant chaque opération, puis resynchronise aussi
les documents déjà ouverts dont le contenu a changé avant d’interroger le serveur. Pour
`diagnostics`, il ajoute brièvement au buffer LSP une sentinelle grammaticale qui ne
bloque pas les autres contrôles TypeScript. Elle est placée après un éventuel shebang, les
directives `@ts-check`, `@ts-nocheck` ou triple-slash et le véritable prologue de
directives JavaScript (`"use strict"`, etc.), identifié depuis l’arbre syntaxique
TypeScript afin de ne pas confondre une expression continuée avec une directive, mais
avant les JSDoc liés au code. Quand un prologue
se termine au milieu d’une ligne, la séparation est créée exactement à cette frontière :
la sentinelle ne peut donc pas être absorbée par le commentaire ou la chaîne qui suit, et
les lignes comme les colonnes sont reconverties vers le fichier original. Si la configuration
supprime les diagnostics grammaticaux, une sentinelle syntaxique de repli est utilisée.
Les fichiers de déclaration `.d.ts`, `.d.mts` et `.d.cts` emploient à la place une
signature de déclarations ambiantes à modificateur dupliqué : elle reste indépendante des
erreurs TS1036/TS1039 du fichier et ne les masque pas.
Chaque appel encode une génération monotone dans une signature de plusieurs positions
de sentinelle. Une notification versionnée doit correspondre exactement à la version du
buffer ; une notification sans version doit contenir toute la signature propre à l’appel.
Une publication retardée d’un appel précédent ne peut donc pas valider le suivant. Les
autres publications sont rejetées comme périmées. Seules les erreurs de la signature sont
retirées et les positions des vrais
diagnostics sont rétablies, y compris pour les erreurs de fin de fichier. Le contenu
disque est restauré même après timeout ou annulation et le fichier n’est jamais modifié
sur disque. Les publications progressives
prouvées sont agrégées et leur dernière vue est rendue. Comme
`publishDiagnostics` ne fournit aucune preuve de fin d’analyse, le résultat et ses
détails indiquent explicitement qu’il peut rester incomplet. Les numéros `line` et
`column` du tool commencent à **1** ; le tool effectue la conversion
vers les positions LSP qui commencent à 0. Les opérations d’un même serveur sont
sérialisées pour conserver un instantané cohérent entre synchronisation et requête.

## Exemples

Symboles du document :

```json
{ "action": "symbols", "path": "src/index.ts", "limit": 50 }
```

Symboles du workspace (la présence de `query` change le routage) :

```json
{ "action": "symbols", "path": "src/index.ts", "query": "createClient" }
```

Définition, références ou information de type :

```json
{ "action": "definition", "path": "src/index.ts", "line": 18, "column": 12 }
{ "action": "references", "path": "src/index.ts", "line": 18, "column": 12, "limit": 100 }
{ "action": "hover", "path": "src/index.ts", "line": 18, "column": 12 }
```

Diagnostics frais après synchronisation :

```json
{ "action": "diagnostics", "path": "src/index.ts", "limit": 50 }
```

## Limites et dépannage

- `limit` vaut 50 par défaut et ne peut pas dépasser 200. Toute sortie est aussi bornée
  à 2 000 lignes et 50 KB. Si elle est tronquée, sa version complète est enregistrée
  dans un fichier temporaire privé dont le chemin est indiqué dans le résultat.
- « `typescript-language-server was not found` » : réinstallez ou mettez à jour le
  package Pi. Vous pouvez aussi installer `typescript` et `typescript-language-server`
  dans le projet pour imposer ses propres versions.
- « not supported » : le serveur détecté n’annonce pas la capacité demandée.
- « timed out » : la réponse ou les diagnostics n’ont pas été reçus dans le délai borné ;
  vérifiez les logs et la santé du serveur.
- « exited unexpectedly » ou « connection closed » : le serveur a crashé. Son stderr
  récent est inclus de manière bornée dans l’erreur et le prochain appel repart avec un
  nouveau processus.
- Les buffers non enregistrés ne sont pas observés : le tool travaille volontairement
  sur la dernière version présente sur disque, sans watcher ni index persistant.
