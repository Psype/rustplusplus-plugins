# Documentation map

Start with the smallest document that answers the task. Historical files are deliberately excluded from the normal
reading path so an AI does not spend context on superseded chronology.

## Fast routes

| Need | Read |
| --- | --- |
| Resume AI work | [`../MEMORY.md`](../MEMORY.md), then [`ai/current-state.md`](ai/current-state.md) |
| Install or pair the bot | [`setup/installation.md`](setup/installation.md), then [`setup/pair-server.md`](setup/pair-server.md) |
| Configure Discord | [`setup/discord-bot.md`](setup/discord-bot.md) |
| Register Rust+ credentials | [`setup/credentials.md`](setup/credentials.md) |
| Find a command | [`reference/commands.md`](reference/commands.md) |
| See the canonical feature catalogue | [`reference/features.md`](reference/features.md) |
| Diagnose runtime/memory | [`operations/runtime-resilience.md`](operations/runtime-resilience.md) |
| Understand player intelligence | [`player-intelligence/architecture.md`](player-intelligence/architecture.md) |
| Diagnose FCM/Rust+ transport | [`transport/fcm.md`](transport/fcm.md) |

## Folders

### `ai/`

- [`current-state.md`](ai/current-state.md): concise operational handoff and open checks.

### `setup/`

- [`installation.md`](setup/installation.md): installation, environment, production service, and deployment.
- [`discord-bot.md`](setup/discord-bot.md): Discord application setup.
- [`credentials.md`](setup/credentials.md): preferred local Rust+ credential registration.
- [`credentials-web.md`](setup/credentials-web.md): legacy web workflow and its limitations.
- [`pair-server.md`](setup/pair-server.md): pair and connect a Rust server.

### `reference/`

- [`commands.md`](reference/commands.md): detailed Discord and in-game command reference with examples.
- [`features.md`](reference/features.md): concise canonical feature/command catalogue parsed by the runtime.
- [`discord-channels.md`](reference/discord-channels.md): channel behavior.
- [`smart-devices.md`](reference/smart-devices.md): switches, alarms, and storage monitors.

### `architecture/`

- [`plugins.md`](architecture/plugins.md): plugin boundaries and registration.
- [`external-mods.md`](architecture/external-mods.md): external mod compatibility and evidence rules.

### `operations/`

- [`runtime-resilience.md`](operations/runtime-resilience.md): current reliability design and deployment checks.
- [`performance-plan.md`](operations/performance-plan.md): staged performance work and measurements.
- [`cache-inventory.md`](operations/cache-inventory.md): cache ownership, limits, and invalidation.
- [`player-crash-diagnostic.md`](operations/player-crash-diagnostic.md): Rust client crash triage.
- [`deep-sea-debugging.md`](operations/deep-sea-debugging.md): Deep Sea event diagnostics.

### `player-intelligence/`

- [`architecture.md`](player-intelligence/architecture.md): full identity/clan/OCR model and design history.
- [`battlemetrics.md`](player-intelligence/battlemetrics.md): BattleMetrics setup and tracker behavior.
- [`data-sources.md`](player-intelligence/data-sources.md): evaluated external identity sources.
- [`output-log.md`](player-intelligence/output-log.md): Rust `output_log.txt` collector study.
- [`rustradar-audit.md`](player-intelligence/rustradar-audit.md): rejected replacement-source audit.

### `transport/`

- [`fcm.md`](transport/fcm.md): FCM/MCS evidence and live validation.
- [`rustplus-js-audit.md`](transport/rustplus-js-audit.md): dependency transport audit.
- [`payload-audit.md`](transport/payload-audit.md): Rust+ payload/marker evidence.

### `archive/`

Frozen pre-1.22.46 memory and session handoff. Read only for chronology or forensic details; current behavior is
defined by `MEMORY.md`, `ai/current-state.md`, code, and current thematic documents.
