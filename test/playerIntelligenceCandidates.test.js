'use strict';

const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence');
const Runtime = require('../src/plugins/playerIntelligence/runtime.js');

const STEAM_A = '76561197975819827';
const STEAM_B = '76561198036538266';
const STEAM_LIVE = '76561198154738095';
const SCOPE = Object.freeze({
    guildId: 'guild', serverKey: 'battlemetrics:42', wipeId: 'wipe:2026-09-29T14:00:00.000Z'
});

function identity(subject, sourceEventId, caseFidelity = true, source = 'test') {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_observed',
        observedAt: '2026-10-01T10:00:00.000Z',
        recordedAt: '2026-10-01T10:00:00.000Z',
        scope: SCOPE,
        subject,
        payload: { caseFidelity },
        provenance: { source, sourceEventId, collectorVersion: 'test-1' },
        confidence: caseFidelity ? 'verified' : 'untrusted',
        evidence: null
    });
}

function supersede(event) {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'events_superseded',
        observedAt: '2026-10-01T10:01:00.000Z',
        recordedAt: '2026-10-01T10:01:00.000Z',
        scope: SCOPE,
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: null },
        payload: { eventIds: [event.eventId], reason: 'test replacement' },
        provenance: { source: 'test', sourceEventId: `supersede-${event.eventId}`,
            collectorVersion: 'test-1' },
        confidence: 'verified',
        evidence: null
    });
}

function clanSnapshot() {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'clan_snapshot',
        observedAt: '2026-10-01T10:02:00.000Z',
        recordedAt: '2026-10-01T10:02:00.000Z',
        scope: SCOPE,
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: null },
        payload: {
            tag: 'TAG', establishedAt: '2026-09-30T18:00:00.000Z', complete: true,
            declaredMemberCount: 2,
            members: [
                { name: 'Current A', steamId: STEAM_A, battlemetricsPlayerId: '201', role: 'leader' },
                { name: 'Collision', steamId: STEAM_B, battlemetricsPlayerId: '202', role: 'member' }
            ]
        },
        provenance: { source: 'test', sourceEventId: 'clan-tag', collectorVersion: 'test-1' },
        confidence: 'verified',
        evidence: { hash: 'a'.repeat(64), reference: null, expiresAt: null }
    });
}

function harness(t) {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-player-candidates-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const trackerPlayer = { playerId: '303', steamId: STEAM_LIVE, name: 'Live First' };
    const battlemetricsPlayer = { id: '303', steamId: STEAM_LIVE, name: 'Live First', status: true };
    const teamPlayer = { steamId: STEAM_LIVE, name: 'Team First' };
    const instance = {
        activeServer: 'server',
        serverList: { server: { battlemetricsId: '42' } },
        trackers: {
            tracker: { managedBy: 'player-tracker', serverId: 'server', battlemetricsId: '42',
                players: [trackerPlayer] }
        }
    };
    const battlemetrics = { players: { 303: battlemetricsPlayer } };
    const rustplus = { serverId: 'server', team: { players: [teamPlayer] } };
    const client = {
        getInstance: () => instance,
        battlemetricsInstances: { 42: battlemetrics },
        playerIntelligenceDependencies: { dataDirectory: directory }
    };
    return {
        context: { client, guildId: 'guild', rustplus },
        store: new Core.JsonlHistoryStore({ directory: Path.join(directory, 'guild', '42') }),
        trackerPlayer,
        battlemetricsPlayer,
        teamPlayer
    };
}

Test('identity candidates aggregate duplicates while preserving fidelity, tags, collisions and live inputs',
    async t => {
        const value = harness(t);
        const duplicateEvents = Array.from({ length: 1500 }, (_unused, index) => identity({
            steamId: STEAM_A, battlemetricsPlayerId: '201', exactName: 'Repeated Alias'
        }, `duplicate-${index}`, index % 2 === 0));
        const bad = identity({ steamId: STEAM_A, battlemetricsPlayerId: null, exactName: 'Superseded OCR' },
            'bad-ocr', false, 'discord-f7');
        await value.store.appendMany([
            identity({ steamId: STEAM_A, battlemetricsPlayerId: '201', exactName: 'Current A' },
                'current-a', true, 'steam-profile-current'),
            identity({ steamId: STEAM_A, battlemetricsPlayerId: null, exactName: 'Past A' },
                'past-a', true, 'steam-profile-alias-history'),
            identity({ steamId: null, battlemetricsPlayerId: '404', exactName: 'Pending BM' },
                'pending-bm', false, 'discord-cinfo'),
            identity({ steamId: STEAM_A, battlemetricsPlayerId: '201', exactName: 'Collision' }, 'collision-a'),
            identity({ steamId: STEAM_B, battlemetricsPlayerId: '202', exactName: 'Collision' }, 'collision-b'),
            ...duplicateEvents,
            bad,
            supersede(bad),
            clanSnapshot()
        ]);

        const candidates = await Runtime.identityCandidates(value.context);
        const repeated = candidates.filter(candidate => candidate.name === 'Repeated Alias');
        Assert.equal(repeated.length, 1);
        Assert.equal(repeated[0].caseFidelity, true);
        Assert.deepEqual(repeated[0].knownClanTags, ['tag']);
        Assert.equal(candidates.some(candidate => candidate.name === 'Current A'), true);
        Assert.equal(candidates.some(candidate => candidate.name === 'Past A'), true);
        const pending = candidates.find(candidate => candidate.name === 'Pending BM');
        Assert.equal(pending.steamId, null);
        Assert.equal(pending.battlemetricsPlayerId, '404');
        Assert.equal(pending.caseFidelity, false);
        Assert.equal(candidates.filter(candidate => candidate.name === 'Collision').length, 2);
        Assert.equal(candidates.some(candidate => candidate.name === 'Superseded OCR'), false);
        Assert.equal(candidates.some(candidate => candidate.name === 'Live First'), true);
        Assert.equal(candidates.some(candidate => candidate.name === 'Team First'), true);

        value.trackerPlayer.name = 'Live Second';
        value.battlemetricsPlayer.name = 'Live Second';
        value.teamPlayer.name = 'Team Second';
        const refreshed = await Runtime.identityCandidates(value.context);
        Assert.equal(refreshed.some(candidate => candidate.name === 'Live First'), false);
        Assert.equal(refreshed.some(candidate => candidate.name === 'Team First'), false);
        Assert.equal(refreshed.some(candidate => candidate.name === 'Live Second'), true);
        Assert.equal(refreshed.some(candidate => candidate.name === 'Team Second'), true);
    });

Test('effective event snapshots and targeted clan tags are cached without changing affinity', () => {
    const identityEvent = identity({
        steamId: STEAM_A, battlemetricsPlayerId: '201', exactName: 'Current A'
    }, 'cache-current');
    const events = Object.freeze([identityEvent, clanSnapshot()]);
    Assert.strictEqual(Core.createEvent(identityEvent), identityEvent);
    Assert.throws(() => Core.createEvent(Object.freeze({
        ...identityEvent, eventId: `pi:${'0'.repeat(64)}`
    })), /eventId does not match/u);
    const firstEffective = Core.effectiveEvents(events);
    const secondEffective = Core.effectiveEvents(events);
    Assert.strictEqual(secondEffective, firstEffective);
    const projection = Core.rebuild(events);
    const subject = { steamId: STEAM_A, battlemetricsPlayerId: '201', exactName: 'Current A' };
    Assert.deepEqual(projection.clans.getKnownTags(subject), projection.clans.getAffinity(subject).knownTags);
});

Test('appending a supersession creates and applies a new effective event snapshot', async t => {
    const value = harness(t);
    const stale = identity({ steamId: STEAM_A, battlemetricsPlayerId: null, exactName: 'Stale OCR' },
        'append-stale', false, 'discord-f7');
    await value.store.append(stale);
    const beforeEvents = await value.store.readAll();
    const beforeEffective = Core.effectiveEvents(beforeEvents);
    Assert.equal(beforeEffective.some(event => event.eventId === stale.eventId), true);

    await value.store.append(supersede(stale));
    const afterEvents = await value.store.readAll();
    const afterEffective = Core.effectiveEvents(afterEvents);
    Assert.notStrictEqual(afterEvents, beforeEvents);
    Assert.notStrictEqual(afterEffective, beforeEffective);
    Assert.equal(afterEffective.some(event => event.eventId === stale.eventId), false);
    Assert.strictEqual(Core.effectiveEvents(afterEvents), afterEffective);
});
