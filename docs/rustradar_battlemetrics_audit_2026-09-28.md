# Audit RustRadar vs BattleMetrics — 2026-09-28

## Décision

Ne pas remplacer BattleMetrics par RustRadar dans RustPlusPlus à ce stade.

RustRadar est exploitable comme catalogue public de serveurs, mais pas comme source autoritaire de présence joueur : lors de l'audit, ses routes joueurs renvoient `503 player_data_source_unavailable`, aucun contrat d'API développeur public n'a été trouvé, et ses conditions interdisent l'extraction automatisée sans autorisation écrite. Le client web expose par ailleurs des champs `bm_id` et `server_bm_id`; cela suggère fortement que le sous-système joueurs dépend de données ou d'identités BattleMetrics. Il s'agit d'une inférence issue du client public, pas d'une déclaration officielle du fournisseur.

## Besoin réel du bot

Le tracker existant repose sur BattleMetrics pour :

- identifier durablement un joueur par BattleMetrics Player ID, avec SteamID64 facultatif ;
- déterminer sa présence sur le serveur actif et détecter les transitions connexion/déconnexion ;
- résoudre une recherche de nom limitée au serveur ;
- obtenir, lorsque l'abonnement le permet, historique de sessions et joueurs associés ;
- alimenter un seul poller toutes les 60 secondes, sans interpréter une panne API comme une déconnexion.

Le remplacement doit préserver ces propriétés. Un simple catalogue de serveurs ou une courbe de population ne suffit pas.

## Vérifications live

| Fonction | BattleMetrics actuel | RustRadar constaté le 2026-09-28 | Conclusion |
|---|---|---|---|
| Serveur WarBandits EU 5X No BPs | Déjà configuré sous l'ID `9456371` | [Fiche RustRadar disponible](https://rustradar.gg/api/v1/servers/01a04853-e80c-782a-a13f-d5f76dc11ae1), adresse `185.29.166.79:28010` | Couverture serveur confirmée |
| Catalogue, état, wipe, carte | Disponible dans l'intégration actuelle et via d'autres sources | Routes publiques `/api/v1/servers`, détails et population opérationnelles | RustRadar peut servir d'enrichissement, avec faible valeur ajoutée actuelle |
| Présence d'un joueur précis | Source actuelle du tracker | [Route joueur](https://rustradar.gg/api/v2/players/63764632) : HTTP `503`, `player_data_source_unavailable` | Bloquant |
| Recherche de joueurs | Intégrée, avec filtrage serveur et gestion de l'ambiguïté | Recherche joueurs également indisponible pendant l'audit | Bloquant |
| Historique de sessions / associations | Déjà pris en charge par le bot lorsque le niveau BattleMetrics l'autorise | Fonctions annoncées dans le client, impossibles à valider pendant la panne | Non démontré |
| Identité indépendante de BattleMetrics | BattleMetrics ID autoritaire | Le client public RustRadar transporte `bm_id` et `server_bm_id` | Dépendance BattleMetrics probable, à confirmer par écrit |
| API pour bot | API utilisée et déjà intégrée | Routes du SPA non documentées : aucun jeton développeur, quota, webhook, schéma stable, SLA ou changelog public trouvé | Contrat d'intégration absent |
| Automatisation autorisée | Intégration existante | Les [conditions RustRadar](https://rustradar.gg/terms) interdisent notamment robots/data mining sans permission écrite | Ne pas appeler ces routes depuis le bot sans accord |

Une [annonce RustRadar](https://t.me/rustradargg/20) signalait aussi l'indisponibilité temporaire du suivi des joueurs. Le service ayant été lancé récemment en 2026, son historique d'exploitation est encore court.

## Coûts

### RustRadar

La [route publique des plans](https://rustradar.gg/api/v1/plans) annonce actuellement :

- Premium : `199 RUB/mois` ;
- limite déclarée par cette route : 50 joueurs et 50 serveurs ;
- prix annuel déclaré : `5 000 RUB`.

Au taux officiel de la Banque centrale de Russie du 2026-09-28 (`1 EUR = 95,8709 RUB`, [source CBR](https://www.cbr.ru/scripts/XML_daily.asp?date_req=28/09/2026)) :

- `199 RUB` ≈ `2,08 EUR` par mois ;
- douze paiements mensuels = `2 388 RUB` ≈ `24,91 EUR` par an ;
- le tarif annuel publié de `5 000 RUB` ≈ `52,15 EUR`.

Le tarif annuel est donc supérieur à douze mensualités. De plus, différentes zones de l'interface publique affichent 20 ou 50 éléments suivis. Ces incohérences doivent être clarifiées par écrit avant tout achat. Peuvent s'ajouter conversion de devise, frais du moyen de paiement et disponibilité régionale. Les conditions autorisent l'évolution des prix et ne garantissent pas une disponibilité ininterrompue.

Une offre gratuite et un essai court sont affichés sur le site, mais ils ne résolvent ni la panne joueurs, ni le droit d'intégrer le service au bot.

### BattleMetrics et migration

Le montant exact de l'abonnement BattleMetrics actif n'est pas exposé dans le dépôt et n'a pas pu être vérifié publiquement de manière fiable. La facture du compte est la seule référence à retenir. Le conserver n'entraîne aucun coût de migration et préserve l'intégration déjà testée.

Le coût d'un passage à RustRadar n'est pas chiffrable sérieusement avant d'obtenir une API contractuelle. Il comprendrait au minimum : adaptateur fournisseur, authentification serveur, validation stricte des schémas, migration des identités persistées, tests de panne et d'ambiguïté, métriques comparatives, puis observation parallèle. Intégrer directement les routes privées du SPA créerait une dette fragile et un risque contractuel ; cette option est exclue.

## Conditions minimales d'une réévaluation

Demander à RustRadar une réponse écrite sur :

1. l'existence d'une API bot, son mode d'authentification, ses quotas et l'autorisation d'usage automatisé ;
2. la provenance des données joueurs et l'éventuelle dépendance à BattleMetrics ;
3. la disponibilité réelle du suivi sur WarBandits EU 5X No BPs, sa fraîcheur et son SLA ;
4. les identifiants stables, SteamID64, sessions, associations et noms censurés ;
5. les webhooks éventuels et la sémantique des erreurs ;
6. les limites exactes — 20 ou 50 — et l'écart `199 RUB/mois` contre `5 000 RUB/an` ;
7. les modalités de paiement, renouvellement, remboursement et traitement des données.

Après accord, exécuter au moins 30 jours en parallèle, sans changer les alertes utilisateur, et mesurer : transitions manquées, faux changements d'état, latence, indisponibilité et stabilité des identifiants. La bascule ne serait admissible que si RustRadar égale ou dépasse BattleMetrics sur ces critères et ne transforme jamais une panne externe en événement `offline`.

## Recommandation opérationnelle

- Garder BattleMetrics comme source primaire du tracker.
- Ne pas acheter RustRadar dans le seul but de remplacer BattleMetrics tant que le suivi joueur est indisponible et l'API non contractualisée.
- Utiliser éventuellement l'essai pour une validation manuelle, sans automatiser les routes du site.
- N'envisager RustRadar comme fournisseur secondaire de métadonnées serveur qu'après autorisation écrite ; ce rôle duplique largement les données déjà disponibles et ne remplace pas la présence joueur.

