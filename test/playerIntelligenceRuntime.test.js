const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence');
const Runtime = require('../src/plugins/playerIntelligence/runtime.js');

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
    const rows = Object.freeze([Object.freeze({
        steamId: '76561198036538266', battlemetricsPlayerId: '777', name: 'Dante',
        observedAt: '2026-09-30T08:00:00.000Z'
    })]);
    value.client.playerIntelligenceDependencies.identityHistory = { getIdentityRows: () => rows };
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    const projection = Core.rebuild(await value.store().readAll());
    const person = projection.identities.persons.find(item => item.steamId === '76561198036538266');
    Assert.equal(person.battlemetricsPlayerIds.includes('777'), true);
    Assert.equal(person.names[0].name, 'Dante');
    Assert.equal(rows[0].name, 'Dante');
});

Test('BattleMetrics ingestion records initial presence, outage unknown and recovery without false logout', async t => {
    const value = harness(t);
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
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

Test('compact commands expose only useful identity, affinity and conservative activity', async t => {
    const value = harness(t);
    await Runtime.onBattlemetricsUpdated(value.context({ firstTime: true }));
    const intel = await Runtime.handleCommand(value.command('!intel Alice'));
    Assert.equal(intel.handled, true);
    Assert.match(intel.response[0], new RegExp(`^Alice \\| Steam:${STEAM_A} \\| BM:101 \\| on$`));
    Assert.equal(intel.response[1], 'Known tags: none');
    Assert.equal(intel.response[2], 'Played with: none');
    Assert.equal(intel.response.every(line => Array.from(line).length <= 122), true);

    value.setNow('2026-10-01T10:30:00.000Z');
    value.battlemetrics.updatedAt = '2026-10-01T10:30:00.000Z';
    value.battlemetrics.newPlayers = [];
    value.battlemetrics.logoutPlayers = ['101'];
    value.battlemetrics.players[101].status = false;
    await Runtime.onBattlemetricsUpdated(value.context());
    const activity = await Runtime.handleCommand(value.command('!activity Alice all'));
    Assert.equal(activity.response, 'Activity all: 0h30m');
});
