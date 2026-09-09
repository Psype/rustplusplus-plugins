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
const Translator = require('../src/plugins/autoTranslate/translator.js');

async function run() {
    const rustMessages = [];
    const diagnosticLogs = [];
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
        log: (...values) => diagnosticLogs.push(values.map(value => value && value.toString()).join(' ')),
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
            const diagnosticStart = diagnosticLogs.length;
            await TeamChatHandler(rustplus, client, {
                steamId: scenario.playerLanguages.includes('zh') ?
                    '76561198843692446' : '76561197975819827',
                name: 'Live Test',
                message: scenario.sourceMessage
            }, {
                settings: { enabled: true, targets: scenario.targets },
                knownLanguages: scenario.playerLanguages
            });

            Assert.equal(rustplus.inGameChatQueue.length, 1,
                `No translated Rust message was queued for ${JSON.stringify(scenario.sourceMessage)}. ` +
                `Plugin logs: ${JSON.stringify(diagnosticLogs.slice(diagnosticStart))}`);
            Assert.match(rustplus.inGameChatQueue[0],
                new RegExp(`^\\[BOT\\] \\[→${scenario.expectedTarget}\\] `, 'u'));
            clearTimeout(rustplus.inGameChatTimeout);
            rustplus.inGameChatTimeout = null;
            await InGameChatHandler.inGameChatHandler(rustplus, client);
        }

        Assert.equal(rustMessages.length, scenarios.length);
        Assert.equal(discordRelays.length, scenarios.length * 2);
        const forcedRateLimit = Object.assign(new Error('Too Many Requests'), { status: 429 });
        const deepLxFallback = await Translator('test de traduction', { from: 'fr', to: 'zh' }, {
            googleClient: async () => { throw forcedRateLimit; }
        });
        Assert.equal(deepLxFallback.provider, 'deeplx');
        Assert.deepEqual(deepLxFallback.failures, [{ provider: 'google-web', reason: 'HTTP 429' }]);
        const bingFallback = await Translator('test de traduction', { from: 'fr', to: 'zh' }, {
            googleClient: async () => { throw forcedRateLimit; },
            deepLxClient: async () => { throw new Error('forced DeepLX failure'); }
        });
        Assert.equal(bingFallback.provider, 'bing-web');
        Assert.deepEqual(bingFallback.failures, [
            { provider: 'google-web', reason: 'HTTP 429' },
            { provider: 'deeplx', reason: 'forced DeepLX failure' }
        ]);
        const myMemoryFallback = await Translator('the bot should work', { from: 'en', to: 'fr' }, {
            googleClient: async () => { throw forcedRateLimit; },
            deepLxClient: async () => { throw new Error('forced DeepLX failure'); },
            bingClient: async () => { throw new Error('forced Bing failure'); }
        });
        Assert.equal(myMemoryFallback.provider, 'mymemory');
        Assert.deepEqual(myMemoryFallback.failures, [
            { provider: 'google-web', reason: 'HTTP 429' },
            { provider: 'deeplx', reason: 'forced DeepLX failure' },
            { provider: 'bing-web', reason: 'forced Bing failure' }
        ]);

        process.stdout.write(`${JSON.stringify({ translations: scenarios.map((scenario, index) => ({
            sourceMessage: scenario.sourceMessage,
            playerLanguages: scenario.playerLanguages,
            targets: scenario.targets,
            rustTeamMessage: rustMessages[index]
        })), deepLxFallback, bingFallback, myMemoryFallback }, null, 2)}\n`);
    }
    finally {
        clearTimeout(rustplus.inGameChatTimeout);
    }
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
