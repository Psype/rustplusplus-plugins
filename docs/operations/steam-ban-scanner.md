# Steam ban scanner

Standalone, read-only scanner for the known player population. It is deliberately outside the bot process: Steam or
WarBandits timeouts, rate limits, and scanner crashes cannot stop Rust+/Discord. It never writes to
`data/player-intelligence`.

## What it produces

Generated files live under ignored `data/steam-ban-scanner/`:

- `identities.csv` / `identities.jsonl`: prioritized input snapshot;
- `identity-export.json`: source, count, generation time, and snapshot hash;
- `scan-state.json`: resumable run status without API secrets;
- `runs/<run-id>/results.jsonl`: immutable raw projected Steam results;
- `ban-cache.jsonl`: latest bounded Steam result cache used across compatible/expanded snapshots;
- `warbandits-cache/<server>/`: one resumable all-time leaderboard page per file;
- `recent-game-bans.csv` / `.jsonl`: current shortlist, ready to upload or inspect.

The report includes SteamID64/profile URL, current Steam persona when returned, locally verified aliases,
BattleMetrics IDs, Steam ban counters, approximate last-ban date, public Rust playtime, local/API WarBandits hours,
priority rank, wipe/observation counts, and first/last local observation.

Steam playtime is `unknown` for private game libraries. WarBandits playtime is server-specific cumulative evidence,
not total Rust playtime and not presence evidence.

## API key

Create a Steam Web API user key, then keep it only in the deployment `.env`:

```dotenv
RPP_STEAM_WEB_API_KEY=replace_with_private_key
```

The key is sent only to the Steam Web API and is never written to snapshots, state, reports, errors, or logs.

## Local database scan

Export every consolidated SteamID64 from every player-intelligence guild/server database:

```bash
npm run steam-bans -- export
```

Priority is deterministic:

1. most distinct server/wipe scopes;
2. most confirmed, non-duplicate clan captures;
3. most identity plus clan observations;
4. oldest first observation.

Then scan slowly, resuming the current compatible run automatically:

```bash
npm run steam-bans -- scan --days 5
```

The threshold is strict: `--days 5` retains Steam `DaysSinceLastBan` values 0 through 4, matching “less than five
days.”

Defaults are 25 SteamIDs per ban request and at least 15 seconds between every Steam request. Only recent candidates
receive the extra batched persona request and one public Rust-playtime request. `Ctrl+C` finishes the current batch,
fsyncs results/state, and exits; run the same command to resume.

Each new candidate is printed immediately as a `MATCH | ...` console line after its batch is durable. In parallel,
the CSV/JSONL shortlist is atomically refreshed after every batch. The immutable per-run result journal is keyed by
SteamID64; a resumed run skips completed IDs and neither calls nor prints them twice.
The delay and batch size may be changed when resuming; they are request policy, not result identity.

Useful bounds:

```bash
# First 5,000 prioritized identities only
npm run steam-bans -- scan --days 5 --max-ids 5000

# Require multiple local observations
npm run steam-bans -- scan --days 5 --min-observations 2

# Require evidence across at least two distinct server/wipe scopes
npm run steam-bans -- scan --days 5 --min-wipes 2
```

Changing the snapshot, top limit, day threshold, or selection starts a new immutable run automatically. Fresh Steam
results shared with the previous snapshot are reused, so expanding a top 300 to top 500 normally queries only the 200
new SteamIDs. `--restart` explicitly starts a new run but still permits this fresh cache reuse. Previous run JSONL
remains under `runs/`; canonical intelligence data is never reset.

Both Steam results and WarBandits pages are reusable for 24 hours by default. Change or disable that window with:

```bash
npm run steam-bans -- scan --days 5 --cache-hours 72
npm run steam-bans -- scan --days 5 --cache-hours 0
```

Use `--force` when every selected SteamID must be queried again regardless of a compatible completed/cache state:

```bash
npm run steam-bans -- scan --days 5 --force
```

`--force` creates a fresh run ID, bypasses both Steam and WarBandits caches, and re-queries every selected ID/page. It
does not delete earlier scanner runs or any canonical player-intelligence data. The current CSV/JSONL shortlist is
immediately reset to an empty valid report, then filled batch by batch by the new run.

## WarBandits top N

For a small high-value first pass, export only the top all-time PvP leaderboard ranks. WarBandits currently accepts
25 rows per all-time page, so a top 300 uses 12 bounded pages with a five-second page gap; the same slow Steam scanner
then runs:

```bash
npm run steam-bans -- run --warbandits-server eu5xnobps --warbandits-top 300 --days 5
```

The request uses `wipe=all-time`, PvP category 1, descending kills, and preserves the API's player `rank`, SteamID64,
name, and playtime. It does not traverse the complete all-time population. Use `--warbandits-top 250` for 250 rows or
`--warbandits-delay-ms` to increase the page interval.

The limit is operator-defined from 1 to 10,000. Cached pages make extensions incremental:

```bash
# Any bounded limit is accepted.
npm run steam-bans -- run --warbandits-server eu5xnobps --warbandits-top 100 --days 5
npm run steam-bans -- run --warbandits-server eu5xnobps --warbandits-top 200 --days 5

# Later: pages/ranks 1-300 and their fresh Steam results are reused; only 301-500 are fetched/scanned.
npm run steam-bans -- run --warbandits-server eu5xnobps --warbandits-top 500 --days 5
```

Each successful page is written atomically before the next page starts. HTTP 429 honors `Retry-After`; transient 5xx,
network, or malformed-response failures use bounded exponential backoff. After five failures the command stops on the
unfinished page, preserving every prior page/result so the same command resumes without duplicates.

Steam ban, persona, and playtime requests apply the same bounded 429/5xx/network retry policy. Each retry is printed
with only the operation, HTTP status, attempt, and wait duration; API keys and request URLs are never logged.

## Accuracy boundary

The official Steam response exposes `NumberOfGameBans` and one aggregate `DaysSinceLastBan`. Therefore the report
means:

> at least one game ban exists, and the account's latest Steam ban of any supported type is less than X days old.

If an account has an old game ban and a new VAC ban, that account can be a false positive for “new game ban.” Steam
may also return a `bans` detail array; the JSONL preserves its bounded numeric fields, but Valve does not document the
`BanType` values on the endpoint, so the scanner does not invent a mapping. A game ban is not necessarily a Rust ban.

Provider errors never create a clean result. A failed required ban batch is retried with bounded backoff and remains
pending after final failure. Optional name/playtime enrichment may be `partial` without discarding the verified ban
summary.
