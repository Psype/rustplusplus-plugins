const { performance } = require('node:perf_hooks');
const PluginManager = require('../src/plugins/pluginManager.js');

const client = {
    intlGet: (_guildId, key) => key.replace(/^commandSyntax/, '').toLowerCase()
};
const rustplus = { guildId: 'benchmark', serverId: 'benchmark', generalSettings: { prefix: '!' }, log: () => {} };
const context = {
    source: 'discord', client, rustplus, guildId: 'benchmark', message: {},
    command: '!unknown', commandLowerCase: '!unknown', prefix: '!'
};
const iterations = 10000;
const customSyntaxKeys = [
    'commandSyntaxDeepsea', 'commandSyntaxHiddenVendors', 'commandSyntaxHiddenWaterVendors',
    'commandSyntaxHiddenVendingTime', 'commandSyntaxLanguage', 'commandSyntaxRecord',
    'commandSyntaxWho', 'commandSyntaxLogs', 'commandSyntaxCommands', 'commandSyntaxAutoTranslate'
];

function legacyCustomDispatch(candidate) {
    for (const syntaxKey of customSyntaxKeys) {
        const values = [client.intlGet('en', syntaxKey), client.intlGet(candidate.guildId, syntaxKey)];
        if (values.some(value => candidate.commandLowerCase === `${candidate.prefix}${value}` ||
            candidate.commandLowerCase.startsWith(`${candidate.prefix}${value} `))) return true;
    }
    return false;
}

async function measure(callback) {
    const startedAt = performance.now();
    for (let index = 0; index < iterations; index++) await callback();
    return performance.now() - startedAt;
}

async function run() {
    await measure(() => PluginManager.handleCommand(context));
    const legacyElapsedMs = await measure(() => legacyCustomDispatch(context));
    const pluginElapsedMs = await measure(() => PluginManager.handleCommand(context));
    process.stdout.write(JSON.stringify({
        iterations,
        legacyMicrosecondsPerDispatch: Number((legacyElapsedMs * 1000 / iterations).toFixed(3)),
        pluginMicrosecondsPerDispatch: Number((pluginElapsedMs * 1000 / iterations).toFixed(3)),
        addedMicrosecondsPerDispatch: Number(((pluginElapsedMs - legacyElapsedMs) * 1000 / iterations).toFixed(3))
    }) + '\n');
}

run().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
