/*
    Synchronize an operational Rust+ connection into Discord without making
    Discord a prerequisite for the authoritative in-game connection.
*/

const DiscordMessages = require('../discordTools/discordMessages.js');

const defaultAdapters = Object.freeze({
    discordMessages: DiscordMessages,
    setupSwitches: require('../discordTools/SetupSwitches'),
    setupSwitchGroups: require('../discordTools/SetupSwitchGroups'),
    setupAlarms: require('../discordTools/SetupAlarms'),
    setupStorageMonitors: require('../discordTools/SetupStorageMonitors')
});

function mergeState(previous = {}, current = {}) {
    previous = previous || {};
    current = current || {};
    return Object.freeze({
        mapChanged: Boolean(previous.mapChanged || current.mapChanged),
        reconnected: Boolean(previous.reconnected || current.reconnected)
    });
}

async function synchronize(client, rustplus, state = {}, adapters = defaultAdapters) {
    const pending = mergeState(rustplus.pendingDiscordSync, state);
    rustplus.pendingDiscordSync = pending;

    const guildId = rustplus.guildId;
    const serverId = rustplus.serverId;
    const discordReady = typeof client.isDiscordGuildReady === 'function' ?
        client.isDiscordGuildReady(guildId) :
        typeof client.isReady === 'function' && client.isReady();
    if (!discordReady) return false;

    const tasks = [];

    if (rustplus.map) {
        tasks.push(['map projection', async () => {
            await rustplus.map.writeMap(false, true);
            if (pending.mapChanged) {
                await adapters.discordMessages.sendServerWipeDetectedMessage(guildId, serverId);
            }
            await adapters.discordMessages.sendInformationMapMessage(guildId);
        }]);
    }
    if (pending.reconnected) {
        tasks.push(['connection state', () =>
            adapters.discordMessages.sendServerChangeStateMessage(guildId, serverId, 0)]);
    }

    tasks.push(
        ['server information', () => adapters.discordMessages.sendServerMessage(guildId, serverId, null)],
        ['smart switches', () => adapters.setupSwitches(client, rustplus)],
        ['smart switch groups', () => adapters.setupSwitchGroups(client, rustplus)],
        ['smart alarms', () => adapters.setupAlarms(client, rustplus)],
        ['storage monitors', () => adapters.setupStorageMonitors(client, rustplus)]
    );

    for (const [label, task] of tasks) {
        try {
            await task();
        }
        catch (error) {
            rustplus.log('DISCORD', `${label} synchronization failed: ${error}`, 'warn');
        }
    }

    rustplus.isNewConnection = false;
    rustplus.pendingDiscordSync = null;
    return true;
}

module.exports = Object.freeze({ mergeState, synchronize });
