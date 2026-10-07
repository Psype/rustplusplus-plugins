const Assert = require('node:assert/strict');
const Test = require('node:test');

const PendingReconciler = require('../src/plugins/playerIntelligence/pendingReconciler.js');

Test('WarBandits pending reconciliation accepts only an exact current or historical alias', () => {
    const player = { steamId: '76561199179453915', name: 'FUNTIK NEW', aliases: ['ＦＵＮＴＩＫ'] };
    Assert.equal(PendingReconciler.exactWarBanditsMatch(player, 'funtik'), true);
    Assert.equal(PendingReconciler.exactWarBanditsMatch(player, 'FUNT'), false);
    Assert.equal(PendingReconciler.exactWarBanditsMatch(player, 'FUNTIK N'), false);
    Assert.equal(PendingReconciler.exactWarBanditsMatch({ ...player, steamId: 'invalid' }, 'FUNTIK'), false);
});

Test('pending reconciliation checkpoints reject inconsistent provider cooldowns', () => {
    const checkpoint = PendingReconciler.startCheckpoint('2026-10-03T12:00:00.000Z');
    checkpoint.battlemetricsFailures = 1;
    Assert.throws(() => PendingReconciler.validateCheckpoint(checkpoint), /provider retry/u);
    checkpoint.battlemetricsRetryAt = '2026-10-03T12:01:00.000Z';
    Assert.equal(PendingReconciler.validateCheckpoint(checkpoint), checkpoint);
});

Test('pending work selection retries after a bounded burst of fresh identities', () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    const candidates = [{ id: 'fresh-a' }, { id: 'fresh-b' }, { id: 'retry' }];
    const retries = new Map([['retry', { id: 'retry', failures: 1,
        nextAttemptAt: '2026-10-03T11:59:00.000Z' }]]);
    Assert.equal(PendingReconciler.selectWork(candidates, new Set(), retries, 'id', now, 0).candidate.id,
        'fresh-a');
    Assert.equal(PendingReconciler.selectWork(candidates, new Set(), retries, 'id', now,
        PendingReconciler.FRESH_BURST_LIMIT).candidate.id, 'retry');

    const prioritizedRetries = new Map([
        ['important', { id: 'important', failures: 1, nextAttemptAt: '2026-10-03T11:59:30.000Z' }],
        ['ordinary', { id: 'ordinary', failures: 1, nextAttemptAt: '2026-10-03T11:59:00.000Z' }]
    ]);
    Assert.equal(PendingReconciler.selectWork([{ id: 'important' }, { id: 'ordinary' }], new Set(),
        prioritizedRetries, 'id', now, PendingReconciler.FRESH_BURST_LIMIT).candidate.id, 'important');
});

Test('confirmed non-duplicate clan sightings prioritize pending identities', () => {
    const observed = '2026-10-03T12:00:00.000Z';
    const persons = [
        { personId: 'bm:100', steamId: null, battlemetricsPlayerIds: ['100'], names: [
            { name: 'No clan evidence', firstObservedAt: observed, lastObservedAt: observed }
        ] },
        { personId: 'bm:200', steamId: null, battlemetricsPlayerIds: ['200'], names: [
            { name: 'Confirmed twice', firstObservedAt: observed, lastObservedAt: observed }
        ] }
    ];
    const member = personId => ({ personId });
    const projection = {
        clans: { snapshots: [
            { confirmed: true, duplicate: false, members: [member('bm:200')] },
            { confirmed: true, duplicate: false, members: [member('bm:200')] },
            { confirmed: true, duplicate: true, members: [member('bm:100')] },
            { confirmed: false, duplicate: false, members: [member('bm:100')] }
        ] },
        identities: {
            persons,
            displayName: personId => persons.find(person => person.personId === personId).names[0].name
        }
    };

    const rows = PendingReconciler.pendingRows(projection);
    Assert.deepEqual(rows.map(row => [row.personId, row.snapshotCount]), [
        ['bm:200', 2],
        ['bm:100', 0]
    ]);
    Assert.deepEqual(PendingReconciler.battlemetricsCandidates(projection, rows)
        .map(candidate => candidate.battlemetricsPlayerId), ['200', '100']);
    Assert.deepEqual(PendingReconciler.warBanditsCandidates(projection, new Set(['100', '200']), true, rows)
        .map(candidate => candidate.query), ['Confirmed twice', 'No clan evidence']);
});

Test('WarBandits fallback rejects a display name owned as an alias by another pending identity', () => {
    const observed = '2026-10-03T12:00:00.000Z';
    const persons = [
        { personId: 'bm:1', steamId: null, battlemetricsPlayerIds: ['1'], names: [
            { name: 'FUNTIK', firstObservedAt: observed, lastObservedAt: observed }
        ] },
        { personId: 'bm:2', steamId: null, battlemetricsPlayerIds: ['2'], names: [
            { name: 'FUNTIK', firstObservedAt: observed, lastObservedAt: observed },
            { name: 'OTHER', firstObservedAt: observed, lastObservedAt: observed }
        ] },
        { personId: 'bm:3', steamId: null, battlemetricsPlayerIds: ['3'], names: [
            { name: 'X'.repeat(65), firstObservedAt: observed, lastObservedAt: observed }
        ] }
    ];
    const projection = {
        clans: { snapshots: [] },
        identities: {
            persons,
            displayName: personId => personId === 'bm:1' ? 'FUNTIK' :
                personId === 'bm:2' ? 'OTHER' : 'X'.repeat(65)
        }
    };
    const candidates = PendingReconciler.warBanditsCandidates(projection, new Set(['1', '2', '3']), true);
    Assert.equal(candidates.some(candidate => candidate.query === 'FUNTIK'), false);
    Assert.deepEqual(candidates.map(candidate => candidate.query), ['OTHER']);
});

Test('identities carrying several BattleMetrics IDs remain manual', () => {
    const observed = '2026-10-03T12:00:00.000Z';
    const projection = {
        clans: { snapshots: [] },
        identities: {
            persons: [{
                personId: 'bm:multi', steamId: null, battlemetricsPlayerIds: ['1', '2'], names: [
                    { name: 'Collision', firstObservedAt: observed, lastObservedAt: observed }
                ]
            }],
            displayName: () => 'Collision'
        }
    };
    Assert.deepEqual(PendingReconciler.battlemetricsCandidates(projection), []);
    Assert.deepEqual(PendingReconciler.warBanditsCandidates(projection, new Set(), true), []);
});
