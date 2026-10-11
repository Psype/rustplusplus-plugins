# Project memory

Concise cross-session context for this Rust+/Discord fork. Read this file, then
[`docs/ai/current-state.md`](docs/ai/current-state.md). Load only the thematic document needed for the task.
Historical detail is archived and is not part of the default AI context.

## Non-negotiable rules

- Preserve every pre-existing worktree change unless the user explicitly asks to remove it.
- Never use destructive reset/checkout operations and never delete persistent data to repair startup.
- Never delete, truncate, or silently rewrite `data/player-intelligence` or its sidecars.
- `Established` and wipe boundaries are GMT. Every `/cinfo` panel computes its own wipe.
- Ignore the Discord capture date when deriving `/cinfo` history.
- F7 proves identity evidence only; it never proves current presence.
- OCR-only names remain pending. Only trusted Steam/API/manual evidence creates verified aliases.
- Provider failure means `unknown`, never an invented logout.
- Keep secrets out of Git, logs, docs, and responses. Relevant secret-bearing paths include `.env`, `credentials/`,
  `rustplus.config.json`, FCM captures, and runtime logs.

## Current release

- Canonical version: `1.22.46` in `package.json` and `package-lock.json`.
- `1.22.46` reorganizes documentation, shortens the default AI context, and updates runtime/help references to the new
  paths. It does not change player-intelligence semantics.
- Last behavioral release: `1.22.45`, commit `adc9e85` before this documentation release.
- Last completed behavioral validation: 430/430 unit tests plus `tsc --noEmit -p .` on 2026-10-11.
- Local tests do not prove Linux/systemd behavior, external providers, OCR availability, or production memory.

## Architecture in one page

- Entry point: `index.js`, running native `node .`; production must not retain `ts-node`.
- Plugin registration and isolation: `src/plugins/pluginManager.js`.
- Rust+/Discord instance lifecycle: `src/structures/RustPlus.js`, Discord event handlers, and FCM utilities.
- Player intelligence: append-only events under `src/plugins/playerIntelligence/`; projections are reconstructible.
- Heavy identity scan: disposable `src/workers/playerScanWorker.js`; the parent remains the only journal writer.
- Provider IPC: exact request/response contracts, bounded size/time/capacity, late-result rejection.
- Presence authority: BattleMetrics complete rosters may infer offline; incomplete/censored/failed samples cannot.
- Name reconciliation: `src/util/playerNameReconciler.js`; ordinary intel uses closest-match mode, tracking uses precise
  selection mode.
- Command catalogue: parsed at runtime from `docs/reference/features.md`; detailed examples live in
  `docs/reference/commands.md`.

## Persistent data model

- `data/player-intelligence/`: canonical append-only identity/clan/presence/metric evidence and scan checkpoint.
- `data/teammate-language-database/`: canonical CSV history; caches are disposable, rows are not.
- `data/warbandits/`: provider sidecars/cooldowns.
- `instances/`, `credentials/`, player trackers, OCR correction libraries, and visual alias libraries are persistent.
- Back up `data/player-intelligence` before deploying schema-sensitive changes. Since `1.22.45`, journals may contain
  `provider_availability_observed`, which releases through `1.22.44` cannot parse.

## Player-intelligence semantics

- Stable identity keys are SteamID64 and BattleMetrics player ID. Exact trusted names may connect missing fields;
  fuzzy/OCR evidence must not.
- Current Steam persona is the preferred display name. Verified past Steam/API names may appear as alias history.
- Unverified OCR corrections never become historical aliases.
- `/cinfo` counts distinct confirmed snapshots; duplicate captures count once. Clan observations do not prove presence.
- `!intel`/`!steamid` return the closest local identity for a name fragment. `!track` remains precise and may show a
  selector. `!record` is strict manual linking. `!scanplayers` explicitly starts/queues bounded reconciliation.
- WarBandits lookup order is current wipe, relevant recent wipe, then all-time; ambiguous all-time results remain
  manual. WarBandits is identity/activity enrichment, not presence authority.

## Runtime guarantees and known limits

- Translation, OCR, and player scans use bounded queues/process boundaries; optional failure must not stop core Rust+.
- The scan child uses a compact projection. Parent provider invocations are capped at eight globally/four per
  provider, with four calls in flight per worker and a 30 s default RPC timeout (allowed range 1-45 s).
- Steam/WarBandits alias responses are capped at 256; WarBandits pages at 100 rows.
- Teammate CSV reads are capped at 16 cached files, 40,000 rows, 32 MiB, ten minutes; each file is capped at 10,000
  rows/8 MiB. Incomplete reads fail closed without modifying the file.
- JSONL append/revision work is still `O(N)` and is instrumented as `pi_history_append`.
- Main-process shutdown grace is 30 s so an in-progress fsync/checkpoint commit is not normally cut off.

## Open production checks

- Deploy `1.22.45+` only after backing up `data/player-intelligence`.
- Confirm `RUSTPLUS v<version> OPERATIONAL`, at least one scan worker `completed`, bounded provider backoff, and no
  recurring 18-22 s parent projection stalls in `/runtime`.
- Observe RSS/heap over several scan cycles; local benchmarks are not production evidence.
- Re-test the real Discord OCR import that previously exposed the KIRK name/Established issue.
- FCM phone receipt still does not prove delivery to the bot virtual device. Validate with a live matching alarm.

## Release workflow

For code or runtime-configuration changes:

1. inspect `git status --short`, `git diff --check`, and the existing diff;
2. preserve unrelated/user changes;
3. increment SemVer in `package.json` and `package-lock.json`;
4. update this file, `docs/ai/current-state.md`, and the relevant thematic document;
5. run targeted tests, then `npm.cmd test`, then `git diff --check`;
6. commit the complete release and push `master` to `origin/master`.

Documentation-only restructuring may still use a patch release when runtime paths or user-facing help URLs change.
Never claim deployment success from local tests.

## Documentation routing

- Index and reading order: [`docs/README.md`](docs/README.md)
- Current AI handoff: [`docs/ai/current-state.md`](docs/ai/current-state.md)
- Setup: `docs/setup/`
- User reference: `docs/reference/`
- Architecture: `docs/architecture/`
- Runtime operations: `docs/operations/`
- Player intelligence: `docs/player-intelligence/`
- Rust+/FCM transport: `docs/transport/`
- Frozen historical context: `docs/archive/`

Use the archive only for chronology or forensic detail. Do not load it for ordinary tasks.
