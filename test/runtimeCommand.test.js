const Assert = require('node:assert/strict');
const Test = require('node:test');

const RuntimeCommand = require('../src/commands/runtime.js');

function snapshot() {
    const operation = { started: 2, completed: 2, success: 1, failure: 1, timeout: 0,
        skipped: 0, dropped: 0, averageMs: 10, maxMs: 20, p50Ms: 10, p95Ms: 25, p99Ms: 25, slow: 0 };
    return Object.freeze({
        windowMs: 60000,
        process: { rssMiB: 1400, heapUsedMiB: 3200, heapTotalMiB: 3300, heapLimitMiB: 4096,
            externalMiB: 40, arrayBuffersMiB: 30, cpuPct: 97.5 },
        eventLoop: { utilizationPct: 98, p50Ms: 20, p95Ms: 100, p99Ms: 300, maxMs: 1200 },
        sources: {
            imports: { active: 1, previewsPending: 2, decisionsClaimed: 0, decisionQueues: 1 },
            ocr: { active: 1, queued: 2, queuedBytes: 1000 },
            scans: { active: 1, forcedRerunsQueued: 0, workerActive: 1, workerQueued: 2,
                automaticBackoffs: 1, automaticBackoffSkips: 5,
                workerCompleted: 12, workerFailures: 3, workerStalePlans: 4,
                workerConsecutiveFailures: 2, workerStage: 'rebuilding', workerRssMiB: 701,
                workerHeapUsedMiB: 512, workerProviderInvocationsOutstanding: 4,
                workerProviderCircuitsOpen: 1, workerLastCode: 'WORKER_EXITED',
                workerLastMessage: 'Worker process exited before commit. stderr: JavaScript heap out of memory.',
                workerLastAt: '2026-10-11T14:15:00.000Z', workerLastStage: 'rebuilding' },
            translations: { active: 0, queued: 0 }
        },
        sourceFailures: 0,
        collectorFailures: 0,
        operations: { translation: operation, ocr_queue_wait: operation, ocr_run: operation,
            import_prepare: operation, import_decision: operation, scan_cycle: operation,
            pi_rebuild_identities: operation, pi_rebuild_metrics: operation,
            pi_rebuild_clans: operation, pi_rebuild_presence: operation,
            pi_rebuild_wipes: operation, pi_rebuild_total: operation, pi_history_append: operation }
    });
}

function harness(administrator) {
    const order = [];
    const edits = [];
    const interaction = {
        guildId: 'private-guild',
        deferReply: async options => { order.push(['defer', options]); }
    };
    const client = {
        isAdministrator: () => { order.push(['permission']); return administrator; },
        intlGet: () => 'Missing permission.',
        interactionEditReply: async (_interaction, payload) => {
            order.push(['edit']);
            edits.push(payload);
            return payload;
        }
    };
    return { client, interaction, order, edits };
}

Test('/runtime defers first, is ephemeral and renders only aggregate admin telemetry', async () => {
    const value = harness(true);
    const sentinel = 'message-secret-76561198000000000-discord-token-secret';
    await RuntimeCommand.execute(value.client, value.interaction, {
        telemetry: {
            isEnabled: () => true,
            getLastSnapshot: () => ({ ...snapshot(), ignoredPrivateValue: sentinel })
        }
    });
    Assert.deepEqual(value.order[0], ['defer', { ephemeral: true }]);
    Assert.deepEqual(value.order.slice(1).map(item => item[0]), ['permission', 'edit']);
    Assert.match(value.edits[0].content, /Runtime — last completed 60\.0 s window/);
    Assert.match(value.edits[0].content, /degraded — event-loop p99, event-loop max, heap pressure/);
    Assert.match(value.edits[0].content, /heap 3200\/3300 MiB \(limit 4096 MiB\)/);
    Assert.match(value.edits[0].content, /OCR: run 2 started, 2 completed .*p95 25 ms.*queue .*p95 25 ms/);
    Assert.match(value.edits[0].content, /Imports: prepare .*decision/);
    Assert.match(value.edits[0].content,
        /scans 1 active, 0 queued, worker 1 active, 2 queued, 12 completed, 3 failed, 4 stale, 1 backoff, 5 deferred/);
    Assert.match(value.edits[0].content,
        /Scan worker: stage rebuilding \| RSS 701 MiB \| heap 512 MiB \| 2 consecutive failures \| provider RPC 4 pending, 1 circuits open/);
    Assert.match(value.edits[0].content,
        /Last scan worker failure: WORKER_EXITED at rebuilding on 2026-10-11T14:15:00\.000Z .*heap out of memory/);
    Assert.match(value.edits[0].content,
        /PI rebuild completed\/p95\/max ms: total 2\/25\/20 \| identities 2\/25\/20 .*wipes 2\/25\/20 .*journal append 2\/25\/20/);
    Assert.match(value.edits[0].content, /Health: degraded/);
    Assert.equal(value.edits[0].content.length <= 1950, true);
    Assert.equal(value.edits[0].content.includes(sentinel), false);
    Assert.deepEqual(value.edits[0].allowedMentions, { parse: [] });
});

Test('/runtime rejects free-form scan diagnostics even when a malformed snapshot is injected', async () => {
    const value = harness(true);
    const sentinel = 'private-player-name-76561198000000000';
    const unsafe = snapshot();
    unsafe.sources.scans = {
        ...unsafe.sources.scans,
        workerStage: sentinel,
        workerLastCode: sentinel,
        workerLastMessage: sentinel,
        workerLastAt: sentinel,
        workerLastStage: sentinel
    };
    await RuntimeCommand.execute(value.client, value.interaction, {
        telemetry: { isEnabled: () => true, getLastSnapshot: () => unsafe }
    });
    Assert.equal(value.edits[0].content.includes(sentinel), false);
    Assert.match(value.edits[0].content, /Scan worker: stage unknown/);
    Assert.match(value.edits[0].content, /Last scan worker failure: none/);
});

Test('/runtime exposes only the fixed admission and IPC failure diagnostics', () => {
    const messages = [
        'Worker IPC delivery failed.',
        'Stable identity candidate input exceeded its limit.',
        'Stable identity candidate input was invalid.'
    ];
    for (const message of messages) {
        const current = snapshot();
        current.sources.scans = {
            ...current.sources.scans,
            workerLastCode: 'WORKER_IPC_SEND_FAILED',
            workerLastMessage: message,
            workerLastAt: '2026-10-11T14:15:00.000Z',
            workerLastStage: 'initializing'
        };
        Assert.equal(RuntimeCommand.render(current).includes(message), true);
    }
});

Test('/runtime reports an active automatic scan backoff as degraded without a live worker failure', async () => {
    const value = harness(true);
    const backoffOnly = snapshot();
    backoffOnly.process = { ...backoffOnly.process, heapUsedMiB: 1000 };
    backoffOnly.eventLoop = { utilizationPct: 1, p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4 };
    backoffOnly.sources.scans = {
        ...backoffOnly.sources.scans,
        workerConsecutiveFailures: 0,
        workerStage: 'idle',
        workerRssMiB: 0,
        workerHeapUsedMiB: 0,
        workerProviderInvocationsOutstanding: 0,
        workerProviderCircuitsOpen: 0,
        workerLastCode: null,
        workerLastMessage: null,
        workerLastAt: null,
        workerLastStage: null
    };
    await RuntimeCommand.execute(value.client, value.interaction, {
        telemetry: { isEnabled: () => true, getLastSnapshot: () => backoffOnly }
    });
    Assert.match(value.edits[0].content, /Health: degraded .*scan worker/);
});

Test('/runtime refuses non-administrators after acknowledging the interaction', async () => {
    const value = harness(false);
    await RuntimeCommand.execute(value.client, value.interaction, {
        telemetry: { isEnabled: () => { throw new Error('must not read telemetry'); } }
    });
    Assert.deepEqual(value.order[0], ['defer', { ephemeral: true }]);
    Assert.equal(value.edits[0].content, 'Missing permission.');
});

Test('/runtime reports disabled and not-yet-completed states without collecting on demand', async () => {
    const disabled = harness(true);
    await RuntimeCommand.execute(disabled.client, disabled.interaction, {
        telemetry: { isEnabled: () => false, getLastSnapshot: () => { throw new Error('not called'); } }
    });
    Assert.match(disabled.edits[0].content, /disabled/);

    const waiting = harness(true);
    await RuntimeCommand.execute(waiting.client, waiting.interaction, {
        telemetry: { isEnabled: () => true, getLastSnapshot: () => null }
    });
    Assert.match(waiting.edits[0].content, /first completed window/);
});
