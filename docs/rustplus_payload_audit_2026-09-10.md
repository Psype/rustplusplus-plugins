# Rust+ payload capability audit — 2026-09-10

## Scope and method

This audit covers the captures stored beside the repository:

- `rustplusplus-events.log` (42,457,680 bytes, decoded JSONL);
- `rustplus-markers-history.log` (26,888,852 bytes, marker JSONL);
- `rustplusplus-raw-socket.txt` (13,524,446 bytes, lossy UTF-8 rendering of protobuf frames);
- `rustplus-markers.json` (latest marker snapshot).

The large files were processed line by line. Timestamps, response sequence numbers and volatile values were excluded when grouping structural signatures. No network request was made. The timestamps below are local logging timestamps, not authoritative server timestamps.

Capture window: `2026-09-07T23:52:15.247Z` to `2026-09-08T13:54:08.739Z`, approximately 14 hours.

## Verified payload inventory

The decoded event log contains 25,552 valid JSONL records and no malformed line.

| Native payload | Count | Observed content |
| --- | ---: | --- |
| `response.info` | 5,031 | server identity, population, wipe/map metadata |
| `response.mapMarkers` | 5,030 | only team `Player` markers |
| `response.teamInfo` | 5,030 | team roster, position, online/alive and spawn/death fields |
| `response.time` | 5,030 | game time and day-cycle settings |
| `response.error` | 169 | exactly `not_found` |
| `response.success` | 88 | successful request acknowledgements |
| `response.map` | 1 | map and static monuments |
| `broadcast.teamMessage` | 142 | team chat |
| `broadcast.teamChanged` | 1 | team change |

There was no `entityChanged`, clan or camera broadcast and no unknown broadcast tag. The 169 `not_found` responses match 169 outgoing `getEntityInfo` requests. They recur about every five minutes but do not block the four main polling requests or team chat.

The raw capture contains 20,379 requests, 20,379 responses and 143 broadcasts. Its envelope counts corroborate the decoded log. It cannot be faithfully decoded again because binary protobuf frames were written with `buffer.toString('utf8')`, which irreversibly replaces invalid byte sequences. Decoded JSONL is authoritative for payload content.

## Map-marker result

Across 5,030 native `getMapMarkers` responses:

- 20,018 marker observations;
- 6 unique player SteamIDs;
- marker counts of 3 (861 polls), 4 (3,410 polls), or 5 (759 polls);
- one and only one marker category: `Player`;
- no `Explosion`, `VendingMachine`, `CH47`, `CargoShip`, `Crate`, `GenericRadius`, `PatrolHelicopter`, travelling vendor/type 9, or unknown type.

The marker logger copies `mapMarkers.markers` before the core marker handlers mutate state, so these categories were absent from the server response rather than filtered by the logger.

The JSON files display known protobuf enum values as names such as `"Player"`. This is protobufjs `toJSON` representation; decoded runtime values remain numeric. It does not indicate a handler format mismatch.

The 65 monument entries are static map metadata. Their `oil_rig_small` and `large_oil_rig` tokens locate monuments only; they contain no oil-rig state, locked-crate state or reset event.

Player markers are also not proof of current online state. A marker may remain motionless, and the same SteamID can return with a different marker ID. `teamInfo.isOnline` is the appropriate own-team signal; movement is only positive evidence of recent activity.

## Historical comparison

`docs/rust_event_rpp_bot.json`, captured on `2026-06-16` for the same guild and Rust server ID, contained 67 markers:

- 9 `Player`;
- 57 `VendingMachine`;
- 1 numeric type `9`, handled by this fork as `TravelingVendor`.

Ten off-map NPC shops, including `Casino Bar Shopkeeper`, provided the former Deep Sea signal. None occurs in the September capture.

This proves a loss of capability for this server/account between the two captures and rules out a simple new marker shape in the September data. These captures alone do not prove that every Rust server or every account is filtered identically.

## Event feasibility from the current Rust+ stream

| Capability | Result | Reason |
| --- | --- | --- |
| Team chat and team changes | Reliable | native broadcasts observed |
| Teammate connect/disconnect/death/respawn | Reliable at poll resolution | `teamInfo` is present about every 10 seconds; 123 member state transitions observed |
| Teammate position/activity | Limited but useful | position is available; no enemy data; stationary does not mean offline |
| Population, map, wipe and day/night | Reliable | `info`, `map` and `time` remain available |
| Cargo ship | Unavailable | no `CargoShip` marker and no alternate broadcast |
| Patrol helicopter | Unavailable | no marker; destruction was inferred from marker disappearance |
| CH47 / heavy scientists / oil-rig trigger | Unavailable | oil-rig logic depends on a CH47 marker near a static rig |
| Oil-rig locked-crate unlock/reset | Unavailable | current code starts a local timer only after the missing CH47 trigger |
| Dynamic vendors / market / hidden vendors | Unavailable | no vending markers |
| Deep Sea | Unavailable | its former off-map vending cluster is absent |
| Explosion / raid from map | Unavailable | no explosion marker; raid alerts need the separate server/FCM source |
| Vanilla airdrop | Unproven and unavailable | no captured marker; protocol `Crate` must not be assumed to mean airdrop |

Rust+ has no dedicated cargo, helicopter or oil-rig broadcast in the installed protocol. Those bot features are derived exclusively from successive `getMapMarkers` snapshots. Raw WebSocket inspection therefore exposes no hidden fallback channel when the server omits those markers.

## Useful client-only features, in priority order

Server plugins, RCON and private server APIs are intentionally excluded: the bot operator is not the Rust server administrator.

### 1. Team-reported world events

Short commands such as `!spot heli`, `!spot cargo`, `!spot ch47`, `!spot oil small` and `!clear heli` can restore a useful event ledger without inventing an API signal. The bot can attach the reporting teammate, local receive time and their current grid automatically, then expose the observation through `!events`.

Every entry must remain explicitly labelled `reported`, not `detected`. Expiry can make an observation stale, but must not claim that the event ended; an explicit clear or a newer report is stronger evidence. This feature uses only observed team messages and team position.

A related `!crate small` / `!crate large` command can start a shared unlock timer after a teammate actually starts the crate. The duration must be user-configurable because the server is modded.

### 2. Sleeper and recovery status

`teamInfo` can support a `!sleepers` or `!recover <name>` view containing offline-but-alive teammates, last observed grid and time since disconnection. This adds information that the existing `!offline` command does not show. Observations need a captured-at timestamp and must become `stale` after an API or bot outage rather than pretending to be current.

The existing death data can similarly expose the latest known death grid by teammate name instead of requiring a SteamID. It cannot identify the killer, cause, loot or whether the body still exists.

### 3. Population history and threshold alerts

The current `!pop` only returns the latest value. The 10-second `info.players` stream can cheaply produce:

- `!poptrend`: min/average/max and direction over 15 minutes or one hour;
- `!popwatch below 20` / `above 100`: state-change notification with hysteresis;
- a local time-of-week quiet-period estimate after enough complete observations.

Persist minute aggregates rather than every sample. Coverage gaps and wipe boundaries must be visible, and a trend must never be presented as a prediction of an in-game event.

### 4. Compact tactical team status

`!squad` can combine currently separate `!online`, `!offline`, `!alive`, `!afk` and position data into one bounded response: online/alive state, AFK duration, grid and nearest static monument. This is primarily an ergonomic aggregation, not new telemetry.

`!split` can cluster online/alive teammates by distance and report isolated members or the largest separated groups. Optional alerts must be transition-based with threshold and cooldown. Straight-line distance does not account for terrain, walls or safe routes.

### 5. Team death concentration map

Persist validated own-team death transitions by wipe, SteamID, grid and observation time. `!deathmap` can report grids with repeated team deaths and a Discord heatmap can visualize them. The correct label is death concentration, not danger or enemy activity: suicides, falls, radiation and combat are indistinguishable.

### 6. Team zones and arrival notifications

User-defined local zones such as base, raid flank or rendezvous can be evaluated against teammate positions. Entry/exit or `arrived` notifications are feasible with confirmation on consecutive polls and state-change delivery. They apply only to teammates and are limited by the approximately 10-second polling resolution.

### 7. Rust+ health and capability status

`!apistatus` can report last successful poll, reconnects, endpoint failures, observed marker categories and unavailable feature groups. It can also associate the periodic `getEntityInfo -> not_found` with its locally configured paired entity and suppress repeated log noise after one actionable warning.

Retain the historical event handlers behind capability gating so they can resume if marker types return. Commands must otherwise report `unavailable`/`unknown`, never synthesize active or ended events.

For future protocol diagnostics, decoded JSONL remains preferable. If raw frames are ever retained, use bounded/rotated base64 or hex and treat them as sensitive because Rust+ requests carry pairing credentials.

Do not infer world events from population changes, team movement, frame size, expected vanilla schedules or chat wording. Those are not authoritative and would create false positives, especially on a modded server.

## Conclusion

For this capture, the bot receives a healthy Rust+ connection and complete regular polling, but the server returns a team-only marker view. The missing cargo, helicopter, CH47, vendor, Deep Sea and oil-rig notifications have no automatic input signal to process. Retrying, changing enum formatting or parsing the raw socket cannot restore data that was not transmitted. Useful new work should therefore build on team reports, team state, positions, population, time and static map data while preserving their evidence level.
