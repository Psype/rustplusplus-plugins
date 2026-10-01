// @ts-check
const Crypto = require('node:crypto');

const Discord = require('discord.js');

const ImageAttachment = require('./imageAttachment.js');
const CinfoRoles = require('./cinfoRoles.js');
const { detectImportKind } = require('./detectImportKind.js');
const { parseCinfoWords, splitCinfoWordBlocks } = require('./parseCinfo.js');
const { parseF7Words } = require('./parseF7.js');
const Runtime = require('./runtime.js');
const TesseractOcr = require('./tesseractOcr.js');
const WarBandits = require('../warBandits');

const CONFIRM_PREFIX = 'PIImportConfirm:';
const REJECT_PREFIX = 'PIImportReject:';
const TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, any>} */
const pending = new Map();

/** @param {any} client @returns {any} */
function importDependencies(client) {
    return client.playerIntelligenceImportDependencies || {};
}

/** @param {any} client @param {any} interaction */
function contextFor(client, interaction) {
    const instance = client.getInstance(interaction.guildId);
    const rustplus = client.rustplusInstances && client.rustplusInstances[interaction.guildId] || {
        serverId: instance && instance.activeServer,
        isOperational: false,
        generalSettings: { inGameCommandsEnabled: false },
        log: (/** @type {any[]} */ ...values) => client.log('PLAYER_INTELLIGENCE', values.join(' '), 'warn')
    };
    return Object.freeze({
        client,
        guildId: interaction.guildId,
        rustplus,
        playerIntelligenceDependencies: client.playerIntelligenceDependencies || {}
    });
}

/** @param {any} parsed */
function previewText(parsed) {
    if (parsed.kind === 'cinfo') {
        const members = parsed.members.map((/** @type {any} */ member) => `${member.name}${
            ['leader', 'moderator'].includes(member.role) ? ` (${member.role})` : ''}`).join(', ');
        return [
            `OCR /cinfo — ${parsed.tag || 'unknown'} — ${parsed.members.length}/${parsed.declaredCount || '?'}`,
            `Established: ${parsed.establishedRaw || 'unread'}`,
            `Members: ${members || 'none'}`,
            parsed.errors.length > 0 ? `Warnings: ${parsed.errors.join(' ')}` : 'Ready to commit.'
        ].join('\n').slice(0, 1900);
    }
    const idOnly = parsed.entries.filter((/** @type {any} */ entry) => !entry.name).length;
    const pairs = parsed.entries.slice(0, 20).map((/** @type {any} */ entry) =>
        `${entry.steamId} — ${entry.name || '[name hidden/unread]'}`).join('\n');
    return [
        `OCR F7 — ${parsed.entries.length} complete SteamID64 (${idOnly} without a safe name)`,
        pairs,
        parsed.rejectedPartialIds.length > 0 ?
            `Rejected partial IDs: ${parsed.rejectedPartialIds.length}` : '',
        parsed.errors.length > 0 ? `Warnings: ${parsed.errors.join(' ')}` : 'Ready to commit.'
    ].filter(Boolean).join('\n').slice(0, 1900);
}

/** @param {readonly {parsed:any}[]} items */
function previewItems(items) {
    const sections = items.map((item, index) => `${items.length > 1 ? `[${index + 1}/${items.length}] ` : ''}${
        previewText(item.parsed)}`);
    return `${items.length > 1 ? `Detected ${items.length} import blocks.\n` : ''}${sections.join('\n\n')}`;
}

/** @param {string} token */
function actionRow(token) {
    return new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId(`${CONFIRM_PREFIX}${token}`)
            .setLabel('Confirm import').setStyle(Discord.ButtonStyle.Success),
        new Discord.ButtonBuilder().setCustomId(`${REJECT_PREFIX}${token}`)
            .setLabel('Reject').setStyle(Discord.ButtonStyle.Danger)
    );
}

/** @param {unknown} value @returns {ReadonlyArray<string>} */
function normalizeWebhookIds(value) {
    const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : `${value || ''}`.split(',');
    return Object.freeze([...new Set(values.map(item => `${item}`.trim())
        .filter(item => /^\d{17,20}$/.test(item)))]);
}

/** @param {any} client @returns {ReadonlyArray<string>} */
function allowedWebhookIds(client) {
    const dependencies = importDependencies(client);
    return normalizeWebhookIds(dependencies.allowedWebhookIds ?? process.env.RPP_INTEL_IMPORT_WEBHOOK_IDS);
}

/** @param {any} instance @param {any} message */
function isMessageAuthorized(instance, message) {
    const administrator = Boolean(message.member && message.member.permissions &&
        message.member.permissions.has(Discord.PermissionsBitField.Flags.Administrator));
    if (instance.blacklist && instance.blacklist.discordIds &&
        instance.blacklist.discordIds.includes(message.author.id) && !administrator) return false;
    if (instance.role === null || instance.role === undefined) return true;
    return administrator || Boolean(message.member && message.member.roles && message.member.roles.cache &&
        message.member.roles.cache.has(instance.role));
}

/**
 * @param {any} client
 * @param {'cinfo'|'f7'|null} kindHint
 * @param {any} attachment
 * @param {string} reference
 * @param {number} attachmentIndex
 */
async function parseAttachment(client, kindHint, attachment, reference, attachmentIndex) {
    const dependencies = importDependencies(client);
    const image = await (dependencies.downloadImage || ImageAttachment.downloadImage)(attachment, dependencies);
    const words = await (dependencies.recognize || TesseractOcr.recognize)(image.imageBase64, {
        executable: dependencies.tesseractPath,
        language: dependencies.language || 'eng',
        psm: kindHint === 'cinfo' ? 6 : 11,
        timeoutMs: dependencies.ocrTimeoutMs
    });
    const kind = detectImportKind(words);
    if (kindHint && kind !== kindHint) {
        throw new Error(`Declared ${kindHint} image was detected as ${kind}.`);
    }
    let blocks;
    if (kind === 'f7') {
        blocks = [{ words, parsed: parseF7Words(words, dependencies.f7Options) }];
    }
    else {
        blocks = splitCinfoWordBlocks(words).map(blockWords => ({
            words: blockWords,
            parsed: parseCinfoWords(blockWords, dependencies.cinfoOptions)
        }));
        try {
            const inferBatch = dependencies.inferCinfoRoleHintsBatch || CinfoRoles.inferCinfoRoleHintsBatch;
            const roleHints = await inferBatch(image.imageBase64, blocks, dependencies);
            blocks = blocks.map((block, index) => ({ ...block,
                parsed: block.parsed.complete ? parseCinfoWords(block.words,
                    { ...dependencies.cinfoOptions, roleHints: roleHints[index] }) : block.parsed }));
        }
        catch (error) {
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Optional role-color read failed: ${sanitizeError(error)}`, 'warn');
            }
        }
    }
    return Object.freeze(blocks.map((block, index) => {
        const hash = blocks.length === 1 ? image.sha256 : Crypto.createHash('sha256')
            .update(`${image.sha256}:${kind}:${index}`, 'utf8').digest('hex');
        return Object.freeze({
            parsed: block.parsed,
            sha256: hash,
            reference: `${reference}:attachment:${attachmentIndex}:block:${index}`
        });
    }));
}

/**
 * @param {any} client @param {any} source
 * @param {readonly {kindHint:'cinfo'|'f7'|null,attachment:any}[]} requests
 * @param {string|null} requesterUserId @param {string} reference
 */
async function prepareImports(client, source, requests, requesterUserId, reference) {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 10) {
        throw new Error('Attach between 1 and 10 PNG/JPEG images.');
    }
    const items = [];
    for (let index = 0; index < requests.length; index += 1) {
        items.push(...await parseAttachment(client, requests[index].kindHint, requests[index].attachment,
            reference, index));
    }
    if (items.length < 1 || items.length > 20) throw new Error('Detected import block count must be between 1 and 20.');
    const preview = previewItems(items);
    if (Array.from(preview).length > 1900) {
        return Object.freeze({
            content: `Detected ${items.length} import blocks, but the confirmation preview is too long. ` +
                'Split the upload into smaller batches. Nothing was committed.',
            components: [], allowedMentions: { parse: [] }
        });
    }
    if (items.some(item => !item.parsed.complete)) {
        return Object.freeze({
            content: `${preview}\nNothing was committed.`, components: [],
            allowedMentions: { parse: [] }
        });
    }
    const scope = Runtime.getScope(contextFor(client, source));
    if (!scope || (items.some(item => item.parsed.kind === 'cinfo') && !scope.wipeId)) {
        return Object.freeze({
            content: 'Active BattleMetrics server or current wipe is unavailable; nothing was committed.',
            components: []
        });
    }
    const token = Crypto.randomBytes(12).toString('hex');
    const createdAt = Date.now();
    pending.set(token, Object.freeze({
        guildId: `${source.guildId}`,
        channelId: `${source.channelId}`,
        userId: requesterUserId,
        serverKey: scope.serverKey,
        wipeId: scope.wipeId,
        items: Object.freeze(items),
        createdAt,
        expiresAt: createdAt + TTL_MS
    }));
    return Object.freeze({
        content: preview, components: [actionRow(token)], allowedMentions: { parse: [] }
    });
}

/** @param {any} client @param {any} interaction */
async function beginImport(client, interaction) {
    if (!await client.validatePermissions(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const instance = client.getInstance(interaction.guildId);
    if (!instance || interaction.channelId !== instance.channelId.commands) {
        await client.interactionEditReply(interaction, {
            content: 'Use /intelimport in the configured commands channel.', components: []
        });
        return;
    }
    const kind = interaction.options.getSubcommand();
    const attachment = interaction.options.getAttachment('image', true);
    try {
        const payload = await prepareImports(client, interaction, [{ kindHint: kind, attachment }],
            `${interaction.user.id}`, `discord-interaction:${interaction.id}`);
        await client.interactionEditReply(interaction, payload);
    }
    catch (error) {
        await client.interactionEditReply(interaction, {
            content: `Import failed safely: ${sanitizeError(error)} Nothing was committed.`, components: []
        });
    }
}

/** @param {{client:any,message:any}} value */
async function handleMessage({ client, message }) {
    const instance = message && message.guildId ? client.getInstance(message.guildId) : null;
    if (!instance || !instance.channelId || `${message.channelId}` !== `${instance.channelId.intelImports}`) {
        return false;
    }
    const webhookId = message.webhookId ? `${message.webhookId}` : null;
    if (message.author && message.author.bot && !webhookId) return true;
    if (webhookId && !allowedWebhookIds(client).includes(webhookId)) {
        if (typeof client.log === 'function') {
            client.log('PLAYER_INTELLIGENCE', `Ignored unapproved import webhook ${webhookId}.`, 'warn');
        }
        return true;
    }
    if (!webhookId && (!message.author || !isMessageAuthorized(instance, message))) {
        await message.reply({ content: 'You are not allowed to import player intelligence.',
            allowedMentions: { parse: [] } });
        return true;
    }
    const kindMatch = `${message.content || ''}`.trim().match(/^(cinfo|f7)(?:\s|$)/i);
    const attachments = message.attachments && typeof message.attachments.values === 'function' ?
        [...message.attachments.values()] : [];
    if (attachments.length < 1 || attachments.length > 10) {
        await message.reply({
            content: 'Attach between 1 and 10 PNG/JPEG images. Type detection is automatic. Nothing was committed.',
            allowedMentions: { parse: [] }
        });
        return true;
    }
    const kindHint = kindMatch ? /** @type {'cinfo'|'f7'} */ (kindMatch[1].toLowerCase()) : null;
    try {
        const payload = await prepareImports(client, message,
            attachments.map(attachment => ({ kindHint, attachment })),
            webhookId ? null : `${message.author.id}`, `discord-message:${message.id}`);
        await message.reply(payload);
    }
    catch (error) {
        await message.reply({
            content: `Import failed safely: ${sanitizeError(error)} Nothing was committed.`,
            components: [], allowedMentions: { parse: [] }
        });
    }
    return true;
}

/** @param {unknown} error */
function sanitizeError(error) {
    const message = error instanceof Error ? error.message : error;
    return `${message}`.replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** @param {any} client @param {any} interaction @param {string} content */
async function respondButton(client, interaction, content) {
    await client.interactionUpdate(interaction, {
        content, embeds: [], components: [], allowedMentions: { parse: [] }
    });
}

/** @param {any} context @param {any} parsed @param {any} client */
async function recrossWarBandits(context, parsed, client) {
    if (!['cinfo', 'f7'].includes(parsed.kind)) return;
    const dependencies = importDependencies(client);
    const provider = dependencies.warBanditsProvider || WarBandits;
    if (!provider || typeof provider.resolvePlayer !== 'function') return;
    try {
        const scope = Runtime.getScope(context);
        if (!scope) return;
        const candidates = await Runtime.linkedClanSteamCandidates(context);
        for (const candidate of candidates) {
            const result = await provider.resolvePlayer(context, scope, candidate.steamId);
            if (!result || !result.available || result.ambiguous || !result.player ||
                `${result.player.steamId}` !== candidate.steamId) continue;
            await Runtime.recordWarBanditsIdentity(context, result.player, result.observedAt);
        }
    }
    catch (error) {
        if (typeof client.log === 'function') {
            client.log('PLAYER_INTELLIGENCE', `WarBandits corroboration unavailable: ${sanitizeError(error)}`, 'warn');
        }
    }
}

/** @param {{client:any,interaction:any}} value */
async function handleButton({ client, interaction }) {
    const confirm = interaction.customId.startsWith(CONFIRM_PREFIX);
    const reject = interaction.customId.startsWith(REJECT_PREFIX);
    if (!confirm && !reject) return false;
    const token = interaction.customId.slice((confirm ? CONFIRM_PREFIX : REJECT_PREFIX).length);
    const item = pending.get(token);
    if (!item || item.expiresAt < Date.now()) {
        if (item) pending.delete(token);
        await respondButton(client, interaction, 'Import expired or already handled. Nothing was changed.');
        return true;
    }
    if ((item.userId !== null && `${interaction.user.id}` !== item.userId) ||
        `${interaction.guildId}` !== item.guildId || `${interaction.channelId}` !== item.channelId) {
        await client.interactionReply(interaction, {
            content: 'Only the requester can confirm this import in its original channel.', ephemeral: true
        });
        return true;
    }
    if (reject) {
        pending.delete(token);
        await respondButton(client, interaction, 'Import rejected. Nothing was changed.');
        return true;
    }
    if (!await client.validatePermissions(interaction)) return true;
    const context = contextFor(client, interaction);
    const scope = Runtime.getScope(context);
    if (!scope || scope.serverKey !== item.serverKey || scope.wipeId !== item.wipeId) {
        pending.delete(token);
        await respondButton(client, interaction, 'Active server or wipe changed. Nothing was committed.');
        return true;
    }
    try {
        const result = await Runtime.commitParsedImports(context, item.items.map((/** @type {any} */ entry) => ({
            parsed: entry.parsed,
            metadata: { sha256: entry.sha256, reference: entry.reference }
        })));
        pending.delete(token);
        await respondButton(client, interaction, result.duplicate ?
            'Every detected block was already imported; no duplicate event was added.' :
            `Import committed (${result.imported} block${result.imported === 1 ? '' : 's'}, ${
                result.appended} event${result.appended === 1 ? '' : 's'}${
                result.duplicates > 0 ? `, ${result.duplicates} duplicate block(s) skipped` : ''}).`);
        if (!result.duplicate) void recrossWarBandits(context, item.items[0].parsed, client);
    }
    catch (error) {
        pending.delete(token);
        await respondButton(client, interaction,
            `Import failed safely: ${sanitizeError(error)} Nothing was committed.`);
    }
    return true;
}

module.exports = Object.freeze({
    CONFIRM_PREFIX,
    REJECT_PREFIX,
    beginImport,
    handleMessage,
    handleButton,
    normalizeWebhookIds,
    previewItems,
    previewText
});
