/* Route generic Rust+ SmartAlarm push notifications before the legacy channel switch. */

const PluginManager = require('../plugins/pluginManager.js');

function getAppDataValue(appData, key) {
    const item = appData.find(entry => entry && entry.key === key);
    return item ? item.value : undefined;
}

function normalizeAppData(appData) {
    if (Array.isArray(appData)) return appData;
    if (!appData || typeof appData !== 'object') return null;
    return Object.entries(appData).map(([key, value]) => ({ key, value }));
}

function isSmartAlarmChannel(channelId) {
    return typeof channelId === 'string' && channelId.trim().toLowerCase() === 'alarm';
}

function parseBody(bodyValue) {
    if (bodyValue && typeof bodyValue === 'object' && !Array.isArray(bodyValue)) return bodyValue;
    if (typeof bodyValue !== 'string') return null;
    const parsed = JSON.parse(bodyValue);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function log(client, source, guildId, steamId, message, level = 'info') {
    client.log(source, `GuildID: ${guildId}, SteamID: ${steamId}, ${message}`, level);
}

async function handle(client, guild, steamId, data, dependencies = {}) {
    const source = dependencies.source || 'FCM Host';
    const appData = normalizeAppData(data && data.appData);
    if (!appData) {
        log(client, source, guild.id, steamId, 'notification received without readable appData.', 'warn');
        return false;
    }

    const channelId = getAppDataValue(appData, 'channelId');
    const keys = appData.map(entry => entry && entry.key).filter(Boolean).join(',');
    log(client, source, guild.id, steamId,
        `notification received: channel=${JSON.stringify(channelId || 'unknown')}, keys=${keys || 'none'}.`);
    if (!isSmartAlarmChannel(channelId)) return false;

    const bodyValue = getAppDataValue(appData, 'body');
    if (bodyValue === undefined || bodyValue === null) {
        log(client, source, guild.id, steamId, 'alarm rejected: body could not be found.', 'warn');
        return true;
    }

    let body;
    try {
        body = parseBody(bodyValue);
    }
    catch (_error) {
        log(client, source, guild.id, steamId, 'alarm rejected: body is not valid JSON.', 'warn');
        return true;
    }
    if (!body) {
        log(client, source, guild.id, steamId, 'alarm rejected: body is not an object.', 'warn');
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
        channelId: 'alarm',
        title,
        message,
        body,
        raidAlarmAdapters: dependencies.raidAlarmAdapters
    });
    return handled === true;
}

module.exports = Object.freeze({ handle, isSmartAlarmChannel, normalizeAppData });
