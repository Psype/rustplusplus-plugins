// @ts-check
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');

const Jimp = require('jimp');

const CinfoRoles = require('./cinfoRoles.js');
const Layout = require('./ocrLayout.js');
const { isRustUiTextPixel } = require('./ocrImagePreprocess.js');

const SCHEMA_VERSION = 1;
const FEATURE_WIDTH = 96;
const FEATURE_HEIGHT = 24;
const FEATURE_BYTES = FEATURE_WIDTH * FEATURE_HEIGHT / 8;
const MAX_SAMPLES = 2000;
const MAX_SAMPLES_PER_ALIAS = 4;
const APPROXIMATE_THRESHOLD = 0.72;
const sharedQueues = new Map();
const decodedFeatures = new WeakMap();
const bitCounts = Object.freeze(Array.from({ length: 256 }, (_, value) => {
    let count = 0;
    for (let work = value; work > 0; work >>>= 1) count += work & 1;
    return count;
}));

class VisualAliasLibraryCorruptionError extends Error {
    /** @param {string} file @param {unknown} cause */
    constructor(file, cause) {
        super(`Visual alias library is corrupt at ${file}; it was preserved.`);
        this.name = 'VisualAliasLibraryCorruptionError';
        this.file = file;
        this.cause = cause;
    }
}

/** @param {unknown} value */
function cleanName(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {unknown} value @param {string} label */
function stableSteamId(value, label) {
    const result = value === null || value === undefined || value === '' ? null : `${value}`;
    if (result !== null && !/^7656119\d{10}$/u.test(result)) throw new TypeError(`${label} is invalid.`);
    return result;
}

/** @param {unknown} value @param {string} label */
function stableBattlemetricsId(value, label) {
    const result = value === null || value === undefined || value === '' ? null : `${value}`;
    if (result !== null && !/^\d{1,32}$/u.test(result)) throw new TypeError(`${label} is invalid.`);
    return result;
}

/** @param {unknown} input */
function validateFeature(input) {
    if (!input || typeof input !== 'object') throw new TypeError('Visual alias feature is invalid.');
    const value = /** @type {any} */ (input);
    if (value.width !== FEATURE_WIDTH || value.height !== FEATURE_HEIGHT ||
        typeof value.bits !== 'string' || typeof value.digest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.digest) || typeof value.aspectRatio !== 'number' ||
        !Number.isFinite(value.aspectRatio) || value.aspectRatio <= 0 || value.aspectRatio > 64) {
        throw new TypeError('Visual alias feature is invalid.');
    }
    const bits = Buffer.from(value.bits, 'base64');
    if (bits.length !== FEATURE_BYTES || bits.toString('base64') !== value.bits) {
        throw new TypeError('Visual alias feature bits are invalid.');
    }
    const digest = Crypto.createHash('sha256').update(bits)
        .update(`:${value.aspectRatio.toFixed(3)}`, 'utf8').digest('hex');
    if (digest !== value.digest) throw new TypeError('Visual alias feature digest is invalid.');
    return Object.freeze({
        width: FEATURE_WIDTH,
        height: FEATURE_HEIGHT,
        bits: value.bits,
        digest: value.digest,
        aspectRatio: Number(value.aspectRatio.toFixed(3))
    });
}

/** @param {unknown} input */
function validateSample(input) {
    if (!input || typeof input !== 'object') throw new TypeError('Visual alias sample is invalid.');
    const value = /** @type {any} */ (input);
    const name = cleanName(value.name);
    const steamId = stableSteamId(value.steamId, 'Visual alias SteamID64');
    const battlemetricsPlayerId = stableBattlemetricsId(value.battlemetricsPlayerId,
        'Visual alias BattleMetrics ID');
    if (!name || Array.from(name).length > 128 || (!steamId && !battlemetricsPlayerId) ||
        typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt))) {
        throw new TypeError('Visual alias sample identity is invalid.');
    }
    const feature = validateFeature(value.feature);
    const sampleId = Crypto.createHash('sha256').update(`${steamId || ''}\0${battlemetricsPlayerId || ''}\0${
        name}\0${feature.digest}`, 'utf8').digest('hex');
    if (value.sampleId !== sampleId) throw new TypeError('Visual alias sample ID is invalid.');
    return Object.freeze({
        sampleId,
        name,
        steamId,
        battlemetricsPlayerId,
        caseFidelity: value.caseFidelity !== false,
        observedAt: new Date(value.observedAt).toISOString(),
        feature
    });
}

/** @param {unknown} input */
function validateDocument(input) {
    if (!input || typeof input !== 'object' || /** @type {any} */ (input).schemaVersion !== SCHEMA_VERSION ||
        !Array.isArray(/** @type {any} */ (input).samples) ||
        /** @type {any} */ (input).samples.length > MAX_SAMPLES) {
        throw new TypeError('Visual alias library schema is invalid.');
    }
    const samples = /** @type {any} */ (input).samples.map(validateSample);
    if (new Set(samples.map((/** @type {any} */ sample) => sample.sampleId)).size !== samples.length) {
        throw new TypeError('Visual alias library contains duplicate samples.');
    }
    const counts = new Map();
    for (const sample of samples) {
        const identity = `${sample.steamId || ''}\0${sample.battlemetricsPlayerId || ''}\0${sample.name}`;
        const count = (counts.get(identity) || 0) + 1;
        if (count > MAX_SAMPLES_PER_ALIAS) {
            throw new TypeError('Visual alias library exceeds the per-alias sample limit.');
        }
        counts.set(identity, count);
    }
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, samples: Object.freeze(samples) });
}

/** @param {string} file */
async function read(file) {
    try {
        const text = await Fs.promises.readFile(file, 'utf8');
        return validateDocument(JSON.parse(text));
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
            return Object.freeze({ schemaVersion: SCHEMA_VERSION, samples: Object.freeze([]) });
        }
        if (error instanceof VisualAliasLibraryCorruptionError) throw error;
        throw new VisualAliasLibraryCorruptionError(file, error);
    }
}

/** @param {string} file @param {any} document */
async function write(file, document) {
    const checked = validateDocument(document);
    await Fs.promises.mkdir(Path.dirname(file), { recursive: true });
    const temporary = Path.join(Path.dirname(file), `.${Path.basename(file)}.${process.pid}.${
        Crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
        const handle = await Fs.promises.open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(checked)}\n`, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await Fs.promises.rename(temporary, file);
    }
    finally {
        await Fs.promises.rm(temporary, { force: true });
    }
}

/** @param {string} file @param {()=>Promise<any>} operation */
function serialized(file, operation) {
    const key = Path.resolve(file);
    const previous = sharedQueues.get(key) || Promise.resolve();
    const current = previous.then(operation);
    sharedQueues.set(key, current.then(() => undefined, () => undefined));
    return current;
}

/** @param {Buffer} bits @param {number} index */
function setBit(bits, index) {
    bits[index >>> 3] |= 1 << (index & 7);
}

/**
 * Creates a scale-independent word-shape signature from OCR-relative boxes.
 * @param {any} image @param {readonly {x:number,y:number,width:number,height:number}[]} boxes
 * @param {any} [JimpImpl]
 */
function featureFromBoxes(image, boxes, JimpImpl = Jimp) {
    if (!Array.isArray(boxes) || boxes.length === 0) return null;
    const left = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.x))));
    const top = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.y))));
    const right = Math.min(image.bitmap.width,
        Math.ceil(Math.max(...boxes.map(box => box.x + box.width))));
    const bottom = Math.min(image.bitmap.height,
        Math.ceil(Math.max(...boxes.map(box => box.y + box.height))));
    if (right <= left || bottom <= top) return null;
    /** @type {[number,number][]} */
    const foreground = [];
    let minimumX = right;
    let minimumY = bottom;
    let maximumX = left;
    let maximumY = top;
    for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
            const { r, g, b, a } = JimpImpl.intToRGBA(image.getPixelColor(x, y));
            if (!isRustUiTextPixel(r, g, b, a)) continue;
            foreground.push([x, y]);
            minimumX = Math.min(minimumX, x);
            minimumY = Math.min(minimumY, y);
            maximumX = Math.max(maximumX, x);
            maximumY = Math.max(maximumY, y);
        }
    }
    if (foreground.length < 8) return null;
    const sourceWidth = maximumX - minimumX + 1;
    const sourceHeight = maximumY - minimumY + 1;
    const scale = Math.min((FEATURE_WIDTH - 2) / sourceWidth, (FEATURE_HEIGHT - 2) / sourceHeight);
    const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
    const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
    const offsetX = Math.floor((FEATURE_WIDTH - drawWidth) / 2);
    const offsetY = Math.floor((FEATURE_HEIGHT - drawHeight) / 2);
    const bits = Buffer.alloc(FEATURE_BYTES);
    for (const [x, y] of foreground) {
        const targetX = Math.min(drawWidth - 1, Math.floor((x - minimumX) * drawWidth / sourceWidth)) + offsetX;
        const targetY = Math.min(drawHeight - 1, Math.floor((y - minimumY) * drawHeight / sourceHeight)) + offsetY;
        setBit(bits, targetY * FEATURE_WIDTH + targetX);
    }
    const aspectRatio = Number((sourceWidth / sourceHeight).toFixed(3));
    const digest = Crypto.createHash('sha256').update(bits)
        .update(`:${aspectRatio.toFixed(3)}`, 'utf8').digest('hex');
    return Object.freeze({
        width: FEATURE_WIDTH,
        height: FEATURE_HEIGHT,
        bits: bits.toString('base64'),
        digest,
        aspectRatio
    });
}

/** @param {any} value */
function decodedFeature(value) {
    if (value && typeof value === 'object' && decodedFeatures.has(value)) return decodedFeatures.get(value);
    const feature = validateFeature(value);
    const bits = Buffer.from(feature.bits, 'base64');
    let foreground = 0;
    for (const byte of bits) foreground += bitCounts[byte];
    const decoded = Object.freeze({ feature, bits, foreground });
    if (value && typeof value === 'object') decodedFeatures.set(value, decoded);
    decodedFeatures.set(feature, decoded);
    return decoded;
}

/** @param {any} left @param {any} right */
function featureSimilarity(left, right) {
    const firstData = decodedFeature(left);
    const secondData = decodedFeature(right);
    const first = firstData.feature;
    const second = secondData.feature;
    if (first.digest === second.digest) return 1;
    let overlap = 0;
    for (let index = 0; index < FEATURE_BYTES; index += 1) {
        overlap += bitCounts[firstData.bits[index] & secondData.bits[index]];
    }
    const total = firstData.foreground + secondData.foreground;
    const shape = total === 0 ? 0 : 2 * overlap / total;
    const aspect = Math.min(first.aspectRatio, second.aspectRatio) /
        Math.max(first.aspectRatio, second.aspectRatio);
    return Number((shape * 0.9 + aspect * 0.1).toFixed(6));
}

/** @param {string} imageBase64 @param {readonly {words:unknown,parsed:any}[]} blocks
 * @param {{JimpImpl?:any}} [options] */
async function extractVisualSamples(imageBase64, blocks, options = {}) {
    const JimpImpl = options.JimpImpl || Jimp;
    const image = await JimpImpl.read(Buffer.from(imageBase64, 'base64'));
    return Object.freeze(blocks.map(block => {
        if (!block.parsed || !['cinfo', 'f7'].includes(block.parsed.kind)) {
            return Object.freeze([]);
        }
        const cinfo = block.parsed.kind === 'cinfo';
        const entries = cinfo ? block.parsed.members : block.parsed.entries;
        if (!Array.isArray(entries)) return Object.freeze([]);
        const words = cinfo ? CinfoRoles.rosterWords(block.words) : Layout.normalizeWords(block.words);
        return Object.freeze(entries.map((/** @type {any} */ entry, /** @type {number} */ index) => {
            const name = cinfo ? entry.name : entry.ambiguous ? null : entry.name;
            if (!name) return null;
            const feature = featureFromBoxes(image, CinfoRoles.findMemberBoxes(words, name), JimpImpl);
            return feature ? Object.freeze({ memberIndex: index, observedText: name, feature }) : null;
        }).filter(Boolean));
    }));
}

/** @param {any} feature @param {readonly any[]} samples */
function matchFeature(feature, samples) {
    const matches = samples.map(sample => ({ sample, score: featureSimilarity(feature, sample.feature) }))
        .filter(match => match.score >= APPROXIMATE_THRESHOLD)
        .sort((left, right) => right.score - left.score ||
            right.sample.observedAt.localeCompare(left.sample.observedAt) ||
            left.sample.sampleId.localeCompare(right.sample.sampleId));
    return Object.freeze(matches.slice(0, 8).map(match => Object.freeze(match)));
}

/** @param {string} file @param {readonly any[]} items */
async function candidatesForItems(file, items) {
    const document = await serialized(file, () => read(file));
    return Object.freeze(items.map(item => {
        const candidates = [];
        for (const visual of item.visualSamples || []) {
            for (const match of matchFeature(visual.feature, document.samples)) {
                candidates.push(Object.freeze({
                    name: match.sample.name,
                    steamId: match.sample.steamId,
                    battlemetricsPlayerId: match.sample.battlemetricsPlayerId,
                    caseFidelity: match.sample.caseFidelity,
                    corroborated: match.score === 1,
                    contextPriority: true,
                    targetMemberIndex: visual.memberIndex,
                    visualScore: match.score
                }));
            }
        }
        return Object.freeze(candidates);
    }));
}

/** @param {string} file @param {readonly any[]} items @param {string} observedAt */
function recordResolved(file, items, observedAt) {
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
        throw new TypeError('Visual alias observation time is invalid.');
    }
    /** @type {any[]} */
    const additions = [];
    for (const item of items) {
        if (!item.parsed || !['cinfo', 'f7'].includes(item.parsed.kind)) continue;
        const resolved = new Map(item.parsed.kind === 'cinfo' ?
            (item.parsed.resolvedMembers || []).map((/** @type {any} */ member) => [member.memberIndex, member]) :
            (item.parsed.entries || []).map((/** @type {any} */ entry, /** @type {number} */ index) =>
                [index, entry.ambiguous || !entry.name ? null : entry]));
        for (const visual of item.visualSamples || []) {
            const member = resolved.get(visual.memberIndex);
            if (!member) continue;
            const feature = validateFeature(visual.feature);
            const base = {
                name: member.name,
                steamId: member.steamId || null,
                battlemetricsPlayerId: member.battlemetricsPlayerId || null,
                caseFidelity: item.parsed.kind === 'f7' ? false : member.caseFidelity !== false,
                observedAt: new Date(observedAt).toISOString(),
                feature
            };
            const sampleId = Crypto.createHash('sha256').update(`${base.steamId || ''}\0${
                base.battlemetricsPlayerId || ''}\0${base.name}\0${feature.digest}`, 'utf8').digest('hex');
            additions.push(validateSample({ ...base, sampleId }));
        }
    }
    if (additions.length === 0) return Promise.resolve(Object.freeze({ added: 0, total: 0 }));
    return serialized(file, async () => {
        const document = await read(file);
        const samples = [...document.samples];
        let added = 0;
        for (const sample of additions) {
            if (samples.some(existing => existing.sampleId === sample.sampleId)) continue;
            const identity = `${sample.steamId || ''}\0${sample.battlemetricsPlayerId || ''}\0${sample.name}`;
            const same = samples.filter(existing => `${existing.steamId || ''}\0${
                existing.battlemetricsPlayerId || ''}\0${existing.name}` === identity);
            if (same.length >= MAX_SAMPLES_PER_ALIAS) continue;
            samples.push(sample);
            added += 1;
        }
        samples.sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
            left.sampleId.localeCompare(right.sampleId));
        const bounded = samples.slice(Math.max(0, samples.length - MAX_SAMPLES));
        if (added > 0) await write(file, { schemaVersion: SCHEMA_VERSION, samples: bounded });
        return Object.freeze({ added, total: bounded.length });
    });
}

module.exports = Object.freeze({
    APPROXIMATE_THRESHOLD,
    FEATURE_HEIGHT,
    FEATURE_WIDTH,
    MAX_SAMPLES,
    MAX_SAMPLES_PER_ALIAS,
    VisualAliasLibraryCorruptionError,
    candidatesForItems,
    extractCinfoSamples: extractVisualSamples,
    extractVisualSamples,
    featureFromBoxes,
    featureSimilarity,
    matchFeature,
    read,
    recordResolved,
    validateDocument,
    validateFeature
});
