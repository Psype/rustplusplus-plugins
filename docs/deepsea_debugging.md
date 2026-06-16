# Deep Sea / Rust+ Payload Debugging

This repo now writes multiple debug files that can be used to discover what Rust+ exposes when a Deep Sea event opens.

## Log layers

- `logs/rustplusplus-raw-socket.txt` — best-effort UTF-8 text directly from raw inbound/outbound WebSocket frames. Use this for simple `grep` across data before RustPlusPlus decodes it.
- `logs/rustplusplus-events.log` — newline-delimited JSON for decoded Rust+ message events and polled map-marker payloads.
- `logs/rustplus-markers-history.log` — newline-delimited JSON containing marker snapshots over time.
- `logs/rustplus-markers.json` — latest marker snapshot only, useful for quick inspection.

## Useful commands

Search raw socket text for likely Deep Sea/vendor words:

```bash
grep -aiE 'deep|sea|floating|ghost|naval|casino|shopkeeper' logs/rustplusplus-raw-socket.txt
```

Search decoded event/poll payloads:

```bash
jq 'select((.payload? | tostring | test("deep|sea|floating|ghost|naval|casino|shopkeeper"; "i")) or (.markers? | tostring | test("deep|sea|floating|ghost|naval|casino|shopkeeper"; "i")))' \
  logs/rustplusplus-events.log
```

Extract marker shapes from marker history so the matcher can be made exact instead of heuristic:

```bash
jq -c '.markers[]? | {
  id, type, name, x, y, radius, color1, color2, alpha,
  sellOrdersCount: (.sellOrders // [] | length),
  raw: .
}' logs/rustplus-markers-history.log
```

Compare snapshots before and during Deep Sea:

```bash
cp logs/rustplus-markers.json logs/rustplus-markers-before-deepsea.json
# wait until Deep Sea is active, then:
cp logs/rustplus-markers.json logs/rustplus-markers-during-deepsea.json
jq -s '.[1].markers - .[0].markers' \
  logs/rustplus-markers-before-deepsea.json \
  logs/rustplus-markers-during-deepsea.json
```

## Development suggestions

1. Capture one snapshot before Deep Sea and one while Deep Sea is active.
2. Identify the exact marker fields that changed: `type`, `name`, `radius`, `color`, `x/y`, or any new field.
3. Refine `src/handlers/deepSeaHandler.js` once the exact vendor cluster marker shape is known.
4. Keep notifications state-change based only: inactive -> active and active -> inactive. Do not notify on every poll.
5. Keep raw socket logging temporary or rotate/delete logs regularly because raw WebSocket text can grow quickly.

## What to send back for implementation

When Deep Sea is active, send a few matching lines from:

```bash
grep -aiE 'deep|sea|floating|ghost|naval|casino|shopkeeper' logs/rustplusplus-raw-socket.txt | tail -50
jq -c '.markers[]?' logs/rustplus-markers.json
```

If there are no text matches, send the marker diff between before/during snapshots. Deep Sea may be exposed as numeric vending-machine marker/type/coordinate changes with little readable text.
