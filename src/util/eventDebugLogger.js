/*
    Debug logger for raw Rust+ payload exploration.
    Writes debug logs to ./logs so missed event/marker payloads can be inspected offline.
*/

const Fs = require('fs');

const Path = require('path');

const LOG_DIR = Path.join(process.cwd(), 'logs');
const EVENT_LOG_PATH = Path.join(LOG_DIR, 'rustplusplus-events.log');
const MARKER_HISTORY_PATH = Path.join(LOG_DIR, 'rustplus-markers-history.log');
const RAW_SOCKET_LOG_PATH = Path.join(LOG_DIR, 'rustplusplus-raw-socket.txt');

function stringify(value) {
    return JSON.stringify(value, (_key, val) => typeof val === 'bigint' ? val.toString() : val);
}

function ensureLogDir() {
    Fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendJsonLine(path, data) {
    ensureLogDir();
    Fs.appendFileSync(path, `${stringify(data)}\n`);
}

function getRawDataBuffer(data) {
    return Array.isArray(data) ? Buffer.concat(data) :
        (Buffer.isBuffer(data) ? data : Buffer.from(data));
}

function appendRawSocketText(rustplus, direction, data) {
    const buffer = getRawDataBuffer(data);
    const header = `\n--- ${new Date().toISOString()} ${direction} guild=${rustplus.guildId} ` +
        `server=${rustplus.serverId} bytes=${buffer.length} ---\n`;
    ensureLogDir();
    Fs.appendFileSync(RAW_SOCKET_LOG_PATH, header);
    Fs.appendFileSync(RAW_SOCKET_LOG_PATH, buffer.toString('utf8'));
    Fs.appendFileSync(RAW_SOCKET_LOG_PATH, '\n');
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
                rustplus.log('DEBUG', `Could not append raw inbound websocket data: ${e}`, 'warning');
            }
        });

        const originalSend = rustplus.websocket.send.bind(rustplus.websocket);
        rustplus.websocket.send = function (data, ...args) {
            try {
                appendRawSocketText(rustplus, 'outbound', data);
            }
            catch (e) {
                rustplus.log('DEBUG', `Could not append raw outbound websocket data: ${e}`, 'warning');
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
            rustplus.log('DEBUG', `Could not append Rust+ debug event: ${e}`, 'warning');
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
            rustplus.log('DEBUG', `Could not append Rust+ marker debug event: ${e}`, 'warning');
        }
    }
};
