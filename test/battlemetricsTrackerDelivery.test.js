const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Test = require('node:test');

const applicationPath = require.resolve('../index.ts');
require.cache[applicationPath] = {
    id: applicationPath,
    filename: applicationPath,
    loaded: true,
    exports: { client: {} }
};
const BattlemetricsHandler = require('../src/handlers/battlemetricsHandler.js');
const DiscordMessages = require('../src/discordTools/discordMessages.js');

Test('native tracker logs and delivers exact online/offline messages despite Discord failures', async t => {
    const guildId = 'test-player-tracker-delivery';
    const serverId = '127.0.0.1-28082';
    const savePath = Path.join(__dirname, '..', 'data', 'player-trackers', `${guildId}-42.json`);
    t.after(() => {
        if (Fs.existsSync(savePath)) Fs.unlinkSync(savePath);
    });

    let instance = {
        activeServer: serverId,
        generalSettings: {
            battlemetricsGlobalLogin: false,
            battlemetricsGlobalLogout: false,
            battlemetricsGlobalNameChanges: false,
            displayInformationBattlemetricsAllOnlinePlayers: false
        },
        informationMessageId: { battlemetricsPlayers: null },
        channelId: { information: null },
        serverList: {
            [serverId]: { battlemetricsId: '42', title: 'Test server', img: null }
        },
        trackers: {
            7: {
                name: 'Enemies',
                serverId,
                battlemetricsId: '42',
                title: 'Test server',
                img: null,
                clanTag: '',
                everyone: false,
                inGame: true,
                players: [{
                    name: 'Nirks',
                    steamId: '76561198154738095',
                    playerId: '1001',
                    playerIdLocked: true
                }],
                messageId: null,
                managedBy: 'player-tracker'
            }
        }
    };
    const battlemetrics = {
        lastUpdateSuccessful: true,
        streamerMode: false,
        players: { 1001: { id: '1001', name: 'Nirks', status: true, logoutDate: null } },
        nameChangedPlayers: [],
        newPlayers: ['1001'],
        loginPlayers: [],
        logoutPlayers: []
    };
    const inGame = [];
    const logs = [];
    const rustplus = {
        serverId,
        isOperational: true,
        log: (...values) => logs.push(values),
        sendInGameMessage: async text => inGame.push(text)
    };
    const client = {
        battlemetricsInstances: { 42: battlemetrics },
        battlemetricsIntervalCounter: 1,
        guilds: { cache: new Map([[guildId, {}]]) },
        rustplusInstances: { [guildId]: rustplus },
        getInstance: () => instance,
        intlGet: (_guildId, key, values) => {
            if (key === 'playerJustConnectedTracker') {
                return `Tracked player ${values.name} is now online.`;
            }
            if (key === 'playerJustDisconnectedTracker') {
                return `Tracked player ${values.name} just disconnected.`;
            }
            return key;
        },
        setInstance: (_guildId, value) => { instance = value; },
        updateBattlemetricsInstances: async () => {}
    };

    const originalActivity = DiscordMessages.sendActivityNotificationMessage;
    const originalTracker = DiscordMessages.sendTrackerMessage;
    DiscordMessages.sendActivityNotificationMessage = async () => {
        throw new Error('Discord unavailable');
    };
    DiscordMessages.sendTrackerMessage = async () => {
        throw new Error('Discord tracker unavailable');
    };
    try {
        await BattlemetricsHandler.handler(client, false);
        battlemetrics.players[1001].status = false;
        battlemetrics.newPlayers = [];
        battlemetrics.logoutPlayers = ['1001'];
        await BattlemetricsHandler.handler(client, false);
    }
    finally {
        DiscordMessages.sendActivityNotificationMessage = originalActivity;
        DiscordMessages.sendTrackerMessage = originalTracker;
    }

    Assert.deepEqual(inGame, [
        'Tracked player Nirks is now online.',
        'Tracked player Nirks just disconnected.'
    ]);
    Assert.equal(JSON.parse(Fs.readFileSync(savePath, 'utf8')).players[0].status, 'offline');
    Assert.equal(instance.trackers[7].players[0].playerId, '1001');
    Assert.deepEqual(logs[0], ['TRACKER', 'Tracked player Nirks is now online.', 'info']);
    Assert.deepEqual(logs[3], ['TRACKER', 'Tracked player Nirks just disconnected.', 'info']);
    Assert.equal(logs.filter(values => values[2] === 'warn').length, 4);
});
