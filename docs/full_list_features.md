# Full list of Features

## Discord Slash Commands
- **/alarm** - Change image of paired Smart Alarms.
- **/alias** - Create an alias for a command/sequence of characters.
- **/blacklist** - Blacklist a user from using the bot.
- **/cctv** - Get cctv camera codes for monuments.
- **/craft** - Display the cost to craft an item.
- **/credentials** - Setup Credentials.
- **/decay** - Display the decay time of an item.
- **/despawn** - Display the despawn time of an item.
- **/help** - Get help message.
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

## In-Game and Discord Commands
- **afk** - `!afk` - Display AFK teammates.
- **alive** - `!alive` - Display who has been alive longest.
- **autotranslate** - `!autotranslate on [language[,language...]]` or `!autotranslate off` - Translate a teammate only when the message matches one of their recorded languages and the active translation pair; relay the result to Rust team chat and Discord.
- **commands/help** - `!commands [command]` or `!help [command]` - List all commands or show the documented synopsis and description for one command.
- **connection/connections** - `!connection [steamid]` or `!connections` - Display latest team connections.
- **craft** - `!craft [item] [quantity]` - Display the cost to craft an item.
- **death/deaths** - `!death [steamid]` or `!deaths` - Display latest deaths.
- **decay** - `!decay [item]` - Display the decay time of an item.
- **despawn** - `!despawn [item]` - Display the despawn time of an item.
- **language** - `!language [code]` - Show or change the bot language for this server.
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
- **raidtest** - `!raidtest` - Send a critical test alert through the same immediate Rust team-chat path used by FCM raid alarms.
- **record** - `!record [steamid] [pseudonym]` - Add a pseudonym; player languages are edited directly in the teammate CSV.
- **recycle** - `!recycle [item] [quantity]` - Display the output of recycling an item.
- **research** - `!research [item]` - Display the cost to research an item.
- **send** - `!send [discord user] [message]` - Send a message through rustplusplus to a person on Discord.
- **stack** - `!stack [item]` - Display stack size information for an item.
- **steamid** - `!steamid [teammate]` - Get teammate SteamID.
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
- **who** - `!who [steamid]` - List known pseudonyms for a SteamID from the teammate language CSV database.
- **wipe** - `!wipe` - Display time since wipe.

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
cannot present stale history as current information. Historical handlers remain isolated for a future authoritative
signal. See [the payload audit](rustplus_payload_audit_2026-09-10.md) for captured evidence.

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
