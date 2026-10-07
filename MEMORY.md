# Project Memory

This file is the cross-session memory for this Rust+ / Discord bot fork. Keep it updated when project behavior, user preferences, debugging workflows, or architecture changes.

## Project purpose and user expectations
- The repo is a Rust+ / Discord bot plugin forked from `alexemanuelol/rustplusplus`.
- It connects to the Rust+ Companion API and provides Rust team-chat plus Discord command/event tooling.
- Keep commands in the same style as existing in-game commands, with localized syntax/messages where practical.
- When adding localization keys, every language JSON should keep key parity with English. Non-English language files should receive translated text, not English placeholders. Command syntax values should remain command-like ASCII unless that language already customizes them.
- This memory file is the source of truth for future ChatGPT sessions. Prefer concise, non-contradictory summaries over raw chronological dumps.
- Every completed code or runtime-configuration change must increment the canonical SemVer in both `package.json` and
  `package-lock.json`. Use a patch increment unless the user explicitly requests a minor/major release; the
  `RUSTPLUS v<version> OPERATIONAL` message is derived from that package version.
- Standing deployment workflow: after every completed and validated release, commit it and push `master` to
  `origin/master` automatically. The Linux deployment should then need only `git pull`; never leave a finished release
  only in the local Windows repository unless a push fails, in which case report that failure explicitly.

## Current handoff (2026-10-04)
- Read `docs/ai_session_handoff_2026-10-04.md` first for the compact, copy-ready resumption context, exact worktree
  inventory, architecture map, safety invariants and remaining live checks. This `MEMORY.md` remains the detailed source
  of truth when the handoff links here.
- Preserve the existing worktree. The original handoff began at `a3a71a8`; on 2026-10-06 the user committed and pushed
  `d327e7d`, which contains the `1.22.24` tightly-spaced `/cinfo` fixes, the `1.22.25` reusable player-name reconciler,
  and the `1.22.26` private Discord identity-correction workflow. Release `1.22.27`, immediately after that commit,
  contains the interaction/translation latency bounds and documentation updates. Release `1.22.28` groups pending
  aliases by known BattleMetrics identity and adds date-selected recent-wipe WarBandits fallback. Release `1.22.29`
  centralizes local identity consolidation and imports verified current/past Steam profile names in the background.
  Release `1.22.30` makes repeated SteamID text lots idempotent and prevents one unavailable Steam profile from
  starving every later ID in the enrichment queue. At the latest completed release audit, `master`, `origin/master`
  and `origin/HEAD` were aligned on `1.22.29` immediately before this release; `1.22.30` is the current release. Only
  `master` plus
  the useful
  `origin/master`/`upstream/master` remote-tracking references remained. Do not reset, overwrite, reimplement or
  discard these changes. Re-audit `git status --short` and `git diff` if the observed state differs.
- Canonical package version is `1.22.30`. The complete local validation on 2026-10-06 passed `267/267` unit tests and
  `tsc --noEmit`; `git diff --check` was clean. This is local deterministic evidence only. Deployment/restart and a
  new Discord import of the reported KIRK screenshot remain unconfirmed, so do not claim production success.
- Primary unresolved production fact: raid and **Pair with Server** notifications were observed on the Rust+ phone but not on the bot. The 2026-09-23/24 journal showed accepted MCS logins and quick reconnects but no inbound notification. Phone receipt proves Facepunch delivery to the phone only; MCS login proves Google accepted the bot's GCM identity only. Facepunch delivery to the bot's virtual device still requires a live capture. Canonical transport audit: `docs/fcm_transport_audit_2026-09-23.md`.
- Implemented receiver path: `src/util/reliableFcmReceiver.js` owns accepted-login readiness, stream position, heartbeat/ack, inactivity detection, ports 5228/443 and capped reconnect; `fcmAlarmRouter.js` routes Host/Lite `alarm`; `src/plugins/raidAlarm/` performs immediate authoritative Rust-chat delivery and five-second duplicate suppression. Current Facepunch/Liam/RustPlusApi evidence still uses GCM/FCM/MCS and `appData.channelId=alarm`; no schema migration was found.
- `!alarmstatus` reports MCS, generic push proof, matching server-pair age, alarm age, Host/account match, output/mute, raw logging and up to five alarms. An operational Rust+ connection with a saved `playerToken` reports `pair active` and **does not** arm a re-pair watcher. Only an unpaired/non-operational server arms one guild-scoped 120-second watcher; repeating the command does not add another timer. Entity-pair or another server/account cannot satisfy it. `!raidtest` validates outbound Rust chat only.
- Release `1.22.1` moves the recognized raid alert's Rust team-chat text to
  `config/raid-alarm.json`. `inGameMessageTemplate` is re-read for every incoming raid and supports `{title}`,
  `{message}`, `{item}` and `{location}`. Invalid/missing configuration or unavailable structured fields log a warning
  and immediately use the built-in complete `{message}` template; configuration failure cannot cancel the critical
  server-authoritative Rust+ delivery. Generic non-raid Smart Alarm text is unchanged.
- Release `1.22.2` fixes `/cinfo` role classification at the OCR word-box boundary: pale/desaturated beige is a normal
  member, saturated bright yellow is a leader, and saturated blue is a moderator. Brown world-background pixels are
  ignored and an unreadable color remains `unknown`; beige antialiasing can no longer promote every member to leader.
  No absolute screen coordinates are used.
- Release `1.22.3` upgrades the persistent per-server `visual-alias-library.json` to backward-compatible schema 2 with
  a bounded glyph↔Unicode-grapheme journal (4,096 total, 12 variants per grapheme, 64 glyphs per alias). It learns only
  from exact, case-faithful, already-resolved `/cinfo` spellings whose foreground segmentation is one-to-one; connected
  or uncertain writing is skipped. New captures use glyph sequences to retrieve/rank same-length known aliases, but
  glyph evidence never marks an identity corroborated by itself. Existing whole-word exact matching remains the only
  strong visual proof. No raw screenshot pixels are stored; schema 1 remains readable and corruption stays preserved.
- Release `1.22.4` refines each structurally incomplete `/cinfo` panel in one semantic, relatively bounded OCR crop,
  and repairs an invalid `Established` value through a separate PSM 7 numeric read. Raw/masked panels are selected
  independently instead of selecting one whole-image pass. Visual roster association now requires a complete declared
  roster plus unique, ordered, non-overlapping member word boxes; a partial list can no longer shift Marley's shape or
  glyphs onto Swizzy's parsed index. Role-color inference follows the same proven partition, and neither whole-word nor
  glyph learning accepts a `/cinfo` spelling changed by identity resolution. In an incomplete roster, only an exact
  case-folded alias may resolve automatically; decoration stripping, fuzzy matching and external corroboration remain
  provisional until boundaries are complete. The visual sidecar is now schema 3: schema 1/2 files are validated and
  preserved but their unsafe pre-boundary samples are ignored, then the derived cache rebuilds from confirmed imports.
  Canonical player/clan events are unchanged.
- Release `1.22.5` makes the Discord confirmation preview distinguish OCR transcription from identity resolution.
  `/cinfo` now reports `names read` and `linked` separately; a partial panel shows the bounded OCR roster in original
  roster order, then the linked identities separately. Thus `d.ve` can be visibly read while remaining unlinked, rather
  than disappearing from the `Members` line. Confirm/Reject semantics and persisted data are unchanged. This also
  exposes the exact remaining Marley/Swizzy transcription on the next upload instead of masking it behind resolution.
- Release `1.22.6` isolates every complete `/cinfo` roster member from the relative comma and final standalone `and`
  separators. Wrapped fragments are stitched into one temporary row per member, converted to the Rust UI text mask,
  enlarged 4x under an 8 Mi-pixel derived-image cap and read together by one bounded PSM 6 process per panel. No fixed
  screen coordinate is stored. A result
  is accepted only when row count/uniqueness match and each row preserves the same Unicode letters/numbers at the same
  roster index; it may therefore return `』` to `Marley` and remove it from `Swizzy`, but cannot exchange or invent
  their names. These proven image fragments also drive role-color voting and whole-word visual samples; stitched rows
  never train the glyph journal. Failure is warning-only and keeps the previous parsed roster.
- Release `1.22.7` gives a structurally incomplete `/cinfo` roster one additional bounded PSM 6 read of the roster
  field alone; it is accepted only when panel identity is unchanged and structural quality improves. If OCR still
  fuses or damages names, each cinfo preview has an `Edit <tag>` button. Its modal requires exactly the declared count,
  one unique Unicode name per line, then reruns the existing identity resolver/corroboration and shows a new preview;
  nothing changes before the normal Confirm click. After a successful canonical commit, manually confirmed names are
  added to a 2,000-entry per-server OCR lexicon in `visual-alias-library.json` and supplied to future Tesseract
  `--user-words`. They are not treated as SteamID proof and do not train pixel/glyph samples unless a later automatic
  boundary is independently safe. The visual sidecar is schema 4; schema 3 visual/glyph samples migrate intact.
- Release `1.22.8` extends requester/guild/channel/server/wipe-bound Discord import decisions from five to thirty
  minutes. Reimporting an already committed image now displays the active previous interpretation beside the proposed
  one and requires `Replace previous` or `Keep existing`. A confirmed replacement preserves the original observation
  time and logical counter position unless an edited `Established` explicitly rebinds its regular wipe; it supersedes
  its prior identity/snapshot events, then rebuilds identity, clan and
  affinity projections from the corrected content; it never increments snapshot or `Played with` counts. Replacement
  is repeatable. The append-only journal retains validated supersession markers for crash-safe reconstruction, while
  superseded content disappears from every effective profile/history/counter. A stale replacement preview fails closed.
- Release `1.22.9` recovers a `/cinfo` whose first OCR pass loses the `Members` or `Established` anchor. It derives
  isolated tag/count/date rows from neighboring semantic lines (including a projected missing count row), uses PSM 7
  with digit-only alphabets for count/date, validates every reconstructed value, and never uses fixed screen pixels.
  This repairs the observed `Mernbe genx`, missing `6`, and unread `10/01/2026 19:33:49` case. When the count remains
  unread, the Discord preview keeps every OCR-read roster name visible and separately reports linked identities.
- Release `1.22.11` acknowledges the cinfo roster-edit modal with `deferUpdate()` before loading identities or calling
  optional WarBandits/Steam corroboration, then edits the deferred response. Discord's three-second deadline can no
  longer produce the generic `Something went wrong` banner merely because resolution is slow; validation failures
  still leave the preview unchanged. Its former capture-time and same-wipe batch rules were removed by `1.22.13`.
- Release `1.22.12` makes the full pending cinfo interpretation editable in one textarea: line 1 is the exact ClanTag,
  line 2 is `Established` in `MM/DD/YYYY HH:mm:ss` GMT, and every remaining line is one exact player name. Tag/date/
  roster are strictly revalidated, identity resolution reruns, and changing `Established` recomputes the inferred
  regular wipe before a new preview is shown. No canonical event or OCR lexicon changes before Confirm.
- Release `1.22.13` removes the former capture-time/same-wipe rules. Capture labels and slash `captured_at` are no
  longer used. Every `/cinfo` block independently derives its Tuesday/Friday 14:00 GMT regular wipe and persisted
  `observedAt` from its own strict `MM/DD/YYYY HH:mm:ss` `Established`; blocks for different wipes may share one image
  and grouped confirmation. The comma-delimited roster sheet excludes delimiter pixels and maps OCR lines back by row
  slot, so a missing line cannot shift Marley onto Swizzy. Confirmed edits with proven boundaries persist image→Unicode
  transcription templates in bounded atomic `ocr-correction-memory.json`, separate from identity evidence; exact
  repeats correct automatically, approximate matches require score 0.985/margin 0.03, and collisions/short fuzzy names
  fail closed. Existing confirmed words can safely repair separated peripheral noise such as `1 Marley 4` but never
  `1Marley4`. F7 adds a muted-gray-ID pass only after normal F7 OCR finds no IDs, repairs at most two common OCR
  substitutions in a range-valid SteamID64, then requires the uppercase OCR name to resemble the public Steam persona
  or an alias already tied to that ID; mismatched/unverifiable rows are excluded with a warning. Version is `1.22.13`.
- Release `1.22.14` handles severe all-caps F7 transcription failures without weakening reconstructed IDs. If an
  unambiguous row contains a range-valid 17-digit SteamID read with no character substitution and OCR confidence at
  least 80, a successful public Steam lookup may supply the canonical persona even when the OCR name is dissimilar
  (`KASANE TETO` read as `of a`). The preview marks the row `[Steam-recovered]` and shows the rejected OCR text before
  confirmation. Any ID repaired through OCR substitutions, lower-confidence read, ambiguous row or unavailable profile
  retains the strict name-similarity rule. A confirmed recovered F7 crop trains the visual alias against the Steam
  persona, never the bad OCR string. Version is `1.22.14`.
- Release `1.22.15` runs the muted-gray F7 preprocessing pass on every F7 image, not only when normal OCR finds zero
  IDs. Variant selection favors unrepaired SteamID64 values repeated across passes and then numeric OCR confidence.
  A same-ID persona comparison accepts a long common core despite a damaged decorative prefix, covering
  `L @*X4LAZY2ERO` versus `零^x Lazy2ero`. When Steam is unavailable, an unambiguous unrepaired ID repeated by at least
  two OCR variants at confidence 60 or above is retained as a reversible `[OCR-consensus]` pair with event confidence
  `probable`; it cannot train authoritative visual evidence. Reconstructed, single-pass and low-confidence unresolved
  IDs still fail closed. Steam profile concurrency is two and transient negative results expire after thirty seconds,
  without an automatic retry. Version is `1.22.15`.
- Release `1.22.16` gives F7 genuinely different OCR inputs. The full muted-gray pass is digit-only. Every complete,
  partial or name-only inferred ID row is then cropped from relative OCR boxes, background-masked, assembled into one
  bounded 4x sheet and reread once with PSM 6 plus a numeric whitelist. This can repair digit-to-digit errors that still
  looked like valid SteamID64s and recover IDs absent from the whole-image pass. It uses no fixed screen coordinates and
  never spawns one process per player; duplicate/shifted/out-of-range reads and sheets above 8 Mi pixels fail closed.
  The preview reports the number of successfully reread isolated rows. Version is `1.22.16`.
- Release `1.22.17` removes the full JSONL reread and projection rebuild from every player-intelligence command.
  Each per-server journal keeps one immutable in-process event snapshot, guarded by shard name/size/mtime signatures so
  out-of-process changes and corruption are still detected. A successful append creates a new snapshot reference,
  which automatically invalidates the WeakMap projection cache. Identity lookup is indexed by SteamID64,
  BattleMetrics ID and normalized exact name; clan affinity uses a symmetric per-person adjacency index instead of
  scanning every known pair. Complete clan snapshots no longer build the expensive unresolved-name candidate index.
  The `benchmark:affinity` corpus (300 players, 600 snapshots, 900 events) measured a 0.67 ms warm command mean versus
  53.27 ms for forced uncached reconstruction, about 79.5x faster on the local workstation. Version is `1.22.17`.
- Release `1.22.18` adds a restart-safe background identity daemon clocked by the existing 60-second BattleMetrics
  hook, never by a second presence poller. A known SteamID64 is refreshed from its actually-online BattleMetrics
  identity at most once per wipe; later ordinary BattleMetrics name-change deltas still remain active. On the exact
  recognized WarBandits server, one serialized, cached `wipe=0` page of at most 100 rows is consumed per tick and a
  completed sweep sleeps twelve hours before looking for later arrivals. New automatic SteamID/BattleMetrics joins
  require an exact unique normalized live name of at least three characters and no conflicting existing link; they
  remain `probable`. The atomic per-server `scan-daemon.json` persists page cursor, seen SteamIDs and wipe refreshes,
  preserves corrupt state, coalesces overlapping ticks, and never produces presence/login/logout observations.
- Release `1.22.19` lets the configured private intelligence-import channel accept a strict text-only batch of 1 to
  100 complete SteamID64 values, one per non-empty line. Blank and duplicate lines are harmless, while any invalid line
  rejects the whole batch. It reuses only unique local name/BattleMetrics links, keeps unknown IDs without inventing an
  alias, and uses the existing thirty-minute Confirm/Reject, duplicate/replacement, durable journal and background
  identity-enrichment paths. Channel routing remains ID-based, so renaming `intel-imports` to `intel-reports` is safe.
- Release `1.22.20` acknowledges every non-modal Discord intelligence-import decision before durable work, edits the
  original message to `Import processing…`/`Import queued…`, serializes mutations per guild/server, and locks each
  pending token against double clicks or a concurrent Edit/Reject. Final success, duplicate replacement prompt, or safe
  failure edits the deferred response. Modal submission keeps its early defer and now shares the same token lock.
- Release `1.22.21` completes the command audit around the server-wide intelligence journal. `!intel` is the canonical
  complete compact player lookup and now includes exact aliases plus rolling 30-day activity; `!steamid` is an exact
  compatibility alias rather than a teammate-only lookup, and `!who` reads server-wide aliases instead of the language
  CSV. `!record <SteamID64> <BattleMetrics ID> <exact name>` writes an idempotent manual identity observation and
  rejects a BattleMetrics ID already linked to another SteamID. `!scanplayers` immediately starts or queues a bounded
  forced current-wipe identity pass with a five-minute manual cooldown; normal pages still advance on the existing
  BattleMetrics hook. Team state, live `!player/!players`, and tracker commands remain because they expose distinct
  Rust+/current-session/alert functions. Recent literal commands are reserved from smart-device name collisions.
- Release `1.22.22` keeps a `/cinfo` panel with an OCR-empty/invalid ClanTag pending when its count, roster and
  `Established` fields make it safely editable. Discord shows `Edit unknown tag`, disables Confirm, and refuses even a
  forged confirmation without writing or consuming the pending preview. A valid modal correction reruns identity/timing
  validation and then enables confirmation; non-editable malformed panels still fail closed immediately.
- Release `1.22.23` gives confirmed text SteamID imports a restart-safe priority enrichment queue: one exact
  WarBandits all-time SteamID lookup runs per existing BattleMetrics tick, while the existing current-wipe sweep still
  consumes one 100-row page per tick. Both paths journal exact names and changed cumulative WarBandits playtime as a
  separate `player_metric_observed` event. `!intel`/`!steamid` render the latest value as a lower bound such as
  `WB hours:7500+`; playtime never implies online presence. Priority attempts run once per wipe and `!scanplayers`
  resets them for an explicit retry. Schema-1 daemon checkpoints migrate in memory to schema 2.
- Release `1.22.24` preserves Tesseract TSV page/block/paragraph/line identifiers so tightly spaced `/cinfo` rows are
  not recombined by geometric proximity. Wrapped final names stay before the following `Established` row, and common
  `l`/`I`/`1` anchor confusion is tolerated without relaxing strict GMT timestamp validation. An unreadable date now
  remains pending with `Edit <tag>` and disabled Confirm when the count/roster are safely editable; the corrected date
  reruns wipe inference, while forged confirmation still writes nothing.
- Release `1.22.25` adds `src/util/playerNameReconciler.js`, a provider-neutral exact/canonical/prefix/contained-name
  ranker accepting either one query or several fragments that must occur in the same alias. Read-only `!intel`,
  `!steamid`, `!who`, `!affinity` and `!activity` use deterministic `first` mode, so `!intel tree` can select
  `Cockornut Tree` without a selector and without creating identity evidence. Tracker, tracked-player and WarBandits
  resolution use `precise` mode; equal best candidates still require the existing numbered `!track` selector, and
  current-online priority remains ahead of stale exact profiles.
- WarBandits name/Steam resolution separates every wipe scope cache. `!track` uses `wipe=0`; OCR and imported-SteamID
  verification check `wipe=0`, then the numeric `/wipes/<server>` interval containing/nearest to the individual
  block's GMT `Established` (or the newest completed interval without a timestamp), then `all-time` only when the
  narrower scopes are empty. The first candidate set stops fallback and ambiguity remains manual. Wipe IDs are opaque,
  selected by interval and never derived arithmetically. Live checks on 2026-10-06 showed `peng` unique on `wipe=0`
  but ten results
  on `all-time`. Repeated/bracketed/indexed/comma/JSON `player_name` values using `KOH` + `PENG` all returned zero, so
  multiple high-confidence OCR fragments must be requested separately and reconciled locally; automatic fragment
  fan-out is not enabled until per-fragment OCR confidence is explicit.
- Release `1.22.28` makes `/intel pending` emit one row per unresolved projected identity, with a separate alias count
  and grouped historical spellings. `FUNTIK`, `gus` and `+=import&**` therefore form one pending identity when they
  share `BM:1192585926`. `/cinfo` now calls a member `linked to known identities` only when SteamID64, BattleMetrics ID
  or both are present, and shows `[Steam]`, `[BM]` or `[Steam+BM]`; name-only matches stay pending. The WarBandits
  provider validates/caches `/wipes/<server>`, accepts opaque positive numeric wipe IDs, and exposes the bounded
  current -> relevant completed interval -> all-time resolver used by OCR corroboration and daemon priority lookups.
  A unique WarBandits Steam proof can join an exact, unique, non-conflicting local BattleMetrics identity, so a pasted
  SteamID enriches the existing BM alias group instead of creating a parallel Steam-only person. Ambiguous all-time
  results never join automatically.
  The 2026-10-06 live catalogue placed `8467` at 2026-10-02 through the 2026-10-06 wipe and `8398` at the earlier
  2026-10-01 through 2026-10-02 interval. A `FUNTIK` lookup was empty in current/8467/8398 but returned four distinct
  all-time Steam identities, so it is deliberately left for manual resolution.
- Release `1.22.29` adds `identityConsolidator.js` as the single conservative local boundary used when an observation
  supplies any combination of SteamID64, BattleMetrics ID and exact name. It queries the current projection, fills a
  missing stable ID from an existing stable link or from one unique trusted exact name, fills a missing display name,
  and returns matched/link/conflict/ambiguity metadata. Fuzzy or partial command matching remains read-only and can
  never mutate identity history; low-fidelity OCR, ambiguous names and conflicting stable IDs fail closed. Runtime
  BattleMetrics/tracker ingestion, Discord imports and replacements, WarBandits daemon rows, exact import
  corroboration, manual records and identity-candidate projection now use this boundary instead of parallel join code.
  A combined Steam+BM `identity_observed` event is the durable link; no destructive row merge is required.
  The background daemon also reads the public Steam Community current persona plus `/ajaxaliases/` history for one
  known SteamID per tick and at most once per wipe. The current persona is marked `current`; returned former names are
  stored as verified `past` aliases and displayed as such by `/intel history`. Past aliases never perform exact-name
  stable-ID joining and never outrank the current Steam name. Steam failure is warning-only/cached and creates no
  presence evidence.
- Release `1.22.30` treats a repeated exact SteamID text lot as an idempotent refresh view instead of an OCR-style
  replacement. The preview still resolves every ID from the current local projection, but confirmation preserves the
  original append-only evidence, writes no supersession event and never offers `Replace previous`. Daemon schema 4
  records completed Steam profiles separately from attempted profiles: success, partial alias-history failure or total
  failure all advance fairly to the next ID on the following BattleMetrics tick. `!scanplayers` clears only incomplete
  attempt checkpoints so failed/partial profiles can be retried without needlessly rereading completed histories.
- Release `1.22.27` makes `/intel` call Discord's ephemeral `deferReply()` before logging, context loading, permission
  work or player-intelligence journal reads. The command remains administrator-only; this removes local processing
  from Discord's initial response window. AutoTranslate now allows at most two seconds per provider and five seconds
  for the complete sequential Google/DeepLX-or-LibreTranslate/Bing/MyMemory chain, while preserving provider order and
  the target-script validator. The original team-chat relay remains independent; translation decisions now log
  `elapsedMs`. A retained slash command can still show `The application did not respond` when the bot is offline: the
  2026-10-06 local inspection found `TokenInvalid`, no active Node process, and no local Discord token/client ID.
  Restore valid runtime secrets and restart before treating any Discord timing test as production evidence.
- Release `1.22.26` adds the administrator-only, ephemeral Discord `/intel` command. `pending` was introduced to
  paginate identities lacking a verified SteamID64; as of 1.22.28 it groups aliases already sharing an identity.
  `link` attaches one exact alias to a SteamID; `merge` targets a
  verified exact alias/SteamID/BattleMetrics ID; `history` lists only verified aliases with dates; `links` audits active
  rules; and `unlink` reverses them. Link/merge read the current public Steam persona, falling back only to an already
  Steam/API-verified local alias; no manually entered name can enter verified history. `identity_linked` may now also
  redirect a source BattleMetrics ID and carry the verified target display name, so all retained snapshots reproject
  without rewriting raw events. Counts add across snapshots
  and deduplicate by person inside one snapshot. OCR-only spellings such as `ChiCo` remain non-verified correction
  evidence: they can route historical `Ch1co` observations but never appear in verified alias history or canonical OCR
  candidates. Revocation restores the evidence-only projection, and nothing under `data/player-intelligence` is deleted.
  `docs/commands.md` and `docs/full_list_features.md` separately document the Discord-only correction/import workflow
  and the in-game-prefix lookup/tracking workflow, including `ChiCo` -> `Ch1co` and partial-name examples.
- `!logs on` captures every decoded Host/Lite MCS message before routing in private LF JSONL `logs/rustplusplus-fcm-raw.jsonl`. It can contain team text, server addresses, Steam IDs and pairing tokens. A write failure is warning-only and cannot cancel delivery.
- The workspace contains an ignored, untracked `rustplus.config.json`; it contains push secrets and must never be committed, published or copied wholesale to the Linux server. Import only `fcm_credentials.gcm.androidId`, `fcm_credentials.gcm.securityToken` and SteamID64 through Discord `/credentials add ... host=true`. Re-adding the same owner/SteamID atomically replaces the credentials and restarts the listener.
- The installed local registration CLI has an untracked `node_modules/@liamcottle/rustplus.js/cli/index.js` override pointing `chromePath` to `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`. Dependency reinstall removes that override. The reproducible local command and caveat are in `docs/credentials.md`; do not assume Chrome exists on this workstation.
- Live validation after deployment: restart, run `!logs on`, then `!alarmstatus`. If it reports `pair active`, no watcher is expected; use Rust **Pair with Server** and confirm a new raw `channelId=pairing` entry, then re-run `!alarmstatus` to inspect the pair receipt age. If the server is actually unpaired/non-operational, the command instead starts the 120-second proof. Finally trigger a real alarm and require, in order, `notification received: channel="alarm"`, `alarm received`, and `raid-alarm.in-game: delivered`. Phone-only receipt still means the bot registration is stale/missing.
- BattleMetrics Premium remains the primary player-presence source. Do not replace it with RustRadar: on 2026-09-28 RustRadar's player API returned `503`, its client exposed BattleMetrics-shaped IDs, and its terms prohibited automated extraction without written permission. Canonical decision and costs: `docs/rustradar_battlemetrics_audit_2026-09-28.md`.
- The 2026-09-30 global player/clan study specifies an isolated `playerIntelligence` event store, not expansion of the mutable tracker/CSV. The fusion is a read projection over independent `playerTracker`, member DB, F7, `/cinfo`, WarBandits and BattleMetrics observations; matching SteamID64/BattleMetrics references are reused rather than recollected or written back, while name-only links remain reversible. Internal person/provider IDs, provenance and confidence remain diagnostic metadata only. The in-game allowlist is current name, full SteamID64, BattleMetrics ID, reliable compact state, verified aliases, `Known tags`, `Played with`, and conservative activity; OCR-only spellings remain pending correction evidence. Omit unavailable fields, all profile URLs, WarBandits references and debug metadata. Alias dates remain a private Discord/history concern. F7 is an opaque recent list containing encountered players and global-chat authors, so it proves no presence; its uppercase names use `caseFidelity: false` and its copy icon is only an OCR fallback. Scroll-overlap is deduplicated by SteamID64; clipped names are never inferred, complete IDs may be retained without an alias, and partial IDs are rejected. Each confirmed `/cinfo` is a time-stamped wipe-bound clan snapshot with leader/moderator/member roles and mutable roster. There are no inter-clan alliances. `x` counts distinct confirmed `/cinfo` snapshots with that tag/shared tag, duplicate hashes count once, BattleMetrics co-presence never increments it, and overflow uses `+N`. `!activity <player> [1mo|all]` uses a rolling 30 days by default or all retained local events; week/4w/wipe scopes are removed. It reports server presence, not `/cinfo` clan state; storage is UTC, outages are `unknown`, source overlaps never duplicate duration, screenshots never overwrite stronger data, and optional WarBandits corroboration never rolls back an import. Steamworks local `k_EFriendFlagOnGameServer`/`GetFriendCountFromSource` can expose the current server source with exact SteamID64/persona, consistent with the user's real-time Overlay observation. No official Web API or verified SteamKit2/ASF CM endpoint enumerates that source: PersonaState only enriches known IDs, friends-who-play only returns friends, `CMsgGSPlayerList` is game-server-to-Steam, and ASF `play 252490` does not emulate Rust/server auth. A same-account passive ASF callback probe may test whether the source is replicated but is expected to see only self/friends/known IDs; a different bot account cannot work. Preferred production path, if leave/rejoin latency is validated, is a one-shot/local Windows Steamworks helper with signed snapshots and no credential export. Canonical study: `docs/player_intelligence_and_clan_tracking_study_2026-09-30.md`.
- Superseding F7 identity rule: F7 remains non-presence evidence. A similar same-ID Steam persona/known alias normally
  validates the uppercase OCR name. A dissimilar name may use the public persona only for an unambiguous, unmodified
  17-digit ID read at confidence 80 or above; the preview exposes that recovery for manual confirmation. If Steam is
  unavailable, two agreeing unrepaired passes at confidence 60 or above retain the pair as probable OCR consensus.
  Reconstructed, single-pass, lower-confidence or ambiguous IDs fail closed.
- Only the currently configured `WarBandits EU 5x NoBPs` server is known to wipe every Tuesday and Friday at 14:00
  GMT; never apply this cadence to another WarBandits server. Historical `/cinfo` scope deliberately ignores forced
  wipes and other intermediate observed boundaries, including the short forced-to-regular interval, and binds each
  block independently to the latest regular boundary at or before its own `Established`.
- Every pushed `/cinfo` block is assumed to concern the currently configured server, never another server; it may
  belong to the current wipe or any earlier wipe. By explicit deployment decision, `Established` is both the
  clan-instance creation time and the only backfill anchor persisted as `observedAt`; capture/upload time is ignored.
- WarBandits `/cinfo Established` and wipe boundaries are interpreted directly in GMT/UTC. On
  2026-09-29, the regular wipe is therefore 14:00 GMT and `Established: 14:58` means the clan was created 58 minutes
  after the wipe. No French-local-time conversion is applied.
- `src/plugins/playerIntelligence/` now implements the schema-validated/deep-frozen event contracts, serialized monthly JSONL journal under ignored `data/player-intelligence/<guild>/<battlemetricsServerId>/`, corruption fail-closed behavior, identity/clan/presence/wipe projections, and compact `!intel`/`!steamid`, `!who`, `!record`, `!scanplayers`, `!affinity`, `!activity [1mo|all]`, `!clan`, `!clanhistory`, and `!clantop` commands. It observes global BattleMetrics transitions through the existing poll after `player-tracker`; first poll is an observation rather than a fake login, stale transition arrays are ignored on provider failure, outage is `unknown`, recovery observes the full known roster, and quiet polls write/reproject nothing. A 200-player benchmark reduced silent poll work from 25.397 ms to a 0.041 ms median after the unchanged-poll guard; command-dispatch median increased only 0.559 µs.
- `/intelimport cinfo image:<attachment>` and `/intelimport f7 image:<attachment>` are Discord-only, private-command-channel imports. They validate Discord CDN/MIME/extension/magic/size/pixels and accept PNG/JPEG/WebP. Extension and declared MIME may disagree; the bounded binary signature is authoritative. They compare serialized local `tesseract` reads of the original and one bounded/upscaled Rust-UI color mask (`RPP_TESSERACT_PATH`; Linux needs `tesseract-ocr` plus `tesseract-ocr-eng`); semantic structure selects each `/cinfo` panel independently. An incomplete panel gets one semantic relative crop, a still-incomplete roster gets one roster-field-only read, an invalid date gets one digit-constrained read, and a complete roster gets one comma-delimited isolated-row read; none of these optional refinements can cancel the import path. Persistent known aliases and manually confirmed OCR words feed a capped temporary UTF-8 `--user-words` file which is removed after use. Parsing uses semantic anchors/relative boxes without fixed screen pixels, previews, and binds thirty-minute Edit/Confirm/Reject/Replace tokens to requester/guild/channel/server/hash. Every cinfo block derives its own wipe/`observedAt` from its own `Established`; capture times are ignored and a batch may span wipes. The Edit modal uses tag/date/names line order, acknowledges Discord before slow resolution, recomputes that block's timing after date edits, and remains non-persistent until Confirm. A duplicate hash prompts with the effective previous and proposed interpretations; `Keep existing` changes nothing, while `Replace previous` rebuilds projections in the same logical counter position and can be repeated. F7 validates a range-correct SteamID and name similarity against that ID's Steam persona/known alias; weak rows are excluded. A `/cinfo` needs a valid tag, count and `Established` timestamp, but its roster may be partial: resolved members and `unresolvedMembers` commit atomically, pending slots never create exact aliases/affinities, and projections reconsider them automatically after later identity evidence. Multi-image/multi-panel batches fail closed on structurally invalid blocks or oversized previews.
- Release `1.22.30` narrows the preceding duplicate rule to image interpretations. A repeated exact SteamID text lot is
  an idempotent projection refresh: it shows current local names/links and keeps the original evidence without
  Replace/Keep or supersession.
- Live `/cinfo` OCR on 2026-10-01 proved the raw whole-image Tesseract `eng` PSM 6/11 pass unusable as an authoritative Unicode transcription: it mixed three panels, anchors, dates and rosters, and hallucinated roles. The implemented mitigation is a shared Unicode-aware candidate resolver over journal, tracker, BattleMetrics, Rust+ and same-batch F7 aliases: indexed exact/alphanumeric/accentless retrieval, bounded rare-bigram fuzzy retrieval, grapheme Damerau-Levenshtein, bigrams, script penalty, exact-writing preservation, conservative score/margin thresholds, stricter rules for names of at most five characters, and global one-to-one assignment. Fuzzy similarity alone stays provisional; an exact/structurally equivalent alias or unique external corroboration is required for an automatic link. Same-ClanTag history is tie-break evidence only. At most three provisional queries per batch use the existing rate-limited WarBandits provider and bounded public Steam profile-name reader; no Steam credential/API key is needed, external failure is non-blocking, and equally corroborated collisions stay unresolved. F7-only uppercase aliases are never promoted as canonical merely by matching. A 20-slot/2,000-alias synthetic benchmark fell from a 3,811 ms median exhaustive pass to 128 ms with indexed retrieval (-96.6%).
- Supplied name examples include decorated Latin, significant spaces, Turkish `İ`, Cyrillic, Korean and possible cross-script homoglyphs. Non-unique results persist with at most three bounded hypotheses and cannot imply a departure or pollute exact aliases/confirmed affinities; later stable aliases can resolve historical slots without another upload. Confirmed `/cinfo` crops and unambiguous F7 name/SteamID rows now populate the persistent, Git-ignored, per-server `visual-alias-library.json`: at most 2,000 normalized binary word-shape signatures and four per alias/identity, with no raw pixels. Exact feature repeats may corroborate an identity; approximate Dice/aspect matches only retrieve/prioritize and cannot hard-link, and exact collisions remain ambiguous. `/cinfo` visual learning and lookup are disabled unless the complete roster has a unique monotonic word-box partition; partial roster indexes have no positional meaning. The sidecar is atomic, validated and corruption-preserving; failure after the canonical event commit cannot roll it back. A 20-crop/2,000-signature benchmark improved from 600.386 ms to 115.941 ms median with decoded-feature caching (-80.7%). Local Rust bundle inspection found the probable `/cinfo` font `RobotoCondensed-Bold SDF`/TTF plus its UI materials and Noto Arabic/Hebrew/CJK/Emoji fallbacks. The preferred next OCR architecture is an offline sequence recognizer trained on synthetic Rust-font lines, backed by the glyph/alias atlas; a per-letter Roboto lookup alone cannot cover shaping, ligatures or every fallback. Still pending and not to be claimed as implemented: multilingual scene OCR such as PaddleOCR PP-OCRv5, synthetic visual font rendering/training, measured corpus weights, and Unicode-confusable retrieval. Canonical detail: `docs/player_intelligence_and_clan_tracking_study_2026-09-30.md`.
- PC-log verification on 2026-10-01 found no `cinfo`, `ClanTag`, `Established`, `WarBandits Clans`, `BEHO` or `FIND PLAYER` in the complete current `Player.log` (3,823,736,224 bytes, last written 2026-10-01 01:05 Europe/Paris). A second full targeted scan found no server connection/hostname, chat or SteamID64 signal, while the file contains over 11.6 million repeated AssetBundle/LogWarning lines. It starts with a failed root AssetBundle lookup under `C:\Windows\System32\Bundles\Bundles` and missing localization assets, so it represents a defective client launch and is useful only for local diagnostics, not `playerIntelligence`. The previously inspected ~160 GB log is now `Player-prev.log` after rotation and also had no cinfo markers; `output_log.txt` is absent. Do not upload/read these files wholesale. Only a fresh bounded `-logFile` experiment synchronized with the commands remains useful.
- Latest QA on 2026-10-03: `npm.cmd test` passes 222/222 including `tsc --noEmit`. New deterministic coverage includes immutable journal/projection cache reuse and append invalidation, external corruption detection while cached, exact SteamID64/BattleMetrics/name indexes, full ClanTag/Established/roster modal correction with wipe recomputation, acknowledgement before slow identity resolution, strict GMT `Established` parsing, independent mixed-wipe blocks in one image, Tuesday/Friday 14:00 GMT historical wipe selection, automatic captionless inference from each block's `Established`, deliberate forced/observed-intermediate-wipe exclusion, historical `observedAt`/wipe persistence, isolated recovery of a polluted tag plus missing count/date anchors, retention of every OCR-read name when the declared count is unread, thirty-minute import decisions, previous/proposed duplicate prompts, repeatable replacement without counter inflation, full link reprojection, `Keep existing`, stale-preview rejection, independent per-panel OCR selection, semantic panel and roster-field refinement reproducing the `n444shj` fusion, constrained date repair, comma-delimited member image rows, correction of `』Marley』`/`Swizzy` punctuation ownership, rejection of any isolated-row letter exchange or oversized derived sheet, manual roster count/uniqueness validation, no OCR-memory mutation before Confirm, confirmed image-to-Unicode correction recall, persistent confirmed-word reuse by later OCR, schema 3 visual preservation/schema 2 invalidation, ordered Marley/Swizzy word-box separation, rejection of repeated-name boundaries, refusal to extract/persist visuals from partial rosters, refusal to learn a resolver-corrected glyph spelling, exact-only automatic identity resolution for incomplete rosters, distinct OCR-roster/identity-link preview output, persistent glyph learning/recall, Unicode grapheme segmentation, `/cinfo` role colors, hot-reloaded raid placeholders, corruption preservation, partial snapshot commit, one-to-one identity assignment, short-name collision corroboration, conservative F7 SteamID OCR repair, digit-only muted F7 OCR, complementary-row fusion, one-call isolated SteamID sheet recovery, cross-pass ID consensus, decorative-core same-ID matching, probable evidence isolation, same-ID persona checks, exact high-confidence recovery of a badly transcribed Steam persona, canonical-only F7 visual learning, thirty-second transient Steam failure expiry and bounded external queries. Interactive Windows capture, a real Discord webhook, the Linux external providers and real screenshot OCR remain deployment checks, not simulated production success.
- Superseding QA for release `1.22.18` on 2026-10-03: `npm.cmd test` passes 227/227 including `tsc --noEmit`.
  The five added deterministic checks cover bounded current-wipe WarBandits pagination, once-per-wipe online SteamID
  refresh, wipe reset, durable resume state, and overlapping daemon-tick coalescing. The preceding 222/222 line is the
  `1.22.17` baseline, not the current total. External Linux provider behavior remains a deployment check.
- Superseding QA for release `1.22.19` on 2026-10-03: `npm.cmd test` passes 229/229 including `tsc --noEmit`.
  The two added checks cover strict line-based parsing/code fences/deduplication and the complete Discord preview,
  requester-bound confirmation and durable exact-SteamID commit. An unrelated FCM timing test timed out once during an
  earlier run, then passed both in isolation and in this complete rerun.
- Superseding QA for release `1.22.20` on 2026-10-03: `npm.cmd test` passes 231/231 including `tsc --noEmit`.
  The two added concurrency checks prove that separate imports for one server are acknowledged before a blocked commit
  and execute serially, while a repeated click is acknowledged but cannot execute the same pending token twice.
- Superseding QA for release `1.22.21` on 2026-10-03: `npm.cmd test` passes 234/234 including `tsc --noEmit`.
  The new checks cover the complete `!intel`/`!steamid`/`!who` views, Unicode-safe idempotent manual identity records
  with conflict rejection, immediate `!scanplayers` acknowledgement, completed-sweep bypass, cooldown, and one forced
  rerun queued behind an active daemon cycle. The command-catalog test also verifies the audited active command set.
- Superseding QA for release `1.22.22` on 2026-10-03: `npm.cmd test` passes 235/235 including `tsc --noEmit`.
  Its deterministic import check covers an unreadable ClanTag, disabled/forged confirmation with zero journal writes,
  retained editing controls, valid correction and final commit.
- Superseding QA for release `1.22.23` on 2026-10-03: `npm.cmd test` passes 238/238 including `tsc --noEmit`.
  New checks cover newest-playtime projection without presence inference, current-wipe page metric collection, exact
  priority enrichment for text-imported SteamIDs, once-per-wipe attempt persistence, and lossless schema-1 daemon-state
  migration.
- Superseding QA for release `1.22.24` on 2026-10-03: `npm.cmd test` passes 241/241 including `tsc --noEmit`.
  New deterministic checks preserve distinct Tesseract line IDs under overlapping geometry, recover a wrapped final
  member beside a fuzzy `Established` anchor, and keep an invalid date editable but impossible to confirm before a
  valid correction.
- Superseding QA for release `1.22.25` on 2026-10-06: `npm.cmd test` passes 249/249 including `tsc --noEmit`, and
  `git diff --check` is clean. New checks cover closest partial read lookup, multi-fragment same-alias reconciliation,
  precise ambiguity, online priority, current/all-time cache isolation, current-wipe tracker enrichment and
  Established-selected historical OCR corroboration.
- Superseding QA for release `1.22.26` on 2026-10-06: `npm.cmd test` passes 252/252 including `tsc --noEmit`, and
  `git diff --check` is clean. New checks cover reversible `ChiCo` -> `Ch1co` historical reprojection, cross-snapshot
  aggregation plus same-snapshot deduplication, verified-versus-pending alias separation, Discord Steam-persona display
  refresh, ephemeral replies, verified history filtering, pending/link listing and unlink restoration.
- Superseding QA for release `1.22.27` on 2026-10-06: `npm.cmd test` passes 253/253 including `tsc --noEmit`, and
  `git diff --check` is clean. New checks require `/intel` to defer before all other work and enforce a single total
  translation deadline in addition to provider-level cancellation. `npm.cmd run test:autotranslate:live` also passed
  in 8.9 seconds for six cumulative live/fallback scenarios (versus roughly 35 seconds before the cap); Bing timed out
  at its two-second bound and MyMemory completed that fallback. External provider health remains non-deterministic.
- Superseding QA for release `1.22.28` on 2026-10-06: `npm.cmd test` passes 259/259 including `tsc --noEmit`, and
  `git diff --check` is clean. New checks cover pending alias grouping by BattleMetrics identity, Discord rendering,
  name-only `/cinfo` candidates remaining pending, strict wipe-catalogue parsing, numeric wipe cache isolation,
  Established-selected historical lookup, all-time ambiguity, daemon use of the recent-scope resolver and safe
  SteamID/BattleMetrics joining from unique exact WarBandits evidence.
- Superseding QA for release `1.22.29` on 2026-10-06: `npm.cmd test` passes 266/266 including `tsc --noEmit`, and
  `git diff --check` is clean. New checks cover bidirectional missing-ID consolidation, exact-name ambiguity and stable
  conflicts, rejection of low-fidelity/unverified OCR as automatic link evidence, immutable results, daemon persistence
  of verified current/past Steam names, current-name display priority, once-per-wipe Steam refresh and bounded Steam
  alias parsing/caching.
- Superseding QA for release `1.22.30` on 2026-10-06: `npm.cmd test` passes 267/267 including `tsc --noEmit`, and
  `git diff --check` is clean. The Discord regression extends the text-list workflow to prove that a replay displays
  newly enriched local names without Replace/Keep or supersession. The daemon regression proves a failed first Steam
  profile cannot starve the next ID and that a forced `!scanplayers` cycle retries only incomplete attempts.
- Performance check for `1.22.3`: the dedicated glyph benchmark recalls the target among 2,000 aliases with 104 stored
  glyph variants and eight graphemes in a 20.797 ms median. The existing 200-player pipeline measured before/after at
  41.702/39.357 ms initial load, 0.044/0.030 ms quiet-poll mean and 51.356/50.742 ms for ten transitions; no measured
  regression. These are local synthetic timings, not production latency claims.

## Command and localization architecture
- In-game commands are routed through `src/handlers/inGameCommandHandler.js` and implemented mostly as `getCommand...` methods on `src/structures/RustPlus.js`, with some isolated feature handlers/plugins.
- Discord command-channel handling should generally match in-game command coverage where practical.
- `!commands [command]` and its `!help [command]` alias work in Rust team chat and the Discord commands channel. Both use `src/util/commandCatalog.js`, which reads the `## In-Game and Discord Commands` section of `docs/full_list_features.md` at runtime as the single documentation-backed source for names, aliases, synopsis, and descriptions. `test/pluginManager.test.js` compares that catalogue with every static syntax referenced by the native/custom handlers plus the player-tracker commands, preventing undocumented commands from passing CI.
- `!language <code>` updates the live guild instance, RustPlus runtime settings, guild intl cache, bot intl cache, and `config/index.js` fallback together. `!language` without an argument reports the current guild language and supported codes. `RPP_LANGUAGE` still overrides the config fallback on restart.
- `Config.general.language` controls bot/default logger intl; per-guild event and in-game command text uses each instance's `generalSettings.language` loaded into `guildIntl`. Existing default-English guild instances may be promoted to a non-English global config language during `DiscordBot.loadGuildIntl()`.
- Chinese (`zh`) is a full Simplified Chinese language option for the whole bot, not a Chinese-only fork. Existing commands remain predictable command-like ASCII unless deliberately localized.

## Bot/team-chat message formatting
- Bot messages sent back into Rust team chat use `[BOT] ` as the visible branding prefix when branding is enabled; `NOT SHOWING` still suppresses the prefix.
- Autotranslate labels only show the destination language, e.g. `[→zh] translated text`, because the source language is not important once the message is translated.
- Message-length calculations for bot-sent team chat must account for the rendered `[BOT] ` prefix length.

## Runtime settings and logging
- Runtime settings live under `config/`:
  - `config/logging-settings.json` for `!logs`.
  - `config/autotranslate-settings.json` for `!autotranslate`.
  - `config/raid-alarm.json` for the hot-reloaded recognized raid message sent to Rust team chat.
- Legacy paths are migrated/copied forward automatically where implemented (`logs/logging-settings.json` and `data/autotranslate-settings.json`).
- `!logs on|off` works in-game and Discord; disabling it preserves console output but suppresses every file/debug write under `logs/`, including Winston, raw WebSocket/FCM, decoded events, markers and snapshots.
- Guild-scoped runtime log prefixes use the compact literal `[server]` instead of the potentially very long Rust server name; the Discord guild ID remains present.
- The shared player identity/language CSV database is data, not config, and remains under `data/teammate-language-database/<guildId>-<serverId>.csv`.

## Current Rust+ map-marker limitation
- Facepunch's [Power Trip update](https://rust.facepunch.com/news/power-trip) of 2026-08-06 stopped sending vending-machine and event map markers (cargo, helicopters, and travelling vendor) to Rust+.
- A full live capture from 2026-09-08 contains 5,030 successful `getMapMarkers` responses over about 14 hours, with only 3-5 `Player` markers and no event, vending-machine, crate, or unknown marker. The same-server 2026-06-16 fixture contained 57 vending machines and one travelling vendor. Polling and protobuf decoding are healthy; this is not a marker-format regression. The canonical evidence and feasibility matrix are in `docs/rustplus_payload_audit_2026-09-10.md`.
- Cargo, Patrol Helicopter, Chinook, marker-derived Oil Rig activity, Deep Sea, Hidden Vendors, and market/vendor observation therefore cannot receive new live state from the current public Rust+ API. Existing historical handlers are retained in case Facepunch restores the signal or a compatible server-authoritative bridge is added.
- Runtime decision (2026-09-24): `cargo`, `chinook`, `deepsea`, `events`, `heli`, `hv`, `hvw`, `hvt`, `large`, `market`, `small`, and `vendor` are intercepted by the fail-closed `map-marker-capabilities` plugin and omitted from `!help`/`!commands`; a legacy invocation reports the Rust+ map API as unavailable instead of returning stale state. The same capability registry excludes slash command `/market`, every obsolete map-event notification card, the vending-item notification option, and Cargo/Oil Rig custom timers from Discord. A versioned one-time Discord UI refresh removes already-published obsolete controls after deployment, while stale interactions are rejected without mutating settings. `map`, `marker/markers`, population, time, wipe, team state, smart devices, BattleMetrics, and raid FCM remain active because they do not depend exclusively on the removed markers.
- Team/death/connection data and paired-device/FCM alerts use other Rust+ responses and remain available. Do not implement retries or enum-format workarounds for the missing markers.
- Restoring these event signals on a modded server requires a separately validated server-side Oxide/Carbon/uMod bridge; do not assume or install one without server-admin scope and a documented payload contract.
- The user is not the Rust server administrator, so server plugins, RCON and private server integrations are not actionable proposals. Client-only priorities from the surviving Rust+ data are: explicitly labelled teammate-reported events/shared crate timers, sleeper/recovery locations, population trends and threshold watches, compact tactical team status, own-team death concentration, teammate zones, and Rust+ capability health. Never promote a report, heuristic, expiry or expected schedule to an authoritative detected event.

## Generic language detection, teammate language DB, and autotranslate
- `src/util/languageDetector.js` detects major scripts directly and lazily loads the local, zero-API `eld` 2.1.0 extra-small model for short English/French/Chinese chat. English/French Rust-gaming and translation-control vocabulary handles terse phrases such as `test de traduction`. When lexical rules do not decide, the detector accepts ELD's most likely supported language even below its reliability threshold; if ELD has no candidate but the message contains Latin letters only, it defaults to `en`. Messages without letters remain unknown. Player-language and active-pair checks still prevent unrelated translations.
- `src/plugins/teammateLanguageDatabase/index.js` is the shared teammate/tracker identity history. Its canonical per-guild/server CSV schema is `steamid,battlemetrics_id,date,name,language`; legacy `steamid,date,name,language` files remain readable and migrate on the next write. The player tracker appends only identities with a proven SteamID64, preserving BattleMetrics ID and name changes; tracker-only rows may leave `language` empty. Multiple two-letter player languages share the final column with a semicolon separator such as `fr;en`; `XX` means an unknown teammate language. Existing declared languages remain the source of truth and are never erased by tracker observations.
- The teammate language DB records observations from Rust+ polling team info, team-change broadcasts, and team-chat messages.
- Manual commands: `!record [steamid] [pseudonym with spaces/special characters allowed]` only adds a nickname row; `!who [steamid]` lists known pseudonyms with dates and the current language list. Player languages are edited directly in the CSV, not through an in-game command.
- `!autotranslate on [language[,language...]]` / `!autotranslate off` works in-game and in Discord command channels. `!autotranslate on` defaults to English. `en,zh` supports English to Chinese and Chinese to English; `fr,zh` supports French to Chinese and Chinese to French.
- To avoid spam, autotranslate only runs when the detected message language belongs to the player's declared language list and to the active translation pair. It then translates to the other language in that pair. A language outside the active pair is ignored even when it belongs to the player.
- The first reliably detected non-`XX` team-chat language still initializes an unknown player. Correct or expand the declared list by editing the most recently dated CSV row for that SteamID, using values such as `fr;en`; only that latest row is authoritative. Later automatic observations never overwrite or append to the list. Diagnose with `!who <steamid>` or the server CSV at `data/teammate-language-database/<guildId>-<sanitizedServerId>.csv`.
- Autotranslate queues the translated Rust team-chat message before the optional Discord relay. Translation-engine and Discord failures are logged and do not cancel an already queued in-game translation.
- `npm run test:autotranslate:live` is the explicit network integration check: it exercises the real local detector, Google translation, forced real DeepLX/Bing/MyMemory fallbacks, multilingual eligibility, team-chat handler, Rust in-game queue, and final `sendTeamMessageAsync` boundary while capturing Discord/Rust outputs instead of publishing them. The test includes plugin decision/error logs in assertion failures.
- The former `translate` 1.4.1 / Google `client=gtx` path began returning persistent HTTP 429 responses (first through Node 18 Undici, then through Axios), causing the plugin boundary to return no translation. AutoTranslate now uses a sequential four-provider chain isolated under `src/plugins/autoTranslate`: `@vitalets/google-translate-api` 9.2.1 (`google-web`), DeepLX REST (`deeplx`), a cancellable local Bing Web adapter (`bing-web`), then MyMemory REST. Each provider is attempted exactly once with an orchestrator-enforced two-second deadline and the whole sequential chain is capped at five seconds; malformed, unchanged, and target-script-mismatched responses also advance the chain, and total failure is structured and aggregated without retrying a provider.
- `RPP_LIBRETRANSLATE_URL` replaces the public DeepLX step with a self-hosted LibreTranslate endpoint; `RPP_LIBRETRANSLATE_API_KEY` is optional. No public LibreTranslate instance is enabled by default: the public endpoints checked on 2026-09-09 were unavailable within five seconds. Lingva was rejected because a live FR→ZH request returned English while claiming success. MyMemory remains last because it also returned an English pivot for one FR→ZH probe; the target-script validator now rejects that false success.
- Successful translation decision logs include the provider. Every failed provider is logged as `PROVIDER_FAILED` with a sanitized reason, including total-chain failures, without message content. Deterministic unit coverage verifies order, a single attempt, timeout cancellation, schema validation, Chinese code mappings, immutable results/errors, and all fallbacks under Node 18.
- For this project, the user considers all supplied Rust team-chat text safe to send to the configured external translation providers during normal operation and diagnostics.
- While autotranslate is enabled, its production decision path logs `AUTOTRANSLATE: TRANSLATED` or `AUTOTRANSLATE: SKIPPED` with SteamID, detected source, declared languages, active targets, chosen target, and a machine-readable reason. It does not log message contents.
- The 2026-09-08 benchmark measured about 356k messages/second (2.8 microseconds/message) after loading the model, versus about 1.54M for the former incomplete word list. The lazy ELD import added about 45 MiB RSS in isolation but does not affect startup or script/lexicon-only messages; translation network latency remains dominant.

## Deep Sea event support
- Deep Sea is not Underwater Labs. It is the Naval Update offshore timed world event reached beyond map-edge buoys, with Floating City, Ghost Ships, islands, patrol boats, no respawning loot, and a timer/radiation pressure before closure.
- Deep Sea support is intentionally isolated as much as possible in `src/handlers/deepSeaHandler.js` to ease future upstream updates. The base hook is a minimal polling install/handler call.
- `!deepsea` gives status/prediction text for the Deep Sea event. It should avoid showing North/South/East/West direction to users until coordinate behavior is fully trusted, though side-calculation/debug data remains useful internally.
- Deep Sea detection is based on off-map vending-machine clusters, especially `Casino Bar Shopkeeper`, not `GenericRadius` markers or Underwater Labs metadata.
- Live Rust+ payloads showed Deep Sea vendors can use `type: "VendingMachine"` string enum names as well as numeric vending-machine type ids, so marker handling must tolerate both.
- GenericRadius-based Deep Sea heuristics were superseded and should stay disabled; `deepSeaHandler.js` owns Deep Sea state and notifications.
- Off-map Deep Sea vendor clusters should not trigger generic `new vending machine` notification spam. Deep Sea uses its own open/close state-change notification.
- Deep Sea open/close notifications should not be suppressed as first-poll events, so a restart while Deep Sea is active can still post a detected Deep Sea event.
- Vanilla/default timing assumptions used for prediction: active duration is about 3 hours (`deepsea.wipeduration = 10800`), cooldown window is about 1.5-2.5 hours (`deepsea.wipecooldownmin = 5400`, `deepsea.wipecooldownmax = 9000`). Facepunch notes indicate the side is random after each opening and Deep Sea no longer opens immediately after wipe.
- Coordinate lessons are contradictory across observations. Keep this as debug-only unless revalidated:
  - Early payloads around negative `x` were first interpreted as west, then user examples suggested single-axis offshore coordinates may encode distance rather than side.
  - A later user-confirmed South payload indicated Rust+ Deep Sea marker coordinates may use `X` as vertical and `Y` as horizontal: negative `x` => South, positive off-map `x` => North, negative `y` => West, positive off-map `y` => East.
  - Because of these contradictions, user-facing messages should not expose direction yet.
- Deep Sea debug logs/workflows:
  - `logs/rustplus-markers.json` stores the latest marker snapshot with markers, vending-machine vendors, monuments, guild/server/timestamp metadata.
  - `logs/rustplus-markers-history.log` keeps marker history across polls.
  - `logs/rustplusplus-events.log` logs decoded Rust+ `message` events and polled `getMapMarkers` payloads.
  - `logs/rustplusplus-raw-socket.txt` logs best-effort UTF-8 raw inbound/outbound WebSocket frames with simple timestamp/direction separators.
  - `docs/deepsea_debugging.md` documents grep/jq workflows for raw WebSocket text, decoded events, marker history, snapshot diffing, and refining `deepSeaHandler.js`.


## Hidden vendor tracking
- Hidden vendor tracking records every Rust+ vending-machine marker seen during polling into `data/hidden-vendors/<guildId>-<serverId>-<mapSignature>.json`. The map signature includes seed/map size/wipe time, so the active database resets naturally on server or map changes while old files remain for inspection.
- `!hv` works in Rust team chat and the Discord commands channel. It reports former vendors grouped by grid from largest cluster to smallest, using vendors that were previously seen in the current server/map database but are absent from the latest broadcasting marker set.
- `!hvw` uses the same database but only reports short-lived former vendors (`seenPolls <= 2`), a heuristic for water-stash vendors that broadcast briefly after placement and then disappear.
- `!hvt` reports hidden vendors grouped by grid and seen-poll count, sorted from the least observed broadcast time upward; this helps find likely water-stash vendors even when a player forgot to disable broadcast for longer than the strict `!hvw` cutoff.
- Rust+ does not expose vendors that never broadcasted; the tracker can only preserve the last observed location for vendors that appeared in marker polling at least once. The command output intentionally does not include sell orders.
- This intentionally avoids relying on generated bot map imagery for water detection. For underwater stash hunting, the useful signal is a vendor that briefly broadcasts and then disappears from the current marker set.

## Events command behavior
- `!events` should be a concise current per-event summary, not a timestamped notification history and not vendor movement spam.
- Each summary line should use relative durations from now, include active/last-seen/next-expected information when known, and say event info is unknown when no data exists.
- Deep Sea should appear as a major event entry. Vendor movement should not appear in `!events` history/all-events integration.
- Event summaries can append vanilla approximate next windows for Cargo, Patrol Helicopter, Chinook, Small Oil Rig, and Large Oil Rig when only last-seen timestamps are known.
- Modded servers may have multiple oil rigs. Small/Large Oil Rig summaries should split per oil-rig monument grid, e.g. `Large Oil Rig (A1)` and `Large Oil Rig (Z20)`, with per-grid last-trigger/unlock estimates when observed.
- Event aliases should remain compatible with RustPlusBot-style naming where previously added, including `ch47`, `oil_rig_small`, and `large_oil_rig`.

## Upstream and plugin architecture
- The canonical bot upstream is configured as Git remote `upstream` at `https://github.com/alexemanuelol/rustplusplus.git`.
- Optional fork features integrate only through `src/plugins/pluginManager.js`; core handlers must not import individual feature plugins.
- Startup is intentionally split into two independent lanes. Saved `instances/*.json` are loaded and their active Rust+
  connections plus saved FCM listeners start before the Discord gateway login; Discord guild/channel/BattleMetrics
  setup continues from the `ready` event and synchronizes any already-operational Rust+ instance afterward. Discord
  unavailability must never delay in-game commands, polling, or the package-derived
  `[BOT] RUSTPLUS v<package-version> OPERATIONAL.` announcement.
- `createRustplusInstancesFromConfig()` is idempotent. The Discord `ready` path may call it to pick up missing guilds,
  but it must not replace or duplicate a Rust+ connection started by the local bootstrap.
- Discord projection waits for both the gateway and that guild's channel setup. This prevents a Rust+ connection racing
  the asynchronous `ready` handler and publishing into channels before setup has completed.
- Generated map-image rendering belongs to the Discord projection and runs after Rust+ becomes operational; it must not
  delay the first poll, in-game command handling, or the in-game operational announcement.
- Saved host/lite FCM credentials start before Discord login as well, after Rust+ instances have been created. This keeps
  the critical raid-alarm route available during a slow Discord login. The later guild setup reuses those listeners.
- FCM startup must await the receiver's asynchronous initial check-in. A failed check-in destroys/removes the dead
  receiver so Discord-ready setup can make one meaningful retry; otherwise an object can exist while receiving nothing.
  Lifecycle logs expose `connected`, `disconnected; receiver reconnect scheduled`, and `initial connection failed`.
- Deep Sea state/detection and custom fork commands live behind the plugin boundary. The base `MapMarkers` and `RustPlus` structures must not carry duplicate Deep Sea implementations or runtime method monkey-patches.
- The Rust+ dependency remains pinned to `alexemanuelol/rustplus.js#089cfd3` because it is version 2.5.0 plus
  Proto3/current-server compatibility fixes absent from Liam's current master. Any replacement must pass the protocol
  compatibility fixtures first. The upstream/schema comparison and safe update path are recorded in
  `docs/rustplus_js_audit_2026-09-23.md`.
- `npm test` runs deterministic Node tests before the TypeScript no-emit check. `npm run benchmark:plugins` measures dispatch overhead.
- TypeScript uses the paired `module: Node16` and `moduleResolution: Node16` settings. The package has no ESM `type`, so Node16 preserves its CommonJS runtime while avoiding the deprecated `node`/`node10` resolver.
- The repository enforces UTF-8/LF through `.gitattributes` and `.editorconfig` for Linux compatibility. Keep `update.sh` tracked as executable (`100755`).
- A `Crate = 6` marker is not treated as a vanilla airdrop without a captured Rust+ fixture proving that mapping.
- Event notification buttons expose their state in their label: green/`ENABLED` means active and red/`DISABLED` means inactive. Discord, in-game, and voice outputs remain independent; in-game event notifications stay disabled by default.
- Event delivery queues enabled in-game output before Discord/voice and isolates failures per output; an optional delivery failure must not cancel the other enabled outputs.

## Discord setup and permissions
- Restarting the bot must not reset existing Rust++ Discord category/channel permission overwrites and make private channels public again.
- Startup setup should preserve current overwrites for existing category/channels. Permissions are applied automatically only when creating missing category/channels or during first-time setup.
- Explicit `/role` and `/reset` commands may still intentionally recalculate permissions.

## Battlemetrics behavior
- Discord spam from repeated `Battlemetrics Server Name Changed` notifications was suppressed by disabling that notification and defaulting `battlemetricsServerNameChanges` to `false`.
- Battlemetrics server names are still updated/recovered internally; only the Discord notification/alarm for `server_name` changes is suppressed.
- Global BattleMetrics login/logout Discord notifications for every server player were retired on 2026-09-24. The 60-second polling interval remains unchanged for accurate state, but presence alerts are emitted only for players explicitly managed by a tracker such as `!track`; legacy enabled global settings are ignored and their stale buttons can only disable the old flags.
- `src/plugins/playerTracker/index.js` adds `!track <partial name|SteamID64>`, complete compact multi-message `!tracklist`/`!tracks`, detailed `!tracklist all`/`!tracks all`, and `!untrack <partial name|BattleMetrics player ID|SteamID64>` behind `pluginManager.js`. Compact lists have no page header and use `name: Online` or `name: <age> ago`; `all` packs multiple complete positional `name,BattleMetricsID,SteamID,status` records per message, using `-` for an unknown SteamID and `on`/`off:<age>`/`unk:<age>` for status. It creates one native `Enemies` tracker per active server, so the existing 60-second BattleMetrics handler remains the only poller and continues to own Discord plus in-game login/logout delivery.
- Player resolution is restricted to the active BattleMetrics server. A direct BattleMetrics ID wins; for a name query, currently-online matches are considered before historical offline profiles, then exact/prefix/partial quality is applied. This fixes stale exact `Kirkstein` profiles hiding the live partial `Jeffrey Kirkstein The 3rd` observation. Partial names are checked against one server-filtered BattleMetrics search with a five-second timeout so historical/offline homonyms are not silently ignored when no live match exists. Truncated/paginated or otherwise equally ranked ambiguous results never select the first entry. They return up to five numbered candidates; for five minutes the same requester on the same server may select one with `!track #<number>` or `!track <same query> <number>`. Pending selections are memory-only, requester-scoped, and never mutate tracking state until a valid selection is confirmed. API failure is never interpreted as offline.
- `src/util/playerNameReconciler.js` is the shared provider-neutral `name/fragments -> target` boundary. Tracking and
  tracked-player commands use `precise` mode and preserve the preceding ambiguity rules. Read-only player-intelligence
  commands use `first` mode to return the closest exact/canonical/prefix/contained alias without a selector; this
  ranking is presentation only and never creates, links or merges an identity.
- BattleMetrics player ID is the authoritative tracking identity. SteamID64 is optional enrichment parsed from validated `identifier` data. For explicit `!track <SteamID64>`, the plugin resolves the free public Steam Community persona name with a five-second timeout, requires a strict current-server BattleMetrics name match (allowing only a leading `[CLAN]` tag), and rejects any BattleMetrics Steam identifier mismatch. Ambiguous, private, unavailable, or merely loose name matches do not mutate state. Plugin-managed native player IDs are locked against the legacy Steam-name remapping pass.
- `!track` is idempotent across a proven BattleMetrics ID/SteamID64 pair. A player first tracked as `BM:<id> | Steam:unavailable` is atomically enriched, not duplicated, when a later `!track <SteamID64>` strictly resolves to the same current-server BattleMetrics profile. The response is `Tracking updated`; aliases, timestamps, presence, and Premium summaries remain attached to the one record. The exact `Tingtong` / `BM:63764632` / `76561197975836271` sequence has a deterministic regression test.
- The native tracker remains persisted in `instances/<guildId>.json`; its readable redacted projection is atomically written to `data/player-trackers/<guildId>-<battlemetricsServerId>.json` with names/aliases, BattleMetrics ID/profile URL, nullable SteamID64, online/offline/unknown status, and last-seen timestamps. The projection contains no server player token or Discord credential. A corrupt projection is preserved and blocks mutation instead of being silently replaced.
- Private profiles, BattleMetrics streamer mode/hidden player lists, token permissions, and API rate limits can prevent resolution or status updates. Status becomes `unknown` while observations are unreliable, preserving the last known state and timestamp separately.
- Native tracker delivery now queues the authoritative Rust in-game alert before the optional Discord activity alert and isolates both failures. Projection sync also runs before optional Discord refreshes, so a Discord outage cannot cancel last-seen persistence or stop later guilds from being processed.
- Plugin-managed tracker presence notifications use `Tracked player <name> is now online.` and `Tracked player <name> just disconnected.` regardless of guild locale. Each detected event is also written at `TRACKER`/`info` before optional Rust/Discord delivery.
- A live unauthenticated `/players` request on 2026-09-09 returned HTTP 403 `A subscription is required to use the API`; historical/offline name search is therefore optional. Without that permission, a unique currently-online partial match is accepted from the authoritative current server view, while a cached offline partial asks for the displayed exact name. Exact locally observed names remain usable.
- `docs/external_player_data_sources_2026-09-10.md` records the live external-data audit. WarBandits EU 5X NoBPs exposes A2S on UDP query port `28015`: `A2S_INFO`/`A2S_RULES` provide useful server/build/map/performance metadata, but `A2S_PLAYER` returns censored generic identities and must not feed player tracking. The anonymous WarBandits `/stats/<server>` endpoint exposes server/wipe-specific SteamID64, current name, rank, playtime plus PvP/raid/farm/PvE statistics, so it is a strong identity/candidate source but not proof of current online status. Its use must be serialized/cached and stop on 429 or Cloudflare challenge. Steam presence is enrichment only; RCON would be authoritative but requires server-owner credentials.
- The 2026-09-28 replacement audit keeps BattleMetrics as the primary tracker source: RustRadar's server catalogue works for the target WarBandits server, but its player API returned `503 player_data_source_unavailable`, its public client exposes BattleMetrics-shaped `bm_id`/`server_bm_id` identities, and its terms forbid automated extraction without written permission. Do not integrate its undocumented SPA routes. Reconsider only with a documented, permitted API and a successful 30-day shadow comparison. Canonical report: `docs/rustradar_battlemetrics_audit_2026-09-28.md`.
- `src/plugins/warBandits/index.js` is the detached WarBandits provider. WarBandits is queried only during `!track`, never periodically. It caches the full validated server catalogue for one hour, matches exact BattleMetrics ID then hostname, resolves a server-specific name or SteamID64, and persists identity/stat/activity observations in `data/warbandits/`. Requests have a five-second timeout, a five-second serialized gap, five-minute response cache, and persisted 429/Cloudflare cooldown without retry. WarBandits failure cannot cancel a native tracker commit.
- Superseding source decision (2026-09-10): the user purchased BattleMetrics Premium, so subscribed BattleMetrics is the primary presence source for this deployment. The previous no-paid plan remains relevant only as failure analysis: no free drop-in replacement exists for arbitrary SteamID64 presence on the censored WarBandits list. Premium failures still produce `unknown`, never a disconnect, and never cancel committed tracker data.
- `RPP_BATTLEMETRICS_TOKEN` is loaded from the ignored repository-root `.env` through `dotenv` before config values are read. The committed `.env.example` contains only an empty placeholder. The tracker performs no RCON, ban, note, flag, trigger, account, favorite, or mutation API calls; do not grant those token permissions. Leave all token permissions unchecked when the UI permits it. `Account > Basic Account Information` is only the narrowest fallback if the UI requires a selected permission, not a tracker dependency, and must be validated with the live check.
- `src/plugins/battlemetrics/index.js` is the detached read-only Premium provider. It validates the fixed BattleMetrics origin and JSON:API boundaries, uses five-second timeouts, bounded responses and results, five-/ten-minute caches, in-flight coalescing, and a `Retry-After`/rate-reset cooldown on HTTP 429 with no retry. Sanitized 401/403/404/429/timeout/schema failures never include tokens or response bodies. Live validation on 2026-09-10 confirmed server-player and session endpoints; co-play returned HTTP 400 when given session-style server/include parameters, so it is now called parameterless and server-filtered only when the response exposes that relationship.
- Premium commands are `!trackinfo <tracked player>`, `!trackhistory <tracked player>`, and `!trackrelated <tracked player>`. They persist bounded server summary, current-server sessions, and co-play results under the schema-2 readable projection but never mutate tracker presence or emit transitions. Co-play is not labelled as team membership or identity proof. Schema-1 projections migrate on the next normal write.
- Rust censored A2S names are deterministic but non-unique according to a reverse-engineered game-code implementation: `(steamId % 2147483647) % 5163` selects from the bundled unique-name list. A SteamID normally keeps the same alias across queries/servers until Facepunch changes the list/algorithm, but different SteamIDs collide. BattleMetrics without RCON receives the same alias and can only build/merge an unverified name-based profile. This may support an explicitly low-confidence A2S observation, never an authoritative online/disconnect notification.
- User-supplied real-name/SteamID64 relations and exact WarBandits identity results are sufficient to compute censored aliases locally, removing BattleMetrics from identity resolution. A future detached presence provider may correlate fresh A2S alias sessions/durations, a cached inverse alias-to-known-SteamIDs index, target-specific WarBandits stat deltas, and optional Steam `playing Rust` state. A unique known alias is still only probable presence because an uncached account may collide; a target WarBandits delta confirms interval activity, not current presence.

## Raid alarms and FCM transport
- FCM is transport, not the producer contract. Route every authenticated notification with normalized `channelId=alarm` and an active-server IP/port match; do not require a title, `body.type`, vanilla Smart Alarm entity or known server mod. Host and Lite listeners share `src/util/fcmAlarmRouter.js`; malformed bodies fail gracefully and duplicate multi-account deliveries are suppressed for five seconds.
- Recognized raid-title alerts use the exact critical Rust-chat format `:exclamation: :poggers: GETTING RAIDED: {item} destroyed at {location}  :oldmanlaugh: :exclamation:` while preserving the parsed item/location placeholders. Discord keeps its localized structured alert projection.
- In-game raid delivery honors `smartAlarmNotifyInGame` and explicit mute, but bypasses delayed batching and stale `team.allOffline`; Rust acknowledgement precedes `raid-alarm.in-game: delivered`. Discord failure cannot cancel it. `!raidtest` uses the same outbound boundary.
- `src/util/reliableFcmReceiver.js` keeps Liam's credential check-in/parser but owns MCS readiness, stream position, heartbeats, data acknowledgements, inactivity/socket recovery, ports 5228/443 and capped reconnect. Authentication errors fail fast; no blind retry.
- `/credentials add` atomically renews the same SteamID64 for the same Discord owner, restarts the correct Host/Lite listener, treats issue/expiry dates as optional legacy metadata and never logs GCM secrets. Acquire credentials via current `rustplus.js fcm-register`, then re-pair in Rust.
- Recognized `You're getting raided!` and `<entity> destroyed at <grid>` forms are localized; unknown text is preserved. WarBandits' actual producer/payload remains unverified, so never infer haggbart solely from the visible phone title. haggbart Raid Alarm `0.4.2` is the only verified external mod integration and can send Rust+ alerts without a vanilla alarm.
- Historical July evidence: 107 old-handler alarms, 74 matching team-chat sends, then 33 received alarms with no chat output. This proved old post-receipt suppression; current critical routing removes its mute/offline/strict-format failure modes. September production receipt is still unproven until post-deployment capture.

## Runtime diagnostics and remaining invariants
- Steam avatars use Facepunch `/api/avatar/<SteamID64>`; persona-name fallback uses bounded Steam XML with five-second timeout and one-hour positive/negative cache. External failures are rate-limited warnings. All runtime Winston levels use `warn`, never invalid `warning`.
- A recurring `not_found` every 30 polls is a stale Smart Switch/Alarm/Storage Monitor reachability probe, not a stopped polling loop. Log device identity only when it transitions unreachable, keep silent recovery probes, and remove permanently stale devices from bot configuration.
- External-mod inventory is canonical in `docs/external_mod_compatibility.md`. Deep Sea/Smart Alarm are vanilla; Hidden Vendors, AutoTranslate and Teammate Language Database are bot-local. Preserve raw FCM/plugin item names because payloads lack stable item IDs.

## Other runtime invariants
- Bot-originated Rust team-chat broadcasts should be identified by queued-message matches or the `[BOT]` brand on messages from the paired Rust+ SteamID, not by SteamID alone, and must not be recorded as player-language observations or relayed back through Discord/team-chat autotranslate or command handling. Autotranslate should also ignore bot-branded messages so command replies such as `!hv` are not translated back into team chat while still allowing the paired Rust+ SteamID to issue commands.
- Hidden vendor tracking should exclude Deep Sea event vending-machine markers. Deep Sea vendors are NPC/event vendors, not player vending machines, and should not appear as temporary/water-suspect hidden vendors.
- On successful Rust+ connection startup, the bot should announce `rustplusOperational` into Rust team chat after the first poll completes and `isOperational` becomes true.
- Teammate death notifications should preserve a grid location whenever possible, falling back from the previous cached player position to the updated team payload position before using `spawn`.
- Hidden vendor commands (`!hv`, `!hvw`, `!hvt`) should prune/filter Deep Sea NPC vending-machine data from both newly detected vendors and existing hidden-vendor storage. Known Deep Sea vendor names observed in `docs/rust_event_rpp_bot.json` include Attire shop, Bandit Weapons Shop, Main Food Shop, Farming shop, Weapons Shop, Boat Vendor, Fish Exchange, Fishing shop, Medical shop, and Casino Bar Shopkeeper; only treat these as Deep Sea exclusions when off-map.
