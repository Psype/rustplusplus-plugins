# Current AI handoff

Use this after the repository-root [`MEMORY.md`](../../MEMORY.md). It is intentionally short and current.

## Repository state

- Branch: `master`.
- Documentation release: `1.22.46`.
- Behavioral baseline: `1.22.45`, commit `adc9e85` before the documentation-only path update.
- Last behavioral validation: 430/430 tests and `tsc --noEmit -p .` on 2026-10-11.
- Production validation of the 1.22.45 scan redesign remains open.

Always inspect `git status --short`, `git diff --check`, and the existing diff before editing. Worktree changes belong
to the user. Do not reset or overwrite them.

## Safety invariants

- Wipes and `/cinfo` `Established` values are GMT; each panel computes its own wipe.
- Ignore Discord capture time for historical `/cinfo` scope.
- F7 never proves current presence.
- OCR-only names stay pending until trusted Steam/API/manual evidence confirms them.
- Provider outages produce `unknown`, never synthetic offline evidence.
- Never delete or reset `data/player-intelligence` or persistent sidecars.

## Current runtime shape

- Native `node .` parent; no retained TypeScript compiler in production.
- Translation and Tesseract use supervised workers.
- Player scans use a disposable child and a compact projection; the parent validates and commits the plan.
- The BattleMetrics hook emits bounded deltas without rebuilding the complete projection.
- Provider RPC is bounded by request/response schema, size, capacity, and timeout. External enrichment failure is
  isolated from validated local identity work.
- `/runtime` exposes bounded aggregate health, worker stage/memory/backoff/circuits, and JSONL append timing.

## Production checks still required

1. Back up `data/player-intelligence`; older releases through 1.22.44 cannot read the availability event introduced in
   1.22.45.
2. Pull/restart and verify `RUSTPLUS v1.22.46 OPERATIONAL`.
3. Run `!scanplayers`; require at least one worker `completed` and no recurring 18-22 s parent rebuilds.
4. Monitor RSS/heap and `pi_history_append` over several cycles.
5. Re-run the real KIRK Discord OCR import.
6. Validate FCM with a live matching alarm; phone delivery alone is insufficient.

## Where to look

- Documentation index: [`../README.md`](../README.md)
- Runtime hardening: [`../operations/runtime-resilience.md`](../operations/runtime-resilience.md)
- Player-intelligence model: [`../player-intelligence/architecture.md`](../player-intelligence/architecture.md)
- Commands: [`../reference/commands.md`](../reference/commands.md)
- FCM transport: [`../transport/fcm.md`](../transport/fcm.md)
- Frozen previous handoff: [`../archive/session-handoff-through-1.22.45.md`](../archive/session-handoff-through-1.22.45.md)

## Release rule

For code/runtime changes: bump SemVer, update concise memory plus the relevant thematic doc, run targeted tests and
`npm.cmd test`, run `git diff --check`, commit, and push `master`. Local validation never proves deployment.
