# `rustplus.js` dependency audit — 2026-09-23

## Result

The project does not consume Liam Cottle's current `master` directly. It pins
[`alexemanuelol/rustplus.js@089cfd3`](https://github.com/alexemanuelol/rustplus.js/commit/089cfd3db1b04709911948bce669273139c6a124),
an Alex Emanuelsson fork of version 2.5.0 which migrated the Rust+ schema from Proto2 to Proto3 after current servers
started omitting fields previously marked `required`.

There is no newer Liam runtime release to adopt wholesale. Liam's latest substantive release is still 2.5.0 and its
current `master` still declares Proto2 required fields. Replacing the pinned fork with it would reintroduce the known
`missing required 'queuedPlayers'` / `Note.type` decode failures reported in
[issue #81](https://github.com/liamcottle/rustplus.js/issues/81). The local
`test/protocolCompatibility.test.js` fixtures already verify the fork's tolerant decoding.

## Installed versus upstream

| Source | State checked | Relevant state |
| --- | --- | --- |
| This project | `package.json` / lockfile | Version 2.5.0 pinned to Alex commit `089cfd3`, 2025-06-06 |
| [Liam upstream](https://github.com/liamcottle/rustplus.js) | `master`, checked 2026-09-23 | No newer runtime than 2.5.0; schema still Proto2 |
| [Open PRs](https://github.com/liamcottle/rustplus.js/pulls) | checked 2026-09-23 | #77 Proto3 migration, #82 two optional fields, #70 safe `isConnected()`, #79 buffer-padding workaround |
| [RustPlusApi](https://github.com/HandyS11/RustPlusApi) | commit `e508cb0`, 2026-09-17 | Actively maintained independent Rust+ protocol implementation |

The pinned fork includes the substantive compatibility work from Liam PR
[#77](https://github.com/liamcottle/rustplus.js/pull/77). PR
[#82](https://github.com/liamcottle/rustplus.js/pull/82) makes only `queuedPlayers` and `Note.type` optional; Proto3 in
the pinned fork already tolerates both omissions. PR
[#79](https://github.com/liamcottle/rustplus.js/pull/79) pads suspiciously short buffers before decoding; the fork
tried and deliberately reverted that workaround, so it must not be restored without a captured malformed frame and a
deterministic regression test. PR [#70](https://github.com/liamcottle/rustplus.js/pull/70) is a small valid guard that
the pin does not contain: local `isConnected()` can dereference an absent WebSocket before connection.

## Protocol deltas still missing locally

Comparison with the maintained RustPlusApi schema shows that the pinned Proto3 schema is tolerant but not current.
Unknown optional fields are ignored safely, so most deltas disable newer data rather than breaking existing decoding.

| Area | Current protocol | Local pin | Impact |
| --- | --- | --- | --- |
| Entity and marker identifiers | `uint64` | `uint32` | Material truncation risk for IDs above 32 bits |
| Team map notes | icon, colour index, label | absent | Metadata unavailable |
| Clan | score and score-event role permission | absent | New clan data unavailable |
| Vending sell orders | price/received multipliers | absent | Adjusted quantities unavailable |
| Cameras | time, position, rotation, sample rotation | absent | New camera metadata unavailable |
| Server info | cameras-enabled flag | absent | Capability flag unavailable |
| Team management | kick request | absent | New operation unavailable |

The travelling-vendor marker value is also unnamed locally, but protobufjs preserves its numeric enum value and the
compatibility fixture covers unknown marker type `9`; this is not a decode failure.

## Relevance to the missing raid notifications

This dependency is not the inbound push-notification transport:

- `src/structures/RustPlus.js` uses `@liamcottle/rustplus.js` for the WebSocket connection to the game server, requests,
  team chat and `entityChanged` broadcasts from explicitly queried paired entities;
- `src/util/FcmListener.js` imports `@liamcottle/push-receiver` directly for Google FCM/MCS pairing and alarm pushes;
- a mod-generated raid notification visible on the phone but not backed by a paired vanilla Smart Alarm therefore
  reaches the bot only through the second path.

Working team chat, deaths and connections already show that the core WebSocket decoder is operating. Updating
`rustplus.js` cannot repair an FCM listener that receives no current alarm envelope. The separate transport diagnosis
is documented in [`fcm_transport_audit_2026-09-23.md`](fcm_transport_audit_2026-09-23.md).

## Safe update path

Do not switch back to Liam `master`. Keep the Proto3-compatible pin until a detached maintained fork can be validated
with deterministic fixtures. A surgical future update should:

1. preserve tolerant Proto3 decoding;
2. widen entity/marker IDs to `uint64` and add the current optional fields without changing existing bot behavior;
3. apply the `isConnected()` null guard;
4. add fixtures for IDs above `2^32`, omitted response fields and every newly consumed field;
5. keep FCM/MCS transport changes isolated from the Rust+ WebSocket client.

No dependency or runtime code was changed by this audit.
