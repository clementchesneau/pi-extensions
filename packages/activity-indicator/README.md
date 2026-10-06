# Activity indicator

Une seule ligne TUI pour le chronomètre Graphite et les travaux actifs, alimentée par plusieurs extensions, quel que soit leur ordre de chargement. Elle n'enregistre ni outil ni commande, et ne remplace pas les vues `/subagents` et `/ps`. Sur terminal large, la durée est alignée à gauche et les compteurs à droite ; si l'espace manque, les compteurs priment et la durée est masquée plutôt que d'ajouter une ligne.

Contrat entre extensions via `pi.events`, version 1 (constantes et client producteur dans `@clement_chsn/pi-shared/activity-indicator`) :

- À chaque `session_start` TUI, l'indicateur vide son état puis émet `activity-indicator:ready` avec `{ protocol: 1 }`. Ce message signifie « envoyez tout votre état » : chaque producteur republie alors ses valeurs courantes. Un producteur ignore un `ready` d'une autre version et garde son widget autonome.
- `activity-indicator:update` prend `{ source: string, label: string, count: number }`. Chaque message **remplace** le compteur de cette source ; `count: 0` retire sa contribution. `label` est le nom affiché avec le nombre (le producteur gère le singulier/pluriel). Le message ne contient ni logs ni commande.
- `activity-indicator:timer` prend `{ text: string, active: boolean }`. Graphite publie sa durée affichable et son état (accent pendant l’exécution, gris au repos), ou `text: ''` lorsqu'il est désactivé ; la barre ne calcule pas elle-même les durées. Le widget disparaît quand il n'y a ni durée ni compteur.
- L'indicateur vide son widget et ses compteurs à `session_shutdown`. Les producteurs doivent cesser de publier après la fermeture de leur session et envoyer `count: 0` lorsqu'ils se désactivent.

Un producteur chargé avant l'indicateur commence sur son widget autonome, puis le retire et publie dans la barre dès le premier `ready`. Charger l'indicateur en premier (comme le manifeste racine) évite ce passage. Sans indicateur, les widgets autonomes de `graphite-ui`, `subagents` et `background-tasks` continuent à fonctionner.

Pour intégrer une autre extension : `connectActivityIndicator(pi)` à l'initialisation, puis à chaque rendu publier via `update`/`timer` si `available`, sinon afficher son propre widget, et republier tout l'état dans `onReady`.
