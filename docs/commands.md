# Commands Documentation

> Commands can be executed via Discord or In-Game Team Chat. To be able to run Slash Commands in Discord, you need to be part of the designated Discord Role for the bot. If no role is set for the bot then everyone should be able to use the Slash Commands by default. To be able to run In-Game Commands, you need to be in the same In-Game Team as the hoster. In-Game Commands can only be run from Team Chat, not global chat. You can also run In-Game commands from the Discord Text-Channel `commands`.

- [Discord Slash Commands](commands.md#discord-slash-commands)
- [In-Game and Discord Commands](commands.md#in-game-and-discord-commands)

# Discord Slash Commands

Slash Command | Description
------------- | -----------
[**/alarm**](commands.md#alarm) | Operations on Smart Alarms.
[**/alias**](commands.md#alias) | Create an alias for a command/sequence of characters.
[**/blacklist**](commands.md#blacklist) | Blacklist a user from using the bot.
[**/cctv**](commands.md#cctv) | Posts CCTV codes for a monument.
[**/craft**](commands.md#craft) | Display the cost to craft an item.
[**/credentials**](commands.md#credentials) | Set/Clear the Credentials for the user account.
[**/decay**](commands.md#decay) | Display the decay time of an item.
[**/despawn**](commands.md#despawn) | Display the despawn time of an item.
[**/help**](commands.md#help) | Display help message.
[**/item**](commands.md#item) | Get the details of an item.
[**/leader**](commands.md#leader) | Give or take the leadership from/to a team member.
[**/map**](commands.md#map) | Get the currently connected server map image.
[**/market**](commands.md#market) | Operations for In-Game Vending Machines.
[**/players**](commands.md#players) | Get player/players information based on battlemetrics.
[**/recycle**](commands.md#recycle) | Display the output of recycling an item.
[**/research**](commands.md#research) | Display the cost to research an item.
[**/reset**](commands.md#reset) | Reset Discord channels.
[**/role**](commands.md#role) | Set/Clear a specific role that will be able to see the rustplusplus category content.
[**/stack**](commands.md#stack) | Display stack size information for an item.
[**/storagemonitor**](commands.md#storagemonitors) | Operations on Storage Monitors.
[**/switch**](commands.md#switch) | Operations on Smart Switches.
[**/upkeep**](commands.md#upkeep) | Get the upkeep cost of an item.
[**/uptime**](commands.md#uptime) | Display uptime of the bot and server.
[**/voice**](commands.md#voice) | Operations on Voice Feature.


## **/alarm**

> **Operations on Smart Alarms.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`edit` | &nbsp; | Edit the properties of a Smart Alarm. | &nbsp;
&nbsp; | `id` | The ID of the Smart Alarm. | `True`
&nbsp; | `image` | Set the image that best represent the Smart Alarm. | `True`

![Discord Slash Command alarm Image](images/slash_commands/alarms_edit.png)


## **/alias**

> **Create an alias for a command/sequence of characters.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`add` | &nbsp; | Add an alias. | &nbsp;
&nbsp; | `alias` | The alias to use. | `True`
&nbsp; | `value` | The command/sequence of characters. | `True`
`remove` | &nbsp; | Remove an alias. | &nbsp;
&nbsp; | `index` | The index of the alias to remove. | `True`
`show` | &nbsp; | Show all registered aliases. | &nbsp;

![Discord Slash Command alias Image](images/slash_commands/alias.png)


## **/blacklist**

> **Blacklist a user from using the bot.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`add` | &nbsp; | Add user to the blacklist. | &nbsp;
&nbsp; | `discord_user` | The discord user. | `False`
&nbsp; | `steamid` | The steamid of the user. | `False`
`remove` | &nbsp; | Remove user from the blacklist. | &nbsp;
&nbsp; | `discord_user` | The discord user. | `False`
&nbsp; | `steamid` | The steamid of the user. | `False`
`show` | &nbsp; | Show blacklisted users. | &nbsp;

![Discord Slash Command blacklist Image](images/slash_commands/blacklist.png)


## **/cctv**

> **Posts CCTV codes for a monument.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
&nbsp; | `monument` | Rust monument. | `True`

![Discord Slash Command monument Image](images/slash_commands/cctv.png)


## **/craft**

> **Display the cost to craft an item.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
&nbsp; | `name` | The name of the item to craft. | `False`
&nbsp; | `id` | The id of the item to craft. | `False`
&nbsp; | `quantity` | The quantity of items to craft. | `False`

![Discord Slash Command craft Image](images/slash_commands/craft.png)


## **/credentials**

> **Add/Remove the Credentials for the user account.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`add` | &nbsp; | Add Credentials. | &nbsp;
&nbsp; | `gcm_android_id` | GCM Android ID. | `True`
&nbsp; | `gcm_security_token` | GCM Security Token. | `True`
&nbsp; | `steam_id` | Steam ID. | `True`
&nbsp; | `issued_date` | Issued date of the credentials. | `True`
&nbsp; | `expire_date` | Expire date of the credentials. | `True`
&nbsp; | `hoster` | Should be hoster. | `False`
`remove` | &nbsp; | Remove Credentials. | &nbsp;
&nbsp; | `steam_id` | Steam ID. | `False`
`show` | &nbsp; | Show all registered Credentials. | &nbsp;
`set_hoster` | &nbsp; | Set the hoster. | &nbsp;
&nbsp; | `steam_id` | Steam ID. | `False`

![Discord Slash Command credentials Image](images/slash_commands/credentials.png)


## **/decay**

> **Display the decay time of an item.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
&nbsp; | `name` | The name of the item. | `False`
&nbsp; | `id` | The id of the item. | `False`
&nbsp; | `hp` | THe current HP of the item. | `False`

![Discord Slash Command decay Image](images/slash_commands/decay.png)


## **/despawn**

> **Display the despawn time of an item.**

Options | Description | Required
------- | ----------- | --------
`name` | The name of the item. | `False`
`id` | The id of the item. | `False`


## **/help**

> Display help message.

![Discord Slash Command help Image](images/slash_commands/help.png)


## **/item**

> **Get the details of an item.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
&nbsp; | `name` | The name of the item. | `False`
&nbsp; | `id` | The id of the item. | `False`

![Discord Slash Command item Image](images/slash_commands/item.png)


## **/leader**

> **Give or take the leadership from/to a team member.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
&nbsp; | `member` | The name of the team member. | `True`

![Discord Slash Command leader Image](images/slash_commands/leader.png)


## **/map**

> **Get the currently connected server map image.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`all` | &nbsp; | Get the map including both monument names and markers. | &nbsp;
`clean` | &nbsp; | Get the clean map. | &nbsp;
`monuments`| &nbsp; | Get the map including monument names. | &nbsp;
`markers` | &nbsp; | Get the map including markers. | &nbsp;

![Discord Slash Command map Image](images/slash_commands/map.png)


## **/market**

> **Operations for In-Game Vending Machines.**.

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`search` | &nbsp; | Search for an item in Vending Machines. | &nbsp;
&nbsp; | `order` | The order type to search for (all, buy, sell). | `True`
&nbsp; | `name` | The name of the item to search for. | `False`
&nbsp; | `id` | The ID of the item to search for. | `False`
`subscribe` | &nbsp; | Subscribe to an item in Vending Machines. | &nbsp;
&nbsp; | `order` | The order type (all, buy, sell). | `True`
&nbsp; | `name` | The name of the item to subscribe to. | `False`
&nbsp; | `id` | The ID of the item to subscribe to. | `False`
`unsubscribe` | &nbsp; | Unsubscribe to an item in Vending Machines. | &nbsp;
&nbsp; | `order` | The order type (all, buy, sell). | `True`
&nbsp; | `name` | The name of the item to unsubscribe to. | `False`
&nbsp; | `id` | The ID of the item to unsubscribe to. | `False`
`list` | &nbsp; | Display the subscription list. | &nbsp;

![Discord Slash Command market Image](images/slash_commands/market.png)


## **/players**

> **Get player/players information based on Battlemetrics.** Calling the subcommand name without the name option will display all players depending on status option. By calling the subcommand playerid, you will get more specific information about a single player.

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`name` | &nbsp; | Search for a player on Battlemetrics based on player name. | &nbsp;
&nbsp; | `status` | Search for players that are online/offline/any. | `True`
&nbsp; | `name` | The name of the player. | `False`
&nbsp; | `battlemetricsid` | The Battlemetrics ID of the server (default: The connected server). | `False`
`playerid` | &nbsp; | Search for a player on Battlemetrics based on player id. | &nbsp;
&nbsp; | `playerid` | The player id of the player. | `True`
&nbsp; | `battlemetricsid` | The Battlemetrics ID of the server (default: The connected server). | `False`

![Discord Slash Command players Image](images/slash_commands/players.png)
![Discord Slash Command players all players Image](images/slash_commands/players_all_players.png)
![Discord Slash Command players specific user Image](images/slash_commands/players_specific_user.png)


## **/recycle**

> **Display the output of recycling an item.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
&nbsp; | `name` | The name of the item to recycle. | `False`
&nbsp; | `id` | The id of the item to recycle. | `False`
&nbsp; | `quantity` | The quantity of items to recycle. | `False`

![Discord Slash Command recycle Image](images/slash_commands/recycle.png)


## **/research**

> **Display the cost to research an item.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
&nbsp; | `name` | The name of the item to research. | `False`
&nbsp; | `id` | The id of the item to research. | `False`

![Discord Slash Command research Image](images/slash_commands/research.png)


## **/reset**

> **Reset Discord channels.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`discord` | &nbsp; | Reset discord channels. | &nbsp;
`information` | &nbsp; | Reset information channel. | &nbsp;
`servers` | &nbsp; | Reset servers channel. | &nbsp;
`settings` | &nbsp; | Reset settings channel. | &nbsp;
`switches` | &nbsp; | Reset switches channels. | &nbsp;
`alarms` | &nbsp; | Reset alarms channel. | &nbsp;
`storagemonitors` | &nbsp; | Reset storagemonitors channel. | &nbsp;
`trackers` | &nbsp; | Reset trackers channel. | &nbsp;

![Discord Slash Command reset Image](images/slash_commands/reset.png)


## **/role**

> **Set/Clear a specific role that will be able to see the rustplusplus category content.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`set` | &nbsp; | Set the role. | &nbsp;
&nbsp; | `role` | The role rustplusplus channels will be visible to. | `True`
`clear` | &nbsp; | Clear the role (to allow everyone to see the rustplusplus channels). | &nbsp;

![Discord Slash Command role Image](images/slash_commands/role.png)


## **/stack**

> **Display stack size information for an item.**

Options | Description | Required
------- | ----------- | --------
`name` | The name of the item. | `False`
`id` | The id of the item. | `False`


## **/storagemonitors**

> **Operations on Storage Monitors.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`edit` | &nbsp; | Edit the properties of a Storage Monitor. | &nbsp;
&nbsp; | `id` | The ID of the Storage Monitor. | `True`
&nbsp; | `image` | Set the image that best represent the Storage Monitor. | `True`

![Discord Slash Command storagemonitor Image](images/slash_commands/storagemonitor.png)


## **/switch**

> **Operations on Smart Switches.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`edit` | &nbsp; | Edit the properties of a Smart Switch. | &nbsp;
&nbsp; | `id` | The ID of the Smart Switch. | `True`
&nbsp; | `image` | Set the image that best represent the Smart Switch. | `True`

![Discord Slash Command switch Image](images/slash_commands/switch.png)


## **/upkeep**

> **Get the upkeep cost of an item.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
&nbsp; | `name` | The name of the item. | `False`
&nbsp; | `id` | The id of the item. | `False`

![Discord Slash Command upkeep Image](images/slash_commands/upkeep.png)


## **/uptime**

> **Display uptime of the bot and server.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`bot` | &nbsp; | Display uptime of bot. | &nbsp;
`server` | &nbsp; | Display uptime of server. | &nbsp;

![Discord Slash Command uptime Image](images/slash_commands/uptime.png)

## **/voice**

> **Operations on Voice Feature.**

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`join` | &nbsp; | Bot Joins a Voicechannel. | &nbsp;
`leave` | &nbsp; | Bot Leaves a Voicechannel. | &nbsp;

![Discord Slash Command uptime Image](images/slash_commands/voice.png)


# In-Game and Discord Commands

These commands work in Rust team chat and in the configured Discord commands channel unless a command section says otherwise.

Command | Description
------- | -----------
[**afk**](commands.md#afk) | Get the currently afk players in your team.
[**alive**](commands.md#alive) | Get the player with the longest time alive.
[**autotranslate**](commands.md#autotranslate) | Automatically translate relayed team-chat messages in Discord.
[**cargo**](commands.md#cargo) | Get information about CargoShip (Location, time till enters egress stage, time since last on map).
[**chinook**](commands.md#chinook) | Get information about Chinook 47 (Location, time since last on map).
[**commands/help**](commands.md#commandshelp) | List available commands or show the documented synopsis and description for a command.
[**connection/connections**](commands.md#connectionconnections) | Get recent connection events.
[**craft**](commands.md#craft-ingame) | Display the cost to craft an item.
[**death/deaths**](commands.md#deathdeaths) | Get recent death events.
[**decay**](commands.md#decay-ingame) | Display the decay time of an item.
[**despawn**](commands.md#despawn-ingame) | Display the despawn time of an item.
[**deepsea**](commands.md#deepsea) | Track Deep Sea activity from the Rust+ map marker when exposed by the server.
[**events**](commands.md#events) | Get recent events.
[**heli**](commands.md#heli) | Get information about Patrol Helicopter (Location, time since last downed, time since last on map).
[**hv/hvw/hvt**](commands.md#hidden-vendors) | Show former vendor locations; `!hvw` filters water suspects and `!hvt` sorts by shortest broadcast time.
[**large**](commands.md#large) | Get information about Large Oil Rig (Time till crate unlocks, time since last trigger).
[**language**](commands.md#language) | Show or change the bot language for this server and config file.
[**leader**](commands.md#leader-1) | Give/Take the Team Leadership.
[**marker/markers**](commands.md#marker) | Set or list custom markers anywhere on the map.
[**market**](commands.md#market-ingame) | Search for items in vending machines or subscribe/unsubscribe to items.
[**logs**](commands.md#logs) | Show, enable, or disable bot file/debug logging.
[**mute**](commands.md#mute) | Mute the bot from the In-Game Team Chat.
[**note/notes**](commands.md#notenotes) | Create notes about meaningful things.
[**offline**](commands.md#offline) | Get the currently offline players in your team.
[**online**](commands.md#online) | Get the currently online players in your team.
[**player/players**](commands.md#playerplayers) | Get the names and playtime of the currently online players on the server (Based on Battlemetrics).
[**pop**](commands.md#pop) | Get the current population of the server including queue size and max population.
[**prox**](commands.md#prox) | Get the distance to the three closest teammates.
[**recycle**](commands.md#recycle-ingame) | Display the output of recycling an item.
[**research**](commands.md#research-ingame) | Display the cost to research an item.
[**record**](commands.md#record) | Manually record a SteamID and pseudonym in the teammate language CSV database.
[**send**](commands.md#send) | Send a message to a discord user.
[**small**](commands.md#small) | Get information about Small Oil Rig (Time till crate unlocks, time since last trigger).
[**stack**](commands.md#stack-ingame) | Display stack size information for an item.
[**steamid**](commands.md#steamid) | Get the steamid of a teammate.
[**team**](commands.md#team) | Get the names of all members in the team.
[**time**](commands.md#time) | Get the current time In-Game and time till day/night.
[**timer/timers**](commands.md#timer) | Set or list custom timers.
[**track**](commands.md#tracktrackinfotrackhistorytrackrelatedtracklisttracksuntrack) | Track an enemy's BattleMetrics online/offline state on the current server.
[**trackinfo**](commands.md#tracktrackinfotrackhistorytrackrelatedtracklisttracksuntrack) | Show the tracked player's server-specific Premium summary.
[**trackhistory**](commands.md#tracktrackinfotrackhistorytrackrelatedtracklisttracksuntrack) | Show the tracked player's recent sessions on the current server.
[**trackrelated**](commands.md#tracktrackinfotrackhistorytrackrelatedtracklisttracksuntrack) | Show bounded BattleMetrics co-play results without inferring team membership.
[**tracklist/tracks**](commands.md#tracktrackinfotrackhistorytrackrelatedtracklisttracksuntrack) | List tracked enemies and their last known presence.
[**tr**](commands.md#tr) | Translate a text to another language.
[**trf**](commands.md#trf) | Translate a text from one language to another.
[**tts**](commands.md#tts) | Send a Text-To-Speech message to the Discord teamchat channel.
[**untrack**](commands.md#tracktrackinfotrackhistorytrackrelatedtracklisttracksuntrack) | Remove an enemy from the player tracker.
[**unmute**](commands.md#unmute) | Unmute the bot from the In-Game Team Chat.
[**upkeep**](commands.md#upkeep) | Get the upkeep time of all connected tool cupboard monitors.
[**uptime**](commands.md#uptime-ingame) | Display uptime of the bot and server.
[**vendor**](commands.md#vendor) | Get information about the Traveling Vendor (Current Location, Time since last vendor)
[**wipe**](commands.md#wipe) | Get the time since it was wiped.
[**who**](commands.md#who) | List all known pseudonyms for a SteamID from the teammate language CSV database.



## **autotranslate**

> **Automatically translate Rust team-chat messages back into team chat and into the Discord relay.** `!autotranslate on` defaults to English. You can pass one target language, or two languages separated by a comma. With two targets, if the detected source language already matches one target, the other target is used; for example `!autotranslate on en,zh` translates Chinese messages to English and English messages to Chinese. Language names from the existing translation command are accepted, such as `english,chinese`, as well as language codes such as `en,zh`.
<br>Command: `!autotranslate on [language[,language...]]`
<br>Command: `!autotranslate off`
<br>Provider queue: Google Web -> DeepLX -> Bing Web -> MyMemory. Each provider is attempted once with a five-second deadline. `RPP_LIBRETRANSLATE_URL` replaces the public DeepLX step with a self-hosted LibreTranslate instance; set `RPP_LIBRETRANSLATE_API_KEY` too when that instance requires a key. No public LibreTranslate mirror is enabled by default because public availability is not reliable enough.
<br>Provider references (verified 2026-09-09): [Google Web adapter 9.2.1](https://github.com/vitalets/google-translate-api), [DeepLX 0.4.0 and its public REST service](https://github.com/un-ts/deeplx), [Bing Web adapter reference 4.2.1](https://github.com/plainheart/bing-translate-api/releases/tag/v4.2.1), [MyMemory REST specification](https://mymemory.translated.net/doc/spec.php), and [LibreTranslate self-hosting/API](https://docs.libretranslate.com/).
<br>Server live check: `npm run test:autotranslate:live` exercises the real detector, Google translation, forced real DeepLX/Bing/MyMemory fallbacks, the handler, Rust queue, and final send boundary without publishing to Rust or Discord.

## **afk**

> **Get the currently afk players in your team.** Definition of AFK for this command is inactivity (No change in XY-coordinate) for more than 5 minutes.
<br>Command: `!afk`

![In-Game Command afk Image](images/ingame_commands/afk_ingame.png)


## **alive**

> **Get the player with the longest time alive or the alive time of a teammate.**
<br>Command: `!alive`
<br>Command: `!alive Alle`

![In-Game Command alive Image](images/ingame_commands/alive_ingame.png)


## **cargo**

> **Get information about CargoShip (Location, time till enters egress stage, time since last on map).**
<br>Command: `!cargo`

![In-Game Command cargo Image](images/ingame_commands/cargo_ingame.png)


## **chinook**

> **Get information about Chinook 47 (Location, time since last on map).**
<br>Command: `!chinook`

![In-Game Command chinook Image](images/ingame_commands/chinook_ingame.png)



## **commands/help**

> **List available commands or show the documented synopsis and description for one command.** The command catalog is parsed from `docs/full_list_features.md` at runtime so both commands use the same canonical source. Aliases such as `tracks`, `hvw`, and `markers` are accepted. Works from in-game team chat and from the Discord commands channel.
<br>Command: `!commands [command]`
<br>Command: `!help [command]`
<br>Examples: `!help track`, `!help hv`, `!commands despawn`

## **connection/connections**

> **Get recent connection events of the team or from a specific teammate.**
<br>Command: `!connections`
<br>Command: `!connection Alle`

![In-Game Command connection Image](images/ingame_commands/connection_ingame.png)


## **craft ingame**

> **Display the cost to craft an item (Quantity is optional).**
<br>Command: `!craft <item-name> <quantity>`
<br>Command: `!craft Assault Rifle 10`
<br>Command: `!craft rocket 100`

![In-Game Command craft Image](images/ingame_commands/craft_ingame.png)


## **deepsea**

> **Track Deep Sea activity from the Rust+ map marker when exposed by the server.** When an off-map Deep Sea vendor cluster appears, the bot records it like other map events and `!deepsea` reports active/remaining status, last seen time, and an estimated next open window from default Deep Sea timing. Works from in-game team chat and from the Discord commands channel.
<br>Command: `!deepsea`


## **death/deaths**

> **Get recent death events of the team or from a specific teammate.**
<br>Command: `!deaths`
<br>Command: `!death Alle`

![In-Game Command death Image](images/ingame_commands/death_ingame.png)


## **decay ingame**

> **Display the decay time of an item.**
<br>Command: `!decay`
<br>Command: `!decay Sheet Metal Door`
<br>Command: `!decay Tug Boat 100`
<br>Command: `!decay armored wall 450`

![In-Game Command decay Image](images/ingame_commands/decay_ingame.png)


## **despawn ingame**

> **Display the despawn time of an item.** The item name can contain spaces.
<br>Command: `!despawn <item-name>`
<br>Example: `!despawn assault rifle`


## **events**

> **Get recent In-Game events.** Available events are cargo, heli, small, large, chinook/ch47, deepsea. Compatibility aliases include oil_rig_small and large_oil_rig.
<br>Command: `!events` - Get last 5 events
<br>Command: `!events 3` - Get last 3 events
<br>Command: `!events cargo` - Get last 5 events from cargo
<br>Command: `!events cargo 2` - Get last 2 events from cargo

![In-Game Command events Image](images/ingame_commands/events_ingame.png)


## **heli**

> **Get information about Patrol Helicopter (Location, time since last downed, time since last on map).**
<br>Command: `!heli`

![In-Game Command heli Image](images/ingame_commands/heli_ingame.png)



## **hidden vendors**

> **Show former vendor locations grouped by grid.** The bot records each vending-machine marker seen for the current server/map signature, keeps it after it disappears, and `!hv` reports former vendors that are not currently broadcasting. `!hvw` uses the same database but only includes short-lived former vendors, which are the best water-stash suspects. `!hvt` shows hidden vendors from shortest tracked broadcast time upward, helping find vendors that were visible for the least polling cycles. Vendors that never broadcast through Rust+ cannot be recovered. Works from in-game team chat and from the Discord commands channel.
<br>Command: `!hv`
<br>Command: `!hvw`
<br>Command: `!hvt`

## **large**

> **Get information about Large Oil Rig (Time till crate unlocks, time since last trigger).**
<br>Command: `!large`

![In-Game Command large Image](images/ingame_commands/large_ingame.png)


## **language**

> **Show or change the bot language.** This command works from in-game team chat and from Discord command chat with the configured prefix. It updates the current guild instance immediately and also rewrites the `config/index.js` language fallback, so switching back to English is `!language en`. If `RPP_LANGUAGE` is set in the environment, that environment variable still overrides the config file on restart.
<br>Command: `!language` - Show the current language and supported language codes.
<br>Command: `!language en` - Change this guild and the config fallback to English.
<br>Command: `!language zh` - Change this guild and the config fallback to Simplified Chinese.


## **leader**

> **Give/Take the Team Leadership.** Calling the leader command alone will give the caller leadership. You can also give the leadership to a team member by writing the name or part of the name after the command.
<br>`This command only works if the current leader is the person that setup the bot.`

Subcommand | Description | Required
---------- | ----------- | --------
`<team_member_name>` | The name or part of the name of a team member (`!leader <name>`). | `False`

![In-Game Command leader Image](images/ingame_commands/leader_ingame.png)


## **marker**

> **Set custom markers anywhere on the map.** This command can be very useful for small stash locations. Place down a small stash, create a marker on that spot and be able to navigate back to that exact place at a later stage. To list all registered markers, run `!markers`.

Subcommand | Description | Required
---------- | ----------- | --------
`add` | Add a custom marker (`!marker add <name>`). | `False`
`remove` | Remove a custom marker (`!marker remove <id>`). | `False`
`<marker_name>` | Calling with the name of the marker will let you navigate to that marker (`!marker <name>`). | `False`

![In-Game Command marker Image](images/ingame_commands/marker_ingame.png)


## **logs**

> **Show, enable, or disable bot file/debug logging.** This command works from in-game team chat and from the Discord command chat with the configured prefix. Console output continues, but file writes under `logs/` stop while disabled, including normal log files, raw Rust+ WebSocket text, event payload logs, marker history, and marker snapshots. The toggle is stored in `config/logging-settings.json`.
<br>Command: `!logs` - Show the current logging status.
<br>Command: `!logs off` - Disable file/debug logging.
<br>Command: `!logs on` - Enable file/debug logging.


## **market ingame**

> **Search for items in vending machines or subscribe/unsubscribe to items.**
<br>Command: `!market search sell Thompson`
<br>Command: `!market sub sell m249`
<br>Command: `!market sub all Scrap`
<br>Command: `!market unsub sell m249`
<br>Command: `!market list`

Subcommand | Description | Required
---------- | ----------- | --------
`search` | Search for an item in Vending Machines (`!market search sell thompson`). | `False`
`sub` | Subscribe to an item in Vending Machines (`!market sub all thompson`). | `False`
`unsub` | Unsubscribe to an item in Vending Machines (`!market unsub sell thompson`). | `False`
`list` | Display the subscription list (`!market list`). | `False`

![In-Game Command market Image](images/ingame_commands/market_ingame.png)


## **mute**

> **Mute the bot from the In-Game Team Chat.** This will mute everything the bot would normally say in Team Chat such as command response, event notifications, timers, Smart Device notifications.
<br>Command: `!mute`

![In-Game Command mute Image](images/ingame_commands/mute_ingame.png)


## **note/notes**

> **Create notes about meaningful things.** To list all registered notes run `!notes`, all note ids will be presented as well.

Subcommand | Description | Required
---------- | ----------- | --------
`add` | Add a note (`!note add <text>`). | `False`
`remove` | Remove a note (`!note remove <id>`). | `False`

![In-Game Command notes Image](images/ingame_commands/notes_ingame.png)


## **offline**

> **Get the currently offline players in your team.**
<br>Command: `!offline`

![In-Game Command offline Image](images/ingame_commands/offline_ingame.png)


## **online**

> **Get the currently online players in your team.**
<br>Command: `!online`

![In-Game Command online Image](images/ingame_commands/online_ingame.png)


## **player/players**

> **Get the names and playtime of the currently online players on the server (Based on Battlemetrics).** To get all the currently online players on the server run `!players`. To get the information from a certain player run `!player <name or part of name>`.

![In-Game Command players Image](images/ingame_commands/players_ingame.png)
![In-Game Command player Image](images/ingame_commands/player_ingame.png)


## **track/trackinfo/trackhistory/trackrelated/tracklist/tracks/untrack**

> **Track a BattleMetrics player on the currently active Rust server.** `!track` accepts either a SteamID64 or the complete remainder of the command as a partial pseudonym, so spaces and special characters are supported. An exact case-insensitive name wins. When several players match, the bot returns a numbered list without changing the tracker; the same requester can select one for five minutes with the same query followed by its number, for example `!track nirk 2`, or with the shorter `!track #2`. The pending choice is isolated by requester and active server and is lost on restart.
<br>Command: `!track <partial player name|SteamID64>`
<br>Selection after an ambiguous result: `!track #<number>` or `!track <same partial player name> <number>`
<br>Command: `!trackinfo <tracked player>`
<br>Command: `!trackhistory <tracked player>`
<br>Command: `!trackrelated <tracked player>`
<br>Command: `!tracklist` (alias: `!tracks`)
<br>Command: `!untrack <partial player name|BattleMetrics ID|SteamID64>`
<br>The plugin creates one native `Enemies` tracker per server. The existing 60-second BattleMetrics poller sends login/logout alerts to Discord and, by default, Rust team chat. `!tracklist` reports `online`, `last <duration>`, or `unknown`; an API failure is never reported as a logout.
<br>On a recognized WarBandits server, `!track` also invokes the detached WarBandits provider once to enrich the selected identity with its server-specific name, SteamID64, internal WarBandits ID, aliases, rank, playtime, and available statistics. This provider performs no background polling and never emits an online/offline transition: BattleMetrics remains the sole presence source.
<br>Presence alerts created by this plugin and their `TRACKER` info logs always use `Tracked player <name> is now online.` and `Tracked player <name> just disconnected.`. The event is logged before the optional Rust/Discord deliveries, whose failures remain isolated.
<br>For SteamID64 input, the plugin reads the free public Steam Community profile name with a five-second timeout, then requires a strict match on the active server. A leading `[CLAN]` tag is tolerated. If BattleMetrics exposes its own Steam identifier, it must equal the requested SteamID; a mismatch, ambiguous name, private profile, or unproven loose match performs no write.
<br>`!trackinfo`, `!trackhistory`, and `!trackrelated` are read-only, on-demand Premium calls. They persist bounded summaries in the same projection but never alter presence or emit a transition. Co-play means simultaneous activity observed by BattleMetrics; it is not proof of a Rust team, alternate identity, or relationship.
<br>The in-game responses are capped to one 122-character bot message. The complete readable, redacted save is `data/player-trackers/<guildId>-<battlemetricsServerId>.json`. Schema 2 contains the stable BattleMetrics player ID, current name, aliases, best-effort SteamID64, status, last-seen timestamps, and bounded Premium summaries, but no token, IP address, raw API body, Rust+ credential, or Discord credential. SteamID64 remains `null` when BattleMetrics does not expose it.
<br>The WarBandits catalogue is atomically cached in `data/warbandits/servers.json`; resolved identities and statistics are stored in `data/warbandits/<guildId>-<serverSlug>.json`. Calls are serialized with a five-second minimum gap and a five-second timeout. HTTP 429 `Retry-After` and Cloudflare challenges create a persisted cooldown with no blind retry. A WarBandits failure degrades to the normal BattleMetrics/Steam resolution and cannot undo a committed tracker change.
<br>`RPP_BATTLEMETRICS_TOKEN` belongs in the ignored repository-root `.env`; it is an access token, not an application ID. The bot loads `.env` automatically and only performs read-only player/server calls. Leave RCON, bans, flags, notes, triggers, and all write scopes disabled. BattleMetrics subscription rights are required; private profiles, streamer mode, hidden player lists, and server-owner-only identifier restrictions can still make a player unresolvable. See `docs/battlemetrics_and_trackers.md` for setup, verified endpoints, limits, and the sanitized live test.


## **pop**

> **Get the current population of the server including queue size and max population.**
<br>Command: `!pop`

![In-Game Command pop Image](images/ingame_commands/pop_ingame.png)


## **prox**

> **Get the distance to the three closest teammates.** To get the three closest teammates run `!prox`. To get the distance to a team member run `!prox <name or part of name>`.

![In-Game Command prox Image](images/ingame_commands/prox_ingame.png)


## **recycle ingame**

> **Display the output of recycling an item (Quantity is optional).**
<br>Command: `!recycle <item-name> <quantity>`
<br>Command: `!recycle Assault Rifle 10`
<br>Command: `!recycle rocket 100`

![In-Game Command recycle Image](images/ingame_commands/recycle_ingame.png)


## **research ingame**

> **Display the cost to research an item.**
<br>Command: `!research <item-name>`
<br>Command: `!research Assault Rifle`
<br>Command: `!research rocket`

![In-Game Command research Image](images/ingame_commands/research_ingame.png)



## **record**

> **Manually record a SteamID and pseudonym in the teammate language CSV database.** The pseudonym is everything after the SteamID, so spaces and special characters are allowed. The language list is managed directly in the CSV; a new alias inherits the latest dated row for that SteamID. Works from in-game team chat and from the Discord commands channel.
<br>Command: `!record [steamid] [pseudonym]`

## **who**

> **List all known pseudonyms for a SteamID from the teammate language CSV database.** Results include the first recorded date for each known pseudonym and the semicolon-separated language codes from the latest dated row for that SteamID. Works from in-game team chat and from the Discord commands channel.
<br>Command: `!who [steamid]`

## **send**

> **Send a message to a discord user.**
<br>Command: `!send Alle Hello my friend!`

![In-Game Command send Image](images/ingame_commands/send_ingame.png)


## **small**

> **Get information about Small Oil Rig (Time till crate unlocks, time since last trigger).**
<br>Command: `!small`

![In-Game Command small Image](images/ingame_commands/small_ingame.png)


## **stack ingame**

> **Display stack size information for an item.** The item name can contain spaces.
<br>Command: `!stack <item-name>`
<br>Example: `!stack high quality metal`


## **steamid**

> **Get the steamid of a teammate.**

Subcommand | Description | Required
---------- | ----------- | --------
`<team_member_name>` | The name or part of the name of a team member (`!steamid <name>`). | `False`

![In-Game Command steamid Image](images/ingame_commands/steamid_ingame.png)


## **team**

> **Get the names of all members in the team.**
<br>Command: `!team`

![In-Game Command team Image](images/ingame_commands/team_ingame.png)


## **time**

> **Get the current time In-Game and time till day/night.**
<br>Command: `!time`

![In-Game Command time Image](images/ingame_commands/time_ingame.png)


## **timer**

> **Set custom timers that will notify whenever the timer have expired.** To list all registered timers run `!timers`.
<br>`The argument <time> is used to set time in the format: 2h15m or 15m10s etc... (not space between d/h/m/s).`

Subcommand | Description | Required
---------- | ----------- | --------
`add` | Add a custom timer (`!timer add <time> <text>`). | `False`
`remove` | Remove a custom timer (`!timer remove <id>`). | `False`

![In-Game Command timer Image](images/ingame_commands/timer_ingame.png)


## **tr**

> **Translate a text from English to another language.**
<br>Command: `!tr <language-code> <Text>`

Subcommand | Description | Required
---------- | ----------- | --------
`language` | Get the language code (`!tr language <language>`). | `False`
`<language-code>` | Translate the text to this language (`!tr <language> <text>`). | `False`

![In-Game Command get language code Image](images/ingame_commands/language_code_ingame.png)
![In-Game Command translateTo Image](images/ingame_commands/translateTo_ingame.png)


## **trf**

> **Translate a text from a language to another language.**
<br>Command: `!trf <language-code-from> <language-code-to> <Text>`

![In-Game Command translateFrom Image](images/ingame_commands/translateFrom_ingame.png)

## **tts**

> **Send a Text-To-Speech message to the Discord teamchat channel.** To execute a Text-To-Speech command run `!tts <text>`.
<br>Command: `!tts <text>`

![In-Game Command tts Image](images/ingame_commands/tts_ingame.png)


## **unmute**

> **Unmute the bot from the In-Game Team Chat.**
<br>Command: `!unmute`

![In-Game Command unmute Image](images/ingame_commands/unmute_ingame.png)


## **upkeep**

> **Get the upkeep time of all connected tool cupboard monitors.**
<br>Command: `!upkeep`

![In-Game Command upkeep Image](images/ingame_commands/upkeep_ingame.png)


## **uptime ingame**

> **Display the uptime of the bot and server.**
<br>Command: `!uptime`

![In-Game Command uptime Image](images/ingame_commands/uptime_ingame.png)


## **vendor**

> **Get information about the Traveling Vendor (Current Location, Time since last Traveling Vendor).**
<br>Command: `!vendor`

![In-Game Command vendor Image](images/ingame_commands/vendor_ingame.png)


## **wipe**

> **Get the time since it was wiped.**
<br>Command: `!wipe`

![In-Game Command wipe Image](images/ingame_commands/wipe_ingame.png)
