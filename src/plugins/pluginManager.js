/*
    Stable integration boundary for optional rustplusplus extensions.

    Core handlers call this module only. Feature-specific modules stay behind
    this boundary so upstream changes do not require imports throughout core.
*/

const AutoTranslate = require('./autoTranslate');
const CustomCommands = require('./customCommands');
const DeepSea = require('./deepSea');
const HiddenVendors = require('./hiddenVendors');
const RaidAlarm = require('./raidAlarm');
const TeammateLanguageDatabase = require('./teammateLanguageDatabase');

const plugins = Object.freeze([
    Object.freeze({ name: 'auto-translate' }),
    Object.freeze({ name: 'custom-commands' }),
    Object.freeze({
        name: 'raid-alarm',
        onFcmAlarm: context => RaidAlarm.handleFcmAlarm(context)
    }),
    Object.freeze({
        name: 'teammate-language-database',
        onTeamInfo: ({ rustplus, teamInfo }) => TeammateLanguageDatabase.recordTeamInfo(rustplus, teamInfo),
        onTeamMessage: ({ rustplus, message }) => TeammateLanguageDatabase.recordTeamMessage(rustplus, message)
    }),
    Object.freeze({
        name: 'hidden-vendors',
        beforeMapMarkersUpdate: ({ rustplus, mapMarkers }) => HiddenVendors.recordVendors(rustplus, mapMarkers)
    }),
    Object.freeze({
        name: 'deep-sea',
        install: ({ rustplus, client }) => DeepSea.install(rustplus, client),
        afterMapMarkersUpdate: ({ rustplus, client, mapMarkers }) => DeepSea.handler(rustplus, client, mapMarkers)
    })
]);

function reportFailure(context, plugin, hook, error) {
    const rustplus = context && context.rustplus;
    if (rustplus && typeof rustplus.log === 'function') {
        rustplus.log('PLUGIN', `${plugin.name}.${hook}: ${error}`, 'warning');
        return;
    }
    const client = context && context.client;
    if (client && typeof client.log === 'function') {
        client.log('PLUGIN', `${plugin.name}.${hook}: ${error}`, 'warning');
    }
}

function validateCommandContext(context) {
    if (!context || typeof context !== 'object') throw new TypeError('Command context must be an object.');
    if (!['discord', 'inGame'].includes(context.source)) throw new TypeError('Unsupported command source.');
    if (!context.client || typeof context.client.intlGet !== 'function') throw new TypeError('Command client is invalid.');
    if (!context.rustplus || typeof context.rustplus !== 'object') throw new TypeError('Command RustPlus instance is invalid.');
    if (typeof context.guildId !== 'string' || context.guildId === '') throw new TypeError('Command guildId is invalid.');
    if (typeof context.command !== 'string' || typeof context.commandLowerCase !== 'string') {
        throw new TypeError('Command text is invalid.');
    }
    if (typeof context.prefix !== 'string' || context.prefix === '') throw new TypeError('Command prefix is invalid.');
}

function runSyncExtension(plugin, hook, context, fallback, callback) {
    try {
        return callback();
    }
    catch (error) {
        reportFailure(context, plugin, hook, error);
        return fallback;
    }
}

async function runHook(hook, context) {
    for (const plugin of plugins) {
        if (typeof plugin[hook] !== 'function') continue;
        try {
            await plugin[hook](context);
        }
        catch (error) {
            reportFailure(context, plugin, hook, error);
        }
    }
}

async function runFirstHandled(hook, context) {
    for (const plugin of plugins) {
        if (typeof plugin[hook] !== 'function') continue;
        try {
            if (await plugin[hook](Object.freeze({ ...context }))) return true;
        }
        catch (error) {
            reportFailure(context, plugin, hook, error);
        }
    }
    return false;
}

async function handleCommand(context) {
    try {
        validateCommandContext(context);
        return await CustomCommands.handleCommand(Object.freeze({ ...context }));
    }
    catch (error) {
        reportFailure(context, { name: 'custom-commands' }, 'handleCommand', error);
        return Object.freeze({ handled: false });
    }
}

async function translateTeamMessage(context) {
    try {
        return await AutoTranslate.translateMessage(context.rustplus, context.message);
    }
    catch (error) {
        reportFailure(context, { name: 'auto-translate' }, 'translateTeamMessage', error);
        return null;
    }
}

module.exports = Object.freeze({
    afterMapMarkersUpdate: context => runHook('afterMapMarkersUpdate', context),
    beforeMapMarkersUpdate: context => runHook('beforeMapMarkersUpdate', context),
    getPluginNames: () => Object.freeze(plugins.map(plugin => plugin.name)),
    getDeepSeaStatus: (rustplus, isInfoChannel = false) => runSyncExtension(
        { name: 'deep-sea' }, 'formatCommand', { rustplus }, null,
        () => DeepSea.formatCommand(rustplus, isInfoChannel)),
    getEventsCommandResponse: (rustplus, client, command) => runSyncExtension(
        { name: 'deep-sea' }, 'getEventsCommandResponse', { rustplus }, null,
        () => {
            const response = DeepSea.getEventsCommandResponse(rustplus, client, command);
            return Array.isArray(response) ? Object.freeze([...response]) : response;
        }),
    handleCommand,
    handleFcmAlarm: context => runFirstHandled('onFcmAlarm', context),
    install: context => runHook('install', context),
    onTeamInfo: context => runHook('onTeamInfo', context),
    onTeamMessage: context => runHook('onTeamMessage', context),
    translateTeamMessage
});
