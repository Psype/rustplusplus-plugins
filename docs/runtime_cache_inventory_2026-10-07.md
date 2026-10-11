# Inventaire des caches runtime — 7 octobre 2026

Cet inventaire distingue les données reconstructibles des preuves persistantes et des travaux actifs. Un cache peut
être évincé ; un journal, une décision en cours ou une file de travail ne le peut pas sans protocole spécifique.
Aucune éviction décrite ici ne supprime de fichier sous `data/player-intelligence`.

## Caches bornés en release 1.22.35

| Métier | Contenu dérivé | TTL | Plafond | Éviction / reconstruction |
| --- | --- | ---: | ---: | --- |
| Steam | Persona courant | 1 h, échec 30 s | 1 024 | LRU ; nouvelle lecture publique Steam |
| Steam | Persona et alias passés | 1 h si complet, 30 s sinon | 1 024 | LRU ; nouvelle lecture publique Steam |
| Steam | Anti-spam des avertissements | 1 h | 2 048 | LRU ; aucun effet sur l'identité |
| BattleMetrics | Documents JSON:API | 5 ou 10 min selon l'appel | 256 | LRU ; nouvel appel borné |
| BattleMetrics | Cooldowns HTTP 429 par client | jusqu'à 1 h | 128 | expiration ; le fournisseur redevient appelable |
| WarBandits | noms/wipes/pages de statistiques | 5 min | 256 | LRU ; nouvel appel sérialisé |
| OCR corrections | documents validés lus du sidecar | 10 min | 64 | LRU ; relecture et revalidation du fichier |

Tous utilisent `src/util/boundedTtlCache.js`. Le TTL est absolu et non glissant : consulter une entrée améliore son
rang LRU sans prolonger sa validité. Les entrées expirées sont purgées avant une éviction de capacité. Une panne
fournisseur n'efface ni preuve ni sidecar. Les registres de sérialisation OCR visuelle/corrections retirent désormais
leur Promise réglée seulement si elle est toujours la dernière du chemin ; deux écritures concurrentes restent donc
sérialisées.

## Structures déjà bornées par construction

- Le catalogue WarBandits en mémoire contient un seul document ; son fichier disque reste un fallback validé.
- La configuration Bing contient au plus un token et est remplacée à expiration ou après HTTP 401.
- Les index `WeakMap`/`WeakSet` des événements, projections, consolidateurs et features OCR suivent la durée de vie de
  leur clé et n'ajoutent pas de racine forte.
- Les Maps `inFlight`, verrous et revendications de décision retirent leurs entrées en `finally`. Leur admission et
  leur équité relèvent des lots 6, 9 ou 10, pas d'un cache TTL.
- Les RPC du scan ne sont pas un cache : au plus quatre appels sont en vol dans un worker. Après timeout, les
  invocations fournisseur réellement encore pendantes restent plafonnées à huit globalement et quatre par provider ;
  une réponse tardive est jetée et les compteurs/circuits/pending sont visibles dans `/runtime`. Le délai vaut 30 s
  par défaut et `RPP_PLAYER_SCAN_PROVIDER_TIMEOUT_MS` l'autorise entre 1 et 45 s.

## Petits états dérivés bornés en release 1.22.36, resserrés en 1.22.45

| Métier | Contenu dérivé | TTL | Plafond | Sémantique conservée |
| --- | --- | ---: | ---: | --- |
| Hook player-intelligence | mode de disponibilité, wipe, empreintes et liste online courante | 24 h depuis le dernier poll calme | 32 serveurs × 2 000 online | une expiration force un replay idempotent |
| Scan daemon | cooldown d'un rescan manuel | 5 min | 256 | même seconde de reprise, expiration à la frontière |
| Scan daemon | backoff d'échec worker automatique | 24 h de conservation, reprise 5–60 min | 256 | `!scanplayers` contourne la pause ; un succès la retire |
| Scan daemon | anti-spam d'avertissement | 1 h | 256 | le travail échoue toujours fermé, seul le log est supprimé |
| Player tracker | choix complets d'un sélecteur | 5 min + 1 ms de frontière | 1 024 | choix valide exactement cinq minutes |
| Player tracker | avis d'expiration sans candidats | 24 h après l'expiration | 1 024 | conserve `Selection expired` sans retenir le tableau lourd |

Les empreintes de hook ne retiennent plus la concaténation de tous les joueurs : chaque vue triée est réduite à un
SHA-256 de longueur fixe. En `1.22.45`, le plafond passe de 128 à 32 serveurs parce que chaque état conserve aussi la
dernière vue online bornée à 2 000 identités afin de produire des deltas sans reconstruire la projection. Le TTL du
hook est renouvelé sur le chemin calme afin de représenter l'inactivité ; le TTL interne du cache reste non glissant.
Chaque sample de disponibilité est identifié par mode, timestamp fournisseur et empreinte ; une recovery au même
`updatedAt` emploie `recordedAt`. Le marker complet est toujours final et n'est jamais durable si le batch de recovery
est interrompu. Une sélection player-tracker consommée retire à la fois ses candidats et son avis.

## Cache CSV ajouté en release 1.22.45

| Métier | Contenu dérivé | TTL | Plafond | Éviction / reconstruction |
| --- | --- | ---: | ---: | --- |
| Teammate language DB | lignes CSV validées, profondément immuables | 10 min absolues | 16 fichiers, 40 000 lignes, 32 MiB ; 10 000 lignes/8 MiB par fichier | LRU ; relecture si signature disque différente |

La signature contient device, inode, taille, mtime et ctime. Elle est contrôlée avant et après lecture afin qu'un
fichier modifié en course ne devienne jamais la vue cachée. Une écriture locale purge l'entrée avant et après l'appel,
y compris si l'écriture échoue. Un fichier dépassant la borne est ignoré avec un avertissement borné ; le lot de
liaisons locales échoue fermé pour ne jamais valider une paire contre une vue partielle. Ni ce refus ni l'éviction ne
tronquent ou ne retirent une ligne du CSV canonique. Ses alias historiques sont server-wide et journalisés avec
`wipeId:null` ; un nouveau wipe ne réémet plus les quelque 5 100 lignes observées.

## Structures qui ne sont pas des caches ordinaires

### Lot 10 — OCR et previews (réalisé en 1.22.42)

`importWorkflow.pending` contient jusqu'à la décision des interprétations, features visuelles et aperçus qui ne sont
pas encore des preuves. Son TTL reste de 30 minutes ; les chemins de préparation, interaction et télémétrie purgent
les entrées expirées, et la table est plafonnée à 256 en supprimant d'abord les plus anciennes. La file OCR locale
admet au plus quatre reconnaissances et 24 MiB ; le superviseur Tesseract de production ajoute une file IPC de deux
demandes, avec requête 16 MiB et réponse 4 MiB maximum. Une surcharge est refusée explicitement sans commit.

### Lot 11 — journal et projections

`historyStore.sharedDirectories` conserve le replay validé, les IDs connus et la queue d'append par répertoire. Les
stores existants partagent cet objet pour garantir l'exclusion mutuelle ; un LRU naïf pourrait créer deux queues et
autoriser des appends concurrents. Les projections et consolidateurs sont dérivés mais restent vivants tant que le
snapshot courant l'est. Le lot 11 mesurera séparément leur poids et introduira un cycle de vie sûr sans changer le
journal JSONL, qui reste la source de vérité.

La release `1.22.43` a supprimé une rétention transitoire majeure : `projectionCandidates` ne matérialise plus le
produit cartésien alias × BattleMetrics IDs et reste linéaire en entrée. En `1.22.44`, les index de réconciliation des
rosters sont construits une fois à l'intérieur d'une projection clans puis libérés avec elle ; ils ne forment aucune
racine globale. Le cache de résolution public d'une projection identité est plafonné à 20 000 clés. La lecture JSONL
et la fusion par shard réduisent les copies transitoires, sans évincer ni réécrire une preuve persistante.

Les benchmarks jusqu'à 324 000 événements situent les projecteurs identité/métriques/présence autour de 1,24 s au
total. Le snapshot partagé demeure nécessaire à l'exclusion mutuelle des appends. Le worker de scan est read-only :
le parent rebase les ajouts sans rapport, mais refuse avant append un checkpoint/scope modifié, un contrôle d'identité
modifié ou un read-set Steam/BM/nom devenu stale, sans introduire un second writer. Une politique d'archivage des
transitions/sessions historiques resterait une décision métier distincte et n'est pas appliquée automatiquement.

En `1.22.45`, le child construit une projection dédiée au scan : identités, métriques et preuves de clan seulement.
Le cache faible correspondant reste attaché au snapshot immuable et n'est pas une nouvelle racine. Sur 108 000
événements synthétiques, cette vue a réduit la médiane de 3 955 à 3 034 ms (-23 %) et la hausse de heap de 188,1 à
134,7 MiB (-28 %) ; la production doit encore confirmer le gain et au moins un plan terminé.

Le coût d'écriture canonique reste un résiduel : `mergeInShardOrder` recopie le snapshot courant et
`historyRevision` le sérialise/hache, donc un append réel reste `O(N)`. `pi_history_append` l'instrumente sans changer
la rétention ni la source de vérité. Ce journal ne doit jamais être soumis à une éviction LRU.

`provider_availability_observed` est un nouvel event kind du schema 1. Après sa première écriture, une release
antérieure à `1.22.45` ne peut pas lire le journal. Sauvegarder `data/player-intelligence` avant déploiement et ne
jamais supprimer/tronquer ces données pour contourner un rollback incompatible.
