const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { performance } = require('node:perf_hooks');

const Runtime = require('../src/plugins/playerIntelligence/runtime.js');

async function run() {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-player-intelligence-benchmark-'));
    let now = new Date('2026-10-01T10:00:00.000Z');
    const players = Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
        const id = `${100000 + index}`;
        return [id, { id, name: `Player ${index}`, status: true }];
    }));
    const battlemetrics = {
        lastUpdateSuccessful: true, streamerMode: false, updatedAt: now.toISOString(),
        server_rust_last_wipe: '2026-09-29T14:00:00.000Z', players,
        onlinePlayers: Object.keys(players), newPlayers: Object.keys(players),
        loginPlayers: [], logoutPlayers: [], nameChangedPlayers: []
    };
    const instance = {
        activeServer: 'server', serverList: { server: { battlemetricsId: '42' } }, trackers: {}
    };
    const client = {
        battlemetricsInstances: { 42: battlemetrics }, getInstance: () => instance,
        playerIntelligenceDependencies: { dataDirectory: directory, now: () => new Date(now) }
    };
    const context = { client, guildId: 'benchmark', rustplus: { serverId: 'server' }, firstTime: true };
    const rssBefore = process.memoryUsage().rss;
    const initialStarted = performance.now();
    await Runtime.onBattlemetricsUpdated(context);
    const initialMs = performance.now() - initialStarted;

    context.firstTime = false;
    battlemetrics.newPlayers = [];
    const pollStarted = performance.now();
    for (let poll = 1; poll <= 60; poll += 1) {
        now = new Date(now.getTime() + 60000);
        battlemetrics.updatedAt = now.toISOString();
        await Runtime.onBattlemetricsUpdated(context);
    }
    const quietPollMs = performance.now() - pollStarted;

    battlemetrics.logoutPlayers = Object.keys(players).slice(0, 10);
    battlemetrics.logoutPlayers.forEach(id => { players[id].status = false; });
    now = new Date(now.getTime() + 60000);
    battlemetrics.updatedAt = now.toISOString();
    const transitionStarted = performance.now();
    await Runtime.onBattlemetricsUpdated(context);
    const transitionMs = performance.now() - transitionStarted;
    const journal = Path.join(directory, 'benchmark', '42', '2026-10.jsonl');
    const bytes = Fs.statSync(journal).size;
    const rssDeltaBytes = process.memoryUsage().rss - rssBefore;
    Fs.rmSync(directory, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({
        players: 200,
        initialMs: Number(initialMs.toFixed(3)),
        quietPolls: 60,
        quietPollMeanMs: Number((quietPollMs / 60).toFixed(3)),
        tenTransitionsMs: Number(transitionMs.toFixed(3)),
        journalBytes: bytes,
        rssDeltaBytes
    })}\n`);
}

run().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
