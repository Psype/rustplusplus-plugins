const Assert = require('node:assert/strict');
const Test = require('node:test');

const FcmAlarmRouter = require('../src/util/fcmAlarmRouter.js');
const InGameChatHandler = require('../src/handlers/inGameChatHandler.js');

Test('raw custom FCM alarm reaches the acknowledged Rust team-message boundary', async () => {
    const sent = [];
    const logs = [];
    const serverId = '185.29.166.79-28083';
    const instance = {
        channelId: { activity: 'activity' },
        generalSettings: { smartAlarmNotifyInGame: true, muteInGameBotMessages: false },
        serverList: { [serverId]: {} }
    };
    const client = {
        getInstance: () => instance,
        intlGet: (_guildId, key, variables = {}) => {
            if (key === 'messageCap') return 'MESSAGE';
            if (key === 'raidAlarmDestroyedAt') return `${variables.item} @ ${variables.location}`;
            if (key === 'infoCap') return 'INFO';
            return key;
        },
        log: (...values) => logs.push(values),
        rustplusInstances: {}
    };
    const rustplus = {
        guildId: 'guild',
        serverId,
        team: { allOffline: true },
        generalSettings: {
            commandDelay: '3600',
            trademark: 'SHOWING',
            muteInGameBotMessages: false
        },
        messagesSentByBot: [],
        updateBotMessages(message) { this.messagesSentByBot.unshift(message); },
        sendTeamMessageAsync: async message => {
            sent.push(message);
            return { success: {} };
        },
        log: (...values) => logs.push(values),
        sendCriticalInGameMessage(message) {
            return InGameChatHandler.sendCriticalMessage(this, client, message);
        }
    };
    client.rustplusInstances.guild = rustplus;

    const handled = await FcmAlarmRouter.handle(client, { id: 'guild' }, '76561197975819827', {
        appData: [
            { key: 'channelId', value: 'alarm' },
            { key: 'title', value: 'WarBandits raid warning' },
            { key: 'message', value: 'Stone wall damaged at H14' },
            { key: 'body', value: JSON.stringify({
                type: 'custom-raid', ip: '185.29.166.79', port: 28083, img: ''
            }) }
        ]
    }, {
        source: 'FCM LITE',
        raidAlarmAdapters: { deduplicate: false, sendDiscord: async () => {} }
    });

    Assert.equal(handled, true);
    Assert.deepEqual(sent, ['[BOT] WarBandits raid warning: Stone wall damaged at H14']);
    Assert.ok(logs.some(values => String(values[1]).includes('alarm received')));
    Assert.ok(logs.some(values => String(values[1]).includes('raid-alarm.in-game: delivered')));
});

Test('malformed alarm FCM is rejected without throwing or entering legacy parsing', async () => {
    const logs = [];
    const handled = await FcmAlarmRouter.handle({
        log: (...values) => logs.push(values)
    }, { id: 'guild' }, 'steam', {
        appData: [
            { key: 'channelId', value: 'alarm' },
            { key: 'body', value: '{invalid' }
        ]
    });

    Assert.equal(handled, true);
    Assert.ok(logs.some(values => String(values[1]).includes('body is not valid JSON')));
});
