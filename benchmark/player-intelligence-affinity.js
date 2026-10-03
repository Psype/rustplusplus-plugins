const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { performance } = require('node:perf_hooks');

const Core = require('../src/plugins/playerIntelligence');
const Runtime = require('../src/plugins/playerIntelligence/runtime.js');

const PLAYER_COUNT = 300;
const SNAPSHOT_COUNT = 600;
const ROSTER_SIZE = 8;
const UNCACHED_QUERIES = 10;
const WARM_QUERIES = 200;

function steamId(index) {
    return (76561197900000000n + BigInt(index)).toString();
}

function event(kind, index, subject, payload, evidence = null) {
    const timestamp = new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString();
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind,
        observedAt: timestamp,
        recordedAt: timestamp,
        scope: { guildId: 'benchmark', serverKey: 'battlemetrics:42', wipeId: 'wipe:benchmark' },
        subject,
        payload,
        provenance: {
            source: 'benchmark', sourceEventId: `${kind}:${index}`, collectorVersion: 'benchmark-1'
        },
        confidence: 'verified',
        evidence
    });
}

async function run() {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-affinity-benchmark-'));
    try {
        const events = [];
        for (let index = 0; index < PLAYER_COUNT; index += 1) {
            events.push(event('identity_observed', index, {
                steamId: steamId(index), battlemetricsPlayerId: `${100000 + index}`, exactName: `Player ${index}`
            }, { caseFidelity: true }));
        }
        for (let snapshot = 0; snapshot < SNAPSHOT_COUNT; snapshot += 1) {
            const members = Array.from({ length: ROSTER_SIZE }, (_, offset) => {
                const player = (snapshot * 3 + offset) % PLAYER_COUNT;
                return {
                    name: `Player ${player}`, steamId: steamId(player),
                    battlemetricsPlayerId: `${100000 + player}`, role: offset === 0 ? 'leader' : 'member'
                };
            });
            events.push(event('clan_snapshot', PLAYER_COUNT + snapshot,
                { steamId: null, battlemetricsPlayerId: null, exactName: null }, {
                    tag: `C${snapshot % 50}`,
                    establishedAt: '2026-09-29T14:00:00.000Z',
                    complete: true,
                    declaredMemberCount: members.length,
                    members
                }, {
                    hash: Crypto.createHash('sha256').update(`snapshot:${snapshot}`).digest('hex'),
                    reference: null,
                    expiresAt: null
                }));
        }

        const store = new Core.JsonlHistoryStore({ directory });
        await store.appendMany(events);
        const stored = await store.readAll();
        const coldStarted = performance.now();
        const projection = Core.rebuild(stored);
        const coldProjectionMs = performance.now() - coldStarted;
        const subject = { steamId: steamId(0), battlemetricsPlayerId: null, exactName: null };
        const client = {
            battlemetricsInstances: { 42: { server_rust_last_wipe: '2026-09-29T14:00:00.000Z' } },
            getInstance: () => ({
                activeServer: 'server', serverList: { server: { battlemetricsId: '42' } }, trackers: {}
            }),
            playerIntelligenceDependencies: { store }
        };
        const command = {
            client,
            guildId: 'benchmark',
            rustplus: { serverId: 'server', isOperational: true, generalSettings: { inGameCommandsEnabled: true } },
            source: 'inGame', prefix: '!', command: `!affinity ${steamId(0)}`
        };
        const warmStarted = performance.now();
        for (let index = 0; index < WARM_QUERIES; index += 1) {
            await Runtime.handleCommand(command);
        }
        const warmTotalMs = performance.now() - warmStarted;
        const uncachedStarted = performance.now();
        for (let index = 0; index < UNCACHED_QUERIES; index += 1) {
            Core.rebuild([...stored]).clans.getAffinity(subject);
        }
        const uncachedTotalMs = performance.now() - uncachedStarted;
        const warmMeanMs = warmTotalMs / WARM_QUERIES;
        const uncachedMeanMs = uncachedTotalMs / UNCACHED_QUERIES;
        const affinity = projection.clans.getAffinity(subject);
        process.stdout.write(`${JSON.stringify({
            players: PLAYER_COUNT,
            snapshots: SNAPSHOT_COUNT,
            events: events.length,
            coldProjectionMs: Number(coldProjectionMs.toFixed(3)),
            warmQueries: WARM_QUERIES,
            warmQueryMeanMs: Number(warmMeanMs.toFixed(3)),
            uncachedQueryMeanMs: Number(uncachedMeanMs.toFixed(3)),
            warmSpeedup: Number((uncachedMeanMs / warmMeanMs).toFixed(1)),
            targetRelations: affinity.playedWith.length
        })}\n`);
    }
    finally {
        Fs.rmSync(directory, { recursive: true, force: true });
    }
}

run().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
