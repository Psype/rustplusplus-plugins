const Assert = require('node:assert/strict');
const Test = require('node:test');

const RuntimeTelemetry = require('../src/util/runtimeTelemetry.js');

function harness() {
    let now = 0;
    let cpu = { user: 1000, system: 500 };
    let elu = { active: 10, idle: 90 };
    let scheduled = null;
    let cleared = false;
    let unref = false;
    const logs = [];
    const monitor = {
        max: 900000000,
        enableCalled: false,
        disableCalled: false,
        resetCalled: false,
        enable() { this.enableCalled = true; },
        disable() { this.disableCalled = true; },
        reset() { this.resetCalled = true; },
        percentile(value) {
            return ({ 50: 50000000, 95: 200000000, 99: 300000000 })[value] || 0;
        }
    };
    const telemetry = RuntimeTelemetry.createRuntimeTelemetry({
        now: () => now,
        memoryUsage: () => ({
            rss: 1400 * 1024 * 1024,
            heapUsed: 1000 * 1024 * 1024,
            heapTotal: 1100 * 1024 * 1024,
            external: 40 * 1024 * 1024,
            arrayBuffers: 30 * 1024 * 1024
        }),
        heapStatistics: () => ({ heap_size_limit: 4096 * 1024 * 1024 }),
        cpuUsage: () => ({ ...cpu }),
        eventLoopUtilization: () => ({ ...elu }),
        createEventLoopMonitor: () => monitor,
        setIntervalImpl: callback => {
            scheduled = callback;
            return { unref: () => { unref = true; } };
        },
        clearIntervalImpl: () => { cleared = true; }
    });
    return {
        telemetry,
        logs,
        monitor,
        advance(value) { now += value; },
        setCpu(value) { cpu = value; },
        setElu(value) { elu = value; },
        scheduled: () => scheduled,
        cleared: () => cleared,
        unref: () => unref
    };
}

Test('runtime telemetry emits one immutable bounded 60-second aggregate without free-form source fields', () => {
    const value = harness();
    const sentinel = 'message-secret-76561198000000000-discord-token-secret';
    Assert.equal(value.telemetry.start({
        intervalMs: 60000,
        logger: (title, message, level) => value.logs.push({ title, message, level }),
        sources: {
            imports: () => ({ active: 1, previewsPending: 2, decisionsClaimed: 3, decisionQueues: 4,
                message: sentinel }),
            ocr: () => ({ active: 1, queued: 2, queuedBytes: 3 * 1024 * 1024, steamId: sentinel }),
            scans: () => ({ active: 1, forcedRerunsQueued: 1, path: sentinel }),
            translations: () => ({ active: 2, queued: 0, token: sentinel })
        }
    }), true);
    Assert.equal(value.unref(), true);
    Assert.equal(value.monitor.enableCalled, true);

    const span = value.telemetry.startSpan('translation');
    value.advance(3500);
    span.finish('success');
    span.finish('failure');
    for (let index = 0; index < 10000; index += 1) {
        const fast = value.telemetry.startSpan('ocr_run');
        fast.finish('success');
    }
    value.advance(56500);
    value.setCpu({ user: 901000, system: 100500 });
    value.setElu({ active: 510, idle: 590 });
    const snapshot = value.scheduled()();

    Assert.equal(snapshot.windowMs, 60000);
    Assert.equal(snapshot.process.rssMiB, 1400);
    Assert.equal(snapshot.process.cpuPct, 1.7);
    Assert.deepEqual(snapshot.eventLoop, {
        utilizationPct: 50,
        p50Ms: 50,
        p95Ms: 200,
        p99Ms: 300,
        maxMs: 900
    });
    Assert.equal(snapshot.operations.translation.started, 1);
    Assert.equal(snapshot.operations.translation.success, 1);
    Assert.equal(snapshot.operations.translation.failure, 0);
    Assert.equal(snapshot.operations.translation.p95Ms, 5000);
    Assert.equal(snapshot.operations.translation.slow, 1);
    Assert.equal(snapshot.operations.ocr_run.started, 10000);
    Assert.equal(snapshot.operations.ocr_run.completed, 10000);
    Assert.equal(snapshot.sources.imports.previewsPending, 2);
    Assert.equal(snapshot.collectorFailures, 0);
    Assert.deepEqual(Object.keys(snapshot.sources.imports),
        ['active', 'previewsPending', 'decisionsClaimed', 'decisionQueues']);
    Assert.equal(Object.isFrozen(snapshot), true);
    Assert.equal(Object.isFrozen(snapshot.operations.translation), true);
    Assert.equal(value.telemetry.getLastSnapshot(), snapshot);
    Assert.equal(value.monitor.resetCalled, true);
    Assert.equal(JSON.stringify({ snapshot, logs: value.logs }).includes(sentinel), false);
    Assert.equal(value.logs.filter(log => log.title === 'RUNTIME_SLOW').length, 1);
    Assert.equal(value.logs.filter(log => log.title === 'RUNTIME').length, 1);
    Assert.equal(value.logs.find(log => log.title === 'RUNTIME').level, 'warn');
    Assert.equal(value.logs.filter(log => log.title === 'RUNTIME_WORK').length, 1);
    Assert.match(value.logs.find(log => log.title === 'RUNTIME_WORK').message,
        /translation_started=1 translation_completed=1 .*translation_skipped=0 .*translation_p95Ms=5000/);
    Assert.match(value.logs.find(log => log.title === 'RUNTIME_WORK').message,
        /ocr_queue_wait_started=0 .*ocr_queue_wait_maxMs=0/);

    value.telemetry.stop();
    Assert.equal(value.cleared(), true);
    Assert.equal(value.monitor.disableCalled, true);
    Assert.equal(value.telemetry.isEnabled(), false);
});

Test('runtime telemetry isolates failing sources, resets windows and rejects unbounded dimensions', () => {
    const value = harness();
    value.telemetry.start({
        intervalMs: 60000,
        sources: {
            imports: () => { throw new Error('private-source-error'); },
            ocr: () => ({ active: -5, queued: Number.POSITIVE_INFINITY, queuedBytes: 'invalid' }),
            translations: () => Object.defineProperty({}, 'active', {
                get() { throw new Error('private-getter-error'); }
            })
        }
    });
    Assert.throws(() => value.telemetry.startSpan('unknown'), /Unknown runtime telemetry operation/);
    const span = value.telemetry.startSpan('scan_cycle');
    Assert.throws(() => span.finish('unknown'), /Unknown runtime telemetry outcome/);
    span.finish('failure');
    value.advance(60000);
    const first = value.telemetry.flush();
    Assert.equal(first.sourceFailures, 2);
    Assert.deepEqual(first.sources.ocr, { active: 0, queued: 0, queuedBytes: 0 });
    Assert.equal(first.operations.scan_cycle.failure, 1);

    value.advance(60000);
    const second = value.telemetry.flush();
    Assert.equal(second.operations.scan_cycle.started, 0);
    Assert.equal(second.operations.scan_cycle.completed, 0);
    Assert.equal(JSON.stringify(second).includes('private-source-error'), false);
    value.telemetry.stop();
});

Test('disabled runtime telemetry creates no timer and spans stay inert', () => {
    const value = harness();
    Assert.equal(value.telemetry.start({ enabled: false }), false);
    value.telemetry.startSpan('translation').finish('success');
    Assert.throws(() => value.telemetry.startSpan('translation').finish('unknown'),
        /Unknown runtime telemetry outcome/);
    Assert.equal(value.telemetry.getLastSnapshot(), null);
    Assert.equal(value.scheduled(), null);
});

Test('runtime telemetry rejects intervals outside its bounded configuration range', () => {
    const value = harness();
    Assert.throws(() => value.telemetry.start({ intervalMs: 9999 }), /between 10000 and 300000/);
    Assert.throws(() => value.telemetry.start({ intervalMs: 300001 }), /between 10000 and 300000/);
    Assert.equal(value.telemetry.isEnabled(), false);
});

Test('runtime telemetry reports cross-window starts and completions separately', () => {
    const value = harness();
    value.telemetry.start({ intervalMs: 60000 });
    const span = value.telemetry.startSpan('scan_cycle');
    value.advance(60000);
    const started = value.telemetry.flush();
    Assert.equal(started.operations.scan_cycle.started, 1);
    Assert.equal(started.operations.scan_cycle.completed, 0);

    value.advance(1000);
    span.finish('success');
    value.advance(59000);
    const completed = value.telemetry.flush();
    Assert.equal(completed.operations.scan_cycle.started, 0);
    Assert.equal(completed.operations.scan_cycle.completed, 1);
    Assert.equal(completed.operations.scan_cycle.success, 1);
    value.telemetry.stop();
});

Test('runtime telemetry exposes fixed collector failures instead of reporting false health', () => {
    let now = 0;
    const logs = [];
    const failure = () => { throw new Error('private collector detail'); };
    const telemetry = RuntimeTelemetry.createRuntimeTelemetry({
        now: () => now,
        memoryUsage: failure,
        heapStatistics: failure,
        cpuUsage: failure,
        eventLoopUtilization: failure,
        createEventLoopMonitor: failure,
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => undefined
    });
    telemetry.start({
        intervalMs: 60000,
        logger: (title, message, level) => logs.push({ title, message, level })
    });
    now = 60000;
    const snapshot = telemetry.flush();
    Assert.equal(snapshot.collectorFailures, 7);
    Assert.equal(snapshot.sourceFailures, 0);
    Assert.equal(logs.find(log => log.title === 'RUNTIME').level, 'warn');
    Assert.equal(JSON.stringify({ snapshot, logs }).includes('private collector detail'), false);
    telemetry.stop();
});

Test('runtime telemetry rebaselines CPU and ELU after a transient collector failure', () => {
    let now = 0;
    let calls = 0;
    const telemetry = RuntimeTelemetry.createRuntimeTelemetry({
        now: () => now,
        memoryUsage: () => ({}),
        heapStatistics: () => ({}),
        cpuUsage: () => {
            calls += 1;
            if (calls === 2) throw new Error('transient CPU failure');
            return calls === 1 ? { user: 0, system: 0 } :
                calls === 3 ? { user: 6000000, system: 0 } : { user: 6600000, system: 0 };
        },
        eventLoopUtilization: () => {
            if (calls === 2) throw new Error('transient ELU failure');
            return calls <= 1 ? { active: 0, idle: 0 } :
                calls === 3 ? { active: 60000, idle: 60000 } : { active: 90000, idle: 90000 };
        },
        createEventLoopMonitor: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 0, max: 0 }),
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => undefined
    });
    telemetry.start({ intervalMs: 60000 });
    now = 60000;
    const failed = telemetry.flush();
    Assert.equal(failed.collectorFailures, 2);
    Assert.equal(failed.process.cpuPct, 0);
    Assert.equal(failed.eventLoop.utilizationPct, 0);

    now = 120000;
    const rebaselined = telemetry.flush();
    Assert.equal(rebaselined.collectorFailures, 0);
    Assert.equal(rebaselined.process.cpuPct, 0);
    Assert.equal(rebaselined.eventLoop.utilizationPct, 0);

    now = 180000;
    const recovered = telemetry.flush();
    Assert.equal(recovered.process.cpuPct, 1);
    Assert.equal(recovered.eventLoop.utilizationPct, 50);
    telemetry.stop();
});
