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
- **/market** - Search for or subscribe to items in vending machines.
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
- **cargo** - `!cargo` - Display information regarding Cargoship.
- **chinook** - `!chinook` - Display information regarding Chinook 47.
- **commands/help** - `!commands [command]` or `!help [command]` - List all commands or show the documented synopsis and description for one command.
- **connection/connections** - `!connection [steamid]` or `!connections` - Display latest team connections.
- **craft** - `!craft [item] [quantity]` - Display the cost to craft an item.
- **death/deaths** - `!death [steamid]` or `!deaths` - Display latest deaths.
- **decay** - `!decay [item]` - Display the decay time of an item.
- **despawn** - `!despawn [item]` - Display the despawn time of an item.
- **deepsea** - `!deepsea` - Track Deep Sea activity from off-map vendor clusters and predict open/close windows.
- **events** - `!events [event]` - Get recent events and event timing summaries.
- **heli** - `!heli` - Get information regarding Patrol Helicopter.
- **hv/hvw/hvt** - `!hv` / `!hvw` / `!hvt` - Show former vendor locations grouped by grid; `!hvw` filters short-lived water suspects and `!hvt` sorts by shortest broadcast time.
- **language** - `!language [code]` - Show or change the bot language for this server.
- **large** - `!large` - Get information regarding Large Oil Rig.
- **leader** - `!leader [teammate]` - Transfer leadership.
- **logs** - `!logs [on|off]` - Show, enable, or disable bot file/debug logging.
- **marker/markers** - `!marker [name]` or `!markers` - Set markers to navigate to.
- **market** - `!market [item]` - Search for or subscribe to items in vending machines.
- **mute** - `!mute` - Mute rustplusplus in-game.
- **note/notes** - `!note [text]` or `!notes` - Add or list notes.
- **offline** - `!offline` - Display offline teammates.
- **online** - `!online` - Display online teammates.
- **player/players** - `!player [name]` or `!players` - Get Battlemetrics information about players.
- **pop** - `!pop` - Get population of the server.
- **prox** - `!prox` - Display teammates that are nearby.
- **record** - `!record [steamid] [pseudonym]` - Add a pseudonym; player languages are edited directly in the teammate CSV.
- **recycle** - `!recycle [item] [quantity]` - Display the output of recycling an item.
- **research** - `!research [item]` - Display the cost to research an item.
- **send** - `!send [discord user] [message]` - Send a message through rustplusplus to a person on Discord.
- **small** - `!small` - Get information regarding Small Oil Rig.
- **stack** - `!stack [item]` - Display stack size information for an item.
- **steamid** - `!steamid [teammate]` - Get teammate SteamID.
- **team** - `!team` - Get team information (names of all teammates).
- **time** - `!time` - Get in-game time.
- **timer/timers** - `!timer [duration] [message]` or `!timers` - Set or list timers.
- **track** - `!track [partial player name|SteamID64]` - Resolve a player on the current BattleMetrics server, prioritizing currently-online name matches over historical offline profiles, enrich it on demand from WarBandits when supported, and start BattleMetrics online/offline tracking. Re-adding a proven SteamID/BattleMetrics identity enriches the existing entry instead of duplicating it. When several equally ranked players match, use `!track #[number]` or `!track [same partial name] [number]`.
- **trackhistory** - `!trackhistory [tracked player]` - Show recent BattleMetrics Premium sessions for a tracked player on the active server.
- **trackinfo** - `!trackinfo [tracked player]` - Show the BattleMetrics Premium server-specific summary for a tracked player.
- **tracklist/tracks** - `!tracklist` or `!tracks` - List tracked players with online or last-seen status.
- **trackrelated** - `!trackrelated [tracked player]` - Show BattleMetrics co-play results without inferring team membership.
- **tr** - `!tr [language] [text]` - Translate from English to another language.
- **trf** - `!trf [from] [to] [text]` - Translate from one language to another.
- **tts** - `!tts [message]` - Send text-to-speech to Discord teamchat.
- **untrack** - `!untrack [partial player name|BattleMetrics ID|SteamID64]` - Stop tracking one player.
- **unmute** - `!unmute` - Unmute rustplusplus in-game.
- **upkeep** - `!upkeep` - Check upkeep of Storage Monitor Tool Cupboards.
- **uptime** - `!uptime` - Display the uptime of rustplusplus and currently connected server.
- **vendor** - `!vendor` - Get information regarding the Traveling Vendor.
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

## In-Game Event Notifications
> **Current Rust+ limitation (since 2026-08-06):** Facepunch no longer sends vending-machine or event map markers
> (cargo, helicopters, travelling vendor) through the public Rust+ stream. The capabilities below are retained for
> protocol history, but cannot receive new live state unless Facepunch restores the signal or the server provides a
> separately integrated authoritative bridge.

> Receive notifications for In-Game Events such as:
- **Cargo Ship** - When it spawns, despawns, how long before it enters egress stage. How long time since it was last out. step-trace.
- **Patrol Helicopter** - When it spawns, despawns or gets taken down. How long time since it was last out and how long since it was taken down. step-trace.
- **Oil Rig** - When Oil Rig calls in Heavy Scientists and how long till the Locked Crate unlocks.
- **Chinook 47** - When it enters map and when it leaves.
- **Vending Machines** - Whenever a new Vending Machine appears on the map.

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
