# Rust `output_log.txt` identity collector study

Date: 2026-10-04  
Status: research note only; no collector or Discord importer implemented yet

## Objective

Assess whether the local Rust client log can be tailed by a background process to preserve player names and SteamID64 values, optionally correlate them with `combatlog` tokens such as `player_16539563`, then import the resulting file into the Discord bot later.

Observed source file:

```text
C:\Jeux\Steam\steamapps\common\Rust\output_log.txt
```

Proposed durable output file:

```text
C:\Jeux\Steam\steamapps\common\Rust\rustplus-player-identities-v1.jsonl
```

The generated file should contain normalized identity evidence only. It must not copy the complete Rust log, hardware details, IP addresses, stack traces, or other unrelated local information.

## Snapshot observed on 2026-10-04

At the final read:

- size: 238,671 bytes;
- lines: 3,723;
- last write: 2026-10-04 11:10:33 Europe/Paris;
- first log timestamp: `2026-10-03T23:35:09.562Z`;
- death lines: 16;
- `combatlog` outputs: 5;
- distinct SteamID64 values: four, including the local player and three human attackers;
- no observed `+XX events in the last 10 seconds`, `suppressed`, `dropped`, or equivalent collapse marker.

The file had not been truncated during that Rust process. It is nevertheless expected to be truncated or replaced at a later game launch, so the collector must treat rotation/truncation as normal.

Third-party SteamID64 values are masked in this document to avoid committing unnecessary personal identifiers. The raw evidence was present in the local log at the time of inspection.

## Confirmed human correlations

The death notification directly supplies an exact name and SteamID64. A later `combatlog` supplies a `player_...` network token and an event age. The event time is reconstructed as:

```text
combatlog header timestamp - age in seconds
```

Observed correlations:

| Exact observed name | Masked SteamID64 | Combat token | Timing delta |
| --- | --- | --- | ---: |
| `R2FAN/igorsigma#flamerust` | `7656119...165140` | `player_21043352` | 13 ms |
| `BelaRusツ` | `7656119...636160` | `player_11433592` | 5-14 ms |
| `37'` | `7656119...187677` | `player_16539563` | 31-62 ms |

Detailed example for `37'`:

```text
death timestamp:       2026-10-04T08:52:00.203Z
combatlog timestamp:   2026-10-04T08:54:30.862Z
combatlog age:         150.69 s
reconstructed event:   2026-10-04T08:52:00.172Z
delta:                 31 ms
token:                 player_16539563
```

The same historical event appeared in another `combatlog`:

```text
combatlog timestamp:   2026-10-04T09:03:47.081Z
combatlog age:         706.94 s
reconstructed event:   2026-10-04T08:52:00.141Z
delta:                 62 ms
token:                 player_16539563
```

This is one event replayed twice, not two observations. It proves that a historical combat row retains its recorded token while it remains in the recent combat history. It does not prove that the live player entity keeps that token indefinitely.

The file also contained at least one seven-digit token, `player_9572422`. Parsing must therefore preserve the opaque token and must not require exactly eight digits or add zero padding. A conservative syntax is:

```regex
^player_[0-9]{1,20}$
```

## Meaning and lifetime of `player_...`

The token must be treated as a network entity identifier, not as an account identifier:

- it is not a SteamID64;
- it is not known to be derived from a SteamID64;
- there is no documented fixed lifetime such as one wipe;
- it must not be assumed stable across entity deletion/recreation, reconnects, server restarts, wipes, or different servers;
- it may eventually be reused for another entity;
- a mapping must never be merged into durable player identity solely because a token matches.

Facepunch changes explicitly mention assigning a player's new network ID when the player is deleted and remapping network IDs in other runtime operations. This contradicts the hypothesis that the value is a durable per-account or cross-wipe identifier.

References:

- Rust Wiki, useful commands and `combatlog`: <https://wiki.facepunch.com/rust/useful_commands>
- Facepunch commit history mentioning a player's new network ID after deletion: <https://commits.facepunch.com/r/rust_reboot/main/hardcore_refresh>
- Facepunch commit about remapping network IDs and not saving entity IDs: <https://commits.facepunch.com/501955>
- Facepunch console optimization mentioning non-truncated `combatlog`: <https://commits.facepunch.com/r/rust_reboot/main/console_optims>

Recommended semantics:

- preserve a confirmed historical link between one exact death event, SteamID64, name, and token;
- scope each token by at least server and client/server session;
- do not use an old token mapping to attribute an unrelated future combat event;
- close the active token scope on server change, detected server restart/wipe, local Rust restart, or contradictory evidence;
- retain the event-specific historical evidence after closing the active scope.

## Information value

### Directly reliable

A line of this form is strong historical identity evidence:

```text
You died: killed by <exact name> (<SteamID64>)
```

It provides:

- exact displayed name, including case and Unicode;
- SteamID64;
- UTC observation timestamp;
- evidence of a past interaction.

It does not prove that the player is still online and must never create a `presence_observed` event or continuous presence interval.

### Useful only after correlation

A `combatlog` row can add:

- a `player_...` token;
- weapon/path and damage information;
- a reconstructed event timestamp.

The token is only useful as event-local diagnostic enrichment. It should not become a durable alternate account ID.

### Not useful or unsafe for identity

- environmental deaths, suicide, generic entity kills, or explosions without SteamID64;
- unmatched `player_...` tokens;
- name-only matches;
- inferred events hidden behind a collapse marker;
- raw hardware, network, crash, or stack-trace information from the full log.

## Collector design

A trayless Node.js process started at Windows logon through Task Scheduler is sufficient. A privileged Windows Service is unnecessary for the first version.

The collector should:

1. open the log with read sharing compatible with Rust;
2. tail it using a byte offset and a UTF-8 partial-line buffer;
3. use polling around every 250-500 ms, optionally assisted by a filesystem watcher;
4. detect `length < offset`, file replacement, or a new startup marker and begin a new client session;
5. parse only allowlisted records;
6. flush each normalized JSONL record promptly;
7. keep the output append-only across Rust launches;
8. deduplicate repeated lines and repeated `combatlog` presentations with stable hashes.

Do not automate F1/keyboard input to invoke `combatlog`. The direct death line already supplies name and SteamID64; manual `combatlog` calls merely add optional enrichment.

### Death parsing

The name portion must be greedy and Unicode-safe because real examples contain slashes, `#`, apostrophes, spaces, and non-ASCII characters. Anchor the SteamID64 at the end of the line rather than splitting on spaces.

Conceptual expression:

```regex
^You died: killed by (?<name>.+) \((?<steamId>7656119\d{10})\)$
```

Environmental/entity variants must be classified separately instead of forced into this identity form.

### Combatlog parsing

Do not naively split rows on whitespace: weapon/entity labels may contain spaces. Read the displayed header and use its column boundaries, with explicit validation of the age, target, info, and token fields.

For a human death correlation:

- reconstruct `eventTime = combatlogTimestamp - ageSeconds`;
- require a unique matching direct death in the same scoped session;
- require `target=you` and `info=killed` or their verified equivalents;
- initially accept at most a one-second timing delta;
- reject or mark ambiguous multiple candidates;
- refuse automatic correlation across an observed log gap.

The current sample's largest confirmed delta is 62 ms, so a one-second threshold is conservative without being overly precise.

## Collapsed and omitted event handling

The parser must recognize variants such as:

```text
+37 events in the last 10 seconds
+37 events in 10 seconds
```

It should also recognize nearby wording containing concepts such as `suppressed`, `dropped`, or `collapsed` when a count/window can be extracted.

Represent the omission explicitly:

```json
{"schemaVersion":1,"type":"log_gap","observedAt":"2026-10-04T09:00:00.000Z","omittedCount":37,"windowSeconds":10}
```

Rules:

- visible direct death evidence remains valid;
- do not synthesize any omitted events;
- do not claim completeness for the covered interval;
- block or downgrade a correlation whose relevant interval overlaps the gap;
- report gap counts in the Discord import preview.

## Proposed JSONL schema examples

Direct identity observation:

```json
{"schemaVersion":1,"type":"identity_observed","sourceEventId":"sha256:...","observedAt":"2026-10-04T08:52:00.203Z","exactName":"37'","steamId":"7656119...187677","caseFidelity":true,"clientSessionId":"2026-10-03T23:35:09.562Z"}
```

Later event-local combat link:

```json
{"schemaVersion":1,"type":"combat_identity_link","sourceEventId":"sha256:...","deathEventId":"sha256:...","observedAt":"2026-10-04T08:54:30.862Z","playerToken":"player_16539563","correlationMs":31,"scope":{"serverKey":"...","clientSessionId":"2026-10-03T23:35:09.562Z"}}
```

Appending the later link is preferred over rewriting an earlier line. This provides crash safety and makes repeated uploads idempotent.

## Discord import design

The current player-intelligence import flow does not yet define this JSONL source or a combat event contract. A future importer could use a dedicated command/import kind such as a private `clientlog` attachment import.

Required behavior:

- strict UTF-8 JSONL parsing with a schema version;
- limits on attachment size, line length, line count, and accepted keys;
- exact SteamID64 and ISO timestamp validation;
- idempotency using `sourceEventId`;
- a preview showing new identities, aliases, duplicates, conflicts, gaps, and token links;
- explicit Confirm/Reject controls;
- requester, guild, channel, and configured-server binding;
- same SteamID plus a new exact name becomes alias history;
- same name plus a different SteamID remains two identities;
- contradictory token mappings are conflicts and never auto-merge;
- imports create historical identity evidence only, never presence evidence.

Uploading the same append-only file repeatedly is acceptable because `sourceEventId` makes already imported observations harmless duplicates.

For the first implementation, importing only direct `identity_observed` records is sufficient and lower risk. `combat_identity_link` can remain diagnostic until the project has a clear event contract and user-facing need for it.

## Project constraints for future implementation

- Preserve all existing uncommitted release 1.22.25 changes, including the earlier 1.22.24 OCR fixes.
- Never delete persistent data under `data/player-intelligence`.
- F7 and local death/combat evidence never prove current presence.
- If this becomes a runtime feature, bump the current package version and update package metadata, memory/handoff documentation, and tests.
- Validate with the complete test suite, `tsc --noEmit` where applicable, and `git diff --check`.

## Suggested implementation phases

1. Build a read-only parser and fixtures for the observed line variants.
2. Add the append-only local collector with truncation/session detection.
3. Run it through several Rust launches, reconnects, deaths, repeated `combatlog` calls, and a real collapsed-event marker.
4. Finalize the JSONL schema from those observations.
5. Add a preview/confirm Discord importer for direct identities.
6. Consider token-link import only if it provides a concrete player-intelligence feature without creating false identity or presence claims.
