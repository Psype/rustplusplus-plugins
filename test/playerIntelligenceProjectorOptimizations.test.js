'use strict';

const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence/index.js');

const STEAM_ID = '76561197975819827';

function event(kind, sourceEventId, overrides = {}) {
    const observedAt = overrides.observedAt || '2026-10-01T00:00:00.000Z';
    return Core.createEvent({
        schemaVersion: 1,
        kind,
        observedAt,
        recordedAt: overrides.recordedAt || observedAt,
        scope: { guildId: 'guild', serverKey: 'battlemetrics:42', wipeId: 'wipe:test' },
        subject: overrides.subject || {
            steamId: STEAM_ID, battlemetricsPlayerId: '101', exactName: 'Player'
        },
        payload: overrides.payload || { caseFidelity: true },
        provenance: { source: overrides.source || 'manual-command', sourceEventId, collectorVersion: 'test' },
        confidence: 'verified',
        evidence: null
    });
}

Test('metric projection selects the same total-order maximum independently of journal order', () => {
    const identity = event('identity_observed', 'identity');
    const metrics = [
        event('player_metric_observed', 'metric-earlier-observed', {
            observedAt: '2026-10-01T01:00:00.000Z', recordedAt: '2026-10-01T05:00:00.000Z',
            subject: { steamId: STEAM_ID, battlemetricsPlayerId: null, exactName: null },
            payload: { provider: 'warbandits', metric: 'playtime', value: 1, unit: 'hours' }
        }),
        event('player_metric_observed', 'metric-earlier-recorded', {
            observedAt: '2026-10-01T02:00:00.000Z', recordedAt: '2026-10-01T02:00:00.000Z',
            subject: { steamId: STEAM_ID, battlemetricsPlayerId: null, exactName: null },
            payload: { provider: 'warbandits', metric: 'playtime', value: 2, unit: 'hours' }
        }),
        event('player_metric_observed', 'metric-latest', {
            observedAt: '2026-10-01T02:00:00.000Z', recordedAt: '2026-10-01T03:00:00.000Z',
            subject: { steamId: STEAM_ID, battlemetricsPlayerId: null, exactName: null },
            payload: { provider: 'warbandits', metric: 'playtime', value: 3, unit: 'hours' }
        })
    ];
    for (const values of [metrics, [...metrics].reverse(), [metrics[1], metrics[0], metrics[2]]]) {
        const projection = Core.rebuild([identity, ...values]);
        Assert.equal(projection.metrics.observations.length, 1);
        Assert.equal(projection.metrics.observations[0].value, 3);
        Assert.equal(projection.metrics.observations[0].observedAt, '2026-10-01T02:00:00.000Z');
    }
});

Test('identity resolution reuses immutable results without allowing weaker fields to override stable IDs', () => {
    const identities = Core.rebuild([
        event('identity_observed', 'identity')
    ]).identities;
    const first = identities.resolveSubject({
        steamId: STEAM_ID, battlemetricsPlayerId: '101', exactName: 'Player'
    });
    const second = identities.resolveSubject({
        steamId: STEAM_ID, battlemetricsPlayerId: '999', exactName: 'Different name'
    });
    Assert.strictEqual(second, first);
    Assert.deepEqual(first, {
        personId: `steam:${STEAM_ID}`, confidence: 'authoritative', ambiguous: false
    });
    Assert.equal(Object.isFrozen(first), true);
});

Test('history cache merge retains monthly shard order while appending to an older shard', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-history-merge-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const store = new Core.JsonlHistoryStore({ directory });
    const septemberFirst = event('identity_observed', 'september-first', {
        observedAt: '2026-09-01T00:00:00.000Z', recordedAt: '2026-09-01T00:00:00.000Z'
    });
    const october = event('identity_observed', 'october', {
        observedAt: '2026-10-01T00:00:00.000Z', recordedAt: '2026-10-01T00:00:00.000Z'
    });
    const septemberLateAppend = event('identity_observed', 'september-late-append', {
        observedAt: '2026-09-02T00:00:00.000Z', recordedAt: '2026-09-02T00:00:00.000Z'
    });
    await store.appendMany([septemberFirst, october]);
    await store.append(septemberLateAppend);
    Assert.deepEqual((await store.readAll()).map(value => value.provenance.sourceEventId), [
        'september-first', 'september-late-append', 'october'
    ]);
});
