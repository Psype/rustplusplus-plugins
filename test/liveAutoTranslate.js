const Assert = require('node:assert/strict');

const discordMessagesPath = require.resolve('../src/discordTools/discordMessages.js');
const discordRelays = [];
require.cache[discordMessagesPath] = {
    id: discordMessagesPath,
    filename: discordMessagesPath,
    loaded: true,
    exports: {
        sendTeamChatMessage: async (_guildId, message) => {
            discordRelays.push(message.message);
        }
    }
};

const InGameChatHandler = require('../src/handlers/inGameChatHandler.js');
const TeamChatHandler = require('../src/handlers/teamChatHandler.js');

async function run() {
    const rustMessages = [];
    const scenarios = Object.freeze([
        Object.freeze({
            sourceMessage: 'test de traduction',
            playerLanguages: Object.freeze(['en', 'fr']),
            targets: Object.freeze(['fr', 'zh']),
            expectedTarget: 'zh'
        }),
        Object.freeze({
            sourceMessage: 'the bot should be fixed',
            playerLanguages: Object.freeze(['en', 'fr']),
            targets: Object.freeze(['en', 'zh']),
            expectedTarget: 'zh'
        }),
        Object.freeze({
            sourceMessage: '现在应该可以用了',
            playerLanguages: Object.freeze(['zh']),
            targets: Object.freeze(['en', 'zh']),
            expectedTarget: 'en'
        })
    ]);
    const client = Object.freeze({ intlGet: (_guildId, key) => key });
    const rustplus = {
        guildId: 'live-autotranslate-test',
        serverId: 'live-autotranslate-test',
        team: { allOffline: false },
        generalSettings: {
            commandDelay: '3600',
            trademark: 'SHOWING',
            muteInGameBotMessages: false
        },
        inGameChatQueue: [],
        inGameChatTimeout: null,
        messagesSentByBot: [],
        log: () => {},
        sendInGameMessage(message) {
            return InGameChatHandler.inGameChatHandler(this, client, message);
        },
        sendTeamMessageAsync(message) {
            rustMessages.push(message);
            return Promise.resolve({ success: {} });
        },
        updateBotMessages(message) {
            this.messagesSentByBot.unshift(message);
        }
    };

    try {
        for (const scenario of scenarios) {
            await TeamChatHandler(rustplus, client, {
                steamId: scenario.playerLanguages.includes('zh') ?
                    '76561198843692446' : '76561197975819827',
                name: 'Live Test',
                message: scenario.sourceMessage
            }, {
                settings: { enabled: true, targets: scenario.targets },
                knownLanguages: scenario.playerLanguages
            });

            Assert.equal(rustplus.inGameChatQueue.length, 1);
            Assert.match(rustplus.inGameChatQueue[0],
                new RegExp(`^\\[BOT\\] \\[→${scenario.expectedTarget}\\] `, 'u'));
            clearTimeout(rustplus.inGameChatTimeout);
            rustplus.inGameChatTimeout = null;
            await InGameChatHandler.inGameChatHandler(rustplus, client);
        }

        Assert.equal(rustMessages.length, scenarios.length);
        Assert.equal(discordRelays.length, scenarios.length * 2);
        process.stdout.write(`${JSON.stringify(scenarios.map((scenario, index) => ({
            sourceMessage: scenario.sourceMessage,
            playerLanguages: scenario.playerLanguages,
            targets: scenario.targets,
            rustTeamMessage: rustMessages[index]
        })), null, 2)}\n`);
    }
    finally {
        clearTimeout(rustplus.inGameChatTimeout);
    }
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
