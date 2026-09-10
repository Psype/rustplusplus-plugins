# External Rust/Steam data sources — 2026-09-10

Target observed: WarBandits EU 5X NoBPs (`eu5xnbp.warbandits.gg`, BattleMetrics server `9456371`). This report records capabilities verified on 2026-09-10; dynamic values must not be hard-coded.

## Verified WarBandits endpoints

- The public [WarBandits server page](https://warbandits.gg/en/servers) embeds the server hostname, BattleMetrics ID, connected/joining/queued counts, maximum population, group limit, multiplier, last wipe, and next wipe. It reported the game endpoint through DNS SRV on UDP `28010`.
- The live Steam A2S query port is UDP `28015`. `A2S_INFO` answered after the standard challenge and exposed server name, Rust application metadata, current/max population, build/tags, and a map label.
- `A2S_RULES` returned 38 public keys. Useful observed fields included `build`, description fragments, `ent_cnt`, `fps`, `fps_avg`, `gc_cl`, `gc_mb`, `hash`, header/logo/map URLs, `pve`, `uptime`, server URL, `world.seed`, and `world.size`. Facepunch documents the public query port and its use by server browsers and third-party services in [Creating a server](https://wiki.facepunch.com/rust/Creating-a-server).
- `A2S_PLAYER` answered, but returned 94 generic names such as `chelsie`, `joesph`, and `kiesha` while the public WarBandits page reported a materially different connected count. These are masked identities, not players that can be matched to SteamID64 or BattleMetrics IDs. Facepunch documents that `censorplayerlist true` masks names exposed to third-party server-list scrapers in [Creating a hidden, whitelisted server](https://wiki.facepunch.com/rust/Creating_a_hidden_whitelisted_server).

Conclusion: a passive A2S plugin could independently collect server health, population, build, map metadata, wipe hints, uptime, entity count, FPS, and memory. On this WarBandits server it must never use `A2S_PLAYER` as an enemy-presence source.

## Steam sources

### Public Steam Community profile

The existing `https://steamcommunity.com/profiles/<SteamID64>?xml=1` endpoint was verified live. A public profile can expose persona name, visibility, avatar, Steam online/in-game state, current game label, profile age/location, groups, and playtime/recent-game data. It needs no key, but it is not a documented stable Web API and is controlled by profile privacy. The tracker currently consumes only the validated persona name.

Steam presence is at most secondary evidence: `In-Game: Rust` does not prove presence on WarBandits, invisible/private users disappear, and server address presence is not guaranteed. Facepunch explicitly notes that an invisible Steam status hides the game, IP, and port in its [server privacy guidance](https://wiki.facepunch.com/rust/Creating_a_hidden_whitelisted_server#UsersVisibility).

### Official Steam Web API

With a server-side Steam Web API key, useful read-only calls include:

- [`ISteamUser/GetPlayerSummaries`](https://partner.steamgames.com/doc/webapi/ISteamUser): up to 100 SteamIDs per request; persona, visibility, profile URL, avatars, and public presence fields.
- `ISteamUser/GetPlayerBans`: community/VAC/game/economy ban summaries.
- `ISteamUser/GetFriendList`: only when the target's friend list is public.
- [`IPlayerService`](https://partner.steamgames.com/doc/webapi/IPlayerService): recently played/owned games and playtime when the profile permits it.
- [`IGameServersService`](https://partner.steamgames.com/doc/webapi/igameserversservice): resolves a game server's IP/port to its Steam game-server ID and back. This can stabilize server identity across DNS changes, but it does not expose player presence.

These enrich a known SteamID64 but do not discover a reliable WarBandits session. Keys must remain environment secrets and calls should be batched/cached.

### Steam client presence

For an authenticated Steam client account, [`ISteamFriends/GetFriendGamePlayed`](https://partner.steamgames.com/doc/api/ISteamFriends) can expose the game ID plus game/query server IP and ports for a friend who is currently playing. An exact IP/port match against the active WarBandits endpoint would be strong live corroboration. It is not available for arbitrary players: it requires a Steam client session and the target normally has to be a friend or otherwise known to that client. The same interface's “recently played with” list only contains users previously registered through the game's `SetPlayedWith` calls, so it cannot be assumed complete for Rust. A headless Steam account would add credential and operational risk, so this is not recommended for the current tracker without a separate explicit design decision.

## Rust+/Facepunch companion protocol

The paired Rust+ WebSocket already used by the bot can retrieve server info, time, map, currently exposed map markers, the paired account's team and team chat, paired smart-entity state/subscriptions, and paired cameras. It requires the player's Rust+ pairing token. Facepunch documents the companion TCP service in [Rust+ Server](https://wiki.facepunch.com/rust/rust-companion-server).

The companion port being reachable is not authorization. The protocol does not provide arbitrary enemy identities, positions, inventories, combat history, or the full server player list to a normal paired player. Directly speaking the protocol therefore cannot bypass the server's Rust+/map-marker restrictions.

## RCON and server-owner data

RCON would be the authoritative option if WarBandits supplied administrative credentials: `playerlist`, `players`, `status`, and `stats` expose connected SteamID64/name data and, depending on the command, ping, session time, IP, kills, deaths, and suicides. These are documented in Facepunch's [useful server commands](https://wiki.facepunch.com/rust/useful_commands). Without the owner's RCON password, this path is unavailable and must not be probed.

## BattleMetrics and WarBandits application data

- BattleMetrics remains the useful external identity/history source when the configured token has the required subscription and profile permissions. A live unauthenticated request to server `9456371` returned HTTP 403 (`A subscription is required to use the API`). Failure remains `unknown`, never `offline`.
- BattleMetrics public profiles and session history are subject to privacy controls and a rolling history window; hidden player lists and private sessions may be absent. This is documented in [BattleMetrics privacy guidance](https://learn.battlemetrics.com/article/44-what-can-i-do-to-hide-my-player-profile).
- BattleMetrics states that direct SteamID/unique-identifier search is available only to owners or administrators of the server that supplied the data. It must not be assumed available to this bot on WarBandits; see [BattleMetrics identifier-search guidance](https://learn.battlemetrics.com/article/54-how-can-i-search-for-a-player-by-steam64id).
- The public WarBandits client uses anonymous JSON endpoints that answered successfully during this audit:
  - [`/servers`](https://api.warbandits.gg/servers) returns server identifiers, hostname, connected/joining/queued/max counts, group limit, multiplier, wipe dates, and BattleMetrics ID.
  - [`/wipes/eu5xnobps`](https://api.warbandits.gg/wipes/eu5xnobps) returns wipe IDs and date ranges.
  - [`/stats/eu5xnobps`](https://api.warbandits.gg/stats/eu5xnobps?limit=10&wipe=all-time&category_ID=1) returns paginated server-specific leaderboard rows without a Steam login. The generic all-time request supplied by the user returned 10 rows and reported 133,925 total records at the observation time; this count is dynamic and must not be hard-coded. Each row contained an internal player ID, full SteamID64, current name, rank, and playtime.
  - Four category schemas were verified: PvP (`kills`, `deaths`, `kdr`, `headshots`, `shot_fired`, `playtime`), raiding (`rocket_fired`, `hv_rocket_fired`, `c4_thrown`, `satchel_thrown`), farming (`sulfur_gathered`, `stone_gathered`, `metal_gathered`, `wood_gathered`, `crate_looted`, `barrel_destroyed`), and PvE (`animals_killed`, `scientists_killed`, `heavy_scientists_killed`, `bradley_killed`).
  - The [`player_name=Psype` request supplied by the user](https://api.warbandits.gg/stats/eu5xnobps?limit=10&wipe=all-time&category_ID=1&player_name=Psype&sort_direction=DESC) returned one row whose SteamID64 matched the already-known account, validating this identity path end to end. The public client also exposes a `steam_64_ID` filter.
  - [`/stats/server/player/events`](https://api.warbandits.gg/stats/server/player/events?steam_64_ID=76561197975819827&events=kills%2Cdeaths) accepts a single SteamID64 and a comma-separated list of event names. It returned cumulative totals grouped by WarBandits server ID/name, without timestamps. This is useful for a cross-server footprint, not presence.
- Response headers identify a custom Express backend behind Cloudflare (`x-powered-by: Express`, `x-served-by: api.warbandits.gg`) with permissive CORS and a reported 60-request rate-limit window. No indexed OpenAPI, Swagger, SDK, or public API documentation was found, and exact route/field searches found no reusable upstream implementation. The routes must be treated as private WarBandits contracts exposed by its public client, not as a standard Rust API.
- The `events` route batches event types for one player, not players. A single controlled request using two repeated `steam_64_ID` parameters (the user's ID plus a synthetic ID) returned HTTP 500; no further undocumented batch syntaxes were probed. There is no verified endpoint accepting a requested list of SteamIDs or names in one call.
- The observed all-time `playtime` value of `3633.96` hours converts to the profile display `151D 9H 58M`, confirming that both views use the same server-specific cumulative counter. A positive delta can prove activity occurred between observations, but the counter has no observation timestamp and may update late.
- The WarBandits stats endpoint is therefore a strong source for `SteamID64 <-> current WarBandits name`, proof that a player appears in a particular server/wipe dataset, and numbered partial-name candidates. It can resolve identities for this network even when BattleMetrics player search is unavailable.
- It is not an authoritative online-presence source: no explicit per-player online flag or observation timestamp was found. A playtime/kill/death change between two on-demand observations is only evidence of activity during the interval and must be labelled as such, never converted into `online` or `just disconnected`.
- These endpoints are used by the public site but are not a documented stable third-party API. Any integration must use a five-second timeout, strict schema validation, bounded caching, serialized requests, and graceful fallback. Rate limits are not published. On HTTP 429 or a Cloudflare challenge, it must stop requesting until a persisted server-directed `Retry-After` or a conservative cooldown has elapsed; no immediate or blind retry. Candidate selection must validate the returned array itself rather than trusting pagination totals alone.

## Useful correlations and confidence

1. For a SteamID64, use WarBandits stats to obtain the server-specific player record and current name. Use BattleMetrics for live presence only when its server-scoped identity is independently linked; otherwise report identity/activity without claiming presence.
2. For a partial name, use WarBandits server/wipe rows to produce numbered candidates containing stable SteamID64 values. This is stronger than selecting a BattleMetrics homonym by display name alone.
3. Compare WarBandits connected counts, BattleMetrics population, and A2S population to detect stale or failing providers. Population agreement cannot identify a specific player.
4. Correlate the WarBandits wipe ID/date range with A2S `world.seed`, `world.size`, and `hash`, plus Rust+ map metadata, to build a wipe/map signature and prevent carrying activity evidence into the wrong wipe.
5. Steam `playing Rust` is only corroboration. WarBandits stat deltas are interval activity. BattleMetrics server sessions are the best external live signal available here. Only owner-side RCON/server plugins are authoritative.

Do not infer teams, locations, inventories, or combat relationships from simultaneous activity or similar names. Store only identifiers required by the tracker and retain the source, observation time, and confidence with every derived fact.

## Other server-level sources assessed

- Steam's official [`ISteamMatchmakingServers`](https://partner.steamgames.com/doc/features/multiplayer/game_servers) can discover the same class of server-browser metadata as A2S, but not a trustworthy arbitrary-player list.
- [Just-Wiped](https://just-wiped.net/rust_servers/3040629), [WipeRadar](https://wiperadar.com/server/warbanditsgg-3x-soloduotrioquadlootx3-just-wiped-140-28015), and [GameMonitoring](https://gamemonitoring.ru/rust/servers/10815449/api) expose secondary server directory/wipe observations. They may help confirm endpoint changes or a wipe when WarBandits is unavailable, but they add no verified SteamID64-to-live-session link and may lag their upstream query. They are not recommended as player-tracker dependencies.
- Public Steam groups/friend lists can enrich known identities when visible, but membership or friendship is not evidence of a Rust team or current server presence.

## Recommended integration order

1. Keep BattleMetrics as the sole online/offline source and alert trigger.
2. Use the detached WarBandits provider only on demand during player resolution: SteamID64/name resolution, candidate caching, identity linking, and statistics. It must not poll in the background or emit online/offline transitions.
3. Optionally add a detached A2S server-metadata provider for health, population, build, uptime, map seed/size, entity count, FPS, memory, and URLs. It is useful even during a BattleMetrics API outage.
4. Optionally enrich tracked SteamID64 records through the official Steam Web API, but label presence only as `Steam online` or `playing Rust`; never infer `online on WarBandits` from that alone.
5. Read WarBandits' public server payload for joining/queued counts and wipe schedule using the same isolated provider and cache.
6. Do not integrate WarBandits `A2S_PLAYER`: its identities are censored on the observed server.

## Implemented integration

`src/plugins/warBandits/index.js` implements the on-demand provider. The first applicable `!track` loads and caches the complete validated `/servers` array for one hour, selects the active server by exact BattleMetrics ID and then exact normalized hostname, and performs one server-scoped `/stats/<slug>` lookup for the requested SteamID64 or name. Identical concurrent lookups are coalesced and response results are held for five minutes.

The provider persists `data/warbandits/servers.json` and `data/warbandits/<guildId>-<serverSlug>.json` atomically with LF endings. The sidecar records sourced identity fields, aliases, statistics, observation times, and deltas between explicit resolutions. Its presence field is `unknown` until the identity is linked to a reliable BattleMetrics observation; WarBandits data can never set it. No periodic WarBandits hook is exported.
