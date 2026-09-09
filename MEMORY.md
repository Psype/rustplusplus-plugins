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

## Current Rust+ map-marker limitation
- Facepunch's [Power Trip update](https://rust.facepunch.com/news/power-trip) of 2026-08-06 stopped sending vending-machine and event map markers (cargo, helicopters, and travelling vendor) to Rust+.
- A live capture from 2026-09-08 contains 14 successful `getMapMarkers` responses over about 130 seconds, with exactly four `Player` markers in every snapshot and no event or vending-machine marker. Polling and protobuf decoding are healthy; this is not a marker-format regression.
- Cargo, Patrol Helicopter, Chinook, marker-derived Oil Rig activity, Deep Sea, Hidden Vendors, and market/vendor observation therefore cannot receive new live state from the current public Rust+ API. Existing historical handlers are retained in case Facepunch restores the signal or a compatible server-authoritative bridge is added.
- Team/death/connection data and paired-device/FCM alerts use other Rust+ responses and remain available. Do not implement retries or enum-format workarounds for the missing markers.
- Restoring these event signals on a modded server requires a separately validated server-side Oxide/Carbon/uMod bridge; do not assume or install one without server-admin scope and a documented payload contract.

## Generic language detection, teammate language DB, and autotranslate
- `src/util/languageDetector.js` detects major scripts directly and lazily loads the local, zero-API `eld` 2.1.0 extra-small model for short English/French/Chinese chat. English/French Rust-gaming and translation-control vocabulary handles terse phrases such as `test de traduction`. When lexical rules do not decide, the detector accepts ELD's most likely supported language even below its reliability threshold; if ELD has no candidate but the message contains Latin letters only, it defaults to `en`. Messages without letters remain unknown. Player-language and active-pair checks still prevent unrelated translations.
- `src/plugins/teammateLanguageDatabase/index.js` stores per-guild/server CSV rows with `steamid,date,name,language`. Multiple two-letter player languages share the final CSV column with a semicolon separator such as `fr;en`; `XX` means unknown. Existing declared languages remain the source of truth, and a new detected chat language only initializes an unknown player instead of silently extending their declared list.
- The teammate language DB records observations from Rust+ polling team info, team-change broadcasts, and team-chat messages.
- Manual commands: `!record [steamid] [pseudonym with spaces/special characters allowed]` only adds a nickname row; `!who [steamid]` lists known pseudonyms with dates and the current language list. Player languages are edited directly in the CSV, not through an in-game command.
- `!autotranslate on [language[,language...]]` / `!autotranslate off` works in-game and in Discord command channels. `!autotranslate on` defaults to English. `en,zh` supports English to Chinese and Chinese to English; `fr,zh` supports French to Chinese and Chinese to French.
- To avoid spam, autotranslate only runs when the detected message language belongs to the player's declared language list and to the active translation pair. It then translates to the other language in that pair. A language outside the active pair is ignored even when it belongs to the player.
- The first reliably detected non-`XX` team-chat language still initializes an unknown player. Correct or expand the declared list by editing the most recently dated CSV row for that SteamID, using values such as `fr;en`; only that latest row is authoritative. Later automatic observations never overwrite or append to the list. Diagnose with `!who <steamid>` or the server CSV at `data/teammate-language-database/<guildId>-<sanitizedServerId>.csv`.
- Autotranslate queues the translated Rust team-chat message before the optional Discord relay. Translation-engine and Discord failures are logged and do not cancel an already queued in-game translation.
- `npm run test:autotranslate:live` is the explicit network integration check: it exercises the real local detector, the Google translation adapter, multilingual eligibility, team-chat handler, Rust in-game queue, and final `sendTeamMessageAsync` boundary while capturing Discord/Rust outputs instead of publishing them. The test includes plugin decision/error logs in assertion failures.
- Node 18's native Undici `fetch` receives HTTP 429 HTML from the free Google translation endpoint in this deployment, which made `translate` 1.4.1 fail while parsing JSON and caused the plugin boundary to return no translation. AutoTranslate therefore uses its own validated Axios-based Google adapter with a 10-second timeout; the real FR→ZH, EN→ZH, and ZH→EN pipeline passes under Node 18.20.8.
- While autotranslate is enabled, its production decision path logs `AUTOTRANSLATE: TRANSLATED` or `AUTOTRANSLATE: SKIPPED` with SteamID, detected source, declared languages, active targets, chosen target, and a machine-readable reason. It does not log message contents.
- The 2026-09-08 benchmark measured about 356k messages/second (2.8 microseconds/message) after loading the model, versus about 1.54M for the former incomplete word list. The lazy ELD import added about 45 MiB RSS in isolation but does not affect startup or script/lexicon-only messages; translation network latency remains dominant.

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

## Upstream and plugin architecture
- The canonical bot upstream is configured as Git remote `upstream` at `https://github.com/alexemanuelol/rustplusplus.git`.
- Optional fork features integrate only through `src/plugins/pluginManager.js`; core handlers must not import individual feature plugins.
- Deep Sea state/detection and custom fork commands live behind the plugin boundary. The base `MapMarkers` and `RustPlus` structures must not carry duplicate Deep Sea implementations or runtime method monkey-patches.
- The Rust+ dependency remains pinned to `alexemanuelol/rustplus.js#089cfd3` because it is version 2.5.0 plus Proto3/current-server compatibility fixes absent from Liam's current master. Any replacement must pass the protocol compatibility fixtures first.
- `npm test` runs deterministic Node tests before the TypeScript no-emit check. `npm run benchmark:plugins` measures dispatch overhead.
- TypeScript uses the paired `module: Node16` and `moduleResolution: Node16` settings. The package has no ESM `type`, so Node16 preserves its CommonJS runtime while avoiding the deprecated `node`/`node10` resolver.
- The repository enforces UTF-8/LF through `.gitattributes` and `.editorconfig` for Linux compatibility. Keep `update.sh` tracked as executable (`100755`).
- A `Crate = 6` marker is not treated as a vanilla airdrop without a captured Rust+ fixture proving that mapping.
- Event notification buttons expose their state in their label: green/`ENABLED` means active and red/`DISABLED` means inactive. Discord, in-game, and voice outputs remain independent; in-game event notifications stay disabled by default.
- Event delivery queues enabled in-game output before Discord/voice and isolates failures per output; an optional delivery failure must not cancel the other enabled outputs.

## Discord setup and permissions
- Restarting the bot must not reset existing Rust++ Discord category/channel permission overwrites and make private channels public again.
- Startup setup should preserve current overwrites for existing category/channels. Permissions are applied automatically only when creating missing category/channels or during first-time setup.
- Explicit `/role` and `/reset` commands may still intentionally recalculate permissions.

## Battlemetrics behavior
- Discord spam from repeated `Battlemetrics Server Name Changed` notifications was suppressed by disabling that notification and defaulting `battlemetricsServerNameChanges` to `false`.
- Battlemetrics server names are still updated/recovered internally; only the Discord notification/alarm for `server_name` changes is suppressed.

## Raid alarm plugin localization
- Raid alarm plugin messages translate the standard `You're getting raided!` title through `baseIsUnderAttack` and translate `X destroyed at Y` payloads through `raidAlarmDestroyedAt`.
- The supported server plugin is haggbart Raid Alarm `0.4.2`, which sends Rust+ FCM alerts directly to TC-authorized players via `Util.TryGetServerPairingData()` and does not require a vanilla Smart Alarm entity.
- Raid Alarm FCM handling lives behind `src/plugins/raidAlarm`. It recognizes the canonical title or body, honors `smartAlarmNotifyInGame`, queues in-game delivery before Discord, and isolates delivery failures.
- As verified on 2026-09-07, Raid Alarm 0.4.2 is the only external Rust server mod with an explicit bot integration. The canonical inventory is `docs/external_mod_compatibility.md`; Deep Sea and Smart Alarm are vanilla Rust features, while Hidden Vendors, AutoTranslate, and Teammate Language Database are bot-local.
- Item names from FCM/plugin payloads remain as provided because the payload does not include stable item IDs.
- Bot-originated Rust team-chat broadcasts should be identified by queued-message matches or the `[BOT]` brand on messages from the paired Rust+ SteamID, not by SteamID alone, and must not be recorded as player-language observations or relayed back through Discord/team-chat autotranslate or command handling. Autotranslate should also ignore bot-branded messages so command replies such as `!hv` are not translated back into team chat while still allowing the paired Rust+ SteamID to issue commands.
- Hidden vendor tracking should exclude Deep Sea event vending-machine markers. Deep Sea vendors are NPC/event vendors, not player vending machines, and should not appear as temporary/water-suspect hidden vendors.
- On successful Rust+ connection startup, the bot should announce `rustplusOperational` into Rust team chat after the first poll completes and `isOperational` becomes true.
- Teammate death notifications should preserve a grid location whenever possible, falling back from the previous cached player position to the updated team payload position before using `spawn`.
- Hidden vendor commands (`!hv`, `!hvw`, `!hvt`) should prune/filter Deep Sea NPC vending-machine data from both newly detected vendors and existing hidden-vendor storage. Known Deep Sea vendor names observed in `docs/rust_event_rpp_bot.json` include Attire shop, Bandit Weapons Shop, Main Food Shop, Farming shop, Weapons Shop, Boat Vendor, Fish Exchange, Fishing shop, Medical shop, and Casino Bar Shopkeeper; only treat these as Deep Sea exclusions when off-map.
