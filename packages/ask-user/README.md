# Ask user

L’outil `ask_user` permet à l’agent de poser une ou plusieurs questions dans le
terminal Pi, avec des propositions et une option **Other answer** (réponse libre) toujours disponible.
L’interface est en anglais, comme celle des autres extensions.
Il ne fait aucun appel modèle supplémentaire et n’utilise aucun service externe.

Le questionnaire apparaît **sous le fil de discussion**, à la place de la zone de
saisie, sans superposition ni écran plein. Sa hauteur s’adapte au contenu, avec une
limite de 16 lignes et d’environ la moitié du terminal (minimum 8 lignes si la taille
le permet). Les contenus longs défilent dans ce panneau ; la zone de saisie normale
revient après validation ou annulation.

## Interaction

Les questions sont affichées une par une. Chaque question accepte soit une réponse
unique, soit plusieurs propositions (`multiple: true`). En choix multiple, le texte
libre peut compléter les propositions cochées ou constituer toute la réponse.
En choix unique, une réponse libre remplace la proposition sélectionnée.

- **↑/↓** : déplacer la sélection.
- **1–9** : choisir/cocher directement une proposition (y compris **Other answer** si son numéro est ≤ 9).
  Les propositions suivantes restent accessibles par les flèches.
- **Entrée** : choisir en mode unique ; continuer en mode multiple.
  Sur **Other answer**, Entrée active la saisie directement dans la ligne de cette
  proposition, sans remplacer la liste. La question et les autres choix restent
  dans le panneau (avec défilement si nécessaire). Dans un terminal très étroit,
  le champ passe sous son libellé.
- **Espace** : cocher/décocher en mode multiple ; activer la ligne courante.
- **← / Shift+Tab** : revenir à la question précédente sans perdre les réponses enregistrées.
- **→ / Tab** : avancer si la question a une réponse.
- **Option/Alt + ↑/↓** : défiler le questionnaire dans les deux modes Pi, même
  pendant la saisie libre, pour relire la question ou parcourir le récapitulatif.
- **PgUp/PgDn** : défiler le questionnaire en mode terminal normal. En mode
  plein écran Pi, ces touches restent réservées au fil de discussion ; utiliser
  **Option/Alt + ↑/↓** pour le panneau. Sur Mac, PgUp/PgDn correspondent à **Fn + ↑/↓**.
- En saisie : **Entrée** enregistre, **Shift+Entrée** ajoute une ligne.
  Un texte vide retire un complément précédent et ne compte pas comme une réponse.
- **Échap**, y compris pendant la saisie : annuler tout le questionnaire.

Après la dernière question, un récapitulatif (**Summary**) permet de relire les réponses,
revenir les modifier, puis **Entrée** transmet toutes les réponses à l’agent.
Même une question seule passe par cette confirmation finale.

Aucune réponse partielle n’est transmise à l’annulation ou à l’interruption de l’outil.
L’agent reçoit `cancelled`, sans réponses ; cela ne constitue ni un refus, ni un accord.
Les réponses envoyées restent dans l’historique normal de la conversation Pi, sans
fichier de stockage supplémentaire. Une fermeture ne sauvegarde pas les brouillons.

## Contrat de l’outil

```json
{
  "questions": [
    {
      "id": "scope",
      "prompt": "Quel périmètre souhaites-tu ?",
      "options": [
        { "value": "minimal", "label": "Version minimale", "description": "Livraison rapide" },
        { "value": "complete", "label": "Version complète", "description": "Plus de fonctionnalités" }
      ]
    },
    {
      "id": "features",
      "prompt": "Quelles fonctionnalités inclure ?",
      "multiple": true,
      "options": [
        { "value": "search", "label": "Recherche" },
        { "value": "export", "label": "Export" }
      ]
    }
  ]
}
```

Les identifiants de questions doivent être uniques, les valeurs des propositions
uniques dans chaque question. Questions et propositions ne peuvent pas être vides.
`multiple` vaut `false` si omis. Chaque question doit avoir au moins une réponse
(proposition ou texte libre) avant de passer à la suivante.

La sortie contient `status` (`answered`, `cancelled` ou `unavailable`) et `answers`.
Chaque réponse transmise contient `id`, `prompt`, `selected` (valeurs et libellés)
et `custom` (texte libre ou `null`). L’ordre suit celui des questions/propositions.

L’outil est exposé directement au modèle (`model-only`), pas aux scripts codemode,
et son exécution est séquentielle pour éviter plusieurs questionnaires simultanés.
En RPC, JSON, print ou dans un sous-agent sans TUI, il renvoie immédiatement
`unavailable` et un résultat d’erreur, sans dialogue ni réponse inventée.

## Essayer

Depuis la racine du dépôt :

```sh
pi -e .
```

Demander par exemple : « Utilise ask_user pour me demander un périmètre à choix
unique puis plusieurs fonctionnalités, avec une description pour chaque proposition. »
Vérifier le choix numérique, les cases à cocher, le complément libre, le retour arrière,
le récapitulatif et l’annulation pendant la saisie. Réessayer dans un terminal étroit
et avec de longues descriptions pour vérifier le défilement. Pendant la saisie,
saisir un emoji ou du texte CJK, redimensionner à 24/25 colonnes, puis vérifier
**Option/Alt + ↑/↓** pour relire une longue question sans perdre le texte. Tester aussi
un récapitulatif long en mode plein écran Pi : le panneau doit défiler avec ces
raccourcis sans déplacer le fil de discussion.

Tests automatisés :

```sh
node --test tests/ask-user.test.mjs
```

Pour prendre en compte une modification, recharger une session qui charge déjà ce
package avec `/reload`, ou démarrer une nouvelle session avec `pi -e .`.
