const Assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Stream = require('node:stream');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence');
const IsolatedScanDaemon = require('../src/plugins/playerIntelligence/isolatedScanDaemon.js');
const ScanDaemon = require('../src/plugins/playerIntelligence/scanDaemon.js');
const PlayerScanIpc = require('../src/workers/playerScanIpc.js');

const STEAM_A = '76561197975819827';
const STEAM_B = '76561198036538266';
const STEAM_C = '76561198154738095';
const STEAM_D = '76561199179453915';

function identityEvent(subject, sourceEventId, source = 'manual-command') {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_observed',
        observedAt: '2026-10-02T14:01:00.000Z',
        recordedAt: '2026-10-02T14:01:00.000Z',
        scope: { guildId: 'guild', serverKey: 'battlemetrics:42',
            wipeId: 'wipe:2026-10-02T14:00:00.000Z' },
        subject,
        payload: { caseFidelity: true },
        provenance: { source, sourceEventId, collectorVersion: 'test-1' },
        confidence: 'verified',
        evidence: null
    });
}

function metricEvent(steamId, sourceEventId, value = 1) {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'player_metric_observed',
        observedAt: '2026-10-02T14:01:00.000Z',
        recordedAt: '2026-10-02T14:01:00.000Z',
        scope: { guildId: 'guild', serverKey: 'battlemetrics:42',
            wipeId: 'wipe:2026-10-02T14:00:00.000Z' },
        subject: { steamId, battlemetricsPlayerId: null, exactName: null },
        payload: { provider: 'warbandits', metric: 'playtime', value, unit: 'hours' },
        provenance: { source: 'warbandits', sourceEventId, collectorVersion: 'test-1' },
        confidence: 'verified',
        evidence: null
    });
}

function harness(t) {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-player-scan-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    let now = new Date('2026-10-03T12:00:00.000Z');
    const battlemetrics = {
        lastUpdateSuccessful: true,
        streamerMode: false,
        updatedAt: now.toISOString(),
        players: {
            101: { id: '101', name: 'Alice', status: true },
            102: { id: '102', name: 'Bob', status: true },
            103: { id: '103', name: 'Charlie', status: true }
        },
        onlinePlayers: ['101', '102', '103']
    };
    const scope = {
        serverKey: 'battlemetrics:42',
        battlemetricsId: '42',
        wipeId: 'wipe:2026-10-02T14:00:00.000Z',
        wipeStart: '2026-10-02T14:00:00.000Z',
        battlemetrics
    };
    const context = {
        guildId: 'guild',
        client: {},
        rustplus: { log: () => undefined }
    };
    const store = new Core.JsonlHistoryStore({ directory });
    return {
        battlemetrics,
        context,
        directory,
        scope,
        store,
        dependencies: { now: () => new Date(now) },
        setNow: value => { now = new Date(value); battlemetrics.updatedAt = now.toISOString(); }
    };
}

class FakeScanChild extends EventEmitter {
    constructor(onSend = () => undefined) {
        super();
        this.connected = true;
        this.exitCode = null;
        this.signalCode = null;
        this.stderr = new Stream.PassThrough();
        this.onSend = onSend;
    }

    send(message, callback) {
        this.onSend(message, this);
        if (callback) callback(null);
    }

    crash(code = 91) {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.connected = false;
        this.exitCode = code;
        this.emit('exit', code, null);
    }

    fail(error = new Error('worker process error')) {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.connected = false;
        this.emit('error', error);
    }

    kill(signal = 'SIGTERM') {
        if (this.exitCode !== null || this.signalCode !== null) return false;
        this.connected = false;
        this.signalCode = signal;
        this.emit('exit', null, signal);
        return true;
    }
}

Test('final worker IPC callback errors become a fixed diagnostic and non-zero exit', () => {
    const privateError = 'private-player-plan-and-provider-token';
    let stderr = '';
    let disconnected = 0;
    const target = {
        connected: true,
        exitCode: 0,
        stderr: { write: value => { stderr += value; } },
        send: (_message, callback) => {
            callback(new Error(privateError));
            return true;
        },
        disconnect: () => { target.connected = false; disconnected += 1; }
    };

    Assert.equal(PlayerScanIpc.sendFinal(target, { v: 1, type: 'result', plan: { privateError } }), true);
    Assert.equal(target.exitCode, PlayerScanIpc.FINAL_SEND_FAILURE_EXIT_CODE);
    Assert.equal(disconnected, 1);
    Assert.equal(stderr.trim(), PlayerScanIpc.FINAL_SEND_FAILURE_MARKER);
    Assert.equal(stderr.includes(privateError), false);
});

Test('provider IPC requests reject immediately when their send cannot be delivered', async () => {
    const privateError = 'private-provider-transport-details';
    const pending = new Map();
    const target = {
        connected: true,
        send: () => { throw new Error(privateError); }
    };

    const request = PlayerScanIpc.request(target, pending,
        { v: 1, type: 'provider_request', callId: 7, provider: 'steam',
            method: 'profileIdentity', args: [STEAM_A] });
    Assert.equal(pending.size, 0);
    await Assert.rejects(request, error => {
        Assert.match(error.message, /could not be delivered/u);
        Assert.equal(error.message.includes(privateError), false);
        return true;
    });
});

Test('local stable identity pairs commit without any external provider and remain idempotent', async t => {
    const value = harness(t);
    value.battlemetrics.onlinePlayers = [];
    const candidate = {
        steamId: STEAM_A,
        battlemetricsPlayerId: '101',
        name: 'Alice',
        observedAt: '2026-10-02T14:05:00.000Z',
        source: 'player-tracker',
        sourceEventId: 'stable:player-tracker:alice'
    };

    await ScanDaemon.runCycle({ ...value, stableIdentityCandidates: [candidate] });
    await ScanDaemon.runCycle({ ...value, stableIdentityCandidates: [candidate] });

    const events = await value.store.readAll();
    const local = events.filter(event => event.provenance.source === 'player-tracker');
    Assert.equal(local.length, 1);
    Assert.deepEqual(local[0].subject, {
        steamId: STEAM_A,
        battlemetricsPlayerId: '101',
        exactName: 'Alice'
    });
    const person = Core.rebuild(events).identities.findByIdentifier('101')[0];
    Assert.equal(person.steamId, STEAM_A);
});

Test('local stable identity pairs fail closed against projected and same-cycle conflicts', async t => {
    const projected = harness(t);
    projected.battlemetrics.onlinePlayers = [];
    await projected.store.append(identityEvent({
        steamId: STEAM_B,
        battlemetricsPlayerId: '101',
        exactName: 'Bob'
    }, 'existing-bob'));
    await ScanDaemon.runCycle({
        ...projected,
        stableIdentityCandidates: [{
            steamId: STEAM_A, battlemetricsPlayerId: '101', name: 'Alice',
            observedAt: '2026-10-02T14:05:00.000Z', source: 'player-tracker',
            sourceEventId: 'stable:player-tracker:conflict-existing'
        }]
    });
    let events = await projected.store.readAll();
    Assert.equal(events.some(event => event.provenance.source === 'player-tracker'), false);
    Assert.deepEqual(Core.rebuild(events).identities.findByIdentifier('101').map(person => person.steamId), [STEAM_B]);

    const sameCycle = harness(t);
    sameCycle.battlemetrics.onlinePlayers = [];
    await ScanDaemon.runCycle({
        ...sameCycle,
        stableIdentityCandidates: [
            { steamId: STEAM_A, battlemetricsPlayerId: '201', name: 'Alice',
                observedAt: '2026-10-02T14:05:00.000Z', source: 'player-tracker',
                sourceEventId: 'stable:player-tracker:conflict-a' },
            { steamId: STEAM_A, battlemetricsPlayerId: '202', name: 'Alice',
                observedAt: '2026-10-02T14:05:00.000Z', source: 'teammate-language-database',
                sourceEventId: 'stable:teammate-language-database:conflict-b' }
        ]
    });
    events = await sameCycle.store.readAll();
    Assert.equal(events.some(event => ['player-tracker', 'teammate-language-database']
        .includes(event.provenance.source)), false);
});

Test('an external provider failure cannot roll back a validated local stable pair', async t => {
    const value = harness(t);
    value.battlemetrics.onlinePlayers = [];
    const result = await ScanDaemon.runCycle({
        ...value,
        stableIdentityCandidates: [{
            steamId: STEAM_A, battlemetricsPlayerId: '101', name: 'Alice',
            observedAt: '2026-10-02T14:05:00.000Z', source: 'player-tracker',
            sourceEventId: 'stable:player-tracker:provider-independent'
        }],
        warBanditsProvider: {
            scanCurrentWipePage: async () => { throw new Error('temporary external outage'); }
        }
    });
    Assert.equal(result.warBanditsPageFailures, 1);
    Assert.equal((await value.store.readAll()).some(event => event.provenance.source === 'player-tracker' &&
        event.subject.steamId === STEAM_A && event.subject.battlemetricsPlayerId === '101'), true);
});

Test('background scan refreshes known online SteamIDs once per wipe and resumes from durable state', async t => {
    const value = harness(t);
    await value.store.appendMany([
        identityEvent({ steamId: STEAM_A, battlemetricsPlayerId: '101', exactName: 'Alice' }, 'alice'),
        identityEvent({ steamId: STEAM_B, battlemetricsPlayerId: null, exactName: 'Bob' }, 'bob')
    ]);
    let requests = 0;
    const warBanditsProvider = {
        scanCurrentWipePage: async (_context, _scope, page) => {
            requests += 1;
            Assert.equal(page, 1);
            return {
                available: true,
                observedAt: '2026-10-03T12:00:00.000Z',
                complete: true,
                nextPage: null,
                rows: [
                    { steamId: STEAM_C, name: 'Charlie', playtime: 12.75 },
                    { steamId: STEAM_D, name: 'Dana', playtime: 7500.9 }
                ]
            };
        }
    };

    const first = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(first.appended, 6);
    Assert.equal(first.onlineRefreshed, 3);
    Assert.equal(first.warBanditsSeen, 2);
    Assert.equal(first.metricsObserved, 2);
    Assert.equal(requests, 1);

    const projection = Core.rebuild(await value.store.readAll());
    Assert.equal(projection.identities.findByIdentifier('103')[0].steamId, STEAM_C);
    Assert.equal(projection.identities.findByIdentifier(STEAM_D)[0].names.some(name => name.name === 'Dana'), true);
    Assert.equal(projection.metrics.getLatest({ steamId: STEAM_D, battlemetricsPlayerId: null, exactName: null },
        value.scope.serverKey, 'warbandits', 'playtime').value, 7500.9);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.refreshedSteamIds, [STEAM_A, STEAM_B, STEAM_C].sort());
    Assert.deepEqual(state.seenWarBanditsSteamIds, [STEAM_C, STEAM_D].sort());
    Assert.equal(state.nextWarBanditsPage, 1);
    Assert.equal(state.warBanditsSweeps, 1);

    value.setNow('2026-10-03T12:01:00.000Z');
    const second = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(second.appended, 0);
    Assert.equal(second.onlineRefreshed, 0);
    Assert.equal(requests, 1);
});

Test('text-imported SteamIDs receive one prioritized recent-scope WarBandits lookup chain per tick', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: STEAM_D, battlemetricsPlayerId: null, exactName: null
    }, 'text-list-dana', 'discord-steamid-list'));
    await value.store.append(identityEvent({
        steamId: null, battlemetricsPlayerId: '777', exactName: 'Dana'
    }, 'cinfo-dana', 'discord-cinfo'));
    let directLookups = 0;
    const warBanditsProvider = {
        resolvePlayer: async () => { throw new Error('legacy single-scope lookup must not run'); },
        resolvePlayerRecent: async (_context, _scope, steamId) => {
            directLookups += 1;
            Assert.equal(steamId, STEAM_D);
            return {
                available: true,
                observedAt: '2026-10-03T12:00:00.000Z',
                player: { steamId: STEAM_D, name: 'Dana', playtime: 10.8 }
            };
        },
        scanCurrentWipePage: async () => ({ available: false, rows: [] })
    };

    const first = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(first.targetedLookups, 1);
    Assert.equal(first.metricsObserved, 1);
    Assert.equal(directLookups, 1);
    let projection = Core.rebuild(await value.store.readAll());
    Assert.equal(projection.identities.displayName(`steam:${STEAM_D}`), 'Dana');
    Assert.deepEqual(projection.identities.getPerson(`steam:${STEAM_D}`).battlemetricsPlayerIds, ['777']);
    Assert.equal(projection.metrics.getLatest({ steamId: STEAM_D, battlemetricsPlayerId: null, exactName: null },
        value.scope.serverKey, 'warbandits', 'playtime').value, 10.8);

    value.setNow('2026-10-03T12:01:00.000Z');
    const second = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(second.targetedLookups, 0);
    Assert.equal(directLookups, 1);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.schemaVersion, 7);
    Assert.deepEqual(state.targetedLookupSteamIds, [STEAM_D]);
});

Test('a wipe change resets only the daemon checkpoint and permits one fresh online refresh', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: STEAM_A, battlemetricsPlayerId: '101', exactName: 'Alice'
    }, 'alice'));
    const unavailable = { scanCurrentWipePage: async () => ({ available: false, rows: [] }) };
    await ScanDaemon.runCycle({ ...value, warBanditsProvider: unavailable });

    value.scope = {
        ...value.scope,
        wipeId: 'wipe:2026-10-06T14:00:00.000Z',
        wipeStart: '2026-10-06T14:00:00.000Z'
    };
    value.setNow('2026-10-06T14:05:00.000Z');
    const nextWipe = await ScanDaemon.runCycle({ ...value, warBanditsProvider: unavailable });

    Assert.equal(nextWipe.onlineRefreshed >= 1, true);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.wipeId, 'wipe:2026-10-06T14:00:00.000Z');
    Assert.equal(state.refreshedSteamIds.includes(STEAM_A), true);
});

Test('a schema-1 daemon checkpoint upgrades without losing its collected SteamID sets', async t => {
    const value = harness(t);
    Fs.writeFileSync(Path.join(value.directory, 'scan-daemon.json'), `${JSON.stringify({
        schemaVersion: 1,
        guildId: 'guild',
        serverKey: value.scope.serverKey,
        wipeId: value.scope.wipeId,
        nextWarBanditsPage: 4,
        warBanditsResumeAt: null,
        warBanditsSweeps: 1,
        seenWarBanditsSteamIds: [STEAM_A],
        refreshedSteamIds: [STEAM_B],
        updatedAt: '2026-10-03T11:00:00.000Z'
    }, null, 2)}\n`, 'utf8');
    const unavailable = { scanCurrentWipePage: async () => ({ available: false, rows: [] }) };

    await ScanDaemon.runCycle({ ...value, warBanditsProvider: unavailable, forceWarBanditsRescan: true });

    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.schemaVersion, 7);
    Assert.deepEqual(state.seenWarBanditsSteamIds, [STEAM_A]);
    Assert.deepEqual(state.refreshedSteamIds, [STEAM_B]);
    Assert.deepEqual(state.targetedLookupSteamIds, []);
    Assert.deepEqual(state.targetedLookupRetries, []);
    Assert.equal(state.targetedFreshStreak, 0);
    Assert.deepEqual(state.profiledSteamIds, []);
    Assert.equal('profileAttemptedSteamIds' in state, false);
    Assert.deepEqual(state.steamProfileRetries, []);
    Assert.equal(state.steamProfileFreshStreak, 0);
    Assert.equal(state.warBanditsRetryAt !== null, true);
    Assert.equal(state.warBanditsFailures, 1);
});

Test('a schema-4 checkpoint keeps non-trivial cursors and collected sets during migration', async t => {
    const value = harness(t);
    Fs.writeFileSync(Path.join(value.directory, 'scan-daemon.json'), `${JSON.stringify({
        schemaVersion: 4,
        guildId: 'guild',
        serverKey: value.scope.serverKey,
        wipeId: value.scope.wipeId,
        nextWarBanditsPage: 4,
        warBanditsResumeAt: null,
        warBanditsSweeps: 2,
        seenWarBanditsSteamIds: [STEAM_A],
        targetedLookupSteamIds: [STEAM_B],
        refreshedSteamIds: [STEAM_C],
        profiledSteamIds: [STEAM_D],
        profileAttemptedSteamIds: [STEAM_A, STEAM_D],
        updatedAt: '2026-10-03T11:00:00.000Z'
    }, null, 2)}\n`, 'utf8');
    const unavailable = { scanCurrentWipePage: async () => ({ available: false, rows: [] }) };

    await ScanDaemon.runCycle({ ...value, warBanditsProvider: unavailable });

    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.schemaVersion, 7);
    Assert.equal(state.nextWarBanditsPage, 4);
    Assert.equal(state.warBanditsSweeps, 2);
    Assert.deepEqual(state.seenWarBanditsSteamIds, [STEAM_A]);
    Assert.deepEqual(state.targetedLookupSteamIds, [STEAM_B]);
    Assert.deepEqual(state.refreshedSteamIds, [STEAM_C]);
    Assert.deepEqual(state.profiledSteamIds, [STEAM_D]);
    Assert.equal('profileAttemptedSteamIds' in state, false);
    Assert.deepEqual(state.targetedLookupRetries, []);
    Assert.deepEqual(state.steamProfileRetries, [{
        steamId: STEAM_A,
        failures: 1,
        nextAttemptAt: '2026-10-03T11:00:00.000Z'
    }]);
    Assert.equal(state.warBanditsFailures, 1);
});

Test('a schema-5 checkpoint preserves WarBandits retries while migrating incomplete Steam work', async t => {
    const value = harness(t);
    await value.store.appendMany([
        identityEvent({ steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null }, 'pending-a'),
        identityEvent({ steamId: STEAM_D, battlemetricsPlayerId: null, exactName: null }, 'profiled-d')
    ]);
    Fs.writeFileSync(Path.join(value.directory, 'scan-daemon.json'), `${JSON.stringify({
        schemaVersion: 5,
        guildId: 'guild',
        serverKey: value.scope.serverKey,
        wipeId: value.scope.wipeId,
        nextWarBanditsPage: 4,
        warBanditsResumeAt: null,
        warBanditsSweeps: 2,
        seenWarBanditsSteamIds: [STEAM_C],
        targetedLookupSteamIds: [],
        targetedLookupRetries: [{
            steamId: STEAM_B, failures: 2, nextAttemptAt: '2026-10-03T12:10:00.000Z'
        }],
        refreshedSteamIds: [STEAM_C],
        profiledSteamIds: [STEAM_D],
        profileAttemptedSteamIds: [STEAM_A, STEAM_D],
        warBanditsRetryAt: '2026-10-03T12:10:00.000Z',
        warBanditsFailures: 2,
        updatedAt: '2026-10-03T11:00:00.000Z'
    }, null, 2)}\n`, 'utf8');
    const result = await ScanDaemon.runCycle({ ...value });
    Assert.equal(result.steamProfileAttempts, 0);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.schemaVersion, 7);
    Assert.equal('profileAttemptedSteamIds' in state, false);
    Assert.equal(state.nextWarBanditsPage, 4);
    Assert.deepEqual(state.seenWarBanditsSteamIds, [STEAM_C]);
    Assert.deepEqual(state.refreshedSteamIds, [STEAM_C]);
    Assert.deepEqual(state.profiledSteamIds, [STEAM_D]);
    Assert.deepEqual(state.targetedLookupRetries, [{
        steamId: STEAM_B, failures: 2, nextAttemptAt: '2026-10-03T12:10:00.000Z'
    }]);
    Assert.deepEqual(state.steamProfileRetries, [{
        steamId: STEAM_A, failures: 1, nextAttemptAt: '2026-10-03T11:00:00.000Z'
    }]);
    Assert.equal(state.warBanditsRetryAt, '2026-10-03T12:10:00.000Z');
    Assert.equal(state.warBanditsFailures, 2);
});

Test('failed targeted lookups cannot be starved by a continuous fresh queue', async t => {
    const value = harness(t);
    await value.store.appendMany([
        identityEvent({ steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null }, 'target-a',
            'discord-steamid-list'),
        identityEvent({ steamId: STEAM_C, battlemetricsPlayerId: null, exactName: null }, 'target-c',
            'discord-steamid-list'),
        identityEvent({ steamId: STEAM_D, battlemetricsPlayerId: null, exactName: null }, 'target-d',
            'discord-steamid-list')
    ]);
    const attempts = [];
    let aliceAvailable = false;
    const warBanditsProvider = {
        resolvePlayerRecent: async (_context, _scope, steamId) => {
            attempts.push(steamId);
            if (steamId === STEAM_A && !aliceAvailable) return { available: false, player: null };
            return { available: true, observedAt: value.battlemetrics.updatedAt,
                player: { steamId, name: steamId === STEAM_A ? 'Alice' :
                    steamId === STEAM_C ? 'Charlie' : 'Dana', playtime: 1 } };
        }
    };

    const first = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(first.targetedLookupFailures, 1);
    let state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.targetedLookupRetries[0].steamId, STEAM_A);
    Assert.equal(state.targetedLookupRetries[0].nextAttemptAt, '2026-10-03T12:01:00.000Z');

    value.setNow('2026-10-03T12:01:00.000Z');
    const second = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(second.targetedLookups, 1);
    Assert.deepEqual(attempts, [STEAM_A, STEAM_C]);

    aliceAvailable = true;
    value.setNow('2026-10-03T12:02:00.000Z');
    const third = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(third.targetedLookups, 1);
    Assert.deepEqual(attempts, [STEAM_A, STEAM_C, STEAM_A]);
    value.setNow('2026-10-03T12:03:00.000Z');
    const fourth = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(fourth.targetedLookups, 1);
    Assert.deepEqual(attempts, [STEAM_A, STEAM_C, STEAM_A, STEAM_D]);
    state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.targetedLookupRetries, []);
    Assert.deepEqual(state.targetedLookupSteamIds, [STEAM_A, STEAM_C, STEAM_D].sort());
});

Test('WarBandits exceptions preserve local work and page retries never skip a page', async t => {
    const value = harness(t);
    await value.store.appendMany([
        identityEvent({ steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null }, 'target-a',
            'discord-steamid-list'),
        identityEvent({ steamId: STEAM_D, battlemetricsPlayerId: null, exactName: null }, 'profile-d')
    ]);
    value.dependencies.steamProfileIdentity = async steamId => ({
        steamId, currentName: 'Dana', pastAliases: [], aliasesComplete: true
    });
    let pageCalls = 0;
    const warBanditsProvider = {
        resolvePlayerRecent: async () => { throw new Error('lookup timeout'); },
        scanCurrentWipePage: async (_context, _scope, page) => {
            pageCalls += 1;
            Assert.equal(page, 1);
            if (pageCalls === 1) throw new Error('page timeout');
            return { available: true, observedAt: value.battlemetrics.updatedAt,
                complete: false, nextPage: 2, rows: [] };
        }
    };

    const first = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(first.steamProfilesRefreshed, 1);
    Assert.equal(first.targetedLookupFailures, 1);
    Assert.equal(first.warBanditsPageFailures, 1);
    let state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.profiledSteamIds, [STEAM_A]);
    Assert.equal(state.nextWarBanditsPage, 1);
    Assert.equal(state.warBanditsRetryAt, '2026-10-03T12:01:00.000Z');
    Assert.equal(Core.rebuild(await value.store.readAll()).presence.providers.length, 0);

    value.setNow('2026-10-03T12:00:30.000Z');
    await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(pageCalls, 1);
    value.setNow('2026-10-03T12:01:00.000Z');
    await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(pageCalls, 2);
    state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.nextWarBanditsPage, 2);
    Assert.equal(state.warBanditsRetryAt, null);
    Assert.equal(state.warBanditsFailures, 0);
});

Test('malformed available WarBandits results fail closed without completing an ID or page', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    }, 'target-a', 'discord-steamid-list'));
    const warBanditsProvider = {
        resolvePlayerRecent: async () => ({
            available: true,
            player: { steamId: STEAM_D, name: 'Wrong player' }
        }),
        scanCurrentWipePage: async () => ({
            available: true, page: 1, rows: null, complete: false, nextPage: 2
        })
    };

    const result = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(result.targetedLookups, 0);
    Assert.equal(result.targetedLookupFailures, 1);
    Assert.equal(result.warBanditsPageFailures, 1);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.targetedLookupSteamIds, []);
    Assert.equal(state.targetedLookupRetries[0].steamId, STEAM_A);
    Assert.equal(state.nextWarBanditsPage, 1);
    Assert.equal(state.warBanditsFailures, 1);
});

Test('one failed Steam profile cannot starve the remaining enrichment queue', async t => {
    const value = harness(t);
    await value.store.appendMany([
        identityEvent({ steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null }, 'pending-a',
            'discord-steamid-list'),
        identityEvent({ steamId: STEAM_D, battlemetricsPlayerId: null, exactName: null }, 'pending-d',
            'discord-steamid-list')
    ]);
    const attempts = [];
    let aliceAvailable = false;
    value.dependencies.steamProfileIdentity = async steamId => {
        attempts.push(steamId);
        return steamId === STEAM_A && !aliceAvailable ? null : {
            steamId,
            currentName: steamId === STEAM_A ? 'Alice' : 'Dana',
            pastAliases: [],
            aliasesComplete: true
        };
    };

    const first = await ScanDaemon.runCycle({ ...value });
    Assert.equal(first.steamProfileAttempts, 1);
    Assert.equal(first.steamProfilesRefreshed, 0);
    Assert.equal(first.steamProfileFailures, 1);
    value.setNow('2026-10-03T12:01:00.000Z');
    const second = await ScanDaemon.runCycle({ ...value });
    Assert.equal(second.steamProfileAttempts, 1);
    Assert.equal(second.steamProfilesRefreshed, 1);
    Assert.deepEqual(attempts, [STEAM_A, STEAM_D]);
    let state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal('profileAttemptedSteamIds' in state, false);
    Assert.deepEqual(state.profiledSteamIds, [STEAM_D]);
    Assert.equal(state.steamProfileRetries[0].steamId, STEAM_A);
    Assert.equal(state.steamProfileRetries[0].nextAttemptAt, '2026-10-03T12:01:00.000Z');
    Assert.equal(Core.rebuild(await value.store.readAll()).identities.displayName(`steam:${STEAM_D}`), 'Dana');

    aliceAvailable = true;
    value.setNow('2026-10-03T12:02:00.000Z');
    const retry = await ScanDaemon.runCycle({ ...value });
    Assert.equal(retry.steamProfileAttempts, 1);
    Assert.equal(retry.steamProfilesRefreshed, 1);
    Assert.deepEqual(attempts, [STEAM_A, STEAM_D, STEAM_A]);
    state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal('profileAttemptedSteamIds' in state, false);
    Assert.deepEqual(state.profiledSteamIds, [STEAM_A, STEAM_D].sort());
    Assert.deepEqual(state.steamProfileRetries, []);

    value.setNow('2026-10-03T12:03:00.000Z');
    const forced = await ScanDaemon.runCycle({ ...value, forceWarBanditsRescan: true });
    Assert.equal(forced.steamProfileAttempts, 0);
    Assert.deepEqual(attempts, [STEAM_A, STEAM_D, STEAM_A]);
});

Test('Steam profile retries use durable exponential backoff', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    }, 'pending-a', 'discord-steamid-list'));
    let attempts = 0;
    value.dependencies.steamProfileIdentity = async () => {
        attempts += 1;
        return null;
    };

    const first = await ScanDaemon.runCycle({ ...value });
    Assert.equal(first.steamProfileFailures, 1);
    let state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.steamProfileRetries, [{
        steamId: STEAM_A, failures: 1, nextAttemptAt: '2026-10-03T12:01:00.000Z'
    }]);

    value.setNow('2026-10-03T12:00:59.000Z');
    Assert.equal((await ScanDaemon.runCycle({ ...value })).steamProfileAttempts, 0);
    value.setNow('2026-10-03T12:01:00.000Z');
    Assert.equal((await ScanDaemon.runCycle({ ...value })).steamProfileFailures, 1);
    state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.steamProfileRetries, [{
        steamId: STEAM_A, failures: 2, nextAttemptAt: '2026-10-03T12:03:00.000Z'
    }]);
    value.setNow('2026-10-03T12:02:59.000Z');
    Assert.equal((await ScanDaemon.runCycle({ ...value })).steamProfileAttempts, 0);
    Assert.equal((await ScanDaemon.runCycle({ ...value, forceWarBanditsRescan: true })).steamProfileAttempts, 1);
    state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.steamProfileRetries, [{
        steamId: STEAM_A, failures: 1, nextAttemptAt: '2026-10-03T12:03:59.000Z'
    }]);
    Assert.equal(attempts, 3);
});

Test('partial Steam aliases are recorded but remain retryable until the profile is complete', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    }, 'pending-a', 'discord-steamid-list'));
    let complete = false;
    let calls = 0;
    value.dependencies.steamProfileIdentity = async steamId => {
        calls += 1;
        return {
            steamId,
            currentName: 'Alice current',
            pastAliases: [{ name: 'Alice past' }],
            aliasesComplete: complete
        };
    };

    const first = await ScanDaemon.runCycle({ ...value });
    Assert.equal(first.steamProfileFailures, 1);
    Assert.equal(first.steamProfilesRefreshed, 0);
    let projection = Core.rebuild(await value.store.readAll());
    Assert.deepEqual(projection.identities.getPerson(`steam:${STEAM_A}`).names
        .filter(alias => alias.verified).map(alias => [alias.name, alias.steamStatus]), [
        ['Alice current', 'current'],
        ['Alice past', 'past']
    ]);
    let state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.steamProfileRetries[0].steamId, STEAM_A);
    Assert.deepEqual(state.profiledSteamIds, []);
    const eventCountAfterPartial = (await value.store.readAll()).length;

    complete = true;
    value.setNow('2026-10-03T12:01:00.000Z');
    const second = await ScanDaemon.runCycle({ ...value });
    Assert.equal(second.steamProfilesRefreshed, 1);
    Assert.equal(second.appended, 0);
    Assert.equal((await value.store.readAll()).length, eventCountAfterPartial);
    state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.steamProfileRetries, []);
    Assert.deepEqual(state.profiledSteamIds, [STEAM_A]);
    projection = Core.rebuild(await value.store.readAll());
    Assert.equal(projection.presence.providers.length, 0);
    Assert.equal(calls, 2);
});

Test('an oversized Steam alias history is never marked complete after bounded projection', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: STEAM_A, battlemetricsPlayerId: null, exactName: null
    }, 'pending-oversized-alias-history', 'discord-steamid-list'));
    value.dependencies.steamProfileIdentity = async steamId => ({
        steamId,
        currentName: 'Alice current',
        pastAliases: Array.from({ length: 257 }, (_unused, index) => ({ name: `Alice past ${index}` })),
        aliasesComplete: true
    });

    const first = await ScanDaemon.runCycle({ ...value });
    Assert.equal(first.steamProfileFailures, 1);
    Assert.equal(first.steamProfilesRefreshed, 0);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.profiledSteamIds, []);
    Assert.equal(state.steamProfileRetries[0].steamId, STEAM_A);
    const names = Core.rebuild(await value.store.readAll()).identities
        .getPerson(`steam:${STEAM_A}`).names.map(alias => alias.name);
    Assert.equal(names.includes('Alice past 255'), true);
    Assert.equal(names.includes('Alice past 256'), false);
});

Test('the background scan stores Steam current and past names as verified aliases', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: STEAM_D, battlemetricsPlayerId: '777', exactName: 'Old local name'
    }, 'known-dana'));
    let calls = 0;
    value.dependencies.steamProfileIdentity = async steamId => {
        calls += 1;
        Assert.equal(steamId, STEAM_D);
        return {
            steamId,
            currentName: 'FUNTIK',
            pastAliases: [{ name: '+=import&**' }, { name: 'gus' }]
        };
    };

    const first = await ScanDaemon.runCycle({ ...value });
    Assert.equal(first.steamProfilesRefreshed, 1);
    Assert.equal(first.appended, 3);
    Assert.equal(calls, 1);
    const projection = Core.rebuild(await value.store.readAll());
    const person = projection.identities.getPerson(`steam:${STEAM_D}`);
    Assert.equal(projection.identities.displayName(person.personId), 'FUNTIK');
    Assert.deepEqual(person.names.filter(alias => alias.name !== 'Old local name')
        .map(alias => [alias.name, alias.verified, alias.steamStatus]), [
        ['+=import&**', true, 'past'],
        ['FUNTIK', true, 'current'],
        ['gus', true, 'past']
    ]);
    Assert.deepEqual(person.battlemetricsPlayerIds, ['777']);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.profiledSteamIds, [STEAM_D]);
    Assert.equal('profileAttemptedSteamIds' in state, false);
    Assert.equal(Core.consolidateProjection(projection, {
        steamId: null, battlemetricsPlayerId: '999', name: 'gus', caseFidelity: true
    }).identity.steamId, null);

    value.setNow('2026-10-03T12:01:00.000Z');
    const second = await ScanDaemon.runCycle({ ...value });
    Assert.equal(second.steamProfilesRefreshed, 0);
    Assert.equal(calls, 1);
});

Test('pending reconciliation is manual-only and BattleMetrics links do not verify OCR names', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: null, battlemetricsPlayerId: '777', exactName: 'FUNT1K'
    }, 'pending-funtik', 'discord-cinfo'));
    const calls = [];
    value.dependencies.battlemetricsProvider = {
        resolveSteamId: async battlemetricsPlayerId => {
            calls.push(battlemetricsPlayerId);
            return { available: true, reason: null, steamId: STEAM_D };
        }
    };

    const ordinary = await ScanDaemon.runCycle({ ...value });
    Assert.equal(ordinary.pendingBattlemetricsAttempts, 0);
    Assert.deepEqual(calls, []);
    let state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.pendingReconciliation.active, false);

    value.setNow('2026-10-03T12:01:00.000Z');
    const started = await ScanDaemon.runCycle({ ...value, forceWarBanditsRescan: true });
    Assert.equal(started.pendingBattlemetricsAttempts, 1);
    Assert.equal(started.pendingIdentitiesLinked, 1);
    Assert.equal(started.pendingReconciliationActive, true);
    Assert.deepEqual(calls, ['777']);
    let projection = Core.rebuild(await value.store.readAll());
    const linked = projection.identities.findByIdentifier('777')[0];
    Assert.equal(linked.steamId, STEAM_D);
    Assert.equal(linked.names.find(alias => alias.name === 'FUNT1K').verified, false);
    Assert.equal(projection.presence.providers.length, 0);

    value.setNow('2026-10-03T12:02:00.000Z');
    const completed = await ScanDaemon.runCycle({ ...value });
    Assert.equal(completed.pendingBattlemetricsAttempts, 0);
    Assert.equal(completed.pendingReconciliationCompleted, true);
    Assert.equal(completed.pendingReconciliationActive, false);
    state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.deepEqual(state.pendingReconciliation.checkedBattlemetricsIds, ['777']);
    projection = Core.rebuild(await value.store.readAll());
    Assert.equal(projection.identities.findByIdentifier(STEAM_D).length, 1);
});

Test('pending reconciliation drains a bounded BattleMetrics batch per cycle', async t => {
    const value = harness(t);
    await value.store.appendMany(['700', '701', '702', '703', '704', '705'].map(id => identityEvent({
        steamId: null, battlemetricsPlayerId: id, exactName: `Pending ${id}`
    }, `pending-${id}`, 'discord-cinfo')));
    const calls = [];
    value.dependencies.battlemetricsProvider = {
        resolveSteamId: async battlemetricsPlayerId => {
            calls.push(battlemetricsPlayerId);
            return { available: true, reason: null, steamId: null };
        }
    };

    const first = await ScanDaemon.runCycle({ ...value, forceWarBanditsRescan: true });
    Assert.equal(first.pendingBattlemetricsAttempts, ScanDaemon.PENDING_BATTLEMETRICS_BATCH_SIZE);
    Assert.deepEqual(calls, ['700', '701', '702', '703']);
    Assert.equal(first.pendingReconciliationActive, true);

    value.setNow('2026-10-03T12:01:00.000Z');
    const second = await ScanDaemon.runCycle({ ...value });
    Assert.equal(second.pendingBattlemetricsAttempts, 2);
    Assert.deepEqual(calls, ['700', '701', '702', '703', '704', '705']);
    Assert.equal(second.pendingReconciliationCompleted, true);
});

Test('pending reconciliation stops opening calls when its cycle budget is exhausted', async t => {
    const value = harness(t);
    await value.store.appendMany(['700', '701', '702', '703'].map(id => identityEvent({
        steamId: null, battlemetricsPlayerId: id, exactName: `Budget ${id}`
    }, `pending-budget-${id}`, 'discord-cinfo')));
    const calls = [];
    let monotonicNow = 0;
    value.dependencies.monotonicNow = () => {
        const result = monotonicNow;
        monotonicNow += 16000;
        return result;
    };
    value.dependencies.battlemetricsProvider = {
        resolveSteamId: async battlemetricsPlayerId => {
            calls.push(battlemetricsPlayerId);
            return { available: true, reason: null, steamId: null };
        }
    };

    const result = await ScanDaemon.runCycle({ ...value, forceWarBanditsRescan: true });
    Assert.equal(result.pendingBattlemetricsAttempts, 2);
    Assert.deepEqual(calls, ['700', '701']);
    Assert.equal(result.pendingReconciliationActive, true);
});

Test('pending reconciliation drains a bounded WarBandits batch per cycle', async t => {
    const value = harness(t);
    await value.store.appendMany(['AlphaOne', 'BravoTwo', 'CharlieThree', 'DeltaFour', 'EchoFive'].map(name =>
        identityEvent({ steamId: null, battlemetricsPlayerId: null, exactName: name },
            `pending-warbandits-${name}`, 'discord-cinfo')));
    const calls = [];
    const warBanditsProvider = {
        resolvePlayerRecent: async (_context, _scope, query) => {
            calls.push(query);
            return { available: true, ambiguous: false, player: null };
        }
    };

    const result = await ScanDaemon.runCycle({ ...value, warBanditsProvider, forceWarBanditsRescan: true });
    Assert.equal(result.pendingWarBanditsAttempts, ScanDaemon.PENDING_WARBANDITS_BATCH_SIZE);
    Assert.deepEqual(calls, ['AlphaOne', 'BravoTwo', 'CharlieThree', 'DeltaFour']);
    Assert.equal(result.pendingReconciliationActive, true);
});

Test('oversized WarBandits aliases remain retryable instead of becoming a false completed lookup', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: null, battlemetricsPlayerId: null, exactName: 'Target Player'
    }, 'pending-warbandits-oversized-aliases', 'discord-cinfo'));
    const warBanditsProvider = {
        resolvePlayerRecent: async () => ({
            available: true,
            ambiguous: false,
            player: {
                steamId: STEAM_A,
                name: 'Target Player',
                aliases: Array.from({ length: 257 }, (_unused, index) => `Target Alias ${index}`)
            }
        })
    };

    const result = await ScanDaemon.runCycle({ ...value, warBanditsProvider, forceWarBanditsRescan: true });
    Assert.equal(result.pendingWarBanditsAttempts, 1);
    Assert.equal(result.pendingIdentitiesLinked, 0);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.pendingReconciliation.warBanditsRetries.length, 1);
    Assert.deepEqual(state.pendingReconciliation.checkedWarBanditsKeys, []);
});

Test('each explicit scanplayers pass rearms unresolved identities', async t => {
    const value = harness(t);
    await value.store.appendMany(['700', '701', '702', '703', '704'].map(id => identityEvent({
        steamId: null, battlemetricsPlayerId: id, exactName: `Rearm ${id}`
    }, `pending-rearm-${id}`, 'discord-cinfo')));
    const calls = [];
    value.dependencies.battlemetricsProvider = {
        resolveSteamId: async battlemetricsPlayerId => {
            calls.push(battlemetricsPlayerId);
            return { available: true, reason: null, steamId: null };
        }
    };

    await ScanDaemon.runCycle({ ...value, forceWarBanditsRescan: true });
    Assert.deepEqual(calls, ['700', '701', '702', '703']);
    value.setNow('2026-10-03T12:01:00.000Z');
    await ScanDaemon.runCycle({ ...value, forceWarBanditsRescan: true });
    Assert.deepEqual(calls, ['700', '701', '702', '703', '700', '701', '702', '703']);
});

Test('pending reconciliation rejects stable-ID conflicts discovered inside one batch', async t => {
    const value = harness(t);
    await value.store.appendMany(['700', '701'].map(id => identityEvent({
        steamId: null, battlemetricsPlayerId: id, exactName: `Pending ${id}`
    }, `pending-conflict-${id}`, 'discord-cinfo')));
    value.dependencies.battlemetricsProvider = {
        resolveSteamId: async () => ({ available: true, reason: null, steamId: STEAM_D })
    };

    const result = await ScanDaemon.runCycle({ ...value, forceWarBanditsRescan: true });
    Assert.equal(result.pendingBattlemetricsAttempts, 2);
    Assert.equal(result.pendingIdentitiesLinked, 1);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.pendingReconciliation.conflicts, 1);
    const projection = Core.rebuild(await value.store.readAll());
    Assert.equal(projection.identities.findByIdentifier('700')[0].steamId, STEAM_D);
    Assert.equal(projection.identities.findByIdentifier('701')[0].steamId, null);
});

Test('manual pending reconciliation falls back to an exact recent WarBandits alias', async t => {
    const value = harness(t);
    await value.store.appendMany([
        identityEvent({ steamId: null, battlemetricsPlayerId: '888', exactName: 'FUNTIK' },
            'pending-funtik', 'discord-cinfo'),
        identityEvent({ steamId: null, battlemetricsPlayerId: '888', exactName: 'BAD OCR' },
            'pending-bad-ocr', 'discord-cinfo')
    ]);
    let battlemetricsCalls = 0;
    const warBanditsCalls = [];
    value.dependencies.battlemetricsProvider = {
        resolveSteamId: async () => {
            battlemetricsCalls += 1;
            return { available: true, reason: null, steamId: null };
        }
    };
    const warBanditsProvider = {
        resolvePlayerRecent: async (...args) => {
            Assert.equal(args.length, 3);
            const query = args[2];
            warBanditsCalls.push(query);
            if (query === 'BAD OCR') return {
                available: true,
                ambiguous: false,
                observedAt: '2026-10-03T12:01:00.000Z',
                player: { steamId: STEAM_A, name: 'SOMEONE ELSE', aliases: [] }
            };
            Assert.equal(query, 'FUNTIK');
            return {
                available: true,
                ambiguous: false,
                observedAt: '2026-10-03T12:01:00.000Z',
                player: { steamId: STEAM_D, name: 'FUNTIK NEW', aliases: ['FUNTIK', 'FUNTIK OLD'], playtime: 42 }
            };
        }
    };

    const battlemetrics = await ScanDaemon.runCycle({
        ...value, warBanditsProvider, forceWarBanditsRescan: true
    });
    Assert.equal(battlemetrics.pendingBattlemetricsAttempts, 1);
    Assert.equal(battlemetrics.pendingWarBanditsAttempts, 2);
    Assert.equal(battlemetrics.pendingIdentitiesLinked, 1);
    Assert.equal(battlemetricsCalls, 1);
    Assert.deepEqual(warBanditsCalls, ['BAD OCR', 'FUNTIK']);
    const projection = Core.rebuild(await value.store.readAll());
    const person = projection.identities.findByIdentifier('888')[0];
    Assert.equal(person.steamId, STEAM_D);
    Assert.deepEqual(person.names.filter(alias => alias.verified).map(alias => alias.name).sort(),
        ['FUNTIK', 'FUNTIK NEW', 'FUNTIK OLD']);
    Assert.equal(person.names.find(alias => alias.name === 'BAD OCR').verified, false);
    Assert.equal(projection.presence.providers.length, 0);
});

Test('pending provider failures use a global cooldown and survive a wipe change', async t => {
    const value = harness(t);
    await value.store.appendMany([
        identityEvent({ steamId: null, battlemetricsPlayerId: '777', exactName: 'One' },
            'pending-one', 'discord-cinfo'),
        identityEvent({ steamId: null, battlemetricsPlayerId: '778', exactName: 'Two' },
            'pending-two', 'discord-cinfo')
    ]);
    const battlemetricsCalls = [];
    let warBanditsCalls = 0;
    value.dependencies.battlemetricsProvider = {
        resolveSteamId: async battlemetricsPlayerId => {
            battlemetricsCalls.push(battlemetricsPlayerId);
            return { available: false, reason: 'token invalid', steamId: null, retryAt: null };
        }
    };
    const warBanditsProvider = {
        resolvePlayerRecent: async () => {
            warBanditsCalls += 1;
            return { available: true, ambiguous: false, player: null };
        }
    };

    await ScanDaemon.runCycle({ ...value, warBanditsProvider, forceWarBanditsRescan: true });
    Assert.deepEqual(battlemetricsCalls, ['777']);
    Assert.equal(warBanditsCalls, 0);
    let state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.pendingReconciliation.battlemetricsRetryAt, '2026-10-03T12:01:00.000Z');

    value.scope = { ...value.scope, wipeId: 'wipe:2026-10-06T14:00:00.000Z',
        wipeStart: '2026-10-06T14:00:00.000Z' };
    value.setNow('2026-10-03T12:00:30.000Z');
    const paused = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(paused.pendingBattlemetricsAttempts, 0);
    Assert.equal(paused.pendingWarBanditsAttempts, 0);
    Assert.deepEqual(battlemetricsCalls, ['777']);
    Assert.equal(warBanditsCalls, 0);
    state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.wipeId, 'wipe:2026-10-06T14:00:00.000Z');
    Assert.equal(state.pendingReconciliation.active, true);

    value.setNow('2026-10-03T12:01:00.000Z');
    await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.deepEqual(battlemetricsCalls, ['777', '778']);
    Assert.equal(warBanditsCalls, 0);
});

Test('Steam alias lookup failure does not cancel the independent WarBandits page', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: STEAM_A, battlemetricsPlayerId: '101', exactName: 'Alice'
    }, 'known-alice'));
    value.dependencies.steamProfileIdentity = async () => { throw new Error('Steam unavailable'); };
    let pages = 0;
    const result = await ScanDaemon.runCycle({
        ...value,
        warBanditsProvider: {
            scanCurrentWipePage: async () => {
                pages += 1;
                return { available: true, observedAt: value.battlemetrics.updatedAt,
                    complete: true, nextPage: null, rows: [] };
            }
        }
    });
    Assert.equal(result.steamProfilesRefreshed, 0);
    Assert.equal(pages, 1);
});

Test('the scheduler coalesces cycles for the same server directory', async t => {
    const value = harness(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const warBanditsProvider = {
        scanCurrentWipePage: async () => {
            calls += 1;
            await gate;
            return { available: false, rows: [] };
        }
    };

    Assert.equal(ScanDaemon.schedule({ ...value, warBanditsProvider }), true);
    Assert.equal(ScanDaemon.getRuntimeStatus().active, 1);
    Assert.equal(ScanDaemon.getRuntimeStatus().forcedRerunsQueued, 0);
    await new Promise(resolve => setImmediate(resolve));
    Assert.equal(ScanDaemon.schedule({ ...value, warBanditsProvider }), false);
    release();
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 1);
    Assert.equal(ScanDaemon.getRuntimeStatus().active, 0);
    Assert.equal(ScanDaemon.getRuntimeStatus().forcedRerunsQueued, 0);
});

Test('a scan plan is read-only until the parent validates and commits it', async t => {
    const value = harness(t);
    const plan = await ScanDaemon.runCycle({
        ...value,
        planOnly: true,
        warBanditsProvider: {
            scanCurrentWipePage: async () => ({
                available: true,
                observedAt: '2026-10-03T12:00:00.000Z',
                complete: true,
                nextPage: null,
                rows: [{ steamId: STEAM_D, name: 'Dana', playtime: 12 }]
            })
        }
    });

    Assert.equal(plan.protocolVersion, ScanDaemon.PLAN_PROTOCOL_VERSION);
    Assert.equal(plan.events.length > 0, true);
    Assert.equal((await value.store.readAll()).length, 0);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);

    const result = await ScanDaemon.commitPlan(value, plan);
    Assert.equal(result.appended, plan.events.length);
    Assert.equal((await value.store.readAll()).length, plan.events.length);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), true);
});

Test('a journal append during provider RPC is rebased without losing either writer', async t => {
    const value = harness(t);
    let releaseProvider;
    let announceProvider;
    const providerEntered = new Promise(resolve => { announceProvider = resolve; });
    const providerGate = new Promise(resolve => { releaseProvider = resolve; });
    const planning = ScanDaemon.runCycle({
        ...value,
        planOnly: true,
        warBanditsProvider: {
            scanCurrentWipePage: async () => {
                announceProvider();
                await providerGate;
                return { available: true, observedAt: '2026-10-03T12:00:00.000Z', complete: true,
                    nextPage: null, rows: [{ steamId: STEAM_D, name: 'Dana', playtime: 12 }] };
            }
        }
    });

    await providerEntered;
    await value.store.appendMany([
        metricEvent(STEAM_A, 'runtime-metric'),
        identityEvent({ steamId: STEAM_A, battlemetricsPlayerId: '901', exactName: 'Unrelated' },
            'runtime-unrelated-identity')
    ]);
    releaseProvider();
    const plan = await planning;

    const result = await ScanDaemon.commitPlan(value, plan);
    const events = await value.store.readAll();
    Assert.equal(result.appended, plan.events.length);
    Assert.equal(events.length, plan.events.length + 2);
    Assert.equal(events.some(event => event.provenance.sourceEventId === 'runtime-metric'), true);
    Assert.equal(events.some(event => event.provenance.sourceEventId === 'runtime-unrelated-identity'), true);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), true);
});

Test('an identity revocation during planning makes the worker plan stale instead of restoring the link', async t => {
    const value = harness(t);
    const linked = Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_linked',
        observedAt: '2026-10-02T14:01:00.000Z',
        recordedAt: '2026-10-02T14:01:00.000Z',
        scope: { guildId: 'guild', serverKey: 'battlemetrics:42',
            wipeId: 'wipe:2026-10-02T14:00:00.000Z' },
        subject: { steamId: null, battlemetricsPlayerId: '101', exactName: 'Alice' },
        payload: { linkId: 'manual-alice', targetSteamId: STEAM_A,
            targetBattlemetricsPlayerId: null, reason: 'operator confirmation' },
        provenance: { source: 'manual-command', sourceEventId: 'manual-alice-link',
            collectorVersion: 'test-1' },
        confidence: 'verified',
        evidence: null
    });
    await value.store.appendMany([
        identityEvent({ steamId: null, battlemetricsPlayerId: '101', exactName: 'Alice' },
            'alice-before-link'),
        linked
    ]);
    const plan = await ScanDaemon.runCycle({ ...value, planOnly: true });
    Assert.equal(plan.events.some(event => event.subject.steamId === STEAM_A &&
        event.subject.battlemetricsPlayerId === '101'), true);
    await value.store.append(Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_link_revoked',
        observedAt: '2026-10-02T14:02:00.000Z',
        recordedAt: '2026-10-02T14:02:00.000Z',
        scope: linked.scope,
        subject: linked.subject,
        payload: { linkId: 'manual-alice', reason: 'operator correction' },
        provenance: { source: 'manual-command', sourceEventId: 'manual-alice-revoke',
            collectorVersion: 'test-1' },
        confidence: 'verified',
        evidence: null
    }));

    await Assert.rejects(() => ScanDaemon.commitPlan(value, plan), error =>
        error.code === 'STALE_SCAN_PLAN' && error.component === 'journal');
    const projection = Core.rebuild(await value.store.readAll());
    Assert.equal(projection.identities.activeLinks.length, 0);
    Assert.equal(projection.identities.findByIdentifier('101')[0].steamId, null);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);
});

Test('a concurrent exact-name owner invalidates a pending name-only reconciliation plan', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: null, battlemetricsPlayerId: null, exactName: 'Tree'
    }, 'pending-tree', 'discord-cinfo'));
    let announceProvider;
    let releaseProvider;
    const providerEntered = new Promise(resolve => { announceProvider = resolve; });
    const providerGate = new Promise(resolve => { releaseProvider = resolve; });
    const options = {
        ...value,
        planOnly: true,
        forceWarBanditsRescan: true,
        warBanditsProvider: {
            resolvePlayerRecent: async (_context, _scope, query) => {
                Assert.equal(query, 'Tree');
                announceProvider();
                await providerGate;
                return { available: true, ambiguous: false,
                    observedAt: '2026-10-03T12:00:00.000Z',
                    player: { steamId: STEAM_A, name: 'Tree', aliases: [], playtime: 1 } };
            }
        }
    };
    const planning = ScanDaemon.runCycle(options);
    await providerEntered;
    await value.store.append(identityEvent({
        steamId: STEAM_B, battlemetricsPlayerId: null, exactName: 'Tree'
    }, 'concurrent-tree-owner', 'steam-profile-current'));
    releaseProvider();
    const plan = await planning;
    Assert.equal(plan.identityGuards.some(guard => guard.steamId === STEAM_A &&
        guard.names.includes('tree')), true);

    await Assert.rejects(() => ScanDaemon.commitPlan(options, plan), error =>
        error.code === 'STALE_SCAN_PLAN' && error.component === 'journal');
    const events = await value.store.readAll();
    Assert.equal(events.some(event => event.subject.steamId === STEAM_A), false);
    Assert.equal(events.some(event => event.subject.steamId === STEAM_B), true);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);
});

Test('a rebased completion keeps manual reconciliation active for aliases appended during planning', async t => {
    const value = harness(t);
    const options = {
        ...value,
        planOnly: true,
        forceWarBanditsRescan: true,
        dependencies: {
            ...value.dependencies,
            battlemetricsProvider: { resolveSteamId: async () => ({ available: true, steamId: null }) }
        }
    };
    const plan = await ScanDaemon.runCycle(options);
    Assert.equal(plan.result.pendingReconciliationCompleted, true);
    await value.store.append(identityEvent({
        steamId: null, battlemetricsPlayerId: '777', exactName: 'Arrived During Scan'
    }, 'concurrent-pending', 'discord-cinfo'));

    const result = await ScanDaemon.commitPlan(options, plan);
    const state = JSON.parse(Fs.readFileSync(Path.join(value.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(result.pendingReconciliationActive, true);
    Assert.equal(result.pendingReconciliationCompleted, false);
    Assert.equal(state.pendingReconciliation.active, true);
    Assert.equal(state.pendingReconciliation.completedAt, null);
});

Test('a rebased plan rejects a stable identity pair conflicting with a concurrent correction', async t => {
    const value = harness(t);
    await value.store.append(identityEvent({
        steamId: null, battlemetricsPlayerId: '777', exactName: 'Pending Pair'
    }, 'pending-pair', 'discord-cinfo'));
    let announceProvider;
    let releaseProvider;
    const providerEntered = new Promise(resolve => { announceProvider = resolve; });
    const providerGate = new Promise(resolve => { releaseProvider = resolve; });
    const options = {
        ...value,
        planOnly: true,
        forceWarBanditsRescan: true,
        dependencies: {
            ...value.dependencies,
            battlemetricsProvider: {
                resolveSteamId: async () => {
                    announceProvider();
                    await providerGate;
                    return { available: true, reason: null, steamId: STEAM_A };
                }
            }
        }
    };
    const planning = ScanDaemon.runCycle(options);
    await providerEntered;
    await value.store.append(identityEvent({
        steamId: STEAM_B, battlemetricsPlayerId: '777', exactName: 'Manual Correction'
    }, 'manual-correction'));
    releaseProvider();
    const plan = await planning;
    Assert.equal(plan.events.some(event => event.subject.steamId === STEAM_A &&
        event.subject.battlemetricsPlayerId === '777'), true);

    await Assert.rejects(() => ScanDaemon.commitPlan(options, plan), error =>
        error.code === 'STALE_SCAN_PLAN' && error.component === 'journal');
    const events = await value.store.readAll();
    Assert.equal(events.some(event => event.subject.steamId === STEAM_A &&
        event.subject.battlemetricsPlayerId === '777'), false);
    Assert.equal(events.some(event => event.subject.steamId === STEAM_B &&
        event.subject.battlemetricsPlayerId === '777'), true);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);
});

Test('a checkpoint replacement during provider RPC rejects the complete plan before journal append', async t => {
    const value = harness(t);
    await ScanDaemon.runCycle(value);
    const file = Path.join(value.directory, 'scan-daemon.json');
    const beforeEvents = await value.store.readAll();
    let releaseProvider;
    let announceProvider;
    const providerEntered = new Promise(resolve => { announceProvider = resolve; });
    const providerGate = new Promise(resolve => { releaseProvider = resolve; });
    const planning = ScanDaemon.runCycle({
        ...value,
        planOnly: true,
        warBanditsProvider: {
            scanCurrentWipePage: async () => {
                announceProvider();
                await providerGate;
                return { available: true, observedAt: '2026-10-03T12:00:00.000Z', complete: true,
                    nextPage: null, rows: [{ steamId: STEAM_D, name: 'Dana', playtime: 12 }] };
            }
        }
    });

    await providerEntered;
    const replacement = JSON.parse(Fs.readFileSync(file, 'utf8'));
    replacement.updatedAt = '2026-10-03T12:00:01.000Z';
    const replacementText = `${JSON.stringify(replacement, null, 2)}\n`;
    Fs.writeFileSync(file, replacementText, 'utf8');
    releaseProvider();
    const plan = await planning;

    await Assert.rejects(() => ScanDaemon.commitPlan(value, plan), error =>
        error.code === 'STALE_SCAN_PLAN' && error.component === 'checkpoint');
    Assert.equal((await value.store.readAll()).length, beforeEvents.length);
    Assert.equal(Fs.readFileSync(file, 'utf8'), replacementText);
});

Test('commit captures validated plan scalars before an injected caller can mutate them', async t => {
    const value = harness(t);
    const mutablePlan = JSON.parse(JSON.stringify(await ScanDaemon.runCycle({ ...value, planOnly: true })));
    let announceCommit;
    let releaseCommit;
    const commitEntered = new Promise(resolve => { announceCommit = resolve; });
    const commitGate = new Promise(resolve => { releaseCommit = resolve; });
    const store = {
        directory: value.directory,
        appendManyIfRevision: async (...args) => {
            announceCommit();
            await commitGate;
            return value.store.appendManyIfRevision(...args);
        }
    };
    const committing = ScanDaemon.commitPlan({ ...value, store }, mutablePlan);
    await commitEntered;
    mutablePlan.baseRevision = `pi-revision:${'0'.repeat(64)}`;
    mutablePlan.baseControlRevision = `pi-control-revision:${'0'.repeat(64)}`;
    mutablePlan.baseStateRevision = `pi-scan-state:${'0'.repeat(64)}`;
    mutablePlan.result.pendingReconciliationCompleted =
        !mutablePlan.result.pendingReconciliationCompleted;
    releaseCommit();

    const result = await committing;
    Assert.equal(result.skipped, false);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), true);
});

Test('the scheduler automatically replans once after a stale worker snapshot', async t => {
    const value = harness(t);
    let calls = 0;
    const isolatedScanRunner = async options => {
        calls += 1;
        const plan = await ScanDaemon.runCycle({ ...options, isolateProcess: false, planOnly: true });
        if (calls === 1) {
            Fs.writeFileSync(Path.join(options.directory, 'scan-daemon.json'),
                `${JSON.stringify(plan.state, null, 2)}\n`, 'utf8');
        }
        return ScanDaemon.commitPlan(options, plan);
    };

    Assert.equal(ScanDaemon.schedule({
        ...value,
        isolateProcess: true,
        dependencies: { ...value.dependencies, isolatedScanRunner }
    }), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 2);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), true);
});

Test('the parent rejects a plan when the canonical runtime wipe changes before commit', async t => {
    const value = harness(t);
    let currentScope = value.scope;
    const options = { ...value, resolveCurrentScope: () => currentScope };
    const plan = await ScanDaemon.runCycle({ ...options, planOnly: true });
    currentScope = {
        ...value.scope,
        wipeId: 'wipe:2026-10-09T14:00:00.000Z',
        wipeStart: '2026-10-09T14:00:00.000Z'
    };

    await Assert.rejects(() => ScanDaemon.commitPlan(options, plan), error =>
        error.code === 'STALE_SCAN_PLAN' && error.component === 'scope');
    Assert.equal((await value.store.readAll()).length, 0);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);
});

Test('scan planning and commit reject split journal and checkpoint directories', async t => {
    const value = harness(t);
    const other = harness(t);
    const split = { ...value, directory: other.directory };

    await Assert.rejects(() => ScanDaemon.runCycle(split),
        /journal and checkpoint directories must match/u);
    const plan = await ScanDaemon.runCycle({ ...value, planOnly: true });
    await Assert.rejects(() => ScanDaemon.commitPlan(split, plan),
        /journal and checkpoint directories must match/u);
    Assert.throws(() => IsolatedScanDaemon.runCycle(split),
        /journal and checkpoint directories must match/u);
    Assert.equal((await value.store.readAll()).length, 0);
    Assert.equal(Fs.existsSync(Path.join(other.directory, 'scan-daemon.json')), false);
});

Test('continuous snapshot contention is bounded but a later scheduler tick can retry', async t => {
    const value = harness(t);
    let calls = 0;
    const isolatedScanRunner = async () => {
        calls += 1;
        throw new ScanDaemon.StaleScanPlanError('journal');
    };
    const options = {
        ...value,
        isolateProcess: true,
        dependencies: { ...value.dependencies, isolatedScanRunner }
    };

    Assert.equal(ScanDaemon.schedule(options), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 2);
    Assert.equal(ScanDaemon.schedule(options), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 4);
});

Test('the parent rejects a worker plan that escapes its requested journal scope', async t => {
    const value = harness(t);
    const plan = await ScanDaemon.runCycle({
        ...value,
        planOnly: true,
        warBanditsProvider: {
            scanCurrentWipePage: async () => ({
                available: true,
                observedAt: '2026-10-03T12:00:00.000Z',
                complete: true,
                nextPage: null,
                rows: [{ steamId: STEAM_D, name: 'Dana', playtime: 12 }]
            })
        }
    });
    const escaped = JSON.parse(JSON.stringify(plan));
    delete escaped.events[0].eventId;
    escaped.events[0].scope.guildId = 'another-guild';

    await Assert.rejects(() => ScanDaemon.commitPlan(value, escaped), /escaped its requested scope/u);
    Assert.equal((await value.store.readAll()).length, 0);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);
});

Test('the parent rejects unbounded or forged worker result metadata before writing', async t => {
    const value = harness(t);
    const plan = await ScanDaemon.runCycle({ ...value, planOnly: true });
    const forged = JSON.parse(JSON.stringify(plan));
    forged.result.appended += 1;
    forged.result.untrusted = 'free-form result';

    await Assert.rejects(() => ScanDaemon.commitPlan(value, forged), /plan result is invalid/u);
    Assert.equal((await value.store.readAll()).length, 0);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);
});

Test('the parent limits worker events to daemon observations and correlates result with state', async t => {
    const value = harness(t);
    const plan = await ScanDaemon.runCycle({
        ...value,
        planOnly: true,
        warBanditsProvider: {
            scanCurrentWipePage: async () => ({
                available: true,
                observedAt: '2026-10-03T12:00:00.000Z',
                complete: true,
                nextPage: null,
                rows: [{ steamId: STEAM_D, name: 'Dana', playtime: 12 }]
            })
        }
    });
    const capabilityEscape = JSON.parse(JSON.stringify(plan));
    capabilityEscape.events[0] = Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'events_superseded',
        observedAt: plan.events[0].observedAt,
        recordedAt: plan.events[0].recordedAt,
        scope: plan.events[0].scope,
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: null },
        payload: { eventIds: [plan.events[0].eventId], reason: 'forged worker capability' },
        provenance: {
            source: plan.events[0].provenance.source,
            sourceEventId: 'forged-supersession',
            collectorVersion: plan.events[0].provenance.collectorVersion
        },
        confidence: 'verified',
        evidence: null
    });
    await Assert.rejects(() => ScanDaemon.commitPlan(value, capabilityEscape),
        /outside the daemon event capability/u);

    const stateMismatch = JSON.parse(JSON.stringify(plan));
    stateMismatch.state.nextWarBanditsPage += 1;
    await Assert.rejects(() => ScanDaemon.commitPlan(value, stateMismatch),
        /result does not match its durable state/u);

    const nestedEscape = JSON.parse(JSON.stringify(plan));
    nestedEscape.state.pendingReconciliation.untrusted = 'must not persist';
    await Assert.rejects(() => ScanDaemon.commitPlan(value, nestedEscape),
        /checkpoint fields are invalid/u);

    const topLevelEscape = JSON.parse(JSON.stringify(plan));
    topLevelEscape.untrusted = 'must not be accepted';
    await Assert.rejects(() => ScanDaemon.commitPlan(value, topLevelEscape),
        /plan protocol is invalid/u);
    Assert.equal((await value.store.readAll()).length, 0);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);
});

Test('the parent rejects worker state for another server before appending valid events', async t => {
    const value = harness(t);
    const plan = await ScanDaemon.runCycle({
        ...value,
        planOnly: true,
        warBanditsProvider: {
            scanCurrentWipePage: async () => ({
                available: true,
                observedAt: '2026-10-03T12:00:00.000Z',
                complete: true,
                nextPage: null,
                rows: [{ steamId: STEAM_D, name: 'Dana', playtime: 12 }]
            })
        }
    });
    Assert.equal(plan.events.length > 0, true);
    const forged = JSON.parse(JSON.stringify(plan));
    forged.state.serverKey = 'battlemetrics:another-server';
    forged.state.untrusted = 'must not be persisted';

    await Assert.rejects(() => ScanDaemon.commitPlan(value, forged), /state escaped its requested scope/u);
    Assert.equal((await value.store.readAll()).length, 0);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);
});

Test('isolated scheduling keeps injected test work deterministic and in-process', async t => {
    const value = harness(t);
    let calls = 0;
    const isolatedScanRunner = async options => {
        calls += 1;
        return ScanDaemon.runCycle({ ...options, isolateProcess: false });
    };

    Assert.equal(ScanDaemon.schedule({
        ...value,
        isolateProcess: true,
        dependencies: { ...value.dependencies, isolatedScanRunner }
    }), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 1);
});

Test('background scan warning TTL distinguishes a new failure code or message', async t => {
    ScanDaemon.resetRuntimeCachesForTests();
    t.after(() => ScanDaemon.resetRuntimeCachesForTests());
    const value = harness(t);
    const warnings = [];
    value.context.rustplus.log = (_category, message, level) => warnings.push({ message, level });

    const rejectWith = (code, message) => ({
        ...value,
        isolateProcess: true,
        forceWarBanditsRescan: true,
        dependencies: {
            ...value.dependencies,
            isolatedScanRunner: async () => {
                const error = new Error(message);
                error.code = code;
                throw error;
            }
        }
    });
    const first = rejectWith('WORKER_EXITED', 'worker stopped at rebuilding');
    Assert.equal(ScanDaemon.schedule(first), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(ScanDaemon.schedule(first), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(warnings.length, 1);

    Assert.equal(ScanDaemon.schedule(rejectWith('WORKER_EXITED', 'worker stopped at finalizing')), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(ScanDaemon.schedule(rejectWith('WORKER_TIMEOUT', 'worker stopped at finalizing')), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(warnings.length, 3);
    Assert.deepEqual(warnings.map(item => item.level), ['warn', 'warn', 'warn']);
});

Test('a throwing scan logger cannot reject the scheduler boundary', async t => {
    ScanDaemon.resetRuntimeCachesForTests();
    t.after(() => ScanDaemon.resetRuntimeCachesForTests());
    const value = harness(t);
    value.context.rustplus.log = () => { throw new Error('logger unavailable'); };
    const options = {
        ...value,
        isolateProcess: true,
        forceWarBanditsRescan: true,
        dependencies: {
            ...value.dependencies,
            isolatedScanRunner: async () => {
                const error = new Error('worker failed safely');
                error.code = 'WORKER_FAILURE';
                throw error;
            }
        }
    };

    Assert.equal(ScanDaemon.schedule(options), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(ScanDaemon.getRuntimeStatus().active, 0);
    Assert.equal(ScanDaemon.schedule(options), true);
    await ScanDaemon.waitForIdle(value.directory);
});

Test('background scheduling contains clock and runner admission failures', t => {
    ScanDaemon.resetRuntimeCachesForTests();
    t.after(() => ScanDaemon.resetRuntimeCachesForTests());
    const value = harness(t);
    Assert.equal(ScanDaemon.schedule({
        ...value,
        isolateProcess: true,
        forceWarBanditsRescan: true,
        dependencies: {
            ...value.dependencies,
            now: () => { throw new Error('clock unavailable'); }
        }
    }), false);

    const dependencies = { ...value.dependencies };
    Object.defineProperty(dependencies, 'isolatedScanRunner', {
        enumerable: true,
        get() { throw new Error('runner unavailable'); }
    });
    Assert.equal(ScanDaemon.schedule({
        ...value,
        isolateProcess: true,
        forceWarBanditsRescan: true,
        dependencies
    }), false);
    Assert.equal(ScanDaemon.getRuntimeStatus().active, 0);
});

Test('the real scan worker can plan read-only work for a parent commit', async t => {
    const value = harness(t);
    value.scope.circular = value.scope;
    value.scope.battlemetrics.players[101].circular = value.scope.battlemetrics;
    const result = await IsolatedScanDaemon.runCycle({
        ...value,
        dependencies: value.dependencies,
        warBanditsProvider: null
    });

    Assert.equal(result.skipped, false);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), true);
    const status = IsolatedScanDaemon.getRuntimeStatus();
    Assert.equal(status.active, 0);
    Assert.equal(status.completed >= 1, true);
    Assert.equal(status.failures, 0);
    Assert.equal(status.stage, 'idle');
    Assert.equal(status.rssMiB, 0);
    Assert.equal(status.heapUsedMiB, 0);
});

Test('a worker crash after provider RPC cannot mutate the journal or scan state', async t => {
    const value = harness(t);
    let providerCalls = 0;
    value.dependencies.steamProfileIdentity = async steamId => {
        providerCalls += 1;
        Assert.equal(steamId, STEAM_A);
        return { steamId, currentName: 'Alice', pastAliases: [] };
    };
    const child = new FakeScanChild((message, instance) => {
        if (message.type === 'run') {
            queueMicrotask(() => instance.emit('message', {
                v: 1,
                type: 'provider_request',
                callId: 1,
                provider: 'steam',
                method: 'profileIdentity',
                args: [STEAM_A]
            }));
        }
        else if (message.type === 'provider_response') queueMicrotask(() => instance.crash(91));
    });

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => child }),
        error => error.code === 'WORKER_EXITED');
    Assert.equal(providerCalls, 1);
    Assert.equal((await value.store.readAll()).length, 0);
    Assert.equal(Fs.existsSync(Path.join(value.directory, 'scan-daemon.json')), false);
});

Test('isolated provider RPC rejects non-exact envelopes before invoking a provider', async t => {
    const value = harness(t);
    let providerCalls = 0;
    let response = null;
    value.dependencies.steamProfileIdentity = async () => {
        providerCalls += 1;
        return { steamId: STEAM_A, currentName: 'Alice', pastAliases: [] };
    };
    const child = new FakeScanChild((message, instance) => {
        if (message.type === 'run') {
            queueMicrotask(() => instance.emit('message', {
                v: 1,
                type: 'provider_request',
                callId: 1,
                provider: 'steam',
                method: 'profileIdentity',
                args: [STEAM_A],
                unexpected: 'private-forged-field'
            }));
        }
        else if (message.type === 'provider_response') {
            response = message;
            queueMicrotask(() => instance.crash(91));
        }
    });

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => child }),
        error => error.code === 'WORKER_EXITED');
    Assert.equal(providerCalls, 0);
    Assert.deepEqual(response, { v: 1, type: 'provider_response', callId: 1,
        ok: false, error: 'Player scan provider request is invalid.' });
    Assert.equal(JSON.stringify(response).includes('private-forged-field'), false);
});

Test('isolated provider RPC bounds simultaneous parent calls under a worker flood', async t => {
    const value = harness(t);
    let providerCalls = 0;
    const responses = [];
    const providerResolvers = [];
    value.dependencies.steamProfileIdentity = () => {
        providerCalls += 1;
        return new Promise(resolve => providerResolvers.push(resolve));
    };
    const child = new FakeScanChild((message, instance) => {
        if (message.type === 'run') {
            queueMicrotask(() => {
                for (let callId = 1; callId <= IsolatedScanDaemon.MAX_IN_FLIGHT_PROVIDER_CALLS + 3;
                    callId += 1) {
                    instance.emit('message', { v: 1, type: 'provider_request', callId,
                        provider: 'steam', method: 'profileIdentity', args: [STEAM_A] });
                }
                setImmediate(() => instance.crash(91));
            });
        }
        else if (message.type === 'provider_response') responses.push(message);
    });

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, {
        forkImpl: () => child,
        providerTimeoutMs: 1000
    }), error => error.code === 'WORKER_EXITED');
    Assert.equal(providerCalls, IsolatedScanDaemon.MAX_IN_FLIGHT_PROVIDER_CALLS);
    Assert.equal(responses.length, 3);
    Assert.equal(responses.every(item => item.ok === false &&
        item.error === 'Player scan provider request limit reached.'), true);
    for (const resolve of providerResolvers) resolve(null);
    await new Promise(resolve => setImmediate(resolve));
});

Test('a saturated provider circuit does not prevent another scan provider', async t => {
    const value = harness(t);
    let steamCalls = 0;
    let battlemetricsCalls = 0;
    const steamResolvers = [];
    value.dependencies.steamProfileIdentity = () => {
        steamCalls += 1;
        return new Promise(resolve => steamResolvers.push(resolve));
    };
    value.dependencies.battlemetricsProvider = {
        resolveSteamId: async battlemetricsPlayerId => {
            battlemetricsCalls += 1;
            return { available: true, steamId: STEAM_A, battlemetricsPlayerId };
        }
    };
    const saturatingChild = new FakeScanChild((message, instance) => {
        if (message.type !== 'run') return;
        queueMicrotask(() => {
            for (let callId = 1;
                callId <= IsolatedScanDaemon.MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER;
                callId += 1) {
                instance.emit('message', { v: 1, type: 'provider_request', callId,
                    provider: 'steam', method: 'profileIdentity', args: [STEAM_A] });
            }
            setImmediate(() => instance.crash(91));
        });
    });
    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, {
        forkImpl: () => saturatingChild,
        providerTimeoutMs: 1000
    }), error => error.code === 'WORKER_EXITED');
    Assert.equal(steamCalls, IsolatedScanDaemon.MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().providerInvocationsOutstanding,
        IsolatedScanDaemon.MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().providerCircuitsOpen, 1);
    Assert.equal(ScanDaemon.getRuntimeStatus().workerProviderInvocationsOutstanding,
        IsolatedScanDaemon.MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER);
    Assert.equal(ScanDaemon.getRuntimeStatus().workerProviderCircuitsOpen, 1);

    const mixedResponses = [];
    const mixedChild = new FakeScanChild((message, instance) => {
        if (message.type === 'run') {
            queueMicrotask(() => {
                instance.emit('message', { v: 1, type: 'provider_request', callId: 1,
                    provider: 'steam', method: 'profileIdentity', args: [STEAM_A] });
                instance.emit('message', { v: 1, type: 'provider_request', callId: 2,
                    provider: 'battlemetrics', method: 'resolveSteamId', args: ['101'] });
            });
        }
        else if (message.type === 'provider_response') {
            mixedResponses.push(message);
            if (mixedResponses.length === 2) queueMicrotask(() => instance.crash(91));
        }
    });
    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => mixedChild }),
        error => error.code === 'WORKER_EXITED');
    Assert.equal(steamCalls, IsolatedScanDaemon.MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER);
    Assert.equal(battlemetricsCalls, 1);
    Assert.equal(mixedResponses.find(item => item.callId === 1).error,
        'Player scan provider-specific capacity is exhausted.');
    Assert.equal(mixedResponses.find(item => item.callId === 2).ok, true);

    for (const resolve of steamResolvers) resolve(null);
    await new Promise(resolve => setImmediate(resolve));
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().providerInvocationsOutstanding, 0);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().providerCircuitsOpen, 0);
});

Test('isolated provider RPC globally bounds unresolved invocations across worker cycles', async t => {
    const value = harness(t);
    const providerResolvers = [];
    const providerCalls = { steam: 0, battlemetrics: 0, warbandits: 0 };
    value.dependencies.steamProfileIdentity = () => {
        providerCalls.steam += 1;
        return new Promise(resolve => providerResolvers.push(resolve));
    };
    value.dependencies.battlemetricsProvider = {
        resolveSteamId: () => {
            providerCalls.battlemetrics += 1;
            return new Promise(resolve => providerResolvers.push(resolve));
        }
    };
    value.warBanditsProvider = {
        resolvePlayer: () => {
            providerCalls.warbandits += 1;
            return new Promise(resolve => providerResolvers.push(resolve));
        }
    };
    const failedCycle = async (provider, method, args, count) => {
        const child = new FakeScanChild((message, instance) => {
            if (message.type !== 'run') return;
            queueMicrotask(() => {
                for (let callId = 1; callId <= count; callId += 1) {
                    instance.emit('message', { v: 1, type: 'provider_request', callId,
                        provider, method, args });
                }
                setImmediate(() => instance.crash(91));
            });
        });
        await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, {
            forkImpl: () => child,
            providerTimeoutMs: 1000
        }), error => error.code === 'WORKER_EXITED');
    };

    Assert.equal(IsolatedScanDaemon.MAX_OUTSTANDING_PROVIDER_INVOCATIONS,
        IsolatedScanDaemon.MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER * 2);
    await failedCycle('steam', 'profileIdentity', [STEAM_A], 3);
    await failedCycle('battlemetrics', 'resolveSteamId', ['101'], 3);
    await failedCycle('warbandits', 'resolvePlayer', ['Alice'], 2);
    Assert.equal(providerCalls.steam + providerCalls.battlemetrics + providerCalls.warbandits,
        IsolatedScanDaemon.MAX_OUTSTANDING_PROVIDER_INVOCATIONS);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().providerInvocationsOutstanding,
        IsolatedScanDaemon.MAX_OUTSTANDING_PROVIDER_INVOCATIONS);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().providerCircuitsOpen, 1);

    const responses = [];
    const blockedChild = new FakeScanChild((message, instance) => {
        if (message.type === 'run') {
            queueMicrotask(() => instance.emit('message', { v: 1, type: 'provider_request', callId: 1,
                provider: 'warbandits', method: 'resolvePlayer', args: ['Alice'] }));
        }
        else if (message.type === 'provider_response') {
            responses.push(message);
            queueMicrotask(() => instance.crash(91));
        }
    });
    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => blockedChild }),
        error => error.code === 'WORKER_EXITED');
    Assert.equal(providerCalls.warbandits, 2);
    Assert.deepEqual(responses, [{ v: 1, type: 'provider_response', callId: 1,
        ok: false, error: 'Player scan provider capacity is exhausted.' }]);

    for (const resolve of providerResolvers) resolve(null);
    await new Promise(resolve => setImmediate(resolve));
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().providerInvocationsOutstanding, 0);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().providerCircuitsOpen, 0);

    value.dependencies.steamProfileIdentity = async steamId => ({
        steamId, currentName: 'Alice', pastAliases: [], aliasesComplete: true
    });
    const recoveredResponses = [];
    const recoveredChild = new FakeScanChild((message, instance) => {
        if (message.type === 'run') {
            queueMicrotask(() => instance.emit('message', { v: 1, type: 'provider_request', callId: 1,
                provider: 'steam', method: 'profileIdentity', args: [STEAM_A] }));
        }
        else if (message.type === 'provider_response') {
            recoveredResponses.push(message);
            queueMicrotask(() => instance.crash(91));
        }
    });
    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => recoveredChild }),
        error => error.code === 'WORKER_EXITED');
    Assert.equal(recoveredResponses.length, 1);
    Assert.equal(recoveredResponses[0].ok, true);
});

Test('isolated provider RPC times out below the worker deadline and ignores a late result', async t => {
    const value = harness(t);
    const plan = await ScanDaemon.runCycle({ ...value, planOnly: true });
    let resolveProvider;
    value.dependencies.steamProfileIdentity = () => new Promise(resolve => { resolveProvider = resolve; });
    const responses = [];
    const child = new FakeScanChild((message, instance) => {
        if (message.type === 'run') {
            queueMicrotask(() => instance.emit('message', { v: 1, type: 'provider_request', callId: 1,
                provider: 'steam', method: 'profileIdentity', args: [STEAM_A] }));
        }
        else if (message.type === 'provider_response') {
            responses.push(message);
            if (message.ok === false) {
                queueMicrotask(() => instance.emit('message', { v: 1, type: 'result', plan }));
            }
        }
    });

    Assert.equal(IsolatedScanDaemon.PROVIDER_CALL_TIMEOUT_MS < IsolatedScanDaemon.WORKER_TIMEOUT_MS, true);
    const result = await IsolatedScanDaemon.runCycle(value, {
        forkImpl: () => child,
        timeoutMs: 1000,
        providerTimeoutMs: 10
    });
    Assert.equal(result.skipped, false);
    Assert.deepEqual(responses, [{ v: 1, type: 'provider_response', callId: 1,
        ok: false, error: 'Player scan provider request timed out.' }]);

    let latePayloadReads = 0;
    const lateResult = { steamId: STEAM_A, pastAliases: [] };
    Object.defineProperty(lateResult, 'currentName', { enumerable: true, get: () => {
        latePayloadReads += 1;
        return 'late-private-name';
    } });
    resolveProvider(lateResult);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    Assert.equal(responses.length, 1);
    Assert.equal(latePayloadReads, 0);
});

Test('isolated worker telemetry returns to zero after payload and spawn failures', async t => {
    const invalidPayload = harness(t);
    invalidPayload.dependencies.now = () => new Date('invalid');
    await Assert.rejects(() => IsolatedScanDaemon.runCycle(invalidPayload), /clock is invalid/u);
    Assert.deepEqual({
        stage: IsolatedScanDaemon.getRuntimeStatus().stage,
        rssMiB: IsolatedScanDaemon.getRuntimeStatus().rssMiB,
        heapUsedMiB: IsolatedScanDaemon.getRuntimeStatus().heapUsedMiB
    }, { stage: 'idle', rssMiB: 0, heapUsedMiB: 0 });

    const failedSpawn = harness(t);
    await Assert.rejects(() => IsolatedScanDaemon.runCycle(failedSpawn, {
        forkImpl: () => { throw new Error('private spawn failure'); }
    }), error => error.code === 'WORKER_SPAWN_FAILED');
    const status = IsolatedScanDaemon.getRuntimeStatus();
    Assert.deepEqual({ stage: status.stage, rssMiB: status.rssMiB, heapUsedMiB: status.heapUsedMiB },
        { stage: 'idle', rssMiB: 0, heapUsedMiB: 0 });
});

Test('isolated worker diagnostics retain bounded progress and only a safe stderr classification', async t => {
    const value = harness(t);
    const privateValue = 'private-player-name-and-token';
    let forkOptions = null;
    /** @type {any} */
    let liveStatus = null;
    const child = new FakeScanChild((message, instance) => {
        if (message.type !== 'run') return;
        instance.emit('message', { v: 1, type: 'progress', stage: 'rebuilding',
            rssMiB: 701, heapUsedMiB: 512 });
        liveStatus = IsolatedScanDaemon.getRuntimeStatus();
        instance.emit('message', { v: 1, type: 'progress', stage: 'not-a-stage',
            rssMiB: 999999, heapUsedMiB: 999999 });
        instance.stderr.write(`${privateValue.repeat(2000)}\n` +
            'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n');
        queueMicrotask(() => instance.crash(134));
    });

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, {
        forkImpl: (_path, _args, options) => { forkOptions = options; return child; }
    }), error => {
        Assert.equal(error.code, 'WORKER_EXITED');
        Assert.match(error.message, /stderr: JavaScript heap out of memory/u);
        Assert.equal(error.message.includes(privateValue), false);
        return true;
    });

    Assert.deepEqual(forkOptions.stdio, ['ignore', 'ignore', 'pipe', 'ipc']);
    Assert.equal(liveStatus.stage, 'rebuilding');
    Assert.equal(liveStatus.rssMiB, 701);
    Assert.equal(liveStatus.heapUsedMiB, 512);
    const status = IsolatedScanDaemon.getRuntimeStatus();
    Assert.equal(status.active, 0);
    Assert.equal(status.stage, 'idle');
    Assert.equal(status.rssMiB, 0);
    Assert.equal(status.heapUsedMiB, 0);
    Assert.equal(status.lastCode, 'WORKER_EXITED');
    Assert.equal(status.lastStage, 'rebuilding');
    Assert.match(status.lastMessage, /JavaScript heap out of memory/u);
    Assert.equal(status.lastMessage.includes(privateValue), false);
    Assert.equal(Number.isNaN(Date.parse(status.lastAt)), false);
    Assert.equal(status.consecutiveFailures > 0, true);

    const plan = await ScanDaemon.runCycle({ ...value, planOnly: true });
    const successChild = new FakeScanChild((message, instance) => {
        if (message.type !== 'run') return;
        instance.emit('message', { v: 1, type: 'progress', stage: 'finalizing',
            rssMiB: 222, heapUsedMiB: 111 });
        queueMicrotask(() => instance.emit('message', { v: 1, type: 'result', plan }));
    });
    await IsolatedScanDaemon.runCycle(value, { forkImpl: () => successChild });
    const recovered = IsolatedScanDaemon.getRuntimeStatus();
    Assert.equal(recovered.consecutiveFailures, 0);
    Assert.equal(recovered.lastCode, 'WORKER_EXITED');
    Assert.equal(recovered.rssMiB, 0);
    Assert.equal(recovered.heapUsedMiB, 0);
});

Test('isolated worker process errors include only classified stderr in retained diagnostics', async t => {
    const value = harness(t);
    const privateValue = 'private-stderr-player-name';
    const child = new FakeScanChild((message, instance) => {
        if (message.type !== 'run') return;
        instance.emit('message', { v: 1, type: 'progress', stage: 'reading_history',
            rssMiB: 200, heapUsedMiB: 100 });
        instance.stderr.write(`${privateValue}\nTypeError: internal worker failure\n`);
        queueMicrotask(() => instance.fail(new Error('child transport failed')));
    });

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => child }), error => {
        Assert.equal(error.code, 'WORKER_ERROR');
        Assert.match(error.message, /stderr: uncaught TypeError/u);
        return true;
    });
    const status = IsolatedScanDaemon.getRuntimeStatus();
    Assert.equal(status.lastCode, 'WORKER_ERROR');
    Assert.equal(status.lastStage, 'reading_history');
    Assert.match(status.lastMessage, /stderr: uncaught TypeError/u);
    Assert.equal(status.lastMessage.includes(privateValue), false);
});

Test('isolated worker reports a failed final IPC delivery without exposing stderr details', async t => {
    const value = harness(t);
    const privateValue = 'private-plan-and-player-value';
    const child = new FakeScanChild((message, instance) => {
        if (message.type !== 'run') return;
        instance.emit('message', { v: 1, type: 'progress', stage: 'sending_result',
            rssMiB: 200, heapUsedMiB: 100 });
        instance.stderr.write(`${privateValue}\n${PlayerScanIpc.FINAL_SEND_FAILURE_MARKER}\n`);
        queueMicrotask(() => instance.crash(PlayerScanIpc.FINAL_SEND_FAILURE_EXIT_CODE));
    });

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => child }), error => {
        Assert.equal(error.code, 'WORKER_EXITED');
        Assert.match(error.message, /stderr: final IPC result delivery failed/u);
        Assert.equal(error.message.includes(privateValue), false);
        return true;
    });
    const status = IsolatedScanDaemon.getRuntimeStatus();
    Assert.equal(status.lastStage, 'sending_result');
    Assert.match(status.lastMessage, /stderr: final IPC result delivery failed/u);
    Assert.equal(status.lastMessage.includes(privateValue), false);
});

Test('the isolated payload bounds BattleMetrics tables while projecting them', async t => {
    const value = harness(t);
    value.scope.battlemetrics.players = {};
    value.scope.battlemetrics.onlinePlayers = [];
    for (let index = 1; index <= 20005; index += 1) {
        const id = `${index}`;
        value.scope.battlemetrics.players[id] = { id, name: `Player ${id}`, status: true };
        value.scope.battlemetrics.onlinePlayers.push(id);
    }
    let inspected = false;
    const child = new FakeScanChild((message, instance) => {
        if (message.type !== 'run') return;
        inspected = true;
        Assert.equal(Object.keys(message.payload.scope.battlemetrics.players).length, 20000);
        Assert.equal(message.payload.scope.battlemetrics.onlinePlayers.length, 20000);
        queueMicrotask(() => instance.crash(93));
    });

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => child }),
        error => error.code === 'WORKER_EXITED');
    Assert.equal(inspected, true);

    let numericReads = 0;
    const sparse = new Array(1000000);
    value.scope.battlemetrics.onlinePlayers = new Proxy(sparse, {
        get: (target, property, receiver) => {
            if (typeof property === 'string' && /^\d+$/u.test(property)) numericReads += 1;
            return Reflect.get(target, property, receiver);
        }
    });
    const sparseChild = new FakeScanChild((message, instance) => {
        if (message.type === 'run') queueMicrotask(() => instance.crash(94));
    });
    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => sparseChild }),
        error => error.code === 'WORKER_EXITED');
    Assert.equal(numericReads, 20000);
});

Test('isolated scans use one global FIFO and coalesce a queued server without starvation', async t => {
    const first = harness(t);
    const second = harness(t);
    const latestScope = {
        ...second.scope,
        wipeId: 'wipe:2026-10-09T14:00:00.000Z',
        wipeStart: '2026-10-09T14:00:00.000Z'
    };
    const secondOptions = { ...second, resolveCurrentScope: () => latestScope };
    const child = new FakeScanChild();
    let forks = 0;
    const forkImpl = () => {
        forks += 1;
        return child;
    };
    const active = IsolatedScanDaemon.runCycle(first, { forkImpl });
    const queued = IsolatedScanDaemon.runCycle(secondOptions);
    const coalesced = IsolatedScanDaemon.runCycle({ ...secondOptions, forceWarBanditsRescan: true });

    Assert.equal(forks, 1);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().active, 1);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().queued, 1);
    child.crash(92);
    await Assert.rejects(() => active, error => error.code === 'WORKER_EXITED');
    const [queuedResult, coalescedResult] = await Promise.all([queued, coalesced]);
    Assert.equal(queuedResult.skipped, false);
    Assert.deepEqual(coalescedResult, queuedResult);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().active, 0);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().queued, 0);
    Assert.equal(Fs.existsSync(Path.join(second.directory, 'scan-daemon.json')), true);
    const state = JSON.parse(Fs.readFileSync(Path.join(second.directory, 'scan-daemon.json'), 'utf8'));
    Assert.equal(state.wipeId, latestScope.wipeId);
});

Test('a manual rescan bypasses the completed-sweep delay and enforces a cooldown', async t => {
    ScanDaemon.resetRuntimeCachesForTests();
    t.after(() => ScanDaemon.resetRuntimeCachesForTests());
    const value = harness(t);
    let calls = 0;
    const warBanditsProvider = {
        scanCurrentWipePage: async () => {
            calls += 1;
            return { available: true, observedAt: value.battlemetrics.updatedAt,
                complete: true, nextPage: null, rows: [] };
        }
    };
    await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    value.setNow('2026-10-03T12:01:00.000Z');

    const request = ScanDaemon.requestRescan({ ...value, warBanditsProvider });
    Assert.deepEqual(request, { accepted: true, state: 'started', retryAfterSeconds: 0 });
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 2);
    const cooldown = ScanDaemon.requestRescan({ ...value, warBanditsProvider });
    Assert.equal(cooldown.accepted, false);
    Assert.equal(cooldown.state, 'cooldown');
    Assert.equal(cooldown.retryAfterSeconds, 300);
    Assert.deepEqual(ScanDaemon.getRuntimeCacheStatus(value.dependencies.now().getTime()), {
        manualTriggers: 1,
        manualTriggerLimit: 256,
        automaticBackoffs: 0,
        automaticBackoffLimit: 256,
        automaticBackoffSkips: 0,
        warnings: 0,
        warningLimit: 256
    });

    value.setNow('2026-10-03T12:05:59.000Z');
    Assert.equal(ScanDaemon.requestRescan({ ...value, warBanditsProvider }).retryAfterSeconds, 1);
    value.setNow('2026-10-03T12:06:00.000Z');
    Assert.deepEqual(ScanDaemon.requestRescan({ ...value, warBanditsProvider }),
        { accepted: true, state: 'started', retryAfterSeconds: 0 });
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 3);
});

Test('automatic scan failures back off per directory while manual scans bypass and success resets it', async t => {
    ScanDaemon.resetRuntimeCachesForTests();
    t.after(() => ScanDaemon.resetRuntimeCachesForTests());
    const value = harness(t);
    const other = harness(t);
    let calls = 0;
    let shouldFail = true;
    const isolatedScanRunner = async () => {
        calls += 1;
        if (!shouldFail) return { skipped: false };
        const error = new Error(`isolated worker failure while processing item ${calls}`);
        error.code = 'WORKER_EXITED';
        throw error;
    };
    const options = {
        ...value,
        isolateProcess: true,
        dependencies: { ...value.dependencies, isolatedScanRunner }
    };

    Assert.equal(ScanDaemon.schedule(options), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 1);
    Assert.deepEqual(ScanDaemon.getRuntimeCacheStatus(value.dependencies.now().getTime()), {
        manualTriggers: 0,
        manualTriggerLimit: 256,
        automaticBackoffs: 1,
        automaticBackoffLimit: 256,
        automaticBackoffSkips: 0,
        warnings: 1,
        warningLimit: 256
    });

    value.setNow('2026-10-03T12:04:59.000Z');
    Assert.equal(ScanDaemon.schedule(options), false);
    Assert.equal(calls, 1);

    // A different directory remains independent from this server's failure state.
    const otherOptions = {
        ...other,
        isolateProcess: true,
        dependencies: { ...other.dependencies, isolatedScanRunner: async () => ({ skipped: false }) }
    };
    Assert.equal(ScanDaemon.schedule(otherOptions), true);
    await ScanDaemon.waitForIdle(other.directory);

    value.setNow('2026-10-03T12:05:00.000Z');
    Assert.equal(ScanDaemon.schedule(options), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 2);

    // The stable failure code doubles the delay even when per-item/provider details change in its message.
    value.setNow('2026-10-03T12:10:00.000Z');
    Assert.equal(ScanDaemon.schedule(options), false);
    Assert.equal(calls, 2);
    Assert.equal(ScanDaemon.getRuntimeCacheStatus(value.dependencies.now().getTime()).automaticBackoffSkips, 2);

    shouldFail = false;
    Assert.deepEqual(ScanDaemon.requestRescan(options),
        { accepted: true, state: 'started', retryAfterSeconds: 0 });
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 3);
    Assert.equal(ScanDaemon.getRuntimeCacheStatus(value.dependencies.now().getTime()).automaticBackoffs, 0);

    // The successful forced run reset the failure state, so an automatic cycle can start immediately.
    Assert.equal(ScanDaemon.schedule(options), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 4);
});

Test('a manual rescan queues one forced cycle behind an active cycle', async t => {
    const value = harness(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const warBanditsProvider = {
        scanCurrentWipePage: async () => {
            calls += 1;
            if (calls === 1) await gate;
            return { available: false, rows: [] };
        }
    };

    Assert.equal(ScanDaemon.schedule({ ...value, warBanditsProvider }), true);
    await new Promise(resolve => setImmediate(resolve));
    Assert.deepEqual(ScanDaemon.requestRescan({ ...value, warBanditsProvider }),
        { accepted: true, state: 'queued', retryAfterSeconds: 0 });
    Assert.equal(ScanDaemon.getRuntimeStatus().active, 1);
    Assert.equal(ScanDaemon.getRuntimeStatus().forcedRerunsQueued, 1);
    release();
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 2);
    Assert.equal(ScanDaemon.getRuntimeStatus().active, 0);
    Assert.equal(ScanDaemon.getRuntimeStatus().forcedRerunsQueued, 0);
});

Test('a queued manual rescan stays forced and receives its own stale retry', async t => {
    ScanDaemon.resetRuntimeCachesForTests();
    t.after(() => ScanDaemon.resetRuntimeCachesForTests());
    const value = harness(t);
    let releaseFirst;
    let announceFirst;
    const firstEntered = new Promise(resolve => { announceFirst = resolve; });
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const forcedCalls = [];
    const isolatedScanRunner = async options => {
        forcedCalls.push(options.forceWarBanditsRescan === true);
        if (forcedCalls.length === 1) {
            announceFirst();
            await firstGate;
            throw new ScanDaemon.StaleScanPlanError('journal');
        }
        if (forcedCalls.length === 2) throw new ScanDaemon.StaleScanPlanError('checkpoint');
        return { skipped: false };
    };
    const options = {
        ...value,
        isolateProcess: true,
        dependencies: { ...value.dependencies, isolatedScanRunner }
    };

    Assert.equal(ScanDaemon.schedule(options), true);
    await firstEntered;
    Assert.deepEqual(ScanDaemon.requestRescan(options),
        { accepted: true, state: 'queued', retryAfterSeconds: 0 });
    releaseFirst();
    await ScanDaemon.waitForIdle(value.directory);

    Assert.deepEqual(forcedCalls, [false, true, true]);
    Assert.equal(ScanDaemon.getRuntimeStatus().forcedRerunsQueued, 0);
});

Test('a queued manual rescan survives a temporarily full isolated worker queue', async t => {
    ScanDaemon.resetRuntimeCachesForTests();
    t.after(() => ScanDaemon.resetRuntimeCachesForTests());
    const value = harness(t);
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const forcedCalls = [];
    const isolatedScanRunner = options => {
        forcedCalls.push(options.forceWarBanditsRescan === true);
        if (forcedCalls.length === 1) return firstGate;
        if (forcedCalls.length === 2) {
            const error = new Error('queue full');
            error.code = 'WORKER_QUEUE_FULL';
            throw error;
        }
        return Promise.resolve({ skipped: false });
    };
    const options = {
        ...value,
        isolateProcess: true,
        dependencies: { ...value.dependencies, isolatedScanRunner }
    };

    Assert.equal(ScanDaemon.schedule(options), true);
    Assert.deepEqual(ScanDaemon.requestRescan(options),
        { accepted: true, state: 'queued', retryAfterSeconds: 0 });
    releaseFirst({ skipped: false });
    await ScanDaemon.waitForIdle(value.directory);

    Assert.deepEqual(forcedCalls, [false, true]);
    Assert.equal(ScanDaemon.getRuntimeStatus().forcedRerunsQueued, 1);
    Assert.equal(ScanDaemon.getRuntimeCacheStatus(value.dependencies.now().getTime()).manualTriggers, 0);
    Assert.equal(ScanDaemon.schedule(options), true);
    await ScanDaemon.waitForIdle(value.directory);
    Assert.deepEqual(forcedCalls, [false, true, true]);
    Assert.equal(ScanDaemon.getRuntimeStatus().forcedRerunsQueued, 0);
});

Test('failed isolated admission does not consume the manual rescan cooldown', async t => {
    ScanDaemon.resetRuntimeCachesForTests();
    t.after(() => ScanDaemon.resetRuntimeCachesForTests());
    const value = harness(t);
    const unavailable = new Error('queue full');
    unavailable.code = 'WORKER_QUEUE_FULL';
    const first = ScanDaemon.requestRescan({
        ...value,
        isolateProcess: true,
        dependencies: { ...value.dependencies, isolatedScanRunner: () => { throw unavailable; } }
    });
    Assert.deepEqual(first, { accepted: false, state: 'unavailable', retryAfterSeconds: 0 });

    let calls = 0;
    const second = ScanDaemon.requestRescan({
        ...value,
        isolateProcess: true,
        dependencies: {
            ...value.dependencies,
            isolatedScanRunner: async options => {
                calls += 1;
                return ScanDaemon.runCycle({ ...options, isolateProcess: false });
            }
        }
    });
    Assert.deepEqual(second, { accepted: true, state: 'started', retryAfterSeconds: 0 });
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 1);
    Assert.equal(ScanDaemon.requestRescan(value).state, 'cooldown');
});

Test('isolated admission rejects an oversized stable candidate array before spawning', t => {
    const value = harness(t);
    let forks = 0;
    const candidates = new Array(IsolatedScanDaemon.MAX_STABLE_IDENTITY_CANDIDATES + 1);

    Assert.throws(() => IsolatedScanDaemon.runCycle({ ...value, stableIdentityCandidates: candidates }, {
        forkImpl: () => { forks += 1; return new FakeScanChild(); }
    }), error => error.code === 'STABLE_IDENTITY_CANDIDATES_TOO_LARGE');
    Assert.equal(forks, 0);
});

Test('isolated admission bounds aggregate stable candidate bytes before spawning', t => {
    const value = harness(t);
    let forks = 0;
    const largeCandidate = Object.freeze({
        steamId: STEAM_A,
        battlemetricsPlayerId: '12345678901234567890123456789012',
        name: '😀'.repeat(128),
        observedAt: '2026-10-03T12:00:00.000Z',
        source: 'teammate-language-database',
        sourceEventId: '€'.repeat(256)
    });
    const candidates = new Array(IsolatedScanDaemon.MAX_STABLE_IDENTITY_CANDIDATES).fill(largeCandidate);

    Assert.throws(() => IsolatedScanDaemon.runCycle({ ...value, stableIdentityCandidates: candidates }, {
        forkImpl: () => { forks += 1; return new FakeScanChild(); }
    }), error => error.code === 'STABLE_IDENTITY_CANDIDATES_TOO_LARGE');
    Assert.equal(forks, 0);
    Assert.equal(IsolatedScanDaemon.MAX_STABLE_IDENTITY_CANDIDATE_BYTES, 12 * 1024 * 1024);
});

Test('parent IPC run callback failures reject immediately without leaking callback details', async t => {
    const value = harness(t);
    const privateError = 'private-run-ipc-callback-value';
    const child = new FakeScanChild();
    child.send = (_message, callback) => {
        queueMicrotask(() => callback(new Error(privateError)));
        return true;
    };

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => child, timeoutMs: 5000 }),
        error => {
            Assert.equal(error.code, 'WORKER_IPC_SEND_FAILED');
            Assert.equal(error.message.includes(privateError), false);
            return true;
        });
});

Test('parent IPC provider-response callback failures terminate the cycle safely', async t => {
    const value = harness(t);
    const privateError = 'private-provider-response-callback-value';
    const child = new FakeScanChild((message, instance) => {
        if (message.type === 'run') queueMicrotask(() => instance.emit('message', {
            v: 1, type: 'provider_request', callId: 1, provider: 'steam',
            method: 'profileIdentity', args: [STEAM_A]
        }));
    });
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
        if (message.type !== 'provider_response') return originalSend(message, callback);
        queueMicrotask(() => callback(new Error(privateError)));
        return true;
    };

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => child, timeoutMs: 5000 }),
        error => {
            Assert.equal(error.code, 'WORKER_IPC_SEND_FAILED');
            Assert.equal(error.message.includes(privateError), false);
            return true;
        });
});

Test('worker warnings are deduplicated across one-shot children and stderr errors stay guarded', async t => {
    const value = harness(t);
    const logs = [];
    value.context.rustplus.log = (...args) => logs.push(args);
    const warning = 'same-parent-warning-dedup-test';
    const childForCycle = () => new FakeScanChild((message, instance) => {
        if (message.type !== 'run') return;
        queueMicrotask(() => {
            instance.stderr.emit('error', new Error('guarded stderr test error'));
            instance.emit('message', { v: 1, type: 'warning', message: warning });
            instance.emit('message', { v: 1, type: 'failure', code: 'EXPECTED_TEST_FAILURE',
                message: 'expected test failure' });
        });
    });

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: childForCycle }));
    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: childForCycle }));
    Assert.equal(logs.filter(entry => entry[1] === warning).length, 1);

    value.context.rustplus.log = () => { throw new Error('optional logger failure'); };
    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () =>
        new FakeScanChild((message, instance) => {
            if (message.type !== 'run') return;
            queueMicrotask(() => {
                instance.emit('message', { v: 1, type: 'warning', message: 'throwing-logger-warning' });
                instance.emit('message', { v: 1, type: 'failure', code: 'EXPECTED_WORKER_FAILURE',
                    message: 'expected worker failure' });
            });
        })
    }), error => error.code === 'EXPECTED_WORKER_FAILURE');
});

Test('oversized provider aliases are an unavailable response instead of a false no-match', async t => {
    const value = harness(t);
    value.dependencies.steamProfileIdentity = async () => ({
        steamId: STEAM_A,
        currentName: 'Alice',
        pastAliases: Array.from({ length: 257 }, (_unused, index) => ({
            name: `Alias ${index}`, timeChanged: null
        })),
        aliasesComplete: true
    });
    let response = null;
    const child = new FakeScanChild((message, instance) => {
        if (message.type === 'run') {
            queueMicrotask(() => instance.emit('message', {
                v: 1, type: 'provider_request', callId: 1, provider: 'steam',
                method: 'profileIdentity', args: [STEAM_A]
            }));
        }
        else if (message.type === 'provider_response') {
            response = message;
            queueMicrotask(() => instance.emit('message', { v: 1, type: 'failure',
                code: 'EXPECTED_TEST_FAILURE', message: 'expected test failure' }));
        }
    });

    await Assert.rejects(() => IsolatedScanDaemon.runCycle(value, { forkImpl: () => child }),
        error => error.code === 'EXPECTED_TEST_FAILURE');
    Assert.equal(response.ok, false);
    Assert.equal(response.error, 'Player scan provider response exceeded its limit.');
});

Test('scan daemon shutdown waits for an active parent commit and remains idempotent', async t => {
    const value = harness(t);
    const plan = await ScanDaemon.runCycle({ ...value, planOnly: true });
    let announceCommit;
    let releaseCommit;
    const commitEntered = new Promise(resolve => { announceCommit = resolve; });
    const commitGate = new Promise(resolve => { releaseCommit = resolve; });
    const store = {
        directory: value.directory,
        appendManyIfRevision: async (...args) => {
            announceCommit();
            await commitGate;
            return value.store.appendManyIfRevision(...args);
        }
    };
    const child = new FakeScanChild((message, instance) => {
        if (message.type === 'run') {
            queueMicrotask(() => instance.emit('message', { v: 1, type: 'result', plan }));
        }
    });
    const active = IsolatedScanDaemon.runCycle({ ...value, store }, { forkImpl: () => child });
    await commitEntered;

    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().active, 1);
    const first = ScanDaemon.shutdown();
    const second = ScanDaemon.shutdown();
    Assert.strictEqual(second, first);
    let stopped = false;
    void first.then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    Assert.equal(stopped, false);
    releaseCommit();
    await active;
    await first;
    Assert.equal(child.signalCode, 'SIGTERM');
    Assert.equal(stopped, true);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().active, 0);
    Assert.equal(IsolatedScanDaemon.getRuntimeStatus().queued, 0);
});
