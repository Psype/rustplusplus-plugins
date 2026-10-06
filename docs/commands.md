# Commands Documentation

> Slash commands beginning with `/` are Discord-only. Commands beginning with the configured prefix (shown as `!`
> below) work from Rust team chat and from the Discord text channel `commands`; they never work from Rust global chat.
> Rust team-chat users must be in the hoster's team. Discord permissions still apply to slash commands, and the
> identity-administration `/intel` command additionally requires a Discord administrator.

- [Discord Slash Commands](commands.md#discord-slash-commands)
- [Discord-only identity correction examples](commands.md#discord-only-identity-correction-examples)
- [In-Game and Discord Commands](commands.md#in-game-and-discord-commands)
- [In-game player-intelligence examples](commands.md#in-game-player-intelligence-examples)

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
[**/intel**](commands.md#intel-discord) | Privately review and reconcile pending player identities.
[**/intelimport**](commands.md#intelimport) | OCR, preview, and confirm a `/cinfo` or F7 screenshot.
[**/item**](commands.md#item) | Get the details of an item.
[**/leader**](commands.md#leader) | Give or take the leadership from/to a team member.
[**/map**](commands.md#map) | Get the currently connected server map image.
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
&nbsp; | `issued_date` | Optional legacy credential registration date. | `False`
&nbsp; | `expire_date` | Optional legacy Rust+ auth-token expiry date. | `False`
&nbsp; | `host` | Make this credential the Host listener. | `False`
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


## **/intel (Discord)**

> **Privately review and correct player identities without sending commands to Rust team chat.** Every response is
> ephemeral and every subcommand requires a Discord administrator. Corrections append reversible reconciliation
> events: raw screenshots and journal observations are never edited or deleted. The command acknowledges Discord
> before logging, context loading or journal reads, so those operations cannot consume Discord's response window.

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`pending` | `page` | List every exact alias whose projected identity still has no verified SteamID64. | `False`
`links` | `page` | List active manual alias reconciliations. | `False`
`history` | `target`, `page` | List only verified aliases, with first/last dates, for one exact local identity. | `target`
`link` | `alias`, `steamid` | Attach one exact pending alias to a SteamID64. | `alias`, `steamid`
`merge` | `alias`, `target` | Merge one exact pending alias into a verified local target selected by exact alias, SteamID64, or BattleMetrics ID. | `alias`, `target`
`unlink` | `alias` | Revoke every active reconciliation for one exact alias. | `True`

`link` and `merge` first read the target SteamID's current public Steam persona. That verified current name becomes the
latest display name. If Steam is unavailable, only an already Steam/API-verified local alias may be reused; there is no
manual name override. Existing verified Steam/API aliases remain in their dated history. An OCR-only spelling
such as `ChiCo` is retained as pending correction evidence and as the key used to reinterpret old captures, but it is
never promoted into the verified alias history of `Ch1co`.

Reprojection is immediate and applies to every retained confirmed `/cinfo` capture. Occurrences from different captures
are added; two spellings merged to the same Steam identity inside one capture count only once. `unlink` restores the
evidence-only projection without deleting data.

### Discord-only identity correction examples

These commands never send a message to Rust team chat. Options named `alias` are exact and intentionally do not use
fuzzy matching, so an administrator cannot accidentally merge a similarly named player.

Goal | Example | Expected effect
---- | ------- | ---------------
Review unresolved identities | `/intel pending page:1` | Lists one row per projected identity which still has no verified SteamID64, grouping aliases that already share a BattleMetrics ID.
Correct against a known local player | `/intel merge alias:ChiCo target:Ch1co` | Reprojects `ChiCo` observations onto the verified `Ch1co` identity.
Correct with a known SteamID64 | `/intel link alias:ChiCo steamid:76561198154738095` | Uses that Steam identity after reading its current public persona or a previously verified local alias.
Review real past names | `/intel history target:Ch1co page:1` | Shows dated Steam/API-verified names only.
Audit corrections | `/intel links page:1` | Lists active reversible reconciliation rules.
Undo a wrong correction | `/intel unlink alias:ChiCo` | Revokes the rule and reconstructs the evidence-only projection.

For the `ChiCo` OCR-error example, the normal sequence is:

1. `/intel pending`
2. `/intel merge alias:ChiCo target:Ch1co`
3. `/intel history target:Ch1co`
4. `/intel links`
5. `/intel unlink alias:ChiCo` only if the correction was wrong.

Before step 2, `ChiCo` is unresolved and appears in `pending`. After the merge it leaves the unresolved queue, but its
stored alias remains unverified correction evidence: `history` and `!who` show `Ch1co` and any other genuinely
Steam/API-verified names, never `ChiCo`. If Steam currently reports a newer persona, for example `Ch1co Current`, that
name becomes the display name while the older verified `Ch1co` entry remains in the dated history. A manually typed
display-name override is deliberately unavailable.

`pending` counts identities separately from aliases. For example, BattleMetrics may report that `FUNTIK` previously
used `gus` and `+=import&**`; if all three observations carry `BM:1192585926`, Discord shows one pending identity with
three aliases, not three people. A `/cinfo` preview says `linked to known identities` only when the candidate has a
SteamID64, a BattleMetrics ID, or both, and labels it `[Steam]`, `[BM]`, or `[Steam+BM]`. A name-only OCR observation
stays pending even if its spelling is an exact local match.


## **/intelimport**

> **Import player intelligence from an original PNG, JPEG, or WebP screenshot.** Use `/intelimport cinfo image:<file>` for a
> WarBandits `/cinfo` panel or `/intelimport f7 image:<file>` for Rust's F7 recent-player list. The command works only
> in the configured private commands channel. It validates the Discord CDN origin, supported extension and declared
> type, then trusts only the downloaded PNG/JPEG/WebP signature when Discord's two metadata hints disagree. Byte size
> and decoded pixel count remain bounded before OCR. Discord's attachment size is only a preflight bound: the CDN body
> is independently capped while streaming because its final length may differ. It compares a bounded high-contrast
> Rust-UI text mask with the original through serialized local Tesseract processes, then displays an
> ephemeral preview. Only the
> requester can edit or confirm it for thirty minutes, on the same server. The event journal is committed before the
> Discord acknowledgement; a Discord failure cannot roll it back. Existing aliases from the event journal, trackers,
> BattleMetrics, Rust+ and the same F7 upload feed a Unicode-aware, globally one-to-one roster resolver. Short names use
> stricter collision margins. At most three provisional queries per batch may be corroborated through the existing
> rate-limited WarBandits provider and public Steam profile names; this needs no Steam credential or Steam Web API key.
> Persistent known aliases are passed to Tesseract as UTF-8 user words. Confirmed name shapes are also retained in a
> bounded per-server data sidecar: exact repeats may corroborate, while approximate visual matches only rank candidates
> and visual collisions remain ambiguous. No screenshot pixels are kept by this dictionary.
> F7 always compares the original, normal text mask and a separate muted-neutral mask for the dim gray SteamID64 rows.
> The muted pass is digit-only instead of repeating the same general text recognition. The selected pass favors exact
> IDs independently repeated across variants, then OCR confidence. Every complete, partial, or name-only row inferred
> across any of those passes is then cropped from its relative OCR box, masked, placed on one bounded 4x numeric sheet and read
> once with a digit whitelist. This can correct a valid-looking wrong digit and recover an ID missed by the whole-image
> pass without fixed screen coordinates or one process per player. The preview reports `Isolated SteamID rows reread`.
> At most two common OCR
> substitutions may be repaired inside a 17-character candidate, which must remain inside the valid Steam account
> range. The uppercase name may contain OCR errors. A similar public Steam persona or same-ID alias confirms the pair;
> long matching cores also tolerate damaged decorative prefixes such as `L @*X4LAZY2ERO` versus `零^x Lazy2ero`.
> When the font is transcribed too badly, an unambiguous row may use the canonical Steam persona only if all 17 digits
> were read directly with confidence at least 80; it is marked `[Steam-recovered]`. If Steam is temporarily unavailable,
> an unrepaired ID repeated by at least two OCR variants with confidence at least 60 is retained as a `probable`
> `[OCR-consensus]` pair. It remains usable as reversible evidence but cannot train authoritative visual identity data.
> Reconstructed, single-pass or low-confidence unverifiable rows are excluded. No Steam credential or Web API key is
> used, and a failed public-profile lookup is cached for only thirty seconds rather than one hour.
> Ambiguous name/SteamID associations and truncated IDs are never guessed. A structurally valid `/cinfo` with uncertain
> or missing members is offered as a partial snapshot: pending identities stay out of aliases and affinity counts until
> later evidence resolves them automatically. A complete SteamID with a hidden name is retained without an alias. Set
> `RPP_TESSERACT_PATH` when the executable is not available as `tesseract`; production Linux therefore
> needs the local `tesseract-ocr` package and English model, with no runtime model download.
> A complete `/cinfo` roster also receives one bounded OCR pass over temporary member rows split relatively at commas
> and the final standalone `and`. OCR output is assigned to its original sheet slot by vertical row, so a missing line
> cannot shift Marley onto Swizzy. Delimiter pixels are excluded from the member signature. It can correct decorative
> punctuation only from a uniquely confirmed name/template; member count, indexes and roles remain fixed.
> Tesseract's own page/block/paragraph/line identifiers are retained throughout parsing. Tightly spaced visual rows
> therefore stay distinct even when their OCR boxes overlap vertically; a wrapped final player such as
> `U Got Kirkified` cannot absorb the following `Established` row. Common `l`/`I`/`1` confusion in the
> `Established:` label is accepted only as an anchor spelling, while the timestamp remains strictly validated.
> A still-incomplete roster receives one separate roster-field-only read. If any cinfo field remains wrong, use
> `Edit <tag>`: line 1 is the exact ClanTag, line 2 is `Established` as `MM/DD/YYYY HH:mm:ss` GMT, and every remaining
> line is one exact player name. The bot validates all three sections, recomputes the inferred wipe when the date
> changes, reruns identity matching and shows another preview. Nothing is stored until Confirm; afterward only the
> confirmed player names enter the bounded OCR user-word lexicon. A changed name with a proven member boundary also
> creates a persistent image→text correction template in `ocr-correction-memory.json`; it changes transcription only,
> never SteamID, identity or role proof. Exact visual repeats apply automatically after restart. Approximate repeats
> require a unique score ≥0.985 with a ≥0.03 margin; collisions and short-name fuzzy matches fail closed.
> Missing `Members`/`Established` anchors and a polluted tag are reread from isolated rows derived from neighboring
> semantic lines. Count/date reads use restricted numeric alphabets and every result is strictly revalidated.
> No capture date is read or required for `/cinfo`. Every detected panel independently infers its regular
> Tuesday/Friday 14:00 GMT wipe from its own `Established`; one image may therefore contain and commit blocks assigned
> to different wipes. Forced wipes, intermediate observed boundaries, the Discord upload time and message captions are
> deliberately ignored. `Established` is parsed strictly as `MM/DD/YYYY HH:mm:ss` GMT.
> Reimporting an already committed image does not silently duplicate it. Discord shows the effective previous version
> and the proposed version, then offers `Replace previous` or `Keep existing`. Replacement preserves the logical
> counter position unless corrected `Established` data moves it to another regular wipe, rebuilds identities/clans/
> affinities from the new content, and may itself be replaced later.

The bot also creates a private `intel-imports` channel (renaming that configured channel, for example to
`intel-reports`, keeps working because the bot uses its Discord ID). A message may contain 1–10 images and needs no caption: F7 and
`/cinfo` are detected from semantic OCR anchors. Starting the message with `cinfo` or `f7` remains an optional strict
hint for all attachments. Repeated `ClanTag` anchors allow several stacked `/cinfo` panels in one image; every panel is
validated separately, receives its own Established-derived wipe, and the whole preview is confirmed as one batch. A `/cinfo` block needs a valid tag, declared
count and `Established` timestamp; its roster may remain partial. If OCR leaves the ClanTag or `Established` empty or
invalid while the count and roster make the panel safely editable, the preview remains pending with an `Edit` button:
confirmation is disabled, and a forged/stale confirmation is also refused without writing or discarding the preview.
Correct line 1 (tag) and line 2 (GMT timestamp) in the modal; the bot reruns strict validation and enables confirmation
only after the block is valid. A non-editable malformed block,
or a complete preview that cannot fit safely, is still rejected before confirmation. The human sender alone can confirm. An approved Windows helper
webhook can post the same messages when its ID is listed in `RPP_INTEL_IMPORT_WEBHOOK_IDS`; because a webhook has no
human requester, any member with the configured bot role (or an administrator) may confirm it. Unapproved webhooks are
ignored. A text-only message may instead contain 1–100 complete SteamID64 values, one per non-empty line (an optional
whole-message `text` code fence is accepted). Blank and duplicate lines are ignored; any other line rejects the entire
lot. The preview reuses a unique locally known name/BattleMetrics ID when available, preserves unknown IDs without
inventing a name, and requires the same `Confirm import` or `Reject` decision before durable storage. Missing names are
left for the background identity daemon, which prioritizes one pasted SteamID per BattleMetrics tick through an exact
WarBandits all-time lookup and stores its current name plus cumulative hours when found. All paths use the same validation, thirty-minute requester/channel/
server binding and durable batch commit logic.
Import decision buttons are acknowledged before validation or disk work begins. The message temporarily changes to
`Import processing…` or `Import queued…`; decisions are serialized per server and repeated clicks on the same pending
token are ignored until its final success, replacement prompt, or safe failure is displayed.

Subcommand | Options | Description | Required
---------- | ------- | ----------- | --------
`cinfo` | `image` | Original `/cinfo` PNG, JPEG, or WebP. | `True`
`f7` | `image` | Original F7 PNG, JPEG, or WebP. | `True`

### Discord-only import examples

- `/intelimport cinfo image:<cinfo-screenshot.png>` previews one or more `/cinfo` panels. Confirm only after checking
  every roster, role and GMT `Established` value.
- `/intelimport f7 image:<f7-screenshot.png>` previews the recent-player rows. A readable F7 row is identity evidence,
  never proof that the player is currently online.
- In the private `intel-imports`/`intel-reports` channel, attach 1-10 screenshots without a slash command for automatic
  semantic type detection, or paste complete SteamID64 values one per line. Every batch still requires confirmation.
- If a `/cinfo` screenshot contains several panels, each panel derives its own wipe from its own GMT `Established`.
  The upload date and caption are ignored.


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

Commands that depended exclusively on event or vending-machine map markers are intentionally absent. Facepunch stopped
exposing those markers through the public Rust+ stream on 2026-08-06; see
[the payload audit](rustplus_payload_audit_2026-09-10.md).

Command | Description
------- | -----------
[**afk**](commands.md#afk) | Get the currently afk players in your team.
[**alive**](commands.md#alive) | Get the player with the longest time alive.
[**autotranslate**](commands.md#autotranslate) | Automatically translate relayed team-chat messages in Discord.
[**activity**](commands.md#player-intelligence) | Show conservative known-online time over the rolling month or all retained history.
[**affinity**](commands.md#player-intelligence) | Show confirmed ClanTag and repeated-clanmate counts.
[**clan**](commands.md#player-intelligence) | Show the latest confirmed stored snapshot for a ClanTag.
[**clanhistory**](commands.md#player-intelligence) | Show the five latest stored snapshots for a ClanTag.
[**clantop**](commands.md#player-intelligence) | Rank observed ClanTags by distinct confirmed snapshots.
[**commands/help**](commands.md#commandshelp) | List available commands or show the documented synopsis and description for a command.
[**connection/connections**](commands.md#connectionconnections) | Get recent connection events.
[**craft**](commands.md#craft-ingame) | Display the cost to craft an item.
[**death/deaths**](commands.md#deathdeaths) | Get recent death events.
[**decay**](commands.md#decay-ingame) | Display the decay time of an item.
[**despawn**](commands.md#despawn-ingame) | Display the despawn time of an item.
[**language**](commands.md#language) | Show or change the bot language for this server and config file.
[**intel**](commands.md#player-intelligence) | Show the complete compact local profile: identity, aliases, presence, clan affinity, and rolling activity.
[**leader**](commands.md#leader-1) | Give/Take the Team Leadership.
[**marker/markers**](commands.md#marker) | Set or list custom markers anywhere on the map.
[**logs**](commands.md#logs) | Show, enable, or disable bot file/debug logging.
[**mute**](commands.md#mute) | Mute the bot from the In-Game Team Chat.
[**note/notes**](commands.md#notenotes) | Create notes about meaningful things.
[**offline**](commands.md#offline) | Get the currently offline players in your team.
[**online**](commands.md#online) | Get the currently online players in your team.
[**player/players**](commands.md#playerplayers) | Get the names and playtime of the currently online players on the server (Based on Battlemetrics).
[**pop**](commands.md#pop) | Get the current population of the server including queue size and max population.
[**prox**](commands.md#prox) | Get the distance to the three closest teammates.
[**alarmstatus**](commands.md#alarmstatus) | Show incoming alarm health and the five latest alarms received.
[**raidtest**](commands.md#raidtest) | Send a critical test alert through the production Rust team-chat raid path.
[**recycle**](commands.md#recycle-ingame) | Display the output of recycling an item.
[**research**](commands.md#research-ingame) | Display the cost to research an item.
[**record**](commands.md#record) | Manually link a SteamID64, BattleMetrics ID, and exact name in the active server intelligence database.
[**scanplayers**](commands.md#player-intelligence) | Trigger or queue an immediate bounded background identity rescan for the active wipe.
[**send**](commands.md#send) | Send a message to a discord user.
[**stack**](commands.md#stack-ingame) | Display stack size information for an item.
[**steamid**](commands.md#steamid) | Compatibility alias for the complete server-wide `!intel` profile.
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
[**wipe**](commands.md#wipe) | Get the time since it was wiped.
[**who**](commands.md#who) | List exact aliases known by the active server intelligence database.



## **autotranslate**

> **Automatically translate Rust team-chat messages back into team chat and into the Discord relay.** `!autotranslate on` defaults to English. You can pass one target language, or two languages separated by a comma. With two targets, if the detected source language already matches one target, the other target is used; for example `!autotranslate on en,zh` translates Chinese messages to English and English messages to Chinese. Language names from the existing translation command are accepted, such as `english,chinese`, as well as language codes such as `en,zh`.
<br>Command: `!autotranslate on [language[,language...]]`
<br>Command: `!autotranslate off`
<br>Provider queue: Google Web -> DeepLX -> Bing Web -> MyMemory. Each provider is attempted once, for at most two seconds, and the complete sequential chain has a strict five-second budget. The original team-chat relay does not wait for translation; translated Rust/Discord relays arrive later or are skipped after the bounded failure. Decision logs include `elapsedMs`. `RPP_LIBRETRANSLATE_URL` replaces the public DeepLX step with a self-hosted LibreTranslate instance; set `RPP_LIBRETRANSLATE_API_KEY` too when that instance requires a key. No public LibreTranslate mirror is enabled by default because public availability is not reliable enough.
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


## **commands/help**

> **List available commands or show the documented synopsis and description for one command.** The command catalog is parsed from `docs/full_list_features.md` at runtime so both commands use the same canonical source. Active aliases such as `tracks` and `markers` are accepted. Works from in-game team chat and from the Discord commands channel.
<br>Command: `!commands [command]`
<br>Command: `!help [command]`
<br>Examples: `!help track`, `!help marker`, `!commands despawn`

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

> **Show, enable, or disable bot file/debug logging.** This command works from in-game team chat and from the Discord command chat with the configured prefix. Console output continues, but file writes under `logs/` stop while disabled, including normal log files, raw Rust+ WebSocket text, decoded Rust+ events, raw decoded FCM notification envelopes, marker history, and marker snapshots. FCM envelopes are written before alarm normalization to `logs/rustplusplus-fcm-raw.jsonl`, one LF-terminated JSON object per notification. The toggle is stored in `config/logging-settings.json`. This diagnostic file can contain team messages, Steam IDs, server addresses and pairing tokens; keep it private and remove unrelated lines before sharing it.
<br>Command: `!logs` - Show the current logging status.
<br>Command: `!logs off` - Disable file/debug logging.
<br>Command: `!logs on` - Enable file/debug logging.


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

> **Get the names and current-session playtime of players online now (based on BattleMetrics).** This is deliberately a
> live roster view, not a historical player profile. Run `!players` for the online server list or `!player <name or
> part of name>` to filter it; use `!intel` for everything retained about the closest known identity.

![In-Game Command players Image](images/ingame_commands/players_ingame.png)
![In-Game Command player Image](images/ingame_commands/player_ingame.png)


## **player intelligence**

> **Query the append-only player, clan and presence history for the active BattleMetrics server.** The plugin reuses
> the existing 60-second BattleMetrics update; it never creates a second poller. A failed/censored update changes
> provider state to `unknown`, never to a false logout. Exact SteamID64 is the strong identity; name-only links remain
> reversible. Read-only lookup ranking never creates or merges identity evidence.
> The immutable per-server journal and its derived projections are reused between commands and invalidated after an
> append. SteamID64, BattleMetrics ID, exact names and `Played with` relations have direct indexes; a normal repeated
> `!affinity` therefore does not reread/rebuild the complete history. Shard metadata is still checked so an external
> disk change or corruption fails closed instead of serving stale data.
> The same 60-second hook clocks a coalesced background identity daemon without delaying BattleMetrics notifications.
> It refreshes each already-linked SteamID at most once per wipe when that BattleMetrics identity is actually online,
> prioritizes one SteamID pasted through `intel-reports` with one exact WarBandits lookup chain per tick, and
> incrementally reads one bounded 100-row current-wipe WarBandits page at a time. Exact, unique live names of at least
> three characters may join the two sources; collisions and short names stay unlinked. Its atomic cursor under the
> player-intelligence server directory survives restarts. A completed WarBandits sweep waits twelve hours before a
> conservative rescan for players who joined the wipe later. Names and WarBandits cumulative hours are retained, but
> neither a leaderboard row nor increasing playtime creates presence or login/logout events.
> Name lookups share one provider-neutral reconciler. `!intel`, `!steamid`, `!who`, `!affinity` and `!activity` use
> its read-only `first` mode: exact identifier/name, prefix and contained partial matches are ranked, then the closest
> deterministic result is returned without a selector. For example, `!intel tree` can select `Cockornut Tree`.
> Tracking paths use the same reconciler in `precise` mode and still require the numbered selector whenever the best
> priority/quality bucket contains several players. The reusable API can require several fragments to occur in one
> alias, but WarBandits does not accept arrays of `player_name`: `KOH` and `PENG` must be queried separately and
> reconciled locally. Automatic OCR fragment fan-out must remain disabled until every submitted fragment has explicit
> high-confidence OCR evidence.
<br>Command: `!intel <SteamID64|BattleMetrics ID|partial name>`
<br>Compatibility alias: `!steamid <SteamID64|BattleMetrics ID|partial name>`
<br>Command: `!who <SteamID64|BattleMetrics ID|partial name>`
<br>Command: `!record <SteamID64> <BattleMetrics ID> <exact name>`
<br>Command: `!scanplayers`
<br>Command: `!affinity <SteamID64|BattleMetrics ID|partial name>`
<br>Command: `!activity <SteamID64|BattleMetrics ID|partial name> [1mo|all]`
<br>Command: `!clan <ClanTag>`
<br>Command: `!clanhistory <ClanTag>`
<br>Command: `!clantop [1-10]`

### In-game player-intelligence examples

The following examples use Rust team-chat syntax. The same `!` commands may also be typed in the Discord `commands`
channel, but they are not Discord slash commands.

Goal | Example | Matching behavior
---- | ------- | -----------------
Read the closest complete profile | `!intel tree` | Selects the closest partial alias, such as `Cockornut Tree`, without a selector and without writing evidence.
Read verified aliases only | `!who ch1` | May return `Ch1co Current, Ch1co`; an OCR-only `ChiCo` spelling is omitted.
Read confirmed clan affinity | `!affinity tree` | Shows `Known tags` and `Played with` counts from distinct confirmed `/cinfo` captures.
Read conservative presence | `!activity tree` or `!activity tree all` | Uses the rolling 30 days by default, or all retained known-online segments.
Read a clan snapshot | `!clan ABC` | Shows the latest stored confirmed snapshot; it does not claim the roster is still current.
Refresh WarBandits collection | `!scanplayers` | Queues one bounded current-wipe scan without claiming presence.

For example, `!intel tree` can return a compact profile headed by `Cockornut Tree`. `!who tree` returns only that
identity's verified Steam/API aliases. Both are read-only closest-match commands: they do not create a merge merely
because one name ranked first.

`!record 76561198154738095 123456 Ch1co` records a proven exact SteamID64/BattleMetrics/name triple. It is not the
correction command for an OCR typo and should not be used to make `ChiCo` historical. Use the private Discord command
`/intel merge alias:ChiCo target:Ch1co` for that reversible correction, avoiding unnecessary Rust team-chat messages.

<br>`!intel` is the canonical complete compact lookup. It returns the current display name, available
SteamID64/primary BattleMetrics ID, reliable compact presence, the latest collected cumulative WarBandits hours,
verified Steam/API aliases, `Known tags`, `Played with`, and rolling 30-day activity. OCR-only spellings remain pending
and are managed privately with `/intel pending`; they are not presented as historical aliases. WarBandits hours use a lower-bound display such
as `WB hours:7500+`: it means at least 7,500 hours at the last successful collection, not a live counter.
`!steamid` returns the same result and no longer searches only Rust+ teammates. `!who` is the alias-only
view. The `x` count is the number of distinct confirmed `/cinfo` screenshots, not shared wipes or BattleMetrics
co-presence. `!activity` defaults to a rolling 30 days (`1mo`); `all` covers all retained local events. Only
known-online segments count, provider outages are excluded, and overlapping providers are merged. `!clan` is the
latest stored observation, not a claim that the roster is still current.
<br>`!record` is idempotent and writes one exact manual identity observation into the append-only per-server journal.
It preserves spaces and Unicode in the name, validates the SteamID64 range and numeric BattleMetrics ID, and refuses
to attach a BattleMetrics ID already linked to another SteamID. It no longer mutates the teammate-language CSV;
that file remains private implementation data for translation language preferences only.
<br>`!scanplayers` immediately acknowledges and starts one bounded WarBandits current-wipe page in the background, or
queues one forced pass behind an already-running cycle. Further pages advance on the existing 60-second BattleMetrics
ticks, so Discord/Rust+ command handling never waits for the scan. It bypasses the normal twelve-hour completed-sweep
delay, has a five-minute manual cooldown, reuses its restart-safe cursor and known-ID sets, and resets the once-per-wipe
priority lookup set for pasted SteamIDs. With 100 pasted IDs, exact lookups therefore take at most roughly
100 successful ticks rather than requiring a traversal of the full all-time leaderboard. Each lookup first checks
`wipe=0`, then the newest completed wipe returned by the server's `/wipes` catalogue, and only then `all-time` if both
scopes are empty. When a unique response name exactly matches one and only one local BattleMetrics identity without a
conflicting SteamID, the journal records the combined Steam+BM identity and all aliases on that BM leave `pending`
together. An ambiguous response remains manual. `!scanplayers` can reset the current wipe's completed priority set so
IDs imported before this behavior are reconsidered. Provider cooldowns extend
that delay safely. The command does not manufacture online/offline presence.


## **track/trackinfo/trackhistory/trackrelated/tracklist/tracks/untrack**

> **Track a BattleMetrics player on the currently active Rust server.** `!track` accepts either a SteamID64 or the complete remainder of the command as a partial pseudonym, so spaces and special characters are supported. A direct BattleMetrics ID wins. For names, currently-online matches are considered before historical offline profiles, then exact, prefix, and partial quality decide. This prevents a stale exact profile such as `Kirkstein` from hiding a live partial match such as `Jeffrey Kirkstein The 3rd`. When several equally ranked players match, the bot returns a numbered list without changing the tracker; the same requester can select one for five minutes with the same query followed by its number, for example `!track nirk 2`, or with the shorter `!track #2`. The pending choice is isolated by requester and active server and is lost on restart.
<br>Command: `!track <partial player name|SteamID64>`
<br>Selection after an ambiguous result: `!track #<number>` or `!track <same partial player name> <number>`
<br>Command: `!trackinfo <tracked player>`
<br>Command: `!trackhistory <tracked player>`
<br>Command: `!trackrelated <tracked player>`
<br>Command: `!tracklist [all]` (alias: `!tracks [all]`)
<br>Command: `!untrack <partial player name|BattleMetrics ID|SteamID64>`
<br>Example: `!track peng` starts tracking immediately only when one precise best match exists.
<br>Ambiguous example: if `!track peng` returns a numbered list, use `!track #2` or `!track peng 2`; unlike the
read-only `!intel peng`, tracking never silently selects between equally ranked candidates.
<br>The plugin creates one native `Enemies` tracker per server. The existing 60-second BattleMetrics poller sends login/logout alerts to Discord and, by default, Rust team chat. `!tracklist` and `!tracks` always queue every tracked player over minimal Rust-safe messages as `name: Online`, `name: <duration> ago`, or `name: Unknown`, without page headers. Adding `all` packs multiple complete `name,BattleMetricsID,SteamID,status` records per message; `-` means the SteamID is unknown and status is `on`, `off:<age>`, or `unk:<age>`. An API failure is never reported as a logout.
<br>On a recognized WarBandits server, `!track` also invokes the detached WarBandits provider once with `wipe=0` to enrich the selected current-server identity with its name, SteamID64, internal WarBandits ID, aliases, rank, playtime, and available statistics. OCR corroboration checks `wipe=0`, then the numeric wipe interval from `/wipes/<server>` which contains that block's GMT `Established` (or the closest interval), and finally `all-time` only when both narrower scopes are empty. A lookup without an `Established` value uses the newest completed interval as its historical step. Numeric wipe IDs are opaque API identifiers: they are selected by date range, never derived with `current ID - 1`. The first scope returning candidates stops the chain; multiple all-time candidates remain unresolved for manual review. Every scope has a separate cache. The tracker path performs no background polling. The separate player-intelligence daemon may consume bounded current-wipe pages, but neither path emits an online/offline transition: BattleMetrics remains the sole presence source.
<br>Presence alerts created by this plugin and their `TRACKER` info logs always use `Tracked player <name> is now online.` and `Tracked player <name> just disconnected.`. The event is logged before the optional Rust/Discord deliveries, whose failures remain isolated.
<br>For SteamID64 input, the plugin reads the free public Steam Community profile name with a five-second timeout, then requires a strict match on the active server. A leading `[CLAN]` tag is tolerated. If BattleMetrics exposes its own Steam identifier, it must equal the requested SteamID; a mismatch, ambiguous name, private profile, or unproven loose match performs no write.
<br>Re-adding the same proven identity never creates a second entry. A later `!track <SteamID64>` that resolves to an existing BattleMetrics player with no SteamID atomically enriches that player, preserves its history and aliases, and replies `Tracking updated`.
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


## **alarmstatus**

> **Inspect the incoming raid-notification route.** Reports the Google MCS connection, whether a Facepunch push has
> actually reached this bot process, whether a server-pair notification and an alarm have been observed since startup, whether the listener account
> matches the active server pairing, whether raw FCM capture is enabled, whether in-game output is enabled or muted, and the five latest alarms with their
> relative receipt times. `push unverified` is not treated
> as connected. If no server-pair notification has been observed, the command arms a non-blocking 120-second check:
> use **Pair with Server** in Rust, then the bot reports success or timeout automatically in team chat. Only a pairing
> notification for the active server and matching listener account completes the check.
<br>Command: `!alarmstatus`


## **raidtest**

> **Verify critical in-game raid-alert delivery without waiting for a real raid.** The command uses the same immediate,
> acknowledged Rust team-message path as an incoming FCM alarm. It works from Rust team chat and the Discord commands
> channel. The bot logs either `raid-alarm.in-game: test delivered` or the precise failure reason.
<br>Command: `!raidtest`


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

> **Manually add an exact identity link to the active server intelligence journal.** The name is everything after the
> two identifiers, so spaces and Unicode are preserved. Repeating the same triple is a no-op; a BattleMetrics ID
> already linked to another SteamID is rejected. Works from Rust team chat and the Discord commands channel.
<br>Command: `!record <SteamID64> <BattleMetrics ID> <exact name>`

## **who**

> **List verified Steam/API aliases known by the active server intelligence database.** OCR-only spellings stay in the
> private `/intel pending` correction queue. The player can be selected by SteamID64,
> BattleMetrics ID, or the closest partial known name. This is server-wide and no longer reads only the
> teammate-language CSV.
<br>Command: `!who <SteamID64|BattleMetrics ID|partial name>`

## **send**

> **Send a message to a discord user.**
<br>Command: `!send Alle Hello my friend!`

![In-Game Command send Image](images/ingame_commands/send_ingame.png)


## **stack ingame**

> **Display stack size information for an item.** The item name can contain spaces.
<br>Command: `!stack <item-name>`
<br>Example: `!stack high quality metal`


## **steamid**

> **Compatibility alias for `!intel`.** It queries the complete active-server intelligence database rather than the
> Rust+ team only, and returns the same identity, aliases, reliable presence, clan affinity, and rolling activity.
<br>Command: `!steamid <SteamID64|BattleMetrics ID|partial name>`

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


## **wipe**

> **Get the time since it was wiped.**
<br>Command: `!wipe`

![In-Game Command wipe Image](images/ingame_commands/wipe_ingame.png)
