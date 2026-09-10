# External Rust/Steam data sources — 2026-09-10

Target observed: WarBandits EU 5X NoBPs (`eu5xnbp.warbandits.gg`, BattleMetrics server `9456371`). This report records capabilities verified on 2026-09-10; dynamic values must not be hard-coded.

## Verified WarBandits endpoints

- The public [WarBandits server page](https://warbandits.gg/en/servers) embeds the server hostname, BattleMetrics ID, connected/joining/queued counts, maximum population, group limit, multiplier, last wipe, and next wipe. It reported the game endpoint through DNS SRV on UDP `28010`.
- The live Steam A2S query port is UDP `28015`. `A2S_INFO` answered after the standard challenge and exposed server name, Rust application metadata, current/max population, build/tags, and a map label.
- `A2S_RULES` returned 38 public keys. Useful observed fields included `build`, description fragments, `ent_cnt`, `fps`, `fps_avg`, `gc_cl`, `gc_mb`, `hash`, header/logo/map URLs, `pve`, `uptime`, server URL, `world.seed`, and `world.size`. Facepunch documents the public query port and its use by server browsers and third-party services in [Creating a server](https://wiki.facepunch.com/rust/Creating-a-server).
- `A2S_PLAYER` answered, but returned 94 generic names such as `chelsie`, `joesph`, and `kiesha` while the public WarBandits page reported a materially different connected count. These are masked identities, not players that can be matched to SteamID64 or BattleMetrics IDs. Facepunch documents that `censorplayerlist true` masks names exposed to third-party server-list scrapers in [Creating a hidden, whitelisted server](https://wiki.facepunch.com/rust/Creating_a_hidden_whitelisted_server).

Conclusion: a passive A2S plugin could independently collect server health, population, build, map metadata, wipe hints, uptime, entity count, FPS, and memory. On this WarBandits server it must never use `A2S_PLAYER` as an enemy-presence source.

### Determinism of censored names

The anonymized name is not freshly randomized for each query. A reverse-engineered implementation dumped from Rust maps a SteamID64 to one entry in the game's `RandomUsernames` list with:

`(steamId % 2147483647) % RandomUsernames.length`

See [`realstrings/rust-de-stream-mode`](https://github.com/realstrings/rust-de-stream-mode/blob/main/de.py). The list already bundled with this bot contains 5,163 distinct names and no duplicate entry. Therefore, while the game algorithm and list remain unchanged:

- one SteamID64 produces the same censored name across repeated A2S queries, reconnects, wipes, and servers;
- two different SteamIDs can produce the same name because the mapping compresses every possible SteamID into only 5,163 outputs;
- for one target among 99 other independently distributed players, the theoretical chance that at least one other player has the same censored name is about 1.9%; among 199 others it is about 3.8%; real SteamID allocation is not guaranteed to be uniform;
- a future Rust update can change the list or algorithm, so this is a reverse-engineered implementation detail rather than a supported Facepunch contract.

This creates a possible low-confidence sensor: calculate the expected censored name from a known SteamID64 and look for it in A2S. Presence proves only that at least one SteamID in the same collision bucket is online; absence may also be affected by A2S caching/query failure. It must not emit authoritative `online` or `just disconnected` notifications without corroboration.

BattleMetrics receives the same censored A2S name when it has only the public query source. Its own documentation says unverified profiles are name-based, activity under the same name is merged, and censored non-RCON Rust lists result in functional anonymity. Thus a stable censored name may create a stable name-based BattleMetrics record, but it is not a verified link to the real SteamID and collisions can merge different players. An owner-authorized RCON feed can provide the real SteamID independently; that data is unavailable to this bot.

### Cross-correlation without BattleMetrics

A user-supplied `real name -> SteamID64` relation or an exact WarBandits stats result is sufficient to create the stable identity. The bot can then calculate the censored alias locally; BattleMetrics is not needed for this mapping. A detached presence provider can combine:

1. the SteamID64 as the canonical key and the real/WarBandits names as aliases;
2. the deterministic censored A2S alias;
3. A2S player presence plus its connection-duration field to follow the visible alias session;
4. a cached inverse index `censored alias -> known WarBandits SteamID64 set` to expose known collisions;
5. on-demand WarBandits playtime/stat deltas and optional public Steam `playing Rust` state as corroboration.

This can prove target activity when that target's WarBandits counters advance, and it can make a currently visible censored session highly probable when its known collision bucket is unique. It still cannot prove which SteamID owns a visible alias when multiple known candidates collide, nor exclude a new/uncached WarBandits account in the same bucket. Such observations must retain a confidence/source field: `ambiguous` for a collision, `probable` for a unique known alias with fresh A2S, and `activity-confirmed` only for a target-specific WarBandits delta. The final state remains probabilistic rather than server-authoritative.

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
- [Just-Wiped](https://just-wiped.net/rust_servers/3040629), [WipeRadar](https://wiperadar.com/server/warbanditsgg-3x-soloduotrioquadlootx3-just-wiped-140-28015), and [GameMonitoring](https://gamemonitoring.net/developers/docs/api/servers/:server_id/players/__get) expose secondary server directory/wipe observations. GameMonitoring explicitly returns players only when the game and server expose them. They may help confirm endpoint changes or a wipe when WarBandits is unavailable, but they add no verified SteamID64-to-live-session link and may lag their upstream query. They are not recommended as player-tracker dependencies.
- Public Steam groups/friend lists can enrich known identities when visible, but membership or friendship is not evidence of a Rust team or current server presence.

## BattleMetrics Premium capability audit

The active Premium plan shown on 2026-09-10 exposes Player Log, Player Flags, an increased update rate for favorite servers, browser/email/SMS alerts, three months of detailed player logs and session history, advanced player searches, player notes, and the web UI's Related Player/Played With views. Only the read-only player information relevant to this bot is integrated.

- Premium Player Log and session pages can answer who joined during a time window, who was online at a specific time, and each session's join/leave/duration. The implemented player-history endpoint is scoped to a tracked BattleMetrics player and locally rechecked against the active server.
- `GET /players/{playerId}/relationships/coplay` exposes player-level co-play data. Its live contract rejects the session-style `filter[servers]`/`include` combination, so the plugin calls the endpoint without those parameters and filters locally only when a server relation is present. It is distinct from RCON **Player Queries / Global Player Matching**, which targets alternate-profile research, requires organization participation/permissions, and can use private identifiers without revealing them. This bot does not call Player Queries, identifiers matching, flags, notes, bans, or any write endpoint.
- The plan's increased update rate states that favorite servers are queried at least once every five minutes. The bot polls BattleMetrics once per minute, but it cannot make BattleMetrics refresh the upstream Rust server more frequently. Favorite the active WarBandits server manually in BattleMetrics to receive that plan benefit; the bot does not need the `Favorite Servers` token permission.
- The access-token permission editor has no separate Player Log, Sessions, Co-play, or public Player Search checkbox. Those read surfaces are subscription/account capabilities. The plugin therefore needs no RCON or write scope. A 403 is reported as `subscription or permission denied` because BattleMetrics can still restrict a resource independently of the token's checkbox list.
- Premium is not server-owner authority. BattleMetrics explicitly reserves SteamID/unique-identifier search for server owners and administrators, and hidden/private/streamer sessions can remain unavailable. On censored Rust lists an unverified profile can be name-based rather than a proven Steam identity.
- BattleMetrics' current privacy documentation describes a rolling 12-month retention ceiling for granular public session data, while the Premium plan/player-log UI advertises three months of accessible detailed logs. The bot requests only a bounded recent page and does not attempt archival scraping.

## Free BattleMetrics alternatives assessed

| Source | Free/self-hosted | Useful signal | Blocking limitation on WarBandits |
| --- | --- | --- | --- |
| [RustMetrics](https://github.com/swiss-shift-ch/rustmetrics) | Yes, MIT/self-hosted | A2S population and display-name sessions; Discord transitions | Its documentation explicitly detects Rust streamer-mode anonymization and states that watchlisting cannot work there. It stores only display names from A2S and SteamIDs only when BattleMetrics surfaces them. WarBandits' observed A2S names are censored. |
| [GameDig](https://github.com/gamedig/node-gamedig) or direct A2S | Yes | Server health, population and any public player names | GameDig can fetch only what the server publishes; its player name may be empty and its player array may differ from the population. It cannot recover SteamID64 from WarBandits' masked names. |
| [GameMonitoring](https://gamemonitoring.net/developers/docs/api/servers/:server_id/players/__get) | Public endpoint | Cached server/player directory data when exposed | The provider documents that the player list exists only when the game/server expose it. It is therefore another view of the same censored source, not an identity bypass. |
| Steam Web API / [RustRadar-style presence](https://rustradar.net/) | A Steam Web API key is free; up to 100 SteamIDs per `GetPlayerSummaries` request | Steam online/offline and current-game presence when public | `playing Rust` does not identify the Rust server. Private/invisible users produce incomplete evidence, so absence must remain `unknown`, not `offline on WarBandits`. |
| WarBandits public stats | Yes but undocumented and rate-limited | Strong SteamID64/name resolution and interval activity deltas | No per-player online flag or timestamp; it cannot emit exact connect/disconnect transitions. |
| RCON or an owner-side uMod/Carbon endpoint | Software can be self-hosted | Authoritative connected SteamID64 list | Requires cooperation and credentials from WarBandits. It is unavailable to a normal player account. |

No free external service was found that can map an arbitrary SteamID64 to a live session on this specific WarBandits server after `censorplayerlist` is applied. This is a source-data limitation, not a missing client library: aggregators using A2S receive the same masked list, Steam exposes at most coarse public presence for arbitrary users, and BattleMetrics now rejects the required server/player API without a subscription.

## Recommended integration order

1. Latest decision (2026-09-10): the user has an active BattleMetrics Premium subscription. BattleMetrics is therefore the primary configured presence source for this deployment. Its failure remains `unknown`, never a disconnect, and never cancels another provider or a committed tracker change.
2. Keep the existing 60-second BattleMetrics server poll as the only transition source. Premium detail endpoints are invoked on demand and must not create a second poller or independently emit online/offline alerts.
3. Keep the detached WarBandits provider on demand for SteamID64/name resolution, numbered candidates, identity caching, and statistics. It must not turn stat deltas into connect/disconnect events.
4. Use BattleMetrics server-player information, session history, and co-play as bounded read-only enrichment. Co-play is not proof of team membership or an alternate identity.
5. Keep Steam presence as optional coarse corroboration only. `playing Rust` does not identify the Rust server.
6. Add server-authoritative exact SteamID presence only if WarBandits later supplies an authenticated endpoint, RCON access, or an owner-side feed. Premium does not grant a normal player access to another organization's RCON identifiers.
7. Do not integrate WarBandits `A2S_PLAYER`: its identities are censored on the observed server. A detached A2S provider remains useful only for server metadata and health.

## Implemented integration

`src/plugins/warBandits/index.js` implements the on-demand provider. The first applicable `!track` loads and caches the complete validated `/servers` array for one hour, selects the active server by exact BattleMetrics ID and then exact normalized hostname, and performs one server-scoped `/stats/<slug>` lookup for the requested SteamID64 or name. Identical concurrent lookups are coalesced and response results are held for five minutes.

The provider persists `data/warbandits/servers.json` and `data/warbandits/<guildId>-<serverSlug>.json` atomically with LF endings. The sidecar records sourced identity fields, aliases, statistics, observation times, and deltas between explicit resolutions. Its presence field is `unknown` until the identity is linked to a reliable BattleMetrics observation; WarBandits data can never set it. No periodic WarBandits hook is exported.

`src/plugins/battlemetrics/index.js` now owns the read-only Premium API boundary used by `playerTracker`. It provides server-scoped search, optional SteamID enrichment, server-player summaries, recent sessions, and co-play with a five-second timeout, fixed origin, bounded immutable parsing, short caches, coalescing, and 429 cooldown without retry. `!trackinfo`, `!trackhistory`, and `!trackrelated` persist only bounded sanitized summaries in the schema-2 tracker projection. The actual online/offline transition path remains the existing BattleMetrics poller.

The repository-root `.env` is now loaded by `config/index.js`; the access token is stored only as `RPP_BATTLEMETRICS_TOKEN`. The committed `.env.example` contains an empty placeholder. The token is not an application ID and is never written into projections or logs. See `docs/battlemetrics_and_trackers.md` for the permission-minimized setup and the explicit sanitized live verifier.
