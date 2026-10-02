// @ts-check
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');

const VisualAliasLibrary = require('./visualAliasLibrary.js');

const SCHEMA_VERSION = 1;
const MAX_TEMPLATES = 2000;
const MAX_TEMPLATES_PER_NAME = 4;
const APPROXIMATE_THRESHOLD = 0.985;
const APPROXIMATE_MARGIN = 0.03;
const sharedQueues = new Map();
const documentCache = new Map();
const indexCache = new WeakMap();

class OcrCorrectionMemoryCorruptionError extends Error {
    /** @param {string} file @param {unknown} cause */
    constructor(file, cause) {
        super(`OCR correction memory is corrupt at ${file}; it was preserved.`);
        this.name = 'OcrCorrectionMemoryCorruptionError';
        this.file = file;
        this.cause = cause;
    }
}

/** @param {unknown} value */
function cleanName(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {string} value */
function nameKey(value) {
    return cleanName(value).normalize('NFKC').toLocaleLowerCase('en');
}

/**
 * Returns a long, human-confirmed core only when decorations are clearly peripheral.
 * Attached digits remain part of the name: `1Marley4` is deliberately not a match.
 * @param {unknown} value
 */
function decoratedCore(value) {
    const text = cleanName(value).normalize('NFC');
    if (!text) return null;
    const tokens = text.split(/\s+/u);
    const edge = (/** @type {string} */ token) => /^(?:\d|[^\p{L}\p{N}]{1,3})$/u.test(token);
    let core = text;
    if (tokens.length >= 3 && edge(tokens[0]) && edge(tokens.at(-1) || '')) {
        core = tokens.slice(1, -1).join(' ');
    }
    else {
        const stripped = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
        if (stripped === text) return null;
        core = stripped;
    }
    const compact = core.replace(/[^\p{L}\p{N}]/gu, '');
    return Array.from(compact).length >= 5 ? nameKey(core) : null;
}

/** @param {unknown} input */
function validateTemplate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('OCR correction template is invalid.');
    }
    const value = /** @type {any} */ (input);
    const observedText = cleanName(value.observedText).normalize('NFC');
    const correctedText = cleanName(value.correctedText).normalize('NFC');
    if (!observedText || !correctedText || Array.from(observedText).length > 128 ||
        Array.from(correctedText).length > 128 || typeof value.confirmedAt !== 'string' ||
        Number.isNaN(Date.parse(value.confirmedAt))) {
        throw new TypeError('OCR correction template text is invalid.');
    }
    const feature = VisualAliasLibrary.validateFeature(value.feature);
    const templateId = Crypto.createHash('sha256').update(`${observedText}\0${correctedText}\0${
        feature.digest}`, 'utf8').digest('hex');
    if (value.templateId !== templateId) throw new TypeError('OCR correction template ID is invalid.');
    return Object.freeze({
        templateId,
        observedText,
        correctedText,
        confirmedAt: new Date(value.confirmedAt).toISOString(),
        feature
    });
}

/** @param {unknown} input */
function validateDocument(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('OCR correction memory schema is invalid.');
    }
    const value = /** @type {any} */ (input);
    if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.templates) ||
        value.templates.length > MAX_TEMPLATES) {
        throw new TypeError('OCR correction memory schema is invalid.');
    }
    const templates = value.templates.map(validateTemplate);
    if (new Set(templates.map((/** @type {any} */ template) => template.templateId)).size !== templates.length) {
        throw new TypeError('OCR correction memory contains duplicate templates.');
    }
    const counts = new Map();
    for (const template of templates) {
        const key = nameKey(template.correctedText);
        const count = (counts.get(key) || 0) + 1;
        if (count > MAX_TEMPLATES_PER_NAME) {
            throw new TypeError('OCR correction memory exceeds the per-name template limit.');
        }
        counts.set(key, count);
    }
    return Object.freeze({ schemaVersion: SCHEMA_VERSION, templates: Object.freeze(templates) });
}

/** @param {string} file */
async function read(file) {
    try {
        const stat = await Fs.promises.stat(file);
        const key = Path.resolve(file);
        const cached = documentCache.get(key);
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs &&
            cached.ctimeMs === stat.ctimeMs) return cached.document;
        const document = validateDocument(JSON.parse(await Fs.promises.readFile(file, 'utf8')));
        documentCache.set(key, Object.freeze({ size: stat.size, mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs, document }));
        return document;
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
            return Object.freeze({ schemaVersion: SCHEMA_VERSION, templates: Object.freeze([]) });
        }
        if (error instanceof OcrCorrectionMemoryCorruptionError) throw error;
        throw new OcrCorrectionMemoryCorruptionError(file, error);
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
        const stat = await Fs.promises.stat(file);
        documentCache.set(Path.resolve(file), Object.freeze({ size: stat.size, mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs, document: checked }));
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

/** @param {string} observed @param {readonly string[]} confirmedNames */
function confirmedNameHint(observed, confirmedNames) {
    const core = decoratedCore(observed);
    if (!core) return null;
    const matches = [...new Map(confirmedNames.map(name => [nameKey(name), cleanName(name).normalize('NFC')]))
        .values()].filter(name => decoratedCore(name) === core && nameKey(name) !== nameKey(observed));
    return matches.length === 1 ? matches[0] : null;
}

/** @param {any} item @param {Map<number,string>} corrections */
function applyMemberCorrections(item, corrections) {
    if (corrections.size === 0 || !item.parsed || item.parsed.kind !== 'cinfo') return item;
    const members = item.parsed.members.map((/** @type {any} */ member, /** @type {number} */ index) => {
        const corrected = corrections.get(index);
        return corrected ? Object.freeze({ ...member, ocrObservedText: member.ocrObservedText || member.name,
            name: corrected }) : member;
    });
    const keys = members.map((/** @type {any} */ member) => nameKey(member.name));
    if (new Set(keys).size !== keys.length) return item;
    return Object.freeze({ ...item, parsed: Object.freeze({ ...item.parsed, members: Object.freeze(members) }) });
}

/** @param {readonly any[]} items @param {readonly string[]} confirmedNames */
function applyConfirmedNameHints(items, confirmedNames) {
    if (!Array.isArray(items) || !Array.isArray(confirmedNames)) {
        throw new TypeError('Confirmed OCR name hints are invalid.');
    }
    return Object.freeze(items.map(item => {
        if (!item.parsed || item.parsed.kind !== 'cinfo' || !Array.isArray(item.parsed.members)) return item;
        const corrections = new Map();
        item.parsed.members.forEach((/** @type {any} */ member, /** @type {number} */ index) => {
            const hint = confirmedNameHint(member.name, confirmedNames);
            if (hint) corrections.set(index, hint);
        });
        return applyMemberCorrections(item, corrections);
    }));
}

/** @param {any} feature @param {readonly any[]} templates @param {string} observedText */
function match(feature, templates, observedText) {
    const exact = templates.filter(template => template.feature.digest === feature.digest);
    const exactNames = [...new Map(exact.map(template => [nameKey(template.correctedText),
        template.correctedText])).values()];
    if (exactNames.length === 1) return Object.freeze({ name: exactNames[0], score: 1 });
    if (exactNames.length > 1) return null;

    const observedKey = nameKey(observedText);
    const candidates = templates.filter(template => nameKey(template.observedText) === observedKey &&
        Array.from(template.correctedText.replace(/[^\p{L}\p{N}]/gu, '')).length > 3 &&
        Math.min(feature.aspectRatio, template.feature.aspectRatio) /
            Math.max(feature.aspectRatio, template.feature.aspectRatio) >= 0.85)
        .map(template => ({ template, score: VisualAliasLibrary.featureSimilarity(feature, template.feature) }))
        .filter(candidate => candidate.score >= APPROXIMATE_THRESHOLD);
    const byName = new Map();
    for (const candidate of candidates) {
        const key = nameKey(candidate.template.correctedText);
        const previous = byName.get(key);
        if (!previous || candidate.score > previous.score) byName.set(key, candidate);
    }
    const ranked = [...byName.values()].sort((left, right) => right.score - left.score ||
        left.template.correctedText.localeCompare(right.template.correctedText));
    if (ranked.length === 0 || ranked[0].score - (ranked[1] ? ranked[1].score : 0) < APPROXIMATE_MARGIN) return null;
    return Object.freeze({ name: ranked[0].template.correctedText, score: ranked[0].score });
}

/** @param {any} document */
function templateIndexes(document) {
    const cached = indexCache.get(document);
    if (cached) return cached;
    const byDigest = new Map();
    const byObserved = new Map();
    for (const template of document.templates) {
        const digestValues = byDigest.get(template.feature.digest) || [];
        digestValues.push(template);
        byDigest.set(template.feature.digest, digestValues);
        const observedValues = byObserved.get(nameKey(template.observedText)) || [];
        observedValues.push(template);
        byObserved.set(nameKey(template.observedText), observedValues);
    }
    const indexes = Object.freeze({ byDigest, byObserved });
    indexCache.set(document, indexes);
    return indexes;
}

/** @param {string} file @param {readonly any[]} items @param {readonly string[]} confirmedNames */
async function apply(file, items, confirmedNames = []) {
    if (!Array.isArray(items)) throw new TypeError('OCR correction input must be an array.');
    const hinted = applyConfirmedNameHints(items, confirmedNames);
    const document = await serialized(file, () => read(file));
    if (document.templates.length === 0) return hinted;
    const { byDigest, byObserved } = templateIndexes(document);
    return Object.freeze(hinted.map(item => {
        if (!item.parsed || item.parsed.kind !== 'cinfo') return item;
        const corrections = new Map();
        for (const visual of item.visualSamples || []) {
            if (visual.boundaryProof !== true || !Number.isSafeInteger(visual.memberIndex)) continue;
            const member = item.parsed.members[visual.memberIndex];
            if (!member) continue;
            const feature = VisualAliasLibrary.validateFeature(visual.feature);
            const candidates = [...(byDigest.get(feature.digest) || []),
                ...(byObserved.get(nameKey(visual.observedText || member.name)) || [])];
            const result = match(feature, [...new Map(candidates.map(template =>
                [template.templateId, template])).values()], visual.observedText || member.name);
            if (result && nameKey(result.name) !== nameKey(member.name)) {
                corrections.set(visual.memberIndex, result.name);
            }
        }
        return applyMemberCorrections(item, corrections);
    }));
}

/** @param {string} file @param {readonly any[]} items @param {string} confirmedAt */
function recordConfirmed(file, items, confirmedAt) {
    if (!Array.isArray(items) || typeof confirmedAt !== 'string' || Number.isNaN(Date.parse(confirmedAt))) {
        throw new TypeError('Confirmed OCR correction update is invalid.');
    }
    /** @type {any[]} */
    const additions = [];
    for (const item of items) {
        if (!item.parsed || item.parsed.kind !== 'cinfo' || !Array.isArray(item.confirmedCorrectionNames) ||
            item.confirmedCorrectionNames.length !== item.parsed.declaredCount) continue;
        const indexes = new Set();
        for (const visual of item.visualSamples || []) {
            if (visual.boundaryProof !== true || !Number.isSafeInteger(visual.memberIndex) ||
                indexes.has(visual.memberIndex)) continue;
            indexes.add(visual.memberIndex);
            const observedText = cleanName(visual.observedText).normalize('NFC');
            const correctedText = cleanName(item.confirmedCorrectionNames[visual.memberIndex]).normalize('NFC');
            if (!observedText || !correctedText || observedText === correctedText) continue;
            const feature = VisualAliasLibrary.validateFeature(visual.feature);
            const templateId = Crypto.createHash('sha256').update(`${observedText}\0${correctedText}\0${
                feature.digest}`, 'utf8').digest('hex');
            additions.push(validateTemplate({ templateId, observedText, correctedText, confirmedAt, feature }));
        }
    }
    if (additions.length === 0) return Promise.resolve(Object.freeze({ added: 0, total: 0 }));
    return serialized(file, async () => {
        const document = await read(file);
        const templates = [...document.templates];
        let added = 0;
        for (const addition of additions) {
            if (templates.some(template => template.templateId === addition.templateId)) continue;
            const key = nameKey(addition.correctedText);
            const same = templates.filter(template => nameKey(template.correctedText) === key)
                .sort((left, right) => left.confirmedAt.localeCompare(right.confirmedAt) ||
                    left.templateId.localeCompare(right.templateId));
            while (same.length >= MAX_TEMPLATES_PER_NAME) {
                const oldest = same.shift();
                const index = templates.findIndex(template => template.templateId === oldest.templateId);
                if (index !== -1) templates.splice(index, 1);
            }
            templates.push(addition);
            added += 1;
        }
        templates.sort((left, right) => left.confirmedAt.localeCompare(right.confirmedAt) ||
            left.templateId.localeCompare(right.templateId));
        const bounded = templates.slice(Math.max(0, templates.length - MAX_TEMPLATES));
        await write(file, { schemaVersion: SCHEMA_VERSION, templates: bounded });
        return Object.freeze({ added, total: bounded.length });
    });
}

/** @param {string} file */
async function confirmedWords(file) {
    const document = await serialized(file, () => read(file));
    return Object.freeze([...new Map([...document.templates].reverse().map(template =>
        [nameKey(template.correctedText), template.correctedText])).values()]);
}

module.exports = Object.freeze({
    APPROXIMATE_MARGIN,
    APPROXIMATE_THRESHOLD,
    MAX_TEMPLATES,
    MAX_TEMPLATES_PER_NAME,
    OcrCorrectionMemoryCorruptionError,
    SCHEMA_VERSION,
    apply,
    applyConfirmedNameHints,
    confirmedNameHint,
    confirmedWords,
    decoratedCore,
    match,
    read,
    recordConfirmed,
    validateDocument,
    validateTemplate
});
