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
- User provided a live south-side Deep Sea vendor cluster where `Casino Bar Shopkeeper` and related vendors had `x` around `-4100` while `y` stayed within the playable map range. This proved Deep Sea vendor markers use a rotated/offshore coordinate space for side detection compared with normal Rust+ map markers.
- Updated Deep Sea side inference in `src/handlers/deepSeaHandler.js` so `x < 0` reports South, `x > mapSize` reports North, `y < 0` reports West, and `y > mapSize` reports East. The handler continues recomputing/storing side while active so `!deepsea` and the info channel reflect vendor movement before the cluster disappears.

## Events output direction
- User wants `!events` to be a current per-event summary instead of timestamped notification history. Each line should use relative durations from now, include active/last-seen and next expected information when known, and say the event info is unknown when no data exists.
- Deep Sea active text should avoid absolute timestamps and say it is active on the side for the next relative duration, e.g. `Deep Sea event is active on the South side for the next 1 hour and 12 minutes.`
