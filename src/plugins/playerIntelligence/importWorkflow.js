// @ts-check
const Crypto = require('node:crypto');
const Path = require('node:path');

const Discord = require('discord.js');

const Scrape = require('../../util/scrape.js');
const ImageAttachment = require('./imageAttachment.js');
const CinfoPanelRefinement = require('./cinfoPanelRefinement.js');
const CinfoRoles = require('./cinfoRoles.js');
const F7IdentityValidation = require('./f7IdentityValidation.js');
const F7RowRefinement = require('./f7RowRefinement.js');
const Layout = require('./ocrLayout.js');
const OcrImagePreprocess = require('./ocrImagePreprocess.js');
const { detectImportKind } = require('./detectImportKind.js');
const { applyRoleHints, parseCinfoWords, parseEstablished, splitCinfoWordBlocks } = require('./parseCinfo.js');
const { parseF7Words } = require('./parseF7.js');
const { resolveCinfo } = require('./resolveCinfo.js');
const Runtime = require('./runtime.js');
const TesseractOcr = require('./tesseractOcr.js');
const VisualAliasLibrary = require('./visualAliasLibrary.js');
const OcrCorrectionMemory = require('./ocrCorrectionMemory.js');
const WarBandits = require('../warBandits');

const CONFIRM_PREFIX = 'PIImportConfirm:';
const REJECT_PREFIX = 'PIImportReject:';
const REPLACE_PREFIX = 'PIImportReplace:';
const KEEP_PREFIX = 'PIImportKeep:';
const EDIT_PREFIX = 'PIImportEdit:';
const EDIT_MODAL_PREFIX = 'PIImportEditModal:';
const EDIT_ROSTER_FIELD = 'PIImportRosterNames';
const TTL_MS = 30 * 60 * 1000;
const MAX_CORROBORATION_QUERIES = 3;
/** @type {Map<string, any>} */
const pending = new Map();

/** @param {unknown} value @param {number} limit */
function truncateCharacters(value, limit) {
    return Array.from(`${value || ''}`).slice(0, limit).join('');
}

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
        const parsedMembers = Array.isArray(parsed.members) ? parsed.members : [];
        const resolved = Array.isArray(parsed.resolvedMembers) ? parsed.resolvedMembers : parsedMembers;
        const display = (/** @type {any} */ member) => `${member.name}${
            ['leader', 'moderator'].includes(member.role) ? ` (${member.role})` : ''}`;
        const boundedRoster = parsedMembers.slice(0, 20).map(display);
        if (parsedMembers.length > boundedRoster.length) {
            boundedRoster.push(`+${parsedMembers.length - boundedRoster.length}`);
        }
        const boundedLinked = resolved.slice().sort((/** @type {any} */ left, /** @type {any} */ right) =>
            (left.memberIndex ?? 0) - (right.memberIndex ?? 0)).slice(0, 20).map(display);
        if (resolved.length > boundedLinked.length) boundedLinked.push(`+${resolved.length - boundedLinked.length}`);
        const resolutionGap = Math.max(0, parsedMembers.length - resolved.length);
        const pendingCount = Math.max(resolutionGap, Array.isArray(parsed.unresolvedMembers) ?
            parsed.unresolvedMembers.length + (parsed.missingMemberCount || 0) : 0);
        const showOcrRoster = pendingCount > 0 || !Number.isSafeInteger(parsed.declaredCount);
        const declared = parsed.declaredCount || '?';
        return [
            `${parsed.manualMetadataCorrected ? 'Corrected' : 'OCR'} /cinfo — ${parsed.tag || 'unknown'} — ${
                parsedMembers.length}/${declared} names read · ${
                resolved.length}/${declared} linked`,
            `Established: ${parsed.establishedRaw || 'unread'}`,
            `${parsed.manualRosterCorrected ? 'Corrected roster' : showOcrRoster ? 'OCR roster' : 'Members'}: ${
                (showOcrRoster ? boundedRoster : boundedLinked).join(', ') || 'none'}`,
            showOcrRoster ? `Linked identities: ${boundedLinked.join(', ') || 'none'}` : '',
            showOcrRoster ?
                `Pending identities: ${pendingCount}. They stay excluded until automatically matched.` : '',
            parsed.errors.length > 0 ? `Warnings: ${parsed.errors.join(' ')}` : 'Ready to commit.'
        ].filter(Boolean).join('\n').slice(0, 1900);
    }
    const idOnly = parsed.entries.filter((/** @type {any} */ entry) => !entry.name).length;
    const consensusOnly = parsed.entries.filter((/** @type {any} */ entry) => entry.ocrConsensusOnly === true).length;
    const verified = parsed.entries.length - consensusOnly;
    const pairLabel = parsed.entries.length === 1 ? 'pair' : 'pairs';
    const pairs = parsed.entries.slice(0, 20).map((/** @type {any} */ entry) =>
        `${entry.steamId} — ${entry.name || '[name hidden/unread]'}${
            entry.profileNameRecovered ? ' [Steam-recovered]' :
                entry.ocrConsensusOnly ? ' [OCR-consensus]' : ''}`).join('\n');
    return [
        `OCR F7 — ${parsed.entries.length} ${pairLabel} (${verified} verified, ${consensusOnly} OCR-consensus, ` +
            `${idOnly} without a safe name)`,
        parsed.idRowsRefined > 0 ? `Isolated SteamID rows reread: ${parsed.idRowsRefined}.` : '',
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

/** @param {readonly {parsed:any}[]} items @param {string|null} timingText */
function timedPreview(items, timingText) {
    return `${timingText ? `${timingText}\n` : ''}${previewItems(items)}`;
}

/** @param {any} context @param {readonly {parsed:any}[]} items @param {any} scope
 * @param {string|null} captureTime */
async function resolveImportTiming(context, items, scope, captureTime) {
    void captureTime;
    const itemTimings = items.map(item => {
        if (item.parsed.kind !== 'cinfo') {
            return Object.freeze({ wipeId: scope.wipeId, wipeStart: scope.wipeStart, observedAt: null,
                historical: false });
        }
        const inferred = Runtime.resolveEstablishedScope(context, item.parsed.establishedAtUtc);
        return Object.freeze({ wipeId: inferred.wipeId, wipeStart: inferred.wipeStart,
            observedAt: item.parsed.establishedAtUtc, historical: true });
    });
    const cinfoTimings = items.map((item, index) => ({ item, timing: itemTimings[index] }))
        .filter(value => value.item.parsed.kind === 'cinfo');
    const timingText = cinfoTimings.length === 0 ? null : cinfoTimings.length === 1 ?
        `Wipe inferred from Established: ${cinfoTimings[0].timing.wipeStart} | capture time not used` :
        `Wipes inferred independently from Established: ${cinfoTimings.map(value => `${value.item.parsed.tag}=${
            value.timing.wipeStart}`).join('; ')}`;
    return Object.freeze({
        activeWipeId: scope.wipeId,
        itemTimings: Object.freeze(itemTimings),
        historical: itemTimings.every(value => value.historical),
        requiresActiveWipe: itemTimings.some(value => !value.historical),
        timingText
    });
}

/** @param {readonly any[]} events */
function previousImportText(events) {
    const snapshot = events.find(event => event.kind === 'clan_snapshot');
    if (snapshot) {
        const members = [
            ...snapshot.payload.members.map((/** @type {any} */ member) => member.name || member.steamId || '?'),
            ...(snapshot.payload.unresolvedMembers || []).map((/** @type {any} */ member) => member.observedText)
        ];
        return [`Previous /cinfo — ${snapshot.payload.tag} — ${members.length}/${
            snapshot.payload.declaredMemberCount ?? '?'} names`,
        `Established: ${snapshot.payload.establishedAt || 'unread'}`,
        `Members: ${members.slice(0, 20).join(', ') || 'none'}${
            members.length > 20 ? `, +${members.length - 20}` : ''}`].join('\n');
    }
    const identities = events.filter(event => event.kind === 'identity_observed');
    return [`Previous F7 — ${identities.length} entries`, identities.slice(0, 20).map(event =>
        `${event.subject.steamId || '?'} — ${event.subject.exactName || '[name hidden/unread]'}`).join('\n')]
        .filter(Boolean).join('\n');
}

/** @param {readonly any[]} items @param {readonly any[]} existing */
function replacementPreview(items, existing) {
    const previous = existing.map((group, index) => `${existing.length > 1 ?
        `[${index + 1}/${existing.length}] ` : ''}${previousImportText(group.events)}`).join('\n\n');
    const footer = 'Choose Replace previous or Keep existing. Nothing has changed yet.';
    const body = `Duplicate evidence detected.\n\n${previous}\n\nProposed replacement:\n${previewItems(items)}`;
    const budget = Math.max(0, 1900 - Array.from(footer).length - 2);
    return `${truncateCharacters(body, budget)}\n\n${footer}`;
}

/** @param {string} token @param {readonly any[]} items @param {'confirm'|'replace'} mode */
function actionRows(token, items, mode = 'confirm') {
    const rows = [new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder().setCustomId(`${mode === 'replace' ? REPLACE_PREFIX : CONFIRM_PREFIX}${token}`)
            .setLabel(mode === 'replace' ? 'Replace previous' : 'Confirm import')
            .setStyle(mode === 'replace' ? Discord.ButtonStyle.Primary : Discord.ButtonStyle.Success),
        new Discord.ButtonBuilder().setCustomId(`${mode === 'replace' ? KEEP_PREFIX : REJECT_PREFIX}${token}`)
            .setLabel(mode === 'replace' ? 'Keep existing' : 'Reject')
            .setStyle(mode === 'replace' ? Discord.ButtonStyle.Secondary : Discord.ButtonStyle.Danger)
    )];
    const editable = items.map((item, index) => ({ item, index })).filter(({ item }) => {
        if (!item.parsed || item.parsed.kind !== 'cinfo' || !Number.isSafeInteger(item.parsed.declaredCount) ||
            item.parsed.declaredCount < 1 || item.parsed.declaredCount > 100) return false;
        const value = item.parsed.members.map((/** @type {any} */ member) => member.name).join('\n');
        return Array.from(value).length <= 4000;
    });
    for (let offset = 0; offset < editable.length; offset += 5) {
        rows.push(new Discord.ActionRowBuilder().addComponents(...editable.slice(offset, offset + 5)
            .map(({ item, index }) => new Discord.ButtonBuilder()
                .setCustomId(`${EDIT_PREFIX}${token}:${index}`)
                .setLabel(truncateCharacters(
                    `Edit ${items.length > 1 ? `${index + 1}: ` : ''}${item.parsed.tag}`, 80))
                .setStyle(Discord.ButtonStyle.Secondary))));
    }
    return Object.freeze(rows);
}

/** @param {string} token @param {number} index @param {any} item */
function rosterEditModal(token, index, item) {
    const value = [item.parsed.tag, item.parsed.establishedRaw,
        ...item.parsed.members.map((/** @type {any} */ member) => member.name)].join('\n');
    const input = new Discord.TextInputBuilder()
        .setCustomId(EDIT_ROSTER_FIELD)
        .setLabel('Tag, date, then one player per line')
        .setStyle(Discord.TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(4000);
    if (value) input.setValue(value);
    return new Discord.ModalBuilder()
        .setCustomId(`${EDIT_MODAL_PREFIX}${token}:${index}`)
        .setTitle(truncateCharacters(`Edit /cinfo — ${item.parsed.tag}`, 45))
        .addComponents(/** @type {any} */ (new Discord.ActionRowBuilder().addComponents(input)));
}

/** @param {unknown} value @param {number} declaredCount */
function parseCorrectedRoster(value, declaredCount) {
    if (typeof value !== 'string' || !Number.isSafeInteger(declaredCount) ||
        declaredCount < 1 || declaredCount > 100) throw new TypeError('Corrected roster size is invalid.');
    const names = value.split(/\r?\n/u).map(line => Layout.cleanText(line));
    if (names.length !== declaredCount) {
        throw new Error(`Enter exactly ${declaredCount} player names, one per line; received ${names.length}.`);
    }
    if (names.some(name => !name || Array.from(name).length > 128)) {
        throw new Error('Every corrected player name must contain 1 to 128 characters.');
    }
    const keys = names.map(name => name.normalize('NFKC').toLocaleLowerCase('en'));
    if (new Set(keys).size !== names.length) throw new Error('Corrected player names must be unique.');
    return Object.freeze(names);
}

/** @param {unknown} value @param {number} declaredCount */
function parseCorrectedCinfo(value, declaredCount) {
    if (typeof value !== 'string') throw new TypeError('Corrected cinfo must be text.');
    const lines = value.split(/\r?\n/u);
    if (lines.length < 3) throw new Error('Enter ClanTag on line 1, Established on line 2, then one player per line.');
    const tag = Layout.cleanText(lines[0]);
    if (!tag || Array.from(tag).length > 32) throw new Error('ClanTag must contain 1 to 32 characters.');
    const establishedRaw = Layout.cleanText(lines[1]);
    const establishedAtUtc = parseEstablished(establishedRaw);
    if (!establishedAtUtc) throw new Error('Established must use MM/DD/YYYY HH:mm:ss in GMT.');
    const names = parseCorrectedRoster(lines.slice(2).join('\n'), declaredCount);
    return Object.freeze({ tag, establishedRaw, establishedAtUtc, names });
}

/** @param {any} parsed @param {readonly string[]} names */
function applyCorrectedRoster(parsed, names) {
    const sourceMembers = Array.isArray(parsed.members) ? parsed.members : [];
    const { resolvedMembers: _resolved, unresolvedMembers: _unresolved, missingMemberCount: _missing,
        importable: _importable, ...base } = parsed;
    return Object.freeze({
        ...base,
        members: Object.freeze(names.map((name, index) => Object.freeze({
            name,
            role: sourceMembers[index] && sourceMembers[index].role || 'unknown'
        }))),
        complete: true,
        manualRosterCorrected: true,
        errors: Object.freeze((parsed.errors || []).filter((/** @type {string} */ error) =>
            !/^Roster count mismatch:|^Partial roster:/u.test(error)))
    });
}

/** @param {any} parsed
 * @param {{tag:string,establishedRaw:string,establishedAtUtc:string,names:readonly string[]}} corrected */
function applyCorrectedCinfo(parsed, corrected) {
    const roster = applyCorrectedRoster(parsed, corrected.names);
    return Object.freeze({
        ...roster,
        tag: corrected.tag,
        establishedRaw: corrected.establishedRaw,
        establishedAtUtc: corrected.establishedAtUtc,
        manualMetadataCorrected: true,
        errors: Object.freeze((roster.errors || []).filter((/** @type {string} */ error) =>
            !/^(?:ClanTag anchor not found\.|ClanTag is empty or too long\.|Established anchor not found\.|Established timestamp is invalid\.)$/u
                .test(error)))
    });
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
        const confidences = /** @type {number[]} */ (parsed.entries.flatMap((/** @type {any} */ entry) =>
            typeof entry.idOcrConfidence === 'number' && Number.isFinite(entry.idOcrConfidence) ?
                [entry.idOcrConfidence] : []));
        const averageConfidence = confidences.length > 0 ?
            confidences.reduce((/** @type {number} */ sum, /** @type {number} */ value) => sum + value, 0) /
                confidences.length : 0;
        const correctedIds = parsed.entries.filter((/** @type {any} */ entry) =>
            entry.idOcrCorrected === true).length;
        return parsed.entries.length * 100 + (parsed.complete ? 40 : 0) -
            parsed.rejectedPartialIds.length * 4 - parsed.errors.length * 2 +
            averageConfidence * 0.2 - correctedIds * 10;
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
    const f7Variants = recognized.filter(value => value.result.kind === 'f7');
    if (f7Variants.length > 0 && f7Variants.length === recognized.length) {
        /** @type {Map<string,number>} */
        const passCounts = new Map();
        for (const variant of f7Variants) {
            const ids = new Set(variant.result.blocks[0].parsed.entries
                .filter((/** @type {any} */ entry) => entry.idOcrCorrected !== true)
                .map((/** @type {any} */ entry) => entry.steamId));
            for (const steamId of ids) passCounts.set(steamId, (passCounts.get(steamId) || 0) + 1);
        }
        f7Variants.sort((left, right) => {
            const agreement = (/** @type {any} */ variant) =>
                variant.result.blocks[0].parsed.entries.reduce((/** @type {number} */ sum,
                    /** @type {any} */ entry) =>
                    sum + Math.max(0, (passCounts.get(entry.steamId) || 0) - 1), 0);
            return agreement(right) - agreement(left) || right.quality - left.quality ||
                Number(right.label === 'f7-muted-text') - Number(left.label === 'f7-muted-text');
        });
        const selected = f7Variants[0].result;
        const block = selected.blocks[0];
        const namesBySteamId = new Map();
        for (const variant of f7Variants) {
            for (const entry of variant.result.blocks[0].parsed.entries) {
                if (!entry.name || entry.ambiguous) continue;
                const names = namesBySteamId.get(entry.steamId) || new Map();
                names.set(entry.name.normalize('NFKC').toLocaleLowerCase('en'), entry.name);
                namesBySteamId.set(entry.steamId, names);
            }
        }
        const entries = block.parsed.entries.map((/** @type {any} */ entry) => {
            const names = [...(namesBySteamId.get(entry.steamId) || new Map()).values()];
            const recoveredName = !entry.name && names.length === 1 ? names[0] : entry.name;
            return Object.freeze({
                ...entry,
                name: recoveredName,
                ambiguous: recoveredName ? false : entry.ambiguous,
                alternatives: recoveredName ? Object.freeze([]) : entry.alternatives,
                idOcrPasses: passCounts.get(entry.steamId) || 0
            });
        });
        /** @type {any[]} */
        const refinementRows = [];
        const refinementKeys = new Set();
        const selectedIdBoxes = block.parsed.entries.map((/** @type {any} */ entry) => entry.idBox).filter(Boolean);
        const sameRow = (/** @type {any} */ left, /** @type {any} */ right) => {
            const leftCenterX = left.x + left.width / 2;
            const leftCenterY = left.y + left.height / 2;
            const rightCenterX = right.x + right.width / 2;
            const rightCenterY = right.y + right.height / 2;
            const height = Math.max(left.height, right.height);
            return Math.abs(leftCenterY - rightCenterY) <= height * 1.5 &&
                Math.abs(leftCenterX - rightCenterX) <= Math.max(left.width, right.width) * 0.55;
        };
        for (const variant of f7Variants) {
            for (const entry of variant.result.blocks[0].parsed.entries) {
                const box = entry && entry.idBox;
                if (!box) continue;
                if (selectedIdBoxes.some((/** @type {any} */ selectedBox) => sameRow(box, selectedBox)) ||
                    refinementRows.some((/** @type {any} */ selectedRow) => sameRow(box, selectedRow.idBox))) continue;
                refinementRows.push(Object.freeze({
                    partialIndex: null,
                    partialText: entry.steamId,
                    idBox: box,
                    idOcrConfidence: entry.idOcrConfidence,
                    name: entry.name,
                    ambiguous: entry.ambiguous === true,
                    alternatives: entry.alternatives || Object.freeze([]),
                    nameGeometryScore: entry.nameGeometryScore,
                    nameBox: entry.nameBox || null
                }));
            }
            for (const row of variant.result.blocks[0].parsed.refinementRows || []) {
                const box = row && row.idBox;
                if (!box) continue;
                if (selectedIdBoxes.some((/** @type {any} */ selectedBox) => sameRow(box, selectedBox)) ||
                    refinementRows.some((/** @type {any} */ selectedRow) => sameRow(box, selectedRow.idBox))) continue;
                const key = `${Math.round(box.x)}\0${Math.round(box.y)}\0${Math.round(box.width)}\0${
                    Math.round(box.height)}`;
                if (refinementKeys.has(key)) continue;
                refinementKeys.add(key);
                refinementRows.push(row);
            }
        }
        return Object.freeze({ ...selected, blocks: Object.freeze([Object.freeze({
            ...block,
            parsed: Object.freeze({ ...block.parsed, entries: Object.freeze(entries),
                refinementRows: Object.freeze(refinementRows) })
        })]) });
    }
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
 * @param {readonly string[]} [confirmedUserWords]
 */
async function parseAttachment(client, kindHint, attachment, reference, attachmentIndex, userWords = [],
    confirmedUserWords = []) {
    const dependencies = importDependencies(client);
    const image = await (dependencies.downloadImage || ImageAttachment.downloadImage)(attachment, dependencies);
    const recognize = dependencies.recognize || TesseractOcr.recognize;
    const ocrOptions = {
        executable: dependencies.tesseractPath,
        language: dependencies.language || 'eng',
        psm: kindHint === 'cinfo' ? 6 : 11,
        timeoutMs: dependencies.ocrTimeoutMs,
        userWords,
        confirmedUserWords
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
    const f7Detected = recognized.some(value => value.result.kind === 'f7');
    if (f7Detected && dependencies.disableF7MutedTextPass !== true) {
        try {
            const preprocessF7 = dependencies.preprocessF7Image || OcrImagePreprocess.createF7TextMask;
            const processed = await preprocessF7(image.imageBase64, dependencies);
            const words = normalizeWordScale(await recognize(processed.imageBase64,
                { ...ocrOptions, psm: 11, userWords: [], confirmedUserWords: [],
                    characterWhitelist: '0123456789' }), processed.scale);
            const result = parseRecognizedWords(words, 'f7', dependencies);
            recognized.push({ label: 'f7-muted-text', result, quality: recognitionQuality(result) });
        }
        catch (error) {
            failures.push(error);
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Optional F7 muted SteamID pass failed: ${
                    sanitizeError(error)}`, 'warn');
            }
        }
    }
    if (recognized.length === 0) {
        const reason = failures.at(-1);
        throw reason instanceof Error ? reason : new Error('No OCR variant produced a valid semantic result.');
    }
    const selected = selectRecognizedResult(recognized);
    const { kind } = selected;
    let blocks = selected.blocks;
    if (kind === 'cinfo') {
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
    else {
        try {
            const refine = dependencies.refineF7Rows || F7RowRefinement.refineF7Rows;
            const refined = await refine(image.imageBase64, blocks[0], recognize, ocrOptions, dependencies);
            if (!refined || !refined.parsed || refined.parsed.kind !== 'f7') {
                throw new TypeError('F7 row refiner returned an invalid result.');
            }
            blocks = Object.freeze([refined]);
        }
        catch (error) {
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Optional F7 row refinement failed: ${
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
                parsed: block.parsed.members.length > 0 ?
                    applyRoleHints(block.parsed, roleHints[index]) : block.parsed }));
        }
        catch (error) {
            blocks = blocks.map((/** @type {any} */ block) => ({ ...block,
                parsed: block.parsed.members.length > 0 ? applyRoleHints(block.parsed,
                    block.parsed.members.map((/** @type {any} */ member) =>
                        ({ name: member.name, role: 'unknown' }))) : block.parsed }));
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
 * @param {string|null} requesterUserId @param {string} reference @param {string|null} captureTime
 */
async function prepareImports(client, source, requests, requesterUserId, reference, captureTime = null) {
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
    const scopeBeforeResolution = Runtime.getScope(context);
    const visualFile = scopeBeforeResolution ? Path.join(Runtime.getDataDirectory(context, scopeBeforeResolution),
        'visual-alias-library.json') : null;
    const correctionFile = scopeBeforeResolution ? Path.join(Runtime.getDataDirectory(context, scopeBeforeResolution),
        'ocr-correction-memory.json') : null;
    /** @type {readonly string[]} */
    let learnedUserWords = Object.freeze([]);
    if (visualFile) {
        try {
            const loadConfirmedWords = dependencies.confirmedOcrUserWords || VisualAliasLibrary.confirmedUserWords;
            learnedUserWords = await loadConfirmedWords(visualFile);
            if (!Array.isArray(learnedUserWords)) {
                throw new TypeError('Confirmed OCR user-word provider returned an invalid result.');
            }
        }
        catch (error) {
            learnedUserWords = Object.freeze([]);
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Confirmed OCR user words unavailable: ${
                    sanitizeError(error)}`, 'warn');
            }
        }
    }
    /** @type {readonly string[]} */
    let correctionUserWords = Object.freeze([]);
    if (correctionFile) {
        try {
            const loadCorrectionWords = dependencies.confirmedOcrCorrectionWords ||
                OcrCorrectionMemory.confirmedWords;
            correctionUserWords = await loadCorrectionWords(correctionFile);
            if (!Array.isArray(correctionUserWords)) {
                throw new TypeError('OCR correction-word provider returned an invalid result.');
            }
        }
        catch (error) {
            correctionUserWords = Object.freeze([]);
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `OCR correction words unavailable: ${
                    sanitizeError(error)}`, 'warn');
            }
        }
    }
    const userWords = Object.freeze([...new Set([
        ...correctionUserWords,
        ...learnedUserWords,
        ...persistedCandidates.map((/** @type {any} */ candidate) => candidate.name)
    ].filter((/** @type {any} */ name) => typeof name === 'string'))]);
    /** @type {any[]} */
    let rawItems = [];
    for (let index = 0; index < requests.length; index += 1) {
        rawItems.push(...await parseAttachment(client, requests[index].kindHint, requests[index].attachment,
            reference, index, userWords, learnedUserWords));
    }
    if (correctionFile) {
        try {
            const correctItems = dependencies.applyOcrCorrections || OcrCorrectionMemory.apply;
            const corrected = await correctItems(correctionFile, rawItems, learnedUserWords);
            if (!Array.isArray(corrected) || corrected.length !== rawItems.length) {
                throw new TypeError('OCR correction provider returned an invalid result.');
            }
            rawItems = [...corrected];
        }
        catch (error) {
            if (typeof client.log === 'function') {
                client.log('PLAYER_INTELLIGENCE', `Optional OCR correction memory unavailable: ${
                    sanitizeError(error)}`, 'warn');
            }
        }
    }
    if (rawItems.some(item => item.parsed.kind === 'f7') && dependencies.disableF7ProfileVerification !== true) {
        const verifyF7 = dependencies.verifyF7Identities || F7IdentityValidation.verify;
        const steamProfileName = dependencies.steamProfileName ||
            ((/** @type {string} */ steamId) => Scrape.scrapeSteamProfileName(client, steamId));
        const verified = await verifyF7(rawItems, persistedCandidates, steamProfileName);
        if (!Array.isArray(verified) || verified.length !== rawItems.length) {
            throw new TypeError('F7 identity verifier returned an invalid result.');
        }
        rawItems = [...verified];
    }
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
    if (items.some(item => item.parsed.kind === 'f7' ? !item.parsed.complete : !item.parsed.importable)) {
        const preview = previewItems(items);
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
    if (captureTime !== null && items.some(item => item.parsed.kind !== 'cinfo')) {
        throw new Error('Historical capture time is supported only for cinfo imports.');
    }
    const timing = await resolveImportTiming(context, items, scope, captureTime);
    const preview = timedPreview(items, timing.timingText);
    if (Array.from(preview).length > 1900) {
        return Object.freeze({
            content: `Detected ${items.length} import blocks, but the confirmation preview is too long. ` +
                'Split the upload into smaller batches. Nothing was committed.',
            components: [], allowedMentions: { parse: [] }
        });
    }
    const token = Crypto.randomBytes(12).toString('hex');
    const createdAt = Date.now();
    pending.set(token, Object.freeze({
        guildId: `${source.guildId}`,
        channelId: `${source.channelId}`,
        userId: requesterUserId,
        serverKey: scope.serverKey,
        ...timing,
        captureTime,
        visualFile,
        correctionFile,
        items: Object.freeze(items),
        createdAt,
        expiresAt: createdAt + TTL_MS
    }));
    return Object.freeze({
        content: preview, components: actionRows(token, items), allowedMentions: { parse: [] }
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
    const captureTime = null;
    try {
        const payload = await prepareImports(client, interaction, [{ kindHint: kind, attachment }],
            `${interaction.user.id}`, `discord-interaction:${interaction.id}`, captureTime);
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
    const content = `${message.content || ''}`.trim();
    const kindMatch = content.match(/^(cinfo|f7)(?:\s|$)/i);
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
    const hintLength = kindMatch ? kindMatch[0].length : 0;
    const captureTime = kindHint === 'cinfo' ? content.slice(hintLength).trim() || null : null;
    if (kindHint === 'f7' && content.slice(hintLength).trim()) {
        await message.reply({ content: 'Historical capture time is supported only for cinfo imports. Nothing was committed.',
            components: [], allowedMentions: { parse: [] } });
        return true;
    }
    try {
        const payload = await prepareImports(client, message,
            attachments.map(attachment => ({ kindHint, attachment })),
            webhookId ? null : `${message.author.id}`, `discord-message:${message.id}`, captureTime);
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

/** @param {any} scope @param {any} item */
function pendingScopeMatches(scope, item) {
    return Boolean(scope && scope.serverKey === item.serverKey &&
        (item.requiresActiveWipe !== true || scope.wipeId === item.activeWipeId));
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

/** @param {any} context @param {any} pendingItem @param {number} itemIndex
 * @param {{tag:string,establishedRaw:string,establishedAtUtc:string,names:readonly string[]}} corrected
 * @param {any} client */
async function resolveCorrectedItem(context, pendingItem, itemIndex, corrected, client) {
    const dependencies = importDependencies(client);
    const loadCandidates = dependencies.identityCandidates || Runtime.identityCandidates;
    const persisted = await loadCandidates(context);
    if (!Array.isArray(persisted)) throw new TypeError('Identity candidate provider returned an invalid result.');
    const batch = pendingItem.items.flatMap((/** @type {any} */ entry) => {
        if (entry.parsed.kind === 'f7') return entry.parsed.entries.filter((/** @type {any} */ value) => value.name)
            .map((/** @type {any} */ value) => ({ ...value, battlemetricsPlayerId: null, caseFidelity: false }));
        return (entry.parsed.resolvedMembers || []).map((/** @type {any} */ value) => ({
            name: value.name,
            steamId: value.steamId,
            battlemetricsPlayerId: value.battlemetricsPlayerId,
            caseFidelity: value.caseFidelity !== false
        }));
    });
    const original = pendingItem.items[itemIndex];
    const raw = applyCorrectedCinfo(original.parsed, corrected);
    let parsed = resolveCinfo(raw, Object.freeze([...persisted, ...batch]), dependencies.nameSimilarityOptions);
    const corroborate = dependencies.corroborateCandidates || corroborateCandidateAliases;
    /** @type {readonly any[]} */
    let corroborated = Object.freeze([]);
    try {
        corroborated = await corroborate(context, [{ parsed }], client, dependencies);
        if (!Array.isArray(corroborated)) {
            throw new TypeError('Candidate corroboration returned an invalid result.');
        }
    }
    catch (error) {
        corroborated = Object.freeze([]);
        if (typeof client.log === 'function') {
            client.log('PLAYER_INTELLIGENCE', `Optional corrected-roster corroboration unavailable: ${
                sanitizeError(error)}`, 'warn');
        }
    }
    if (corroborated.length > 0) {
        parsed = resolveCinfo(raw, Object.freeze([...persisted, ...batch, ...corroborated]),
            dependencies.nameSimilarityOptions);
    }
    return Object.freeze({
        ...original,
        parsed,
        confirmedCorrectionNames: Object.freeze([...corrected.names])
    });
}

/** @param {{client:any,interaction:any}} value */
async function handleButton({ client, interaction }) {
    const confirm = interaction.customId.startsWith(CONFIRM_PREFIX);
    const reject = interaction.customId.startsWith(REJECT_PREFIX);
    const replace = interaction.customId.startsWith(REPLACE_PREFIX);
    const keep = interaction.customId.startsWith(KEEP_PREFIX);
    const editMatch = new RegExp(`^${EDIT_PREFIX}([a-f0-9]{24}):(\\d{1,2})$`, 'u')
        .exec(interaction.customId);
    if (!confirm && !reject && !replace && !keep && !editMatch) return false;
    const token = editMatch ? editMatch[1] :
        interaction.customId.slice((confirm ? CONFIRM_PREFIX : reject ? REJECT_PREFIX :
            replace ? REPLACE_PREFIX : KEEP_PREFIX).length);
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
    if (editMatch) {
        if (!await client.validatePermissions(interaction)) return true;
        const index = Number(editMatch[2]);
        const target = item.items[index];
        if (!Number.isSafeInteger(index) || !target || target.parsed.kind !== 'cinfo') {
            await client.interactionReply(interaction, {
                content: 'This cinfo block is no longer editable. Nothing was changed.', ephemeral: true
            });
            return true;
        }
        await interaction.showModal(rosterEditModal(token, index, target));
        return true;
    }
    if (reject) {
        pending.delete(token);
        await respondButton(client, interaction, 'Import rejected. Nothing was changed.');
        return true;
    }
    if ((replace || keep) && !Array.isArray(item.duplicatePrompt)) {
        pending.delete(token);
        await respondButton(client, interaction, 'Replacement preview is no longer available. Nothing was changed.');
        return true;
    }
    if (!await client.validatePermissions(interaction)) return true;
    const context = contextFor(client, interaction);
    const scope = Runtime.getScope(context);
    if (!pendingScopeMatches(scope, item)) {
        pending.delete(token);
        await respondButton(client, interaction, 'Active server or wipe changed. Nothing was committed.');
        return true;
    }
    let result;
    try {
        const imports = item.items.map((/** @type {any} */ entry, /** @type {number} */ index) => ({
            parsed: entry.parsed,
            metadata: {
                sha256: entry.sha256,
                reference: entry.reference,
                ...(item.itemTimings[index].observedAt ? {
                    observedAt: item.itemTimings[index].observedAt,
                    wipeId: item.itemTimings[index].wipeId,
                    wipeStart: item.itemTimings[index].wipeStart
                } : {})
            }
        }));
        result = await Runtime.commitParsedImports(context, imports, {
            onDuplicate: replace ? 'replace' : keep ? 'skip' : 'prompt',
            expectedDuplicates: replace ? item.duplicatePrompt.map((/** @type {any} */ group) => ({
                hash: group.hash,
                eventIds: group.events.map((/** @type {any} */ event) => event.eventId)
            })) : undefined
        });
    }
    catch (error) {
        pending.delete(token);
        await respondButton(client, interaction,
            `Import failed safely: ${sanitizeError(error)} Nothing was committed.`);
        return true;
    }
    if (confirm && result.duplicate) {
        const updated = Object.freeze({ ...item, duplicatePrompt: result.existing });
        pending.set(token, updated);
        await client.interactionUpdate(interaction, {
            content: replacementPreview(item.items, result.existing),
            embeds: [], components: actionRows(token, item.items, 'replace'), allowedMentions: { parse: [] }
        });
        return true;
    }
    pending.delete(token);
    const message = replace ?
        `Import replaced (${result.replaced} previous block${result.replaced === 1 ? '' : 's'}, ${
            result.appended} event${result.appended === 1 ? '' : 's'} appended). The previous version is no longer active.` :
        keep ? result.imported === 0 ? 'Existing import kept. Nothing was changed.' :
            `Existing duplicate(s) kept; ${result.imported} new block(s) committed (${result.appended} events).` :
            `Import committed (${result.imported} block${result.imported === 1 ? '' : 's'}, ${
                result.appended} event${result.appended === 1 ? '' : 's'}).`;
    await respondButton(client, interaction, message);
    if (!result.duplicate) {
        const committedHashes = new Set(result.committedHashes || []);
        const committedItems = item.items.filter((/** @type {any} */ entry) =>
            committedHashes.has(`${entry.sha256}`.toLowerCase()));
        if (item.visualFile) {
            try {
                const dependencies = importDependencies(client);
                const recordVisual = dependencies.recordVisualAliases || VisualAliasLibrary.recordResolved;
                await recordVisual(item.visualFile, committedItems, new Date().toISOString());
            }
            catch (error) {
                if (typeof client.log === 'function') {
                    client.log('PLAYER_INTELLIGENCE', `Visual alias library update failed after commit: ${
                        sanitizeError(error)}`, 'warn');
                }
            }
        }
        const correctedNames = committedItems.flatMap((/** @type {any} */ entry) =>
            entry.confirmedCorrectionNames || []);
        if (item.visualFile && correctedNames.length > 0) {
            try {
                const dependencies = importDependencies(client);
                const recordCorrections = dependencies.recordConfirmedOcrUserWords ||
                    VisualAliasLibrary.recordConfirmedUserWords;
                await recordCorrections(item.visualFile, correctedNames, new Date().toISOString());
            }
            catch (error) {
                if (typeof client.log === 'function') {
                    client.log('PLAYER_INTELLIGENCE', `Confirmed OCR lexicon update failed after commit: ${
                        sanitizeError(error)}`, 'warn');
                }
            }
        }
        if (item.correctionFile && correctedNames.length > 0) {
            try {
                const dependencies = importDependencies(client);
                const recordCorrections = dependencies.recordOcrCorrections ||
                    OcrCorrectionMemory.recordConfirmed;
                await recordCorrections(item.correctionFile, committedItems, new Date().toISOString());
            }
            catch (error) {
                if (typeof client.log === 'function') {
                    client.log('PLAYER_INTELLIGENCE', `OCR correction memory update failed after commit: ${
                        sanitizeError(error)}`, 'warn');
                }
            }
        }
        void recrossWarBandits(context,
            committedItems.map((/** @type {any} */ entry) => entry.parsed), client);
    }
    return true;
}

/** @param {{client:any,interaction:any}} value */
async function handleModal({ client, interaction }) {
    const match = new RegExp(`^${EDIT_MODAL_PREFIX}([a-f0-9]{24}):(\\d{1,2})$`, 'u')
        .exec(interaction.customId);
    if (!match) return false;
    const token = match[1];
    const index = Number(match[2]);
    const item = pending.get(token);
    if (!item || item.expiresAt < Date.now()) {
        if (item) pending.delete(token);
        await client.interactionReply(interaction, {
            content: 'Import expired or already handled. Nothing was changed.', ephemeral: true
        });
        return true;
    }
    if ((item.userId !== null && `${interaction.user.id}` !== item.userId) ||
        `${interaction.guildId}` !== item.guildId || `${interaction.channelId}` !== item.channelId) {
        await client.interactionReply(interaction, {
            content: 'Only the requester can edit this import in its original channel.', ephemeral: true
        });
        return true;
    }
    if (!await client.validatePermissions(interaction)) return true;
    const target = item.items[index];
    if (!Number.isSafeInteger(index) || !target || target.parsed.kind !== 'cinfo') {
        await client.interactionReply(interaction, {
            content: 'This cinfo block is no longer editable. Nothing was changed.', ephemeral: true
        });
        return true;
    }
    const context = contextFor(client, interaction);
    const scope = Runtime.getScope(context);
    if (!pendingScopeMatches(scope, item)) {
        pending.delete(token);
        await client.interactionReply(interaction, {
            content: 'Active server or wipe changed. Nothing was committed.', ephemeral: true
        });
        return true;
    }
    let correctedForm;
    try {
        correctedForm = parseCorrectedCinfo(
            interaction.fields.getTextInputValue(EDIT_ROSTER_FIELD), target.parsed.declaredCount);
    }
    catch (error) {
        await client.interactionReply(interaction, {
            content: `Cinfo correction rejected safely: ${sanitizeError(error)} Preview unchanged.`,
            ephemeral: true
        });
        return true;
    }
    await interaction.deferUpdate();
    try {
        const corrected = await resolveCorrectedItem(context, item, index, correctedForm, client);
        const items = Object.freeze(item.items.map((/** @type {any} */ entry, /** @type {number} */ itemIndex) =>
            itemIndex === index ? corrected : entry));
        const timing = await resolveImportTiming(context, items, scope, item.captureTime ?? null);
        const preview = item.duplicatePrompt ? replacementPreview(items, item.duplicatePrompt) :
            timedPreview(items, timing.timingText || null);
        if (Array.from(preview).length > 1900) {
            throw new Error('Corrected preview exceeds the Discord limit; split the upload into smaller batches.');
        }
        pending.set(token, Object.freeze({ ...item, ...timing, items }));
        await client.interactionEditReply(interaction, {
            content: preview, components: actionRows(token, items, item.duplicatePrompt ? 'replace' : 'confirm'),
            embeds: [], allowedMentions: { parse: [] }
        });
    }
    catch (error) {
        const preview = item.duplicatePrompt ? replacementPreview(item.items, item.duplicatePrompt) :
            timedPreview(item.items, item.timingText || null);
        await client.interactionEditReply(interaction, {
            content: `${preview}\nCinfo correction rejected safely: ${sanitizeError(error)} Preview unchanged.`
                .slice(0, 1900),
            components: actionRows(token, item.items, item.duplicatePrompt ? 'replace' : 'confirm'),
            embeds: [], allowedMentions: { parse: [] }
        });
    }
    return true;
}

module.exports = Object.freeze({
    CONFIRM_PREFIX,
    EDIT_MODAL_PREFIX,
    EDIT_PREFIX,
    KEEP_PREFIX,
    REPLACE_PREFIX,
    REJECT_PREFIX,
    TTL_MS,
    applyCorrectedCinfo,
    applyCorrectedRoster,
    beginImport,
    handleMessage,
    handleButton,
    handleModal,
    normalizeWebhookIds,
    parseCorrectedCinfo,
    parseCorrectedRoster,
    previewItems,
    replacementPreview,
    previewText,
    selectRecognizedResult
});
