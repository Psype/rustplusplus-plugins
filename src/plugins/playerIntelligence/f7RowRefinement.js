// @ts-check
const Jimp = require('jimp');

const F7IdentityValidation = require('./f7IdentityValidation.js');
const Layout = require('./ocrLayout.js');
const OcrImagePreprocess = require('./ocrImagePreprocess.js');

const MAX_SHEET_PIXELS = 8 * 1024 * 1024;
const SCALE = 4;
const PADDING = 3;

/** @param {any} box @param {number} width @param {number} height */
function boundedBox(box, width, height) {
    if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
        box.width <= 0 || box.height <= 0) return null;
    const left = Math.max(0, Math.floor(box.x - box.height * 0.45));
    const top = Math.max(0, Math.floor(box.y - box.height * 0.3));
    const right = Math.min(width, Math.ceil(box.x + box.width + box.height * 1.4));
    const bottom = Math.min(height, Math.ceil(box.y + box.height * 1.35));
    return right > left && bottom > top ? Object.freeze({
        x: left, y: top, width: right - left, height: bottom - top
    }) : null;
}

/** @param {any} image @param {readonly any[]} rows @param {any} JimpImpl */
async function createIdSheet(image, rows, JimpImpl) {
    const imageWidth = Number(image.bitmap && image.bitmap.width);
    const imageHeight = Number(image.bitmap && image.bitmap.height);
    if (!Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight) ||
        imageWidth < 1 || imageHeight < 1) throw new TypeError('F7 source image dimensions are invalid.');
    const boxes = rows.map(row => boundedBox(row.idBox, imageWidth, imageHeight));
    if (boxes.some(box => box === null)) throw new TypeError('F7 row bounds are invalid.');
    const safeBoxes = /** @type {readonly {x:number,y:number,width:number,height:number}[]} */ (boxes);
    const rowHeight = Math.max(...safeBoxes.map(box => box.height)) + PADDING * 2;
    const width = Math.max(...safeBoxes.map(box => box.width)) + PADDING * 2;
    const height = rowHeight * safeBoxes.length;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width * SCALE * height * SCALE > MAX_SHEET_PIXELS) {
        throw new Error('F7 isolated SteamID sheet exceeds the pixel limit.');
    }
    const sheet = await new Promise((resolve, reject) => {
        new JimpImpl(width, height, 0xffffffff, (/** @type {any} */ error, /** @type {any} */ value) =>
            error ? reject(error) : resolve(value));
    });
    for (let rowIndex = 0; rowIndex < safeBoxes.length; rowIndex += 1) {
        const box = safeBoxes[rowIndex];
        const targetY = rowIndex * rowHeight + PADDING;
        for (let y = 0; y < box.height; y += 1) {
            for (let x = 0; x < box.width; x += 1) {
                const { r, g, b, a } = JimpImpl.intToRGBA(image.getPixelColor(box.x + x, box.y + y));
                if (OcrImagePreprocess.isRustF7TextPixel(r, g, b, a)) {
                    sheet.setPixelColor(0x000000ff, PADDING + x, targetY + y);
                }
            }
        }
    }
    sheet.resize(width * SCALE, height * SCALE, JimpImpl.RESIZE_NEAREST_NEIGHBOR);
    const buffer = await sheet.getBufferAsync(JimpImpl.MIME_PNG || Jimp.MIME_PNG);
    return Object.freeze({ imageBase64: buffer.toString('base64'), scale: SCALE, rowHeight });
}

/** @param {readonly any[]} words @param {{scale:number,rowHeight:number}} sheet @param {number} count
 * @returns {readonly ({steamId:string,confidence:number|null}|null)[]} */
function readSheetIds(words, sheet, count) {
    const candidates = /** @type {{steamId:string,confidence:number|null}[][]} */ (
        Array.from({ length: count }, () => []));
    for (const line of Layout.groupLines(words)) {
        const index = Math.floor((line.y + line.height / 2) / (sheet.rowHeight * sheet.scale));
        if (!Number.isSafeInteger(index) || index < 0 || index >= count) continue;
        const raw = line.words.map(word => word.text).join('').replace(/\D/gu, '');
        const normalized = F7IdentityValidation.normalizeSteamIdOcr(raw);
        if (!normalized || normalized.corrections !== 0) continue;
        const confidences = line.words.flatMap(word => typeof word.confidence === 'number' &&
            Number.isFinite(word.confidence) ? [word.confidence] : []);
        candidates[index].push(Object.freeze({
            steamId: normalized.steamId,
            confidence: confidences.length > 0 ? Math.min(...confidences) : null
        }));
    }
    return Object.freeze(candidates.map(values => values.sort((left, right) =>
        Number(right.confidence || -1) - Number(left.confidence || -1))[0] || null));
}

/** @param {any} entry */
function rowFromEntry(entry) {
    return Object.freeze({
        source: 'entry',
        idBox: entry.idBox,
        name: entry.name,
        nameBox: entry.nameBox || null,
        ambiguous: entry.ambiguous === true,
        alternatives: entry.alternatives || Object.freeze([])
    });
}

/**
 * Rereads every detected or geometrically inferred F7 SteamID line in one digit-only isolated sheet.
 * @param {string} imageBase64 @param {any} block @param {Function} recognize
 * @param {any} ocrOptions @param {any} dependencies
 */
async function refineF7Rows(imageBase64, block, recognize, ocrOptions, dependencies = {}) {
    if (typeof imageBase64 !== 'string' || !block || block.parsed.kind !== 'f7' ||
        typeof recognize !== 'function') throw new TypeError('F7 row refinement input is invalid.');
    const entryRows = block.parsed.entries.filter((/** @type {any} */ entry) => entry.idBox).map(rowFromEntry);
    const extraRows = Array.isArray(block.parsed.refinementRows) ? block.parsed.refinementRows.filter(
        (/** @type {any} */ row) => row && row.idBox) : [];
    const rows = Object.freeze([...entryRows, ...extraRows]);
    if (rows.length === 0) return block;
    const JimpImpl = dependencies.JimpImpl || Jimp;
    const image = await JimpImpl.read(Buffer.from(imageBase64, 'base64'));
    const sheet = await createIdSheet(image, rows, JimpImpl);
    const words = await recognize(sheet.imageBase64, {
        ...ocrOptions,
        psm: 6,
        timeoutMs: Math.min(30000, Number(ocrOptions.timeoutMs) || 30000),
        userWords: [],
        confirmedUserWords: [],
        characterWhitelist: '0123456789'
    });
    const reads = readSheetIds(words, sheet, rows.length);
    const entries = block.parsed.entries.map((/** @type {any} */ entry, /** @type {number} */ index) => {
        const read = reads[index];
        if (!read) return entry;
        const unchanged = read.steamId === entry.steamId;
        return Object.freeze({
            ...entry,
            steamId: read.steamId,
            idOcrCorrected: false,
            idOcrConfidence: read.confidence,
            idOcrPasses: unchanged ? Math.max(2, Number(entry.idOcrPasses) || 0) : 1,
            idRowRefined: true
        });
    });
    const existingSteamIds = entries.map((/** @type {any} */ entry) => entry.steamId);
    if (new Set(existingSteamIds).size !== existingSteamIds.length) return block;
    const seenSteamIds = new Set(existingSteamIds);
    const recoveredPartials = new Set();
    for (let index = entryRows.length; index < rows.length; index += 1) {
        const read = reads[index];
        const row = rows[index];
        if (!read || seenSteamIds.has(read.steamId)) continue;
        entries.push(Object.freeze({
            steamId: read.steamId,
            name: row.ambiguous ? null : row.name || null,
            caseFidelity: false,
            ambiguous: row.ambiguous === true,
            alternatives: Object.freeze(row.alternatives || []),
            idOcrCorrected: false,
            idOcrConfidence: read.confidence,
            idOcrPasses: 1,
            idRowRefined: true,
            idBox: row.idBox,
            nameBox: row.nameBox || null
        }));
        seenSteamIds.add(read.steamId);
        if (Number.isSafeInteger(row.partialIndex)) recoveredPartials.add(row.partialIndex);
    }
    const rejectedPartialIds = block.parsed.rejectedPartialIds.filter((/** @type {string} */ _value,
        /** @type {number} */ index) => !recoveredPartials.has(index));
    const errors = block.parsed.errors.filter((/** @type {string} */ error) =>
        error !== 'No complete SteamID64 found.' && !/partial SteamID candidate\(s\) rejected\./u.test(error));
    if (rejectedPartialIds.length > 0) errors.push(`${rejectedPartialIds.length} partial SteamID candidate(s) rejected.`);
    const refinedCount = reads.filter(Boolean).length;
    return Object.freeze({ ...block, parsed: Object.freeze({
        ...block.parsed,
        entries: Object.freeze(entries),
        rejectedPartialIds: Object.freeze(rejectedPartialIds),
        complete: entries.length > 0 && !entries.some((/** @type {any} */ entry) => entry.ambiguous),
        errors: Object.freeze(errors),
        idRowsRefined: refinedCount
    }) });
}

module.exports = Object.freeze({
    MAX_SHEET_PIXELS,
    SCALE,
    createIdSheet,
    readSheetIds,
    refineF7Rows
});
