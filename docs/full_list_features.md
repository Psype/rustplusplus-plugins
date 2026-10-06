# Full list of Features

## Discord Slash Commands

All commands in this section are Discord-only. Player-identity administration replies ephemerally and never sends its
review/correction output to Rust team chat.

- **/alarm** - Change image of paired Smart Alarms.
- **/alias** - Create an alias for a command/sequence of characters.
- **/blacklist** - Blacklist a user from using the bot.
- **/cctv** - Get cctv camera codes for monuments.
- **/craft** - Display the cost to craft an item.
- **/credentials** - Setup Credentials.
- **/decay** - Display the decay time of an item.
- **/despawn** - Display the despawn time of an item.
- **/help** - Get help message.
- **/intel** - Privately list identities without a verified SteamID, grouping aliases already joined by BattleMetrics; reconcile them to a verified identity, inspect verified alias history, review links, or revoke a correction. Discord is acknowledged before logging or journal reads.
- **/intelimport** - OCR, preview, and confirm `/cinfo` or F7 screenshots without fixed pixel coordinates.
- **intel-imports channel** - Drop 1–10 screenshots manually or through the allowlisted Windows region-capture
  webhook, or paste 1–100 complete SteamID64 values with one ID per line. F7 versus `/cinfo` and repeated `/cinfo`
  panels are detected semantically; every image or text batch still requires a Discord confirmation. Renaming the
  configured channel (for example to `intel-reports`) is safe because routing uses its Discord ID. Confirmed text IDs
  receive restart-safe, one-per-tick scoped WarBandits enrichment; the background wipe leaderboard also collects names
  and cumulative hours without treating them as online presence. The same background cycle refreshes at most one
  known Steam profile per tick and per wipe, preserving its current persona and returned past aliases as verified
  history without making them presence evidence. Failed Steam requests advance fairly to the next ID and are
  explicitly retryable with `!scanplayers`. Reposting an identical text lot shows current local enrichment and keeps
  the original evidence; only changed image interpretations use Replace/Keep.
- **/item** - Get the details of an item.
- **/leader** - Transfer leadership.
- **/map** - Display the In-Game Map.
- **/players** - Get Battlemetrics data on all connected players.
- **/recycle** - Display the output of recycling an item.
- **/research** - Display the cost to research an item.
- **/reset** - Reset Discord Channels.
- **/role** - Setup a specific role to use rustplusplus.
- **/stack** - Display stack size information for an item.
- **/storagemonitor** - Change image of paired Storage Monitors.
- **/switch** - Change image of paired Storage Monitors.
- **/upkeep** - Get the upkeep cost of an item.
- **/uptime** - Get the current uptime for rustplusplus.
- **/voice** - Let rustplusplus join voicechat.

### Discord-only player identity examples

- `/intel pending page:1` lists one row per unresolved identity. Aliases sharing a BattleMetrics ID are grouped; for
  example `FUNTIK`, `gus`, and `+=import&**` on `BM:1192585926` count as one identity and three aliases.
- `/intel merge alias:ChiCo target:Ch1co` performs an exact, reversible correction against an existing verified target.
- `/intel link alias:ChiCo steamid:76561198154738095` performs the same correction when the SteamID64 is known directly.
- `/intel history target:Ch1co page:1` lists only dated Steam/API-verified names. Steam Community names are labelled
  `[current Steam name]` or `[past Steam alias]`; the command never promotes `ChiCo` merely because that typo was
  merged.
- `/intel links page:1` audits active rules, and `/intel unlink alias:ChiCo` revokes a wrong rule without deleting data.
- `/intelimport cinfo image:<file>` and `/intelimport f7 image:<file>` create private previews that must be confirmed.
  F7 never proves presence; each `/cinfo` panel uses its own GMT `Established`, not the upload date, to derive its wipe.

## In-Game and Discord Commands
- **afk** - `!afk` - Display AFK teammates.
- **alive** - `!alive` - Display who has been alive longest.
- **autotranslate** - `!autotranslate on [language[,language...]]` or `!autotranslate off` - Translate a teammate only when the message matches one of their recorded languages and the active translation pair; relay the result to Rust team chat and Discord. Providers get at most two seconds each and the complete fallback chain is capped at five seconds.
- **commands/help** - `!commands [command]` or `!help [command]` - List all commands or show the documented synopsis and description for one command.
- **connection/connections** - `!connection [steamid]` or `!connections` - Display latest team connections.
- **activity** - `!activity [SteamID64|BattleMetrics ID|partial name] [1mo|all]` - Show conservative known-online time from the local event history; `1mo` is the default rolling 30 days.
- **affinity** - `!affinity [SteamID64|BattleMetrics ID|partial name]` - Show compact confirmed `Known tags` and `Played with` counts.
- **clan** - `!clan [ClanTag]` - Show the latest confirmed stored snapshot for a ClanTag.
- **clanhistory** - `!clanhistory [ClanTag]` - Show the five latest stored snapshots for a ClanTag.
- **clantop** - `!clantop [1-10]` - Rank observed ClanTags by distinct confirmed snapshots.
- **craft** - `!craft [item] [quantity]` - Display the cost to craft an item.
- **death/deaths** - `!death [steamid]` or `!deaths` - Display latest deaths.
- **decay** - `!decay [item]` - Display the decay time of an item.
- **despawn** - `!despawn [item]` - Display the despawn time of an item.
- **language** - `!language [code]` - Show or change the bot language for this server.
- **intel** - `!intel [SteamID64|BattleMetrics ID|partial name]` - Return the closest known identity without a selector and show its complete compact local profile: current identity, verified current/past aliases, reliable presence, known tags, repeated clanmates, and rolling activity.
- **leader** - `!leader [teammate]` - Transfer leadership.
- **logs** - `!logs [on|off]` - Show, enable, or disable bot file/debug logging.
- **marker/markers** - `!marker [name]` or `!markers` - Set markers to navigate to.
- **mute** - `!mute` - Mute rustplusplus in-game.
- **note/notes** - `!note [text]` or `!notes` - Add or list notes.
- **offline** - `!offline` - Display offline teammates.
- **online** - `!online` - Display online teammates.
- **player/players** - `!player [name]` or `!players` - Get Battlemetrics information about players.
- **pop** - `!pop` - Get population of the server.
- **prox** - `!prox` - Display teammates that are nearby.
- **alarmstatus** - `!alarmstatus` - Show alarm transport/history and, until pairing is proven, watch 120 seconds for a matching active-server Pair notification.
- **raidtest** - `!raidtest` - Send a critical test alert through the same immediate Rust team-chat path used by FCM raid alarms.
- **record** - `!record [SteamID64] [BattleMetrics ID] [exact name]` - Add one verified manual identity link to the active server intelligence database.
- **recycle** - `!recycle [item] [quantity]` - Display the output of recycling an item.
- **research** - `!research [item]` - Display the cost to research an item.
- **send** - `!send [discord user] [message]` - Send a message through rustplusplus to a person on Discord.
- **stack** - `!stack [item]` - Display stack size information for an item.
- **scanplayers** - `!scanplayers` - Trigger or queue an immediate bounded background identity rescan for the active wipe.
- **steamid** - `!steamid [SteamID64|BattleMetrics ID|partial name]` - Compatibility alias for the complete `!intel` server-wide profile.
- **team** - `!team` - Get team information (names of all teammates).
- **time** - `!time` - Get in-game time.
- **timer/timers** - `!timer [duration] [message]` or `!timers` - Set or list timers.
- **track** - `!track [partial player name|SteamID64]` - Resolve a player on the current BattleMetrics server, prioritizing currently-online name matches over historical offline profiles, enrich it on demand from WarBandits when supported, and start BattleMetrics online/offline tracking. Re-adding a proven SteamID/BattleMetrics identity enriches the existing entry instead of duplicating it. When several equally ranked players match, use `!track #[number]` or `!track [same partial name] [number]`.
- **trackhistory** - `!trackhistory [tracked player]` - Show recent BattleMetrics Premium sessions for a tracked player on the active server.
- **trackinfo** - `!trackinfo [tracked player]` - Show the BattleMetrics Premium server-specific summary for a tracked player.
- **tracklist/tracks** - `!tracklist [all]` or `!tracks [all]` - Queue every tracked player over minimal bounded messages. Without an argument, show compact `name: status/age` entries; add `all` for packed `name,BattleMetricsID,SteamID,status` records (`-` means unknown SteamID; status is `on`, `off:<age>`, or `unk:<age>`).
- **trackrelated** - `!trackrelated [tracked player]` - Show BattleMetrics co-play results without inferring team membership.
- **tr** - `!tr [language] [text]` - Translate from English to another language.
- **trf** - `!trf [from] [to] [text]` - Translate from one language to another.
- **tts** - `!tts [message]` - Send text-to-speech to Discord teamchat.
- **untrack** - `!untrack [partial player name|BattleMetrics ID|SteamID64]` - Stop tracking one player.
- **unmute** - `!unmute` - Unmute rustplusplus in-game.
- **upkeep** - `!upkeep` - Check upkeep of Storage Monitor Tool Cupboards.
- **uptime** - `!uptime` - Display the uptime of rustplusplus and currently connected server.
- **who** - `!who [SteamID64|BattleMetrics ID|partial name]` - Select the closest known identity and list only its verified Steam/API aliases.
- **wipe** - `!wipe` - Display time since wipe.

### Player identity examples with the in-game prefix

- `!intel tree` returns the closest read-only profile, for example `Cockornut Tree`, without a selector or mutation.
- `!who ch1` lists only verified Steam/API aliases and omits pending OCR spellings such as `ChiCo`.
- `!affinity tree` shows confirmed `Known tags` and `Played with` counts; different captures add, while one merged person
  counts once inside the same capture.
- `!activity tree` uses a rolling month; `!activity tree all` uses all retained known-online evidence.
- `!track peng` uses precise matching. If it returns several equal candidates, use `!track #2` or `!track peng 2`.
- `!record <SteamID64> <BattleMetrics ID> <exact name>` is for a proven exact triple, not OCR correction. Use the
  Discord-only `/intel merge` flow to reconcile a typo privately and reversibly.

## Smart Devices
> Pair Smart Devices such as `Smart Switches`, `Smart Alarms`, `Storage Monitors` and control them from Discord or In-Game teamchat.

- See [Smart Switches](smart_devices.md#smart-switches).
- See [Smart Switch Groups](smart_devices.md#smart-switch-groups).
- See [Smart Alarms](smart_devices.md#smart-alarms).
- See [Storage Monitors](smart_devices.md#storage-monitors).


## Rust Server Information
- See number of players, max capacity and queue size of the Rust Server.
- See the In-Game time and time till day/night.
- See how long ago wipe was.
- See Map Size.
- See Map Seed.
- See Map Salt.
- See Map Name.
- F1 console connect information.

## Unavailable Rust+ map capabilities

Since Facepunch's 2026-08-06 Power Trip update, the public Rust+ stream no longer supplies the event and
vending-machine markers needed for Cargo Ship, Patrol Helicopter, Chinook, Oil Rig, Deep Sea, travelling vendor,
market, or hidden-vendor state. Their commands are disabled and omitted from the active command catalog so the bot
cannot present stale history as current information. Discord also hides the corresponding slash command, live-event
panel, notification cards, vending-item option, and Cargo/Oil Rig timers. Historical handlers and saved preferences
remain isolated for a future authoritative signal. See
[the payload audit](rustplus_payload_audit_2026-09-10.md) for captured evidence.

## Teammate Information
> Get information about teammates such as Online/Offline/AFK/Alive/Dead/Location/Paired/Leader.

## Other
- Connect through different Rust Servers seemingly through the `servers` Text-Channel in Discord.
- Easily access rustplusplus settings via the Discord Text-Channel `settings`.
- Run In-Game commands either from In-Game teamchat or from Discord Text-Channel `commands`.
- Communicate with teammates from In-Game to Discord and vice versa.
- Get activity information in the `activity` Text-Channel on Discord. Information such as Smart Devices not reachable, Teammate connect/disconnect/leave/join/death, Smart Alarms notify when triggered, Server went offline/online, Map Wipe Detection, Storage Monitor Decay Notification, Tracker notifications etc...
- Create Battlemetrics Trackers to track players or groups.
- Get Facepunch news in Discord.
