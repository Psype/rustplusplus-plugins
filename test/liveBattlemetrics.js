/* Explicit read-only BattleMetrics Premium integration check. */

const Config = require('../config');
const Battlemetrics = require('../src/plugins/battlemetrics');

function usage() {
    console.error('Usage: npm run test:battlemetrics:live -- <BattleMetrics server ID> <BattleMetrics player ID>');
    process.exitCode = 2;
}

function printResult(label, result, detail) {
    if (result.available !== true) {
        const retry = result.retryAt ? ` retryAt=${result.retryAt}` : '';
        console.log(`${label}: unavailable reason=${result.reason} status=${result.status || 'none'}${retry}`);
        return false;
    }
    console.log(`${label}: ok ${detail(result)}`);
    return true;
}

async function run() {
    const serverId = `${process.argv[2] || ''}`;
    const playerId = `${process.argv[3] || ''}`;
    if (!/^\d+$/.test(serverId) || !/^\d+$/.test(playerId)) return usage();
    if (!Config.battlemetrics.token) {
        console.error('RPP_BATTLEMETRICS_TOKEN is missing. The token value is never printed.');
        process.exitCode = 2;
        return;
    }

    const dependencies = { token: Config.battlemetrics.token };
    const server = await Battlemetrics.getServerPlayer(playerId, serverId, dependencies);
    const sessions = await Battlemetrics.getSessions(playerId, serverId, dependencies);
    const related = await Battlemetrics.getRelatedPlayers(playerId, serverId, dependencies);

    const checks = [
        printResult('server-player', server, result => [
            `online=${typeof result.player.online === 'boolean' ? 'present' : 'absent'}`,
            `firstSeen=${result.player.firstSeenAt ? 'present' : 'absent'}`,
            `lastSeen=${result.player.lastSeenAt ? 'present' : 'absent'}`,
            `timePlayed=${result.player.timePlayedSeconds !== null ? 'present' : 'absent'}`
        ].join(' ')),
        printResult('sessions', sessions, result =>
            `count=${result.sessions.length} truncated=${result.truncated}`),
        printResult('related', related, result =>
            `count=${result.players.length} truncated=${result.truncated}`)
    ];
    if (checks.some(check => !check)) process.exitCode = 1;
}

run().catch(error => {
    console.error(`BattleMetrics live check failed safely: ${error && error.message ? error.message : 'unknown error'}`);
    process.exitCode = 1;
});
