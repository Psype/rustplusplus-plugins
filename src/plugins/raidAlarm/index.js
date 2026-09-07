/*
    Integration for haggbart's uMod Raid Alarm notifications.

    The server plugin sends a Rust+ SmartAlarm-channel FCM payload directly;
    no vanilla Smart Alarm entity is involved or required.
*/

const Path = require('path');

const DEFAULT_TITLE = 'You\'re getting raided!';
const DEFAULT_MESSAGE = /^.+ destroyed at [A-Z]+\d+$/i;

function matches(context) {
    if (!context || context.channelId !== 'alarm') return false;
    if (context.title === DEFAULT_TITLE) return true;
    return typeof context.message === 'string' && DEFAULT_MESSAGE.test(context.message);
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
    if (typeof context.title !== 'string' || typeof context.message !== 'string') {
        throw new TypeError('Raid Alarm text is invalid.');
    }
}

function getText(client, guildId, title, message) {
    let translatedTitle = title;
    let translatedMessage = message;

    if (title === DEFAULT_TITLE) translatedTitle = client.intlGet(guildId, 'baseIsUnderAttack');

    const destroyedMatch = /^(.*) destroyed at (.*)$/i.exec(message);
    if (destroyedMatch) {
        translatedMessage = client.intlGet(guildId, 'raidAlarmDestroyedAt', {
            item: destroyedMatch[1],
            location: destroyedMatch[2]
        });
    }

    return Object.freeze({ title: translatedTitle, message: translatedMessage });
}

function logFailure(client, guildId, output, error) {
    client.log('PLUGIN', `GuildID: ${guildId}, raid-alarm.${output}: ${error}`, 'warning');
}

async function deliver(client, guildId, output, callback) {
    try {
        await callback();
    }
    catch (error) {
        logFailure(client, guildId, output, error);
    }
}

function getDefaultDiscordAdapter() {
    const Discord = require('discord.js');
    const DiscordEmbeds = require('../../discordTools/discordEmbeds.js');
    const DiscordMessages = require('../../discordTools/discordMessages.js');

    return async (context, raidText, instance) => {
        const files = [];
        if (typeof context.body.img !== 'string' || context.body.img === '') {
            files.push(new Discord.AttachmentBuilder(
                Path.join(__dirname, '..', '..', 'resources/images/rocket.png')));
        }

        const content = Object.freeze({
            embeds: Object.freeze([
                DiscordEmbeds.getAlarmRaidAlarmEmbed(raidText, context.body)
            ]),
            content: '@everyone',
            files: Object.freeze(files)
        });

        await DiscordMessages.sendMessage(
            context.guild.id, content, null, instance.channelId.activity);
    };
}

async function handleFcmAlarm(context, adapters = {}) {
    if (!matches(context)) return false;
    validateContext(context);

    const guildId = context.guild.id;
    const instance = context.client.getInstance(guildId);
    const serverId = `${context.body.ip}-${context.body.port}`;
    const server = instance && instance.serverList && instance.serverList[serverId];
    const rustplus = context.client.rustplusInstances[guildId];
    const raidText = getText(context.client, guildId, context.title, context.message);

    if (!server) {
        context.client.log('PLUGIN', `GuildID: ${guildId}, Raid Alarm server is not registered: ${serverId}.`, 'warning');
        return true;
    }

    if (rustplus && rustplus.serverId === serverId) {
        if (instance.generalSettings.smartAlarmNotifyInGame) {
            await deliver(context.client, guildId, 'in-game', () =>
                rustplus.sendInGameMessage(`${raidText.title}: ${raidText.message}`));
        }

        const sendDiscord = adapters.sendDiscord || getDefaultDiscordAdapter();
        await deliver(context.client, guildId, 'discord', () => sendDiscord(context, raidText, instance));
    }

    context.client.log(context.client.intlGet(null, 'infoCap'), `${raidText.title} ${raidText.message}`);
    return true;
}

module.exports = Object.freeze({
    DEFAULT_TITLE,
    getText,
    handleFcmAlarm,
    matches
});
