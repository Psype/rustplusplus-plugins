/* Route SmartAlarm-channel FCM data before the legacy channel switch. */

const PluginManager = require('../plugins/pluginManager.js');

function getAppDataValue(appData, key) {
    const item = appData.find(entry => entry && entry.key === key);
    return item ? item.value : undefined;
}

function log(client, source, guildId, steamId, message, level = 'info') {
    client.log(source, `GuildID: ${guildId}, SteamID: ${steamId}, ${message}`, level);
}

async function handle(client, guild, steamId, data, dependencies = {}) {
    const appData = data && data.appData;
    if (!Array.isArray(appData)) return false;

    const channelId = getAppDataValue(appData, 'channelId');
    if (channelId !== 'alarm') return false;

    const source = dependencies.source || 'FCM Host';
    const bodyValue = getAppDataValue(appData, 'body');
    if (typeof bodyValue !== 'string') {
        log(client, source, guild.id, steamId, 'alarm rejected: body could not be found.', 'warn');
        return true;
    }

    let body;
    try {
        body = JSON.parse(bodyValue);
    }
    catch (_error) {
        log(client, source, guild.id, steamId, 'alarm rejected: body is not valid JSON.', 'warn');
        return true;
    }

    const title = getAppDataValue(appData, 'title');
    const message = getAppDataValue(appData, 'message');
    const serverId = body && body.ip !== undefined && body.port !== undefined ?
        `${body.ip}-${body.port}` : 'unknown';
    log(client, source, guild.id, steamId,
        `alarm received: server=${serverId}, type=${body && body.type ? body.type : 'unknown'}, ` +
        `title=${JSON.stringify(title || '')}, message=${JSON.stringify(message || '')}.`);

    const handleFcmAlarm = dependencies.handleFcmAlarm || PluginManager.handleFcmAlarm;
    const handled = await handleFcmAlarm({
        client,
        guild,
        hoster: steamId,
        channelId,
        title,
        message,
        body,
        raidAlarmAdapters: dependencies.raidAlarmAdapters
    });
    return handled === true;
}

module.exports = Object.freeze({ handle });
