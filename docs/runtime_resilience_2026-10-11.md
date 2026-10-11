# Fiabilisation runtime et isolation des services — 11 octobre 2026

Cette note décrit la release `1.22.42`. Elle ne prétend pas rendre un programme « bug-proof » au sens absolu : elle
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

Les workers ne lisent ni n'écrivent le journal `data/player-intelligence`. Ils renvoient un résultat au cœur, qui reste
le seul propriétaire du commit append-only. Le daemon de consolidation ne doit pas être déplacé avant d'avoir séparé
un plan read-only de son commit par le writer unique.

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
redémarrages, échecs et circuit ouvert. Les logs `RUNTIME` gardent uniquement des compteurs bornés, sans message joueur,
SteamID ou token.

Validation locale de release : `npm.cmd test`, puis `git diff --check`. Cela couvre les rejets d'événements, le
non-chevauchement, la sérialisation, le crash et le timeout d'un vrai worker enfant. Cela ne prouve ni les fournisseurs
réels, ni Tesseract Linux, ni systemd, ni la mémoire en production.

Après `git pull` et redémarrage sur Linux :

1. vérifier `RUSTPLUS v1.22.42 OPERATIONAL` et l'absence de boucle de restart ;
2. observer `systemctl status rustplusplus`, `journalctl -u rustplusplus` et `/runtime` pendant au moins un cycle BM ;
3. provoquer une traduction puis un import OCR et vérifier que les workers apparaissent sans hausse durable du heap
   principal ;
4. tester une commande locale quand Steam/BattleMetrics sont indisponibles et vérifier `unknown/pending`, jamais un
   faux offline ;
5. re-pairer un serveur si possible et vérifier que le pair est sauvegardé même si BattleMetrics échoue.
