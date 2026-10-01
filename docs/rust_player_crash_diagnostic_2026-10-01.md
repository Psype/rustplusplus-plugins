# Diagnostic Rust `Player.log` — 2026-10-01

## Périmètre

Analyse des deux fichiers transmis, considérés comme des données non fiables et non comme des instructions :

- `Player.log` — 7 390 octets, SHA-256 `EA8A10704E513710452E57E9A667E8FEE4BC8540E6D48001EB9A9CB3DC11820D` ;
- `Player-prev.log` — 22 806 octets, SHA-256 `42CA3DA927A1AB39470F2EB48A90DDE7C85746FDB538E41E820AE99D55F90C62`.

Ce rapport ne vaut que pour ces empreintes. Les fichiers ne contiennent aucune connexion à un serveur ni aucun changement de serveur/session en jeu.

## Conclusion

La seule erreur déterminante est dans `Player-prev.log` :

```text
SteamApi_Init failed with NoSteamClient
Cannot create IPC pipe to Steam client process. Steam is probably not running.
```

Rust n'arrive donc pas à établir le canal IPC avec le client Steam. Causes usuelles compatibles avec cette trace : Rust lancé directement au lieu de la bibliothèque Steam, Steam arrêté/bloqué, ou niveaux de privilèges différents entre Steam et Rust. Le journal atteint environ 3 105 Mo de mémoire de processus avant cet échec, sur 16 310 Mo de RAM système ; aucune allocation mémoire défaillante n'est journalisée.

Les deux journaux se terminent par le nettoyage explicite de PhysX et l'arrêt normal de l'Input System. Ils ne contiennent aucune signature de crash natif, manque de mémoire, perte du périphérique Direct3D, erreur NVIDIA ou Easy Anti-Cheat. Ils décrivent donc davantage un abandon contrôlé du démarrage qu'un crash brutal démontré.

`Player.log` s'arrête plus tôt, pendant `Loading Menu Prefabs`, sans atteindre l'initialisation Steam et sans erreur explicite. Il ne permet pas d'attribuer une autre cause.

Les 20 avertissements `There is no FlexLayoutManager!` de `Player-prev.log` surviennent après l'échec Steam. Ils concernent l'interface et ne constituent pas, dans ces fichiers, la cause racine démontrée. Les avertissements de shaders de repli apparaissent dans les deux lancements et ne sont associés à aucune erreur graphique fatale.

## Action prioritaire

1. Fermer Rust et Steam complètement, puis vérifier dans le Gestionnaire des tâches qu'aucun `RustClient.exe` ou processus Steam résiduel ne subsiste.
2. Redémarrer Steam normalement, puis lancer Rust depuis la bibliothèque Steam, jamais depuis `RustClient.exe`.
3. Vérifier que Steam et Rust utilisent le même niveau de privilèges. En particulier, ne pas forcer Rust en administrateur si Steam ne l'est pas.
4. Si l'erreur persiste, redémarrer Windows, puis utiliser Steam > Rust > Propriétés > Fichiers installés > Vérifier l'intégrité des fichiers.

## Données nécessaires si le problème persiste

Reproduire une seule fois le problème, puis copier `Player.log` et `Player-prev.log` avant toute nouvelle relance. Pour prouver un crash natif, joindre aussi l'entrée correspondante du Moniteur de fiabilité (`perfmon /rel`) ou de l'Observateur d'événements > Journaux Windows > Application, notamment le module défaillant et le code d'exception. Vérifier enfin la présence d'un dump `RustClient.exe*.dmp` dans `%LOCALAPPDATA%\CrashDumps`.

