// @ts-check
const Crypto = require('node:crypto');
const Path = require('node:path');

const Discord = require('discord.js');

const Scrape = require('../../util/scrape.js');
const ImageAttachment = require('./imageAttachment.js');
const CinfoPanelRefinement = require('./cinfoPanelRefinement.js');
const CinfoRoles = require('./cinfoRoles.js');
const OcrImagePreprocess = require('./ocrImagePreprocess.js');
const { detectImportKind } = require('./detectImportKind.js');
const { parseCinfoWords, splitCinfoWordBlocks } = require('./parseCinfo.js');
const { parseF7Words } = require('./parseF7.js');
const { resolveCinfo } = require('./resolveCinfo.js');
const Runtime = require('./runtime.js');
const TesseractOcr = require('./tesseractOcr.js');
const VisualAliasLibrary = require('./visualAliasLibrary.js');
const WarBandits = require('../warBandits');

const CONFIRM_PREFIX = 'PIImportConfirm:';
const REJECT_PREFIX = 'PIImportReject:';
const TTL_MS = 5 * 60 * 1000;
const MAX_CORROBORATION_QUERIES = 3;
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
        const resolved = Array.isArray(parsed.resolvedMembers) ? parsed.resolvedMembers : parsed.members;
        const members = resolved.map((/** @type {any} */ member) => `${member.name}${
            ['leader', 'moderator'].includes(member.role) ? ` (${member.role})` : ''}`).join(', ');
        const pendingCount = Array.isArray(parsed.unresolvedMembers) ? parsed.unresolvedMembers.length +
            (parsed.missingMemberCount || 0) : 0;
        return [
            `OCR /cinfo — ${parsed.tag || 'unknown'} — ${resolved.length}/${parsed.declaredCount || '?'} linked`,
            `Established: ${parsed.establishedRaw || 'unread'}`,
            `Members: ${members || 'none'}`,
            pendingCount > 0 ?
                `Pending identities: ${pendingCount}. They stay excluded until automatically matched.` : '',
            parsed.errors.length > 0 ? `Warnings: ${parsed.errors.join(' ')}` : 'Ready to commit.'
        ].filter(Boolean).join('\n').slice(0, 1900);
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

/** @param {unknown} words @param {number} scale */
function normalizeWordScale(words, scale) {
    if (!Array.isArray(words)) throw new TypeError('OCR provider returned an invalid word list.');
    if (scale === 1) return words;
    return Object.freeze(words.map((/** @type {any} */ word) => Object.freeze({
        ...word,
        x: word.x / scale,
        y: word.y / scale,
        width: word.width / scale,
        height: word.height / scale
    })));
}

/** @param {readonly any[]} words @param {'cinfo'|'f7'|null} kindHint @param {any} dependencies */
function parseRecognizedWords(words, kindHint, dependencies) {
    const kind = detectImportKind(words);
    if (kindHint && kind !== kindHint) {
        throw new Error(`Declared ${kindHint} image was detected as ${kind}.`);
    }
    const blocks = kind === 'f7' ?
        [{ words, parsed: parseF7Words(words, dependencies.f7Options) }] :
        splitCinfoWordBlocks(words).map(blockWords => ({
            words: blockWords,
            parsed: parseCinfoWords(blockWords, dependencies.cinfoOptions)
        }));
    return Object.freeze({ kind, blocks: Object.freeze(blocks) });
}

/** @param {{kind:string,blocks:readonly any[]}} result */
function recognitionQuality(result) {
    if (result.kind === 'f7') {
        const parsed = result.blocks[0].parsed;
        return parsed.entries.length * 100 + (parsed.complete ? 40 : 0) -
            parsed.rejectedPartialIds.length * 4 - parsed.errors.length * 2;
    }
    return result.blocks.reduce((score, block) => score + cinfoBlockQuality(block), 0);
}

/** @param {{parsed:any}} block */
function cinfoBlockQuality(block) {
    const parsed = block.parsed;
    const structure = Number(Boolean(parsed.tag)) + Number(Number.isSafeInteger(parsed.declaredCount)) +
        Number(Boolean(parsed.establishedAtUtc));
    return 1000 + structure * 100 + parsed.members.length * 12 +
        (parsed.complete ? 50 : 0) - parsed.errors.length * 3;
}

/** @param {{label:string,result:any,quality:number}[]} recognized */
function selectRecognizedResult(recognized) {
    recognized.sort((left, right) => right.quality - left.quality ||
        Number(right.label === 'text-mask') - Number(left.label === 'text-mask'));
    const selected = recognized[0].result;
    if (selected.kind !== 'cinfo' || recognized.length === 1) return selected;
    const blocks = selected.blocks.map((/** @type {any} */ block, /** @type {number} */ index) => {
        const tag = `${block.parsed.tag || ''}`.normalize('NFKC').toLocaleLowerCase('en');
        const candidates = [block];
        for (const variant of recognized.slice(1)) {
            const sameTag = tag ? variant.result.blocks.filter((/** @type {any} */ candidate) =>
                `${candidate.parsed.tag || ''}`.normalize('NFKC').toLocaleLowerCase('en') === tag) : [];
            const candidate = sameTag.length === 1 ? sameTag[0] :
                variant.result.blocks.length === selected.blocks.length ? variant.result.blocks[index] : null;
            if (candidate) candidates.push(candidate);
        }
        return candidates.sort((left, right) => cinfoBlockQuality(right) - cinfoBlockQuality(left))[0];
    });
    return Object.freeze({ kind: 'cinfo', blocks: Object.freeze(blocks) });
}

/**
 * @param {any} client
 * @param {'cinfo'|'f7'|null} kindHint
 * @param {any} attachment
 * @param {string} reference
 * @param {number} attachmentIndex
 * @param {readonly string[]} [userWords]
 */
async function parseAttachment(client, kindHint, attachment, reference, attachmentIndex, userWords = []) {
    const dependencies = importDependencies(client);
    const image = await (dependencies.downloadImage || ImageAttachment.downloadImage)(attachment, dependencies);
    const recognize = dependencies.recognize || TesseractOcr.recognize;
    const ocrOptions = {
        executable: dependencies.tesseractPath,
        language: dependencies.language || 'eng',
        psm: kindHint === 'cinfo' ? 6 : 11,
        timeoutMs: dependencies.ocrTimeoutMs,
        userWords
    };
    /** @type {{label:string,result:any,quality:number}[]} */
    const recognized = [];
    /** @type {unknown[]} */
    const failures = [];
    if (dependencies.disableOcrPreprocessing !== true) {
        try {
            const preprocess = dependencies.preprocessImage || OcrImagePreprocess.createTextMask;
            const processed = await preprocess(image.imageBase64, dependencies);
            if (processed) {
                const words = normalizeWordScale(await recognize(processed.imageBase64, ocrOptions), processed.scale);
                const result = parseRecognizedWords(words, kindHint, dependencies);
                recognized.push({ label: 'text-mask', result, quality: recognitionQuality(result) });
            }
        }
        catch (error) {
            failures.push(error);
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Optional OCR text-mask pass failed: ${sanitizeError(error)}`, 'warn');
            }
        }
    }
    try {
        const words = normalizeWordScale(await recognize(image.imageBase64, ocrOptions), 1);
        const result = parseRecognizedWords(words, kindHint, dependencies);
        recognized.push({ label: 'raw', result, quality: recognitionQuality(result) });
    }
    catch (error) {
        failures.push(error);
    }
    if (recognized.length === 0) {
        const reason = failures.at(-1);
        throw reason instanceof Error ? reason : new Error('No OCR variant produced a valid semantic result.');
    }
    const selected = selectRecognizedResult(recognized);
    const { kind } = selected;
    let blocks = selected.blocks;
    if (kind === 'cinfo' && blocks.some((/** @type {any} */ block) =>
        !block.parsed.complete || !block.parsed.establishedAtUtc)) {
        try {
            const refine = dependencies.refineCinfoPanels || CinfoPanelRefinement.refineCinfoPanels;
            const refined = await refine(image.imageBase64, blocks, recognize, ocrOptions, dependencies);
            if (!refined || !Array.isArray(refined.blocks) || refined.blocks.length !== blocks.length) {
                throw new TypeError('Cinfo panel refiner returned an invalid result.');
            }
            blocks = refined.blocks;
            if (refined.warning && typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Optional cinfo panel refinement: ${refined.warning}`, 'warn');
            }
        }
        catch (error) {
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Optional cinfo panel refinement failed: ${
                    sanitizeError(error)}`, 'warn');
            }
        }
    }
    /** @type {readonly (readonly any[])[]} */
    let visualSamples = Object.freeze(blocks.map(() => Object.freeze([])));
    if (kind === 'cinfo') {
        try {
            const inferBatch = dependencies.inferCinfoRoleHintsBatch || CinfoRoles.inferCinfoRoleHintsBatch;
            const roleHints = await inferBatch(image.imageBase64, blocks, dependencies);
            blocks = blocks.map((/** @type {any} */ block, /** @type {number} */ index) => ({ ...block,
                parsed: block.parsed.members.length > 0 ? parseCinfoWords(block.words,
                    { ...dependencies.cinfoOptions, roleHints: roleHints[index] }) : block.parsed }));
        }
        catch (error) {
            blocks = blocks.map((/** @type {any} */ block) => ({ ...block,
                parsed: block.parsed.members.length > 0 ? parseCinfoWords(block.words, {
                    ...dependencies.cinfoOptions,
                    roleHints: block.parsed.members.map((/** @type {any} */ member) =>
                        ({ name: member.name, role: 'unknown' }))
                }) : block.parsed }));
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Optional role-color read failed: ${sanitizeError(error)}`, 'warn');
            }
        }
    }
    try {
        const extract = dependencies.extractVisualSamples || dependencies.extractCinfoVisualSamples ||
            VisualAliasLibrary.extractVisualSamples;
        visualSamples = await extract(image.imageBase64, blocks, dependencies);
    }
    catch (error) {
        if (typeof client.log === 'function') {
            client.log('PLAYER_INTELLIGENCE', `Optional visual alias extraction failed: ${
                sanitizeError(error)}`, 'warn');
        }
    }
    return Object.freeze(blocks.map((/** @type {any} */ block, /** @type {number} */ index) => {
        const hash = blocks.length === 1 ? image.sha256 : Crypto.createHash('sha256')
            .update(`${image.sha256}:${kind}:${index}`, 'utf8').digest('hex');
        return Object.freeze({
            parsed: block.parsed,
            sha256: hash,
            reference: `${reference}:attachment:${attachmentIndex}:block:${index}`,
            visualSamples: Object.freeze(visualSamples[index] || [])
        });
    }));
}

/** @param {readonly {parsed:any}[]} items @param {number} limit */
function corroborationQueries(items, limit) {
    const steamScores = new Map();
    /** @type {string[]} */
    const observedNames = [];
    for (const item of items) {
        if (item.parsed.kind !== 'cinfo') continue;
        for (const member of item.parsed.unresolvedMembers || []) {
            for (const candidate of member.candidates || []) {
                if (!/^7656119\d{10}$/u.test(`${candidate.steamId || ''}`) || candidate.score < 0.55) continue;
                steamScores.set(candidate.steamId, Math.max(steamScores.get(candidate.steamId) || 0,
                    candidate.score));
            }
            if (member.observedText && !observedNames.includes(member.observedText)) {
                observedNames.push(member.observedText);
            }
        }
    }
    const queries = [...steamScores.entries()].sort((left, right) => right[1] - left[1] ||
        left[0].localeCompare(right[0])).map(([value]) => ({ kind: 'steam', value }));
    for (const value of observedNames) {
        if (queries.length >= limit) break;
        queries.push({ kind: 'name', value });
    }
    return Object.freeze(queries.slice(0, limit).map(query => Object.freeze(query)));
}

/** @param {any} context @param {readonly {parsed:any}[]} items @param {any} client @param {any} dependencies */
async function corroborateCandidateAliases(context, items, client, dependencies) {
    if (dependencies.enableExternalCorroboration === false) return Object.freeze([]);
    const configuredLimit = dependencies.maxCorroborationQueries === undefined ? MAX_CORROBORATION_QUERIES :
        Number(dependencies.maxCorroborationQueries);
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 0) {
        throw new TypeError('maxCorroborationQueries must be a non-negative integer.');
    }
    const queries = corroborationQueries(items, Math.min(MAX_CORROBORATION_QUERIES, configuredLimit));
    if (queries.length === 0) return Object.freeze([]);
    const scope = Runtime.getScope(context);
    if (!scope) return Object.freeze([]);
    const provider = dependencies.warBanditsProvider === null ? null :
        dependencies.warBanditsProvider || WarBandits;
    const steamProfileName = dependencies.steamProfileName ||
        ((/** @type {string} */ steamId) => Scrape.scrapeSteamProfileName(client, steamId));
    const aliases = new Map();
    const steamIds = new Set();
    /** @param {unknown} rawName @param {unknown} rawSteamId */
    function addAlias(rawName, rawSteamId) {
        const name = `${rawName || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ')
            .replace(/\s+/gu, ' ').trim();
        const steamId = `${rawSteamId || ''}`;
        if (!name || name.length > 128 || !/^7656119\d{10}$/u.test(steamId)) return;
        aliases.set(`${steamId}\u0000${name}`, Object.freeze({
            name, steamId, battlemetricsPlayerId: null, caseFidelity: true, corroborated: true
        }));
        steamIds.add(steamId);
    }

    for (const query of queries) {
        if (query.kind === 'steam') steamIds.add(query.value);
        if (!provider || typeof provider.resolvePlayer !== 'function') continue;
        try {
            const result = await provider.resolvePlayer(context, scope, query.value);
            const player = result && result.available && !result.ambiguous && result.player;
            if (!player || !/^7656119\d{10}$/u.test(`${player.steamId || ''}`) ||
                (query.kind === 'steam' && `${player.steamId}` !== query.value)) continue;
            addAlias(player.name, player.steamId);
            for (const alias of Array.isArray(player.aliases) ? player.aliases : []) {
                addAlias(alias, player.steamId);
            }
        }
        catch (error) {
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE',
                    `WarBandits candidate corroboration unavailable: ${sanitizeError(error)}`, 'warn');
            }
        }
    }
    for (const steamId of [...steamIds].slice(0, MAX_CORROBORATION_QUERIES)) {
        try {
            addAlias(await steamProfileName(steamId), steamId);
        }
        catch (error) {
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE',
                    `Steam candidate corroboration unavailable: ${sanitizeError(error)}`, 'warn');
            }
        }
    }
    return Object.freeze([...aliases.values()]);
}

/**
 * @param {any} client @param {any} source
 * @param {readonly {kindHint:'cinfo'|'f7'|null,attachment:any}[]} requests
 * @param {string|null} requesterUserId @param {string} reference
 */
async function prepareImports(client, source, requests, requesterUserId, reference) {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 10) {
        throw new Error('Attach between 1 and 10 PNG/JPEG/WebP images.');
    }
    const context = contextFor(client, source);
    const dependencies = importDependencies(client);
    const loadCandidates = dependencies.identityCandidates || Runtime.identityCandidates;
    const persistedCandidates = await loadCandidates(context);
    if (!Array.isArray(persistedCandidates)) {
        throw new TypeError('Identity candidate provider returned an invalid result.');
    }
    const userWords = Object.freeze(persistedCandidates.map((/** @type {any} */ candidate) => candidate.name)
        .filter((/** @type {any} */ name) => typeof name === 'string'));
    /** @type {any[]} */
    const rawItems = [];
    for (let index = 0; index < requests.length; index += 1) {
        rawItems.push(...await parseAttachment(client, requests[index].kindHint, requests[index].attachment,
            reference, index, userWords));
    }
    const scopeBeforeResolution = Runtime.getScope(context);
    const visualFile = scopeBeforeResolution ? Path.join(Runtime.getDataDirectory(context, scopeBeforeResolution),
        'visual-alias-library.json') : null;
    /** @type {readonly (readonly any[])[]} */
    let visualCandidates = Object.freeze(rawItems.map(() => Object.freeze([])));
    if (visualFile) {
        try {
            const loadVisual = dependencies.visualCandidatesForItems || VisualAliasLibrary.candidatesForItems;
            visualCandidates = await loadVisual(visualFile, rawItems);
            if (!Array.isArray(visualCandidates) || visualCandidates.length !== rawItems.length) {
                throw new TypeError('Visual alias candidate provider returned an invalid result.');
            }
        }
        catch (error) {
            visualCandidates = Object.freeze(rawItems.map(() => Object.freeze([])));
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Visual alias library unavailable: ${sanitizeError(error)}`, 'warn');
            }
        }
    }
    const batchF7Candidates = rawItems.flatMap(item => item.parsed.kind === 'f7' ?
        item.parsed.entries.filter((/** @type {any} */ entry) => entry.name).map((/** @type {any} */ entry) => ({
            name: entry.name,
            steamId: entry.steamId,
            battlemetricsPlayerId: null,
            caseFidelity: false
        })) : []);
    const candidates = Object.freeze([...persistedCandidates, ...batchF7Candidates]);
    const resolveItems = (/** @type {readonly any[]} */ sourceCandidates) => {
        const byStableId = new Map();
        for (const candidate of sourceCandidates) {
            const key = candidate.steamId ? `steam:${candidate.steamId}` : candidate.battlemetricsPlayerId ?
                `battlemetrics:${candidate.battlemetricsPlayerId}` : null;
            if (!key) continue;
            const values = byStableId.get(key) || [];
            values.push(candidate);
            byStableId.set(key, values);
        }
        return rawItems.map((item, itemIndex) => {
            const visual = visualCandidates[itemIndex];
            const enrichedVisual = [...visual];
            for (const match of visual) {
                const key = match.steamId ? `steam:${match.steamId}` : match.battlemetricsPlayerId ?
                    `battlemetrics:${match.battlemetricsPlayerId}` : null;
                for (const known of key && byStableId.get(key) || []) {
                    enrichedVisual.push(Object.freeze({
                        ...known,
                        corroborated: known.corroborated === true || match.corroborated === true,
                        contextPriority: true,
                        targetMemberIndex: match.targetMemberIndex,
                        visualScore: match.visualScore
                    }));
                }
            }
            return Object.freeze({
        ...item,
        parsed: item.parsed.kind === 'cinfo' ?
            resolveCinfo(item.parsed, Object.freeze([...sourceCandidates, ...enrichedVisual]),
                dependencies.nameSimilarityOptions) : item.parsed
            });
        });
    };
    let items = resolveItems(candidates);
    const corroborate = dependencies.corroborateCandidates || corroborateCandidateAliases;
    const corroborated = await corroborate(context, items, client, dependencies);
    if (!Array.isArray(corroborated)) {
        throw new TypeError('Candidate corroboration returned an invalid result.');
    }
    if (corroborated.length > 0) items = resolveItems(Object.freeze([...candidates, ...corroborated]));
    if (items.length < 1 || items.length > 20) throw new Error('Detected import block count must be between 1 and 20.');
    const preview = previewItems(items);
    if (Array.from(preview).length > 1900) {
        return Object.freeze({
            content: `Detected ${items.length} import blocks, but the confirmation preview is too long. ` +
                'Split the upload into smaller batches. Nothing was committed.',
            components: [], allowedMentions: { parse: [] }
        });
    }
    if (items.some(item => item.parsed.kind === 'f7' ? !item.parsed.complete : !item.parsed.importable)) {
        return Object.freeze({
            content: `${preview}\nNothing was committed.`, components: [],
            allowedMentions: { parse: [] }
        });
    }
    const scope = Runtime.getScope(context);
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
        visualFile,
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
            content: 'Attach between 1 and 10 PNG/JPEG/WebP images. Type detection is automatic. Nothing was committed.',
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

/** @param {any} context @param {readonly any[]} parsedItems @param {any} client */
async function recrossWarBandits(context, parsedItems, client) {
    const dependencies = importDependencies(client);
    const provider = dependencies.warBanditsProvider || WarBandits;
    if (!provider || typeof provider.resolvePlayer !== 'function') return;
    try {
        const scope = Runtime.getScope(context);
        if (!scope) return;
        const ranked = new Map();
        /** @param {unknown} rawSteamId @param {unknown} rawName @param {number} score */
        function addCandidate(rawSteamId, rawName, score) {
            const steamId = `${rawSteamId || ''}`;
            if (!/^7656119\d{10}$/u.test(steamId)) return;
            const previous = ranked.get(steamId);
            if (!previous || score > previous.score) ranked.set(steamId, {
                steamId, name: `${rawName || ''}`, score
            });
        }
        for (const parsed of parsedItems) {
            if (parsed.kind === 'cinfo') {
                for (const member of parsed.resolvedMembers || []) {
                    addCandidate(member.steamId, member.name, 2);
                }
                for (const member of parsed.unresolvedMembers || []) {
                    for (const candidate of member.candidates || []) {
                        addCandidate(candidate.steamId, candidate.name, candidate.score);
                    }
                }
            }
            else if (parsed.kind === 'f7') {
                for (const entry of parsed.entries || []) addCandidate(entry.steamId, entry.name, 1);
            }
        }
        for (const candidate of await Runtime.linkedClanSteamCandidates(context)) {
            addCandidate(candidate.steamId, candidate.name, 0.5);
        }
        const candidates = [...ranked.values()].sort((left, right) =>
            right.score - left.score || left.steamId.localeCompare(right.steamId)).slice(0, 3);
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
    let result;
    try {
        result = await Runtime.commitParsedImports(context, item.items.map((/** @type {any} */ entry) => ({
            parsed: entry.parsed,
            metadata: { sha256: entry.sha256, reference: entry.reference }
        })));
    }
    catch (error) {
        pending.delete(token);
        await respondButton(client, interaction,
            `Import failed safely: ${sanitizeError(error)} Nothing was committed.`);
        return true;
    }
    pending.delete(token);
    await respondButton(client, interaction, result.duplicate ?
        'Every detected block was already imported; no duplicate event was added.' :
        `Import committed (${result.imported} block${result.imported === 1 ? '' : 's'}, ${
            result.appended} event${result.appended === 1 ? '' : 's'}${
            result.duplicates > 0 ? `, ${result.duplicates} duplicate block(s) skipped` : ''}).`);
    if (!result.duplicate) {
        if (item.visualFile) {
            try {
                const dependencies = importDependencies(client);
                const recordVisual = dependencies.recordVisualAliases || VisualAliasLibrary.recordResolved;
                await recordVisual(item.visualFile, item.items, new Date().toISOString());
            }
            catch (error) {
                if (typeof client.log === 'function') {
                    client.log('PLAYER_INTELLIGENCE', `Visual alias library update failed after commit: ${
                        sanitizeError(error)}`, 'warn');
                }
            }
        }
        void recrossWarBandits(context,
            item.items.map((/** @type {any} */ entry) => entry.parsed), client);
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
    previewText,
    selectRecognizedResult
});
