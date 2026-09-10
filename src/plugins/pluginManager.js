/*
    Stable integration boundary for optional rustplusplus extensions.

    Core handlers call this module only. Feature-specific modules stay behind
    this boundary so upstream changes do not require imports throughout core.
*/

const AutoTranslate = require('./autoTranslate');
const CustomCommands = require('./customCommands');
const DeepSea = require('./deepSea');
const HiddenVendors = require('./hiddenVendors');
const PlayerTracker = require('./playerTracker');
const RaidAlarm = require('./raidAlarm');
const TeammateLanguageDatabase = require('./teammateLanguageDatabase');
const WarBandits = require('./warBandits');

function getWarBanditsProvider(context) {
    if (context && Object.prototype.hasOwnProperty.call(context, 'warBanditsProvider')) {
        return context.warBanditsProvider;
    }
    const dependencies = context && context.playerTrackerDependencies;
    if (dependencies && Object.prototype.hasOwnProperty.call(dependencies, 'warBanditsProvider')) {
        return dependencies.warBanditsProvider;
    }
    return WarBandits;
}

function withWarBanditsProvider(context) {
    const dependencies = context.playerTrackerDependencies || {};
    if (Object.prototype.hasOwnProperty.call(dependencies, 'warBanditsProvider')) return context;
    return Object.freeze({
        ...context,
        playerTrackerDependencies: Object.freeze({
            ...dependencies,
            warBanditsProvider: getWarBanditsProvider(context)
        })
    });
}

const plugins = Object.freeze([
    Object.freeze({ name: 'auto-translate' }),
    Object.freeze({ name: 'battlemetrics' }),
    Object.freeze({
        name: 'custom-commands',
        handleCommand: context => CustomCommands.handleCommand(context)
    }),
    Object.freeze({ name: 'warbandits' }),
    Object.freeze({
        name: 'player-tracker',
        handleCommand: context => PlayerTracker.handleCommand(withWarBanditsProvider(context)),
        onBattlemetricsUpdated: context => PlayerTracker.onBattlemetricsUpdated(context)
    }),
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
        rustplus.log('PLUGIN', `${plugin.name}.${hook}: ${error}`, 'warn');
        return;
    }
    const client = context && context.client;
    if (client && typeof client.log === 'function') {
        client.log('PLUGIN', `${plugin.name}.${hook}: ${error}`, 'warn');
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
        for (const plugin of plugins) {
            if (typeof plugin.handleCommand !== 'function') continue;
            try {
                const result = await plugin.handleCommand(Object.freeze({ ...context }));
                if (result && result.handled) return result;
            }
            catch (error) {
                reportFailure(context, plugin, 'handleCommand', error);
            }
        }
        return Object.freeze({ handled: false });
    }
    catch (error) {
        reportFailure(context, { name: 'custom-commands' }, 'handleCommand', error);
        return Object.freeze({ handled: false });
    }
}

async function translateTeamMessage(context) {
    try {
        return await AutoTranslate.translateMessage(
            context.rustplus, context.message, context.translationDependencies || {});
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
    onBattlemetricsUpdated: context => runHook('onBattlemetricsUpdated', context),
    onTeamInfo: context => runHook('onTeamInfo', context),
    onTeamMessage: context => runHook('onTeamMessage', context),
    translateTeamMessage
});
