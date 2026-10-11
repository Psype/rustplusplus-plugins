# Fiabilisation runtime et isolation des services — 11 octobre 2026

Cette note décrit les releases `1.22.42` à `1.22.45`. Elle ne prétend pas rendre un programme « bug-proof » au sens absolu : elle
réduit les causes connues de reboot, borne les charges reconstructibles et limite le rayon d'impact des fournisseurs
externes et des traitements lourds.

## Frontières de panne

- Un événement Discord `error` et un échec d'enregistrement des slash commands sont journalisés ; ils ne terminent
  plus le processus.
- Les callbacks asynchrones Discord, Rust+, Rust+ Lite, FCM et les principaux timers différés passent par une frontière
  qui observe les rejets. Une panne reste attachée à son contexte au lieu de devenir un rejet global anonyme.
- `uncaughtExceptionMonitor` écrit un diagnostic borné mais ne masque pas une corruption inconnue : Node peut encore
  sortir et systemd le redémarrer. Avaler toute exception non interceptée laisserait un état potentiellement incohérent.
- Une guilde Discord mal configurée ne bloque plus le démarrage des guildes suivantes, de BattleMetrics ou de Rust+.
- Une erreur du transport Winston désactive la sortie fichier défaillante après un diagnostic `stderr`; elle ne doit
  pas devenir un événement `error` fatal. Les journaux raw refusent un enregistrement de plus de 1 MiB et cessent de
  grossir au-delà de 16 MiB par fichier.

## Boucles et files bornées

- Le poll Rust+ et le cycle BattleMetrics utilisent une boucle série auto-planifiée : le cycle suivant n'est armé
  qu'après la fin du précédent. Une API lente ne peut donc plus empiler un nouveau cycle à chaque intervalle.
- Une réponse Rust+ vide invalide uniquement le poll courant ; elle ne détruit plus définitivement le scheduler.
- La traduction accepte deux travaux actifs et huit en attente. Au-delà, la traduction reconstructible est abandonnée
  et le message original continue son chemin.
- La file OCR locale accepte quatre reconnaissances et 24 MiB en attente. Le superviseur OCR de production ajoute une
  file IPC de deux demandes maximum.
- Les aperçus d'import expirés sont balayés et leur table est plafonnée à 256. La file de messages Rust sortants est
  plafonnée à 100 ; les réponses critiques raid utilisent toujours leur voie accusée séparée.
- Les délais de poll/reconnexion provenant de l'environnement sont des entiers bornés. La chaîne `false` désactive
  réellement les stacks et peut désormais désactiver `needAdminPrivileges` sans devenir truthy par accident.

## Processus isolés

Le cœur conserve Rust+, les commandes locales, FCM/raid et l'unique écriture des fichiers canoniques. Deux traitements
optionnels sont lancés paresseusement par `src/util/processSupervisor.js` :

1. `translationWorker.js` exécute la chaîne Google/DeepLX ou LibreTranslate/Bing/MyMemory dans un processus Node limité
   à 128 MiB de heap. Une demande expire après 7 secondes.
2. `tesseractWorker.js` exécute le binaire Tesseract depuis un processus Node limité à 384 MiB de heap. Une demande
   expire après 60 secondes ; l'entrée IPC est limitée à 16 MiB et la réponse à 4 MiB.

Chaque service traite une demande à la fois. Le protocole IPC est versionné, les tailles sont validées, un timeout tue
le worker et un crash rejette seulement la demande active. Le prochain travail redémarre le worker paresseusement. Le
circuit s'ouvre une minute après cinq crashes en dix minutes afin d'éviter une boucle de fork.

La limite V8 ne borne pas à elle seule les buffers natifs. Les limites d'image existantes, l'admission IPC et le
traitement série restent donc nécessaires. Une limite RSS dure nécessite à terme des unités systemd séparées avec
`MemoryMax`; les workers enfants de cette release partagent encore le cgroup de `rustplusplus.service`.

Les workers de traduction et OCR ne lisent ni n'écrivent le journal `data/player-intelligence`. Depuis `1.22.44`, le
worker de scan reçoit uniquement un store exposé en lecture et son chemin applicatif n'appelle aucun append : il
renvoie un plan versionné que le processus parent recanonicalise, borne et contraint au triplet guilde/serveur/wipe.
Le parent compare
exactement checkpoint et scope dans la file d'append, rebase les ajouts indépendants, puis rejette seulement un plan
touché par un contrôle global ou un guard Steam/BM/nom devenu stale. Il reste donc l'unique writer des événements
canoniques et du checkpoint de scan.

Depuis `1.22.45`, chaque RPC du worker de scan a une enveloppe et des arguments exacts par méthode, une requête de
4 KiB maximum, une réponse de 8 MiB maximum, au plus quatre appels en vol par worker et un délai indépendant de 30 s
par défaut (`RPP_PLAYER_SCAN_PROVIDER_TIMEOUT_MS`, borné entre 1 et 45 s). Le parent plafonne aussi les invocations
fournisseur qui ont expiré mais dont la Promise externe n'est pas encore réglée : huit globalement et quatre par
provider. Leur réponse tardive est ignorée et ne retient plus le child. L'échec immédiat d'un envoi IPC ou de la
livraison du résultat final est explicite ; circuits et pending restent visibles dans `/runtime`.
Avant la livraison IPC, le parent projette chaque réponse sur le contrat exact de la méthode : les champs inconnus et
accesseurs ne sont jamais lus, les alias Steam/WarBandits sont limités à 256 et une page WarBandits à 100 lignes. Une
réponse mal formée ou trop grande échoue fermée pour cet enrichissement facultatif sans transmettre le payload brut.

## Hotfix mémoire 1.22.43

Le journal de production a révélé quatre OOM déterministes du processus principal environ 376 à 378 secondes après
chaque démarrage, au voisinage de la limite V8 de 2 042 MiB. Il ne s'agissait pas d'un crash des workers ni d'une
simple panne fournisseur.

Deux coûts se cumulaient :

- `ts-node .` conservait le compilateur et son programme `allowJs` pendant toute la vie du bot. Une sonde locale du
  chargement des modules mesurait environ 1 067 MiB de heap avec `ts-node`, contre 47,7 MiB avec Node natif ;
- `projectionCandidates` matérialisait alias × BattleMetrics IDs avant de reconstruire les index. Avec 2 500 alias et
  2 500 IDs, cela représentait 6 250 000 lignes temporaires.

La release lance donc `node .` via `index.js`, sans modifier la commande opérateur `npm start`. Le pont `index.ts`
reste disponible aux modules CommonJS existants. Le consolidateur produit maintenant au plus `B + 2A` lignes lorsqu'il
existe plusieurs BattleMetrics IDs : chaque ID stable reste représenté et deux associations distinctes par alias
préservent le refus automatique des ambiguïtés. Le cas 2 500 × 2 500 tombe ainsi à 7 500 lignes. Des tests différentiels
vérifient le résultat métier contre l'ancien produit cartésien sur les projections ordinaires.

Le déploiement observé de `1.22.43` a franchi l'ancienne frontière de crash : démarrage opérationnel en environ sept
secondes, puis plus de huit minutes quarante sans OOM dans l'extrait fourni. Après GC, le heap se situait environ entre
547 et 630 MiB et le RSS entre 760 et 870 MiB. Cette observation valide le correctif OOM sur cette fenêtre, pas une
stabilité illimitée. Elle a aussi révélé un problème distinct : les cycles de scan duraient 44 à 48 secondes et
bloquaient la boucle principale environ 40 à 42 secondes, avec CPU/ELU proche de 100 %, pendant que Rust+ expirait.

## Projection indexée et scan isolé 1.22.44

- Le replay des membres `/cinfo` non résolus prépare une fois les groupes, index Unicode et index de recherche, puis
  les réutilise pour toutes les captures historiques. Les exclusions par personne évitent de reconstruire tout le
  catalogue pour chaque snapshot ; une collision inter-identités repasse par le chemin exact conservateur.
- Les projecteurs identité, métriques et présence évitent plusieurs tris/copies globaux. La lecture JSONL ne crée plus
  un tableau contenant toutes les lignes et le cache mensuel fusionne les ajouts sans recopies intermédiaires.
- `Core.rebuildAsync` cède la boucle entre ses étapes fixes sur le hook BattleMetrics. Six métriques bornées
  `pi_rebuild_*` exposent total, identités, métriques, clans, présence et wipes sans nom ni identifiant joueur.
- Le scan lourd est planifié dans un processus enfant one-shot. Steam, BattleMetrics et WarBandits restent appelés par
  RPC dans le parent, où leurs caches/circuits demeurent uniques. Une panne, un timeout ou un OOM du worker avant la
  réception et la validation d'un plan complet ne modifie ni journal ni checkpoint ; après livraison, seul le commit
  parent validé peut continuer.
- Le plan protocole v3 a des clés, tailles, compteurs, sources et kinds stricts ; le child ne peut proposer que les
  observations identité/métrique propres au daemon. Le parent recanonicalise tout et reste l'unique writer durable.
- Le checkpoint et le scope utilisent une comparaison exacte. Les appends sans rapport sont rebasés pour ne pas
  affamer un scan sur un serveur actif. Une révision de contrôle globale couvre les liens/révocations/supersessions,
  et des guards bornés couvrent seulement les SteamID, BattleMetrics ID et noms exacts ayant fondé une décision : une
  correction ou collision pertinente rend le plan stale avant toute écriture et déclenche au plus un replan immédiat.
- Une file FIFO globale, bornée et coalescée par répertoire donne accès à un seul worker à la fois sans perdre un
  `!scanplayers` concurrent. Un job différé recalcule son wipe au dispatch, un rerun manuel reste forcé si l'admission
  échoue, et son cooldown est remboursé si la file le refuse. Le protocole borne requête, tables BattleMetrics, appels
  fournisseur, réponses, guards et plan. L'arrêt tue/récolte les enfants puis attend la fin d'un éventuel commit parent ;
  la grâce SIGTERM du processus principal est portée à 30 secondes pour ne pas couper un append JSONL fsync en cours.

Le compare-and-append suppose un seul processus parent écrivain, comme le service systemd prévu. Deux instances du bot
pointant simultanément vers le même répertoire nécessiteraient un verrou inter-processus qui n'est pas fourni. Une
panne entre deux shards d'un même batch, ou après le `fsync` du journal mais avant le remplacement du checkpoint, peut
laisser un préfixe d'observations durable avec un checkpoint en retard. Le checkpoint n'avance jamais avant la preuve.
Le passage suivant déduplique les événements dont l'ID est déterministe ; une observation reconstruite avec un nouvel
horodatage peut être répétée, mais aucune preuve existante n'est supprimée et le replay reste récupérable.

Mesures synthétiques locales : avec 2 700 identités, 120 snapshots × 4 membres non résolus passent d'environ 23,25 s
sur l'ancien replay à environ 0,33–0,37 s ; 1 200 snapshots passent en environ 1,70 s. Identités, métriques et présence
traitent ensemble 81 000 événements en environ 0,39 s. Ces chiffres isolent le coût algorithmique et ne constituent
pas une mesure de la machine Linux de production.

## Bilan de production 1.22.44

L'extrait fourni le 11 octobre ne contient ni crash, ni redémarrage, ni OOM du bot. Le RSS oscille globalement entre
environ 908 et 1 030 MiB, autour de 952 MiB en moyenne, sans croissance monotone visible sur cette fenêtre. Cette
stabilité ne suffit pourtant pas à valider le scanner : `scanWorkersCompleted` reste à zéro, tandis que les échecs
passent de 7 à 18. Chaque tentative dure en moyenne environ 114,8 secondes avant de disparaître. La release jetait le
`stderr` du child et dédupliquait le warning une heure ; la cause exacte ne pouvait donc pas être distinguée entre
OOM, exception, IPC ou arrêt externe.

Le hook parent reconstruit parallèlement une projection complète environ toutes les 103,5 secondes. Son total moyen
est 18,38 secondes et son maximum observé proche de 21,8 secondes. Les alarmes, morts et le tracker continuent, ce qui
montre que l'isolation limite bien le rayon d'impact du child, mais `1.22.44` n'a ni fait progresser le scan ni supprimé
le blocage CPU résiduel du parent. Ce constat de production remplace toute conclusion tirée des seuls tests locaux.

## Projection compacte, présence fail-closed et reprise 1.22.45

- `rebuildForScan` reconstruit seulement les identités, métriques et preuves de clan consommées par le planner. Il
  omet sessions de présence, historique des wipes, historique complet des clans et affinités. Sur un corpus local de
  108 000 événements, sa médiane est 3 034 ms contre 3 955 ms pour la projection complète (-23 %) ; la hausse de heap
  mesurée est 134,7 MiB contre 188,1 MiB (-28 %). Le RSS du benchmark reste trop proche pour conclure et aucun de ces
  chiffres n'est une mesure Linux de production.
- Le hook BattleMetrics ne lit plus tout le journal et ne reconstruit plus `Core.rebuild`. Il produit directement les
  événements sûrs, garde un état borné à 32 serveurs et au plus 2 000 identités online par serveur, et laisse le child
  calculer les enrichissements lourds. Une reprise complète n'émet plus des milliers d'offline individuels.
- Les paires SteamID/BattleMetrics déjà présentes dans le player-tracker ou le CSV teammate-language ne sont pas
  admises aveuglément dans le journal par le hook. Elles sont transmises comme candidats au worker, qui les revalide
  contre la projection compacte, refuse toute collision Steam/BM/nom et committe au plus 100 nouvelles liaisons sûres
  par cycle. Cette étape locale précède Steam/BattleMetrics/WarBandits et reste committable lorsque ces services
  facultatifs échouent ou expirent.
- Un échec automatique crée un backoff par serveur de 5, 10, 20, 40 puis 60 minutes, fondé sur un code stable plutôt
  que sur un message susceptible de contenir un joueur ou une page différente. `!scanplayers` contourne ce backoff ;
  un succès remet la série à zéro.
- Le child envoie des stages bornés (`reading_history`, `rebuilding`, fournisseurs, finalisation, etc.) et son dernier
  RSS/heap. Le parent remet ces jauges à zéro à l'état idle et conserve seulement code, stage, date et classification
  `stderr` privée (`heap out of memory`, erreur IPC finale, exception Node connue…). `/runtime` marque la santé scan
  dégradée pendant une série d'échecs ou un backoff, sans exposer pseudo, SteamID, chemin ou réponse fournisseur.
- `provider_availability_observed` sépare la fiabilité globale de la présence individuelle. Seul `available`, émis
  après une liste complète et après ses observations online, autorise la projection à considérer les absents offline.
  Une liste réussie mais incomplète garde les joueurs présents online et place les absents de la vue précédente en
  unknown. Un mode censuré ou un appel échoué rend l'état unknown et ne persiste pas de pseudo masqué comme alias
  vérifié. La clé d'échantillon contient mode, timestamp fournisseur et empreinte du roster ; une recovery qui reçoit
  le même `updatedAt` utilise `recordedAt` pour rester distincte. Le marker global reste le dernier élément du batch et
  un append de recovery interrompu ne le persiste jamais : aucune déconnexion ne peut être fabriquée.
- Les lectures du CSV teammate-language utilisent un cache immuable de 16 fichiers, 40 000 lignes et 32 MiB au total,
  avec TTL absolu de dix minutes. Chaque fichier accepté est limité à 10 000 lignes et 8 MiB : un dépassement est
  signalé, le scan local échoue fermé et le fichier durable reste strictement inchangé. La signature
  dev/inode/taille/mtime/ctime est vérifiée avant et après lecture ; une modification externe ou toute écriture locale
  invalide la vue avant sa réutilisation. Ses alias historiques utilisent une portée `wipeId:null`, car ils sont
  server-wide ; le changement de wipe ne peut plus append à nouveau les quelque 5 100 lignes observées.

La mutation durable n'est pas devenue à coût constant. À chaque append réel, `historyStore` fusionne encore le
snapshot courant avec les ajouts et recalcule sa révision forte ; ce chemin reste `O(N)` en nombre d'événements. La
métrique fermée `pi_history_append` permet désormais de corréler ce coût avec les pauses réelles. Une refonte
incrémentale/shardée reste un chantier ultérieur, sans migration MySQL ni suppression du journal canonique.

Compatibilité de rollback : le nouvel event kind `provider_availability_observed` est ajouté au schema 1 existant.
Dès qu'il est écrit, `1.22.44` et les versions plus anciennes rejetteront le journal comme inconnu/corrompu. Faire une
sauvegarde de `data/player-intelligence` avant le premier démarrage `1.22.45` et conserver cette sauvegarde ainsi que
les données courantes. Ne jamais supprimer, tronquer ou réinitialiser ces fichiers pour faire démarrer un rollback ;
revenir plutôt à `1.22.45` ou à une version ultérieure compatible.

## Services externes et mode dégradé

| Défaillance | Comportement attendu |
| --- | --- |
| Discord gateway/REST | Rust+, FCM et les tâches locales restent actifs ; la projection Discord reprendra plus tard. |
| BattleMetrics | Timeout à 10 s, réponse limitée à 2 MiB et schéma validé ; le dernier état reste stale/unknown, jamais une déconnexion inventée. |
| BattleMetrics pendant Pair with Server | Le pair Rust+ est persisté d'abord avec les champs BM éventuellement vides ; l'enrichissement est best-effort ensuite. |
| Steam/WarBandits | Les identités locales et commandes sans enrichissement restent utilisables ; les champs restent pending/unknown et les mécanismes de reprise existants s'appliquent. |
| Traduction | Le message original n'est pas annulé ; seule la traduction optionnelle manque. |
| Tesseract/OCR | L'import ne commit rien et peut être rejoué ; le bot, Rust+ et les données existantes restent intacts. |
| StreamElements voix | Timeout à 5 s et réponse limitée à 2 MiB ; les sorties Discord/in-game indépendantes continuent. |
| Disque/log Winston | La sortie fichier est coupée après erreur et la console reste disponible ; les écritures de configuration utilisent temp + fsync + rename. |

## Observabilité et validation

`/runtime` expose désormais les boucles série et les services isolés : actifs, en attente, processus en marche,
redémarrages, échecs, plans stale et circuit ouvert. Il affiche aussi completed/p95/max des six étapes de projection,
le coût `pi_history_append`, le stage/mémoire du worker actif, son dernier code d'échec et le backoff automatique.
Les logs `RUNTIME` gardent uniquement des compteurs et textes allowlistés, sans message joueur, SteamID ou token.

Validation locale `1.22.44` : `363/363` tests avec `npm.cmd test`, puis `git diff --check`. Cela couvre les rejets
d'événements/capacités, les courses journal/checkpoint/scope, guards d'identité, rebase sans rapport, ordre durable
journal puis checkpoint, files/reruns bornés, shutdown pendant commit, crash et timeout d'un vrai worker enfant. Cela
ne prouve ni les fournisseurs réels, ni Tesseract Linux, ni systemd, ni la mémoire en production.

Validation locale `1.22.45` : `npm.cmd test` passe 430/430 tests, puis `tsc --noEmit -p .` réussit.
`git diff --check` est propre. Cette preuve couvre les régressions déterministes ; elle ne remplace toujours pas la
validation Linux des workers, fournisseurs, RSS ni latence réelle.

Après `git pull` et redémarrage sur Linux :

1. sauvegarder `data/player-intelligence`, vérifier `RUSTPLUS v1.22.45 OPERATIONAL` et l'absence de boucle de restart
   pendant plusieurs cycles ;
2. observer `systemctl status rustplusplus`, `journalctl -u rustplusplus` et `/runtime` avant/après `!scanplayers` :
   exiger au moins un worker `completed`, suivre stage/RSS/heap/backoff/dernier code et vérifier que le parent ne répète
   plus les projections de 18–22 secondes observées sous `1.22.44` ; corréler les pauses restantes avec
   `pi_history_append` ;
3. provoquer une traduction puis un import OCR et vérifier que les workers apparaissent sans hausse durable du heap
   principal ;
4. tester une commande et une liaison locale quand Steam/BattleMetrics/WarBandits sont indisponibles : les données
   locales doivent rester utilisables, l'enrichissement `unknown/pending` et aucun faux offline ne doit apparaître ;
5. re-pairer un serveur si possible et vérifier que le pair est sauvegardé même si BattleMetrics échoue.
