'use strict';

const Assert = require('node:assert/strict');
const Test = require('node:test');

const Similarity = require('../src/plugins/playerIntelligence/nameSimilarity.js');
const { resolveCinfo } = require('../src/plugins/playerIntelligence/resolveCinfo.js');

const STEAM_A = '76561197975819827';
const STEAM_B = '76561198154738095';

Test('Unicode-aware retrieval matches decorations, spacing and Turkish case without rewriting aliases', () => {
    const values = [
        ['CRYTEK', '☜★CRYTEK★☞'],
        ['DEUSLRA', 'D E U S L R A'],
        ['ESINTI YAPMA', 'ESİNTİ YAPMA'],
        ['한주', '한주'],
        ['مرحبا', 'مرحبا']
    ];
    for (const [observed, candidate] of values) {
        const result = Similarity.resolveRoster([observed], [{
            name: candidate, steamId: STEAM_A, battlemetricsPlayerId: null
        }])[0];
        Assert.equal(result.status, 'resolved');
        Assert.equal(result.candidate.name, candidate);
    }
});

Test('global assignment cannot reuse one identity and keeps ambiguous homonyms provisional', () => {
    const duplicate = Similarity.resolveRoster(['ALICE', 'ALICE'], [
        { name: 'Alice', steamId: STEAM_A, battlemetricsPlayerId: null }
    ]);
    Assert.equal(duplicate.filter(result => result.status === 'resolved').length, 1);
    Assert.equal(duplicate.filter(result => result.status === 'unresolved').length, 1);

    const ambiguous = Similarity.resolveRoster(['ALICE'], [
        { name: 'Alice', steamId: STEAM_A, battlemetricsPlayerId: null },
        { name: 'Alice', steamId: STEAM_B, battlemetricsPlayerId: null }
    ])[0];
    Assert.equal(ambiguous.status, 'provisional');
    Assert.equal(ambiguous.candidate, null);
    Assert.equal(ambiguous.alternatives.length, 2);
    Assert.equal(Object.isFrozen(ambiguous.alternatives), true);
    Assert.equal(Object.isFrozen(ambiguous.alternatives[0]), true);

    const clanPriorityOnly = Similarity.resolveRoster(['RW'], [
        { name: 'RW', steamId: STEAM_A, battlemetricsPlayerId: null, contextPriority: true },
        { name: 'RW', steamId: STEAM_B, battlemetricsPlayerId: null }
    ])[0];
    Assert.equal(clanPriorityOnly.status, 'provisional');
    Assert.equal(clanPriorityOnly.alternatives[0].steamId, STEAM_A);

    const bothCorroborated = Similarity.resolveRoster(['RW'], [
        { name: 'RW', steamId: STEAM_A, battlemetricsPlayerId: null, corroborated: true },
        { name: 'RW', steamId: STEAM_B, battlemetricsPlayerId: null, corroborated: true }
    ])[0];
    Assert.equal(bothCorroborated.status, 'provisional');

    const fuzzyOnly = Similarity.resolveRoster(['ABCDEFGHIJ'], [
        { name: 'ABCDEFGHIK', steamId: STEAM_A, battlemetricsPlayerId: null }
    ])[0];
    Assert.equal(fuzzyOnly.status, 'provisional');
    const fuzzyCorroborated = Similarity.resolveRoster(['ABCDEFGHIJ'], [
        { name: 'ABCDEFGHIK', steamId: STEAM_A, battlemetricsPlayerId: null, corroborated: true }
    ])[0];
    Assert.equal(fuzzyCorroborated.status, 'resolved');
});

Test('BattleMetrics-only and Steam-enriched aliases for one identity share one assignment group', () => {
    const groups = Similarity.groupCandidates([
        { name: 'Old Name', steamId: null, battlemetricsPlayerId: '42' },
        { name: 'New Name', steamId: STEAM_A, battlemetricsPlayerId: '42' }
    ]);
    Assert.equal(groups.length, 1);
    Assert.deepEqual(groups[0].aliases.map(alias => alias.steamId), [STEAM_A, STEAM_A]);
});

Test('exact visual evidence is slot-scoped and visual identity collisions stay ambiguous', () => {
    const exact = Similarity.resolveRoster(['bad ocr'], [{
        name: 'Known Unicode Name', steamId: STEAM_A, battlemetricsPlayerId: null,
        targetMemberIndex: 0, visualScore: 1, corroborated: true
    }])[0];
    Assert.equal(exact.status, 'resolved');
    Assert.equal(exact.candidate.steamId, STEAM_A);

    const wrongSlot = Similarity.resolveRoster(['bad ocr'], [{
        name: 'Known Unicode Name', steamId: STEAM_A, battlemetricsPlayerId: null,
        targetMemberIndex: 1, visualScore: 1, corroborated: true
    }])[0];
    Assert.equal(wrongSlot.status, 'unresolved');

    const collision = Similarity.resolveRoster(['bad ocr'], [
        { name: 'Known A', steamId: STEAM_A, battlemetricsPlayerId: null,
            targetMemberIndex: 0, visualScore: 1, corroborated: true },
        { name: 'Known B', steamId: STEAM_B, battlemetricsPlayerId: null,
            targetMemberIndex: 0, visualScore: 1, corroborated: true }
    ])[0];
    Assert.equal(collision.status, 'provisional');
    Assert.equal(collision.candidate, null);

    const approximateOnly = Similarity.resolveRoster(['bad ocr'], [{
        name: 'Known Unicode Name', steamId: STEAM_A, battlemetricsPlayerId: null,
        targetMemberIndex: 0, visualScore: 0.95, corroborated: false
    }])[0];
    Assert.equal(approximateOnly.status, 'unresolved');
});

Test('cinfo resolver keeps uncertain identities pending and immutable', () => {
    const parsed = {
        kind: 'cinfo', tag: 'TEST', declaredCount: 2,
        members: [
            { name: 'CRYTEK', role: 'leader' },
            { name: 'ALICE', role: 'member' }
        ],
        complete: true,
        establishedRaw: '09/29/2026 14:58:27',
        establishedAtUtc: '2026-09-29T16:58:27.000Z',
        timezoneConfidence: 'probable', rawText: '', errors: Object.freeze([])
    };
    const result = resolveCinfo(parsed, [
        { name: '☜★CRYTEK★☞', steamId: STEAM_A, battlemetricsPlayerId: null },
        { name: 'Alice', steamId: STEAM_B, battlemetricsPlayerId: null },
        { name: 'Alice', steamId: '76561197900000003', battlemetricsPlayerId: null }
    ]);
    Assert.equal(result.importable, true);
    Assert.equal(result.complete, false);
    Assert.equal(result.resolvedMembers.length, 1);
    Assert.equal(result.unresolvedMembers.length, 1);
    Assert.equal(result.unresolvedMembers[0].observedText, 'ALICE');
    Assert.equal(Object.isFrozen(result), true);
    Assert.equal(Object.isFrozen(result.resolvedMembers), true);
});

Test('cinfo links only candidates backed by a known Steam or BattleMetrics identity', () => {
    const parsed = {
        kind: 'cinfo', tag: 'TEST', declaredCount: 1,
        members: [{ name: 'Known Name', role: 'member' }],
        complete: true,
        establishedRaw: '09/29/2026 14:58:27',
        establishedAtUtc: '2026-09-29T14:58:27.000Z',
        timezoneConfidence: 'probable', rawText: '', errors: Object.freeze([])
    };
    const nameOnly = resolveCinfo(parsed, [{
        name: 'Known Name', steamId: null, battlemetricsPlayerId: null
    }]);
    Assert.equal(nameOnly.resolvedMembers.length, 0);
    Assert.equal(nameOnly.unresolvedMembers[0].observedText, 'Known Name');

    const battlemetrics = resolveCinfo(parsed, [{
        name: 'Known Name', steamId: null, battlemetricsPlayerId: '42'
    }]);
    Assert.equal(battlemetrics.resolvedMembers.length, 1);
    Assert.equal(battlemetrics.resolvedMembers[0].battlemetricsPlayerId, '42');
});

Test('partial cinfo resolves exact names but never strips adjacent Marley glyphs into Swizzy', () => {
    const parsed = {
        kind: 'cinfo', tag: 'FBM', declaredCount: 6,
        members: [
            { name: 'Rw', role: 'leader' },
            { name: '] Swizzy ]', role: 'member' }
        ],
        complete: false,
        establishedRaw: '09/29/2026 14:00:08',
        establishedAtUtc: '2026-09-29T14:00:08.000Z',
        timezoneConfidence: 'probable', rawText: '',
        errors: Object.freeze(['Roster count mismatch: expected 6, read 2.'])
    };
    const result = resolveCinfo(parsed, [
        { name: 'Rw', steamId: STEAM_A, battlemetricsPlayerId: null },
        { name: 'Swizzy', steamId: STEAM_B, battlemetricsPlayerId: null, corroborated: true }
    ]);
    Assert.deepEqual(result.resolvedMembers.map(member => member.name), ['Rw']);
    Assert.equal(result.unresolvedMembers[0].observedText, '] Swizzy ]');
});

Test('prepared historical resolver is differential-equivalent to filtering and rebuilding candidates', () => {
    const candidates = [];
    for (let index = 0; index < 80; index += 1) {
        const identityKey = `person:${index}`;
        const steamId = (76561197900001000n + BigInt(index)).toString();
        const battlemetricsPlayerId = `${50000 + index}`;
        candidates.push({
            name: `Player ${`${index}`.padStart(3, '0')} Alpha`, steamId, battlemetricsPlayerId,
            personId: identityKey, corroborated: index % 3 === 0
        }, {
            name: `P${`${index}`.padStart(3, '0')}-Legacy`, steamId: null, battlemetricsPlayerId,
            personId: identityKey, caseFidelity: index % 2 === 0
        });
    }
    candidates.push(
        { name: '☜★CRYTEK★☞', steamId: STEAM_A, battlemetricsPlayerId: '90001', personId: 'special:a' },
        { name: 'CRYTEK old', steamId: null, battlemetricsPlayerId: '90001', personId: 'special:a' },
        { name: 'Alice', steamId: STEAM_B, battlemetricsPlayerId: '90002', personId: 'special:b' },
        { name: 'Alice', steamId: '76561197900009999', battlemetricsPlayerId: '90003',
            personId: 'special:c' }
    );
    const prepared = Similarity.prepareRosterResolver(candidates, candidate => candidate.personId);
    const cases = [
        { observed: ['Player 007 Alpha', 'P011-Legacy'], excluded: new Set() },
        { observed: ['Player 007 Alpha', 'P011-Legacy'], excluded: new Set(['person:7']) },
        { observed: ['CRYTEK', 'ALICE'], excluded: new Set(['person:1', 'special:c']) },
        { observed: ['Player 021 Alphx', 'Player 022 Alpha'], excluded: new Set(['person:3']),
            options: { resolvedScore: 0.8, resolvedMargin: 0.05 } },
        { observed: ['CRYTEK'], excluded: new Set(), options: { exactOnly: true } }
    ];
    for (const value of cases) {
        const filtered = candidates.filter(candidate => !value.excluded.has(candidate.personId));
        Assert.deepEqual(
            prepared.resolve(value.observed, value.options || {}, value.excluded),
            Similarity.resolveRoster(value.observed, filtered, value.options || {})
        );
    }

    // A malformed cross-person stable-ID collision takes the exact slow fallback instead of changing evidence.
    const collision = [
        { name: 'Collision A', steamId: STEAM_A, battlemetricsPlayerId: null, personId: 'collision:a' },
        { name: 'Collision B', steamId: STEAM_A, battlemetricsPlayerId: null, personId: 'collision:b' }
    ];
    const collisionResolver = Similarity.prepareRosterResolver(collision, candidate => candidate.personId);
    Assert.deepEqual(
        collisionResolver.resolve(['Collision B'], {}, new Set(['collision:a'])),
        Similarity.resolveRoster(['Collision B'], collision.filter(candidate => candidate.personId !== 'collision:a'))
    );
});
