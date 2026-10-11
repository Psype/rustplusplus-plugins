'use strict';

const { performance } = require('node:perf_hooks');

const { projectClans } = require('../src/plugins/playerIntelligence/clanProjector.js');

const PLAYER_COUNT = Number.parseInt(process.argv[2] || process.env.RPP_BENCH_PLAYERS || '2700', 10);
const SNAPSHOT_COUNT = Number.parseInt(process.argv[3] || process.env.RPP_BENCH_SNAPSHOTS || '120', 10);
const UNRESOLVED_PER_SNAPSHOT = Number.parseInt(process.argv[4] || process.env.RPP_BENCH_UNRESOLVED || '4', 10);

function steamId(index) {
    return (76561197900000000n + BigInt(index)).toString();
}

function playerName(index) {
    return `Player ${`${index}`.padStart(4, '0')} Alpha`;
}

function buildFixture() {
    const persons = Array.from({ length: PLAYER_COUNT }, (_, index) => Object.freeze({
        personId: `steam:${steamId(index)}`,
        steamId: steamId(index),
        battlemetricsPlayerIds: Object.freeze([`${1000000 + index}`]),
        names: Object.freeze([Object.freeze({ name: playerName(index), verified: true })])
    }));
    const bySteamId = new Map(persons.map(person => [person.steamId, person.personId]));
    const byBattlemetricsId = new Map(persons.map(person => [person.battlemetricsPlayerIds[0], person.personId]));
    const byName = new Map(persons.map((person, index) => [playerName(index), person.personId]));
    const identities = Object.freeze({
        persons: Object.freeze(persons),
        resolveSubject(subject) {
            const personId = bySteamId.get(subject.steamId) ||
                byBattlemetricsId.get(subject.battlemetricsPlayerId) || byName.get(subject.exactName) ||
                `name:${`${subject.exactName || ''}`.toLocaleLowerCase('en')}`;
            return Object.freeze({ personId, confidence: 'verified', ambiguous: false });
        },
        displayName(personId) {
            const index = persons.findIndex(person => person.personId === personId);
            return index === -1 ? personId : playerName(index);
        }
    });
    const events = Array.from({ length: SNAPSHOT_COUNT }, (_, snapshot) => {
        const memberIndex = snapshot % PLAYER_COUNT;
        const unresolvedMembers = Array.from({ length: UNRESOLVED_PER_SNAPSHOT }, (_, offset) => ({
            observedText: playerName((snapshot * UNRESOLVED_PER_SNAPSHOT + offset + 1) % PLAYER_COUNT),
            role: 'member'
        }));
        return Object.freeze({
            kind: 'clan_snapshot',
            eventId: `snapshot-${`${snapshot}`.padStart(6, '0')}`,
            observedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, snapshot)).toISOString(),
            scope: Object.freeze({ serverKey: 'battlemetrics:benchmark', wipeId: 'wipe:benchmark' }),
            confidence: 'verified',
            evidence: null,
            payload: Object.freeze({
                tag: `C${snapshot % 20}`,
                establishedAt: '2026-10-01T00:00:00.000Z',
                declaredMemberCount: 1 + unresolvedMembers.length,
                members: Object.freeze([Object.freeze({
                    name: playerName(memberIndex),
                    steamId: steamId(memberIndex),
                    battlemetricsPlayerId: `${1000000 + memberIndex}`,
                    role: 'leader'
                })]),
                unresolvedMembers: Object.freeze(unresolvedMembers.map(Object.freeze))
            })
        });
    });
    return Object.freeze({ events: Object.freeze(events), identities });
}

const fixture = buildFixture();
const rssBefore = process.memoryUsage().rss;
const heapBefore = process.memoryUsage().heapUsed;
const started = performance.now();
const result = projectClans(fixture.events, fixture.identities);
const elapsedMs = performance.now() - started;
const memory = process.memoryUsage();
const resolvedMembers = result.snapshots.reduce((sum, snapshot) => sum + snapshot.members.length, 0);
const unresolvedMembers = result.snapshots.reduce((sum, snapshot) => sum + snapshot.unresolvedMembers.length, 0);

process.stdout.write(`${JSON.stringify({
    players: PLAYER_COUNT,
    snapshots: SNAPSHOT_COUNT,
    unresolvedPerSnapshot: UNRESOLVED_PER_SNAPSHOT,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    meanSnapshotMs: Number((elapsedMs / SNAPSHOT_COUNT).toFixed(3)),
    rssDeltaBytes: memory.rss - rssBefore,
    heapDeltaBytes: memory.heapUsed - heapBefore,
    resolvedMembers,
    unresolvedMembers
})}\n`);
