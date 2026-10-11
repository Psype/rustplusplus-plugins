'use strict';

const Assert = require('node:assert/strict');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence/index.js');
const RuntimeTelemetry = require('../src/util/runtimeTelemetry.js');

const REBUILD_OPERATIONS = Object.freeze([
    'pi_rebuild_identities',
    'pi_rebuild_metrics',
    'pi_rebuild_clans',
    'pi_rebuild_presence',
    'pi_rebuild_wipes',
    'pi_rebuild_total'
]);

function identityEvent(name = 'private-player-name', battlemetricsPlayerId = '123456789') {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_observed',
        observedAt: '2026-10-11T10:00:00.000Z',
        recordedAt: '2026-10-11T10:00:00.000Z',
        scope: { guildId: 'private-guild', serverKey: 'battlemetrics:private', wipeId: 'wipe:private' },
        subject: { steamId: null, battlemetricsPlayerId, exactName: name },
        payload: { caseFidelity: true },
        provenance: {
            source: 'warbandits', sourceEventId: `private-source-${battlemetricsPlayerId}`,
            collectorVersion: 'test-1'
        },
        confidence: 'verified',
        evidence: null
    });
}

Test('Core.rebuild records one bounded private-data-free timing for every projection stage', t => {
    const logs = [];
    t.after(() => RuntimeTelemetry.stop());
    RuntimeTelemetry.start({
        intervalMs: 300000,
        logger: (title, message, level) => logs.push({ title, message, level })
    });
    const events = Object.freeze([identityEvent()]);
    const projection = Core.rebuild(events);
    Assert.strictEqual(Core.rebuild(events), projection, 'a cache hit must not be reported as projection work');

    const snapshot = RuntimeTelemetry.flush();
    for (const operation of REBUILD_OPERATIONS) {
        Assert.equal(snapshot.operations[operation].started, 1, operation);
        Assert.equal(snapshot.operations[operation].completed, 1, operation);
        Assert.equal(snapshot.operations[operation].success, 1, operation);
        Assert.equal(snapshot.operations[operation].failure, 0, operation);
    }
    Assert.deepEqual(RuntimeTelemetry.OPERATIONS.filter(operation => operation.startsWith('pi_rebuild_')),
        REBUILD_OPERATIONS);
    const serialized = JSON.stringify({ snapshot, logs });
    for (const privateValue of ['private-player-name', '123456789', 'private-guild', 'private-source']) {
        Assert.equal(serialized.includes(privateValue), false);
    }
});

Test('Core.rebuild reports validation failure only on its fixed total dimension', t => {
    const logs = [];
    t.after(() => RuntimeTelemetry.stop());
    RuntimeTelemetry.start({
        intervalMs: 300000,
        logger: (title, message, level) => logs.push({ title, message, level })
    });

    Assert.throws(() => Core.rebuild(Object.freeze([{ privateName: 'must-never-be-logged' }])),
        /unsupported or missing fields/u);
    const snapshot = RuntimeTelemetry.flush();
    Assert.equal(snapshot.operations.pi_rebuild_total.started, 1);
    Assert.equal(snapshot.operations.pi_rebuild_total.failure, 1);
    for (const operation of REBUILD_OPERATIONS.filter(operation => operation !== 'pi_rebuild_total')) {
        Assert.equal(snapshot.operations[operation].started, 0, operation);
        Assert.equal(snapshot.operations[operation].completed, 0, operation);
    }
    Assert.equal(JSON.stringify({ snapshot, logs }).includes('must-never-be-logged'), false);
});

Test('Core.rebuildAsync yields between fixed stages and remains equivalent and cacheable', async () => {
    const event = identityEvent('async-player-name', '987654321');
    const synchronous = Core.rebuild([event]);
    const events = Object.freeze([event]);
    let yields = 0;
    const asynchronous = await Core.rebuildAsync(events, {
        yieldControl: async () => { yields += 1; }
    });

    Assert.equal(yields, 6);
    Assert.equal(JSON.stringify(asynchronous), JSON.stringify(synchronous));
    Assert.strictEqual(await Core.rebuildAsync(events, {
        yieldControl: () => { throw new Error('cache hits must not yield'); }
    }), asynchronous);
    await Assert.rejects(Core.rebuildAsync([event], { yieldControl: /** @type {any} */ (42) }),
        /yieldControl must be a function/u);
});

Test('projection stage thresholds emit a bounded slow signal without dynamic dimensions', () => {
    let now = 0;
    const logs = [];
    const telemetry = RuntimeTelemetry.createRuntimeTelemetry({
        now: () => now,
        memoryUsage: () => ({}),
        heapStatistics: () => ({}),
        cpuUsage: () => ({ user: 0, system: 0 }),
        eventLoopUtilization: () => ({ active: 0, idle: 0 }),
        createEventLoopMonitor: () => ({
            enable() {}, disable() {}, reset() {}, percentile: () => 0, max: 0
        }),
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => undefined
    });
    telemetry.start({
        intervalMs: 10000,
        logger: (title, message, level) => logs.push({ title, message, level })
    });
    const span = telemetry.startSpan('pi_rebuild_clans');
    now = 1001;
    span.finish('success');
    span.finish('failure');

    Assert.deepEqual(logs, [{
        title: 'RUNTIME_SLOW',
        message: 'operation=pi_rebuild_clans outcome=success elapsedMs=1001 thresholdMs=1000',
        level: 'warn'
    }]);
    telemetry.stop();
});
