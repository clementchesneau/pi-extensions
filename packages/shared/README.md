# Pi shared

Code commun des extensions `@clement_chsn/pi-*`, installé automatiquement comme
dépendance de celles qui l’utilisent. Ce n’est pas une extension Pi : il n’enregistre ni
outil, ni commande, ni widget.

Les modules sont importés par sous-chemin, par exemple
`@clement_chsn/pi-shared/process-tree` :

- `activity-indicator` : protocole `pi.events` entre la barre d’activité et ses producteurs ;
- `full-page` : vue plein écran par-dessus le fil, sans images du fil en transparence ;
- `process-tree` : lecture de `ps` et cibles de nettoyage d’un arbre de processus ;
- `task-list` : liste de tâches groupée par section, sélection par identifiant ;
- `terminal-text` : texte non fiable rendu sûr pour une ligne de terminal ;
- `tool-result` : résultat d’outil dont le texte pour le modèle et les détails portent la même valeur JSON.

Aucune garantie de stabilité en dehors de ces extensions : chacune dépend d’une version
exacte de ce package.
