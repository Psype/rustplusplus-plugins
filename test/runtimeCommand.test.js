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
            scans: { active: 1, forcedRerunsQueued: 0 },
            translations: { active: 0, queued: 0 }
        },
        sourceFailures: 0,
        collectorFailures: 0,
        operations: { translation: operation, ocr_queue_wait: operation, ocr_run: operation,
            import_prepare: operation, import_decision: operation, scan_cycle: operation }
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
    Assert.equal(value.edits[0].content.includes(sentinel), false);
    Assert.deepEqual(value.edits[0].allowedMentions, { parse: [] });
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
