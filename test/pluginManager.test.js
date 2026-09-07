const Assert = require('node:assert/strict');
const Test = require('node:test');

const PluginManager = require('../src/plugins/pluginManager.js');

function createClient() {
    return {
        getInstance: () => ({ generalSettings: { language: 'en' } }),
        intlGet: (_guildId, key, variables = {}) => {
            const syntaxes = {
                commandSyntaxAutoTranslate: 'autotranslate',
                commandSyntaxCommands: 'commands',
                commandSyntaxDeepsea: 'deepsea',
                commandSyntaxHiddenVendingTime: 'hvt',
                commandSyntaxHiddenVendors: 'hv',
                commandSyntaxHiddenWaterVendors: 'hvw',
                commandSyntaxLanguage: 'language',
                commandSyntaxLogs: 'logs',
                commandSyntaxRecord: 'record',
                commandSyntaxWho: 'who'
            };
            if (syntaxes[key]) return syntaxes[key];
            if (key === 'eventInfoUnknown') return `${variables.event}: unknown`;
            return key;
        }
    };
}

function createRustplus() {
    return {
        guildId: 'guild',
        serverId: 'server',
        generalSettings: { prefix: '!' },
        getCommandCargo: () => 'cargo',
        getCommandChinook: () => 'chinook',
        getCommandHeli: () => 'heli',
        getCommandLarge: () => 'large',
        getCommandSmall: () => 'small',
        log: () => {},
        map: { monuments: [] },
        mapMarkers: {}
    };
}

Test('plugin registry exposes an immutable stable list', () => {
    const names = PluginManager.getPluginNames();
    Assert.deepEqual(names, [
        'auto-translate', 'custom-commands', 'raid-alarm',
        'teammate-language-database', 'hidden-vendors', 'deep-sea'
    ]);
    Assert.equal(Object.isFrozen(names), true);
});

Test('invalid command contexts fail closed at the plugin boundary', async () => {
    const response = await PluginManager.handleCommand({ source: 'unknown' });

    Assert.deepEqual(response, { handled: false });
    Assert.equal(Object.isFrozen(response), true);
});

Test('a synchronous optional plugin failure preserves the core fallback', () => {
    const DeepSea = require('../src/plugins/deepSea');
    const original = DeepSea.formatCommand;
    DeepSea.formatCommand = () => { throw new Error('deterministic failure'); };

    try {
        Assert.equal(PluginManager.getDeepSeaStatus(createRustplus(), true), null);
    }
    finally {
        DeepSea.formatCommand = original;
    }
});

Test('custom Deep Sea command is handled outside core command handlers', async () => {
    const client = createClient();
    const rustplus = createRustplus();
    const response = await PluginManager.handleCommand({
        source: 'inGame', client, rustplus, guildId: 'guild',
        message: {}, command: '!deepsea', commandLowerCase: '!deepsea', prefix: '!'
    });

    Assert.equal(response.handled, true);
    Assert.equal(response.response, 'deepseaInfoUnknown');
    Assert.equal(Object.isFrozen(response), true);
});

Test('unknown commands fall through without side effects', async () => {
    const client = createClient();
    const rustplus = createRustplus();
    const response = await PluginManager.handleCommand({
        source: 'discord', client, rustplus, guildId: 'guild',
        message: {}, command: '!unknown', commandLowerCase: '!unknown', prefix: '!'
    });

    Assert.deepEqual(response, { handled: false });
    Assert.equal(Object.isFrozen(response), true);
});

Test('Deep Sea detection requires an off-map vendor cluster', async () => {
    const client = createClient();
    const rustplus = createRustplus();
    rustplus.info = { correctedMapSize: 4500 };
    rustplus.mapMarkers = { types: { VendingMachine: 3 } };
    await PluginManager.install({ rustplus, client });

    const markers = {
        markers: [
            { id: 1, type: 3, x: 4600, y: 100, name: 'Vendor A' },
            { id: 2, type: 3, x: 4610, y: 110, name: 'Vendor B' },
            { id: 3, type: 3, x: 4620, y: 120, name: 'Vendor C' },
            { id: 4, type: 3, x: 100, y: 100, name: 'Player Shop' }
        ]
    };

    const DeepSea = require('../src/plugins/deepSea');
    Assert.deepEqual(DeepSea.getDeepSeaVendors(rustplus, markers).map(marker => marker.id), [1, 2, 3]);
});
