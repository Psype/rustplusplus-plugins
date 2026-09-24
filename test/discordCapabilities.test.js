const Assert = require('node:assert/strict');
const Test = require('node:test');

const instance = {
    activeServer: null,
    serverList: {
        server: {
            battlemetricsId: '42',
            url: 'https://example.invalid',
            title: 'Test server'
        }
    }
};
let instanceReads = 0;
const client = {
    activeRustplusInstances: {},
    getInstance: () => {
        instanceReads += 1;
        return instance;
    },
    intlGet: (_guildId, key) => key
};

const indexPath = require.resolve('../index.ts');
require.cache[indexPath] = {
    id: indexPath,
    filename: indexPath,
    loaded: true,
    exports: { client }
};

const DiscordButtons = require('../src/discordTools/discordButtons.js');
const DiscordMessages = require('../src/discordTools/discordMessages.js');

Test('server controls omit Cargo and Oil Rig custom timers', () => {
    const rows = DiscordButtons.getServerButtons('guild', 'server', 0);
    const customIds = rows.flatMap(row => row.toJSON().components)
        .map(component => component.custom_id)
        .filter(Boolean);

    Assert.equal(customIds.some(customId => customId.startsWith('CustomTimersEdit')), false);
});

Test('removed map-event information is not projected to Discord', async () => {
    const readsBefore = instanceReads;

    const result = await DiscordMessages.sendUpdateEventInformationMessage({ guildId: 'guild' });

    Assert.equal(result, undefined);
    Assert.equal(instanceReads, readsBefore);
});
