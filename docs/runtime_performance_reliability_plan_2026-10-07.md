# Plan d’optimisation et de fiabilisation runtime — 7 octobre 2026

Ce document est la feuille de route canonique pour réduire la mémoire, le CPU et les blocages de la boucle Node sans
changer la sémantique métier de player-intelligence. Les changements sont livrés par petits lots versionnés, testés,
committés et poussés séparément. MySQL est volontairement exclu : le journal persistant observé ne pèse que 19,09 MiB,
alors que le processus Node retenait environ 1,08 GiB dans le heap JavaScript. Déplacer ces fichiers vers le MySQL déjà
résident ne corrigerait donc pas la cause mesurée et ajouterait une dépendance runtime.

## Diagnostic de production observé

| Mesure | Valeur observée | Lecture |
| --- | ---: | --- |
| RSS Node | 1 461 006 336 octets | La consommation appartient bien au processus du bot. |
| Heap utilisé | 1 076 858 616 octets | La majorité est constituée d’objets JavaScript encore retenus. |
| Heap réservé | 1 131 847 680 octets | V8 a agrandi son heap en réponse à cette rétention. |
| Mémoire externe | 44 667 795 octets | Les buffers natifs ne sont pas la cause principale. |
| Données player-intelligence | 19,09 MiB | Le volume disque ne justifie ni 1 GiB de heap ni une migration SQL. |

La pile capturée pendant un import SteamID passait par
`identityCandidates -> consolidateIdentity -> consolidateProjection -> projectionCandidates -> displayName`. Le chemin
global reconstruisait les candidats de toute la projection, puis reconsolidait chaque observation contre cette même
projection. Le coût croissait approximativement comme `observations × candidats`, avec de nombreux tableaux, objets
et chaînes temporaires. Ce travail synchrone retardait aussi Discord, le daemon et la traduction.

## Invariants obligatoires

- `Established` et les wipes restent interprétés en GMT ; chaque bloc `/cinfo` calcule son propre wipe et la date de
  capture reste ignorée.
- F7 ne prouve jamais une présence actuelle.
- Une correspondance floue ou OCR non vérifiée ne crée jamais un lien d’identité.
- Les conflits SteamID/BattleMetrics échouent fermés et restent manuels.
- Aucun fichier sous `data/player-intelligence` ni aucun sidecar persistant ne doit être supprimé ou réinitialisé.
- Une panne fournisseur signifie `unknown`, pas déconnexion, et ne doit pas bloquer toute une file.

## Protocole de livraison

Chaque lot suit le même ordre : test de régression, modification ciblée, mesure locale, `npm.cmd test`,
`git diff --check`, incrément SemVer, documentation, commit et push de `master`. Une validation locale ne vaut pas
preuve de production. Après déploiement, les temps de réponse, le heap et la progression des files doivent être
comparés au point de départ ci-dessus.

## Feuille de route par lot

### Lot 1 — Import texte SteamID ciblé — release 1.22.31

Statut : implémenté et validé localement ; déploiement à vérifier.

1. Extraire les SteamID valides et uniques avant toute résolution.
2. Lire dans la projection uniquement les personnes correspondant à ces SteamID.
3. Ajouter seulement leurs alias vérifiés, leurs BattleMetrics déjà liés et les données live non conflictuelles.
4. Préférer le nom BattleMetrics actuel, puis le persona Steam courant vérifié, sans promouvoir une faute OCR.
5. Prouver avec un lot de 100 ID que le résolveur global n’est jamais appelé.

Critères : mêmes aperçus métier, 1 à 100 ID acceptés, inconnus conservés comme pending, conflits BM rejetés, aucune
itération sur toutes les observations pour chaque ID.

### Lot 2 — Consolidateur d’identité préparé et indexé

Statut : planifié.

1. Normaliser les candidats une seule fois par projection.
2. Construire des index `SteamID -> lignes`, `BattleMetrics ID -> lignes` et `nom exact fiable -> lignes`.
3. Exposer un résolveur préparé réutilisable par toutes les observations d’un même cycle.
4. Mettre en cache ce résolveur par objet de projection avec une référence faible.
5. Comparer l’ancien algorithme et le nouveau sur les cas existants et un corpus généré déterministe.
6. Ajouter un benchmark séparé mesurant temps, débit et heap transitoire.

Critères : résultat strictement identique à l’oracle linéaire, ordre déterministe conservé, ambiguïtés et conflits
inchangés, aucun cache global retenant une ancienne projection.

### Lot 3 — Construction et déduplication des candidats

Statut : planifié.

1. Éviter de consolider plusieurs fois le même triplet nom/Steam/BattleMetrics dans un cycle.
2. Séparer les candidats nécessaires aux commandes des événements historiques détaillés.
3. Réutiliser les index de projection dans `/intel`, imports, daemon et ingestion tracker.
4. Conserver les alias passés vérifiés sans les faire participer aux liens exacts interdits.

Critères : aucune différence dans les profils projetés et baisse mesurable des allocations sur une projection réelle.

### Lot 4 — Télémétrie de latence et de mémoire

Statut : planifié.

1. Mesurer sans contenu sensible les durées des imports, commandes, projections, providers et traductions.
2. Échantillonner `heapUsed`, RSS, taille des files et retards de boucle événementielle.
3. Journaliser les opérations lentes avec leur métier et leur taille d’entrée, jamais les tokens ou messages privés.
4. Fournir une commande d’état administrateur compacte et bornée.

Critères : faible coût à vide, métriques plafonnées et diagnostic possible avant saturation.

### Lot 5 — Caches bornés et expirables

Statut : planifié.

1. Inventorier les Maps de Steam, WarBandits, BattleMetrics, OCR et traduction.
2. Donner à chaque cache une taille maximale, un TTL et une politique d’éviction documentés.
3. Ne jamais confondre cache dérivé et preuve append-only.
4. Tester expiration, éviction, panne fournisseur et redémarrage.

Critères : aucune croissance sans borne et aucune perte de données canoniques.

### Lot 6 — Équité et reprise du daemon

Statut : planifié.

1. Séparer les files Steam, WarBandits et enrichissement local.
2. Borner le travail et le temps par tick.
3. Faire progresser le curseur après timeout/erreur et programmer un retry avec backoff.
4. Empêcher deux ticks BattleMetrics de se chevaucher.
5. Persister seulement les checkpoints nécessaires à la reprise.

Critères : un fournisseur lent ne bloque ni les autres IDs ni Discord ; chaque file progresse de façon observable.

### Lot 7 — Priorité interactive et travail en arrière-plan

Statut : planifié.

1. Distinguer tâches interactives, commits et enrichissements opportunistes.
2. Donner la priorité aux accusés Discord et aux lectures locales courtes.
3. Découper les boucles CPU longues avec des points de restitution contrôlés.
4. Annuler proprement les résultats devenus obsolètes sans supprimer de preuve.

Critères : pas de famine du daemon et latence interactive bornée sous charge.

### Lot 8 — Accusés Discord et budgets de commande

Statut : planifié.

1. Auditer chaque slash command et bouton pour que l’accusé soit la première opération attendue.
2. Ajouter un budget global et un message de progression pour les traitements longs.
3. Garantir une réponse finale ou une erreur explicite après chaque `deferReply`.
4. Tester les délais et exceptions avant/après acquittement.

Critères : aucun `The application did not respond` causé par un traitement local lorsque le bot est connecté.

### Lot 9 — Traduction automatique

Statut : planifié.

1. Dédupliquer les traductions identiques en vol et sur une courte fenêtre.
2. Limiter la concurrence par fournisseur et ajouter un circuit breaker temporaire.
3. Mettre en cache les configurations et dictionnaires immuables au lieu de les relire par message.
4. Conserver le relais original indépendant des fournisseurs.

Critères : mémoire bornée, ordre des fournisseurs conservé, timeout total respecté et aucun blocage du chat original.

### Lot 10 — OCR, Tesseract et images

Statut : planifié.

1. Plafonner la file d’images et refuser proprement la surcharge avant décodage coûteux.
2. Expirer les previews/tokens pending et retirer leurs gros buffers dérivés dès que possible.
3. Borner explicitement chaque crop, processus Tesseract et transformation Jimp.
4. Déplacer uniquement les calculs CPU prouvés lourds vers des workers si les mesures le justifient.

Critères : nombre maximal de jobs et de pixels connu, nettoyage testé, sémantique OCR inchangée.

### Lot 11 — Journal et projecteurs

Statut : planifié.

1. Mesurer le coût de `readAll` et des reconstructions par commande.
2. Réutiliser une projection immuable tant que le journal n’a pas changé.
3. Ajouter si nécessaire des snapshots dérivés versionnés et reconstruisibles, jamais une nouvelle autorité mutable.
4. Vérifier corruption, migration et reprise après crash.

Critères : journal JSONL toujours source de vérité, replay complet déterministe et cache invalidé après append.

### Lot 12 — Runtime de production

Statut : planifié après stabilisation applicative.

1. Compiler TypeScript avant déploiement et lancer Node sur les fichiers produits plutôt que `ts-node` en continu.
2. Ajouter un plafond mémoire systemd raisonnable seulement après avoir supprimé la cause de croissance.
3. Configurer redémarrage, délai d’arrêt et collecte de diagnostics sans boucle de crash.
4. Documenter les commandes de vérification RSS/heap/event-loop et la procédure de rollback par release Git.

Critères : démarrage reproductible, mémoire stable sur plusieurs wipes et rollback sans toucher aux données persistantes.

## Vérifications de production du lot 1

Après `git pull` et redémarrage :

1. vérifier `RUSTPLUS v1.22.31 OPERATIONAL` ;
2. noter RSS, `heapUsed` et temps de réponse avant l’import ;
3. rejouer le lot de 11 SteamID, puis un lot de 100 ID si disponible ;
4. exiger un aperçu rapide, les noms locaux déjà vérifiés et aucun dialogue Replace/Keep pour le lot identique ;
5. vérifier que le heap redescend après GC naturel et ne reprend pas une croissance proportionnelle à toute la base ;
6. vérifier que `/intel pending`, le daemon et la traduction continuent de progresser pendant et après l’import.

Le lot 1 supprime le chemin chaud précisément observé, mais ne prétend pas à lui seul résoudre toutes les rétentions.
Les lots suivants doivent être décidés à partir des métriques, dans l’ordre ci-dessus, sans migration MySQL préalable.
