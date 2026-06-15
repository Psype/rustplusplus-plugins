/*
    Debug logger for raw Rust+ payload exploration.
    Writes newline-delimited JSON to /tmp so missed event/marker payloads can be inspected offline.
*/

const Fs = require('fs');

const EVENT_LOG_PATH = '/tmp/rustplusplus-events.log';
const MARKER_HISTORY_PATH = '/tmp/rustplus-markers-history.log';

function stringify(value) {
    return JSON.stringify(value, (_key, val) => typeof val === 'bigint' ? val.toString() : val);
}

function appendJsonLine(path, data) {
    Fs.appendFileSync(path, `${stringify(data)}\n`);
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
