/*
    Relay Rust+ SmartAlarm-channel FCM notifications to the active Rust team.

    This covers vanilla Smart Alarms, haggbart Raid Alarm and server-specific
    raid integrations without depending on a fragile title/body contract.
*/

const Path = require('path');

const DEFAULT_TITLE = 'You\'re getting raided!';
const RAID_TITLE = /^(?:you(?:'|\u2019)?re|you\s+are)?\s*getting\s+raided!?\s*$/i;
const DEDUPLICATION_MS = 5000;
const recentAlerts = new Map();

function isRaidTitle(title) {
    return typeof title === 'string' && RAID_TITLE.test(title);
}

function matches(context) {
    return Boolean(context && context.channelId === 'alarm');
}

function validateContext(context) {
    if (!context.client || typeof context.client.getInstance !== 'function') {
        throw new TypeError('Raid Alarm client is invalid.');
    }
    if (!context.guild || typeof context.guild.id !== 'string') {
        throw new TypeError('Raid Alarm guild is invalid.');
    }
    if (!context.body || typeof context.body.ip !== 'string' ||
        !['string', 'number'].includes(typeof context.body.port)) {
        throw new TypeError('Raid Alarm server identity is invalid.');
    }
}

function getText(client, guildId, title, message) {
    let translatedTitle = typeof title === 'string' && title.trim() !== '' ?
        title.trim() : client.intlGet(guildId, 'smartAlarm');
    let translatedMessage = typeof message === 'string' ? message.trim() : '';

    if (isRaidTitle(translatedTitle)) translatedTitle = client.intlGet(guildId, 'baseIsUnderAttack');

    const destroyedMatch = /^(.*) destroyed at (.*)$/i.exec(translatedMessage);
    if (destroyedMatch) {
        translatedMessage = client.intlGet(guildId, 'raidAlarmDestroyedAt', {
            item: destroyedMatch[1],
            location: destroyedMatch[2]
        });
    }

    return Object.freeze({ title: translatedTitle, message: translatedMessage });
}

function logFailure(client, guildId, output, error) {
    client.log('PLUGIN', `GuildID: ${guildId}, raid-alarm.${output}: ${error}`, 'warn');
}

async function deliver(client, guildId, output, callback) {
    try {
        await callback();
        return true;
    }
    catch (error) {
        logFailure(client, guildId, output, error);
        return false;
    }
}

function getInGameBlockReason(instance, rustplus) {
    if (!rustplus) return 'Rust+ is not connected';
    if (!instance || !instance.generalSettings) return 'guild settings are unavailable';
    if (!instance.generalSettings.smartAlarmNotifyInGame) return 'the Raid Alarm in-game setting is disabled';
    if (instance.generalSettings.muteInGameBotMessages ||
        (rustplus.generalSettings && rustplus.generalSettings.muteInGameBotMessages)) {
        return 'in-game bot messages are muted';
    }
    return null;
}

function logInGameRoute(client, guildId, message, level = 'info') {
    client.log('PLUGIN', `GuildID: ${guildId}, raid-alarm.in-game: ${message}`, level);
}

function getDefaultDiscordAdapter() {
    const Discord = require('discord.js');
    const DiscordEmbeds = require('../../discordTools/discordEmbeds.js');
    const DiscordMessages = require('../../discordTools/discordMessages.js');

    return async (context, alertText, instance) => {
        const files = [];
        if (typeof context.body.img !== 'string' || context.body.img === '') {
            files.push(new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', '..', 'resources/images/rocket.png')));
        }

        const content = Object.freeze({
            embeds: Object.freeze([
                DiscordEmbeds.getAlarmRaidAlarmEmbed(alertText, context.body)
            ]),
            content: '@everyone',
            files: Object.freeze(files)
        });

        await DiscordMessages.sendMessage(
            context.guild.id, content, null, instance.channelId.activity);
    };
}

function getServerId(body) {
    return `${body.ip}`.trim() + '-' + `${body.port}`.trim();
}

function formatAlert(alertText) {
    return [alertText.title, alertText.message].filter(value => value !== '').join(': ');
}

function getDeduplicationKey(guildId, serverId, alertText) {
    return `${guildId}|${serverId}|${alertText.title}|${alertText.message}`.toLocaleLowerCase('en');
}

function claimAlert(key, now) {
    for (const [storedKey, timestamp] of recentAlerts) {
        if (now - timestamp >= DEDUPLICATION_MS) recentAlerts.delete(storedKey);
    }
    if (recentAlerts.has(key)) return false;
    recentAlerts.set(key, now);
    return true;
}

async function sendInGameAlert(rustplus, text) {
    const sender = typeof rustplus.sendCriticalInGameMessage === 'function' ?
        rustplus.sendCriticalInGameMessage.bind(rustplus) : rustplus.sendInGameMessage.bind(rustplus);
    const result = await sender(text);
    if (result === false) throw new Error('Rust+ rejected the in-game alarm.');
}

async function handleCommand(context) {
    const expected = `${context.prefix}raidtest`.toLowerCase();
    if (context.commandLowerCase !== expected) return Object.freeze({ handled: false });

    const instance = context.client.getInstance(context.guildId);
    const rustplus = context.client.rustplusInstances[context.guildId];
    const blockReason = getInGameBlockReason(instance, rustplus);
    if (blockReason) {
        logInGameRoute(context.client, context.guildId, `test failed; ${blockReason}.`, 'warn');
        return Object.freeze({
            handled: true,
            response: `Raid alert test failed: ${blockReason}.`,
            logType: 'RaidAlarmTest'
        });
    }

    const alert = `[RAID TEST] ${context.client.intlGet(context.guildId, 'baseIsUnderAttack')}`;
    const delivered = await deliver(context.client, context.guildId, 'in-game-test', () =>
        sendInGameAlert(rustplus, alert));
    if (delivered) logInGameRoute(context.client, context.guildId, `test delivered for ${rustplus.serverId}.`);
    return Object.freeze({
        handled: true,
        response: context.source === 'discord' ?
            (delivered ? 'Raid alert test delivered to Rust team chat.' : 'Raid alert test failed; check bot logs.') : null,
        logType: 'RaidAlarmTest'
    });
}

async function handleFcmAlarm(context, adapters = {}) {
    if (!matches(context)) return false;
    validateContext(context);

    const guildId = context.guild.id;
    const instance = context.client.getInstance(guildId);
    const serverId = getServerId(context.body);
    const server = instance && instance.serverList && instance.serverList[serverId];
    const rustplus = context.client.rustplusInstances && context.client.rustplusInstances[guildId];
    const alertText = getText(context.client, guildId, context.title, context.message);

    if (!server) {
        context.client.log('PLUGIN', `GuildID: ${guildId}, Raid Alarm server is not registered: ${serverId}.`, 'warn');
        return true;
    }

    if (!rustplus) {
        logInGameRoute(context.client, guildId, 'skipped; Rust+ is not connected.', 'warn');
    }
    else if (rustplus.serverId !== serverId) {
        logInGameRoute(context.client, guildId,
            `skipped; notification server ${serverId} does not match active server ${rustplus.serverId}.`, 'warn');
    }
    else {
        const deduplicationKey = getDeduplicationKey(guildId, serverId, alertText);
        const now = typeof adapters.now === 'function' ? adapters.now() : Date.now();
        if (adapters.deduplicate !== false && !claimAlert(deduplicationKey, now)) {
            context.client.log('PLUGIN',
                `GuildID: ${guildId}, raid-alarm.duplicate: suppressed for ${serverId}.`);
            return true;
        }

        const blockReason = getInGameBlockReason(instance, rustplus);
        let inGameFailed = false;
        if (blockReason) {
            logInGameRoute(context.client, guildId, `skipped; ${blockReason}.`, 'warn');
        }
        else if (await deliver(context.client, guildId, 'in-game', () =>
            sendInGameAlert(rustplus, formatAlert(alertText)))) {
            logInGameRoute(context.client, guildId, `delivered for ${serverId}.`);
        }
        else {
            inGameFailed = true;
        }

        const sendDiscord = adapters.sendDiscord || getDefaultDiscordAdapter();
        await deliver(context.client, guildId, 'discord', () => sendDiscord(context, alertText, instance));
        if (inGameFailed) recentAlerts.delete(deduplicationKey);
    }

    context.client.log(context.client.intlGet(null, 'infoCap'), `${alertText.title} ${alertText.message}`.trim());
    return true;
}

module.exports = Object.freeze({
    DEFAULT_TITLE,
    getText,
    handleCommand,
    handleFcmAlarm,
    isRaidTitle,
    matches
});
