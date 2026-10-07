/*
    Copyright (C) 2022 Alexander Emanuelsson (alexemanuelol)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

    https://github.com/alexemanuelol/rustplusplus

*/

require('dotenv').config({ quiet: true });

function environmentBoolean(name, fallback) {
    const value = process.env[name];
    if (value === undefined || value === null || value.trim() === '') return fallback;
    return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

function environmentInteger(name, fallback, minimum, maximum) {
    const value = Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return fallback;
    return value;
}

module.exports = {
    general: {
        language: process.env.RPP_LANGUAGE || 'en',
        pollingIntervalMs: process.env.RPP_POLLING_INTERVAL || 10000,
        showCallStackError: process.env.RPP_LOG_CALL_STACK || false,
        reconnectIntervalMs: process.env.RPP_RECONNECT_INTERVAL || 15000,
    },
    discord: {
        username: process.env.RPP_DISCORD_USERNAME || 'rustplusplus',
        clientId: process.env.RPP_DISCORD_CLIENT_ID || '',
        token: process.env.RPP_DISCORD_TOKEN || '',
        needAdminPrivileges: process.env.RPP_NEED_ADMIN_PRIVILEGES || true, /* If true, only admins can delete (server, switch..), manage credentials and reset a channel */
    },
    battlemetrics: {
        token: (process.env.RPP_BATTLEMETRICS_TOKEN || '').trim()
    },
    runtimeTelemetry: {
        enabled: environmentBoolean('RPP_RUNTIME_TELEMETRY', true),
        intervalMs: environmentInteger('RPP_RUNTIME_TELEMETRY_INTERVAL_MS', 60000, 10000, 300000)
    }
};
