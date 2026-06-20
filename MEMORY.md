# Project Memory

## Project purpose
- This repository is a Rust+ / Discord bot plugin forked from `alexemanuelol/rustplusplus`.
- It connects to the Rust+ companion API and exposes useful in-game/team-chat and Discord-operated commands for Rust servers.
- Existing commands include live event/monument-style information such as `!cargo`, `!heli`/patrol helicopter, `!small`, and `!large`, plus Discord slash commands documented in `/docs`.

## User expectations
- Keep this `MEMORY.md` file updated whenever new information is learned or meaningful changes are made.
- Treat this file as the source of truth for continuing work in later sessions without losing context.
- Prefer implementing commands in the same style as existing in-game commands, with localized command syntax/message keys where practical.
- The immediate request is to add/suggest a `!deepsea` monument information command analogous to existing event/monument commands.

## Current work notes
- Existing in-game commands are routed in `src/handlers/inGameCommandHandler.js` and implemented mostly as `getCommand...` methods in `src/structures/RustPlus.js`.
- Underwater Labs are already represented in map monument metadata as token `underwater_lab` in `src/structures/Map.js` and in CCTV data as `Underwater Labs` in `src/staticFiles/cctv.json`.
- Important correction: Deep Sea is not Underwater Labs. It is the Naval Update offshore timed world event reached past the map edge/buoys, with Floating City, Ghost Ships, islands, patrol boats, and event timer/radiation pressure.

## Implemented changes
- Reworked `!deepsea` away from Underwater Labs. It now gives a Deep Sea event briefing/access reminder based on research: timed offshore event, map-edge/buoys entry, Floating City, Ghost Ships, islands, patrol boats, no respawning loot, and leave before timer/radiation.
- Added English localization strings and documentation entries for `!deepsea`.

## Follow-up Deep Sea tracking notes
- User clarified that they want Deep Sea tracked like Cargo/Heli if possible because the game plays a notification when Deep Sea opens.
- Earlier GenericRadius-based Deep Sea tracking was superseded after live data showed the useful signal is off-map vending-machine clusters, especially `Casino Bar Shopkeeper`.
- If vanilla Rust only plays a client-side sound and does not expose this marker/name through Rust+, this tracker will not fire until the actual Rust+ marker payload is captured and matched.

## Discovery dump update
- Added `logs/rustplus-markers.json` dump on each polling refresh. It includes `markers`, vending-machine `vendors`, `monuments`, plus guild/server/timestamp metadata so the user can compare before/while Deep Sea is active.
- Deep Sea matching now relies on `src/handlers/deepSeaHandler.js`: `Casino Bar Shopkeeper` off-map vendors or an off-map vending-machine cluster (>=3 vendors), with state changes based on cluster appearance/disappearance.
- Extended `!events` compatibility toward RustPlusBot naming by recording `vendor` events and accepting `ch47`, `oil_rig_small`, and `large_oil_rig` aliases in addition to existing Cargo/Heli/Oil/Chinook/Deep Sea names.

## Battlemetrics noise suppression
- User reported repeated `Battlemetrics Server Name Changed` Discord spam. Disabled those notifications in the Battlemetrics handler and changed the default `battlemetricsServerNameChanges` setting to `false`; other Battlemetrics notifications remain untouched.

## Battlemetrics name recovery clarification
- Clarified that Battlemetrics server names are still updated/recovered inside the Battlemetrics instance; only the Discord notification/alarm for `server_name` changes is suppressed.

## Events output alignment
- User screenshots show `!events` should remain a concise history of major map events, not vendor movement spam. Removed `vendor` from `!events` history/all-events integration and kept Deep Sea as the new major event entry.
- Adjusted `!deepsea` messages to match existing command wording style (`Deep Sea is active at ...`, `No current data on Deep Sea.`, and time-since-last-active) instead of pipe-delimited status text.

## Deep Sea prediction research
- Research notes: current public server convar guides list default Deep Sea active duration as `deepsea.wipeduration = 10800` seconds (3h), cooldown as `deepsea.wipecooldownmin = 5400` seconds (1.5h) and `deepsea.wipecooldownmax = 9000` seconds (2.5h), with final wipe/radiation pressure near the end. Facepunch Shipshape notes the side is now random after each opening and Deep Sea no longer opens right after wipe.
- Implemented prediction in `!deepsea`: while active, it estimates remaining time from first marker sighting against a 3h default window; after close, it predicts the next opening window using 1.5h-2.5h default cooldown.

## Raw Rust+ debug logging
- User reported Deep Sea spawned but the matcher did not detect it. Added newline-delimited raw payload logging for exploration: `logs/rustplusplus-events.log` logs every Rust+ `message` event and every polled `getMapMarkers` payload; `logs/rustplus-markers-history.log` keeps marker history across polls. Existing `logs/rustplus-markers.json` remains as the latest marker snapshot.
- Use these logs while Deep Sea is active to inspect missed payloads and tighten `deepSeaHandler.js`.

## Raw websocket logging
- User asked for raw socket data to grep for Deep Sea hints. Added `logs/rustplusplus-raw-socket.txt` plain-text best-effort UTF-8 logging for raw inbound and outbound WebSocket frames.

## Raw websocket text logging adjustment
- User clarified raw socket logs should be readable plain text, not JSON/base64/hex. Changed the WebSocket raw log path to `logs/rustplusplus-raw-socket.txt` and append best-effort UTF-8 text directly with simple timestamp/direction separators.

## Deep Sea debug workflow documentation
- Added `docs/deepsea_debugging.md` with recommended grep/jq workflows for raw WebSocket text, decoded events, marker history, before/during snapshot diffing, and how to refine `deepSeaHandler.js` once the actual Deep Sea vendor marker shape is identified.

## Deep Sea vendor-cluster detection
- User found Deep Sea opening creates a cluster of off-map vending-machine markers, including `Casino Bar Shopkeeper`. Removed previous GenericRadius Deep Sea matching and added `src/handlers/deepSeaHandler.js`, called from polling, to detect Casino Bar Shopkeeper or any off-map vendor cluster (>=3 vendors), infer side from off-map coordinates, track a 3h active window, and close when those vendors disappear.
- Moved debug outputs from `/tmp` into the project `logs/` directory.

- Suppressed generic `new vending machine` notifications for off-map vendors so Deep Sea shopkeeper clusters do not spam vending-machine alerts; Deep Sea uses its own state-change notification.

## Deep Sea JSON confirmation
- User provided a live marker payload showing Deep Sea vendors as `type: "VendingMachine"` strings with x around `-4100` and `Casino Bar Shopkeeper`, confirming the west-side off-map vendor-cluster detection. Updated `deepSeaHandler.js` to accept both numeric Rust+ vending type `3` and string `VendingMachine`.
- Follow-up from the live JSON: Rust+ marker `type` may arrive as enum names like `"VendingMachine"` instead of numeric ids. Deep Sea detection, marker dumps, and `MapMarkers.getMarkersOfType()` now tolerate both string enum names and numeric enum values so existing events and vendor handling keep working with either payload shape.

## Deep Sea side correction
- Full live payload review corrected the previous interpretation: the Deep Sea vendor cluster with `Casino Bar Shopkeeper` at negative `x` and in-bounds `y` is west of the map, not south. The earlier rotated-axis assumption was wrong.
- Deep Sea side inference in `src/handlers/deepSeaHandler.js` must use normal Rust+ map axes: `x < 0` reports West, `x > mapSize` reports East, `y < 0` reports South, and `y > mapSize` reports North. The handler continues recomputing/storing side while active so `!deepsea` and the info channel reflect vendor movement before the cluster disappears.

## Events output direction
- User wants `!events` to be a current per-event summary instead of timestamped notification history. Each line should use relative durations from now, include active/last-seen and next expected information when known, and say the event info is unknown when no data exists.
- Deep Sea active text should avoid absolute timestamps and say it is active on the side for the next relative duration, e.g. `Deep Sea event is active on the South side for the next 1 hour and 12 minutes.`

## Deep Sea reverification
- Complete code-path review found the old GenericRadius Deep Sea heuristic still existed in `src/structures/MapMarkers.js` even though vendor-cluster detection had superseded it. Disabled that heuristic so only `src/handlers/deepSeaHandler.js` owns Deep Sea state/notifications.
- `deepSeaHandler.js` now exposes side-calculation helpers for direct verification and stores `sideDetails` (`center`, `distance`, and `correctedMapSize`) on `rustplus.deepSea`. The handler overwrites `side` and `sideName` on every active poll, not only when the side changes, to prevent stale `South` values from surviving after a fix/reload.

## Deep Sea isolation refactor
- User requested Deep Sea changes be isolated so updating from the original project is easier. Moved Deep Sea runtime state, command formatting, event summary wrapping, side calculation, notification strings, and legacy GenericRadius suppression into `src/handlers/deepSeaHandler.js`.
- Reverted direct Deep Sea changes to base `RustPlus.js`, `MapMarkers.js`, and `languages/en.json`; the remaining base hook is a minimal polling call to `DeepSeaHandler.install(...)` and `DeepSeaHandler.handler(...)`.


## Discord channel permission preservation
- User reported that restarting the bot made existing rustplusplus Discord channels public again. The startup path was resetting category/channel permission overwrites every time via setup helpers and `resetPermissionsAllChannels`.
- Changed startup setup so existing category/channels keep their current Discord permission overwrites. Permissions are now applied automatically only when the bot creates a missing channel/category or during first-time setup; explicit `/role` and `/reset` commands can still intentionally recalculate permissions.


## Deep Sea side inference update
- User provided another server where `Casino Bar Shopkeeper` at `x=-3827.1997`, `y=2065.6836` is actually North. This shows the far-outside coordinate on Deep Sea vendors can be offshore distance, not the side itself.
- Updated `deepSeaHandler.js` side inference: if exactly one axis is outside the map and the other is in-bounds, use the in-bounds coordinate relative to the map midpoint (`y >= midpoint` => North, `y < midpoint` => South; `x >= midpoint` => East, `x < midpoint` => West). Fall back to outside-edge distance only when both axes are outside or neither gives the single-axis pattern.


## Deep Sea dynamic map-size correction
- User clarified that Deep Sea side inference must be dynamic across different map sizes; a coordinate that looks in-bounds on one map may still be part of an offshore Deep Sea marker on a larger map.
- Updated `deepSeaHandler.js` to calculate reference bounds from in-map monuments first, falling back to in-map non-Deep-Sea vending-machine markers, other in-map markers, and then server `correctedMapSize`. For single-axis-offshore Deep Sea markers, side is now based on the in-bounds coordinate relative to these observed bounds instead of assuming a fixed map midpoint.


## Events approximate next windows and oil-rig grids
- User wants `!events` to show approximate next event timing from vanilla-default assumptions even when the bot only has last-seen timestamps. Added isolated event-summary helpers in `deepSeaHandler.js` that append vanilla approximate next windows for Cargo, Patrol Helicopter, Chinook, Small Oil Rig, and Large Oil Rig.
- User also noted modded servers can have multiple oil rigs and wants one `!events` line per rig, not combined names. Small/Large Oil Rig summaries are now split per oil-rig monument grid, e.g. `Large Oil Rig (A1)` and `Large Oil Rig (Z20)`, with each grid keeping its own last-trigger/unlock estimate when the bot has seen that rig.

## Deep Sea map-size confirmation
- Superseded correction: user clarified from another live South Deep Sea payload that Rust+ Deep Sea marker coordinates use `X` as vertical and `Y` as horizontal. A `Casino Bar Shopkeeper` marker at `x=-3455.9019`, `y=2101.2419` is South; therefore negative `x` must report South, positive off-map `x` North, negative `y` West, and positive off-map `y` East.
- `deepSeaHandler.js` now falls back to calculating corrected map size from `rustplus.info.mapSize` if `correctedMapSize` is not already present, keeping Deep Sea edge checks tied to the live server map dimensions exposed by Rust+ info payloads.

## Deep Sea message direction suppression
- User asked to keep the side/direction calculation code for later debugging, but stop showing Deep Sea direction in bot-facing messages until the coordinate behavior is fully trusted. Deep Sea open, active, info-channel, and last-seen messages should only show active/remaining/next-timer text, not North/South/East/West.

## Deep Sea localization update
- Moved the newer isolated Deep Sea command, notification, and event-summary user-facing strings in `src/handlers/deepSeaHandler.js` behind language keys instead of hardcoded English.
- Added the new Deep Sea/event-summary localization keys to the language JSON files and added `src/languages/zh.json` as a Chinese language file. The Chinese Deep Sea strings use Simplified Chinese wording for the Rust Deep Sea timed event, prediction windows, notifications, and oil-rig/event-summary helpers.
- Added `commandSyntaxDeepsea` to the reserved in-game keyword list so the localized `!deepsea` command is treated like the other localized commands.

## Full Chinese language file
- User clarified they need the whole bot usable in Chinese for Chinese-speaking in-game teammates, not only Deep Sea strings.
- Expanded `src/languages/zh.json` from a mostly-English copy into a full Simplified Chinese language file covering general bot output, in-game/team messages, event notifications, command descriptions, settings, smart devices, market subscriptions, timers, Battlemetrics, and Deep Sea strings. Command syntax values intentionally remain command-like ASCII unless already customized, so existing commands stay predictable.

## Language parity expectation
- User clarified that new language keys must not be left in English inside non-English language files. When adding localization keys, translate those keys into each existing language file's respective language; do not translate command syntax values unless that is already the standard/procedure for that language.
- Chinese (`zh`) is being added as one language option among the existing language choices, not because the user specifically wants a Chinese-only bot.

## Guild language default behavior
- User logs showed bot log titles in Chinese but guild event/in-game messages still in English after reboot. The cause is that `Config.general.language` controls the bot/default logger intl, while per-guild event and in-game command text uses each instance's `generalSettings.language` loaded into `guildIntl`.
- To make global non-English configuration apply to existing default-English guild instances after restart, `DiscordBot.loadGuildIntl()` now promotes an instance language of `en` to `Config.general.language` when the config language is non-English, persists it to the instance file, and then loads that language for guild event/in-game text.
