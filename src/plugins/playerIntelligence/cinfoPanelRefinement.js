// @ts-check
const Jimp = require('jimp');

const Layout = require('./ocrLayout.js');
const OcrImagePreprocess = require('./ocrImagePreprocess.js');
const { parseCinfoWords, parseEstablished, splitCinfoWordBlocks } = require('./parseCinfo.js');

/** @param {{parsed:any}} block */
function blockQuality(block) {
    const parsed = block.parsed;
    const structure = Number(Boolean(parsed.tag)) + Number(Number.isSafeInteger(parsed.declaredCount)) +
        Number(Boolean(parsed.establishedAtUtc));
    return 1000 + structure * 100 + parsed.members.length * 12 +
        (parsed.complete ? 50 : 0) - parsed.errors.length * 3;
}

/** @param {any} image @param {{words:unknown}} block */
function panelBounds(image, block) {
    const lines = Layout.groupLines(block.words);
    const start = lines.findIndex(line => /clan\s*tag\s*:/iu.test(line.text));
    const established = lines.findIndex(line => /established\s*:/iu.test(line.text));
    if (start === -1 || established < start) return null;
    const relevant = lines.slice(start, established + 1);
    const typicalHeight = Math.max(1, Layout.median(relevant.map(line => line.height)));
    const left = Math.max(0, Math.floor(Math.min(...relevant.map(line => line.x)) - typicalHeight));
    const top = Math.max(0, Math.floor(relevant[0].y - typicalHeight * 0.5));
    const recognizedRight = Math.max(...relevant.map(line => line.x + line.width));
    const right = Math.min(image.bitmap.width, Math.ceil(recognizedRight + typicalHeight * 6));
    const last = relevant.at(-1);
    if (!last) return null;
    const bottom = Math.min(image.bitmap.height, Math.ceil(last.y + last.height + typicalHeight * 0.5));
    if (right - left < typicalHeight * 3 || bottom - top < typicalHeight * 3) return null;
    return Object.freeze({ left, top, width: right - left, height: bottom - top });
}

/** @param {any} image @param {{words:unknown}} block */
function establishedBounds(image, block) {
    const line = Layout.groupLines(block.words).find(candidate => /established\s*:/iu.test(candidate.text));
    if (!line) return null;
    const anchor = line.words.find(word => /established/iu.test(word.text));
    if (!anchor) return null;
    const colon = anchor.text.indexOf(':');
    const valueFraction = colon === -1 ? 1 : Math.min(1, (colon + 1) / Math.max(1, anchor.text.length));
    const height = Math.max(1, line.height);
    const left = Math.max(0, Math.floor(anchor.x + anchor.width * valueFraction - height * 0.25));
    const recognizedRight = Math.max(...line.words.map(word => word.x + word.width));
    const right = Math.min(image.bitmap.width,
        Math.ceil(Math.max(recognizedRight + height, left + height * 14)));
    const top = Math.max(0, Math.floor(line.y - height * 0.35));
    const bottom = Math.min(image.bitmap.height, Math.ceil(line.y + line.height + height * 0.35));
    if (right <= left || bottom <= top) return null;
    return Object.freeze({ left, top, width: right - left, height: bottom - top, line });
}

/** @param {readonly any[]} words @param {number} scale @param {{left:number,top:number}} bounds */
function mapCropWords(words, scale, bounds) {
    if (!Array.isArray(words) || !Number.isFinite(scale) || scale <= 0) {
        throw new TypeError('Cinfo panel OCR returned invalid geometry.');
    }
    return Object.freeze(words.map(word => Object.freeze({
        ...word,
        x: word.x / scale + bounds.left,
        y: word.y / scale + bounds.top,
        width: word.width / scale,
        height: word.height / scale
    })));
}

/** @param {any} original @param {any} candidate */
function samePanel(original, candidate) {
    const originalTag = `${original.parsed.tag || ''}`.normalize('NFKC').toLocaleLowerCase('en');
    const candidateTag = `${candidate.parsed.tag || ''}`.normalize('NFKC').toLocaleLowerCase('en');
    if (originalTag && candidateTag && originalTag !== candidateTag) return false;
    const originalCount = original.parsed.declaredCount;
    const candidateCount = candidate.parsed.declaredCount;
    return !Number.isSafeInteger(originalCount) || !Number.isSafeInteger(candidateCount) ||
        originalCount === candidateCount;
}

/** @param {any} image @param {any} block @param {Function} recognize @param {any} ocrOptions
 * @param {any} dependencies @param {any} JimpImpl */
async function refineEstablished(image, block, recognize, ocrOptions, dependencies, JimpImpl) {
    if (block.parsed.establishedAtUtc) return block;
    const bounds = establishedBounds(image, block);
    if (!bounds) return block;
    const crop = image.clone().crop(bounds.left, bounds.top, bounds.width, bounds.height);
    const cropBuffer = await crop.getBufferAsync(JimpImpl.MIME_PNG || Jimp.MIME_PNG);
    const preprocess = dependencies.preprocessDateImage || OcrImagePreprocess.createTextMask;
    const processed = await preprocess(cropBuffer.toString('base64'), {
        JimpImpl,
        scale: 4,
        minForegroundRatio: 0.001,
        maxForegroundRatio: 0.85
    });
    const words = await recognize(processed.imageBase64, {
        ...ocrOptions,
        psm: 7,
        timeoutMs: Math.min(20000, Number(ocrOptions.timeoutMs) || 20000),
        userWords: [],
        characterWhitelist: '0123456789/: '
    });
    const text = Array.isArray(words) ? words.map(word => `${word.text || ''}`).join(' ') : '';
    const match = /(\d{2}\/\d{2}\/\d{4})\s*(\d{2}:\d{2}:\d{2})/u.exec(text);
    const establishedRaw = match ? `${match[1]} ${match[2]}` : '';
    if (!parseEstablished(establishedRaw)) return block;
    const wordKey = (/** @type {any} */ word) => `${word.text}\0${word.x}\0${word.y}\0${word.width}\0${word.height}`;
    const targetWords = new Set(bounds.line.words.map(wordKey));
    const replacement = Object.freeze({
        text: `Established: ${establishedRaw}`,
        x: bounds.line.x,
        y: bounds.line.y,
        width: bounds.line.width,
        height: bounds.line.height,
        confidence: null
    });
    const candidateWords = Object.freeze([
        ...Layout.normalizeWords(block.words).filter(word => !targetWords.has(wordKey(word))),
        replacement
    ]);
    return Object.freeze({ words: candidateWords, parsed: parseCinfoWords(candidateWords, dependencies.cinfoOptions) });
}

/**
 * Runs one deterministic OCR pass per incomplete semantic panel. It is a distinct,
 * bounded input, not a retry of the full screenshot.
 * @param {string} imageBase64 @param {readonly any[]} blocks @param {Function} recognize
 * @param {any} ocrOptions @param {any} dependencies
 */
async function refineCinfoPanels(imageBase64, blocks, recognize, ocrOptions, dependencies = {}) {
    if (typeof imageBase64 !== 'string' || !Array.isArray(blocks) || typeof recognize !== 'function') {
        throw new TypeError('Cinfo panel refinement input is invalid.');
    }
    const JimpImpl = dependencies.JimpImpl || Jimp;
    const image = await JimpImpl.read(Buffer.from(imageBase64, 'base64'));
    const preprocess = dependencies.preprocessPanelImage || OcrImagePreprocess.createTextMask;
    const refined = [];
    let failed = 0;
    const reasons = [];
    for (const block of blocks) {
        if (block.parsed.complete && block.parsed.establishedAtUtc) {
            refined.push(block);
            continue;
        }
        const bounds = panelBounds(image, block);
        if (!bounds) {
            refined.push(block);
            failed += 1;
            reasons.push('semantic panel bounds unavailable');
            continue;
        }
        try {
            const crop = image.clone().crop(bounds.left, bounds.top, bounds.width, bounds.height);
            const cropBuffer = await crop.getBufferAsync(JimpImpl.MIME_PNG || Jimp.MIME_PNG);
            const processed = await preprocess(cropBuffer.toString('base64'), {
                JimpImpl,
                scale: 3,
                minForegroundRatio: 0.001,
                maxForegroundRatio: 0.7
            });
            const timeoutMs = Number.isFinite(Number(dependencies.panelOcrTimeoutMs)) ?
                Math.min(30000, Math.max(1000, Number(dependencies.panelOcrTimeoutMs))) :
                Math.min(30000, Number(ocrOptions.timeoutMs) || 30000);
            const words = mapCropWords(await recognize(processed.imageBase64, {
                ...ocrOptions,
                psm: 6,
                timeoutMs
            }), processed.scale, bounds);
            const candidates = splitCinfoWordBlocks(words).map(candidateWords => Object.freeze({
                words: candidateWords,
                parsed: parseCinfoWords(candidateWords, dependencies.cinfoOptions)
            }));
            const candidate = candidates.length === 1 ? candidates[0] : null;
            let selected = block;
            if (candidate && samePanel(block, candidate) && blockQuality(candidate) > blockQuality(block)) {
                selected = candidate;
            }
            selected = await refineEstablished(image, selected, recognize, ocrOptions, dependencies, JimpImpl);
            refined.push(selected);
            if (!selected.parsed.complete || !selected.parsed.establishedAtUtc) {
                failed += 1;
                reasons.push('isolated panel/date score did not produce a complete structure');
            }
        }
        catch (error) {
            refined.push(block);
            failed += 1;
            reasons.push(`${error instanceof Error ? error.message : error}`.replace(/\s+/gu, ' ').slice(0, 160));
        }
    }
    return Object.freeze({
        blocks: Object.freeze(refined),
        warning: failed > 0 ? `${failed}/${blocks.length} panels remain structurally incomplete; ${
            [...new Set(reasons)].slice(0, 2).join('; ')}.` : null
    });
}

module.exports = Object.freeze({
    blockQuality,
    establishedBounds,
    mapCropWords,
    panelBounds,
    refineCinfoPanels,
    refineEstablished,
    samePanel
});
