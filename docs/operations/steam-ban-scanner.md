# Steam ban scanner

Standalone, read-only scanner for known SteamID64 values. It runs outside the bot, so provider timeouts, rate limits,
or scanner crashes cannot stop Rust+/Discord. It never writes to `data/player-intelligence`.

## No account or key

The scanner never uses Steamworks, a Steam Web API key, a Steam login, or cookies. It reads the public ban header shown
by `steamcommunity.com/profiles/<SteamID64>/`, one profile at a time. HTML is bounded and structurally validated;
challenge, error, or changed-layout pages fail closed instead of becoming clean results.
Steam may redirect a numeric profile to its vanity `/id/<name>/` URL. The scanner follows at most one such redirect,
only on the exact `https://steamcommunity.com` origin; external, credentialed, malformed, or chained redirects fail.

## Output

Generated files live under ignored `data/steam-ban-scanner/`:

- `identities.csv` / `.jsonl`: prioritized input snapshot;
- `identity-export.json`: source, count, generation time, and snapshot hash;
- `scan-state.json`: resumable run status;
- `runs/<run-id>/results.jsonl`: immutable projected profile results;
- `ban-cache.jsonl`: reusable latest results;
- `warbandits-cache/<server>/`: one resumable all-time leaderboard page per file;
- `recent-game-bans.csv` / `.jsonl`: current shortlist, ready to upload.

The report includes SteamID64/profile URL, public persona when readable, locally verified aliases, BattleMetrics IDs,
game/VAC-ban counts, approximate last-ban date, WarBandits hours, priority rank, wipe/observation counts, and local
first/last observation. WarBandits hours are server-specific cumulative evidence, not total Rust playtime or presence.

## Local intelligence database

Export all consolidated SteamID64 values from every player-intelligence database:

```bash
npm run steam-bans -- export
npm run steam-bans -- scan --days 5
```

Priority is deterministic:

1. most distinct server/wipe scopes;
2. most confirmed, non-duplicate clan captures;
3. most identity plus clan observations;
4. oldest first observation.

Useful bounds:

```bash
npm run steam-bans -- scan --days 5 --max-ids 5000
npm run steam-bans -- scan --days 5 --min-observations 2
npm run steam-bans -- scan --days 5 --min-wipes 2
```

`--days 5` is strict and retains displayed values 0 through 4. The scanner makes one request at a time, with at least
15 seconds between requests by default. `Ctrl+C` finishes the current profile, fsyncs state/results, and exits. Running
the same command resumes without calling or printing completed SteamID64 values again.

Every new match is printed after its result is durable. CSV/JSONL reports are atomically refreshed after every profile.

## Cache, extension, and force

Changing the snapshot, top limit, day threshold, or selection starts a new immutable run. Fresh results shared with a
previous snapshot are reused, so expanding top 300 to top 500 normally queries only the 200 new SteamID64 values.
`--restart` starts a new run but permits fresh cache reuse. Historical run journals remain under `runs/`.

Steam profile results and WarBandits pages cache for 24 hours by default:

```bash
npm run steam-bans -- scan --days 5 --cache-hours 72
npm run steam-bans -- scan --days 5 --cache-hours 0
npm run steam-bans -- scan --days 5 --force
```

`--force` creates a fresh run, bypasses both caches, and re-queries every selected profile/page. It does not delete
earlier runs or canonical player-intelligence data.

## WarBandits top N

WarBandits currently accepts 25 rows per all-time page. The operator selects any limit from 1 to 10,000:

```bash
npm run steam-bans -- run --warbandits-server eu5xnobps --warbandits-top 100 --days 5
npm run steam-bans -- run --warbandits-server eu5xnobps --warbandits-top 300 --days 5
```

The request uses `wipe=all-time`, PvP category 1, descending kills, and preserves API rank, SteamID64, name, and
playtime. Increase the page interval with `--warbandits-delay-ms` when needed.

Later extension reuses fresh pages/ranks 1-300 and their profile results:

```bash
npm run steam-bans -- run --warbandits-server eu5xnobps --warbandits-top 500 --days 5
```

Each successful page/profile is persisted before the next. HTTP 429 honors `Retry-After`; transient 5xx, network, or
malformed-response failures use bounded exponential backoff. After five failures the command stops at the unfinished
item, preserving prior progress. Retry logs contain only the operation, status, attempt, and delay.

## Accuracy boundary

The public profile exposes a game-ban count and one aggregate “days since last ban” value. A reported candidate means:

> At least one game ban exists, and the account's latest displayed Steam ban is less than X days old.

An old game ban plus a newer VAC ban can therefore be a false positive for “new game ban.” A game ban is not
necessarily a Rust ban. The public header does not identify the banned game or expose Steam Rust playtime reliably, so
the scanner invents neither; WarBandits hours remain available when supplied by that source.

Provider errors, profile challenges, missing markers, and malformed ban text never create a clean result.
