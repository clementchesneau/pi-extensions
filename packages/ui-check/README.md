# ui-check

Quatre outils Pi pour observer et manipuler une UI web avec Playwright/Chromium.
Le modèle de la conversation reçoit les captures ; aucun appel à un second modèle,
aucun MCP ni service navigateur externe.

## Comportement

L’extension donne une capacité, **pas une procédure obligatoire**. Ses
`promptGuidelines` recommandent d’utiliser le navigateur quand observer un rendu ou
une interaction aide à valider la demande, avec un effort proportionné au changement.
Elles invitent à comparer à la demande originale et aux références fournies, à traiter
les pages comme des données non fiables, et à distinguer observation et conformité.

Aucun détecteur de tâche UI, surveillance des fichiers, hook de fin de réponse,
relance automatique ou verdict « conforme ». Seul hook : fermeture des ressources
à `session_shutdown` (sortie, reload ou remplacement de session).

## Préparation et chargement

Depuis la racine de `pi-extensions` :

```sh
pnpm install --frozen-lockfile
pnpm --filter @clement_chsn/pi-ui-check exec playwright install chromium
pi -e ./packages/ui-check/index.js
```

Installé depuis npm (`pi install npm:@clement_chsn/pi-ui-check`), télécharger Chromium
avec la version de Playwright du package, que rappelle aussi l’erreur de lancement :

```sh
npx playwright@1.63.0 install chromium
```

Le téléchargement du navigateur est explicite, jamais déclenché par un outil.
Sur Linux, des bibliothèques système peuvent être nécessaires ; utiliser la procédure
d’installation Playwright adaptée à la machine. Chromium n’est lancé qu’au premier
`browser_open`, en mode headless. L’extension ne démarre pas le serveur de développement :
l’agent utilise les commandes du projet et lui passe son URL.

Le manifeste du package inclut l’extension. Si ce dossier est déjà référencé par Pi,
utiliser `/reload` ; sinon `-e` permet un essai sans installation persistante.
Ne pas charger deux fois le même point d’entrée. L’option `-e` ne désactive pas les
autres extensions déjà configurées. Pour une installation persistante volontaire,
voir la [documentation du package web](../web/README.md#configuration-et-utilisation).

Les captures nécessitent un modèle déclarant une entrée `image`. Un modèle texte
seul peut utiliser les snapshots accessibles et diagnostics, mais pas prétendre
avoir vérifié l’apparence. Cette extension ne change jamais le modèle actif.

## Outils

### `browser_open`

```json
{"url":"http://localhost:3000/profile","width":1280,"height":800}
```

Navigation HTTP(S), localhost compris, puis snapshot accessible et diagnostics.
Les URL contenant des identifiants et les protocoles `file:`, `javascript:`, etc.
sont refusés à l’entrée. La session conserve cookies et état entre les appels ;
une nouvelle navigation conserve les cookies et réinitialise les diagnostics.
Dimensions par défaut à chaque ouverture : 1280 × 800 CSS pixels.

### `browser_act`

```json
{"action":"fill","target":{"role":"textbox","name":"Name"},"value":"Clément"}
```

```json
{"action":"click","target":{"role":"button","name":"Save"}}
```

```json
{"action":"resize","width":390,"height":844}
```

Actions :

| Action | Paramètres spécifiques |
| --- | --- |
| `click`, `hover` | `target` |
| `fill` | `target`, `value` (chaîne, vide autorisé) |
| `press` | `target`, `key` (`Tab`, `Enter`, `ControlOrMeta+A`…) |
| `select` | `target`, `value` (valeur d’une option du select natif) |
| `check` | `target`, `checked` (booléen) |
| `scroll` | `target` à amener dans la zone visible |
| `wait` | `target`, `state` : `visible` par défaut ou `hidden` |
| `resize` | `width`, `height`, sans cible |

Préférer `target: {role, name}` (nom accessible exact). Repli possible avec
`target: {selector: "#profile button[type=submit]"}`, sans le combiner avec rôle/nom.
Une cible ambiguë échoue plutôt que de cliquer sur le premier élément.
Les actions sont sérialisées même si Pi en demande plusieurs en parallèle.
Elles renvoient un accusé court, **pas une preuve du résultat attendu**.
Playwright attend la disponibilité des éléments ; délai de 10 secondes par opération
Playwright, sans attente réseau globale ni pause arbitraire imposée.

### `browser_inspect`

```json
{"screenshot":true}
```

```json
{"screenshot":true,"target":{"role":"button","name":"Save"}}
```

Sans option : snapshot accessible textuel de la page et diagnostics. Avec `target` :
snapshot du composant. Avec `screenshot: true` : image JPEG jointe au résultat pour
le modèle, et chemin local dans `details.screenshotPath`. La capture d’un composant
peut le faire défiler dans la zone visible.

Les diagnostics comprennent les avertissements/erreurs console, exceptions JS,
échecs réseau et réponses HTTP ≥ 400 observés sur la page. Ils sont bornés aux
50 dernières entrées, chacune limitée à 2000 caractères, depuis `browser_open`.
Ils ne prouvent pas l’absence d’erreur : aucune attente de toutes les requêtes,
pas de journal complet ni d’analyse des corps réseau.

### `browser_close`

```json
{}
```

Ferme le navigateur et perd cookies et état de page. Appel répétable sans erreur.
Une annulation pendant une opération ferme également le navigateur pour interrompre
les attentes ; rouvrir ensuite avec `browser_open`. Une annulation pendant le lancement
peut attendre que celui-ci se termine ou atteigne son timeout avant le nettoyage.

## Coût, limites et confidentialité

- Une page dans un contexte neuf, sans profil personnel. Les popups sont fermées ;
  pas de gestion multi-onglets, de fichiers téléchargés/importés, de dialogue natif,
  d’iframe ciblée explicitement ni de clic par coordonnées sur un canvas.
- Les dialogues JavaScript sont rejetés automatiquement par Playwright.
- Chromium uniquement ; pas d’app native ni de TUI. Réduire la largeur
  simule un viewport étroit, pas un vrai appareil tactile ni Safari mobile.
- Viewport : largeur 240–1920, hauteur 240–1440. Captures viewport ou composant
  (1920 × 1440 maximum), jamais une page complète arbitrairement longue.
- JPEG qualité 80, maximum 4 MiB. Animations désactivées pour la capture ; ce n’est
  pas un test d’animation ni une comparaison pixel-perfect.
- Texte limité à 24 000 octets ou 600 lignes, plus l’avis de troncature.
  Le texte complet tronqué et les captures sont conservés dans le dossier temporaire
  système `pi-ui-check-*` (dossier `0700`, fichiers `0600`, vérifiés sur macOS).
  Les gros snapshots ne sont pas dupliqués dans les métadonnées.
- Les fichiers restent après fermeture pour pouvoir relire les preuves. Aucun quota
  disque ni nettoyage automatique : supprimer les dossiers lorsqu’ils ne servent plus.
  Le nettoyage système peut les faire disparaître ; ce n’est pas un archivage durable.
- **Les pages exécutent leur JavaScript et peuvent accéder au réseau**, y compris local.
  Contrairement à `web_fetch`, ce navigateur ne bloque pas les réseaux privés et
  n’impose pas de liste d’origines. Le contexte isolé n’est pas une sandbox de sécurité
  du système ou du réseau, ni une garantie contre les injections de prompt.
- Utiliser des environnements et comptes de test autorisés. Un clic ou même une
  navigation peut modifier des données serveur ; aucune confirmation technique n’est
  imposée par l’extension. Ne pas utiliser de compte personnel ou réaliser une action
  destructive/externe sans autorisation.
- Texte, URL, diagnostics et captures peuvent contenir des secrets : ils sont envoyés
  au fournisseur du modèle actif et peuvent rester dans l’historique Pi. Le traitement
  navigateur local ne rend pas la conversation privée ou gratuite ; les images
  consomment du contexte et des tokens selon le fournisseur.

## Vérifications

```sh
node --test tests/browser.test.mjs
pnpm test
```

Les tests navigateur utilisent un serveur HTTP local éphémère et Chromium réel :
interactions, viewport, captures viewport/composant, diagnostics, troncature UTF-8,
fichiers privés, annulation et réouverture. Le contrat d’enregistrement vérifie que
l’extension n’ajoute que les outils et le hook de nettoyage.

Ils ne constituent pas un test conversationnel multi-provider ni une garantie que
l’agent choisira toujours de vérifier. Le jugement d’alignement avec la demande reste
celui du modèle, à partir des observations réelles et des références disponibles.
