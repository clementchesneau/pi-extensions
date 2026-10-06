# Graphite UI

Interface sombre pour Pi : thème Graphite, bannière PI en caractères bloc, chronomètres d’exécution, footer adaptatif et indicateur de travail braille animé sur quatre rangées de points, avec une cadence ralentie (110 ms par image). Un arc de quatre points parcourt les huit positions du caractère pour équilibrer l’animation sur toute sa hauteur.

L’en-tête affiche un logo Pi blanc centré en caractères bloc, avec une silhouette géométrique et le chemin du répertoire courant dessous (`~` pour le dossier personnel), sans raccourcis ni cadre. Il devient compact lorsque le logo ne tient pas dans la largeur du terminal. Conserver `"quietStartup": false` dans `~/.pi/agent/settings.json` pour afficher les sections natives Context, Skills et Extensions. Pi peut alors afficher brièvement son en-tête avant Graphite : c’est une limite de son ordre d’initialisation actuel. `quietStartup: true` supprime le flash, mais masque aussi ces sections. Graphite ne modifie pas ce réglage automatiquement.

Dans le package complet, une barre partagée juste au-dessus de l’éditeur aligne la durée à gauche et les compteurs de tâches et sous-agents à droite. Sur terminal étroit, les compteurs priment si les deux ne tiennent pas sur la même ligne. Sans `activity-indicator`, Graphite conserve son widget de durée autonome. Cette ligne affiche le temps de l’exécution en cours. Le cumul de la branche active n’apparaît qu’au début de la deuxième exécution ; avant cela, il répéterait la durée de la première. Une fois l’exécution terminée, le temps individuel quitte cette ligne : le cumul reste affiché à partir de deux exécutions, et la durée individuelle est consultable dans le fil. La ligne est absente au repos avant la deuxième exécution si aucun compactage n’est à afficher.

```text
En cours :  ⏱ 1m 42s · 18m 07s · 2 comp
Au repos :  Total 18m 07s · 2 comp
Dans le fil :  ⏱ 1m 42s · run duration · 14:08:08
```

Une exécution commence avec un prompt effectivement envoyé et se termine lorsque l’agent est complètement arrêté. Les retries, continuations et compactages automatiques ne coupent donc pas le chronomètre. À la fin de chaque exécution, sa durée et l’heure locale de fin (`HH:mm:ss`) apparaissent dans le fil de conversation (`⏱ 1m 42s · run duration · 14:08:08`) : on peut la retrouver en remontant le fil ou après une reprise de session. La durée et l’instant de fin sont conservés dans la session sans entrer dans le contexte du modèle. Les anciennes entrées sans instant de fin continuent d’afficher uniquement la durée ; le cumul survit aux compactages, rechargements, reprises et forks, et suit la branche sélectionnée avec `/tree`. Le compteur `comp` n’apparaît qu’à partir du premier compactage réussi. Il inclut les compactages manuels et automatiques aboutis de toute la session, y compris ceux des branches quittées ; les tentatives échouées ne sont pas comptées.

Le footer réserve deux lignes à l’environnement et à la consommation. Le modèle et le thinking sont alignés à droite sur la première ligne ; le chemin reste à gauche tant qu’il reste de la place, puis est tronqué pour préserver le modèle et le thinking. Sur un terminal large, le provider accompagne le modèle. La seconde ligne aligne la branche et le nombre de fichiers modifiés à droite, sous le modèle. Le pourcentage et la capacité (`3%/272k`), le coût et les tokens restent à gauche. Sur terminal étroit, le contexte et le coût priment : les fichiers modifiés et les tokens disparaissent si nécessaire, puis la branche est tronquée ou masquée. Le nombre de tokens « utilisés » n’est pas répété : il ferait doublon avec le pourcentage et les compteurs. Les statuts publiés par les autres extensions restent affichés en dessous, y compris lorsqu’ils sont multilignes ou colorés.

Exemple sans couleurs, sur 80 colonnes :

```text
~/work/graphite                                         claude-sonnet-4-6 · high
42%/200k · $0.128 · ↑12.3k ↓2.3k                    feature/graphite · 7 changed
```

Lorsque `session-compaction` est chargée, seul le pourcentage de contexte déjà présent change de couleur : gris avant le seuil volontaire de 60 %, bleu lorsque la compaction est possible ou en cours, jaune au dépassement du seuil automatique natif effectif. Aucun ajout de ligne, jauge, seuil chiffré ou libellé ; la capacité, le coût et les autres informations conservent leur couleur. Un contexte inconnu (`?%`) ou l’absence de l’extension garde la couleur neutre. La compaction automatique désactivée ne provoque pas la couleur d’alerte du seuil final.

Les totaux de tokens et le coût sont calculés à partir des messages assistant de la branche active. Ils n’incluent pas le cache dans les flèches et ne constituent ni une facture ni nécessairement le total affiché par `/session`.

L’état Git est lu localement, sans shell, réseau ni polling. Graphite rafraîchit le snapshot au démarrage et après les saisies, outils, commandes shell utilisateur, fins d’agent ou changements de branche observés. Un changement réalisé depuis un autre terminal pendant une session inactive peut donc rester invisible jusqu’au prochain déclencheur ; `/graphite-ui refresh` force une lecture bornée. Hors dépôt, le bloc Git disparaît ; une erreur explicite affiche `git ?` plutôt qu’un faux dépôt propre.

Le thème est appliqué automatiquement en mode TUI uniquement. La commande `/graphite-ui` active ou désactive les composants personnalisés pour la session courante (`/graphite-ui on` et `/graphite-ui off` sont aussi acceptés). La désactivation restaure le header, le footer et l’indicateur natifs, retire sa durée de la barre partagée (sans retirer les autres compteurs), annule les lectures Git en cours et ne change pas le thème Graphite déjà sélectionné. Un footer installé par une autre extension peut remplacer celui de Graphite : Pi ne compose pas plusieurs footers personnalisés arbitraires.

Graphite utilise des couleurs RGB 24 bits. Le rendu est optimal dans un terminal truecolor. L’extension cible les API publiques de Pi et pi-tui.
