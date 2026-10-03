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

function identityEvent(subject, sourceEventId) {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_observed',
        observedAt: '2026-10-02T14:01:00.000Z',
        recordedAt: '2026-10-02T14:01:00.000Z',
        scope: { guildId: 'guild', serverKey: 'battlemetrics:42',
            wipeId: 'wipe:2026-10-02T14:00:00.000Z' },
        subject,
        payload: { caseFidelity: true },
        provenance: { source: 'test', sourceEventId, collectorVersion: 'test-1' },
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
                    { steamId: STEAM_C, name: 'Charlie' },
                    { steamId: STEAM_D, name: 'Dana' }
                ]
            };
        }
    };

    const first = await ScanDaemon.runCycle({ ...value, warBanditsProvider });
    Assert.equal(first.appended, 4);
    Assert.equal(first.onlineRefreshed, 3);
    Assert.equal(first.warBanditsSeen, 2);
    Assert.equal(requests, 1);

    const projection = Core.rebuild(await value.store.readAll());
    Assert.equal(projection.identities.findByIdentifier('103')[0].steamId, STEAM_C);
    Assert.equal(projection.identities.findByIdentifier(STEAM_D)[0].names.some(name => name.name === 'Dana'), true);
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
    await new Promise(resolve => setImmediate(resolve));
    Assert.equal(ScanDaemon.schedule({ ...value, warBanditsProvider }), false);
    release();
    await ScanDaemon.waitForIdle(value.directory);
    Assert.equal(calls, 1);
});
