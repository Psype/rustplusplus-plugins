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
- Implemented best-effort tracking using Rust+ `GenericRadius` map markers whose marker name matches `/deep\s*sea/i`. If Facepunch exposes the Deep Sea map marker through Rust+, the bot now sends open/close notifications, records it in event history, includes it in event info, and makes `!deepsea` report active location or time since last active.
- If vanilla Rust only plays a client-side sound and does not expose this marker/name through Rust+, this tracker will not fire until the actual Rust+ marker payload is captured and matched.

## Discovery dump update
- Added `/tmp/rustplus-markers.json` dump on each polling refresh. It includes `markers`, vending-machine `vendors`, `monuments`, plus guild/server/timestamp metadata so the user can compare before/while Deep Sea is active.
- Updated the Deep Sea candidate matcher to scan serialized GenericRadius marker payloads for `deep|sea|floating|ghost|naval`, matching the requested jq discovery keywords while still limiting state changes to GenericRadius marker appearance/disappearance.
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
- User reported Deep Sea spawned but the matcher did not detect it. Added newline-delimited raw payload logging for exploration: `/tmp/rustplusplus-events.log` logs every Rust+ `message` event and every polled `getMapMarkers` payload; `/tmp/rustplus-markers-history.log` keeps marker history across polls. Existing `/tmp/rustplus-markers.json` remains as the latest marker snapshot.
- Use these logs while Deep Sea is active to inspect missed payloads and tighten `isDeepseaMarker()`.

## Raw websocket logging
- User asked for raw socket data to grep for Deep Sea hints. Added `/tmp/rustplusplus-raw-socket.log` newline-delimited JSON logging for raw inbound and outbound WebSocket frames. Frames are protobuf/binary, so each entry includes byte length plus UTF-8 best-effort, hex, and base64 representations.

## Raw websocket text logging adjustment
- User clarified raw socket logs should be readable plain text, not JSON/base64/hex. Changed the WebSocket raw log path to `/tmp/rustplusplus-raw-socket.txt` and append best-effort UTF-8 text directly with simple timestamp/direction separators.

## Deep Sea debug workflow documentation
- Added `docs/deepsea_debugging.md` with recommended grep/jq workflows for raw WebSocket text, decoded events, marker history, before/during snapshot diffing, and how to refine `isDeepseaMarker()` once the actual Deep Sea marker shape is identified.
