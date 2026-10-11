const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence');
const Runtime = require('../src/plugins/playerIntelligence/runtime.js');
const ScanDaemon = require('../src/plugins/playerIntelligence/scanDaemon.js');

const STEAM_A = '76561197975819827';

function harness(t) {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-player-intelligence-runtime-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    let now = new Date('2026-10-01T10:00:00.000Z');
    const instance = {
        activeServer: 'server',
        serverList: { server: { battlemetricsId: '42', title: 'Test' } },
        trackers: {
            1: {
                managedBy: 'player-tracker', serverId: 'server', battlemetricsId: '42',
                players: [{ playerId: '101', steamId: STEAM_A, name: 'Alice' }]
            }
        }
    };
    const battlemetrics = {
        lastUpdateSuccessful: true,
        streamerMode: false,
        updatedAt: now.toISOString(),
        server_rust_last_wipe: '2026-09-29T14:00:00.000Z',
        players: {
            101: { id: '101', name: 'Alice', status: true },
            102: { id: '102', name: 'Bob', status: true }
        },
        onlinePlayers: ['101', '102'],
        newPlayers: ['101', '102'],
        loginPlayers: [], logoutPlayers: [], nameChangedPlayers: []
    };
    const logs = [];
    const client = {
        battlemetricsInstances: { 42: battlemetrics },
        getInstance: () => instance,
        playerIntelligenceDependencies: { dataDirectory: directory, now: () => new Date(now) }
    };
    const rustplus = {
        serverId: 'server', isOperational: true,
        generalSettings: { inGameCommandsEnabled: true },
        log: (...values) => logs.push(values)
    };
    return {
        battlemetrics, client, directory, logs, rustplus,
        context: overrides => ({ client, guildId: 'guild', rustplus, firstTime: false, ...overrides }),
        command: text => ({
            client, rustplus, guildId: 'guild', source: 'inGame', prefix: '!', command: text,
            commandLowerCase: text.toLowerCase()
        }),
        setNow: value => { now = new Date(value); },
        store: () => new Core.JsonlHistoryStore({ directory: Path.join(directory, 'guild', '42') })
    };
}

function captureLocalScans(value) {
    const scheduled = [];
    Object.assign(value.client.playerIntelligenceDependencies, {
        steamProfileIdentity: null,
        battlemetricsProvider: null,
        warBanditsProvider: null,
        playerScanDaemon: { schedule: options => { scheduled.push(options); return true; } }
    });
    return Object.freeze({
        scheduled,
        runNext: async () => {
            const options = scheduled.shift();
            Assert.ok(options, 'a local identity reconciliation scan should be scheduled');
            return ScanDaemon.runCycle(options);
        }
    });
}

Test('historical capture and Tuesday/Friday 14:00 wipe boundaries use GMT', () => {
    Assert.equal(Runtime.parseCaptureTime('2026-09-29 21:15'), '2026-09-29T21:15:00.000Z');
    Assert.equal(Runtime.regularWipeStart('2026-09-29T21:15:00.000Z'), '2026-09-29T14:00:00.000Z');
    Assert.equal(Runtime.regularWipeStart('2026-10-02T13:59:59.000Z'), '2026-09-29T14:00:00.000Z');
    Assert.equal(Runtime.regularWipeStart('2026-10-02T14:00:00.000Z'), '2026-10-02T14:00:00.000Z');
    Assert.equal(Runtime.parseCaptureTime('2026-03-29 02:30'), '2026-03-29T02:30:00.000Z');
    Assert.throws(() => Runtime.parseCaptureTime('2026-02-30T12:00:00+01:00'), /valid calendar/);
});

Test('historical inference ignores forced and observed intermediate wipes', async t => {
    const value = harness(t);
    value.battlemetrics.server_rust_last_wipe = '2026-09-30T18:00:00.000Z';
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    value.battlemetrics.server_rust_last_wipe = '2026-10-02T14:00:00.000Z';
    const historical = await Runtime.resolveHistoricalScope(value.context(), '2026-10-01 10:00');
    Assert.equal(historical.wipeStart, '2026-09-29T14:00:00.000Z');
    Assert.equal(historical.wipeId, 'wipe:2026-09-29T14:00:00.000Z');
    Assert.equal(Runtime.regularWipeStart('2026-10-02T14:00:00.000Z'), '2026-10-02T14:00:00.000Z');
});

Test('existing teammate identity rows are fused read-only without modifying their source', async t => {
    const value = harness(t);
    const scans = captureLocalScans(value);
    const rows = Object.freeze([Object.freeze({
        steamId: '76561198036538266', battlemetricsPlayerId: '777', name: 'Dante',
        observedAt: '2026-09-30T08:00:00.000Z'
    })]);
    value.client.playerIntelligenceDependencies.identityHistory = { getIdentityRows: () => rows };
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    await scans.runNext();
    const projection = Core.rebuild(await value.store().readAll());
    const person = projection.identities.persons.find(item => item.steamId === '76561198036538266');
    Assert.equal(person.battlemetricsPlayerIds.includes('777'), true);
    Assert.equal(person.names[0].name, 'Dante');
    Assert.equal(rows[0].name, 'Dante');
});

Test('BattleMetrics ingestion records initial presence, outage unknown and recovery without false logout', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    const scans = captureLocalScans(value);
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    await scans.runNext();
    let projection = Core.rebuild(await value.store().readAll());
    Assert.equal(projection.presence.getStatus({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    }, 'battlemetrics:42').state, 'online');
    Assert.equal(projection.wipes.snapshots.length, 1);
    Assert.equal(projection.identities.persons.some(person => person.steamId === STEAM_A &&
        person.battlemetricsPlayerIds.includes('101')), true);

    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = false;
    await Runtime.onBattlemetricsUpdated(value.context());
    projection = Core.rebuild(await value.store().readAll());
    Assert.equal(projection.presence.getStatus({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    }, 'battlemetrics:42').state, 'unknown');

    // Recovery must be reconstructible from the journal even after a process restart erased the hook cache.
    Runtime.resetRuntimeCachesForTests();
    value.setNow('2026-10-01T10:02:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = true;
    value.battlemetrics.updatedAt = '2026-10-01T10:02:00.000Z';
    value.battlemetrics.players[102].status = false;
    value.battlemetrics.onlinePlayers = ['101'];
    await Runtime.onBattlemetricsUpdated(value.context());
    projection = Core.rebuild(await value.store().readAll());
    Assert.equal(projection.presence.getStatus({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    }, 'battlemetrics:42').state, 'online');
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '102', exactName: null
    }, 'battlemetrics:42').state, 'offline');
});

Test('quiet BattleMetrics polls still clock the coalesced background player daemon', async t => {
    const value = harness(t);
    const scheduled = [];
    value.client.playerIntelligenceDependencies.playerScanDaemon = {
        schedule: options => { scheduled.push(options); return true; }
    };
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    value.battlemetrics.newPlayers = [];
    await Runtime.onBattlemetricsUpdated(value.context());

    Assert.equal(scheduled.length, 2);
    Assert.equal(scheduled[0].scope.battlemetricsId, '42');
    Assert.equal(scheduled[1].directory, Path.join(value.directory, 'guild', '42'));
});

Test('idle hook fingerprints are bounded, renewed and stay projection-free after expiry', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    value.client.playerIntelligenceDependencies.playerScanDaemon = { schedule: () => true };
    const store = value.store();
    let reads = 0;
    value.client.playerIntelligenceDependencies.store = {
        directory: store.directory,
        readAll: async () => {
            reads += 1;
            return store.readAll();
        },
        appendMany: events => store.appendMany(events)
    };

    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    const initialCount = (await store.readAll()).length;
    Assert.equal(reads, 0);
    value.battlemetrics.newPlayers = [];

    value.setNow('2026-10-02T09:00:00.000Z');
    await Runtime.onBattlemetricsUpdated(value.context());
    Assert.equal(reads, 0);
    value.setNow('2026-10-03T08:00:00.000Z');
    await Runtime.onBattlemetricsUpdated(value.context());
    Assert.equal(reads, 0);

    value.setNow('2026-10-04T09:00:00.000Z');
    await Runtime.onBattlemetricsUpdated(value.context());
    Assert.equal(reads, 0);
    Assert.equal((await store.readAll()).length, initialCount);
    Assert.deepEqual(Runtime.getRuntimeCacheStatus(new Date('2026-10-04T09:00:00.000Z').getTime()), {
        hookStates: 1,
        hookStateLimit: 32
    });
});

Test('stale non-empty BattleMetrics deltas are idempotent while snapshot changes still emit transitions', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    const store = value.store();
    value.client.playerIntelligenceDependencies.store = {
        directory: store.directory,
        readAll: async () => { throw new Error('poll ingestion must not rebuild the journal'); },
        appendMany: events => store.appendMany(events)
    };

    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    const initialEvents = await store.readAll();

    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T10:01:00.000Z';
    await Runtime.onBattlemetricsUpdated(value.context());
    Assert.equal((await store.readAll()).length, initialEvents.length);

    value.setNow('2026-10-01T10:02:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T10:02:00.000Z';
    value.battlemetrics.players[102].status = false;
    value.battlemetrics.onlinePlayers = ['101'];
    await Runtime.onBattlemetricsUpdated(value.context());

    const projection = Core.rebuild(await store.readAll());
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '102', exactName: null
    }, 'battlemetrics:42').state, 'offline');
    Assert.equal((await store.readAll()).filter(event => event.kind === 'presence_observed' &&
        event.subject.battlemetricsPlayerId === '102' && event.payload.state === 'offline').length, 1);
});

Test('a wipe change resets the roster without duplicating stable identity aliases', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    value.client.playerIntelligenceDependencies.playerScanDaemon = { schedule: () => true };
    value.setNow('2026-10-02T13:59:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-02T13:59:00.000Z';
    value.client.playerIntelligenceDependencies.identityHistory = {
        getIdentityRows: () => [{
            steamId: '76561198036538266', battlemetricsPlayerId: '777', name: 'Dante',
            observedAt: '2026-09-30T08:00:00.000Z'
        }]
    };
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    const initialEvents = await value.store().readAll();
    const initialTrackerAliases = initialEvents.filter(event =>
        event.provenance.source === 'player-tracker');
    const initialLegacyAliases = initialEvents.filter(event =>
        event.provenance.source === 'teammate-language-database');
    Assert.equal(initialTrackerAliases.length, 1);
    Assert.equal(initialLegacyAliases.length, 1);
    Assert.equal(initialLegacyAliases[0].scope.wipeId, null);

    value.setNow('2026-10-02T14:01:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-02T14:01:00.000Z';
    value.battlemetrics.server_rust_last_wipe = '2026-10-02T14:00:00.000Z';
    value.battlemetrics.players[102].status = false;
    value.battlemetrics.onlinePlayers = ['101'];
    value.battlemetrics.newPlayers = [];
    await Runtime.onBattlemetricsUpdated(value.context());

    const events = await value.store().readAll();
    const newWipe = 'wipe:2026-10-02T14:00:00.000Z';
    Assert.deepEqual(events.filter(event => event.provenance.source === 'player-tracker')
        .map(event => event.eventId), initialTrackerAliases.map(event => event.eventId));
    Assert.deepEqual(events.filter(event => event.provenance.source === 'teammate-language-database')
        .map(event => event.eventId), initialLegacyAliases.map(event => event.eventId));
    Assert.equal(events.some(event => event.scope.wipeId === newWipe &&
        ['player-tracker', 'teammate-language-database'].includes(event.provenance.source)), false);
    Assert.equal(events.some(event => event.scope.wipeId === newWipe && event.kind === 'wipe_snapshot'), true);
    Assert.equal(events.some(event => event.scope.wipeId === newWipe &&
        event.kind === 'presence_observed' && event.subject.battlemetricsPlayerId === '102' &&
        event.payload.state === 'offline'), false);
    Assert.equal(events.some(event => event.scope.wipeId === newWipe &&
        event.kind === 'presence_observed' && event.subject.battlemetricsPlayerId === '101' &&
        event.payload.state === 'online'), true);
    Assert.equal(Core.rebuild(events).presence.getStatus({
        steamId: null, battlemetricsPlayerId: '102', exactName: null
    }, 'battlemetrics:42').state, 'offline');
});

Test('availability mode keeps same-timestamp incomplete and failed transitions distinct', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    const transitionAt = '2026-10-01T10:01:00.000Z';
    value.setNow(transitionAt);
    value.battlemetrics.updatedAt = transitionAt;
    value.battlemetrics.onlinePlayers = ['101', 'not-a-player-id'];
    await Runtime.onBattlemetricsUpdated(value.context());

    value.battlemetrics.lastUpdateSuccessful = false;
    await Runtime.onBattlemetricsUpdated(value.context());

    const transitions = (await value.store().readAll()).filter(event =>
        event.kind === 'provider_availability_observed' && event.observedAt === transitionAt &&
        event.payload.state === 'unavailable');
    Assert.equal(transitions.length, 2);
    Assert.equal(transitions.some(event => event.provenance.sourceEventId
        .startsWith(`unavailable:failed:${transitionAt}:`)), true);
    Assert.equal(transitions.some(event => event.provenance.sourceEventId
        .startsWith(`unavailable:incomplete:${transitionAt}:`)), true);
    Assert.equal(new Set(transitions.map(event => event.eventId)).size, 2);
    Assert.deepEqual(transitions.map(event => event.payload.reason).sort(), [
        'provider online snapshot incomplete',
        'provider update failed'
    ]);
});

Test('successive incomplete BattleMetrics rosters append only membership and name deltas', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    value.client.playerIntelligenceDependencies.playerScanDaemon = { schedule: () => true };
    value.battlemetrics.onlinePlayers = ['101', 'invalid-player-id'];
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    let events = await value.store().readAll();
    const unavailableIndex = events.findIndex(event => event.kind === 'provider_availability_observed' &&
        event.payload.state === 'unavailable');
    const firstPositiveIndex = events.findIndex(event => event.kind === 'presence_observed' &&
        event.subject.battlemetricsPlayerId === '101' && event.payload.state === 'online');
    Assert.equal(unavailableIndex >= 0 && firstPositiveIndex > unavailableIndex, true);

    const beforeMembershipDelta = events.length;
    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T10:01:00.000Z';
    value.battlemetrics.onlinePlayers = ['102', 'invalid-player-id'];
    value.battlemetrics.newPlayers = [];
    await Runtime.onBattlemetricsUpdated(value.context());

    events = await value.store().readAll();
    const membershipDelta = events.slice(beforeMembershipDelta);
    Assert.deepEqual(membershipDelta.map(event => [
        event.kind,
        event.subject.battlemetricsPlayerId,
        event.kind === 'presence_observed' ? event.payload.state : null
    ]), [
        ['presence_observed', '101', 'unknown'],
        ['identity_observed', '102', null],
        ['presence_observed', '102', 'online']
    ]);
    Assert.equal(membershipDelta.some(event => event.kind === 'provider_availability_observed'), false);

    const beforeNameDelta = events.length;
    value.setNow('2026-10-01T10:02:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T10:02:00.000Z';
    value.battlemetrics.players[102].name = 'Bob Renamed';
    await Runtime.onBattlemetricsUpdated(value.context());

    events = await value.store().readAll();
    const nameDelta = events.slice(beforeNameDelta);
    Assert.deepEqual(nameDelta.map(event => [event.kind, event.subject.battlemetricsPlayerId,
        event.subject.exactName]), [['identity_observed', '102', 'Bob Renamed']]);
});

Test('failed and censored recoveries use a causal local time when provider time is stale', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    value.client.playerIntelligenceDependencies.playerScanDaemon = { schedule: () => true };
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = false;
    await Runtime.onBattlemetricsUpdated(value.context());
    value.setNow('2026-10-01T10:02:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = true;
    await Runtime.onBattlemetricsUpdated(value.context());

    value.setNow('2026-10-01T10:03:00.000Z');
    value.battlemetrics.streamerMode = true;
    await Runtime.onBattlemetricsUpdated(value.context());
    value.setNow('2026-10-01T10:04:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T09:59:00.000Z';
    value.battlemetrics.streamerMode = false;
    await Runtime.onBattlemetricsUpdated(value.context());

    const availability = (await value.store().readAll()).filter(event =>
        event.kind === 'provider_availability_observed');
    Assert.deepEqual(availability.map(event => [event.payload.state, event.observedAt]), [
        ['available', '2026-10-01T10:00:00.000Z'],
        ['unavailable', '2026-10-01T10:01:00.000Z'],
        ['available', '2026-10-01T10:02:00.000Z'],
        ['unavailable', '2026-10-01T10:03:00.000Z'],
        ['available', '2026-10-01T10:04:00.000Z']
    ]);
    Assert.equal(availability[2].provenance.sourceEventId
        .startsWith('available:complete:2026-10-01T10:02:00.000Z:'), true);
    Assert.equal(availability[4].provenance.sourceEventId
        .startsWith('available:complete:2026-10-01T10:04:00.000Z:'), true);
});

Test('a cold startup complete sample cannot sort before a durable outage with stale provider time', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    value.client.playerIntelligenceDependencies.playerScanDaemon = { schedule: () => true };
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = false;
    await Runtime.onBattlemetricsUpdated(value.context());

    Runtime.resetRuntimeCachesForTests();
    value.setNow('2026-10-01T10:02:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = true;
    // Simulate BattleMetrics recovering without advancing its last provider timestamp.
    Assert.equal(value.battlemetrics.updatedAt, '2026-10-01T10:00:00.000Z');
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    const events = await value.store().readAll();
    const availability = events.filter(event => event.kind === 'provider_availability_observed');
    Assert.deepEqual(availability.map(event => [event.payload.state, event.observedAt]), [
        ['available', '2026-10-01T10:00:00.000Z'],
        ['unavailable', '2026-10-01T10:01:00.000Z'],
        ['available', '2026-10-01T10:02:00.000Z']
    ]);
    Assert.equal(Core.rebuild(events).presence.getStatus({
        steamId: null, battlemetricsPlayerId: '101', exactName: null
    }, 'battlemetrics:42').state, 'online');
});

Test('stable identity changes during an outage are committed once before recovery', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    value.client.playerIntelligenceDependencies.playerScanDaemon = { schedule: () => true };
    let legacyRows = [{
        steamId: '76561198036538266', battlemetricsPlayerId: '777', name: 'Dante',
        observedAt: '2026-09-30T08:00:00.000Z'
    }];
    value.client.playerIntelligenceDependencies.identityHistory = {
        getIdentityRows: (_scope, options) => legacyRows.slice(0, options.limit)
    };
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = false;
    await Runtime.onBattlemetricsUpdated(value.context());

    value.setNow('2026-10-01T10:02:00.000Z');
    value.client.getInstance().trackers[1].players[0].name = 'Alice During Outage';
    legacyRows = [...legacyRows, {
        steamId: '76561198000000003', battlemetricsPlayerId: '778', name: 'Erin',
        observedAt: '2026-10-01T10:02:00.000Z'
    }];
    await Runtime.onBattlemetricsUpdated(value.context());

    const duringOutage = await value.store().readAll();
    Assert.equal(duringOutage.some(event => event.provenance.source === 'player-tracker' &&
        event.subject.exactName === 'Alice During Outage'), true);
    Assert.equal(duringOutage.some(event => event.provenance.source === 'teammate-language-database' &&
        event.subject.exactName === 'Erin'), true);
    const committedIdentityEventIds = duringOutage.filter(event =>
        ['player-tracker', 'teammate-language-database'].includes(event.provenance.source))
        .map(event => event.eventId);

    value.setNow('2026-10-01T10:03:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T10:03:00.000Z';
    value.battlemetrics.lastUpdateSuccessful = true;
    await Runtime.onBattlemetricsUpdated(value.context());

    const afterRecoveryIdentityEventIds = (await value.store().readAll()).filter(event =>
        ['player-tracker', 'teammate-language-database'].includes(event.provenance.source))
        .map(event => event.eventId);
    Assert.deepEqual(afterRecoveryIdentityEventIds, committedIdentityEventIds);
});

Test('contradictory stale logout deltas cannot override the authoritative online snapshot', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T10:01:00.000Z';
    value.battlemetrics.logoutPlayers = ['101'];
    value.battlemetrics.players[101].status = false;
    // BattleMetrics occasionally leaves stale delta arrays behind; the full roster remains authoritative.
    value.battlemetrics.onlinePlayers = ['101', '102'];
    await Runtime.onBattlemetricsUpdated(value.context());

    const events = await value.store().readAll();
    Assert.equal(events.some(event => event.kind === 'presence_observed' &&
        event.subject.battlemetricsPlayerId === '101' && event.payload.state === 'offline'), false);
    Assert.equal(Core.rebuild(events).presence.getStatus({
        steamId: null, battlemetricsPlayerId: '101', exactName: null
    }, 'battlemetrics:42').state, 'online');
});

Test('changed failed polls emit one outage transition and incomplete rosters never synthesize offline', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = false;
    await Runtime.onBattlemetricsUpdated(value.context());
    value.setNow('2026-10-01T10:02:00.000Z');
    value.battlemetrics.nameChangedPlayers = [{ id: '101' }];
    value.battlemetrics.players[101].name = 'Alice Changed';
    await Runtime.onBattlemetricsUpdated(value.context());

    let events = await value.store().readAll();
    Assert.equal(events.filter(event => event.kind === 'provider_availability_observed' &&
        event.payload.state === 'unavailable').length, 1);

    value.setNow('2026-10-01T10:03:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = true;
    value.battlemetrics.updatedAt = '2026-10-01T10:03:00.000Z';
    value.battlemetrics.onlinePlayers = ['101', 'not-a-player-id'];
    await Runtime.onBattlemetricsUpdated(value.context());
    events = await value.store().readAll();
    const projection = Core.rebuild(events);
    Assert.equal(events.some(event => event.kind === 'presence_observed' &&
        event.subject.battlemetricsPlayerId === '102' && event.payload.state === 'offline'), false);
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '102', exactName: null
    }, 'battlemetrics:42').state, 'unknown');
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '101', exactName: null
    }, 'battlemetrics:42').state, 'online');
});

Test('an incomplete roster followed by a complete roster at the same provider time closes absent players', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    value.client.playerIntelligenceDependencies.playerScanDaemon = { schedule: () => true };
    const providerTime = value.battlemetrics.updatedAt;
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.onlinePlayers = ['101', 'invalid-player-id'];
    await Runtime.onBattlemetricsUpdated(value.context());
    let events = await value.store().readAll();
    let projection = Core.rebuild(events);
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '101', exactName: null
    }, 'battlemetrics:42').state, 'online');
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '102', exactName: null
    }, 'battlemetrics:42').state, 'unknown');

    value.setNow('2026-10-01T10:02:00.000Z');
    value.battlemetrics.onlinePlayers = ['101'];
    value.battlemetrics.players[102].status = false;
    value.battlemetrics.newPlayers = [];
    await Runtime.onBattlemetricsUpdated(value.context());

    events = await value.store().readAll();
    projection = Core.rebuild(events);
    Assert.equal(value.battlemetrics.updatedAt, providerTime);
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '101', exactName: null
    }, 'battlemetrics:42').state, 'online');
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '102', exactName: null
    }, 'battlemetrics:42').state, 'offline');
    const alice = projection.presence.providers.find(provider =>
        provider.personId === 'battlemetrics:101' && provider.source === 'battlemetrics');
    const bob = projection.presence.providers.find(provider =>
        provider.personId === 'battlemetrics:102' && provider.source === 'battlemetrics');
    Assert.deepEqual(alice.transitions.map(transition => transition.state), ['online']);
    Assert.equal(alice.sessions.length, 1);
    Assert.equal(alice.sessions[0].uncertainFrom, null);
    Assert.equal(alice.sessions[0].endedAt, null);
    Assert.deepEqual(bob.transitions.map(transition => transition.state), ['online', 'unknown', 'offline']);
    Assert.equal(bob.sessions[0].preciseEnd, false);
    Assert.equal(events.filter(event => event.kind === 'provider_availability_observed').length, 3);
    const aliceSamples = events.filter(event => event.kind === 'presence_observed' &&
        event.subject.battlemetricsPlayerId === '101' && event.observedAt === providerTime);
    Assert.equal(aliceSamples.length, 3);
    Assert.equal(new Set(aliceSamples.map(event => event.eventId)).size, 3);
});

Test('an interrupted chunked recovery cannot persist a false global offline boundary', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    value.client.playerIntelligenceDependencies.playerScanDaemon = { schedule: () => true };
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = false;
    await Runtime.onBattlemetricsUpdated(value.context());

    const legacyRows = Array.from({ length: Runtime.MAX_STABLE_IDENTITY_CANDIDATES + 100 },
        (_unused, index) => ({
        steamId: `${76561198000010000n + BigInt(index)}`,
        battlemetricsPlayerId: null,
        name: `Durable Legacy ${index}`,
        observedAt: '2026-09-30T08:00:00.000Z'
    }));
    value.client.playerIntelligenceDependencies.identityHistory = {
        getIdentityRows: (_scope, options) => legacyRows.slice(0, options.limit)
    };
    value.setNow('2026-10-01T10:02:00.000Z');
    value.battlemetrics.lastUpdateSuccessful = true;
    value.battlemetrics.updatedAt = '2026-10-01T10:02:00.000Z';
    value.battlemetrics.onlinePlayers = ['101'];
    value.battlemetrics.players[102].status = false;
    for (let index = 0; index < 1500; index += 1) {
        const id = `${1000 + index}`;
        value.battlemetrics.players[id] = { id, name: `Recovery Player ${index}`, status: true };
        value.battlemetrics.onlinePlayers.push(id);
    }

    const durableStore = value.store();
    let batches = 0;
    value.client.playerIntelligenceDependencies.store = {
        directory: durableStore.directory,
        appendMany: async events => {
            batches += 1;
            if (batches === 2) throw new Error('simulated interruption before recovery marker');
            return durableStore.appendMany(events);
        }
    };
    await Assert.rejects(Runtime.onBattlemetricsUpdated(value.context()), /simulated interruption/u);
    Assert.equal(batches, 2);

    let projection = Core.rebuild(await durableStore.readAll());
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '101', exactName: null
    }, 'battlemetrics:42').state, 'unknown');
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '102', exactName: null
    }, 'battlemetrics:42').state, 'unknown');

    delete value.client.playerIntelligenceDependencies.store;
    await Runtime.onBattlemetricsUpdated(value.context());
    projection = Core.rebuild(await durableStore.readAll());
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '101', exactName: null
    }, 'battlemetrics:42').state, 'online');
    Assert.equal(projection.presence.getStatus({
        steamId: null, battlemetricsPlayerId: '102', exactName: null
    }, 'battlemetrics:42').state, 'offline');
});

Test('BattleMetrics hook appends oversized legacy input in bounded journal batches', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    const batches = [];
    const scheduled = [];
    let requestedLimit = null;
    value.client.playerIntelligenceDependencies.identityHistory = {
        getIdentityRows: (_scope, options) => {
            requestedLimit = options.limit;
            return Array.from({ length: options.limit }, (_unused, index) => ({
            steamId: `${76561198000000000n + BigInt(index)}`,
            battlemetricsPlayerId: null,
            name: `Legacy ${index}`,
            observedAt: '2026-09-30T08:00:00.000Z'
            }));
        },
        recordIdentity: () => undefined
    };
    value.client.playerIntelligenceDependencies.playerScanDaemon = {
        schedule: options => { scheduled.push(options); return true; }
    };
    value.client.playerIntelligenceDependencies.store = {
        directory: Path.join(value.directory, 'guild', '42'),
        appendMany: async events => { batches.push(events); }
    };
    for (let index = 0; index < 1500; index += 1) {
        const id = `${1000 + index}`;
        value.battlemetrics.players[id] = { id, name: `Initial Player ${index}`, status: true };
        value.battlemetrics.onlinePlayers.push(id);
    }

    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    Assert.equal(batches.length, 3);
    Assert.equal(batches[0].length, 5000);
    Assert.equal(batches[1].length, 5000);
    Assert.equal(batches[2].length > 0 && batches[2].length <= 5000, true);
    Assert.equal(batches.flat().filter(event => event.provenance.source ===
        'teammate-language-database').length, Runtime.MAX_LEGACY_IDENTITY_CANDIDATES);
    Assert.equal(requestedLimit, Runtime.MAX_LEGACY_IDENTITY_CANDIDATES);
    Assert.equal(scheduled.length, 1);
    Assert.equal(scheduled[0].stableIdentityCandidates.length,
        Runtime.MAX_LEGACY_IDENTITY_CANDIDATES + 1);
    Assert.equal(scheduled[0].stableIdentityCandidates[0].source, 'player-tracker');
});

Test('stable candidates fail closed when the complete tracker set exceeds its bound', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    const scheduled = [];
    value.client.playerIntelligenceDependencies.playerScanDaemon = {
        schedule: options => { scheduled.push(options); return true; }
    };
    value.client.getInstance().trackers[1].players = Array.from({
        length: Runtime.MAX_TRACKER_IDENTITY_CANDIDATES + 1
    }, (_unused, index) => ({
        playerId: `${100000 + index}`,
        steamId: `${76561198001000000n + BigInt(index)}`,
        name: `Tracked ${index}`
    }));

    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    value.battlemetrics.newPlayers = [];
    await Runtime.onBattlemetricsUpdated(value.context());

    Assert.equal(scheduled.length, 2);
    Assert.deepEqual(scheduled.map(options => options.stableIdentityCandidates.length), [0, 0]);
    Assert.equal(value.logs.filter(entry => `${entry[1]}`.includes('player tracker exceeded')).length, 1);
});

Test('stable candidates fail closed without throwing when tracker players are malformed', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    const scheduled = [];
    value.client.playerIntelligenceDependencies.playerScanDaemon = {
        schedule: options => { scheduled.push(options); return true; }
    };
    value.client.getInstance().trackers[1].players = null;

    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));

    Assert.equal(scheduled.length, 1);
    Assert.equal(scheduled[0].stableIdentityCandidates.length, 0);
    Assert.equal(value.logs.filter(entry => `${entry[1]}`.includes('player tracker was incomplete')).length, 1);

    Runtime.resetRuntimeCachesForTests();
    scheduled.length = 0;
    value.client.getInstance().trackers[1].players = [{
        playerId: '101', steamId: '76561198000000001', name: ' '.repeat(4)
    }];
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    Assert.equal(scheduled.length, 1);
    Assert.equal(scheduled[0].stableIdentityCandidates.length, 0,
        'a stable ID pair with an unusable name must not hide a cross-source conflict');
});

Test('stable candidates fail closed when identity history signals or throws an incomplete read', async t => {
    Runtime.resetRuntimeCachesForTests();
    t.after(() => Runtime.resetRuntimeCachesForTests());
    const value = harness(t);
    const scheduled = [];
    value.client.playerIntelligenceDependencies.playerScanDaemon = {
        schedule: options => { scheduled.push(options); return true; }
    };
    const legacyRow = {
        steamId: '76561198036538266', battlemetricsPlayerId: '777', name: 'Dante',
        observedAt: '2026-09-30T08:00:00.000Z'
    };
    value.client.playerIntelligenceDependencies.identityHistory = {
        getIdentityRows: (_scope, options) => {
            options.onWarning('bounded CSV read failed');
            return [legacyRow];
        }
    };

    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    Assert.equal(scheduled[0].stableIdentityCandidates.length, 0,
        'the tracker candidate must not survive an incomplete history window');

    Runtime.resetRuntimeCachesForTests();
    scheduled.length = 0;
    value.client.playerIntelligenceDependencies.identityHistory = {
        getIdentityRows: () => { throw new Error('unreadable identity history'); }
    };
    value.setNow('2026-10-01T10:01:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T10:01:00.000Z';
    await Runtime.onBattlemetricsUpdated(value.context());
    Assert.equal(scheduled[0].stableIdentityCandidates.length, 0);
    Assert.equal(value.logs.filter(entry => `${entry[1]}`.includes('identity history was not read completely'))
        .length, 2);
});

Test('confirmed F7 and cinfo imports fuse by exact normalized name and stay hash-idempotent', async t => {
    const value = harness(t);
    const f7 = Object.freeze({
        kind: 'f7', complete: true,
        entries: Object.freeze([Object.freeze({ steamId: STEAM_A, name: 'ALICE', caseFidelity: false,
            ambiguous: false, alternatives: Object.freeze([]) })]),
        errors: Object.freeze([])
    });
    const cinfo = Object.freeze({
        kind: 'cinfo', complete: true, tag: 'BEHO', declaredCount: 2,
        establishedAtUtc: '2026-09-29T14:00:00.000Z',
        members: Object.freeze([
            Object.freeze({ name: 'Alice', role: 'leader' }),
            Object.freeze({ name: 'Bob', role: 'member' })
        ]),
        errors: Object.freeze([])
    });
    const first = await Runtime.commitParsedImport(value.context(), f7, { sha256: 'a'.repeat(64) });
    const duplicate = await Runtime.commitParsedImport(value.context(), f7, { sha256: 'a'.repeat(64) });
    const clan = await Runtime.commitParsedImport(value.context(), cinfo, { sha256: 'b'.repeat(64) });
    Assert.equal(first.appended, 1);
    Assert.deepEqual(duplicate, { appended: 0, duplicate: true });
    Assert.equal(clan.appended, 3);

    const projection = Core.rebuild(await value.store().readAll());
    const affinity = projection.clans.getAffinity({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    });
    Assert.deepEqual(affinity.knownTags, [{ tag: 'BEHO', count: 1 }]);
    Assert.deepEqual(affinity.playedWith.map(item => [item.name, item.count]), [['Bob', 1]]);
    Assert.deepEqual(await Runtime.linkedClanSteamCandidates(value.context()), [
        { name: 'Alice', steamId: STEAM_A }
    ]);
});

Test('an OCR-consensus-only F7 observation remains explicitly probable in the journal', async t => {
    const value = harness(t);
    const parsed = Object.freeze({
        kind: 'f7', complete: true,
        entries: Object.freeze([Object.freeze({
            steamId: STEAM_A, name: 'ALICE', caseFidelity: false, ambiguous: false,
            alternatives: Object.freeze([]), identityConfidence: 'probable', ocrConsensusOnly: true
        })]),
        errors: Object.freeze([])
    });

    await Runtime.commitParsedImport(value.context(), parsed, { sha256: '9'.repeat(64) });

    const [event] = await value.store().readAll();
    Assert.equal(event.kind, 'identity_observed');
    Assert.equal(event.confidence, 'probable');
    Assert.equal(event.subject.steamId, STEAM_A);
    Assert.equal(event.subject.exactName, 'ALICE');
});

Test('compact commands expose only useful identity, affinity and conservative activity', async t => {
    const value = harness(t);
    const scans = captureLocalScans(value);
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    await scans.runNext();
    await value.store().append(Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'player_metric_observed',
        observedAt: '2026-10-01T10:00:00.000Z',
        recordedAt: '2026-10-01T10:00:00.000Z',
        scope: { guildId: 'guild', serverKey: 'battlemetrics:42',
            wipeId: 'wipe:2026-09-29T14:00:00.000Z' },
        subject: { steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null },
        payload: { provider: 'warbandits', metric: 'playtime', value: 7500.9, unit: 'hours' },
        provenance: { source: 'warbandits-current-wipe-daemon', sourceEventId: 'playtime-test',
            collectorVersion: 'test-1' },
        confidence: 'verified',
        evidence: null
    }));
    const intel = await Runtime.handleCommand(value.command('!intel Alice'));
    Assert.equal(intel.handled, true);
    Assert.match(intel.response[0], new RegExp(
        `^Alice \\| Steam:${STEAM_A} \\| BM:101 \\| on \\| WB hours:7500\\+$`));
    Assert.equal(intel.response[1], 'Aliases: Alice');
    Assert.equal(intel.response[2], 'Known tags: none');
    Assert.equal(intel.response[3], 'Played with: none');
    Assert.equal(intel.response[4], 'Activity 1mo: 0h00m');
    Assert.equal(intel.response.every(line => Array.from(line).length <= 122), true);
    const steamIdAlias = await Runtime.handleCommand(value.command(`!steamid ${STEAM_A}`));
    Assert.deepEqual(steamIdAlias.response, intel.response);
    const aliases = await Runtime.handleCommand(value.command('!who 101'));
    Assert.equal(aliases.response, 'Aliases: Alice');

    value.setNow('2026-10-01T10:30:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T10:30:00.000Z';
    value.battlemetrics.newPlayers = [];
    value.battlemetrics.logoutPlayers = ['101'];
    value.battlemetrics.players[101].status = false;
    await Runtime.onBattlemetricsUpdated(value.context());
    const activity = await Runtime.handleCommand(value.command('!activity Alice all'));
    Assert.equal(activity.response, 'Activity all: 0h30m');
});

Test('record writes one durable server-wide Steam/BattleMetrics/name identity and rejects conflicts', async t => {
    const value = harness(t);
    const steamId = '76561198000000003';
    const otherSteamId = '76561198036538266';
    const name = '这就是我的宿命';

    const first = await Runtime.handleCommand(value.command(`!record ${steamId} 777 ${name}`));
    const duplicate = await Runtime.handleCommand(value.command(`!record ${steamId} 777 ${name}`));
    const conflict = await Runtime.handleCommand(value.command(`!record ${otherSteamId} 777 Other`));

    Assert.equal(first.response, `Identity recorded | Steam:${steamId} | BM:777`);
    Assert.equal(duplicate.response, `Identity already known | Steam:${steamId} | BM:777`);
    Assert.match(conflict.response, new RegExp(`^BM:777 is already linked to Steam:${steamId}`));
    const events = await value.store().readAll();
    Assert.equal(events.length, 1);
    Assert.equal(events[0].provenance.source, 'manual-command');
    Assert.equal(events[0].subject.exactName, name);
    const who = await Runtime.handleCommand(value.command('!who 777'));
    Assert.equal(who.response, `Aliases: ${name}`);
});

Test('intel-family name lookups return the closest partial identity without a selector', async t => {
    const value = harness(t);
    const steamId = '76561198000000004';
    await Runtime.handleCommand(value.command(`!record ${steamId} 778 Cockornut Tree`));

    const intel = await Runtime.handleCommand(value.command('!intel tree'));
    const who = await Runtime.handleCommand(value.command('!who cockornut'));

    Assert.match(intel.response[0], new RegExp(`^Cockornut Tree \\| Steam:${steamId} \\| BM:778`));
    Assert.equal(who.response, 'Aliases: Cockornut Tree');
});

Test('Discord identity administration lists pending aliases and keeps OCR corrections out of alias history',
    async t => {
        const value = harness(t);
        const targetSteamId = '76561198154738095';
        const scope = { guildId: 'guild', serverKey: 'battlemetrics:42',
            wipeId: 'wipe:2026-09-29T14:00:00.000Z' };
        const makeIdentity = (subject, observedAt, sourceEventId) => Core.createEvent({
            schemaVersion: Core.SCHEMA_VERSION,
            kind: 'identity_observed', observedAt, recordedAt: observedAt, scope, subject,
            payload: { caseFidelity: true },
            provenance: { source: subject.steamId ? 'manual-command' : 'discord-cinfo',
                sourceEventId, collectorVersion: 'test-1' },
            confidence: 'verified', evidence: null
        });
        await value.store().appendMany([
            makeIdentity({ steamId: targetSteamId, battlemetricsPlayerId: null, exactName: 'Ch1co' },
                '2026-10-01T09:00:00.000Z', 'verified-ch1co'),
            makeIdentity({ steamId: null, battlemetricsPlayerId: null, exactName: 'ChiCo' },
                '2026-10-01T09:01:00.000Z', 'pending-chico')
        ]);

        const pending = await Runtime.listPendingAliases(value.context());
        Assert.deepEqual(pending.map(item => item.name), ['ChiCo']);
        const target = await Runtime.resolveIdentityTarget(value.context(), 'Ch1co');
        Assert.equal(target.steamId, targetSteamId);

        value.setNow('2026-10-01T10:01:00.000Z');
        const linked = await Runtime.linkIdentityAlias(value.context(), {
            alias: 'ChiCo', targetSteamId, targetName: 'Ch1co', targetNameSource: 'verified-history',
            actorId: 'discord-admin'
        });
        Assert.equal(linked.changed, true);
        Assert.deepEqual(linked.verifiedAliases, ['Ch1co']);
        Assert.deepEqual(await Runtime.listPendingAliases(value.context()), []);
        Assert.equal((await Runtime.listIdentityLinks(value.context()))[0].exactName, 'ChiCo');
        Assert.equal((await Runtime.handleCommand(value.command(`!who ${targetSteamId}`))).response,
            'Aliases: Ch1co');

        const refreshed = await Runtime.linkIdentityAlias(value.context(), {
            alias: 'ChiCo', targetSteamId, targetName: 'Ch1co Current', targetNameSource: 'steam-profile',
            actorId: 'discord-admin'
        });
        Assert.equal(refreshed.changed, true);
        Assert.equal((await Runtime.listIdentityLinks(value.context()))[0].targetName, 'Ch1co Current');
        Assert.equal((await Runtime.handleCommand(value.command(`!who ${targetSteamId}`))).response,
            'Aliases: Ch1co Current, Ch1co');

        value.setNow('2026-10-01T10:02:00.000Z');
        Assert.equal((await Runtime.unlinkIdentityAlias(value.context(), {
            alias: 'ChiCo', actorId: 'discord-admin'
        })).changed, true);
        Assert.deepEqual((await Runtime.listPendingAliases(value.context())).map(item => item.name), ['ChiCo']);
    });

Test('pending identity administration groups every alias sharing one BattleMetrics identity', async t => {
    const value = harness(t);
    const scope = { guildId: 'guild', serverKey: 'battlemetrics:42',
        wipeId: 'wipe:2026-10-02T14:00:00.000Z' };
    const observed = (exactName, observedAt, sourceEventId) => Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_observed', observedAt, recordedAt: observedAt, scope,
        subject: { steamId: null, battlemetricsPlayerId: '1192585926', exactName },
        payload: { caseFidelity: true },
        provenance: { source: 'test', sourceEventId, collectorVersion: 'test-1' },
        confidence: 'verified', evidence: null
    });
    await value.store().appendMany([
        observed('+=import&**', '2026-10-02T09:00:00.000Z', 'funtik-old'),
        observed('gus', '2026-10-03T09:00:00.000Z', 'funtik-middle'),
        observed('FUNTIK', '2026-10-04T09:00:00.000Z', 'funtik-current')
    ]);

    const pending = await Runtime.listPendingAliases(value.context());

    Assert.equal(pending.length, 1);
    Assert.equal(pending[0].name, 'FUNTIK');
    Assert.deepEqual(pending[0].aliases, ['FUNTIK', 'gus', '+=import&**']);
    Assert.deepEqual(pending[0].battlemetricsPlayerIds, ['1192585926']);
});

Test('scanplayers acknowledges a bounded background rescan without awaiting it', async t => {
    const value = harness(t);
    const requests = [];
    value.client.playerIntelligenceDependencies.playerScanDaemon = {
        requestRescan: options => {
            requests.push(options);
            return Object.freeze({ accepted: true, state: 'started', retryAfterSeconds: 0 });
        }
    };

    const response = await Runtime.handleCommand(value.command('!scanplayers'));

    Assert.equal(response.response,
        'Player scan and a new pending identity reconciliation pass started in background; progress continues on ' +
        'BattleMetrics polling ticks.');
    Assert.equal(requests.length, 1);
    Assert.equal(requests[0].scope.wipeId, 'wipe:2026-09-29T14:00:00.000Z');
    Assert.equal(requests[0].directory, Path.join(value.directory, 'guild', '42'));
    const usage = await Runtime.handleCommand(value.command('!scanplayers now'));
    Assert.equal(usage.response, 'Usage: !scanplayers.');
});
