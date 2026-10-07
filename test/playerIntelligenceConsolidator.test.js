'use strict';

const Assert = require('node:assert/strict');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence');
const LinearOracle = require('./fixtures/identityConsolidatorLinear.js');

const STEAM_A = '76561197975819827';
const STEAM_B = '76561198154738095';

function observed(subject, sourceEventId = 'observation') {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_observed',
        observedAt: '2026-10-06T15:00:00.000Z',
        recordedAt: '2026-10-06T15:00:00.000Z',
        scope: { guildId: 'guild', serverKey: 'battlemetrics:42',
            wipeId: 'wipe:2026-10-06T14:00:00.000Z' },
        subject,
        payload: { caseFidelity: true },
        provenance: { source: 'test', sourceEventId, collectorVersion: 'test-1' },
        confidence: 'verified',
        evidence: null
    });
}

Test('the consolidator fills either missing stable ID through one exact trusted local identity', () => {
    const known = [
        { steamId: null, battlemetricsPlayerId: '101', name: 'Dana', nameTrusted: true },
        { steamId: STEAM_A, battlemetricsPlayerId: null, name: 'Dana', nameTrusted: true }
    ];
    const fromSteam = Core.consolidateCandidates(known, { steamId: STEAM_A, name: 'Dana' });
    Assert.deepEqual(fromSteam.identity, {
        steamId: STEAM_A, battlemetricsPlayerId: '101', name: 'Dana', caseFidelity: true
    });
    Assert.deepEqual(fromSteam.links, [{
        steamId: STEAM_A, battlemetricsPlayerId: '101', via: 'exact-name'
    }]);

    const fromBattlemetrics = Core.consolidateCandidates(known,
        { battlemetricsPlayerId: '101', name: 'Dana' });
    Assert.equal(fromBattlemetrics.identity.steamId, STEAM_A);
    Assert.deepEqual(fromBattlemetrics.changedFields, ['steamId']);
});

Test('identifier matches fill the counterpart and current local display name without fuzzy mutation', () => {
    const known = [{
        personId: `steam:${STEAM_A}`,
        steamId: STEAM_A,
        battlemetricsPlayerId: '101',
        name: 'Cockornut Tree',
        preferredName: 'Cockornut Tree',
        nameTrusted: true
    }];
    const result = Core.consolidateCandidates(known, { battlemetricsPlayerId: '101' });
    Assert.deepEqual(result.identity, {
        steamId: STEAM_A,
        battlemetricsPlayerId: '101',
        name: 'Cockornut Tree',
        caseFidelity: true
    });
    Assert.deepEqual(result.changedFields, ['steamId', 'name']);
    Assert.equal(result.status, 'enriched');

    const exactName = Core.consolidateCandidates(known, { name: 'Cockornut Tree' });
    Assert.equal(exactName.identity.steamId, STEAM_A);
    Assert.equal(exactName.identity.battlemetricsPlayerId, '101');
    Assert.deepEqual(exactName.links, [{
        steamId: STEAM_A, battlemetricsPlayerId: '101', via: 'exact-name'
    }]);

    const partial = Core.consolidateCandidates(known, { steamId: STEAM_B, name: 'tree' });
    Assert.equal(partial.identity.battlemetricsPlayerId, null);
    Assert.equal(partial.status, 'new');
});

Test('ambiguous names, conflicting stable IDs and low-fidelity OCR never create an automatic link', () => {
    const ambiguous = [
        { steamId: null, battlemetricsPlayerId: '101', name: 'Nova', nameTrusted: true },
        { steamId: null, battlemetricsPlayerId: '102', name: 'Nova', nameTrusted: true }
    ];
    const nameCollision = Core.consolidateCandidates(ambiguous, { steamId: STEAM_A, name: 'Nova' });
    Assert.equal(nameCollision.identity.battlemetricsPlayerId, null);
    Assert.equal(nameCollision.status, 'ambiguous');

    const conflicting = Core.consolidateCandidates([
        { steamId: STEAM_A, battlemetricsPlayerId: '101', name: 'Alice', nameTrusted: true }
    ], { steamId: STEAM_A, battlemetricsPlayerId: '102', name: 'Alice' });
    Assert.equal(conflicting.status, 'conflict');
    Assert.deepEqual(conflicting.links, []);

    const ocr = Core.consolidateCandidates([
        { steamId: null, battlemetricsPlayerId: '101', name: 'Dana', nameTrusted: true }
    ], { steamId: STEAM_A, name: 'Dana', caseFidelity: false });
    Assert.equal(ocr.identity.battlemetricsPlayerId, null);
});

Test('projection consolidation excludes an unverified OCR correction from automatic name evidence', () => {
    const link = Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_linked',
        observedAt: '2026-10-06T15:01:00.000Z',
        recordedAt: '2026-10-06T15:01:00.000Z',
        scope: { guildId: 'guild', serverKey: 'battlemetrics:42',
            wipeId: 'wipe:2026-10-06T14:00:00.000Z' },
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: 'ChiCo' },
        payload: {
            linkId: 'manual-chico', targetSteamId: STEAM_A, targetBattlemetricsPlayerId: null,
            targetName: 'Ch1co', targetNameSource: 'verified-history', reason: 'operator correction'
        },
        provenance: { source: 'discord-admin', sourceEventId: 'manual-chico', collectorVersion: 'test-1' },
        confidence: 'verified',
        evidence: null
    });
    const projection = Core.rebuild([
        observed({ steamId: STEAM_A, battlemetricsPlayerId: null, exactName: 'Ch1co' }, 'ch1co'),
        observed({ steamId: null, battlemetricsPlayerId: null, exactName: 'ChiCo' }, 'chico-ocr'),
        link
    ]);
    const rejected = Core.consolidateProjection(projection,
        { steamId: STEAM_A, name: 'ChiCo', caseFidelity: true });
    Assert.equal(rejected.identity.battlemetricsPlayerId, null);

    const accepted = Core.consolidateProjection(projection,
        { steamId: STEAM_A, name: 'Ch1co', caseFidelity: true });
    Assert.equal(accepted.identity.battlemetricsPlayerId, null);
    Assert.equal(Object.isFrozen(accepted), true);
    Assert.equal(Object.isFrozen(accepted.identity), true);
    Assert.throws(() => { accepted.identity.name = 'changed'; }, TypeError);
});

Test('prepared consolidation is identical to the linear oracle for Unicode, conflicts and ambiguities', () => {
    const scenarios = [{
        candidates: [{
            personId: `steam:${STEAM_A}`,
            steamId: STEAM_A,
            battlemetricsPlayerId: '101',
            name: 'ＫＯＨ PENG 🕷',
            preferredName: 'KOH PENG 🕷',
            nameTrusted: true
        }, {
            personId: `steam:${STEAM_A}`,
            steamId: STEAM_A,
            battlemetricsPlayerId: '101',
            name: 'Cafe\u0301',
            preferredName: 'KOH PENG 🕷',
            nameTrusted: true
        }],
        observations: [
            { name: 'KOH PENG 🕷' },
            { exactName: 'Café' },
            { steamId: STEAM_A },
            { steamId: STEAM_A, name: 'ＫＯＨ\u0007PENG 🕷' }
        ]
    }, {
        candidates: [
            { steamId: STEAM_A, battlemetricsPlayerId: '201', name: 'Nova', nameTrusted: true },
            { steamId: STEAM_B, battlemetricsPlayerId: '202', name: 'Nova', nameTrusted: true },
            { steamId: STEAM_A, battlemetricsPlayerId: '203', name: 'Conflict', nameTrusted: true },
            { steamId: null, battlemetricsPlayerId: '204', name: 'Untrusted', nameTrusted: false }
        ],
        observations: [
            { name: 'Nova' },
            { steamId: STEAM_A, name: 'Nova' },
            { steamId: STEAM_A, battlemetricsPlayerId: '202', name: 'Nova' },
            { battlemetricsPlayerId: '204', name: 'Untrusted' },
            { steamId: STEAM_B, name: 'Untrusted', caseFidelity: false }
        ]
    }];

    for (const { candidates, observations } of scenarios) {
        const prepared = Core.prepareIdentityConsolidator(candidates);
        Assert.equal(Object.isFrozen(prepared), true);
        for (const observation of observations) {
            const expected = LinearOracle.consolidateCandidates(candidates, observation);
            Assert.deepEqual(prepared(observation), expected);
            Assert.deepEqual(Core.consolidateCandidates(candidates, observation), expected);
        }
    }
});

Test('prepared consolidation stays identical to the linear oracle across deterministic generated cases', () => {
    /** @param {number} seed */
    function random(seed) {
        let state = seed >>> 0;
        return () => {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return (state >>> 0) / 0x100000000;
        };
    }
    /** @param {() => number} next @param {readonly any[]} values */
    const pick = (next, values) => values[Math.floor(next() * values.length)];
    const steamIds = Array.from({ length: 12 }, (_unused, index) =>
        `${76561197900000000n + BigInt(index)}`);
    const battlemetricsIds = Array.from({ length: 12 }, (_unused, index) => `${1000 + index}`);
    const names = ['Nova', 'NOVA', 'ＫＯＨ PENG 🕷', 'KOH PENG 🕷', 'Café', 'Cafe\u0301',
        'Ch1co', 'ChiCo', '♡cute♡ Plu', 'ab', '  spaced\u0007name  ', null];

    for (let seed = 1; seed <= 12; seed += 1) {
        const next = random(seed * 0x9e3779b1);
        const candidates = Array.from({ length: 48 }, (_unused, index) => {
            const knownSteamId = pick(next, [...steamIds, null, null, 'invalid-steam']);
            const knownBattlemetricsId = pick(next, [...battlemetricsIds, null, null, 'invalid-bm']);
            return {
                personId: next() < 0.55 ? `person:${Math.floor(next() * 16)}` : undefined,
                steamId: knownSteamId,
                battlemetricsPlayerId: knownBattlemetricsId,
                name: pick(next, names),
                preferredName: next() < 0.3 ? pick(next, names) : null,
                nameTrusted: next() >= 0.2,
                caseFidelity: next() >= 0.15,
                duplicateMarker: index
            };
        });
        candidates.push(candidates[Math.floor(next() * candidates.length)]);
        const prepared = Core.prepareIdentityConsolidator(candidates);

        for (let observationIndex = 0; observationIndex < 160; observationIndex += 1) {
            const observation = {
                steamId: pick(next, [...steamIds, null, 'invalid-steam']),
                battlemetricsPlayerId: pick(next, [...battlemetricsIds, null, 'invalid-bm']),
                caseFidelity: next() >= 0.15,
                nameTrusted: next() >= 0.15,
                allowExactName: next() >= 0.15
            };
            const selectedName = pick(next, names);
            if (next() < 0.5) observation.name = selectedName;
            else observation.exactName = selectedName;
            const expected = LinearOracle.consolidateCandidates(candidates, observation);
            Assert.deepEqual(prepared(observation), expected,
                `prepared mismatch for seed ${seed}, observation ${observationIndex}`);
            Assert.deepEqual(Core.consolidateCandidates(candidates, observation), expected,
                `compatibility mismatch for seed ${seed}, observation ${observationIndex}`);
        }
    }
});

Test('projection consolidation prepares display names only once for repeated observations', () => {
    let displayNameCalls = 0;
    const persons = Object.freeze([Object.freeze({
                personId: `steam:${STEAM_A}`,
                steamId: STEAM_A,
                battlemetricsPlayerIds: Object.freeze(['101', '102']),
                names: Object.freeze([Object.freeze({
                    name: 'Current Name', caseFidelity: true, verified: true, steamStatus: 'current'
                }), Object.freeze({
                    name: 'Past Name', caseFidelity: true, verified: true, steamStatus: 'past'
                })])
            })]);
    const identities = Object.freeze({
            persons,
            displayName: personId => {
                Assert.equal(personId, `steam:${STEAM_A}`);
                displayNameCalls += 1;
                return 'Current Name';
            }
        });
    const projection = Object.freeze({ identities });

    for (let index = 0; index < 100; index += 1) {
        Core.consolidateProjection(projection, {
            steamId: STEAM_A,
            battlemetricsPlayerId: index % 2 === 0 ? '101' : null,
            name: index % 3 === 0 ? 'Current Name' : null
        });
    }
    Assert.equal(displayNameCalls, 1);

    const secondProjection = Object.freeze({
        identities: Object.freeze({ ...projection.identities, persons: Object.freeze([...persons]) })
    });
    Core.consolidateProjection(secondProjection, { steamId: STEAM_A });
    Assert.equal(displayNameCalls, 2);
});

Test('projection consolidation never caches a mutable projection snapshot', () => {
    let displayNameCalls = 0;
    const person = {
        personId: `steam:${STEAM_A}`,
        steamId: STEAM_A,
        battlemetricsPlayerIds: [],
        names: [{ name: 'First Name', caseFidelity: true, verified: true, steamStatus: 'current' }]
    };
    const projection = {
        identities: {
            persons: [person],
            displayName: () => {
                displayNameCalls += 1;
                return person.names[0].name;
            }
        }
    };
    const first = Core.consolidateProjection(projection, { steamId: STEAM_A });
    Assert.equal(first.identity.name, 'First Name');
    person.names = [{ name: 'Second Name', caseFidelity: true, verified: true, steamStatus: 'current' }];
    const second = Core.consolidateProjection(projection, { steamId: STEAM_A });
    Assert.equal(second.identity.name, 'Second Name');
    Assert.equal(displayNameCalls, 2);
});
