'use strict';

const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const PlayerIntelligence = require('../src/plugins/playerIntelligence');

const STEAM_A = '76561197975819827';
const STEAM_B = '76561198154738095';
let sourceSequence = 0;

function event(kind, overrides = {}) {
    sourceSequence += 1;
    return PlayerIntelligence.createEvent({
        schemaVersion: 1,
        kind,
        observedAt: overrides.observedAt || '2026-09-30T12:00:00.000Z',
        recordedAt: overrides.recordedAt || overrides.observedAt || '2026-09-30T12:00:00.000Z',
        scope: overrides.scope || { guildId: 'guild', serverKey: 'warbandits-main', wipeId: 'wipe-1' },
        subject: overrides.subject || { steamId: STEAM_A, battlemetricsPlayerId: null, exactName: 'Alice' },
        payload: overrides.payload || { caseFidelity: true },
        provenance: overrides.provenance || {
            source: 'test', sourceEventId: `${kind}-${sourceSequence}`, collectorVersion: 'test-1'
        },
        confidence: overrides.confidence || 'verified',
        evidence: Object.hasOwn(overrides, 'evidence') ? overrides.evidence : null
    });
}

function identity(options = {}) {
    return event('identity_observed', {
        ...options,
        payload: { caseFidelity: Object.hasOwn(options, 'caseFidelity') ? options.caseFidelity : true }
    });
}

function clanSnapshot(options = {}) {
    return event('clan_snapshot', {
        observedAt: options.observedAt,
        scope: { guildId: 'guild', serverKey: 'warbandits-main', wipeId: options.wipeId || 'wipe-1' },
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: null },
        payload: {
            tag: options.tag || 'BEHO',
            establishedAt: options.establishedAt || '2026-09-29T16:02:03.000Z',
            complete: true,
            declaredMemberCount: 2,
            members: options.members || [
                { name: 'Alice', steamId: STEAM_A, battlemetricsPlayerId: null, role: 'leader' },
                { name: 'Bob', steamId: STEAM_B, battlemetricsPlayerId: null, role: 'member' }
            ]
        },
        confidence: options.confidence || 'verified',
        evidence: { hash: options.hash || 'a'.repeat(64), reference: null, expiresAt: null },
        provenance: {
            source: options.source || 'warbandits-command',
            sourceEventId: options.sourceEventId || `clan-${++sourceSequence}`,
            collectorVersion: 'test-1'
        }
    });
}

Test('contracts reject unsupported input and return deeply immutable events', () => {
    const created = identity();
    Assert.equal(Object.isFrozen(created), true);
    Assert.equal(Object.isFrozen(created.scope), true);
    Assert.throws(() => { created.scope.serverKey = 'changed'; }, TypeError);
    Assert.throws(() => PlayerIntelligence.createEvent({ ...created, unexpected: true }), TypeError);
    Assert.throws(() => identity({
        subject: { steamId: '42', battlemetricsPlayerId: null, exactName: 'Alice' }
    }), /SteamID64/u);
    Assert.throws(() => identity({ observedAt: '2026-09-30T12:00:00Z' }), /canonical/u);
    Assert.throws(() => event('clan_snapshot', {
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: null },
        payload: {
            tag: 'BAD', establishedAt: '2026-09-29T16:02:03.000Z', complete: true,
            declaredMemberCount: 1, members: [],
            unresolvedMembers: [{
                observedText: 'Alice', role: 'member',
                candidates: [{ name: 'Alice', steamId: STEAM_A,
                    battlemetricsPlayerId: null, score: 1 }]
            }]
        }
    }), /complete clan_snapshot/u);
});

Test('JSONL history serializes concurrent appends, deduplicates and detects corruption', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-player-intelligence-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const firstStore = new PlayerIntelligence.JsonlHistoryStore({ directory });
    const secondStore = new PlayerIntelligence.JsonlHistoryStore({ directory });
    const events = Array.from({ length: 16 }, (_, index) => identity({
        observedAt: `2026-09-30T12:00:${String(index).padStart(2, '0')}.000Z`,
        subject: { steamId: STEAM_A, battlemetricsPlayerId: String(1000 + index), exactName: `Alice-${index}` }
    }));

    const results = await Promise.all(events.map((item, index) =>
        (index % 2 === 0 ? firstStore : secondStore).append(item)));
    Assert.equal(results.every(result => result.appended), true);
    Assert.equal((await secondStore.append(events[0])).appended, false);

    const shard = Path.join(directory, '2026-09.jsonl');
    const lines = Fs.readFileSync(shard, 'utf8').trimEnd().split('\n');
    Assert.equal(lines.length, events.length);
    lines.forEach(line => Assert.doesNotThrow(() => JSON.parse(line)));
    Assert.deepEqual((await new PlayerIntelligence.JsonlHistoryStore({ directory }).readAll())
        .map(item => item.eventId).sort(), events.map(item => item.eventId).sort());

    const cachedEvents = await firstStore.readAll();
    Assert.strictEqual(await secondStore.readAll(), cachedEvents);
    const cachedProjection = PlayerIntelligence.rebuild(cachedEvents);
    Assert.strictEqual(PlayerIntelligence.rebuild(await firstStore.readAll()), cachedProjection);
    const added = identity({ observedAt: '2026-09-30T12:01:00.000Z' });
    Assert.equal((await secondStore.append(added)).appended, true);
    const updatedEvents = await firstStore.readAll();
    Assert.notStrictEqual(updatedEvents, cachedEvents);
    Assert.equal(updatedEvents.length, cachedEvents.length + 1);
    Assert.notStrictEqual(PlayerIntelligence.rebuild(updatedEvents), cachedProjection);

    Fs.appendFileSync(shard, '{broken\n', 'utf8');
    const preserved = Fs.readFileSync(shard, 'utf8');
    await Assert.rejects(() => firstStore.readAll(), PlayerIntelligence.HistoryCorruptionError);
    Assert.equal(Fs.readFileSync(shard, 'utf8'), preserved);
    await Assert.rejects(() => firstStore.append(identity()), PlayerIntelligence.HistoryCorruptionError);
});

Test('identity projection joins stable IDs and keeps name-only links reversible', () => {
    const base = [
        identity({
            observedAt: '2026-09-30T10:00:00.000Z',
            subject: { steamId: null, battlemetricsPlayerId: '101', exactName: 'Alice' }
        }),
        identity({
            observedAt: '2026-09-30T10:01:00.000Z',
            subject: { steamId: STEAM_A, battlemetricsPlayerId: '101', exactName: 'Alice' }
        })
    ];
    const first = PlayerIntelligence.rebuild(base).identities;
    Assert.deepEqual(first.findByIdentifier(STEAM_A).map(person => person.personId), [`steam:${STEAM_A}`]);
    Assert.deepEqual(first.findByIdentifier('101').map(person => person.personId), [`steam:${STEAM_A}`]);
    Assert.deepEqual(first.findByExactName('ALICE').map(person => person.personId), [`steam:${STEAM_A}`]);
    Assert.equal(first.getPerson(`steam:${STEAM_A}`).steamId, STEAM_A);
    Assert.equal(first.resolveSubject({ steamId: null, battlemetricsPlayerId: '101', exactName: null }).personId,
        `steam:${STEAM_A}`);
    Assert.deepEqual(first.resolveSubject({ steamId: null, battlemetricsPlayerId: null, exactName: 'ALICE' }), {
        personId: `steam:${STEAM_A}`, confidence: 'probable', ambiguous: false
    });
    const lowFidelity = identity({
        observedAt: '2026-09-30T10:01:30.000Z', caseFidelity: false,
        subject: { steamId: STEAM_A, battlemetricsPlayerId: null, exactName: 'ALICE FROM F7' }
    });
    Assert.equal(PlayerIntelligence.rebuild([...base, lowFidelity]).identities.persons[0].names
        .some(alias => alias.name === 'ALICE FROM F7'), false);

    const collision = identity({
        observedAt: '2026-09-30T10:02:00.000Z',
        subject: { steamId: STEAM_B, battlemetricsPlayerId: null, exactName: 'Alice' }
    });
    Assert.equal(PlayerIntelligence.rebuild([...base, collision]).identities.resolveSubject({
        steamId: null, battlemetricsPlayerId: null, exactName: 'alice'
    }).ambiguous, true);

    const link = event('identity_linked', {
        observedAt: '2026-09-30T10:03:00.000Z',
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: 'Alice' },
        payload: {
            linkId: 'manual-alice-a', targetSteamId: STEAM_A,
            targetBattlemetricsPlayerId: null, reason: 'operator confirmation'
        }
    });
    const linked = PlayerIntelligence.rebuild([...base, collision, link]).identities;
    Assert.deepEqual(linked.resolveSubject({ steamId: null, battlemetricsPlayerId: null, exactName: 'Alice' }), {
        personId: `steam:${STEAM_A}`, confidence: 'verified', ambiguous: false
    });

    const revoke = event('identity_link_revoked', {
        observedAt: '2026-09-30T10:04:00.000Z',
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: 'Alice' },
        payload: { linkId: 'manual-alice-a', reason: 'operator correction' }
    });
    const revoked = PlayerIntelligence.rebuild([...base, collision, link, revoke]).identities;
    Assert.equal(revoked.activeLinks.length, 0);
    Assert.equal(revoked.resolveSubject({
        steamId: null, battlemetricsPlayerId: null, exactName: 'Alice'
    }).personId.startsWith('name:'), true);
});

Test('clan affinities count only distinct confirmed snapshots across wipes', () => {
    const identities = [
        identity({ subject: { steamId: STEAM_A, battlemetricsPlayerId: null, exactName: 'Alice' } }),
        identity({ subject: { steamId: STEAM_B, battlemetricsPlayerId: null, exactName: 'Bob' } })
    ];
    const observations = [
        clanSnapshot({ hash: 'a'.repeat(64), sourceEventId: 'a-1' }),
        clanSnapshot({ hash: 'a'.repeat(64), source: 'discord-reimport',
            sourceEventId: 'a-duplicate', observedAt: '2026-09-30T12:01:00.000Z' }),
        clanSnapshot({ hash: 'b'.repeat(64), sourceEventId: 'b-1', observedAt: '2026-09-30T12:02:00.000Z' }),
        clanSnapshot({ hash: 'c'.repeat(64), sourceEventId: 'c-1', wipeId: 'wipe-2', observedAt: '2026-10-01T12:00:00.000Z' }),
        clanSnapshot({ hash: 'd'.repeat(64), sourceEventId: 'd-unconfirmed',
            confidence: 'probable', observedAt: '2026-10-01T12:01:00.000Z' })
    ];
    const projection = PlayerIntelligence.rebuild([...identities, ...observations]).clans;
    const affinity = projection.getAffinity({ steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null });

    Assert.deepEqual(affinity.knownTags, [{ tag: 'BEHO', count: 3 }]);
    Assert.deepEqual(affinity.playedWith, [{ personId: `steam:${STEAM_B}`, name: 'Bob', count: 3 }]);
    Assert.deepEqual(projection.tags, [{
        tag: 'BEHO', wipeIds: ['wipe-1', 'wipe-2'], wipeCount: 2, snapshotCount: 3, memberCount: 2
    }]);
    Assert.equal(projection.snapshots.filter(snapshot => snapshot.duplicate).length, 1);
    Assert.equal(projection.snapshots.filter(snapshot => snapshot.confirmed).length, 4);
    Assert.equal(projection.snapshots[0].members[0].role, 'leader');
});

Test('partial clan snapshots resolve automatically from later stable aliases', () => {
    const alice = identity({
        observedAt: '2026-09-30T10:00:00.000Z',
        subject: { steamId: STEAM_A, battlemetricsPlayerId: null, exactName: 'Alice' }
    });
    const partial = event('clan_snapshot', {
        observedAt: '2026-09-30T10:01:00.000Z',
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: null },
        payload: {
            tag: 'TEST', establishedAt: '2026-09-29T16:02:03.000Z', complete: false,
            declaredMemberCount: 2,
            members: [
                { name: 'Alice', steamId: STEAM_A, battlemetricsPlayerId: null, role: 'leader' }
            ],
            unresolvedMembers: [
                { observedText: 'D E U S L R A', role: 'member', candidates: [] }
            ]
        },
        evidence: { hash: 'e'.repeat(64), reference: null, expiresAt: null }
    });
    const before = PlayerIntelligence.rebuild([alice, partial]);
    Assert.equal(before.clans.snapshots[0].complete, false);
    Assert.equal(before.clans.snapshots[0].members.length, 1);
    Assert.equal(before.clans.snapshots[0].unresolvedMembers.length, 1);
    Assert.deepEqual(before.clans.getAffinity({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    }).playedWith, []);

    const laterAlias = identity({
        observedAt: '2026-09-30T11:00:00.000Z',
        subject: { steamId: STEAM_B, battlemetricsPlayerId: '202', exactName: 'DEUSLRA' }
    });
    const after = PlayerIntelligence.rebuild([alice, partial, laterAlias]);
    Assert.equal(after.clans.snapshots[0].complete, true);
    Assert.equal(after.clans.snapshots[0].members.length, 2);
    Assert.equal(after.clans.snapshots[0].unresolvedMembers.length, 0);
    Assert.deepEqual(after.clans.getAffinity({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    }).playedWith, [{ personId: `steam:${STEAM_B}`, name: 'DEUSLRA', count: 1 }]);
});

Test('presence keeps outages unknown and closes sessions only on explicit offline evidence', () => {
    const subject = { steamId: STEAM_A, battlemetricsPlayerId: null, exactName: 'Alice' };
    const presence = (state, observedAt, source, reason = null) => event('presence_observed', {
        observedAt,
        subject,
        payload: { state, providerSessionId: 'session-1', reason },
        provenance: { source, sourceEventId: `${source}-${observedAt}`, collectorVersion: 'test-1' }
    });
    const events = [
        identity({ subject }),
        presence('online', '2026-09-30T10:00:00.000Z', 'battlemetrics'),
        presence('unknown', '2026-09-30T10:05:00.000Z', 'battlemetrics', 'provider outage'),
        presence('online', '2026-09-30T10:10:00.000Z', 'battlemetrics'),
        presence('offline', '2026-09-30T10:20:00.000Z', 'battlemetrics'),
        presence('online', '2026-09-30T10:25:00.000Z', 'rustplus')
    ];
    const projection = PlayerIntelligence.rebuild(events).presence;
    const battlemetrics = projection.providers.find(provider => provider.source === 'battlemetrics');
    Assert.equal(battlemetrics.sessions.length, 1);
    Assert.equal(battlemetrics.sessions[0].endedAt, '2026-09-30T10:20:00.000Z');
    Assert.equal(battlemetrics.sessions[0].preciseEnd, false);
    Assert.equal(battlemetrics.segments.some(segment => segment.state === 'unknown'), true);
    Assert.equal(projection.getStatus(subject, 'warbandits-main').state, 'online');

    const unknownOnly = PlayerIntelligence.rebuild([
        identity({ subject }), presence('unknown', '2026-09-30T11:00:00.000Z', 'battlemetrics', 'timeout')
    ]).presence;
    Assert.equal(unknownOnly.getStatus(subject, 'warbandits-main').state, 'unknown');
    Assert.equal(unknownOnly.providers[0].sessions.length, 0);
});

Test('wipe snapshots and every projection are reconstructible from persisted events', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-player-intelligence-rebuild-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const store = new PlayerIntelligence.JsonlHistoryStore({ directory });
    const events = [
        identity(),
        clanSnapshot(),
        event('wipe_snapshot', {
            scope: { guildId: 'guild', serverKey: 'warbandits-main', wipeId: 'wipe-1' },
            subject: { steamId: null, battlemetricsPlayerId: null, exactName: null },
            payload: { startsAt: '2026-09-25T18:00:00.000Z', endsAt: null },
            confidence: 'authoritative'
        })
    ];
    for (const item of events) await store.append(item);

    const before = PlayerIntelligence.rebuild(events);
    const after = PlayerIntelligence.rebuild(await store.readAll());
    Assert.deepEqual(after.identities.persons, before.identities.persons);
    Assert.deepEqual(after.clans.snapshots, before.clans.snapshots);
    Assert.deepEqual(after.presence.providers, before.presence.providers);
    Assert.deepEqual(after.wipes.snapshots, before.wipes.snapshots);
    Assert.equal(after.wipes.snapshots[0].startsAt, '2026-09-25T18:00:00.000Z');
});
