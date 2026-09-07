# External Server Mod Compatibility

Last verified: **2026-09-07 03:32:43 +02:00 (Europe/Paris)**.

## Scope

This inventory covers Rust server mods whose payloads or APIs are explicitly consumed by rustplusplus. It does not
list npm dependencies, external web services, or unrelated mods that may be installed on a game server.

## Supported external mods

| Name | Official source | Latest known version | Compatibility |
| --- | --- | --- | --- |
| Raid Alarm by haggbart | [uMod](https://umod.org/plugins/raid-alarm), [source](https://github.com/haggbart/rustplugin-raidalarm/blob/master/RaidAlarm.cs), [updates](https://umod.org/plugins/raid-alarm/updates) | **0.4.2** | Bot payload contract supported by `src/plugins/raidAlarm`; current Rust/Oxide runtime requires the live verification procedure below. No vanilla Smart Alarm entity is required. |

### Raid Alarm 0.4.2

Version 0.4.2 is the current uMod release and is identified as the November 2025 Rust compatibility patch. Its source
uses `NotificationChannel.SmartAlarm` with `Util.TryGetServerPairingData()`. The bot accepts the canonical
`You're getting raided!` title or an `<entity> destroyed at <grid>` body, validates the FCM server identity, and only
routes the alert to the matching currently connected Rust+ server.

The shared **Smart Alarm and uMod Raid Alarm alerts In-Game** setting controls team-chat delivery. Rust team chat is
queued before Discord, and a Discord delivery failure does not cancel it. The global in-game mute and Rust+'s
all-team-offline guard still apply.

The published source contract and the bot adapter are verified by deterministic tests. Runtime compilation of the C#
plugin against the September 2026 Rust/Oxide assemblies is not verified in this repository because those assemblies
and a live server are outside the bot workspace. No release newer than 0.4.2 is listed by uMod.

Server verification procedure:

1. Install the official `RaidAlarm.cs` version 0.4.2 in `oxide/plugins/`.
2. Run `oxide.reload RaidAlarm` and confirm version 0.4.2 in the server plugin list.
3. Run `/raidalarm status`, then `/raidalarm test` while paired with that Rust server.
4. Confirm the alert in Rust+, the Discord activity channel, and Rust team chat when its output setting is enabled.

## Features that are not external server mods

| Feature | Classification | Version tracking |
| --- | --- | --- |
| Deep Sea | Vanilla Rust feature introduced by Facepunch in the [Naval Update](https://rust.facepunch.com/news/naval) on 2026-02-05. The bot observes Rust+ map markers. | Follow Rust/Rust+ protocol compatibility; there is no server-plugin version. |
| Hidden Vendors | Bot-local persistence and filtering of Rust+ vending-machine markers. | Versioned with this repository. |
| AutoTranslate | Bot-local team-chat processing. | Versioned with this repository and its npm lockfile. |
| Teammate Language Database | Bot-local CSV persistence. | Versioned with this repository. |
| Smart Alarm | Vanilla Rust+ entity support. | Follow Rust/Rust+ protocol compatibility; it is not a uMod plugin. |
| BattleMetrics | External API service used by trackers. | API compatibility is separate from server-mod compatibility. |

## Unsupported or undeclared mods

No other uMod, Oxide, Carbon, Codefling, or Lone Design plugin is imported, called by name, or assigned a payload
contract in the current bot source. A mod is therefore not considered compatible merely because it changes a marker
that Rust+ happens to expose. Add it to this inventory only after documenting a stable upstream source, payload/API
contract, version, fixture, and deterministic compatibility test.
