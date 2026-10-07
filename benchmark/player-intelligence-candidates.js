'use strict';

const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { performance } = require('node:perf_hooks');

const Core = require('../src/plugins/playerIntelligence');
const Runtime = require('../src/plugins/playerIntelligence/runtime.js');

const PERSON_COUNT = 2500;
const EVENTS_PER_PERSON = 8;
const BATCH_SIZE = 5000;
const SCOPE = Object.freeze({
    guildId: 'benchmark', serverKey: 'battlemetrics:42', wipeId: 'wipe:2026-10-06T14:00:00.000Z'
});

function steamId(index) {
    return `${76561197900000000n + BigInt(index)}`;
}

function identityEvent(person, duplicate) {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_observed',
        observedAt: '2026-10-07T00:00:00.000Z',
        recordedAt: '2026-10-07T00:00:00.000Z',
        scope: SCOPE,
        subject: {
            steamId: steamId(person),
            battlemetricsPlayerId: `${1000000 + person}`,
            exactName: `Player ${person}`
        },
        payload: { caseFidelity: duplicate % 2 === 0 },
        provenance: { source: 'benchmark', sourceEventId: `${person}:${duplicate}`,
            collectorVersion: 'benchmark-1' },
        confidence: duplicate % 2 === 0 ? 'verified' : 'untrusted',
        evidence: null
    });
}

function rawTripletCount(events) {
    return new Set(events.filter(event => event.kind === 'identity_observed' && event.subject.exactName)
        .map(event => `${event.subject.steamId || ''}\u0000${event.subject.battlemetricsPlayerId || ''}\u0000${
            event.subject.exactName}`)).size;
}

async function run() {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-candidate-benchmark-'));
    try {
        const store = new Core.JsonlHistoryStore({ directory: Path.join(directory, 'benchmark', '42') });
        const events = [];
        for (let person = 0; person < PERSON_COUNT; person += 1) {
            for (let duplicate = 0; duplicate < EVENTS_PER_PERSON; duplicate += 1) {
                events.push(identityEvent(person, duplicate));
            }
        }
        for (let offset = 0; offset < events.length; offset += BATCH_SIZE) {
            await store.appendMany(events.slice(offset, offset + BATCH_SIZE));
        }
        const instance = {
            activeServer: 'server', serverList: { server: { battlemetricsId: '42' } }, trackers: {}
        };
        const client = {
            getInstance: () => instance,
            battlemetricsInstances: { 42: { players: {} } },
            playerIntelligenceDependencies: { dataDirectory: directory }
        };
        const context = { client, guildId: 'benchmark', rustplus: { serverId: 'server', team: { players: [] } } };

        if (typeof global.gc === 'function') global.gc();
        const coldHeapBefore = process.memoryUsage().heapUsed;
        const coldStarted = performance.now();
        let candidates = await Runtime.identityCandidates(context);
        const coldMs = performance.now() - coldStarted;
        const coldHeapBytes = process.memoryUsage().heapUsed - coldHeapBefore;
        const candidateRows = candidates.length;
        candidates = null;

        if (typeof global.gc === 'function') global.gc();
        const warmHeapBefore = process.memoryUsage().heapUsed;
        const warmStarted = performance.now();
        candidates = await Runtime.identityCandidates(context);
        const warmMs = performance.now() - warmStarted;
        const warmHeapBytes = process.memoryUsage().heapUsed - warmHeapBefore;
        if (candidates.length !== PERSON_COUNT) throw new Error('Candidate benchmark result is incomplete.');

        process.stdout.write(`${JSON.stringify({
            events: events.length,
            rawUniqueTriplets: rawTripletCount(events),
            candidateRows,
            coldMs: Number(coldMs.toFixed(3)),
            warmMs: Number(warmMs.toFixed(3)),
            coldHeapBytes,
            warmHeapBytes,
            gcAvailable: typeof global.gc === 'function'
        })}\n`);
    }
    finally {
        Fs.rmSync(directory, { recursive: true, force: true });
    }
}

run().catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
});
