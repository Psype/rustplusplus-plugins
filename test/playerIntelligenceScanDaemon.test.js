const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence');
const ScanDaemon = require('../src/plugins/playerIntelligence/scanDaemon.js');

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
        monotonicNow += 7000;
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
    Assert.equal(battlemetrics.pendingWarBanditsAttempts, 1);
    Assert.equal(battlemetricsCalls, 1);
    Assert.deepEqual(warBanditsCalls, ['BAD OCR']);

    value.setNow('2026-10-03T12:01:00.000Z');
    const rejectedAlias = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(rejectedAlias.pendingWarBanditsAttempts, 1);
    Assert.equal(rejectedAlias.pendingIdentitiesLinked, 1);
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
    Assert.deepEqual(ScanDaemon.getRuntimeStatus(), { active: 1, forcedRerunsQueued: 0 });
    await new Promise(resolve => setImmediate(resolve));
    Assert.equal(ScanDaemon.schedule({ ...value, warBanditsProvider }), false);
    release();
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 1);
    Assert.deepEqual(ScanDaemon.getRuntimeStatus(), { active: 0, forcedRerunsQueued: 0 });
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
    Assert.deepEqual(ScanDaemon.getRuntimeStatus(), { active: 1, forcedRerunsQueued: 1 });
    release();
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 2);
    Assert.deepEqual(ScanDaemon.getRuntimeStatus(), { active: 0, forcedRerunsQueued: 0 });
});
