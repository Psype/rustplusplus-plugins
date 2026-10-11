/*
    Debug logger for raw Rust+ payload exploration.
    Writes debug logs to ./logs so missed event/marker payloads can be inspected offline.
*/

const Fs = require('fs');

const Path = require('path');
const LoggingSettings = require('./loggingSettings.js');

const LOG_DIR = Path.join(process.cwd(), 'logs');
const EVENT_LOG_PATH = Path.join(LOG_DIR, 'rustplusplus-events.log');
const FCM_RAW_LOG_PATH = Path.join(LOG_DIR, 'rustplusplus-fcm-raw.jsonl');
const MARKER_HISTORY_PATH = Path.join(LOG_DIR, 'rustplus-markers-history.log');
const RAW_SOCKET_LOG_PATH = Path.join(LOG_DIR, 'rustplusplus-raw-socket.txt');
const MAX_DEBUG_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DEBUG_RECORD_BYTES = 1024 * 1024;

function stringify(value) {
    return JSON.stringify(value, (_key, val) => typeof val === 'bigint' ? val.toString() : val);
}

function ensureLogDir(path = LOG_DIR, filesystem = Fs) {
    filesystem.mkdirSync(path, { recursive: true });
}

function appendBounded(path, content, filesystem = Fs) {
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_DEBUG_RECORD_BYTES) return false;
    if (typeof filesystem.statSync === 'function') {
        try {
            if (filesystem.statSync(path).size + bytes > MAX_DEBUG_FILE_BYTES) return false;
        }
        catch (error) {
            if (!error || error.code !== 'ENOENT') throw error;
        }
    }
    filesystem.appendFileSync(path, content, 'utf8');
    return true;
}

function appendJsonLine(path, data, dependencies = {}) {
    const isEnabled = dependencies.isEnabled || LoggingSettings.isEnabled;
    if (!isEnabled()) return false;
    const filesystem = dependencies.filesystem || Fs;
    ensureLogDir(Path.dirname(path), filesystem);
    return appendBounded(path, `${stringify(data)}\n`, filesystem);
}

function getRawDataBuffer(data) {
    return Array.isArray(data) ? Buffer.concat(data) :
        (Buffer.isBuffer(data) ? data : Buffer.from(data));
}

function appendRawSocketText(rustplus, direction, data) {
    if (!LoggingSettings.isEnabled()) return;
    const buffer = getRawDataBuffer(data);
    const header = `\n--- ${new Date().toISOString()} ${direction} guild=${rustplus.guildId} ` +
        `server=${rustplus.serverId} bytes=${buffer.length} ---\n`;
    ensureLogDir();
    appendBounded(RAW_SOCKET_LOG_PATH, `${header}${buffer.toString('utf8')}\n`);
}

function getBase(rustplus, source) {
    return {
        timestamp: new Date().toISOString(),
        guildId: rustplus.guildId,
        serverId: rustplus.serverId,
        source: source
    };
}

module.exports = {
    EVENT_LOG_PATH: EVENT_LOG_PATH,
    FCM_RAW_LOG_PATH: FCM_RAW_LOG_PATH,
    MARKER_HISTORY_PATH: MARKER_HISTORY_PATH,
    RAW_SOCKET_LOG_PATH: RAW_SOCKET_LOG_PATH,

    attachWebsocketLogger: function (rustplus) {
        if (!rustplus.websocket || rustplus.websocket.__rustplusplusRawLoggerAttached) return;

        rustplus.websocket.__rustplusplusRawLoggerAttached = true;

        rustplus.websocket.on('message', (data) => {
            try {
                appendRawSocketText(rustplus, 'inbound', data);
            }
            catch (e) {
                rustplus.log('DEBUG', `Could not append raw inbound websocket data: ${e}`, 'warn');
            }
        });

        const originalSend = rustplus.websocket.send.bind(rustplus.websocket);
        rustplus.websocket.send = function (data, ...args) {
            try {
                appendRawSocketText(rustplus, 'outbound', data);
            }
            catch (e) {
                rustplus.log('DEBUG', `Could not append raw outbound websocket data: ${e}`, 'warn');
            }
            return originalSend(data, ...args);
        };
    },

    logRustplusPayload: function (rustplus, source, payload) {
        try {
            appendJsonLine(EVENT_LOG_PATH, {
                ...getBase(rustplus, source),
                payload: payload
            });
        }
        catch (e) {
            rustplus.log('DEBUG', `Could not append Rust+ debug event: ${e}`, 'warn');
        }
    },

    logFcmPayload: function (client, identity, payload, dependencies = {}) {
        try {
            const now = dependencies.now || (() => new Date());
            return appendJsonLine(dependencies.path || FCM_RAW_LOG_PATH, {
                timestamp: now().toISOString(),
                source: identity.source,
                guildId: String(identity.guildId),
                steamId: String(identity.steamId),
                payload: payload
            }, dependencies);
        }
        catch (e) {
            client.log('DEBUG', `Could not append raw FCM notification: ${e}`, 'warn');
            return false;
        }
    },

    logMapMarkers: function (rustplus, mapMarkers, monuments = []) {
        try {
            const payload = {
                ...getBase(rustplus, 'polling:getMapMarkers'),
                markers: mapMarkers.markers || [],
                monuments: monuments
            };
            appendJsonLine(MARKER_HISTORY_PATH, payload);
            appendJsonLine(EVENT_LOG_PATH, {
                ...getBase(rustplus, 'polling:getMapMarkers'),
                payload: payload
            });
        }
        catch (e) {
            rustplus.log('DEBUG', `Could not append Rust+ marker debug event: ${e}`, 'warn');
        }
    }
};
