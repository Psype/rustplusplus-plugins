'use strict';

const Assert = require('node:assert/strict');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence');

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
