# Project Memory

This file is the cross-session memory for this Rust+ / Discord bot fork. Keep it updated when project behavior, user preferences, debugging workflows, or architecture changes.

## Project purpose and user expectations
- The repo is a Rust+ / Discord bot plugin forked from `alexemanuelol/rustplusplus`.
- It connects to the Rust+ Companion API and provides Rust team-chat plus Discord command/event tooling.
- Keep commands in the same style as existing in-game commands, with localized syntax/messages where practical.
- When adding localization keys, every language JSON should keep key parity with English. Non-English language files should receive translated text, not English placeholders. Command syntax values should remain command-like ASCII unless that language already customizes them.
- This memory file is the source of truth for future ChatGPT sessions. Prefer concise, non-contradictory summaries over raw chronological dumps.

## Command and localization architecture
- In-game commands are routed through `src/handlers/inGameCommandHandler.js` and implemented mostly as `getCommand...` methods on `src/structures/RustPlus.js`, with some isolated feature handlers/plugins.
- Discord command-channel handling should generally match in-game command coverage where practical.
- `!commands [command]` works in Rust team chat and the Discord commands channel. It uses `src/util/commandCatalog.js`, which reads the `## In-Game and Discord Commands` section of `docs/full_list_features.md` at runtime as the documentation-backed command source.
- `!language <code>` updates the live guild instance, RustPlus runtime settings, guild intl cache, bot intl cache, and `config/index.js` fallback together. `!language` without an argument reports the current guild language and supported codes. `RPP_LANGUAGE` still overrides the config fallback on restart.
- `Config.general.language` controls bot/default logger intl; per-guild event and in-game command text uses each instance's `generalSettings.language` loaded into `guildIntl`. Existing default-English guild instances may be promoted to a non-English global config language during `DiscordBot.loadGuildIntl()`.
- Chinese (`zh`) is a full Simplified Chinese language option for the whole bot, not a Chinese-only fork. Existing commands remain predictable command-like ASCII unless deliberately localized.

## Bot/team-chat message formatting
- Bot messages sent back into Rust team chat use `[BOT] ` as the visible branding prefix when branding is enabled; `NOT SHOWING` still suppresses the prefix.
- Autotranslate labels only show the destination language, e.g. `[→zh] translated text`, because the source language is not important once the message is translated.
- Message-length calculations for bot-sent team chat must account for the rendered `[BOT] ` prefix length.

## Runtime settings and logging
- Runtime settings live under `config/`:
  - `config/logging-settings.json` for `!logs`.
  - `config/autotranslate-settings.json` for `!autotranslate`.
- Legacy paths are migrated/copied forward automatically where implemented (`logs/logging-settings.json` and `data/autotranslate-settings.json`).
- `!logs on|off` works in-game and in the Discord command chat. Turning logs off keeps console output but suppresses Winston file writes, raw Rust+ WebSocket/event debug logs, marker history, and marker snapshots.
- The teammate SteamID/nickname/language CSV database is data, not config, and remains under `data/teammate-language-database/<guildId>-<serverId>.csv`.

## Generic language detection, teammate language DB, and autotranslate
- `src/util/languageDetector.js` provides silent lightweight detection for major scripts such as Han, Japanese kana, Hangul, Cyrillic, Arabic, Thai, Greek, Hebrew, and Devanagari, plus a basic English heuristic for short team-chat messages.
- `src/plugins/teammateLanguageDatabase/index.js` stores per-guild/server CSV rows with `steamid,date,name,language`. It uses `XX` for unknown, preserves existing non-`XX` languages as source of truth, and appends a row when a SteamID appears with a new nickname.
- The teammate language DB records observations from Rust+ polling team info, team-change broadcasts, and team-chat messages.
- Manual commands: `!record [steamid] [pseudonym with spaces allowed]` adds a nickname row, and `!who [steamid]` lists known pseudonyms with dates/language. They should work in Rust team chat and the Discord commands channel.
- `!autotranslate on [language[,language...]]` / `!autotranslate off` works in-game and in Discord command channels. `!autotranslate on` defaults to English. With two targets such as `en,zh`, English messages translate to Chinese and Chinese/non-English messages translate to English where detected.
- Autotranslate posts translated messages to the Discord team-chat relay and repeats them into Rust team chat.

## Deep Sea event support
- Deep Sea is not Underwater Labs. It is the Naval Update offshore timed world event reached beyond map-edge buoys, with Floating City, Ghost Ships, islands, patrol boats, no respawning loot, and a timer/radiation pressure before closure.
- Deep Sea support is intentionally isolated as much as possible in `src/handlers/deepSeaHandler.js` to ease future upstream updates. The base hook is a minimal polling install/handler call.
- `!deepsea` gives status/prediction text for the Deep Sea event. It should avoid showing North/South/East/West direction to users until coordinate behavior is fully trusted, though side-calculation/debug data remains useful internally.
- Deep Sea detection is based on off-map vending-machine clusters, especially `Casino Bar Shopkeeper`, not `GenericRadius` markers or Underwater Labs metadata.
- Live Rust+ payloads showed Deep Sea vendors can use `type: "VendingMachine"` string enum names as well as numeric vending-machine type ids, so marker handling must tolerate both.
- GenericRadius-based Deep Sea heuristics were superseded and should stay disabled; `deepSeaHandler.js` owns Deep Sea state and notifications.
- Off-map Deep Sea vendor clusters should not trigger generic `new vending machine` notification spam. Deep Sea uses its own open/close state-change notification.
- Deep Sea open/close notifications should not be suppressed as first-poll events, so a restart while Deep Sea is active can still post a detected Deep Sea event.
- Vanilla/default timing assumptions used for prediction: active duration is about 3 hours (`deepsea.wipeduration = 10800`), cooldown window is about 1.5-2.5 hours (`deepsea.wipecooldownmin = 5400`, `deepsea.wipecooldownmax = 9000`). Facepunch notes indicate the side is random after each opening and Deep Sea no longer opens immediately after wipe.
- Coordinate lessons are contradictory across observations. Keep this as debug-only unless revalidated:
  - Early payloads around negative `x` were first interpreted as west, then user examples suggested single-axis offshore coordinates may encode distance rather than side.
  - A later user-confirmed South payload indicated Rust+ Deep Sea marker coordinates may use `X` as vertical and `Y` as horizontal: negative `x` => South, positive off-map `x` => North, negative `y` => West, positive off-map `y` => East.
  - Because of these contradictions, user-facing messages should not expose direction yet.
- Deep Sea debug logs/workflows:
  - `logs/rustplus-markers.json` stores the latest marker snapshot with markers, vending-machine vendors, monuments, guild/server/timestamp metadata.
  - `logs/rustplus-markers-history.log` keeps marker history across polls.
  - `logs/rustplusplus-events.log` logs decoded Rust+ `message` events and polled `getMapMarkers` payloads.
  - `logs/rustplusplus-raw-socket.txt` logs best-effort UTF-8 raw inbound/outbound WebSocket frames with simple timestamp/direction separators.
  - `docs/deepsea_debugging.md` documents grep/jq workflows for raw WebSocket text, decoded events, marker history, snapshot diffing, and refining `deepSeaHandler.js`.


## Hidden vendor tracking
- Hidden vendor tracking records every Rust+ vending-machine marker seen during polling into `data/hidden-vendors/<guildId>-<serverId>-<mapSignature>.json`. The map signature includes seed/map size/wipe time, so the active database resets naturally on server or map changes while old files remain for inspection.
- `!hv` works in Rust team chat and the Discord commands channel. It reports former vendors grouped by grid from largest cluster to smallest, using vendors that were previously seen in the current server/map database but are absent from the latest broadcasting marker set.
- `!hvw` uses the same database but only reports short-lived former vendors (`seenPolls <= 2`), a heuristic for water-stash vendors that broadcast briefly after placement and then disappear.
- `!hvt` reports hidden vendors grouped by grid and seen-poll count, sorted from the least observed broadcast time upward; this helps find likely water-stash vendors even when a player forgot to disable broadcast for longer than the strict `!hvw` cutoff.
- Rust+ does not expose vendors that never broadcasted; the tracker can only preserve the last observed location for vendors that appeared in marker polling at least once. The command output intentionally does not include sell orders.
- This intentionally avoids relying on generated bot map imagery for water detection. For underwater stash hunting, the useful signal is a vendor that briefly broadcasts and then disappears from the current marker set.

## Events command behavior
- `!events` should be a concise current per-event summary, not a timestamped notification history and not vendor movement spam.
- Each summary line should use relative durations from now, include active/last-seen/next-expected information when known, and say event info is unknown when no data exists.
- Deep Sea should appear as a major event entry. Vendor movement should not appear in `!events` history/all-events integration.
- Event summaries can append vanilla approximate next windows for Cargo, Patrol Helicopter, Chinook, Small Oil Rig, and Large Oil Rig when only last-seen timestamps are known.
- Modded servers may have multiple oil rigs. Small/Large Oil Rig summaries should split per oil-rig monument grid, e.g. `Large Oil Rig (A1)` and `Large Oil Rig (Z20)`, with per-grid last-trigger/unlock estimates when observed.
- Event aliases should remain compatible with RustPlusBot-style naming where previously added, including `ch47`, `oil_rig_small`, and `large_oil_rig`.

## Discord setup and permissions
- Restarting the bot must not reset existing Rust++ Discord category/channel permission overwrites and make private channels public again.
- Startup setup should preserve current overwrites for existing category/channels. Permissions are applied automatically only when creating missing category/channels or during first-time setup.
- Explicit `/role` and `/reset` commands may still intentionally recalculate permissions.

## Battlemetrics behavior
- Discord spam from repeated `Battlemetrics Server Name Changed` notifications was suppressed by disabling that notification and defaulting `battlemetricsServerNameChanges` to `false`.
- Battlemetrics server names are still updated/recovered internally; only the Discord notification/alarm for `server_name` changes is suppressed.

## Raid alarm plugin localization
- Raid alarm plugin messages translate the standard `You're getting raided!` title through `baseIsUnderAttack` and translate `X destroyed at Y` payloads through `raidAlarmDestroyedAt`.
- Item names from FCM/plugin payloads remain as provided because the payload does not include stable item IDs.
- Bot-originated Rust team-chat broadcasts (matching the bot Rust+ player SteamID) should be treated as echoes of the bot's own queued messages and must not be relayed back through Discord/team-chat autotranslate or command handling. This prevents localized bot command replies such as `!hv` output from being translated by autotranslate.
- Hidden vendor tracking should exclude Deep Sea event vending-machine markers. Deep Sea vendors are NPC/event vendors, not player vending machines, and should not appear as temporary/water-suspect hidden vendors.
- On successful Rust+ connection startup, the bot should announce `rustplusOperational` into Rust team chat after the first poll completes and `isOperational` becomes true.
- Teammate death notifications should preserve a grid location whenever possible, falling back from the previous cached player position to the updated team payload position before using `spawn`.
