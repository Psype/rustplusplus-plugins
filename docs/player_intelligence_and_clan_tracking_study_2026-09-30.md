# Étude — historique global joueurs, clans et associations

Date de vérification initiale : 2026-09-30  
Dernière mise à jour : 2026-10-01  
Cible : bot RustPlusPlus standalone Linux, serveur WarBandits EU 5X NoBPs  
Contrainte : aucun accès administrateur WarBandits, RCON ou plugin serveur.

## Décision appliquée

Le plugin isolé `playerIntelligence` est distinct de la watchlist `playerTracker` et de la base CSV des langues. Sa
vérité canonique est un journal d'observations immuables ; les fiches joueurs, historiques de clans et classements
sont des projections reconstructibles.

Le premier apport clan est un import Discord ponctuel des captures produites par `/cinfo <tag>` : OCR local,
prévisualisation, confirmation humaine, puis commit durable et idempotent du snapshot. L'image fournie pour `BEHO` expose le tag,
un compteur de 8 membres, leurs pseudonymes et `Established: 09/29/2026 16:02:03`, mais aucun SteamID. Elle constitue
donc une observation de roster fournie par l'utilisateur à cet instant, pas une résolution automatique des personnes
ni une preuve serveur signée.

Le bot ne peut pas lire le chat global via Rust+. La voie pérenne et exhaustive serait un endpoint ou webhook
WarBandits en lecture seule. Sans coopération du serveur, les journaux, le presse-papiers et les démos client ne sont
que des expériences ponctuelles ; la capture/OCR manuelle est la solution la plus sûre.

## Sources disponibles

| Source | Informations utiles | Autorité / confiance | Limite principale |
|---|---|---|---|
| Capture `/cinfo` | tag, roster, rôles colorés, établissement et relations de clan affichées | observation utilisateur confirmée | noms seulement ; capture modifiable ; état valable au temps constaté |
| Capture du menu F7 | paire visuelle nom affiché / SteamID64 | candidat fort, corroborable par WarBandits | liste « récente » opaque, incluant rencontres et auteurs du global ; aucune présence prouvée |
| Steam Overlay « Personnes en jeu » | SteamID64 des joueurs signalés au client local sur le même serveur / rencontrés récemment | identité forte ; présence à qualifier expérimentalement | API Steamworks cliente seulement, délai de retrait non documenté ; aucune Web API équivalente |
| API publique WarBandits | SteamID64, nom, statistiques, serveur et wipe | forte pour une observation WarBandits datée | API privée non documentée, aucun SLA ni route clan trouvée |
| BattleMetrics Premium | présence, sessions, changements de nom, co-présence | meilleure présence externe actuellement disponible | listes censurées/profils name-based ; co-présence ≠ appartenance au clan |
| Rust+ équipe | SteamID64, nom, membres et leader de l'équipe du bot | autoritaire pour l'équipe visible | uniquement l'équipe du compte pairé |
| Rust+ clan | clan courant du compte pairé, SteamID64 des membres, rôles et dates | autoritaire pour son propre clan | aucun paramètre pour interroger un autre tag |
| Chat global Rust+ | aucune donnée | indisponible | aucun message/requête global-chat dans le protocole |
| Journal client | aucune donnée gameplay exploitable dans les fichiers vérifiés | exclu | décision finale : ignorer `Player.log`, aucun tailing/upload |
| Démo officielle | joueurs enregistrés et SteamID64 via `demo.playernames` | utile si le fait recherché est rejoué | chat et `/cinfo` non documentés ; format `.dem` non contractuel |
| RCON, RustRelay, plugin serveur | chat, SteamID, clans et événements structurés | autoritaire | nécessite WarBandits |

### WarBandits

Les routes publiques déjà utilisées par le site répondent sans authentification :

- [catalogue serveurs](https://api.warbandits.gg/servers) ;
- [wipes EU5X NoBPs](https://api.warbandits.gg/wipes/eu5xnobps) ;
- [statistiques du wipe courant](https://api.warbandits.gg/stats/eu5xnobps?limit=10&wipe=0&category_ID=1&sort_direction=DESC&page=1&sort_key=kills) ;
- [agrégats d'un joueur par serveur](https://api.warbandits.gg/stats/server/player/events?steam_64_ID=76561198718926765&events=kills%2Cdeaths).

Les résultats contiennent notamment `steam_64_ID`, nom, rang, temps de jeu et compteurs. Les IDs/dates de wipe
permettent d'empêcher le mélange de deux wipes. La recherche par `player_name` ou `steam_64_ID` peut enrichir un nom
issu de `/cinfo`, mais un homonyme ou un renommage doit conserver l'état `ambiguous`.

Les réponses observées annoncent une limite de 60 requêtes ; aucune documentation, OpenAPI, version stable ou SLA n'a
été trouvée. Aucun endpoint clan n'apparaît dans les bundles publics ciblés. Avant une ingestion périodique, demander
une autorisation écrite, un quota et un contrat de compatibilité. La [politique WarBandits](https://warbandits.gg/en/policies)
indique que l'exploitant collecte déjà Steam IDs, connexions entre identifiants, commandes, chat, connexions et
déconnexions : il détient donc la meilleure source pour un flux clan officiel.

La commande `/cinfo` existe dans plusieurs plugins Clans. Les APIs documentées côté serveur peuvent exposer clans,
membres SteamID64 et rôles, par exemple [uMod Clans](https://umod.org/index.php/plugins/clans). Cela ne prouve pas
le plugin exact employé par WarBandits et ces APIs ne sont pas appelables par un joueur externe.

### BattleMetrics

Conserver BattleMetrics comme source de sessions et de présence. Une page de
[sessions BattleMetrics](https://www.battlemetrics.com/players/1086043882/sessions) expose le filtrage temporel,
serveur et les joueurs présents au même moment aux abonnés appropriés. Cette co-présence est une relation
`co_presence`, jamais une preuve d'équipe ou d'appartenance au même clan.

La documentation actuelle précise que les sessions granulaires ont une rétention glissante de 12 mois, que les
profils non vérifiés peuvent être fondés uniquement sur le nom et que les listes cachées/censurées créent une
anonymisation fonctionnelle. Une archive locale est donc nécessaire pour comparer plusieurs années, mais elle doit
conserver cette incertitude. Voir [BattleMetrics — visibilité et rétention](https://learn.battlemetrics.com/article/44-what-can-i-do-to-hide-my-player-profile).

La recherche directe par SteamID64 est réservée aux propriétaires/administrateurs du serveur ayant fourni les données
([documentation BattleMetrics](https://learn.battlemetrics.com/article/54-how-can-i-search-for-a-player-by-steam64id)).
Un BattleMetrics Player ID name-based ne doit donc jamais être promu silencieusement en SteamID64.

### Rust+ et nouveau système de clans

Rust a ajouté en juillet 2026 un système natif de clans avec rôles, permissions et chat séparé
([Common Ground](https://rust.facepunch.com/news/common-ground/)). Le protocole Rust+ présent dans la dépendance locale
comprend `getClanInfo`, `getClanChat`, `clanChanged` et un `ClanInfo` contenant `clanId`, nom, création, créateur,
rôles et membres avec SteamID64, date d'entrée, dernière activité et état en ligne.

`getClanInfo` porte un corps vide : il retourne seulement le clan du joueur pairé. Il ne permet pas `/cinfo BEHO` à
distance si le compte n'appartient pas à BEHO. Le [schéma Rust+ public](https://github.com/liamcottle/rustplus.js/blob/master/rustplus.proto)
ne possède aucune lecture ou écriture du chat global ; il ne contient que les canaux équipe et clan. L'API clan est
donc une excellente source pour historiser **son propre clan**, pas un annuaire des clans adverses.

## Collecte depuis le PC

### Constat local

Le 2026-10-01, les journaux connus de ce poste sont :

- `C:\Users\Psype\AppData\LocalLow\Facepunch Studios LTD\Rust\Player.log` : 3 823 736 224 octets, dernière écriture
  le 2026-10-01 à 01:05:18 Europe/Paris ;
- `Player-prev.log` dans le même dossier : 160 093 412 730 octets, dernière écriture le 2026-06-26 ;
- `output_log.txt` dans ce dossier : absent.

Une recherche complète mais strictement ciblée dans le `Player.log` actuel n'a trouvé aucune occurrence de `cinfo`,
`ClanTag`, `Established`, `WarBandits Clans`, `BEHO` ou `FIND PLAYER`. La recherche antérieure dans le journal de
160 Go — désormais `Player-prev.log` après rotation — n'avait pas trouvé ces marqueurs non plus. Ne pas uploader ni
lire intégralement ces fichiers. À ce stade, aucune preuve ne montre que le panneau CUI `/cinfo` ou F7 est conservé en
texte dans les logs PC.

Le `Player.log` actuel n'est pas un journal de gameplay exploitable. Une recherche complète supplémentaire n'a trouvé
aucune ligne correspondant à une connexion serveur, `client.connect`, adresse/hostname, chat ou SteamID64. En revanche,
il contient plus de 11,6 millions de lignes répétitives liées aux AssetBundles/`LogWarning`. Son démarrage montre un
échec de chargement du root AssetBundle sous `C:\Windows\System32\Bundles\Bundles`, puis des fichiers de localisation
`engine*.json` introuvables. Il expose surtout chemin d'installation, GPU/driver et erreurs Unity : utile pour diagnostiquer
un lancement client défectueux, inutile comme source `playerIntelligence`, et impropre à un upload public.

Décision finale du 1er octobre : ignorer `Player.log` et ne développer ni tailing, ni upload, ni spike supplémentaire.
Unity accepte `-logFile`, mais cela ne crée pas les signaux absents ; le flux retenu est l'import visuel confirmé.

### Capture et OCR

Deux entrées peuvent alimenter exactement le même pipeline serveur :

- **Discord, voie principale** : envoi manuel de l'image dans un canal privé. L'implémentation actuelle utilise
  `/intelimport cinfo image:<fichier>` ou `/intelimport f7 image:<fichier>` dans le canal de commandes configuré. Le
  canal privé `intel-imports`, créé automatiquement, accepte aussi 1 à 10 images sans légende obligatoire. Le type est
  détecté par les ancres OCR ; un préfixe `cinfo` ou `f7` reste un indice strict facultatif pour toutes les pièces
  jointes. Plusieurs panneaux `/cinfo` empilés dans une image sont séparés par les répétitions de `ClanTag`, jamais par
  des coordonnées fixes, puis validés bloc par bloc avant une confirmation groupée ;
- **helper Windows facultatif** : capture partielle déclenchée par l'utilisateur, sans coordonnées fixes, puis envoi de
  l'image originale au même pipeline. Le helper capture et transporte seulement ; l'OCR, la validation, la fusion et
  le stockage restent autoritaires dans le bot Linux. Il ne réalise aucune capture continue et ne contourne jamais la
  confirmation. Il publie par un webhook limité au canal, dont l'ID doit être autorisé côté bot ; le secret reste sur
  le PC Windows.

Flux actuellement implémenté :

1. le joueur lance `/cinfo <tag>` ;
2. capture PNG originale avec `Win+Shift+S` ou Steam F12 ; Steam documente ce mécanisme
   [dans Steamworks](https://partner.steamgames.com/doc/features/screenshots?language=english) ;
3. attachement dans le canal Discord privé avec `/intelimport cinfo` ;
4. validation de taille/type, calcul du hash et OCR hors du processus Rust ;
5. réponse de prévisualisation : serveur, wipe, tag, date, compteur, membres et avertissements ;
6. confirmation humaine obligatoire ;
7. commit du snapshot avant l'accusé de réception Discord. Une panne Discord après commit ne l'annule pas.

La décision reste disponible trente minutes et demeure liée au demandeur, au canal, au serveur et au wipe. Si le hash
existe déjà, aucune écriture n'a lieu au premier clic : Discord compare la version effective précédente et la proposition,
puis exige `Replace previous` ou `Keep existing`. Le remplacement conserve l'heure et la position logique du constat,
supprime l'ancienne interprétation de toutes les projections et reconstruit identités, clans, affinités et compteurs sans
ajouter un snapshot visible. Il peut être répété ; un aperçu devenu obsolète échoue sans mutation.

L'OCR doit conserver Unicode, casse, espaces et ponctuation. Il doit détecter les retours de ligne, les pseudos avec
virgule et l'écart entre `Members: N` et le nombre de noms extraits. Une virgule ne peut pas être considérée comme un
séparateur infaillible. Le CLI Tesseract local retourne le TSV et ses positions ; sa précision et son coût CPU/mémoire
doivent être benchmarkés sur un corpus de vraies captures avant activation. Le modèle doit être local en production,
sans téléchargement implicite au runtime.

#### Retour réel et décision OCR du 1er octobre 2026

Le premier essai Discord réel sur une capture `/cinfo` d'environ 556×310 pixels contenant trois panneaux a démontré
que la passe Tesseract brute `eng`, PSM 6/11, n'est pas exploitable pour une transcription autoritaire. Elle a mélangé
ancres, dates et rosters, perdu des membres et attribué de faux rôles. Le rejet transactionnel a correctement empêché
tout commit, mais ce pipeline reste un prototype. Il est en outre incapable de couvrir correctement des pseudos
chinois, arabes ou composés de symboles avec le seul modèle anglais.

La décision initiale était de ne pas ajouter de formulaire de correction. Elle est remplacée le 1er octobre par un
fallback explicite : conserver l'extraction automatique et les slots provisoires, mais offrir `Edit <tag>` lorsqu'une
coquille reste visible. Depuis la version 1.22.12, la ligne 1 contient le ClanTag exact, la ligne 2 `Established` au
format `MM/DD/YYYY HH:mm:ss` GMT, puis chaque ligne restante contient un pseudo Unicode. Le compteur, l'unicité, le tag
et la date sont revalidés ; une date modifiée recalcule le wipe régulier avant le nouvel aperçu et le clic Confirm.

Le pipeline structuré reste sans coordonnées absolues :

1. détecter les panneaux et lignes sémantiques, puis recadrer chaque panneau relativement aux ancres ;
2. produire une variante locale bornée (agrandissement et masque des couleurs/luminances de l'UI Rust) sans inventer
   les détails absents de la capture originale, puis la comparer sémantiquement à la lecture brute ;
3. lire séparément les ancres anglaises, le compteur et la date avec modèles/alphabets contraints ;
4. benchmarker un moteur de scène multilingue local, en priorité PaddleOCR PP-OCRv5, pour les lignes de pseudos avec
   reconnaisseurs Latin, CJK, cyrillique et arabe ; Tesseract reste utile comme seconde lecture spécialisée ;
5. rendre une valeur définitive uniquement si les passes indépendantes convergent et si les contraintes du panneau
   sont satisfaites. Une divergence produit un slot provisoire ou non résolu, modifiable seulement par le fallback
   utilisateur explicite avant confirmation ;
6. pour F7, une passe dédiée conserve le gris atténué des SteamID lorsque les passes normales n'en lisent aucun. Deux
   substitutions OCR usuelles maximum sont réparables dans un candidat de 17 chiffres, puis sa plage SteamID64 et la
   proximité du pseudo majuscule avec le persona Steam/alias du même ID sont exigées. Une ligne incompatible est
   affichée puis exclue ; le persona exact devient le nom canonique, sans credential Steam ni clé Web API ;
7. pour `/cinfo`, classer les alias déjà connus par similarité textuelle, visuelle et contextuelle. Un candidat unique
   nettement séparé peut être lié automatiquement ; sinon conserver un slot provisoire avec ses hypothèses bornées et
   réévaluables. Le snapshot devient partiel sans perdre les membres déjà résolus ; l'édition reste facultative.

Depuis la version 1.22.5, l'aperçu Discord ne confond plus transcription et liaison : il affiche séparément le nombre
de noms OCR lus et le nombre d'identités liées. Pour un roster partiel, la ligne `OCR roster` conserve les noms dans
l'ordre observé, puis `Linked identities` liste uniquement les rattachements. Un nom simple comme `d.ve` peut donc être
correctement transcrit tout en restant en attente d'une identité stable. Les boutons Confirm/Reject et le contrat de
persistance ne changent pas.

État implémenté au 1er octobre : le résolveur textuel partagé collecte les alias du journal, des trackers,
BattleMetrics, de l'équipe Rust+ et des F7 du même lot. Il compare les graphèmes par Damerau-Levenshtein et bigrammes,
conserve les écritures exactes, pénalise les changements de script et effectue une affectation globale un-à-un. Les
pseudos de cinq caractères ou moins exigent des seuils et marges renforcés. L'historique du même ClanTag départage
seulement les candidats à score égal ; il ne suffit jamais à lever une collision. Une similarité floue seule reste
provisoire même au-dessus du seuil ; une écriture exacte/structurellement équivalente ou une corroboration externe
unique est nécessaire pour lier automatiquement. Une ambiguïté conserve au plus trois
hypothèses internes. Au plus trois requêtes par lot ciblent d'abord les SteamID probables, via le fournisseur
WarBandits déjà sérialisé/caché puis le nom public du profil Steam. Une corroboration externe unique peut lever une
collision ; deux réponses compatibles restent ambiguës. Aucun credential Steam ni clé Web API n'est requis.

Avant chaque OCR, ces alias persistants alimentent aussi un fichier UTF-8 Tesseract `--user-words`, limité et supprimé
après le processus. Pour chaque image, le bot produit une seule variante noir-sur-blanc agrandie, en conservant les
pixels texte neutres, jaunes/orange, verts et cyan/bleus puis en rejetant un ratio de premier plan pathologique. La
lecture masquée et la lecture brute sont toutes deux bornées et sérialisées ; la structure reconnue (ancres, blocs,
tag, compteur, date, roster ou SteamID complets) choisit déterministement la meilleure. Ce sont deux entrées OCR
indépendantes, pas des retries aveugles. Les boîtes de la variante agrandie sont ramenées à l'échelle originale avant
la lecture relative des couleurs de rôles.

Depuis la version 1.22.4, le choix brut/masqué est effectué panneau par panneau. Un panneau encore incomplet reçoit
une seule lecture PSM 6 d'un crop borné relativement entre `ClanTag` et `Established`; le résultat n'est accepté que
s'il conserve tag/compteur et améliore la structure. Une date encore invalide reçoit une lecture PSM 7 séparée avec
alphabet `0123456789/: `, puis passe le même validateur calendaire strict. Une panne de ce raffinement optionnel est
un avertissement et ne peut pas annuler une transaction serveur déjà valide.

Depuis la version 1.22.9, l'absence d'une ancre `Members` ou `Established` ne bloque plus ce raffinement. Le compteur
est recadré entre les lignes voisines `ClanTag` et `Clan Members`, y compris lorsque la première OCR n'a produit aucun
mot pour cette ligne ; la date est choisie relativement sous le roster. Un tag multi-mot suspect est relu dans sa
seule zone de valeur. Les lectures compteur/date utilisent PSM 7 et un alphabet numérique restreint, puis les mêmes
validateurs stricts. L'aperçu conserve aussi tous les noms OCR lus lorsque le compteur reste inconnu, distinctement
des identités déjà liées. Aucune coordonnée d'écran fixe n'est introduite.

Depuis la version 1.22.6, un roster complet reçoit aussi une lecture visuelle isolée par membre. Les virgules et le
`and` final reconnus dans la ligne servent de séparateurs relatifs ; les fragments d'un pseudo coupé sur deux lignes
sont recollés horizontalement, puis chaque membre occupe sa propre ligne d'une feuille temporaire noir-sur-blanc
agrandie 4x et plafonnée à 8 Mi pixels avant allocation. Une seule exécution PSM 6 traite cette feuille par panneau,
au lieu d'un processus par pseudo. Depuis 1.22.13, les pixels de virgule sont exclus et chaque ligne OCR est remappée
au slot vertical de la feuille plutôt qu'associée par ordre de sortie. Le résultat n'est accepté que si chaque slot est
présent une fois, si l'unicité correspond au compteur et si, à chaque index, les lettres/chiffres restent identiques ou
qu'une correction humaine persistante unique explique précisément l'écart. Cette passe peut donc rattacher les
décorations `』` au crop de `Marley` plutôt qu'à `Swizzy`, mais elle refuse un échange de noms ou une lettre inventée.
Si les séparateurs ne
produisent pas exactement le compteur attendu, le roster précédent est conservé. Aucune coordonnée écran fixe ni
pixel de cette feuille temporaire n'est persisté.

Depuis la version 1.22.7, un roster encore incomplet après la passe panneau reçoit une seule lecture PSM 6 du champ
`Clan Members` isolé entre ses ancres relatives. Le résultat n'est retenu que si le tag/compteur restent ceux du même
panneau et si la qualité structurelle augmente. Si `n444shj, spirit_monger19` reste par exemple fusionné en
`n444. spirit_monger19`, le bouton `Edit GenX` ouvre le cinfo courant : tag en première ligne, date en deuxième, puis
les huit pseudos uniques dans cet exemple. La soumission relance le résolveur, la corroboration bornée et l'inférence
du wipe, puis remplace uniquement l'aperçu en attente. Le journal et les dictionnaires restent intacts avant Confirm.

Les membres `/cinfo` déjà résolus et les lignes F7 nom/SteamID non ambiguës enrichissent enfin une mémoire visuelle
persistante par serveur sous
`data/player-intelligence/<guild>/<battlemetricsServerId>/visual-alias-library.json`. Elle stocke au plus 2 000
signatures binaires normalisées de formes de mots, quatre par alias/identité, jamais les pixels ni la capture brute.
Les crops viennent des boîtes OCR relatives au roster, sans position d'écran fixe. Un digest visuel strictement
identique peut corroborer l'identité ; une similarité approximative sert seulement à rappeler/prioriser le candidat et
reste insuffisante pour le lier. Deux identités ayant la même signature restent toutes deux candidates. Le sidecar est
validé, borné, écrit atomiquement et sa corruption est préservée ; sa panne après le commit canonique ne peut pas
annuler ce commit.

Depuis la version 1.22.3, le même sidecar journalise aussi jusqu'à 4 096 signatures
glyphe↔graphème Unicode, avec douze variantes maximum par graphème. L'apprentissage exige un alias `/cinfo` déjà
résolu, une graphie OCR strictement identique à l'alias et une séparation non ambiguë d'un segment visuel par graphème.
Une graphie liée, des lettres qui se touchent ou un découpage incohérent ne produisent aucun échantillon. Lors d'une
capture suivante, la séquence de glyphes rappelle et réordonne les alias visuels de même longueur, y compris avec des
graphèmes non latins séparables, mais reste une preuve de classement non corroborante. Seule une signature de mot
entier strictement identique peut conserver le statut visuel fort antérieur.

La version 1.22.4 corrige une contamination de frontière : l'index d'un pseudo dans un roster OCR partiel ne représente
pas sa position réelle dans le clan. L'extraction, la recherche visuelle, l'apprentissage de mots/glyphes et le vote
de rôle `/cinfo` exigent désormais le compteur complet et une partition unique, ordonnée et non chevauchante de toutes
les boîtes de pseudos. Ainsi la forme de `Marley` ne peut plus être attribuée au slot reconnu de `Swizzy`. Le sidecar
passe au schema 3 ; les fichiers schema 1/2 restent validés et préservés, mais leurs échantillons dérivés antérieurs à
cette preuve de frontière sont ignorés. Ils se reconstruisent sur les imports confirmés suivants, sans modifier les
événements canoniques de joueurs ou de clans. Même avec une partition prouvée, aucune signature de mot ni de glyphe
`/cinfo` n'est apprise si le résolveur a changé la graphie OCR. Enfin, un roster incomplet ne lie automatiquement que
les alias exacts après normalisation de casse : suppression des décorations, similarité floue et corroboration externe
restent provisoires tant que les frontières ne sont pas complètes.

La partition visuelle prouvée par la version 1.22.6 devient également la source des boîtes de vote de rôle et des
signatures de mot entier. Elle évite que la couleur bleue de `』 Marley 』` soit lue sur `Swizzy`. Les fragments recollés
ne permettent toutefois pas une correspondance sûre glyphe-par-graphème : ils ne nourrissent donc jamais le journal de
glyphes. L'échec ou le timeout de cette passe optionnelle ne bloque ni la prévisualisation ni le commit canonique.

Le sidecar passe au schema 4 pour ajouter un lexique borné à 2 000 noms OCR confirmés manuellement. Après le commit
canonique seulement, les lignes corrigées sont écrites atomiquement puis injectées dans le `--user-words` Tesseract
des captures suivantes. Elles ne constituent ni une preuve SteamID, ni une autorisation d'apprendre les pixels ou les
glyphes du crop ambigu. Les échantillons visuels/glyphes fiables du schema 3 migrent sans être invalidés.

La version 1.22.13 ajoute une mémoire de transcription distincte de la preuve d'identité dans
`ocr-correction-memory.json`. Après Confirm/Replace seulement, le cut de membre à frontière prouvée est relié au nom
Unicode corrigé, même sans SteamID. Au prochain import, un digest exact unique corrige ce même slot avant la résolution
d'identité ; l'approximation exige 0,985 et 0,03 de marge, et reste interdite aux noms courts. Les conflits ne corrigent
rien. Les corrections textuelles historiques peuvent réparer le cas périphérique séparé `1 Marley 4` → `』 Marley 』`,
mais jamais le vrai pseudo attaché `1Marley4`. Les virgules sont exclues des signatures et les lignes de la feuille OCR
sont réaffectées à leur slot vertical : une ligne absente ne décale plus Marley sur Swizzy. Le sidecar est borné à
2 000 templates/quatre par nom, atomique, validé et préservé s'il est corrompu ; il ne contient aucun pixel brut.

Le benchmark synthétique 1.22.13 mesure la recherche chaude de six membres dans 2 000 corrections à 0,325 ms de
médiane (maximum 0,626 ms), contre 37,602 ms de médiane avant cache/index, sans OCR supplémentaire.
Le benchmark synthétique dédié de la version 1.22.3 rappelle la cible parmi 2 000 alias, 104 variantes de glyphes et
une séquence de huit graphèmes en 20,797 ms de médiane. Le benchmark global 200 joueurs ne régresse pas entre les
mesures immédiatement avant/après (chargement initial 41,702→39,357 ms, poll silencieux 0,044→0,030 ms, dix
transitions 51,356→50,742 ms). Ces chiffres locaux valident le bornage, pas la précision sur captures réelles.

Le contrat `clan_snapshot` accepte désormais, sans casser les événements schema 1 existants, des membres résolus et
des slots `unresolvedMembers`. Une structure tag/compteur/date valide peut donc être confirmée malgré un roster
incomplet. Les slots ne créent ni alias exact, ni relation `Played with`; chaque reconstruction de la projection les
réévalue contre les nouvelles observations, y compris les noms F7 liés à un SteamID mais marqués non fidèles à la
casse. La confirmation Discord reste un clic transactionnel et non une transcription. Les lectures isolées du
tag/compteur, les lectures numériques indépendantes restantes et le moteur multilingue local restent à implémenter et
à mesurer sur des PNG originaux.

Les exemples F7 réels ajoutés le 1er octobre combinent décorations autour d'un nom latin, lettres volontairement
espacées, `İ` turc, caractères cyrilliques, coréens et chaînes visuellement ambiguës mélangeant potentiellement
plusieurs alphabets. Le pseudo F7 n'est donc pas canonique. Depuis 1.22.13, une variante visuelle dédiée est déclenchée
uniquement lorsque les passes normales reconnaissent F7 sans aucun SteamID ; elle conserve le gris atténué et agrandit
l'image dans la même limite de pixels. Le parseur accepte au plus deux substitutions OCR usuelles dans un candidat de
17 caractères, puis valide sa plage SteamID64. Le nom majuscule reste un contrôle : la ligne n'est conservée que si sa
similarité avec le persona Steam ou un alias déjà lié au même ID dépasse le seuil renforcé selon sa longueur. Le nom
canonique fournisseur remplace alors la casse OCR ; une incompatibilité ou une vérification indisponible exclut la
ligne avec avertissement. Aucun avatar n'est comparé visuellement et aucun credential Steam n'est requis.

Ces identités exactes enrichissent ensuite un dictionnaire de candidats commun à F7, `/cinfo`, chat et clans. Le roster
peut être reconnu de façon contrainte en comparant chaque segment visuel aux alias déjà connus et, si utile, à leur
rendu synthétique avec les polices Rust et leurs fallbacks. Les espaces, signes décoratifs et alphabets doivent rester
distincts : ne jamais assimiler automatiquement `O` latin, `О` cyrillique, `0`, ni supprimer ponctuation ou symboles.
Les [squelettes de caractères Unicode confusables](https://www.unicode.org/reports/tr39/) servent seulement à rappeler
des candidats, jamais à les fusionner ni à être affichés ou stockés comme pseudonymes normalisés.

Le score cible doit à terme combiner des mesures indépendantes : distance Damerau-Levenshtein pondérée par les erreurs
OCR réellement mesurées, similarité de graphèmes et n-grammes, script/direction, probabilité du reconnaisseur de scène,
comparaison entre le crop et un rendu synthétique de l'alias — une approche cohérente avec la recherche de
[reconnaissance guidée par dictionnaire visuel](https://arxiv.org/abs/2305.04524) —, récence sur le même serveur/wipe,
observation F7 récente, historique du tag et marge entre les deux meilleurs candidats. Les poids et seuils proviennent
du corpus de validation. Les seuils conservateurs actuels sont une base testée, pas une calibration OCR réelle. Les
priorités temporelles/clan restent faibles afin de permettre
recrutement, départ et scission sans verrouiller l'ancien roster.

La résolution porte sur le roster complet : construire une matrice slots/candidats puis résoudre une affectation
globale un-à-un avec une option `unresolved`. Cela empêche qu'un même joueur soit choisi pour deux graphies proches et
exploite le compteur déclaré sans forcer une mauvaise identité. Trois sorties sont distinctes : `resolved` avec score
et marge suffisants, `provisional` avec hypothèses classées, et `unresolved` sans candidat utile. Les deux dernières ne
polluent ni les alias exacts ni les affinités confirmées.

Un snapshot partiel conserve tag, date, compteur, membres résolus et slots provisoires. Il peut ajouter les relations
positives suffisamment fortes, mais ne prouve jamais l'absence ou le départ d'un membre. Lorsqu'un futur F7, une
réponse Steam/WarBandits ou un autre `/cinfo` apporte un alias/ID, la projection recalcule automatiquement les slots et
émet une liaison réversible ; aucune correction humaine ni nouvel upload n'est requis. Le schéma compatible mis en
place conserve le texte OCR brut et les hypothèses comme évidence interne, pas comme `exactName` ni comme membres
confirmés tant que le seuil de liaison n'est pas atteint.

Connaître la police aide à générer un corpus synthétique ou à affiner un reconnaisseur, mais n'est pas un paramètre
magique à fournir à Tesseract. Le [code officiel Facepunch](https://github.com/Facepunch/Rust.Community/blob/master/CommunityEntity.UI.cs)
utilise `RobotoCondensed-Bold.ttf` comme fonte CUI par
défaut. L'audit des bundles installés localement le 1er octobre 2026 retrouve `RobotoCondensed-Bold SDF` et ses
matériaux `Chat`, `PlayerName`, `Team List`, `Title` et `Outline` dans `content.bundle`, ainsi que le TTF embarqué dans
`textures.4.bundle`, ce qui rend cette fonte très probable pour `/cinfo`.
Le bundle contient cependant aussi Roboto Condensed Regular, Roboto Regular, Roboto Mono, Droid Sans Mono,
Permanent Marker, Press Start 2P, Poxel, Super Chiby, LCD, VCR OSD, Dripping, ainsi que les replis Noto Sans Arabic,
Noto Sans Hebrew, Noto Sans CJK chinois/japonais/coréen, Noto Emoji et Unifont 17. Un corpus synthétique devra donc reproduire
Roboto Condensed Bold SDF puis ces fallbacks, pas une fonte unique. Avant activation d'un modèle affiné,
constituer un corpus privé de captures originales et mesurer au minimum le rappel des ancres, l'exactitude complète des
SteamID64/dates/tags/rosters, le taux d'erreur caractère Unicode et les faux commits. Le critère de livraison est zéro
faux lien définitif sur le corpus de validation ; les états provisoires et non résolus permettent ensuite d'améliorer
le rappel sans abaisser ce garde-fou ni jeter tout le snapshot. En attendant ce corpus, le système ne doit pas être
présenté comme une transcription Unicode complète : sa sûreté vient aussi de ses slots partiels et de ses refus.

L'évolution recommandée est hybride et entièrement offline : affiner un reconnaisseur de séquences sur des lignes
synthétiques rendues avec la chaîne Roboto/Noto de Rust, ses tailles, contours, ombres, couleurs et compressions, puis
utiliser un atlas de glyphes comme seconde mesure et pour reclasser les alias déjà connus. Un atlas lettre par lettre
seul ne couvre pas correctement crénage, ligatures, signes combinants ni façonnage arabe contextuel. Les champs
numériques conservent leurs lectures contraintes indépendantes. L'objectif mesurable est une exactitude très élevée
sur le corpus réel et zéro faux lien définitif, pas une garantie théorique de 100 % lorsque la rasterisation a déjà
rendu deux caractères différents identiques au niveau des pixels.

### Menu de signalement F7

La capture fournie montre que chaque ligne du menu **Find Player** associe visuellement un pseudo à un SteamID64 de
17 chiffres. C'est une meilleure source d'identité que `/cinfo`, mais elle ne prouve ni l'appartenance à un clan, ni
la présence actuelle, ni l'exhaustivité de la liste. Le rendu transforme les pseudos latins en majuscules ; cette
chaîne ne doit donc pas être enregistrée comme un changement de nom fidèle à la casse Steam.

La liste est déroulante et son horizon « récent » n'est pas défini. Elle mélange au moins des joueurs rencontrés et des
auteurs vus dans le chat global. Une ligne F7 signifie uniquement « identité proposée par le menu F7 au temps du
constat » ; elle ne prouve ni proximité physique, ni connexion actuelle, ni dernière activité. L'icône verte copie bien
le SteamID exact, mais elle sert seulement de recours ciblé pour une ligne OCR ambiguë, pas de procédure manuelle pour
toute la liste.

Les captures supplémentaires du 1er octobre confirment trois colonnes et plusieurs pages de défilement. Une bordure
peut masquer le pseudo tout en laissant le SteamID64 complet visible en haut, ou tronquer une ligne en bas. Dans ce cas,
conserver au plus une observation SteamID-only ; ne jamais deviner ni relier un nom masqué. Un SteamID tronqué est
rejeté. Les pages qui se chevauchent sont dédupliquées par SteamID64 ; deux noms concurrents pour le même SteamID dans
un même lot rendent la liaison ambiguë au lieu de choisir arbitrairement.

Prévoir un import Discord distinct, par exemple `!playerimport`, avec ce traitement :

1. OCRiser l'image complète sans coordonnées, recadrage, résolution ou gabarit fixes ; détecter les blocs à partir des
   libellés et motifs du contenu, puis associer dans l'ordre de lecture un pseudo au SteamID de 17 chiffres de son bloc ;
2. accepter seulement un SteamID conforme au validateur existant et relire explicitement toute confusion OCR de
   chiffres ; aucune correction silencieuse de `O/0`, `I/1` ou `S/5` ;
3. conserver l'image/hash, le texte OCR brut et `caseFidelity: false`, mais ne pas ajouter le nom F7 majuscule à
   l'historique des alias exacts ;
4. afficher toutes les paires en prévisualisation, puis exiger une confirmation humaine avant commit ;
5. si la mise en page produit un ordre de lecture ambigu, ne rien associer automatiquement et demander la correction
   dans la prévisualisation ;
6. pour une ligne ambiguë seulement, utiliser l'icône F7 qui copie le SteamID exact et préférer cette valeur collée à
   sa lecture OCR.

La même règle vaut pour `/cinfo` : détecter sémantiquement `ClanTag`, `Members` et `Established`, sans dépendre de leur
position en pixels. Les boîtes retournées par l'OCR peuvent aider son propre regroupement dynamique, mais aucune
coordonnée absolue ne fait partie du contrat ni de la décision métier. Le bruit autour peut être ignoré après détection
des ancres ; il ne doit jamais servir à compléter une valeur manquante. Le rendu des glyphes apporte aussi le rôle :
jaune plus intense pour le chef, bleu pour un modérateur, couleur ordinaire pour un membre. Classifier la couleur
relativement au texte détecté, sans palette ni zone fixes, et demander confirmation si elle est incertaine.

Le décalage constaté de deux heures avec la France métropolitaine le 29 septembre 2026, alors en UTC+2, rend l'hypothèse
UTC probable pour `Established`. Conserver simultanément la chaîne brute, une interprétation UTC et
`timezoneConfidence: probable`; ne rendre l'UTC autoritaire qu'après une seconde vérification, idéalement après le
changement d'heure.

Après confirmation d'un import F7 ou `/cinfo`, le recroisement WarBandits est limité aux identités déjà reliées de
manière unique à un snapshot de clan confirmé. Il est donc indépendant de l'ordre des deux imports, sans requêter tous
les joueurs d'une capture F7. Réutiliser exclusivement l'adaptateur, la sérialisation, le cache et le cooldown
existants : dédupliquer les SteamID, ne lancer aucune rafale parallèle et réutiliser les résultats déjà chargés. Un
accord nom/SteamID case-foldé ajoute une corroboration `warbandits`; un nom différent signale un renommage possible ou
une erreur OCR et exige une revue, sans écraser aucune observation. Une absence, un timeout, un `429` ou un challenge
Cloudflare signifie `source_unavailable`, jamais « SteamID invalide », et ne doit pas annuler l'import déjà validé.

Une image Discord n'est ni signée par Rust ni infalsifiable. Sa confirmation garantit la qualité de transcription,
pas son authenticité serveur. Conserver sa provenance et son niveau `user-confirmed`; elle peut compléter une source
plus forte mais jamais l'écraser, créer un état en ligne ou révoquer une identité corroborée.

### Steam Overlay « Personnes en jeu »

L'API cliente officielle Steamworks expose deux ensembles distincts dans
[`ISteamFriends`](https://partner.steamgames.com/doc/api/isteamfriends) :

- `GetFriendCount(k_EFriendFlagOnGameServer)` puis `GetFriendByIndex`, projetés par
  `SteamFriends.GetFriendsOnGameServer()` dans Facepunch.Steamworks ;
- `GetCoplayFriendCount`, `GetCoplayFriend`, `GetFriendCoplayTime` et `GetFriendCoplayGame`, projetés par
  `SteamFriends.GetPlayedWith()`.

Ils fournissent des SteamID64 exacts depuis le contexte du client Steam local. En revanche, Steam ne documente ni la
cadence d'actualisation, ni l'expiration, ni le retrait après déconnexion ; la fenêtre fournie décrit elle-même des
personnes avec qui le joueur a joué « récemment ». La colonne `Maintenant` n'est donc pas encore une preuve de présence
instantanée. Jusqu'au test de départ/reconnexion, journaliser au plus `observed_on_game_server`, jamais `online`, et une
absence/panne comme `unknown`, jamais `offline`.

L'observation utilisateur — ajouts/retraits efficaces en temps réel avec profil, nom et avatar — concorde plus
précisément avec la source locale `k_EFriendFlagOnGameServer = 0x10`, définie par Valve comme les utilisateurs sur le
même serveur et alimentée par `SetPlayedWith`. `GetFriendCountFromSource(gameServerSteamID)` et
`GetFriendFromSourceByIndex` offrent une autre vue du même cache local. Le test doit désormais mesurer le délai exact
de retrait plutôt que remettre en cause l'existence de cette liste courante.

Il n'existe pas de Web API officielle documentée pour cette liste :
[`GetRecentlyPlayedGames`](https://partner.steamgames.com/doc/webapi/iplayerservice) renvoie des jeux, et
[`GetFriendList`](https://partner.steamgames.com/doc/webapi/isteamuser) des contacts. Un compte Steam ouvert sur le bot
Linux n'hériterait pas des rencontres de la session Rust jouée sur le PC. Cette voie exigerait en plus des secrets et
Steam Guard sans résoudre le problème ; elle est exclue.

Piste prioritaire : test manuel et ponctuel de l'API cliente pendant Rust ; le fichier
`Steam/config/coplay_<SteamID64>.vdf` ne sert que de comparaison passive et ne remplace pas la source courante de
l'Overlay. Mesurer la liste avant et après le départ d'un joueur à 10, 30, 60, 120 et 300 secondes, puis après
reconnexion, changement de serveur et fermeture du jeu. Aucun appel à `SetPlayedWith`, aucune injection et aucun
polling permanent. Si le comportement est validé, un compagnon Windows séparé pourra produire des snapshots signés
`{server, observedAtUtc, steamId64, name}` vers le bot Linux, sans exporter aucun credential Steam : il réutilise la
session du client Steam local déjà ouverte. Seule la sonde ASF facultative nécessite une authentification Steam.

#### Audit SteamKit2 / ArchiSteamFarm (1er octobre 2026)

L'audit de [SteamKit2](https://github.com/SteamRE/SteamKit) et
[ArchiSteamFarm](https://github.com/JustArchiNET/ArchiSteamFarm) ne trouve aucun appel CM équivalent à
`GetFriendCount(k_EFriendFlagOnGameServer)` permettant de découvrir les inconnus du serveur depuis un bot distant :

- `SteamFriends.RequestFriendInfo()` envoie `CMsgClientRequestFriendData` pour des SteamID déjà connus ;
- `CMsgClientFriendsList` porte amis/clans et relations, sans `EFriendFlags`, source ni roster ;
- `CMsgClientPersonaState.Friend` peut enrichir un SteamID déjà livré avec nom, AppID, IP/port serveur,
  `steamid_source`, lobby et rich presence, mais n'énumère pas la source ;
- `ClientGetFriendsWhoPlayGame` et `Player.GetFriendsGameplayInfo#1` ne concernent que les amis ;
- `CMsgGSPlayerList` contient des SteamID mais va du game server vers Steam, pas vers un client utilisateur ;
- `play 252490` dans ASF signale seulement `CMsgClientGamesPlayed` et n'émule ni Rust, ni l'auth serveur, ni le roster.

Repères vérifiés :
[SteamKit `RequestFriendInfo`](https://github.com/SteamRE/SteamKit/blob/84c990c3982eedb5abd733116b987c9870a0dccb/SteamKit2/SteamKit2/Steam/Handlers/SteamFriends/SteamFriends.cs#L534-L563),
[`CMsgClientFriendsList`](https://github.com/SteamTracking/Protobufs/blob/244135e687ad0d0163228cb2ed3743b1264aa504/steam/steammessages_clientserver_friends.proto#L42-L53),
[`PersonaState`](https://github.com/SteamTracking/Protobufs/blob/244135e687ad0d0163228cb2ed3743b1264aa504/steam/steammessages_clientserver_friends.proto#L113-L170),
[`CMsgGSPlayerList`](https://github.com/SteamTracking/Protobufs/blob/244135e687ad0d0163228cb2ed3743b1264aa504/steam/steammessages_clientserver_gameservers.proto#L24-L40) et
[ASF `CMsgClientGamesPlayed`](https://github.com/JustArchiNET/ArchiSteamFarm/blob/d8b4abbe345260c68163cb24fdfff7a62917de3f/ArchiSteamFarm/Steam/Integration/ArchiHandler.cs#L951-L1005).

Un plugin ASF `IBotSteamClient` peut écouter passivement les `PersonaStateCallback`. C'est un banc d'essai utile sur
le **même compte**, farming suspendu et sans commande `play`, pour vérifier si Valve réplique exceptionnellement la
source locale vers une seconde connexion CM. Le résultat attendu reste négatif : un compte distinct ne possède pas la
source `OnGameServer`, et une seconde connexion du même compte peut ne recevoir que self/amis/IDs déjà suivis. Le test
doit comparer SteamID, nom, AppID `252490`, `SourceSteamID`, IP serveur et retraits à 10/30/60/120 secondes. Ne jamais
requêter une plage d'IDs. Un refresh token/Steam Guard serait requis pour la session ASF et doit être traité comme un
mot de passe ; une collision de `LoginID` peut remplacer la session. Cette sonde ne devient pas une dépendance de
production sans preuve de découverte complète et retrait déterministe.

Pour relier un membre `/cinfo` à une ligne F7, construire uniquement une clé de rapprochement avec normalisation
Unicode NFKC puis case-fold Unicode. Ne retirer ni ponctuation, ni espaces internes, ni tag supposé. Une liaison peut
être proposée si la clé est identique, qu'un seul SteamID candidat existe sur le même serveur/wipe et dans une fenêtre
temporelle affichée, et que les deux imports ont été confirmés. Elle reste `verified-by-user`, réversible et accompagnée
des deux preuves. Zéro ou plusieurs candidats donnent `ambiguous` et n'entraînent aucune fusion.

### Chat global continu

Le bot Linux ne peut pas le recevoir via Rust+. Une capture vidéo/écran suivie d'OCR est techniquement possible mais
elle créerait un collecteur client continu, fragile et difficile à relier aux SteamID64. Les
[conditions Facepunch](https://facepunch.com/legal/tos/) interdisent notamment bots, scripts, automation et outils
d'extraction interagissant avec les services. Ne pas déployer de macro, client AFK automatisé, PCAP/MITM, injection,
lecture mémoire ou mod client. Un collecteur continu exige au minimum un accord écrit Facepunch/WarBandits.

Pour quelques messages importants, la fonction native `Copy Text` du chat, les captures manuelles ou un extrait de
journal **préalablement validé** suffisent. Le contenu brut du chat ne doit pas être conservé par défaut : enregistrer
l'auteur affiché, l'heure, le canal, le fait dérivé et une référence de preuve limitée.

## Modèle d'identité réversible

### Règles de liaison

- `SteamID64` validé : identité forte `person:steam:<id>`.
- BattleMetrics ID avec SteamID validé : liaison fournisseur forte.
- Pseudo strictement identique sans SteamID : continuité d'affichage `probable`, jamais fusion destructive.
- Deux SteamID ayant porté le même pseudo, deux observations simultanées ou un conflit fournisseur : `ambiguous`.
- Confirmation humaine : événement de liaison audité, réversible.
- Les faits bruts ne sont jamais déplacés ou réécrits après une liaison ; seule la projection agrégée change.

Cela permet bien de « combiner les états » d'un pseudo puis d'un SteamID : la fiche peut agréger visuellement les
observations name-only tant qu'elle affiche `probable` et leur provenance. Si un homonyme apparaît, le lien est révoqué
ou scindé sans perte de données.

La normalisation Unicode/casse sert à la recherche. Pour une liaison automatique candidate, conserver la chaîne exacte
après suppression des seuls caractères de contrôle ; ne jamais retirer arbitrairement un préfixe supposé être un tag.

Le modèle interne conserve `personId`, références fournisseurs, provenance et confiance afin de résoudre les conflits,
mais ces métadonnées sont du diagnostic et ne sont jamais projetées dans le chat in-game.

La sortie in-game utilise une liste blanche : pseudo courant, SteamID64, BattleMetrics player ID, état récent seulement
s'il est fiable, ClanTags connus et joueurs associés. Un champ indisponible est omis plutôt que remplacé par une longue
explication. Aucun lien de profil Steam/BattleMetrics, ID interne, référence WarBandits, provenance ou niveau de
confiance. Les alias et dates détaillés restent accessibles par une commande d'historique distincte.

Ne jamais fabriquer un ID à partir d'un pseudo. Les identifiants sensibles de configuration, tokens et credentials ne
font partie d'aucune projection.

### Contrat d'observation immuable

| Champ | Contenu |
|---|---|
| identité | `eventId`, `schemaVersion`, `kind` |
| temps | `observedAt`, `recordedAt` |
| scope | guild, serveur stable, endpoint/slug, `wipeId` nullable |
| références | SteamID64, BattleMetrics ID, WarBandits ID ou exact-name |
| payload | uniquement le fait observé : nom, état, session, équipe, clan, etc. |
| provenance | source, ID source, version collecteur |
| confiance | `authoritative`, `verified`, `probable`, `ambiguous`, `untrusted` |
| preuve | hash, référence privée et éventuelle expiration |

Les DTO validés aux frontières sont profondément immuables. La déduplication utilise une clé déterministe incluant
source, scope, ID/horodatage source et type d'événement.

Décision de déploiement 1.22.13 : aucune date de capture n'est utilisée. Pour ce serveur, chaque panneau `/cinfo` est
traité comme une capture indépendante ; son propre `Established` détermine son wipe régulier et sert d'ancre temporelle
persistée. Plusieurs panneaux d'une même image peuvent donc viser des wipes différents sans rejet global. Le hash de
preuve et la date d'import restent distincts.

Toutes les captures `/cinfo` déposées sont supposées provenir du serveur actuellement configuré ; aucun sélecteur de
serveur n'est nécessaire. Elles peuvent appartenir au wipe courant ou à un wipe antérieur. Le champ `Established`
représente la création de cette instance du clan ; conformément à la décision ci-dessus, il est aussi l'unique ancre
disponible pour le backfill et remplit `observedAt` dans cette source.

L'heure `Established` affichée par WarBandits et les frontières de wipe sont interprétées
directement en GMT/UTC. Par exemple, le 29 septembre 2026, le wipe régulier est à 14:00 GMT : `Established: 14:58`
signifie donc une création du clan 58 minutes après le wipe. Aucune conversion en heure française n'est appliquée.

Depuis la version 1.22.13, le moteur déduit pour chaque bloc, indépendamment, la dernière frontière régulière
mardi/vendredi 14:00 GMT à partir de son `Established` et l'affiche avant confirmation. Il ignore les forced wipes, les
frontières intermédiaires, les légendes, l'heure d'upload et toute date de capture. Des blocs visant plusieurs wipes
peuvent être envoyés et confirmés ensemble.

## Wipes, clans et associations de joueurs

- Le wipe est une entité explicite liée au serveur. Utiliser en priorité l'ID WarBandits et ses dates, corroborés par
  BattleMetrics/A2S/Rust+. Une modification de date est une nouvelle observation, pas une réécriture silencieuse.
- Uniquement sur le serveur actuellement configuré **WarBandits EU 5x NoBPs**, les wipes réguliers ont lieu chaque
  mardi et vendredi à 14:00 GMT. Cette cadence ne doit jamais être généralisée à un autre serveur WarBandits. Pour le
  backfill `/cinfo`, les forced wipes et autres frontières intermédiaires sont ignorés : le scope est toujours la
  dernière frontière régulière à ou avant le `Established` propre à chaque bloc. Tous les calculs restent en GMT.
- Une instance de clan utilise un ID interne et la clé candidate
  `{serverKey, wipeId, tagExact, establishedAt?}`. Un même tag recréé pendant le wipe avec un autre `Established` est
  une nouvelle instance. Avec `clanId` natif, le conserver sans supposer sa persistance après wipe.
- Chaque nouvelle capture `/cinfo` confirmée crée un `clan_snapshot` daté : roster, compteur, rôles et complétude.
  Une correction confirmée du même hash remplace toutefois son interprétation effective à la même place logique, sauf
  si un `Established` corrigé la rattache explicitement à un autre wipe régulier : elle
  ne crée pas un constat ni un compteur supplémentaire, et ses liens sont entièrement reconstruits.
- Un joueur peut rejoindre, quitter, changer de clan ou de rôle pendant un wipe. Deux snapshots complets bornent le
  changement entre `lastObservedPresentAt` et `firstObservedAbsentAt`; ils ne donnent pas son heure exacte. Un snapshot
  incomplet ajoute des présences mais ne permet jamais de conclure à un départ.
- Le même tag sur trois wipes produit `recurrenceWipes = 3`, mais pas automatiquement « même organisation ».
- Calculer séparément une continuité probable à partir des membres SteamID64 communs, avec couverture et provenance.
- L'appartenance au même clan moddé est une association explicite `clan_membership`. BattleMetrics co-play, équipe
  Rust+, conversation ou absence de kills restent `association_observed` et ne deviennent pas un membership.
- Les liens entre joueurs sont dérivés des snapshots partagés : nombre de wipes/clans communs, première et dernière
  co-appartenance constatée, rôles et couverture. Ne pas dupliquer dans le journal toutes les paires en O(n²).

Pour l'affichage compact, l'affinité est un nombre de constats `/cinfo` confirmés et distincts :

- `knownTagCount(tag)` : snapshots où la personne est membre de ce ClanTag ;
- `playedWithCount(person)` : snapshots où les deux identités sont membres du même ClanTag.

Un même hash importé deux fois ne compte qu'une fois. Son remplacement explicite modifie son contenu effectif sans
modifier ce compteur. Deux captures réellement distinctes prises à des moments
différents comptent chacune, même si le roster est inchangé. Ce `x` mesure donc les co-appartenances **observées**, pas
un nombre de sessions de jeu. BattleMetrics co-presence ne l'incrémente jamais.

Après la ligne d'identité, l'affinité in-game est limitée à deux lignes triées par compteur décroissant :

```text
Alice | Steam:7656119... | BM:123456 | on
Known tags: BOBR 10x, BALLS 8x
Played with: Pierre 10x, Paul 5x, Joe 2x
```

Les IDs sont complets en production ; les points de suspension ci-dessus servent uniquement à raccourcir l'exemple.
Omettre `Steam`, `BM` ou l'état lorsqu'ils sont indisponibles/non fiables.

Utiliser l'anglais correct `Played with`. Ajouter des entrées tant que la limite du message le permet, puis terminer
par `+N` pour les résultats restants. Les wipes, intervalles, dates et preuves restent consultables dans la vue Discord
détaillée mais ne figurent pas dans les messages in-game.

Une scission peut être projetée comme `roster_split_candidate` lorsqu'un ancien roster se retrouve ensuite réparti
entre plusieurs clans, avec les membres communs, les dates, le wipe et la couverture. Ne jamais attribuer la cause à un
litige sans source explicite : la base observe une partition de roster, pas l'événement social qui l'a provoquée.

### Plages hebdomadaires de présence

Préserver dès le socle les transitions et sessions nécessaires à une future vue des habitudes de jeu sur **ce
serveur**. `playerTracker` et BattleMetrics alimentent des observations `online`, `offline` ou `unknown` avec source,
début, fin et précision. Une panne fournisseur ouvre une plage `unknown` et ne clôt jamais artificiellement une
session. Les sessions recouvrantes provenant du même fait sont dédupliquées ; deux fournisseurs restent deux preuves,
pas deux durées additionnées.

La projection hebdomadaire agrégera, dans des créneaux configurables, au minimum : minutes observées en ligne, minutes
couvertes, couverture, nombre de semaines/sessions et fenêtre de données. Stockage en UTC ; affichage dans le fuseau
configuré, par défaut `Europe/Paris`, avec gestion des changements d'heure. Elle pourra afficher par exemple « lundi
19:00–23:30 souvent observé sur WarBandits », mais jamais « ne joue pas » durant une période non couverte, avant le
début du tracking, ou sur les autres serveurs Rust.

Deux scopes seulement :

- `1mo` : fenêtre glissante des 30 derniers jours, valeur par défaut ;
- `all` : toutes les observations locales conservées pour cette personne.

Les scopes `current`, `week`, `4w` et `wipe` sont supprimés. Les wipes restent pertinents pour les clans, pas pour les
habitudes horaires puisque le serveur en effectue deux par semaine. Cette vue ne répète pas le clan visible avec
`/cinfo` : elle résume uniquement les plages de présence issues du tracking. `all` signifie « all time local » et ne
couvre pas une période antérieure au premier constat. Afficher la plage de dates et refuser toute conclusion sous un
seuil de couverture à définir sur les données réelles.

Le classement `!clantop` doit trier d'abord par nombre de wipes distincts observés, puis par couverture/membres
vérifiés. Compter les lignes ou polls favoriserait artificiellement les clans davantage échantillonnés. Toujours
afficher « clans observés », car les `/cinfo` choisis manuellement ne couvrent pas exhaustivement le serveur.

## Architecture dans ce dépôt

### Séparation des responsabilités

Créer `src/plugins/playerIntelligence/` derrière `pluginManager.js` :

- `contracts` : validation stricte et sorties gelées ;
- `store` : journal append-only, verrouillage par scope, écritures durables ;
- `identityResolver` : liens réversibles et ambiguïtés ;
- `wipeProjector`, `clanProjector` et futur `activityProjector` ;
- `queryService` et commandes ;
- adaptateurs BattleMetrics, Rust+ team/clan, WarBandits, import manuel et futur log validé.

La fusion est une projection de lecture, jamais une réécriture des sources. Un `personId` interne agrège des références
versionnées : SteamID64, BattleMetrics player ID, WarBandits ID, alias, appartenances et rôles. La jointure est forte
quand F7 et `playerTracker`/la base membres portent le même SteamID64 ; avec seulement un nom ou un BattleMetrics ID
non relié, elle reste `probable` jusqu'à corroboration. Les bases existantes restent indépendantes et réutilisables.

Ne pas transformer :

- `playerTracker` en archive : sa projection ne contient que les joueurs encore suivis ;
- `teammateLanguageDatabase` en graphe : son CSV est limité aux identités/langues avec SteamID ;
- `instances/*.json` en base volumineuse ;
- les sidecars WarBandits en journal canonique.

Le plugin consomme le poll BattleMetrics existant via un hook d'observation ; aucun second poller. Il journalise les
changements et frontières de wipe valides, pas 200 états identiques chaque minute. Une panne fournisseur produit une
observation `unknown`, jamais des déconnexions synthétiques.

### Stockage

Définir d'abord une interface `HistoryStore`.

- Pilote : JSONL append-only mensuel sous `data/player-intelligence/<guild>/<battlemetricsServerId>/`, avec projections
  reconstruites depuis le journal. Aucune dépendance Node native.
- Volume confirmé : SQLite indexé. Le runtime Node 18 ne fournit pas `node:sqlite`; `better-sqlite3` introduirait une
  dépendance native à valider sur Linux/CI et à benchmarker avant adoption.

L'ancien CSV, les projections tracker et les sidecars WarBandits peuvent être importés une seule fois avec une source
`legacy-*`, sans modifier ni supprimer les originaux. Ensuite, des adaptateurs en lecture et les hooks existants
alimentent la projection centrale : aucune recollecte d'une paire SteamID/BattleMetrics déjà validée.

### Commandes implémentées

- `!intel <SteamID64|BattleMetrics ID|pseudo exact>` : identité utile, état fiable, `Known tags`, `Played with` ;
- `!affinity <...>` : uniquement les deux lignes compactes d'affinité ;
- `!activity <...> [1mo|all]` : durée connue en ligne, `1mo` par défaut, plages `unknown` exclues ;
- `!clan <tag>`, `!clanhistory <tag>` et `!clantop [1-10]` : observations confirmées locales ;
- Discord seulement : `/intelimport cinfo image:<fichier>` et `/intelimport f7 image:<fichier>`, avec aperçu éphémère,
  décision liée au demandeur/canal/serveur/wipe pendant trente minutes et prompt ancien/nouveau pour conserver ou
  remplacer un hash déjà importé.

L'historique détaillé des alias et les commandes manuelles de liaison/révocation restent différés : ces métadonnées
existent dans le journal mais ne sont pas exposées dans le chat in-game.

`!track`/`!untrack` restent la watchlist de présence. Retirer une alerte ne supprime jamais l'histoire.

## Informations encore utiles avant calibration OCR

Aucun de ces points ne bloque le journal, les requêtes ou le flux de confirmation. Ils restent nécessaires avant de
considérer l'OCR calibré pour les captures réelles :

- un corpus d'environ 10 à 20 PNG originaux de chaque écran, couvrant résolutions/UI scales, colonnes, scroll, lignes
  coupées, Unicode et pseudos ponctués ; inclure quelques joueurs présents à la fois dans F7 et `/cinfo` ;
- vérifier l'hypothèse UTC de `/cinfo Established` avec une seconde date, idéalement après le changement d'heure ;
- définir la durée de conservation des PNG. Recommandation : canal privé, accès restreint, puis suppression planifiée
  de l'image après validation si le hash, l'OCR et la piste d'audit suffisent ;
- collecter des exemples `/cinfo` montrant clairement les trois couleurs de rôles et des changements de roster.

Le point techniquement le plus délicat est le regroupement fiable des colonnes F7 sans coordonnées fixes, suivi des
homonymes après perte de casse. Le SteamID à 17 chiffres, la prévisualisation humaine et le recroisement WarBandits
bornent ce risque sans inventer de correspondance.

## Plan chirurgical

Calibration confirmée le 2026-10-01 pour `/cinfo` : le beige/jaune pâle désaturé indique un membre normal, le jaune
vif saturé un leader et le bleu saturé un modérateur. Le vote travaille dans les boîtes relatives des mots OCR, sépare
teinte et saturation et ignore le fond brun ; il ne dépend d'aucune position écran. Une couleur illisible reste
`unknown`, et les pixels beige d'anti-crénelage ne peuvent plus promouvoir un membre en leader.

1. **Terminé** : contrats stricts, journal JSONL mensuel durable, projections identité/clan/présence/wipe,
   déduplication/corruption, hook BattleMetrics global sans second poller et requêtes compactes.
2. **Terminé fonctionnellement** : imports `/cinfo` et F7 par slash command ou dépôt de 1–10 images dans
   `intel-imports`, détection sémantique du type, découpage de plusieurs panneaux `/cinfo`, validation de l'image,
   Tesseract local sérialisé, regroupement relatif, couleurs de rôles relatives, aperçu/confirmation et remplacement
   explicite ancien/nouveau des hash déjà importés. Le batch est validé entièrement avant son unique append durable ; les webhooks non autorisés
   sont ignorés. Les snapshots partiels, le résolveur Unicode un-à-un, la réévaluation automatique et la corroboration
   WarBandits/Steam plafonnée à trois requêtes candidates par lot, le masque couleur agrandi, les user-words et la
   mémoire visuelle persistante sont également implémentés. Les rosters complets sont désormais redécoupés relativement
   aux virgules/`and`, avec une ligne image isolée par membre et une seule lecture bornée par panneau. Un roster
   incomplet reçoit aussi une lecture de champ dédiée ; le fallback Edit/Confirm apprend un lexique textuel persistant
   sans transformer la correction en preuve d'identité ou de glyphe.
3. **À calibrer et étendre** : corpus de PNG originaux, précision champ par champ et seuils couleur/OCR sur Linux,
   lectures isolées du tag/compteur, modèle synthétique multi-fontes et moteur de scène multilingue ; les tests
   déterministes utilisent actuellement les textes et boîtes correspondant aux exemples fournis.
4. **À ajouter si utile** : import legacy en lecture seule, Rust+ own-clan, vue d'historique détaillée et outil audité
   de liaison/révocation ; aucune de ces étapes ne doit modifier les bases existantes.
5. **Terminé pour les images** : le helper Windows déclenche le sélecteur de région natif, valide le PNG et envoie une
   seule capture au webhook avec détection automatique par défaut ou indice strict facultatif, sans coordonnées fixes,
   fichier persistant ou retry réseau. Le helper
   Steamworks de roster et la sonde ASF passive restent des pistes séparées conditionnées au test de fraîcheur/retrait.
   Aucun credential Steam n'est exporté vers le bot.

### Mesures de performance (poste de développement, 1er octobre 2026)

QA locale finale après remplacement d'import, lecture de champ et correction confirmée du roster :
`npm.cmd test` passe 193/193,
dont le typage strict `tsc --noEmit`. Une
couverture déterministe reproduit la mauvaise attribution `』Marley』`/`Swizzy`, vérifie le découpage relatif aux
virgules, la fusion `n444shj, spirit_monger19`, le rejet des comptes/doublons manuels et l'absence d'apprentissage avant
Confirm. Elle vérifie ensuite la persistance et la réutilisation du mot corrigé. Le sélecteur Windows, un webhook
Discord réel et l'OCR de PNG originaux restent à valider interactivement ; les tests n'envoient rien sur le réseau.

Scénario reproductible `npm run benchmark:player-intelligence` : roster initial de 200 joueurs, 60 polls silencieux,
puis 10 déconnexions. Le premier profilage lisait/reprojetait le journal à chaque poll silencieux : `25,397 ms/poll`.
Après ajout d'une garde de poll inchangé fondée sur la fiabilité fournisseur, le wipe, les deltas et les liens tracker,
la médiane de trois exécutions est `0,041 ms/poll`, soit `-99,84 %`. Les mêmes exécutions mesurent `42,9–64,2 ms` pour
l'initialisation, `55,5–95,1 ms` pour dix transitions, `267 710` octets de journal et environ `16 MiB` de RSS ajoutée.
Une panne répétée ignore aussi les anciens tableaux de transitions BattleMetrics et ne reprojette qu'à la frontière.

Le dispatch `!unknown` mesuré avant/après l'ajout du descriptor plugin passe d'une médiane de `15,645 µs` à
`16,204 µs` par commande (`+0,559 µs`, environ `+3,6 %`, 10 000 itérations). Le coût reste négligeable face aux I/O ;
le benchmark et les résultats fonctionnels doivent être rerun après toute extension des hooks.

Le résolveur a aussi été mesuré sur 20 slots et 2 000 alias synthétiques. La matrice exhaustive initiale prenait une
médiane de `3 811 ms` sur trois exécutions. Un index de récupération exacte/alphanumérique/sans accents, puis de
bigrammes rares bornés pour les seules hypothèses floues, réduit la médiane à `128 ms` (`-96,6 %`). Le bornage ne peut
pas créer un lien définitif : une hypothèse seulement floue reste provisoire tant qu'une source externe unique ne la
corrobore pas. Le coût réel sur le corpus de captures reste à mesurer.

La recherche visuelle a été mesurée séparément sur 20 crops et la limite de 2 000 signatures. La validation/décodage
répétée de chaque signature prenait une médiane de `600,386 ms` sur sept exécutions. Un cache faible des features
validées/décodées et du nombre de pixels actifs ramène la médiane à `115,941 ms` (`-80,7 %`) sans changer le score Dice
de forme ni la pénalité d'aspect. Le premier chargement valide toujours intégralement le sidecar.

## Tests déterministes indispensables

- validation des SteamID/dates/schémas, immutabilité profonde et réponses bornées ;
- corruption préservée et mutation bloquée, atomicité, concurrence, déduplication et reconstruction après restart ;
- même SteamID fusionné ; pseudo exact unique seulement probable ; homonymes/simultanéité Unicode ambiguës ;
- révocation/split reconstruisant la bonne projection ;
- panne BattleMetrics devenant `unknown`, jamais `offline` ;
- panne ou reprise fournisseur ne fermant/ouvrant aucune fausse session, chevauchements non comptés deux fois ;
- agrégation hebdomadaire bornée, fuseau/DST déterministes, `unknown` exclu et couverture insuffisante signalée ;
- changement de wipe fermant les intervalles sans hériter du clan ;
- même tag sur plusieurs wipes augmentant la récurrence sans créer une identité globale ;
- snapshots complets bornant un départ/changement de rôle, snapshot incomplet ne créant aucune absence ;
- association de joueurs dérivée des memberships partagés sans événements pair-à-pair dupliqués ;
- hash `/cinfo` réimporté ne gonflant pas les compteurs, snapshots distincts les incrémentant une seule fois ;
- ordre décroissant stable et suffixe `+N` respectant strictement la limite des messages in-game ;
- scission de roster projetée avec couverture sans inventer un litige ni modifier l'historique source ;
- co-play ne créant aucun membership, équipe Rust+ ne devenant pas automatiquement un clan ;
- OCR `/cinfo` : noms colorés, guillemets, accents, virgules, lignes coupées, compteur incohérent et image dupliquée ;
- roster `/cinfo` partiel : aucune association visuelle positionnelle, aucune permutation Marley/Swizzy et aucun
  apprentissage de mot/glyphe avant une partition complète, unique et ordonnée ;
- OCR F7 : regroupement dynamique nom/SteamID sans coordonnées fixes, casse non fidèle, Unicode, ligne partiellement
  masquée, SteamID tronqué ou mal lu, homonymes et variations d'ordre des colonnes/résolution ;
- rapprochement `/cinfo`/F7 : correspondance case-foldée unique acceptée après confirmation, collision refusée ;
- corroboration WarBandits : accord, renommage, absence, timeout et `429`, sans rollback de l'import confirmé ni
  requêtes parallèles par joueur ;
- commit historique précédant toute projection Discord ; panne UI après commit sans rollback ;
- benchmark CPU, mémoire, latence et taille disque avant/après sur 200 joueurs et un lot de captures.

## Coût et priorité

- Capture manuelle, API existantes et stockage JSONL : aucun abonnement supplémentaire.
- BattleMetrics Premium : déjà actif ; la facture du compte reste la référence de coût.
- WarBandits : API publique sans coût apparent, mais production conditionnée à leur autorisation.
- OCR local : pas de coût par requête avec Tesseract/Tesseract.js, mais coût CPU/mémoire à mesurer.
- SQLite éventuel : pas de coût de licence, mais dépendance native et maintenance Linux/CI.

Ordre de valeur : flux officiel WarBandits > import `/cinfo` confirmé > Rust+ own-clan > enrichissements
BattleMetrics/WarBandits > chat global manuel. RustRadar et tout collecteur client automatisé sont exclus du plan
actuel.

## Vie privée et sécurité

SteamID64, pseudo et historique relationnel restent des données identifiantes ; la
[CNIL inclut pseudonymes et identifiants](https://www.cnil.fr/fr/identifier-les-donnees-personnelles). Limiter l'accès
Discord, documenter la finalité et la rétention, permettre correction/suppression, séparer preuves brutes et
projections, et ne pas publier les captures. Ne pas conserver le chat global complet lorsqu'un fait dérivé suffit.
