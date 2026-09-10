const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Test = require('node:test');

const CommandCatalog = require('../src/util/commandCatalog.js');
const PluginManager = require('../src/plugins/pluginManager.js');
const TeammateLanguageDatabase = require('../src/plugins/teammateLanguageDatabase/index.js');

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
            if (key === 'commandsList') return `Commands: ${variables.commands}`;
            if (key === 'commandsUsage') return `${variables.usage} - ${variables.description}`;
            if (key === 'commandsUnknown') return `Unknown command: ${variables.command}.`;
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
        'auto-translate', 'custom-commands', 'warbandits', 'player-tracker', 'raid-alarm',
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
    const logs = [];
    const rustplus = createRustplus();
    rustplus.log = (...values) => logs.push(values);
    DeepSea.formatCommand = () => { throw new Error('deterministic failure'); };

    try {
        Assert.equal(PluginManager.getDeepSeaStatus(rustplus, true), null);
        Assert.equal(logs.length, 1);
        Assert.equal(logs[0][2], 'warn');
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

Test('canonical documentation covers every static in-game command', () => {
    const language = require('../src/languages/en.json');
    const runtimeKeys = new Set();
    for (const relativePath of [
        '../src/handlers/inGameCommandHandler.js',
        '../src/plugins/customCommands/index.js'
    ]) {
        const source = Fs.readFileSync(Path.join(__dirname, relativePath), 'utf8');
        for (const match of source.matchAll(/commandSyntax[A-Za-z0-9]+/g)) runtimeKeys.add(match[0]);
    }
    runtimeKeys.delete('commandSyntaxOn');
    runtimeKeys.delete('commandSyntaxOff');
    const runtimeNames = new Set([...runtimeKeys].map(key => language[key]));
    for (const name of ['help', 'track', 'tracklist', 'tracks', 'untrack']) runtimeNames.add(name);

    Assert.deepEqual([...CommandCatalog.getCommandNames()].sort(), [...runtimeNames].sort());

    const detailed = Fs.readFileSync(Path.join(__dirname, '..', 'docs', 'commands.md'), 'utf8');
    const table = detailed.slice(
        detailed.indexOf('# In-Game and Discord Commands'),
        detailed.indexOf('## **autotranslate**'));
    const detailedNames = new Set([...table.matchAll(/^\[\*\*(.+?)\*\*\]/gm)]
        .flatMap(match => match[1].split('/')).map(name => name.trim()));
    Assert.deepEqual([...detailedNames].sort(), [...runtimeNames].sort());
});

Test('both command documents cover every Discord slash command module', () => {
    const slashNames = Fs.readdirSync(Path.join(__dirname, '..', 'src', 'commands'))
        .filter(name => name.endsWith('.js'))
        .map(name => Path.basename(name, '.js'))
        .sort();
    const canonical = Fs.readFileSync(
        Path.join(__dirname, '..', 'docs', 'full_list_features.md'), 'utf8');
    const canonicalSlashSection = canonical.slice(0, canonical.indexOf('## In-Game and Discord Commands'));
    const canonicalNames = [...canonicalSlashSection.matchAll(/^- \*\*\/([^*]+)\*\*/gm)]
        .map(match => match[1]).sort();
    const detailed = Fs.readFileSync(Path.join(__dirname, '..', 'docs', 'commands.md'), 'utf8');
    const detailedSlashSection = detailed.slice(0, detailed.indexOf('# In-Game and Discord Commands'));
    const detailedNames = [...detailedSlashSection.matchAll(/^\[\*\*\/([^*]+)\*\*\]/gm)]
        .map(match => match[1]).sort();

    Assert.deepEqual(canonicalNames, slashNames);
    Assert.deepEqual(detailedNames, slashNames);
});

Test('despawn slash command uses its own documented description', () => {
    const source = Fs.readFileSync(Path.join(__dirname, '..', 'src', 'commands', 'despawn.js'), 'utf8');

    Assert.match(source, /\.setDescription\(client\.intlGet\(guildId, 'commandsDespawnDesc'\)\)/);
    Assert.doesNotMatch(source, /commandsStackDesc/);
});

Test('help and commands share immutable documented synopsis data', async () => {
    const client = createClient();
    const rustplus = createRustplus();
    const base = {
        source: 'inGame', client, rustplus, guildId: 'guild', message: {}, prefix: '!'
    };

    const help = await PluginManager.handleCommand({
        ...base, command: '!help hvw', commandLowerCase: '!help hvw'
    });
    const commands = await PluginManager.handleCommand({
        ...base, command: '!commands despawn', commandLowerCase: '!commands despawn'
    });
    const list = await PluginManager.handleCommand({
        ...base, command: '!help', commandLowerCase: '!help'
    });

    Assert.equal(help.response,
        '!hvw - Show former vendor locations grouped by grid; !hvw filters short-lived water suspects and !hvt sorts by shortest broadcast time.');
    Assert.equal(commands.response, '!despawn [item] - Display the despawn time of an item.');
    Assert.match(list.response, /^Commands: /);
    for (const name of ['despawn', 'help', 'stack', 'track', 'untrack']) {
        Assert.equal(list.response.split(/[:,] /).includes(name), true);
    }
    Assert.equal(Object.isFrozen(CommandCatalog.getCommands()), true);
    Assert.equal(Object.isFrozen(CommandCatalog.getCommand('track')), true);
});

Test('record command preserves a pseudonym with non-ASCII characters', async t => {
    const client = createClient();
    const rustplus = createRustplus();
    rustplus.guildId = 'test-record-command';
    const csvPath = Path.join(__dirname, '..', 'data', 'teammate-language-database',
        'test-record-command-server.csv');
    t.after(() => {
        if (Fs.existsSync(csvPath)) Fs.unlinkSync(csvPath);
    });

    const response = await PluginManager.handleCommand({
        source: 'inGame', client, rustplus, guildId: rustplus.guildId,
        message: {}, command: '!record 76561198000000003 这就是我的宿命',
        commandLowerCase: '!record 76561198000000003 这就是我的宿命', prefix: '!'
    });

    Assert.equal(response.handled, true);
    Assert.deepEqual(
        TeammateLanguageDatabase.getKnownPseudonyms(rustplus, '76561198000000003').map(entry => entry.name),
        ['这就是我的宿命']);
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
