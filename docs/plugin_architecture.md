# Plugin Architecture

Fork-specific optional features are integrated through `src/plugins/pluginManager.js`. Core handlers must import only
that boundary and must not import individual feature plugins.

## Current plugins

- `deepSea`: detects and reports Deep Sea from Rust+ marker polling.
- `hiddenVendors`: persists vendors that disappear from map marker polling.
- `autoTranslate`: translates eligible relayed team-chat messages.
- `raidAlarm`: handles direct Rust+ FCM alerts from haggbart's uMod Raid Alarm without requiring a vanilla Smart Alarm.
- `teammateLanguageDatabase`: records teammate names and detected languages.
- `customCommands`: owns commands added by this fork, including `deepsea`, `hv`, `hvw`, `hvt`, `language`, `record`,
  `who`, `logs`, `commands`, and `autotranslate`.

## Stable hooks

The core currently calls these plugin-manager operations:

- `install`
- `onTeamInfo`
- `onTeamMessage`
- `beforeMapMarkersUpdate`
- `afterMapMarkersUpdate`
- `translateTeamMessage`
- `handleCommand`
- `handleFcmAlarm`
- `getEventsCommandResponse`
- `getDeepSeaStatus`

Plugin failures are logged and isolated so an optional feature cannot cancel the authoritative Rust+ polling cycle or
message handling. Command results and the exposed plugin-name list are immutable.

## Upstream maintenance

`upstream` tracks `https://github.com/alexemanuelol/rustplusplus.git`. Merge upstream changes separately from plugin
changes. Bug fixes that alter original bot behavior remain small core patches; optional features belong behind the
plugin-manager boundary.

The Rust+ dependency remains pinned to `alexemanuelol/rustplus.js#089cfd3`. Although Liam's current branch is newer by
date, this pin is also version 2.5.0 and contains Proto3 compatibility fixes absent from Liam's branch. Do not replace
it until `test/protocolCompatibility.test.js` passes against the candidate dependency.

## QA

- `npm ci --ignore-scripts`
- `npm test`
- `npm run benchmark:plugins`

No airdrop behavior is implemented. Rust+ exposes a generic marker type `Crate = 6`, but no captured fixture currently
proves that it represents a vanilla airdrop.
