/* Track the real FCM socket lifecycle and surface initial connection failures. */

function formatIdentity(guildId, steamId) {
    return `GuildID: ${guildId}, SteamID: ${steamId}`;
}

function attach(receiver, client, { source, guildId, steamId }) {
    const state = {
        status: 'connecting',
        connectedAt: null,
        disconnectedAt: null,
        failure: null
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
            `${formatIdentity(guildId, steamId)}, MCS login accepted; notification listener ready.`);
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

module.exports = Object.freeze({ attach, connect });
