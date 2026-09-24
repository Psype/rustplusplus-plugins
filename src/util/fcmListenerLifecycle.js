/* Track the real FCM socket lifecycle and surface initial connection failures. */

function formatIdentity(guildId, steamId) {
    return `GuildID: ${guildId}, SteamID: ${steamId}`;
}

function getChannelId(data) {
    const appData = data && data.appData;
    if (Array.isArray(appData)) {
        const entry = appData.find(item => item && item.key === 'channelId');
        return typeof entry?.value === 'string' ? entry.value.trim().toLowerCase() : null;
    }
    if (appData && typeof appData === 'object' && typeof appData.channelId === 'string') {
        return appData.channelId.trim().toLowerCase();
    }
    return null;
}

function getAppDataValue(data, key) {
    const appData = data && data.appData;
    if (Array.isArray(appData)) return appData.find(item => item && item.key === key)?.value;
    return appData && typeof appData === 'object' ? appData[key] : undefined;
}

function cleanAlarmText(value) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function isServerPairing(data) {
    const bodyValue = getAppDataValue(data, 'body');
    let body = bodyValue;
    if (typeof bodyValue === 'string') {
        try {
            body = JSON.parse(bodyValue);
        }
        catch (_error) {
            return false;
        }
    }
    return body && typeof body === 'object' && !Array.isArray(body) &&
        String(body.type).toLowerCase() === 'server';
}

function attach(receiver, client, { source, guildId, steamId }) {
    const state = {
        source,
        guildId,
        steamId,
        status: 'connecting',
        connectedAt: null,
        disconnectedAt: null,
        failure: null,
        notificationCount: 0,
        lastNotificationAt: null,
        lastChannelId: null,
        serverPairingCount: 0,
        lastServerPairingAt: null,
        alarmCount: 0,
        lastAlarmAt: null,
        recentAlarms: []
    };
    Object.defineProperty(receiver, 'rppConnectionState', {
        configurable: false,
        enumerable: false,
        value: state,
        writable: false
    });

    receiver.on('connect', () => {
        state.status = 'connected';
        state.connectedAt = new Date().toISOString();
        state.failure = null;
        client.log(source,
            `${formatIdentity(guildId, steamId)}, MCS login accepted; transport ready. ` +
            (state.notificationCount > 0 ?
                `Facepunch push delivery previously verified (${state.notificationCount} notification(s)).` :
                'Facepunch push delivery is not verified until the first notification is received.'));
    });
    receiver.on('disconnect', (error, details = { willReconnect: true }) => {
        state.status = details.willReconnect ? 'reconnecting' : 'failed';
        state.disconnectedAt = new Date().toISOString();
        client.log(source,
            `${formatIdentity(guildId, steamId)}, disconnected (${error || 'unknown reason'}); ` +
            (details.willReconnect ? 'receiver reconnect scheduled.' : 'receiver stopped.'), 'warn');
    });
    receiver.on('fatal', error => {
        state.status = 'failed';
        state.failure = String(error);
        client.log(source,
            `${formatIdentity(guildId, steamId)}, fatal notification transport failure: ${error}`, 'error');
    });
    return state;
}

function markNotification(receiver, client, { source, guildId, steamId }, data) {
    const state = receiver && receiver.rppConnectionState;
    if (!state) return;

    const firstNotification = state.notificationCount === 0;
    const channelId = getChannelId(data);
    const now = new Date().toISOString();
    state.notificationCount += 1;
    state.lastNotificationAt = now;
    state.lastChannelId = channelId;
    if (channelId === 'pairing' && isServerPairing(data)) {
        state.serverPairingCount += 1;
        state.lastServerPairingAt = now;
    }
    if (channelId === 'alarm') {
        state.alarmCount += 1;
        state.lastAlarmAt = now;
        state.recentAlarms = Object.freeze([
            Object.freeze({
                receivedAt: now,
                title: cleanAlarmText(getAppDataValue(data, 'title')),
                message: cleanAlarmText(getAppDataValue(data, 'message'))
            }),
            ...state.recentAlarms
        ].slice(0, 5));
    }

    if (firstNotification) {
        client.log(source,
            `${formatIdentity(guildId, steamId)}, Facepunch push delivery verified; ` +
            `first notification channel=${JSON.stringify(channelId || 'unknown')}.`);
    }
}

async function connect(receiver, client, identity) {
    try {
        await receiver.connect();
    }
    catch (error) {
        const state = receiver.rppConnectionState;
        if (state) {
            state.status = 'failed';
            state.failure = String(error);
        }
        receiver.destroy();
        client.log(identity.source,
            `${formatIdentity(identity.guildId, identity.steamId)}, initial connection failed: ${error}`,
            'error');
        throw error;
    }
}

module.exports = Object.freeze({ attach, connect, getChannelId, markNotification });
