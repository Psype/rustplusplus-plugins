/*
    Relay generic Rust+ SmartAlarm push notifications to the active Rust team.

    FCM is the bot transport, not the notification producer. This covers native
    Smart Alarms and every server integration that emits Rust's native
    NotificationChannel.SmartAlarm without depending on a mod or title contract.
*/

const Path = require('path');
const LoggingSettings = require('../../util/loggingSettings.js');

const DEFAULT_TITLE = 'You\'re getting raided!';
const RAID_TITLE = /^(?:you(?:'|\u2019)?re|you\s+are)?\s*getting\s+raided!?\s*$/i;
const DEDUPLICATION_MS = 5000;
const PAIR_WATCH_MS = 120000;
const recentAlerts = new Map();
const pairWatches = new Map();

function formatAge(timestamp, now = Date.now()) {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) return 'unknown';
    const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

function getReadiness(client, guildId, rustplus, now = Date.now()) {
    const instance = client.getInstance(guildId);
    const listener = client.fcmListeners && client.fcmListeners[guildId];
    const state = listener && listener.rppConnectionState;
    const server = instance && instance.serverList && rustplus && instance.serverList[rustplus.serverId];
    const account = !state || !server || server.steamId === undefined ? 'unknown' :
        (String(server.steamId) === String(state.steamId) ? 'match' : 'mismatch');
    const inGame = instance?.generalSettings?.smartAlarmNotifyInGame === true ? 'on' : 'off';
    const muted = instance?.generalSettings?.muteInGameBotMessages === true ||
        rustplus?.generalSettings?.muteInGameBotMessages === true;
    const alarmCount = server && server.alarms && typeof server.alarms === 'object' ?
        Object.keys(server.alarms).length : 0;

    return Object.freeze({
        mcs: state?.status || 'missing',
        push: state?.lastNotificationAt ? 'verified' : 'unverified',
        lastChannelId: state?.lastChannelId || null,
        pairing: state?.lastServerPairingAt ? formatAge(state.lastServerPairingAt, now) : 'unseen',
        alarm: state?.lastAlarmAt ? formatAge(state.lastAlarmAt, now) : 'unseen',
        account,
        inGame,
        mute: muted ? 'on' : 'off',
        rawLog: LoggingSettings.isEnabled() ? 'on' : 'off',
        pairedVanillaAlarms: alarmCount,
        recentAlarms: Object.freeze([...(state?.recentAlarms || [])].slice(0, 5))
    });
}

function readinessSignature(readiness) {
    return [readiness.mcs, readiness.push, readiness.lastChannelId || '-', readiness.alarm === 'unseen' ?
        'unseen' : 'seen', readiness.pairing === 'unseen' ? 'unseen' : 'seen', readiness.account,
    readiness.inGame, readiness.mute, readiness.rawLog,
    readiness.pairedVanillaAlarms].join('|');
}

function formatReadiness(readiness, compact = false) {
    if (compact) {
        return `Alarm MCS ${readiness.mcs} | push ${readiness.push} | pair ${readiness.pairing} | ` +
            `alarm ${readiness.alarm} | account ${readiness.account} | out ${readiness.inGame} | ` +
            `mute ${readiness.mute} | raw ${readiness.rawLog}`;
    }
    return `mcs=${readiness.mcs}; push=${readiness.push}` +
        `${readiness.lastChannelId ? ` (last-channel=${readiness.lastChannelId})` : ''}; ` +
        `pair=${readiness.pairing}; alarm=${readiness.alarm}; account=${readiness.account}; ` +
        `in-game=${readiness.inGame}; ` +
        `mute=${readiness.mute}; rawlog=${readiness.rawLog}; ` +
        `paired-vanilla-alarms=${readiness.pairedVanillaAlarms}.`;
}

function formatAlarmHistory(readiness, now = Date.now()) {
    if (readiness.recentAlarms.length === 0) return Object.freeze(['Last alarms: none since this process started.']);
    return Object.freeze(readiness.recentAlarms.map((alarm, index) => {
        const text = [alarm.title, alarm.message].filter(Boolean).join(': ') || 'Alarm notification';
        const compactText = text.length > 86 ? `${text.slice(0, 83)}...` : text;
        return `${index + 1}) ${formatAge(alarm.receivedAt, now)} ago | ${compactText}`;
    }));
}

function logReadiness({ rustplus, client }) {
    const readiness = getReadiness(client, rustplus.guildId, rustplus);
    const signature = readinessSignature(readiness);
    if (rustplus.raidAlarmReadinessSignature === signature) return;
    rustplus.raidAlarmReadinessSignature = signature;
    client.log('PLUGIN', `GuildID: ${rustplus.guildId}, raid-alarm.ready: ${formatReadiness(readiness)}` +
        (readiness.push === 'unverified' ?
            ' Re-pair the active server once to verify Facepunch push delivery.' : ''));
}

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

function getAppDataValue(data, key) {
    const appData = data && data.appData;
    if (Array.isArray(appData)) return appData.find(item => item && item.key === key)?.value;
    return appData && typeof appData === 'object' ? appData[key] : undefined;
}

function parseNotificationBody(data) {
    const bodyValue = getAppDataValue(data, 'body');
    if (bodyValue && typeof bodyValue === 'object' && !Array.isArray(bodyValue)) return bodyValue;
    if (typeof bodyValue !== 'string') return null;
    try {
        const body = JSON.parse(bodyValue);
        return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    }
    catch (_error) {
        return null;
    }
}

function clearPairWatch(guildId, watch) {
    if (watch.timer) watch.scheduler.clearTimeout(watch.timer);
    if (pairWatches.get(guildId) === watch) pairWatches.delete(guildId);
}

async function sendPairCheckResult(watch, text, outcome) {
    const rustplus = watch.client.rustplusInstances && watch.client.rustplusInstances[watch.guildId];
    if (!rustplus || rustplus.serverId !== watch.serverId) {
        watch.client.log('PLUGIN', `GuildID: ${watch.guildId}, raid-alarm.pair-check: ${outcome}; ` +
            'active Rust+ server is unavailable.', 'warn');
        return false;
    }
    return deliver(watch.client, watch.guildId, `pair-check-${outcome}`, () =>
        sendInGameAlert(rustplus, text));
}

async function expirePairWatch(guildId, watch) {
    if (pairWatches.get(guildId) !== watch) return;
    clearPairWatch(guildId, watch);
    watch.client.log('PLUGIN', `GuildID: ${guildId}, raid-alarm.pair-check: timed out after 120s.`, 'warn');
    await sendPairCheckResult(watch,
        'Pairing not received within 120s; renew the FCM registration.', 'timeout');
}

function armPairWatch(context, readiness, adapters = {}) {
    const now = typeof adapters.now === 'function' ? adapters.now() : Date.now();
    const current = pairWatches.get(context.guildId);
    if (current && current.expiresAt > now) {
        return `Pair check already active for ${Math.ceil((current.expiresAt - now) / 1000)}s.`;
    }
    if (current) clearPairWatch(context.guildId, current);

    const listener = context.client.fcmListeners && context.client.fcmListeners[context.guildId];
    const state = listener && listener.rppConnectionState;
    if (!state || !['connected', 'connecting', 'reconnecting'].includes(state.status)) {
        return `Pair check unavailable: FCM listener ${readiness.mcs}.`;
    }
    if (readiness.account !== 'match') {
        return `Pair check unavailable: listener account ${readiness.account}.`;
    }

    const scheduler = adapters.scheduler || { setTimeout, clearTimeout };
    const watch = {
        client: context.client,
        guildId: context.guildId,
        serverId: context.rustplus.serverId,
        steamId: String(state.steamId),
        expiresAt: now + PAIR_WATCH_MS,
        scheduler,
        timer: null
    };
    pairWatches.set(context.guildId, watch);
    watch.timer = scheduler.setTimeout(() => expirePairWatch(context.guildId, watch), PAIR_WATCH_MS);
    if (watch.timer && typeof watch.timer.unref === 'function') watch.timer.unref();
    context.client.log('PLUGIN', `GuildID: ${context.guildId}, raid-alarm.pair-check: armed for 120s ` +
        `on ${watch.serverId}, SteamID: ${watch.steamId}.`);
    return 'Pair check armed for 120s. Use Pair with Server now.';
}

async function handleFcmNotification(context, adapters = {}) {
    const guildId = context && context.guild && context.guild.id;
    const watch = guildId && pairWatches.get(guildId);
    if (!watch) return false;

    const now = typeof adapters.now === 'function' ? adapters.now() : Date.now();
    if (now >= watch.expiresAt) {
        await expirePairWatch(guildId, watch);
        return false;
    }
    const channelId = getAppDataValue(context.data, 'channelId');
    if (typeof channelId !== 'string' || channelId.trim().toLowerCase() !== 'pairing') return false;
    if (String(context.steamId) !== watch.steamId) return false;

    const body = parseNotificationBody(context.data);
    if (!body || String(body.type).toLowerCase() !== 'server' ||
        typeof body.ip !== 'string' || !['string', 'number'].includes(typeof body.port) ||
        getServerId(body) !== watch.serverId) return false;
    if (body.playerId !== undefined && String(body.playerId) !== watch.steamId) return false;

    clearPairWatch(guildId, watch);
    watch.client.log('PLUGIN', `GuildID: ${guildId}, raid-alarm.pair-check: pairing received for ` +
        `${watch.serverId}, SteamID: ${watch.steamId}, source: ${context.source || 'FCM'}.`);
    await sendPairCheckResult(watch,
        'Pairing received: Facepunch push delivery verified.', 'received');
    return true;
}

async function handleCommand(context) {
    const alarmStatus = `${context.prefix}alarmstatus`.toLowerCase();
    if (context.commandLowerCase === alarmStatus) {
        const readiness = getReadiness(context.client, context.guildId, context.rustplus);
        const response = [formatReadiness(readiness, true)];
        if (readiness.pairing === 'unseen') {
            response.push(armPairWatch(context, readiness, context.raidAlarmAdapters || {}));
        }
        response.push(...formatAlarmHistory(readiness));
        return Object.freeze({
            handled: true,
            response: Object.freeze(response),
            logType: 'AlarmStatus'
        });
    }

    const raidTest = `${context.prefix}raidtest`.toLowerCase();
    if (context.commandLowerCase !== raidTest) return Object.freeze({ handled: false });

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
    PAIR_WATCH_MS,
    formatAlarmHistory,
    formatReadiness,
    getReadiness,
    getText,
    handleCommand,
    handleFcmAlarm,
    handleFcmNotification,
    isRaidTitle,
    logReadiness,
    matches
});
