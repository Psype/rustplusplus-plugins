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

const Discord = require('discord.js');
const Fs = require('fs');
const Path = require('path');

const Config = require('./config');
const DiscordBot = require('./src/structures/DiscordBot');
const AutoTranslate = require('./src/plugins/autoTranslate');
const PlayerIntelligenceImports = require('./src/plugins/playerIntelligence/importWorkflow.js');
const PlayerScanDaemon = require('./src/plugins/playerIntelligence/scanDaemon.js');
const TesseractOcr = require('./src/plugins/playerIntelligence/isolatedTesseractOcr.js');
const RuntimeTelemetry = require('./src/util/runtimeTelemetry.js');
const AsyncEventBoundary = require('./src/util/asyncEventBoundary.js');
const SerialLoop = require('./src/util/serialLoop.js');

function getIsolatedServicesStatus() {
    const services = [AutoTranslate.getServiceRuntimeStatus(), TesseractOcr.getRuntimeStatus()];
    return Object.freeze({
        active: services.reduce((total, value) => total + value.active, 0),
        queued: services.reduce((total, value) => total + value.queued, 0),
        running: services.reduce((total, value) => total + value.running, 0),
        restarts: services.reduce((total, value) => total + value.restarts, 0),
        failures: services.reduce((total, value) => total + value.failures, 0),
        circuitOpen: services.some(value => value.circuitOpen > 0) ? 1 : 0
    });
}

createMissingDirectories();

const client = new DiscordBot({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.GuildVoiceStates],
    retryLimit: 2,
    restRequestTimeout: 60000,
    disableEveryone: false
});

/* Rust+ startup may run before Discord is ready; expose the client before build(). */
exports.client = client;
RuntimeTelemetry.start({
    enabled: Config.runtimeTelemetry.enabled,
    intervalMs: Config.runtimeTelemetry.intervalMs,
    logger: (title: string, message: string, level: string) =>
        client.log(title, message, level),
    sources: {
        imports: PlayerIntelligenceImports.getRuntimeStatus,
        ocr: TesseractOcr.getRuntimeStatus,
        scans: PlayerScanDaemon.getRuntimeStatus,
        translations: AutoTranslate.getRuntimeStatus,
        services: getIsolatedServicesStatus,
        loops: SerialLoop.getRuntimeStatus
    }
});
client.build();
process.once('exit', () => {
    AutoTranslate.shutdown();
    TesseractOcr.shutdown();
});

function createMissingDirectories() {
    if (!Fs.existsSync(Path.join(__dirname, 'logs'))) {
        Fs.mkdirSync(Path.join(__dirname, 'logs'));
    }

    if (!Fs.existsSync(Path.join(__dirname, 'instances'))) {
        Fs.mkdirSync(Path.join(__dirname, 'instances'));
    }

    if (!Fs.existsSync(Path.join(__dirname, 'credentials'))) {
        Fs.mkdirSync(Path.join(__dirname, 'credentials'));
    }

    if (!Fs.existsSync(Path.join(__dirname, 'maps'))) {
        Fs.mkdirSync(Path.join(__dirname, 'maps'));
    }
}

process.on('unhandledRejection', error => {
    const formatted = AsyncEventBoundary.formatError(error);
    try {
        client.log(client.intlGet(null, 'errorCap'), client.intlGet(null, 'unhandledRejection', {
            error: formatted
        }), 'error');
    }
    catch (_loggingError) {
        try { console.error(`Unhandled rejection: ${formatted}`); }
        catch (_consoleError) { /* Preserve the original process state. */ }
    }
});

process.on('uncaughtExceptionMonitor', error => {
    const formatted = AsyncEventBoundary.formatError(error);
    try {
        client.log('FATAL', `Uncaught exception; process supervisor will restart the bot: ${formatted}`, 'error');
    }
    catch (_loggingError) {
        try { console.error(`Uncaught exception: ${formatted}`); }
        catch (_consoleError) { /* Node will retain its normal fatal behavior. */ }
    }
});
