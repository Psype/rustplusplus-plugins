// @ts-check
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');

const Jimp = require('jimp');

const CinfoRoles = require('./cinfoRoles.js');
const Layout = require('./ocrLayout.js');
const { isRustUiTextPixel } = require('./ocrImagePreprocess.js');

/** @typedef {Readonly<{text:string,x:number,y:number,width:number,height:number,confidence:number|null}>} OcrWord */

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const FEATURE_WIDTH = 96;
const FEATURE_HEIGHT = 24;
const FEATURE_BYTES = FEATURE_WIDTH * FEATURE_HEIGHT / 8;
const MAX_SAMPLES = 2000;
const MAX_SAMPLES_PER_ALIAS = 4;
const MAX_GLYPH_SAMPLES = 4096;
const MAX_GLYPH_SAMPLES_PER_GRAPHEME = 12;
const MAX_GLYPHS_PER_ALIAS = 64;
const APPROXIMATE_THRESHOLD = 0.72;
const GLYPH_APPROXIMATE_THRESHOLD = 0.72;
const sharedQueues = new Map();
const decodedFeatures = new WeakMap();
const graphemeSegmenter = typeof Intl.Segmenter === 'function' ?
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
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

/** @param {unknown} value */
function graphemes(value) {
    const text = `${value || ''}`;
    return graphemeSegmenter ? [...graphemeSegmenter.segment(text)].map(item => item.segment) : Array.from(text);
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
function validateGlyphSample(input) {
    if (!input || typeof input !== 'object') throw new TypeError('Visual glyph sample is invalid.');
    const value = /** @type {any} */ (input);
    const grapheme = typeof value.grapheme === 'string' ? value.grapheme.normalize('NFC') : '';
    if (!grapheme || /[\u0000-\u001f\u007f\s]/u.test(grapheme) || graphemes(grapheme).length !== 1 ||
        Array.from(grapheme).length > 16 || typeof value.observedAt !== 'string' ||
        Number.isNaN(Date.parse(value.observedAt))) {
        throw new TypeError('Visual glyph identity is invalid.');
    }
    const feature = validateFeature(value.feature);
    const sampleId = Crypto.createHash('sha256').update(`${grapheme}\0${feature.digest}`, 'utf8').digest('hex');
    if (value.sampleId !== sampleId) throw new TypeError('Visual glyph sample ID is invalid.');
    return Object.freeze({
        sampleId,
        grapheme,
        observedAt: new Date(value.observedAt).toISOString(),
        feature
    });
}

/** @param {unknown} input */
function validateDocument(input) {
    const value = /** @type {any} */ (input);
    if (!input || typeof input !== 'object' ||
        ![LEGACY_SCHEMA_VERSION, SCHEMA_VERSION].includes(value.schemaVersion) ||
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
    const rawGlyphSamples = value.schemaVersion === LEGACY_SCHEMA_VERSION ? [] : value.glyphSamples;
    if (!Array.isArray(rawGlyphSamples) || rawGlyphSamples.length > MAX_GLYPH_SAMPLES) {
        throw new TypeError('Visual glyph library schema is invalid.');
    }
    const glyphSamples = rawGlyphSamples.map(validateGlyphSample);
    if (new Set(glyphSamples.map((/** @type {any} */ sample) => sample.sampleId)).size !== glyphSamples.length) {
        throw new TypeError('Visual glyph library contains duplicate samples.');
    }
    const glyphCounts = new Map();
    for (const sample of glyphSamples) {
        const count = (glyphCounts.get(sample.grapheme) || 0) + 1;
        if (count > MAX_GLYPH_SAMPLES_PER_GRAPHEME) {
            throw new TypeError('Visual glyph library exceeds the per-grapheme sample limit.');
        }
        glyphCounts.set(sample.grapheme, count);
    }
    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        samples: Object.freeze(samples),
        glyphSamples: Object.freeze(glyphSamples)
    });
}

/** @param {string} file */
async function read(file) {
    try {
        const text = await Fs.promises.readFile(file, 'utf8');
        return validateDocument(JSON.parse(text));
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
            return Object.freeze({
                schemaVersion: SCHEMA_VERSION,
                samples: Object.freeze([]),
                glyphSamples: Object.freeze([])
            });
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

/** @param {any} image @param {{x:number,y:number,width:number,height:number}} box @param {any} JimpImpl */
function foregroundColumnRuns(image, box, JimpImpl = Jimp) {
    const left = Math.max(0, Math.floor(box.x));
    const top = Math.max(0, Math.floor(box.y));
    const right = Math.min(image.bitmap.width, Math.ceil(box.x + box.width));
    const bottom = Math.min(image.bitmap.height, Math.ceil(box.y + box.height));
    if (right <= left || bottom <= top) return Object.freeze([]);
    const active = [];
    for (let x = left; x < right; x += 1) {
        let foreground = false;
        for (let y = top; y < bottom && !foreground; y += 1) {
            const { r, g, b, a } = JimpImpl.intToRGBA(image.getPixelColor(x, y));
            foreground = isRustUiTextPixel(r, g, b, a);
        }
        active.push(foreground);
    }
    const runs = [];
    let start = -1;
    for (let index = 0; index <= active.length; index += 1) {
        if (active[index] === true && start === -1) start = index;
        if (active[index] !== true && start !== -1) {
            runs.push(Object.freeze({ x: left + start, y: top, width: index - start, height: bottom - top }));
            start = -1;
        }
    }
    return Object.freeze(runs);
}

/**
 * Learns only when one foreground run maps to one Unicode grapheme. Connected scripts,
 * touching letters, and uncertain segmentations deliberately return no samples.
 * @param {any} image @param {readonly OcrWord[]} boxes @param {string} name @param {any} [JimpImpl]
 */
function glyphFeaturesFromBoxes(image, boxes, name, JimpImpl = Jimp) {
    const expectedWords = cleanName(name).split(/\s+/u).filter(Boolean);
    if (!Array.isArray(boxes) || boxes.length !== expectedWords.length || expectedWords.length === 0) {
        return Object.freeze([]);
    }
    if (expectedWords.reduce((total, word) => total + graphemes(word).length, 0) > MAX_GLYPHS_PER_ALIAS) {
        return Object.freeze([]);
    }
    const result = [];
    for (let index = 0; index < boxes.length; index += 1) {
        const box = boxes[index];
        const labels = graphemes(expectedWords[index]);
        let runs = foregroundColumnRuns(image, box, JimpImpl);
        const rawText = `${box.text || ''}`.normalize('NFC');
        const leading = graphemes((rawText.match(/^[,;:]+/u) || [''])[0]).length;
        const trailing = graphemes((rawText.match(/[,;:]+$/u) || [''])[0]).length;
        const stripped = rawText.replace(/^[,;:]+|[,;:]+$/gu, '');
        const comparable = (/** @type {string} */ value) => value.normalize('NFKC').toLocaleLowerCase('en');
        if (runs.length !== labels.length && comparable(stripped) === comparable(expectedWords[index]) &&
            runs.length === labels.length + leading + trailing) {
            runs = Object.freeze(runs.slice(leading, runs.length - trailing));
        }
        if (runs.length !== labels.length) return Object.freeze([]);
        for (let glyphIndex = 0; glyphIndex < labels.length; glyphIndex += 1) {
            const feature = featureFromBoxes(image, [runs[glyphIndex]], JimpImpl);
            if (!feature) return Object.freeze([]);
            result.push(Object.freeze({ grapheme: labels[glyphIndex].normalize('NFC'), feature }));
        }
    }
    return Object.freeze(result);
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
            const boxes = CinfoRoles.findMemberBoxes(words, name);
            const feature = featureFromBoxes(image, boxes, JimpImpl);
            return feature ? Object.freeze({
                memberIndex: index,
                observedText: name,
                feature,
                glyphs: glyphFeaturesFromBoxes(image, boxes, name, JimpImpl)
            }) : null;
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

/** @param {any} feature @param {readonly any[]} glyphSamples */
function glyphScores(feature, glyphSamples) {
    const scores = new Map();
    for (const sample of glyphSamples) {
        const score = featureSimilarity(feature, sample.feature);
        if (score < 0.5 || score <= (scores.get(sample.grapheme) || 0)) continue;
        scores.set(sample.grapheme, score);
    }
    return scores;
}

/** @param {string} name */
function compactGraphemes(name) {
    return graphemes(cleanName(name).normalize('NFC')).filter(grapheme => !/^\s+$/u.test(grapheme));
}

/** @param {readonly any[]} glyphs @param {readonly any[]} samples @param {readonly any[]} glyphSamples */
function matchGlyphSequence(glyphs, samples, glyphSamples) {
    if (!Array.isArray(glyphs) || glyphs.length === 0 || glyphs.length > MAX_GLYPHS_PER_ALIAS ||
        glyphSamples.length === 0) {
        return Object.freeze([]);
    }
    const positionScores = glyphs.map(glyph => glyphScores(validateFeature(glyph.feature), glyphSamples));
    const identities = new Map();
    for (const sample of samples) {
        const expected = compactGraphemes(sample.name);
        if (expected.length !== positionScores.length) continue;
        const scores = expected.map((grapheme, index) => positionScores[index].get(grapheme));
        if (scores.some(score => score === undefined)) continue;
        const numericScores = /** @type {number[]} */ (scores);
        const minimum = Math.min(...numericScores);
        const average = numericScores.reduce((sum, score) => sum + score, 0) / numericScores.length;
        const score = Number((average * 0.8 + minimum * 0.2).toFixed(6));
        if (score < GLYPH_APPROXIMATE_THRESHOLD) continue;
        const key = `${sample.steamId || ''}\0${sample.battlemetricsPlayerId || ''}\0${sample.name}`;
        const previous = identities.get(key);
        if (!previous || score > previous.score) identities.set(key, { sample, score });
    }
    return Object.freeze([...identities.values()].sort((left, right) => right.score - left.score ||
        right.sample.observedAt.localeCompare(left.sample.observedAt) ||
        left.sample.sampleId.localeCompare(right.sample.sampleId)).slice(0, 8)
        .map(match => Object.freeze(match)));
}

/** @param {Map<string,any>} candidates @param {any} match @param {number} memberIndex @param {boolean} exact */
function addVisualCandidate(candidates, match, memberIndex, exact) {
    const sample = match.sample;
    const key = `${memberIndex}\0${sample.steamId || ''}\0${sample.battlemetricsPlayerId || ''}\0${sample.name}`;
    const score = exact ? match.score : Math.min(match.score, 0.999999);
    const previous = candidates.get(key);
    if (previous) {
        candidates.set(key, Object.freeze({
            ...previous,
            corroborated: previous.corroborated || exact,
            visualScore: Math.max(previous.visualScore, score)
        }));
        return;
    }
    candidates.set(key, Object.freeze({
        name: sample.name,
        steamId: sample.steamId,
        battlemetricsPlayerId: sample.battlemetricsPlayerId,
        caseFidelity: sample.caseFidelity,
        corroborated: exact,
        contextPriority: true,
        targetMemberIndex: memberIndex,
        visualScore: score
    }));
}

/** @param {string} file @param {readonly any[]} items */
async function candidatesForItems(file, items) {
    const document = await serialized(file, () => read(file));
    return Object.freeze(items.map(item => {
        const candidates = new Map();
        for (const visual of item.visualSamples || []) {
            for (const match of matchFeature(visual.feature, document.samples)) {
                addVisualCandidate(candidates, match, visual.memberIndex, match.score === 1);
            }
            for (const match of matchGlyphSequence(visual.glyphs || [], document.samples,
                document.glyphSamples)) {
                addVisualCandidate(candidates, match, visual.memberIndex, false);
            }
        }
        return Object.freeze([...candidates.values()].sort((left, right) =>
            Number(right.corroborated) - Number(left.corroborated) ||
            right.visualScore - left.visualScore || left.name.localeCompare(right.name)));
    }));
}

/** @param {string} file @param {readonly any[]} items @param {string} observedAt */
function recordResolved(file, items, observedAt) {
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
        throw new TypeError('Visual alias observation time is invalid.');
    }
    /** @type {any[]} */
    const additions = [];
    /** @type {any[]} */
    const glyphAdditions = [];
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
            const exactObservedName = cleanName(visual.observedText).normalize('NFC') ===
                cleanName(member.name).normalize('NFC');
            if (item.parsed.kind !== 'cinfo' || !exactObservedName || member.caseFidelity === false ||
                !Array.isArray(visual.glyphs)) continue;
            for (const glyph of visual.glyphs) {
                if (!glyph || typeof glyph.grapheme !== 'string') continue;
                const glyphFeature = validateFeature(glyph.feature);
                const grapheme = glyph.grapheme.normalize('NFC');
                const glyphSampleId = Crypto.createHash('sha256').update(`${grapheme}\0${
                    glyphFeature.digest}`, 'utf8').digest('hex');
                glyphAdditions.push(validateGlyphSample({
                    sampleId: glyphSampleId,
                    grapheme,
                    observedAt: new Date(observedAt).toISOString(),
                    feature: glyphFeature
                }));
            }
        }
    }
    if (additions.length === 0 && glyphAdditions.length === 0) {
        return Promise.resolve(Object.freeze({ added: 0, total: 0 }));
    }
    return serialized(file, async () => {
        const document = await read(file);
        const samples = [...document.samples];
        const glyphSamples = [...document.glyphSamples];
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
        let glyphsAdded = 0;
        for (const sample of glyphAdditions) {
            if (glyphSamples.some(existing => existing.sampleId === sample.sampleId)) continue;
            if (glyphSamples.filter(existing => existing.grapheme === sample.grapheme).length >=
                MAX_GLYPH_SAMPLES_PER_GRAPHEME) continue;
            glyphSamples.push(sample);
            glyphsAdded += 1;
        }
        glyphSamples.sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
            left.sampleId.localeCompare(right.sampleId));
        const boundedGlyphs = glyphSamples.slice(Math.max(0, glyphSamples.length - MAX_GLYPH_SAMPLES));
        if (added > 0 || glyphsAdded > 0 || document.schemaVersion !== SCHEMA_VERSION) {
            await write(file, {
                schemaVersion: SCHEMA_VERSION,
                samples: bounded,
                glyphSamples: boundedGlyphs
            });
        }
        return Object.freeze({ added, total: bounded.length });
    });
}

module.exports = Object.freeze({
    APPROXIMATE_THRESHOLD,
    FEATURE_HEIGHT,
    FEATURE_WIDTH,
    GLYPH_APPROXIMATE_THRESHOLD,
    MAX_GLYPH_SAMPLES,
    MAX_GLYPH_SAMPLES_PER_GRAPHEME,
    MAX_GLYPHS_PER_ALIAS,
    MAX_SAMPLES,
    MAX_SAMPLES_PER_ALIAS,
    VisualAliasLibraryCorruptionError,
    candidatesForItems,
    extractCinfoSamples: extractVisualSamples,
    extractVisualSamples,
    featureFromBoxes,
    featureSimilarity,
    glyphFeaturesFromBoxes,
    matchGlyphSequence,
    matchFeature,
    read,
    recordResolved,
    validateDocument,
    validateFeature,
    validateGlyphSample
});
