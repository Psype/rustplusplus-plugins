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
