# Passation de session IA — 4 octobre 2026

Ce document est le point d’entrée compact d’une nouvelle session IA. Il ne remplace pas `MEMORY.md`, qui reste la
mémoire détaillée et l’autorité en cas de doute. L’objectif est de reprendre le dépôt sans réinitialiser, dupliquer ou
contredire le travail déjà effectué.

## Introduction prête à copier

```text
Nous reprenons le projet Rust+/Discord situé dans
C:\Users\Psype\Desktop\IA\Projects\Rust\rustplusplus-plugins.

Avant toute modification :
1. lis intégralement MEMORY.md puis docs/ai_session_handoff_2026-10-04.md ;
2. inspecte git status --short, git diff --check et le diff utile ;
3. préserve toutes les modifications existantes : elles sont intentionnelles et appartiennent à l’utilisateur ;
4. ne fais ni reset, ni checkout destructif, ni réécriture globale du worktree ;
5. ne prétends jamais qu’un comportement fonctionne en production sur la seule base des tests locaux.

État observé avant la release courante : branche master, HEAD/origin/master alignés sur `5917199`, release 1.22.35,
et worktree propre. La release 1.22.36 borne les petits états dérivés restants sans toucher au journal.
Le commit d327e7d contient les releases 1.22.24 à 1.22.26 avec leurs documentations/tests ; `a308c0a` ajoute la
1.22.27. La release suivante 1.22.28 groupe les alias pending par identité BattleMetrics et ajoute le fallback
WarBandits courant -> intervalle historique pertinent -> all-time. La release 1.22.29 centralise toute consolidation
locale SteamID/BattleMetrics/pseudo et collecte en arrière-plan le nom Steam courant plus ses alias Steam passés. La
release 1.22.30 garde la preuve initiale lorsqu'un lot SteamID identique est rejoué, affiche l'enrichissement local
courant sans Replace/Keep et empêche un profil Steam indisponible de bloquer tous les IDs suivants.
La release 1.22.31 résout uniquement les SteamID collés, conserve les alias Steam vérifiés et liens BattleMetrics non
conflictuels, et préfère le nom BM live puis le persona Steam courant.
La release 1.22.32 indexe SteamID/BattleMetrics/nom fiable une fois par projection et vérifie tous les résultats contre
un oracle linéaire figé de la 1.22.31.
La release 1.22.33 déduplique avant consolidation, lit seulement les tags utiles et exclut toute ancienne observation
supersédée du réservoir actif.
La release 1.22.34 mesure sans contenu privé la mémoire, le CPU, la boucle Node, les files et six opérations critiques
dans des fenêtres à cardinalité fixe ; `/runtime` expose le dernier snapshot dans une réponse Discord éphémère.
La release 1.22.35 plafonne et expire par LRU les caches Steam, BattleMetrics, WarBandits et OCR, puis libère les tails
de sérialisation OCR réglées sans altérer l'ordre des écritures.
La release 1.22.36 plafonne les hooks, cooldowns/avertissements du daemon et sélecteurs `/track` abandonnés ; les
longues concaténations d'identités deviennent des SHA-256 fixes.
La première conserve les identifiants de ligne TSV
Tesseract pour empêcher un pseudo /cinfo replié (U Got Kirkified) d’absorber Established, accepte la confusion l/I/1
uniquement dans l’ancre et garde une date illisible éditable avec Confirm désactivé. La seconde ajoute la
réconciliation partielle de pseudos partagée et la portée de wipe WarBandits. La troisième ajoute les corrections
d'identité privées Discord et sépare alias vérifiés/lectures OCR pending. La suivante borne les délais de réponse
Discord/traduction et la dernière fiabilise la sémantique des identités connues et des wipes WarBandits. La dernière
validation complète a passé 297/297 tests et tsc --noEmit ; le déploiement et la
nouvelle capture Discord restent à valider réellement.

Respecte les invariants métier : Established et les wipes sont en GMT ; chaque bloc /cinfo déduit son propre wipe ;
la date de capture Discord est ignorée ; ce calendrier mardi/vendredi 14:00 GMT ne vaut que pour WarBandits EU 5x
NoBPs ; F7 ne prouve jamais la présence ; aucune similarité floue ne doit inventer une identité ; les données et
dictionnaires persistants sous data/player-intelligence ne doivent jamais être supprimés.

Pour toute nouvelle modification de code ou de configuration runtime, incrémente le SemVer dans package.json et
package-lock.json, mets à jour MEMORY.md et les docs concernées, puis exécute npm.cmd test et git diff --check.
Après validation, committe la release et pousse systématiquement `master` sur `origin/master` afin que le serveur Linux
n'ait besoin que d'un `git pull`; si le push échoue, signale-le explicitement.
Commence par résumer l’état réellement observé, puis poursuis la nouvelle demande sans refaire l’étude depuis zéro.
```

## État Git et release en cours

- Dépôt : `rustplusplus-plugins`.
- Branche au moment de la passation : `master`.
- `HEAD`, `origin/master` et `origin/HEAD` étaient alignés sur `5917199`, release `1.22.35`, avant la release courante.
- Version canonique du worktree : `1.22.36` dans `package.json` et `package-lock.json`.
- Le commit `a3a71a8` contient la release `1.22.23`, notamment l’enrichissement prioritaire des SteamID texte et la
  métrique d’heures WarBandits.
- Le commit utilisateur `d327e7d` regroupe les releases `1.22.24` à `1.22.26`, notamment dans :

  - `src/plugins/playerIntelligence/tesseractOcr.js` ;
  - `src/plugins/playerIntelligence/ocrLayout.js` ;
  - `src/plugins/playerIntelligence/parseCinfo.js` ;
  - `src/plugins/playerIntelligence/cinfoPanelRefinement.js` ;
  - `src/plugins/playerIntelligence/cinfoRoles.js` ;
  - `src/plugins/playerIntelligence/detectImportKind.js` ;
  - `src/plugins/playerIntelligence/importWorkflow.js` ;
  - `src/plugins/playerIntelligence/runtime.js`, `src/plugins/playerIntelligence/identityAdministration.js`,
    `src/plugins/playerTracker/index.js` et
    `src/plugins/warBandits/index.js` ;
  - `src/util/playerNameReconciler.js` ;
  - `test/playerIntelligenceOcr.test.js` et `test/playerIntelligenceImport.test.js` ;
  - `test/playerIntelligenceRuntime.test.js`, `test/playerIntelligenceDiscord.test.js`,
    `test/playerTracker.test.js`, `test/warBandits.test.js` et `test/playerNameReconciler.test.js` ;
  - `src/commands/intel.js` ;
  - `package.json`, `package-lock.json`, `MEMORY.md`, `docs/commands.md` et `docs/installation.md` ;
  - le présent document, son lien dans `docs/documentation.md` et la mise à jour de l’étude player-intelligence.

- Le commit suivant `a308c0a` contient la release `1.22.27`, notamment dans :

  - `src/commands/intel.js` et `test/playerIntelligenceDiscord.test.js` ;
  - `src/plugins/autoTranslate/index.js`, `src/plugins/autoTranslate/translator.js` et leurs tests ;
  - `.env.example`, `README.md` et la documentation de démarrage Discord ;
  - `package.json`, `package-lock.json`, `MEMORY.md`, `docs/commands.md`, `docs/full_list_features.md` et ce document.

- La release `1.22.28` ajoute la résolution de wipes récents et le regroupement des alias pending, notamment dans :

  - `src/plugins/warBandits/index.js`, `src/plugins/playerIntelligence/importWorkflow.js`,
    `src/plugins/playerIntelligence/resolveCinfo.js` et `src/plugins/playerIntelligence/scanDaemon.js` ;
  - `src/plugins/playerIntelligence/identityAdministration.js` et `src/commands/intel.js` ;
  - les tests WarBandits, import, résolution, daemon, runtime et Discord associés ;
  - `package.json`, `package-lock.json`, `MEMORY.md` et les documentations player-intelligence/commandes/sources.

- La release `1.22.29` ajoute la consolidation locale unique et l'historique d'alias Steam, notamment dans :

  - `src/plugins/playerIntelligence/identityConsolidator.js`, `runtime.js`, `scanDaemon.js`, `identityProjector.js`,
    `importWorkflow.js` et `index.js` ;
  - `src/util/scrape.js` et `src/commands/intel.js` ;
  - les tests de consolidation, daemon, Steam et les documentations d'architecture/commandes/sources.

- La release `1.22.30` rend les lots SteamID texte idempotents et la file Steam équitable, notamment dans :

  - `src/plugins/playerIntelligence/importWorkflow.js`, `runtime.js` et `scanDaemon.js` ;
  - les tests Discord/import et daemon de player-intelligence ;
  - `package.json`, `package-lock.json`, `MEMORY.md`, `docs/commands.md`, `docs/full_list_features.md` et ce document.

- La release `1.22.31` supprime le chemin global des aperçus de listes SteamID, notamment dans :

  - `src/plugins/playerIntelligence/importWorkflow.js` et `runtime.js` ;
  - `test/playerIntelligenceImport.test.js` et la stabilisation temporelle de `test/reliableFcmReceiver.test.js` ;
  - `package.json`, `package-lock.json`, `MEMORY.md`, `docs/commands.md`, l'étude player-intelligence et le plan runtime.

- La release `1.22.32` prépare et indexe le consolidateur d'identité, notamment dans :

  - `src/plugins/playerIntelligence/identityConsolidator.js` ;
  - `test/playerIntelligenceConsolidator.test.js` et son oracle linéaire sous `test/fixtures/` ;
  - `benchmark/player-intelligence-consolidator.js`, le script npm associé et les documentations architecture/runtime.

- La release `1.22.33` déduplique les candidats avant consolidation, notamment dans :

  - `src/plugins/playerIntelligence/contracts.js`, `index.js`, `clanProjector.js` et `runtime.js` ;
  - `test/playerIntelligenceCandidates.test.js` ;
  - `benchmark/player-intelligence-candidates.js`, le script npm associé et les documentations architecture/runtime.

- La release `1.22.34` ajoute l'observabilité runtime bornée, notamment dans :

  - `src/util/runtimeTelemetry.js` et `src/commands/runtime.js` ;
  - l'instrumentation ciblée de traduction, OCR, imports et scan daemon ;
  - `test/runtimeTelemetry.test.js`, `test/runtimeCommand.test.js` et les tests de statut numérique des métiers ;
  - `.env.example`, `docs/installation.md`, les documents de commandes et le plan runtime.

- La release `1.22.35` borne les caches reconstructibles, notamment dans :

  - `src/util/boundedTtlCache.js` et `src/util/scrape.js` ;
  - les fournisseurs BattleMetrics et WarBandits ;
  - les documents et queues de sérialisation OCR correction/alias visuels ;
  - les tests d'expiration, d'éviction et de libération des queues ;
  - `docs/runtime_cache_inventory_2026-10-07.md` et le plan runtime.

- La release `1.22.36` borne les petits états dérivés, notamment dans :

  - `src/plugins/playerIntelligence/runtime.js` et `scanDaemon.js` ;
  - `src/plugins/playerTracker/index.js` ;
  - les tests runtime, daemon et player-tracker associés ;
  - l'inventaire et le plan des caches runtime.

- Il ne reste qu'une branche locale `master`. Les deux anciennes branches `origin/codex/*`, déjà entièrement intégrées,
  ont été supprimées ; le suivi de l'amont est limité à `upstream/master`, avec pruning automatique des références.

Ne déduis pas qu’un fichier absent de cette liste peut être écrasé : commence toujours par relire l’état Git réel.

## Dernière correction : release 1.22.36

Les états de hook sont plafonnés à 128 répertoires et expirent après 24 heures sans poll calme correspondant. Les
listes tracker/héritées triées sont réduites à deux SHA-256 fixes. Après expiration, le replay du journal ne crée
aucun nouvel événement. Les cooldowns de rescan et avertissements sont limités à 256, avec leurs frontières intactes.

Le player-tracker conserve au plus 1 024 sélecteurs complets pendant cinq minutes. Ensuite un avis minimal, sans
candidats, permet encore pendant 24 heures de répondre `Selection expired`; les deux enregistrements disparaissent
après un choix réussi. Le test de capacité insère 1 025 utilisateurs et observe exactement 1 024 entrées.

## Correction précédente : release 1.22.35

`boundedTtlCache` applique un TTL absolu non glissant et une éviction LRU après purge des expirés. Les plafonds sont
1 024 personas Steam, 1 024 identités Steam, 2 048 avertissements Steam, 256 réponses et 128 cooldowns BattleMetrics,
256 réponses WarBandits et 64 documents OCR. Toutes ces valeurs sont reconstructibles ; leur éviction ne supprime
aucune preuve. Les tailles, TTL et reports vers les lots 10/11 sont consignés dans l'inventaire des caches runtime.

Les queues par chemin de correction OCR et d'alias visuels suppriment leur Promise réglée seulement si elle reste la
tail courante. Une nouvelle écriture enchaînée garde ainsi l'exclusion mutuelle. Aucun fichier persistant n'est purgé.

## Correction précédente : release 1.22.34

`runtimeTelemetry` conserve une seule fenêtre courante et le dernier snapshot profondément immuable. Les opérations,
issues, buckets de durée et champs de sources sont fermés : aucune dimension libre, identité joueur, chaîne de message,
chemin ou token n'est accepté. RSS, heap V8, mémoire externe, CPU, utilisation/retard de boucle, tailles des files et
latences p95/max sont journalisés par fenêtre. Une source de métriques défaillante ne peut pas interrompre le bot.

`/runtime` appelle `deferReply({ ephemeral: true })` avant l'autorisation et toute lecture. Seul un administrateur voit
le dernier snapshot ; la commande ne lance ni scan ni collecte. Les spans traversant deux fenêtres exposent
explicitement leurs compteurs `started` et `completed`. La pression heap utilise la limite V8 et l'intervalle reste
borné à 10 s–5 min, configurable ou désactivable. La stabilité réelle doit encore être vérifiée sur Linux.

## Correction précédente : release 1.22.33

La vue globale utilisée par l'OCR agrège chaque triplet SteamID/BattleMetrics/nom avant consolidation. Elle combine la
fidélité de casse, unit les tags et ne consolide qu'une fois les événements identiques. `getKnownTags()` évite de
construire `playedWith` pour chaque personne. Les données live tracker/BattleMetrics/équipe sont toujours relues à
chaque appel ; alias Steam actuels/passés, BM-only pending et collisions de noms gardent leur sémantique.

Les observations supersédées sont désormais exclues via la primitive canonique `effectiveEvents`. Un événement déjà
validé est reconnu par un `WeakSet` et réutilisé comme objet profondément immuable ; une copie ou falsification repasse
par toute la validation. Le cache retient donc seulement un tableau filtré de références, pas une deuxième copie du
journal. Le benchmark de 20 000 événements/2 500 triplets mesure environ 307 ms à froid et 52 ms à chaud localement.

## Correction précédente : release 1.22.32

`prepareIdentityConsolidator()` normalise une fois le snapshot candidat, puis construit des index ordonnés SteamID,
BattleMetrics et nom exact fiable. `consolidateProjection()` le réutilise via un `WeakMap` uniquement pour les
projections profondément immuables de `Core.rebuild()` ; une projection mutable est recalculée et ne peut pas fournir
un résultat obsolète. Les couples conflictuels, homonymes, noms courts/non fiables et alias Steam passés gardent
strictement leur sémantique antérieure.

Un oracle linéaire figé de la 1.22.31 compare 1 920 observations générées plus les cas Unicode/NFKC, doublons,
conflits et ambiguïtés. Le benchmark local de 2 500 personnes/7 500 lignes mesure environ 38 ms de préparation,
4,8 MiB d'index et 0,011 ms par résolution préparée, contre 14,3 ms avec l'algorithme linéaire. Le gain synthétique
d'environ 1 280× doit encore être mesuré sur le journal et la charge réels.

## Correction précédente : release 1.22.31

Un lot texte de 1 à 100 SteamID utilise maintenant un résolveur ciblé. Il cherche seulement ces identifiants dans la
projection, conserve leurs alias vérifiés actuels/passés et leurs liens BattleMetrics connus, puis superpose les
données live uniquement lorsqu'elles ne contredisent pas les liens durables. Les fautes OCR et les BM conflictuels sont
exclus. Le nom affiché préfère le BattleMetrics live, puis le persona Steam courant vérifié.

Le test de régression envoie 100 SteamID et échoue explicitement si l'ancien résolveur global est appelé. Il couvre
aussi les alias passés, le persona courant, plusieurs BM déjà connus, un BM contradictoire et un nom OCR non fiable.
Cette correction vise la pile capturée sur le serveur avec environ 1,08 GiB de heap JavaScript. Elle doit encore être
mesurée après déploiement ; elle ne constitue pas une preuve de stabilisation mémoire générale. La suite est découpée
dans `docs/runtime_performance_reliability_plan_2026-10-07.md` et n'inclut pas de migration MySQL.

## Correction précédente : release 1.22.30

Rejouer exactement le même lot texte de SteamID ne passe plus par la logique de remplacement des captures OCR. Le
nouvel aperçu relit les noms et liens actuels depuis la projection locale ; sa confirmation conserve la preuve
append-only d'origine, n'ajoute aucun événement de supersession et ne propose jamais Replace/Keep. Les captures image
réinterprétées gardent, elles, ce choix explicite.

Le checkpoint du daemon distingue maintenant les profils Steam terminés des profils simplement tentés. Une réponse
Steam absente ou un historique d'alias partiel avance vers l'ID suivant au tick BattleMetrics suivant au lieu de
monopoliser la file. `!scanplayers` remet seulement les tentatives incomplètes en jeu ; les historiques déjà complets
restent acquis. La migration du sidecar `scan-daemon.json` vers le schéma 4 est non destructive.

## Correction précédente : release 1.22.29

Toute observation contenant un SteamID64, un BattleMetrics ID ou un pseudo exact traverse désormais la même frontière
locale avant journalisation. Elle consulte la projection existante, complète les champs manquants lorsqu'un identifiant
stable ou un unique nom exact fiable suffit, renvoie les correspondances/conflits/ambiguïtés et produit un événement
Steam+BM lorsqu'une liaison est prouvée. Les correspondances partielles/floues servent uniquement aux consultations ;
elles ne peuvent jamais écrire un lien. Une faute OCR non vérifiée, une collision de noms ou un couple stable
contradictoire reste pending ou manuel.

Le daemon utilise aussi le profil Steam Community lié au SteamID64. Une fois par SteamID et par wipe, à raison d'un
profil maximum par tick existant, il conserve le persona actuel comme `current` et les noms renvoyés par
`/ajaxaliases/` comme alias vérifiés `past`. Ces anciens noms n'effectuent aucune liaison exacte et ne peuvent jamais
remplacer le persona courant comme nom d'affichage. `/intel history` les étiquette explicitement. Cette collecte reste
hors du délai initial Discord et ne constitue jamais une preuve de présence.

## Correction précédente : release 1.22.28

`/intel pending` compte désormais les personnes séparément de leurs alias. Une identité BattleMetrics sans SteamID64
produit une seule ligne, avec son nom d'affichage courant et ses autres pseudos : `FUNTIK`, `gus` et `+=import&**`
partageant `BM:1192585926` valent donc une identité et trois alias. L'aperçu `/cinfo` réserve `linked to known
identities` aux cibles possédant réellement un identifiant et affiche `[BM]`, `[Steam]` ou `[Steam+BM]`. Une
correspondance name-only reste pending.

Le provider WarBandits valide et met en cache `/wipes/<serveur>`. Les vérifications OCR et les SteamID prioritaires
essaient `wipe=0`, puis l'intervalle numérique contenant ou le plus proche du GMT `Established` (le wipe terminé le
plus récent sans timestamp), et seulement ensuite `all-time` si aucun candidat n'est apparu. La première portée avec
des candidats arrête la chaîne ; une ambiguïté all-time reste manuelle. Les IDs sont opaques et sélectionnés par dates,
jamais calculés. Le 6 octobre, `8467` était l'intervalle immédiatement terminé (2 au 6 octobre) et `8398` l'intervalle
antérieur du 1er au 2 octobre. `FUNTIK` était absent de ces portées restreintes mais correspondait à quatre SteamID
all-time, donc aucune fusion automatique n'est permise.

Lorsqu'un SteamID importé produit au contraire une réponse WarBandits unique dont le nom exact correspond à une seule
identité BattleMetrics locale sans conflit, le daemon journalise le couple Steam+BM et fusionne les alias déjà portés
par ce BM. Un ancien lot déjà marqué comme traité peut être relancé après déploiement avec `!scanplayers`, qui remet à
zéro uniquement le checkpoint de priorités du wipe sans supprimer l'historique.

## Correction précédente : release 1.22.27

`/intel` accuse désormais réception auprès de Discord avec un `deferReply()` éphémère comme toute première opération,
avant les logs, le chargement de contexte ou la lecture du journal player-intelligence. Le traitement peut ensuite
prendre plus de trois secondes sans provoquer à lui seul `The application did not respond`. La commande reste réservée
aux administrateurs. Un bot hors ligne ne peut toutefois pas accuser réception : l'inspection locale du 6 octobre a
trouvé `TokenInvalid`, aucun processus Node actif et aucune variable locale `RPP_DISCORD_TOKEN`/
`RPP_DISCORD_CLIENT_ID`. Les commandes slash déjà enregistrées restent visibles dans Discord dans cet état.

AutoTranslate conserve l'ordre Google Web -> DeepLX (ou LibreTranslate) -> Bing Web -> MyMemory, mais chaque tentative
est maintenant bornée à deux secondes et toute la chaîne séquentielle à cinq secondes. Le relais du message original
reste immédiat et indépendant ; le relais traduit arrive plus tard ou est abandonné proprement à l'expiration du
budget. Les décisions `TRANSLATED`/`FAILED` journalisent `elapsedMs` pour mesurer la production sans exposer le texte.

## Correction précédente : release 1.22.26

La commande slash `/intel`, réservée aux administrateurs et toujours éphémère, expose la correction d'identité sans
polluer le chat Rust : `pending` liste les pseudos sans SteamID vérifié, `link` les associe directement, `merge` cible
un alias/SteamID/BattleMetrics ID vérifié, `history` affiche uniquement l'historique d'alias vérifiés, `links` audite
les règles actives et `unlink` les révoque. Chaque action reste append-only ; aucune capture ni donnée persistante n'est
réécrite ou supprimée.

`link`/`merge` consultent le persona Steam public courant et l'utilisent comme nom d'affichage le plus récent. Si Steam
est indisponible, seul un alias local déjà vérifié par Steam/API peut être réutilisé : aucune saisie manuelle ne peut
entrer dans l'historique vérifié. La projection distingue désormais les alias liés à un SteamID/API
stable des lectures OCR name-only. Une faute telle que `ChiCo` peut donc reprojeter les anciennes captures vers le
SteamID de `Ch1co`, additionner les occurrences entre captures et dédupliquer les deux formes dans une même capture,
sans faire apparaître `ChiCo` dans l'historique d'alias vérifiés ni dans les candidats OCR canoniques. La révocation
restaure la projection fondée uniquement sur les preuves d'origine.

La documentation canonique sépare maintenant les exemples de consultation avec le préfixe in-game (`!intel`, `!who`,
`!affinity`, `!activity`, `!track`) des opérations Discord-only (`/intel pending|merge|link|history|links|unlink` et
`/intelimport`). Elle précise notamment que `!record` exige un triplet exact prouvé et ne sert pas à promouvoir une
faute OCR : la correction `ChiCo` -> `Ch1co` doit rester privée, exacte et réversible via `/intel merge`.

## Correction précédente : release 1.22.25

`src/util/playerNameReconciler.js` fournit une frontière indépendante `pseudo/fragments -> cible`. Le mode `first`,
utilisé par `!intel`, `!steamid`, `!who`, `!affinity` et `!activity`, classe exact/canonique/préfixe/sous-chaîne et
retourne la cible la plus proche sans sélecteur ; `!intel tree` peut ainsi choisir `Cockornut Tree`. Cette résolution
est strictement en lecture et ne crée aucune preuve d’identité. Le mode `precise`, utilisé par le tracker et
WarBandits, conserve la priorité des profils en ligne et le sélecteur numéroté lorsque plusieurs meilleures cibles
restent possibles.

Le même composant accepte plusieurs fragments devant appartenir au même alias. L’API WarBandits ne les accepte pas en
tableau : le test live `KOH` + `PENG` du 6 octobre a renvoyé zéro pour les formes répétée, crochets, index, virgule et
JSON, alors que `player_name=KOH PENG` renvoyait `KOH PENG 🕷`. Toute future recherche OCR multi-fragments doit donc
faire des requêtes séparées bornées, exiger une forte confiance individuelle et réconcilier localement.

La recherche WarBandits du tracker utilise maintenant `wipe=0`. La corroboration OCR utilise `wipe=0` lorsque le GMT
`Established` du bloc dérive le wipe actif, sinon `all-time`; les caches sont séparés par portée. Cela évite le bruit
observé avec `peng` : un résultat sur le wipe courant contre dix en all-time.

## Correction antérieure : release 1.22.24

Le cas réel à reproduire était un panneau KIRK de trois joueurs :

```text
Jeffrey Kirkstein The 3rd
Rw
U Got Kirkified
Established: 10/03/2026 17:01:39
```

Le pipeline avait produit `U Got Established: ...`, puis `Established: unread`, parce qu’il supprimait les identifiants
de ligne fournis par le TSV Tesseract et reconstruisait les lignes uniquement par proximité verticale. Avec une police
serrée, deux boîtes de lignes différentes pouvaient fusionner.

Le correctif :

- conserve `page:block:paragraph:line` comme `lineKey` sur chaque mot Tesseract ;
- privilégie cette frontière native et n’utilise la géométrie qu’en secours pour les mots sans `lineKey` ;
- namespace les identifiants des OCR de crops avant de les recombiner avec un panneau afin d’éviter les collisions
  entre deux exécutions Tesseract ;
- sépare le préfixe roster d’une ancre `Established` accidentellement fusionnée ;
- tolère `l`, `I` ou `1` dans le mot-ancre seulement ;
- continue d’exiger exactement `MM/DD/YYYY HH:mm:ss` en GMT pour la valeur ;
- conserve un bloc avec date invalide dans le workflow si son compteur et son roster rendent le formulaire éditable ;
- affiche `Wipe pending`, laisse `Edit <tag>` disponible et bloque Confirm jusqu’à une correction valide ;
- recalcule le wipe et les identités après soumission du formulaire corrigé.

Résultat déterministe attendu pour cette capture : `3/3 names read`, `U Got Kirkified`, date
`10/03/2026 17:01:39`, puis le wipe propre à ce bloc. Une lecture qui reste incertaine doit proposer l’édition, jamais
inventer ni commiter silencieusement.

## Validation déjà effectuée

Le 7 octobre 2026, après la release 1.22.36 :

- `npm.cmd test` : `297/297` tests unitaires réussis ;
- `tsc --noEmit -p .` : réussi dans la même commande ;
- `git diff --check` : aucune erreur ;
- `npm.cmd run test:autotranslate:live` : réussi en 8,9 s pour six scénarios cumulés ; Bing a atteint sa borne de deux
  secondes et MyMemory a terminé ce fallback, contre environ 35 s avant la borne globale ;
- tests ajoutés : séparation de lignes malgré géométrie chevauchante, récupération du membre replié avec ancre
  `EstabIished`, workflow d’édition obligatoire d’une date illisible, reprojection réversible `ChiCo` -> `Ch1co`,
  agrégation inter-captures/déduplication intra-capture, séparation alias vérifiés/OCR pending, persona Steam courant,
  réponses Discord éphémères, historique filtré, révocation, accusé `/intel` avant tout travail, budget total de
  traduction, regroupement des alias BattleMetrics pending, liens `/cinfo` adossés à un identifiant et fallback de
  wipes WarBandits avec ambiguïté manuelle et jointure Steam/BM exacte non conflictuelle, consolidation locale unique,
  conflits/ambiguïtés fermés, alias Steam courants/passés vérifiés, cardinalité de télémétrie fermée,
  isolement des sources de métriques, spans inter-fenêtres, acquittement `/runtime` avant autorisation/lecture,
  expiration absolue/LRU et plafonds des caches Steam, BattleMetrics, WarBandits/OCR, des hooks, du daemon et des
  sélecteurs player-tracker.

Ces résultats ne prouvent ni le comportement du binaire Tesseract installé sur Linux, ni le téléchargement Discord, ni
les fournisseurs externes, ni le processus de déploiement.

## Carte d’architecture utile

### Import Discord et OCR

- `src/plugins/playerIntelligence/importWorkflow.js` : téléchargement validé, OCR multi-passes, aperçu,
  Edit/Confirm/Reject/Replace, files de décisions
  et commit atomique.
- `src/commands/intel.js` et `src/plugins/playerIntelligence/identityAdministration.js` : revue privée des pseudos sans
  SteamID, liaison/fusion append-only, persona Steam courant, historique vérifié, audit et révocation.
- `src/plugins/playerIntelligence/tesseractOcr.js` : processus local sérialisé, TSV, user words temporaires, délais et
  limites de sortie.
- `src/plugins/playerIntelligence/ocrLayout.js` : validation des mots, lignes natives/fallback géométrique et clusters
  relatifs.
- `src/plugins/playerIntelligence/parseCinfo.js` / `src/plugins/playerIntelligence/parseF7.js` : parsing sémantique
  strict sans coordonnées absolues.
- `src/plugins/playerIntelligence/cinfoPanelRefinement.js` / `src/plugins/playerIntelligence/f7RowRefinement.js` :
  crops relatifs bornés et lectures spécialisées.
- `src/plugins/playerIntelligence/cinfoRoles.js` : beige = membre, jaune vif = leader, bleu = modérateur, sinon
  `unknown`.
- `src/plugins/playerIntelligence/resolveCinfo.js` / `src/plugins/playerIntelligence/nameSimilarity.js` : résolution
  Unicode conservatrice et affectation globale un-à-un.
- `src/util/playerNameReconciler.js` : sélection pseudo/fragments réutilisable, `first` pour les consultations et
  `precise` pour les mutations de tracking.
- `src/plugins/playerIntelligence/visualAliasLibrary.js` et
  `src/plugins/playerIntelligence/ocrCorrectionMemory.js` : dictionnaires persistants séparés du code ; ils ne
  constituent pas à eux seuls une preuve d’identité.

### Journal, requêtes et daemon

- `src/plugins/playerIntelligence/historyStore.js` : journal JSONL mensuel, append sérialisé, corruption bloquante.
- `src/plugins/playerIntelligence/identityConsolidator.js` : frontière unique SteamID/BattleMetrics/pseudo exact vers
  une identité locale enrichie, préparée/indexée une fois par projection immuable ; aucune correspondance floue ne
  peut muter le journal.
- `src/plugins/playerIntelligence/runtime.js` et les projecteurs : reconstruction
  identité/clan/activité/présence/métriques.
- `src/plugins/playerIntelligence/scanDaemon.js` : une page WarBandits bornée par tick BattleMetrics existant, état
  reprenable, aucune seconde boucle de présence.
- `src/util/runtimeTelemetry.js` et `src/commands/runtime.js` : agrégats runtime bornés, logs sans contenu privé et
  consultation administrateur éphémère du dernier snapshot terminé.
- `!intel` est la vue complète ; `!steamid` est son alias exact ; `!who` expose les alias ; `!record` ajoute une liaison
  manuelle stricte ; `!scanplayers` force un passage borné en arrière-plan.

## Invariants métier à ne pas casser

- Le serveur concerné est actuellement **WarBandits EU 5x NoBPs**. Son calendrier régulier connu est mardi et vendredi
  à 14:00 GMT. Ne pas appliquer cette règle à un autre serveur.
- `Established` est une heure serveur GMT et l’unique ancre temporelle d’un `/cinfo`. La date/heure de capture ou
  d’upload Discord est sans effet.
- Chaque panneau d’une même image calcule son wipe indépendamment. Deux panneaux d’une image peuvent donc appartenir
  à des wipes différents.
- Les forced wipes et frontières intermédiaires sont volontairement ignorés pour ce calcul historique.
- Un snapshot `/cinfo` partiel peut être confirmé si tag, compteur et date sont structurellement valides. Les identités
  non résolues restent exclues des alias exacts et affinités jusqu’à une preuve ultérieure.
- F7 est une liste opaque de rencontres/auteurs de chat, pas une preuve de connexion actuelle.
- Un SteamID64 complet peut survivre sans nom sûr. Un ID partiel, ambigu ou hors plage doit être rejeté.
- Une similarité textuelle ou visuelle floue classe des hypothèses mais ne suffit pas à créer une identité définitive.
- Les rôles `/cinfo` viennent des couleurs relatives dans les boîtes prouvées. Ne jamais promouvoir une couleur
  illisible en leader.
- BattleMetrics Premium est la source de présence principale. Une panne vaut `unknown`, jamais une déconnexion.
- WarBandits enrichit identité et compteur d’heures mais ne prouve jamais la présence.

## Persistance, secrets et sécurité

Ne jamais supprimer ou réinitialiser les fichiers ignorés nécessaires à la continuité :

- `data/player-intelligence/<guild>/<battlemetricsServerId>/*.jsonl` ;
- `visual-alias-library.json` ;
- `ocr-correction-memory.json` ;
- `scan-daemon.json` ;
- les sidecars sous `data/warbandits/` et les trackers existants.

`rustplus.config.json`, `.env`, `credentials/` et les logs FCM peuvent contenir des secrets, SteamID, adresses serveur,
tokens et messages. Ils ne doivent jamais être commités, publiés ou recopiés en entier dans une réponse. L’override
local Brave dans `node_modules/@liamcottle/rustplus.js/cli/index.js` est non reproductible après réinstallation ; voir
`docs/credentials.md`.

## Vérifications de production encore ouvertes

1. Déployer/redémarrer `1.22.36`, vérifier le message `RUSTPLUS v1.22.36 OPERATIONAL`, puis rejouer le lot de 11
   SteamID. Mesurer temps de réponse, RSS et heap avant/après ; exiger les noms locaux connus et aucun Replace/Keep.
   Après une fenêtre, contrôler `/runtime`, `RUNTIME`, `RUNTIME_WORK` et les éventuels `RUNTIME_SLOW`, sans donnée joueur.
2. Sur Linux, vérifier `command -v tesseract` et `tesseract --list-langs`; `eng` doit être présent. Les tests utilisent
   des boîtes déterministes et ne remplacent pas ce contrôle.
3. Réimporter l’image KIRK originale dans le canal d’intelligence et exiger `U Got Kirkified` plus un `Established`
   séparé. Vérifier aussi que chaque ID pending est tenté à son tour malgré un profil Steam indisponible, puis contrôler
   l’enrichissement WarBandits, les heures comme borne basse et `!scanplayers` sans inférence de présence.
4. Le transport raid/Pair FCM reste non prouvé côté Facepunch malgré une authentification MCS acceptée. Suivre
   `docs/fcm_transport_audit_2026-09-23.md`; `!raidtest` ne valide que la sortie Rust chat.
5. Continuer à constituer un corpus de PNG originaux variés avant toute affirmation de précision OCR générale ou ajout
   d’un moteur multilingue/modèle synthétique.

Ne déploie, ne redémarre et ne contacte aucun service externe sans que la demande courante l’autorise.

## Routine de fin pour les prochaines modifications

Pour toute évolution de code ou de configuration runtime :

1. préserver les changements existants et modifier avec un patch ciblé ;
2. incrémenter le SemVer dans `package.json` et les deux occurrences racines de `package-lock.json` ;
3. mettre à jour `MEMORY.md` et la documentation utilisateur/architecture concernée ;
4. ajouter des tests déterministes couvrant la régression réelle ;
5. exécuter `npm.cmd test` puis `git diff --check` ;
6. créer le commit de release puis pousser automatiquement `master` vers `origin/master` ;
7. annoncer séparément ce qui est validé localement et ce qui reste à vérifier en production.

Une modification exclusivement documentaire ne nécessite pas de nouvelle version applicative.
