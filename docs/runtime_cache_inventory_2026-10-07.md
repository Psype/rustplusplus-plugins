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

## Petit état dérivé restant pour le sous-lot 5b

- `playerIntelligence/runtime.js` garde un fingerprint par répertoire actif.
- `scanDaemon.js` garde les timestamps de rescan manuel et d'anti-spam d'avertissement.
- `playerTracker` garde les sélecteurs utilisateur abandonnés jusqu'à leur prochaine consultation.

Ces valeurs sont petites, mais seront plafonnées séparément afin de conserver les messages d'expiration et
l'idempotence existants.

## Structures reportées parce qu'elles ne sont pas des caches ordinaires

### Lot 10 — OCR et previews

`importWorkflow.pending` contient jusqu'à la décision des interprétations, features visuelles et aperçus qui ne sont
pas encore des preuves. Son TTL de 30 minutes n'est actuellement purgé que lors d'une interaction sur le token. La
file Tesseract retient le base64 des jobs en attente et n'a pas encore de plafond d'admission. Le lot 10 ajoutera une
expiration active, des limites globales/par utilisateur et des plafonds de jobs/octets, avec refus explicite en
surcharge.

### Lot 11 — journal et projections

`historyStore.sharedDirectories` conserve le replay validé, les IDs connus et la queue d'append par répertoire. Les
stores existants partagent cet objet pour garantir l'exclusion mutuelle ; un LRU naïf pourrait créer deux queues et
autoriser des appends concurrents. Les projections et consolidateurs sont dérivés mais restent vivants tant que le
snapshot courant l'est. Le lot 11 mesurera séparément leur poids et introduira un cycle de vie sûr sans changer le
journal JSONL, qui reste la source de vérité.
