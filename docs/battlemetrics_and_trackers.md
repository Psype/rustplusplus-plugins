# BattleMetrics Premium and Player Trackers

## Authentication

BattleMetrics API access requires the active subscription associated with the access token. Create a personal access
token in the BattleMetrics developer settings, copy `.env.example` to the repository-root `.env`, and set:

```dotenv
RPP_BATTLEMETRICS_TOKEN=replace_with_the_access_token
```

The value is an access token, not a client/application ID. `.env` is ignored by Git and loaded before `config/index.js`
is evaluated; an existing process environment variable takes precedence. Never add the real token to `config/index.js`,
`docker-compose.yml`, a service file committed to Git, logs, screenshots, or support output.

The tracker only performs read-only player/server requests. It does not call the Account, Favorite Servers, RCON,
Bans, Player Flags, Player Notes, Triggers, or other mutation endpoints. Leave all those access-token permissions
unchecked. If BattleMetrics requires at least one selection to create the token, `Account > Basic Account Information`
is the narrowest fallback and is not used by the tracker; validate the resulting token with the live check below. Do
not grant `View RCON information`: the
user is not an administrator of the WarBandits server and that permission would not grant access to another
organization's private identifiers.

## Implemented data flow

| Signal | BattleMetrics endpoint | Bot behavior |
| --- | --- | --- |
| Current roster/status | `GET /servers/{serverId}?include=player` | Existing 60-second BattleMetrics poll; sole source of online/offline transitions and notifications. |
| Server-scoped player search | `GET /players?filter[search]=...&filter[servers]=...` | Resolves `!track`; a direct BM ID wins, then currently-online name matches are ranked before historical offline profiles. Ambiguous or truncated results require numbered selection. |
| Player identifier | `GET /players/{playerId}?include=identifier` | Adds SteamID64 only when BattleMetrics exposes a valid Steam identifier. |
| Server-specific player summary | `GET /players/{playerId}/servers/{serverId}` | Read on demand by `!trackinfo`; persists first/last seen and playtime when supplied. |
| Session history | `GET /players/{playerId}/relationships/sessions` | Read on demand by `!trackhistory`, filtered again locally to the active server. |
| Co-play/related players | `GET /players/{playerId}/relationships/coplay` | Read on demand without unsupported server/include parameters; locally filters a server relation when BattleMetrics supplies one. Never labelled as a team or identity proof. |

The Premium provider is isolated in `src/plugins/battlemetrics`. It uses one five-second request per command endpoint,
fixed HTTPS origin, no redirects, bounded responses, strict JSON:API validation, five- or ten-minute caches, and
in-flight request coalescing. A provider is never retried blindly. HTTP 429 establishes a process-wide cooldown for
that HTTP client using `Retry-After`/rate-reset headers; 401, 403, 404, timeout, and malformed responses remain distinct
sanitized failures. Tokens and raw response bodies are never logged.

## Commands and storage

- `!track <partial name|SteamID64>` starts tracking on the active BattleMetrics server. Use `!track #<number>` after
  an ambiguous search.
- `!tracklist` / `!tracks` lists current status or last seen.
- `!trackinfo <tracked player>` obtains the Premium server-specific summary.
- `!trackhistory <tracked player>` obtains recent sessions on the active server.
- `!trackrelated <tracked player>` obtains BattleMetrics co-play results.
- `!untrack <partial name|BattleMetrics ID|SteamID64>` stops tracking.

Tracking is idempotent by BattleMetrics player ID and by a proven SteamID64. If a player was first added from a
BattleMetrics profile whose Steam identifier was unavailable, a later `!track <SteamID64>` resolving to that same
profile enriches the existing entry atomically. It returns `Tracking updated`, keeps one native tracker/player record,
and preserves its aliases, timestamps, presence, and Premium summaries instead of creating a duplicate.

Presence notifications remain exactly `Tracked player <name> is now online.` and
`Tracked player <name> just disconnected.`. A failed API call never becomes an offline transition and never erases the
last successful data. Premium detail commands do not mutate tracker presence or emit transitions.

The readable projection is `data/player-trackers/<guildId>-<battlemetricsServerId>.json`. Schema 2 keeps stable IDs,
aliases, status and timestamps plus sanitized Premium summaries. It does not store access tokens, IP addresses, raw
identifiers, notes, flags, response bodies, or unbounded logs. Schema 1 files are migrated in memory and rewritten as
schema 2 on the next normal tracker update.

## Verification and limits

After setting the token and restarting the service, obtain a tracked player's BattleMetrics ID from `!track` or the
JSON projection and run:

```bash
npm run test:battlemetrics:live -- <battlemetrics-server-id> <battlemetrics-player-id>
```

This explicit read-only check probes server-player information, sessions, and co-play. It prints only availability,
field presence, counts, truncation, sanitized HTTP category and retry time; it never prints the token, configured IDs,
names, response values, headers, or bodies.

Premium improves the available history and BattleMetrics' refresh rate, but it does not bypass Rust's censored player
list, a private/hidden BattleMetrics profile, or server-owner-only access. BattleMetrics states that unique identifier
search is unavailable to non-owners, and private/streamer sessions can be hidden even from subscribers. The bot
therefore keeps BattleMetrics player ID as its tracking key, treats SteamID64 as optional enrichment, and never infers
identity from co-play alone.

References: [BattleMetrics API documentation](https://www.battlemetrics.com/developers/documentation),
[SteamID search restrictions](https://learn.battlemetrics.com/article/54-how-can-i-search-for-a-player-by-steam64id),
[profile visibility and retention](https://learn.battlemetrics.com/article/44-what-can-i-do-to-hide-my-player-profile),
[Player Log](https://www.battlemetrics.com/servers/arma3/2197362/sessions), and
[Player Queries](https://blog.battlemetrics.com/posts/player-queries/).
