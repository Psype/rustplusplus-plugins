# External Server Mod Compatibility

Last verified: **2026-09-10 (Europe/Paris)**.

## Scope

This inventory covers Rust server mods whose payloads or APIs are explicitly consumed by rustplusplus. It does not
list npm dependencies, external web services, or unrelated mods that may be installed on a game server.

## Current Rust+ API limitation

Facepunch's [Power Trip update](https://rust.facepunch.com/news/power-trip) of 2026-08-06 explicitly stopped sending
vending-machine and event map markers (cargo, helicopters, and travelling vendor) to Rust+. A 2026-09-08 live capture
confirmed healthy polling and decoding but returned only `Player` markers in all 14 `getMapMarkers` snapshots.

Consequently, the standalone bot cannot currently observe Cargo Ship, Patrol Helicopter, Chinook, marker-derived Oil
Rig activity, vending machines, Hidden Vendors, or Deep Sea through the public Rust+ stream. Existing handlers are
kept for protocol history and a possible future restoration of the signal. Raid Alarm FCM notifications and
team/death/connection information use separate payloads and are unaffected. Restoring world-event detection on a
modded server requires a separately validated server-authoritative plugin bridge; it is not a marker-format fix.

## Supported external mods

| Name | Official source | Latest known version | Compatibility |
| --- | --- | --- | --- |
| Raid Alarm by haggbart | [uMod](https://umod.org/plugins/raid-alarm), [source](https://github.com/haggbart/rustplugin-raidalarm/blob/master/RaidAlarm.cs), [updates](https://umod.org/plugins/raid-alarm/updates) | **0.4.2** | Bot payload contract supported by `src/plugins/raidAlarm`; current Rust/Oxide runtime requires the live verification procedure below. No vanilla Smart Alarm entity is required. |

### Raid Alarm 0.4.2

Version 0.4.2 is the current uMod release and is identified as the November 2025 Rust compatibility patch. Its source
uses `NotificationChannel.SmartAlarm` with `Util.TryGetServerPairingData()`. The bot now relays every authenticated FCM
notification on that channel for the exactly matching active Rust+ server, rather than requiring a particular title,
body, `type`, or vanilla entity registration. This also covers server-specific integrations such as WarBandits whose
complete payload contract is not published. Canonical raid titles and `<entity> destroyed at <grid>` bodies are still
localized when recognized.

The shared **Smart Alarm and uMod Raid Alarm alerts In-Game** setting controls team-chat delivery. Host and secondary
FCM credentials use the same route; identical multi-account deliveries are suppressed for five seconds. The raid alert
bypasses the ordinary delayed chat queue and the potentially stale all-team-offline projection, then waits for the Rust+
server response before logging `raid-alarm.in-game: delivered`. Discord is attempted afterward and cannot cancel the
in-game transaction. The explicit global in-game mute still applies.

`!raidtest` sends `[RAID TEST] ...` through this same critical acknowledged Rust team-chat boundary. It is the first
deployment check: use it in Rust team chat or the Discord commands channel. Incoming FCM logs include `alarm received`
with the source SteamID, server endpoint, type, title, and message; malformed bodies are rejected without crashing the
listener.

The published source contract and the bot adapter are verified by deterministic tests. Runtime compilation of the C#
plugin against the September 2026 Rust/Oxide assemblies is not verified in this repository because those assemblies
and a live server are outside the bot workspace. No release newer than 0.4.2 is listed by uMod.

WarBandits displays raid notifications in Rust+, but its underlying server plugin and full payload contract are not
identified. The channel-level relay no longer depends on identifying that plugin or its title. A captured production
`alarm received` line remains useful to verify its exact endpoint and fields, but is no longer required for routing.

Server verification procedure:

1. Install the official `RaidAlarm.cs` version 0.4.2 in `oxide/plugins/`.
2. Run `oxide.reload RaidAlarm` and confirm version 0.4.2 in the server plugin list.
3. Run `/raidalarm status`, then `/raidalarm test` while paired with that Rust server.
4. Confirm the alert in Rust+, the Discord activity channel, and Rust team chat when its output setting is enabled.

## Features that are not external server mods

| Feature | Classification | Version tracking |
| --- | --- | --- |
| Deep Sea | Vanilla Rust feature introduced by Facepunch in the [Naval Update](https://rust.facepunch.com/news/naval) on 2026-02-05. Detection historically observed Rust+ vending-machine markers, which Facepunch stopped sending on 2026-08-06. | Currently unavailable from the public Rust+ stream; there is no server-plugin version. |
| Hidden Vendors | Bot-local persistence and filtering of Rust+ vending-machine markers, which Facepunch stopped sending on 2026-08-06. | Existing history remains readable, but no new public Rust+ observations are currently available. |
| AutoTranslate | Bot-local team-chat processing. | Versioned with this repository and its npm lockfile. |
| Teammate Language Database | Bot-local CSV persistence. | Versioned with this repository. |
| Smart Alarm | Vanilla Rust+ entity support. | Follow Rust/Rust+ protocol compatibility; it is not a uMod plugin. |
| BattleMetrics | External API service used by trackers. | API compatibility is separate from server-mod compatibility. |

## Unsupported or undeclared mods

No other uMod, Oxide, Carbon, Codefling, or Lone Design plugin is imported, called by name, or assigned a payload
contract in the current bot source. A mod is therefore not considered compatible merely because it changes a marker
that Rust+ happens to expose. Add it to this inventory only after documenting a stable upstream source, payload/API
contract, version, fixture, and deterministic compatibility test.
