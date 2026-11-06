'use strict';

const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence');
const Exporter = require('../src/util/steamBanExport.js');

const STEAM_A = '76561198357380276';
const STEAM_B = '76561198154738095';

function event(steamId, name, wipeId, observedAt, overrides = {}) {
    return Core.createEvent({
        schemaVersion: 1,
        kind: 'identity_observed',
        observedAt,
        recordedAt: observedAt,
        scope: { guildId: 'guild', serverKey: 'warbandits-main', wipeId },
        subject: { steamId, battlemetricsPlayerId: overrides.battlemetricsPlayerId || null, exactName: name },
        payload: { caseFidelity: true },
        provenance: {
            source: overrides.source || 'warbandits',
            sourceEventId: `${steamId}-${wipeId}-${observedAt}`,
            collectorVersion: 'test-1'
        },
        confidence: 'verified',
        evidence: null
    });
}

Test('identity export prioritizes multi-wipe and frequent identities before old one-off players', async t => {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-ban-export-'));
    const directory = Path.join(root, 'guild', '42');
    const output = Path.join(root, 'output');
    t.after(() => Fs.rmSync(root, { recursive: true, force: true }));
    const store = new Core.JsonlHistoryStore({ directory });
    await store.appendMany([
        event(STEAM_B, 'Old one-off', 'wipe-0', '2025-01-01T00:00:00.000Z'),
        event(STEAM_A, "H'", 'wipe-1', '2026-10-01T00:00:00.000Z', { source: 'steam-profile-current',
            battlemetricsPlayerId: '1200' }),
        event(STEAM_A, "H'", 'wipe-2', '2026-11-01T00:00:00.000Z', { battlemetricsPlayerId: '1200' }),
        Core.createEvent({
            schemaVersion: 1,
            kind: 'player_metric_observed',
            observedAt: '2026-11-01T01:00:00.000Z',
            recordedAt: '2026-11-01T01:00:00.000Z',
            scope: { guildId: 'guild', serverKey: 'warbandits-main', wipeId: 'wipe-2' },
            subject: { steamId: STEAM_A, battlemetricsPlayerId: '1200', exactName: "H'" },
            payload: { provider: 'warbandits', metric: 'playtime', value: 456.75, unit: 'hours' },
            provenance: { source: 'warbandits', sourceEventId: 'metric-a', collectorVersion: 'test-1' },
            confidence: 'verified',
            evidence: null
        })
    ]);

    const result = await Exporter.exportIdentities({ dataRoot: root, outputDirectory: output,
        now: () => new Date('2026-11-06T00:00:00.000Z') });
    Assert.deepEqual(result.rows.map(row => row.steamId), [STEAM_A, STEAM_B]);
    Assert.equal(result.rows[0].wipeCount, 2);
    Assert.equal(result.rows[0].observationCount, 2);
    Assert.equal(result.rows[0].warBanditsHoursMax, 456.75);
    Assert.equal(result.rows[0].currentSteamName, "H'");
    Assert.deepEqual(result.rows[0].battlemetricsPlayerIds, ['1200']);
    Assert.equal(Fs.existsSync(Path.join(output, 'identities.csv')), true);
    Assert.equal(Fs.existsSync(Path.join(output, 'identity-export.json')), true);
});

Test('history discovery ignores symlinks and finds only shard-bearing leaves', async t => {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-ban-discovery-'));
    t.after(() => Fs.rmSync(root, { recursive: true, force: true }));
    const leaf = Path.join(root, 'guild', 'server');
    Fs.mkdirSync(leaf, { recursive: true });
    Fs.writeFileSync(Path.join(leaf, '2026-11.jsonl'), '');
    Assert.deepEqual(await Exporter.discoverHistoryDirectories(root), [leaf]);
});
