# Rust+ FCM transport audit — 2026-09-23

## Finding

No evidence was found that Facepunch changed the Rust+ alarm application payload. A maintained Rust+ implementation at
commit [`e508cb0`](https://github.com/HandyS11/RustPlusApi/commit/e508cb0f10a287a546730a6e490786d32f67bdd3)
from 2026-09-17 still extracts `channelId` and `body` from FCM `appData`, dispatching alarms when
`channelId == "alarm"`.

The obsolete JavaScript FCM/MCS transport was the strongest failure candidate. This repository still uses
`@liamcottle/push-receiver` 0.0.4 for its credential check-in and wire parser, but now replaces its incomplete socket
client with the local `src/util/reliableFcmReceiver.js` adapter. The current Liam repository contains no newer
transport implementation.

The protocol defect and local correction are covered deterministically. This is not yet a live-production proof: the
supplied journal ends in July and contains no current raw FCM envelope after deployment.

## Message attribution correction

The exact title `You're getting raided!` is registered as a default by
[haggbart Raid Alarm](https://github.com/haggbart/rustplugin-raidalarm/blob/master/RaidAlarm.cs), but that only proves
reuse, not origin. It may also be a historical vanilla Smart Alarm default. Facepunch's public documentation confirms
that Smart Alarm text is customizable but does not publish the factory title, so the title's origin remains
unverified. By contrast, the structured `{entity} destroyed at {grid}` body is explicitly produced by the uMod
plugin source and is not a generic vanilla Smart Alarm contract.

The historical journal only shows `Your base is under attack!` because the old bot matched the raw title and replaced
it with a local translation before logging. This proves that the old title-specific branch ran; it does not identify
the WarBandits producer or its current payload.

## Application payload comparison

| Source | State checked | Alarm contract |
| --- | --- | --- |
| This bot | Current workspace | `appData` array/object, case-insensitive `channelId=alarm`, JSON/object `body`; title and `body.type` optional |
| [RustPlusApi](https://github.com/HandyS11/RustPlusApi/blob/develop/docs/articles/fcm-notifications.md) | HEAD `e508cb0`, 2026-09-17 | `appData.channelId`, JSON `body`, `channelId == "alarm"` -> `OnAlarmTriggered` |
| [Facepunch Rust+](https://rust.facepunch.com/companion) | Public documentation checked 2026-09-23 | Customizable Smart Alarm push notifications; no published 2026 payload migration |

Conclusion: widening the title or `body.type` parser was useful for server variants, but it cannot repair a dead MCS
socket. There is no basis for inventing another alarm channel or message shape without a live captured envelope.

## Transport comparison

| MCS behavior | Liam 0.0.4 client | Local adapter | Maintained RustPlusApi |
| --- | --- | --- | --- |
| Connection considered ready | Raw TCP/TLS `connect` | Valid `LoginResponse` | Valid `LoginResponse` |
| Client heartbeat | Missing | Every five minutes | Every five minutes by default |
| Reply to server `HeartbeatPing` | Missing | `HeartbeatAck` with stream position | `HeartbeatAck` with stream position |
| Reliable-message acknowledgement | Missing | `StreamAck` after every data message | `StreamAck` after every data message |
| Server `Close` frame | Ignored | Explicit disconnect | Explicit disconnect |
| Silent/half-open socket detection | Missing | Heartbeat deadline plus 12-minute watchdog | Twelve-minute watchdog by default |
| Receive-loop failures | Several failures stay opaque | Surfaced and reconnected | Surfaced through an error event |
| Reconnect | Uncontrolled async timer | Reasoned exponential backoff capped at 30 seconds | Explicit bounded backoff pattern documented |

RustPlusApi added incoming stream tracking and `StreamAck` in
[`4145347`](https://github.com/HandyS11/RustPlusApi/commit/4145347a5bfbeef82795fad22a3c39b693d754f1)
on 2026-06-11. Its source states that without this acknowledgement the server treats messages as undelivered, closes
the connection after a few minutes, and replays them after reconnect. Socket hardening followed in
[`884b7d2`](https://github.com/HandyS11/RustPlusApi/commit/884b7d2) the same day.

The former lifecycle log was therefore misleading. The current
`MCS login accepted; notification listener ready.` line is emitted only after Google accepts the MCS login.

## Alternative Node client

[`@eneris/push-receiver`](https://www.npmjs.com/package/@eneris/push-receiver) 4.3.1 is active and adds heartbeat,
server-close handling, and a real ready event. It is not a safe drop-in replacement here:

- it requires Node 20 and a full Firebase configuration;
- its credential schema requires GCM, FCM installation, and encryption-key fields which this bot did not retain;
- generating new credentials would require registering the new FCM token with Rust+/Facepunch;
- its current source still marks incoming IQ handling as unresolved and does not send `StreamAck`.

Replacing the dependency directly would therefore force a credential migration while leaving one material protocol gap.

## Implemented surgical fix

`src/util/reliableFcmReceiver.js` preserves the existing `android_id` and `security_token` and replaces only the
listener transport boundary. It:

1. emits ready only after a valid MCS `LoginResponse`;
2. tracks incoming stream position;
3. answers `HeartbeatPing` and sends a periodic client heartbeat;
4. sends `StreamAck` after every data message, including deduplicated deliveries;
5. handles MCS `Close`, parser/socket errors, heartbeat deadlines and inactivity through one bounded reconnect path;
6. tries the standard ports 5228 then 443 without changing credentials;
7. fails fast on credential/authentication rejection instead of retrying blindly;
8. keeps the application-facing `ON_DATA_RECEIVED` and raid-plugin contracts unchanged.

`test/reliableFcmReceiver.test.js` covers login readiness, heartbeat response, stream acknowledgement, duplicate
delivery, dead-socket detection, authentication failure, and the full MCS alarm-to-acknowledged-Rust-chat path.

Do not replace `@liamcottle/rustplus.js` for this fault: the Rust+ WebSocket API and the Google FCM/MCS receiver are
separate paths. Team chat and normal server requests working while push alarms disappear is consistent with only the
FCM path failing.

## Current deployment check

The earlier filter used `FCM Host`, which did not match the startup text `FCM-listener Host`; an empty result from that
filter was inconclusive. Use the broad, case-insensitive check first:

```bash
sudo journalctl -u rustplusplus --since "2026-09-01" -o short-iso --no-pager \
  | grep -iE 'fcm|notification|alarm|destroyed|under attack'
```

After deployment, a healthy startup must contain:

```text
MCS login accepted; transport ready. Facepunch push delivery is not verified until the first notification is received.
```

A real raid notification must then show `notification received: channel="alarm"`, `alarm received`, and
`raid-alarm.in-game: delivered`. `!raidtest` validates only the outbound team-chat half.

## 2026-09-24 production-log follow-up

The supplied 2026-09-23/24 journal shows repeated accepted MCS logins and successful reconnects, but no
`notification received` entry on any channel. This proves the Google transport can authenticate; it does not prove
that Facepunch still targets the bot's Expo/FCM device registration. Current `rustplus.js` and the maintained
RustPlusApi implementation still use `channelId=alarm` and the same GCM/FCM/Expo/Facepunch registration chain. No
evidence of a new alarm payload or transport was found.

The runtime now records separate health evidence:

- `MCS login accepted; transport ready` means Google accepted the GCM identity;
- `Facepunch push delivery verified` appears only after an actual Rust+ notification reaches this process;
- `alarm received` proves the canonical alarm channel reached the router;
- `raid-alarm.in-game: delivered` proves Rust accepted the resulting team-chat message.

`!alarmstatus` exposes the same states, the last pairing receipt, active-server account matching, output/mute settings,
and up to five alarms received since process start. Until a matching server-pair notification has been observed, it
arms a non-blocking 120-second check and automatically reports receipt or timeout in Rust team chat. Only `pairing`
with `body.type=server`, the active IP/port and the listener SteamID64 completes it. On timeout, renew the device
registration through current `rustplus.js fcm-register` and replace the same SteamID64 through `/credentials add`.

When file logging is enabled with `!logs on`, every decoded MCS data notification is also captured before lifecycle
tracking, channel parsing, body parsing, deduplication or plugin routing in `logs/rustplusplus-fcm-raw.jsonl`. Each
LF-terminated JSON line contains the UTC receipt time, listener source, guild ID, SteamID64 and the untouched decoded
FCM envelope. This is the canonical capture for discovering a changed alarm channel/body contract. `!alarmstatus`
reports this as `rawlog on|off`. The file can include team text, server addresses, Steam IDs and pairing tokens and
must be treated as private diagnostic material.
