// @ts-check
const Jimp = require('jimp');

const Layout = require('./ocrLayout.js');
const OcrImagePreprocess = require('./ocrImagePreprocess.js');
const OcrCorrectionMemory = require('./ocrCorrectionMemory.js');
const { parseCinfoWords, parseEstablished, splitCinfoWordBlocks } = require('./parseCinfo.js');

const MAX_ISOLATED_ROSTER_MEMBERS = 32;
const MAX_ISOLATED_SHEET_PIXELS = 8 * 1024 * 1024;

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

/** @param {any} image @param {any} line @param {RegExp|null} anchorExpression */
function lineValueBounds(image, line, anchorExpression = null) {
    if (!line || !Array.isArray(line.words) || line.words.length === 0) return null;
    const height = Math.max(1, line.height);
    let left = line.x;
    if (anchorExpression) {
        const anchor = line.words.find((/** @type {any} */ word) => anchorExpression.test(word.text));
        if (!anchor) return null;
        const colon = anchor.text.indexOf(':');
        const valueFraction = colon === -1 ? 1 : Math.min(1, (colon + 1) /
            Math.max(1, Array.from(anchor.text).length));
        left = anchor.x + anchor.width * valueFraction;
    }
    left = Math.max(0, Math.floor(left - height * 0.2));
    const recognizedRight = Math.max(...line.words.map((/** @type {any} */ word) => word.x + word.width));
    const right = Math.min(image.bitmap.width,
        Math.ceil(Math.max(recognizedRight + height, left + height * 2)));
    const top = Math.max(0, Math.floor(line.y - height * 0.35));
    const bottom = Math.min(image.bitmap.height, Math.ceil(line.y + line.height + height * 0.35));
    if (right <= left || bottom <= top) return null;
    return Object.freeze({ left, top, width: right - left, height: bottom - top, line });
}

/** @param {any} image @param {{words:unknown}} block */
function tagValueBounds(image, block) {
    const line = Layout.groupLines(block.words).find(candidate => /clan\s*tag\s*:/iu.test(candidate.text));
    return lineValueBounds(image, line, /clan\s*tag/iu);
}

/** @param {any} image @param {any} before @param {any} after */
function projectedBoundsBetween(image, before, after) {
    const height = Math.max(1, Layout.median([before.height, after.height]));
    const center = (before.center + after.center) / 2;
    const left = Math.max(0, Math.floor(Math.min(before.x, after.x) - height * 0.25));
    const right = Math.min(image.bitmap.width, Math.ceil(Math.max(before.x + before.width,
        after.x + after.width) + height));
    const top = Math.max(0, Math.floor(center - height * 0.85));
    const bottom = Math.min(image.bitmap.height, Math.ceil(center + height * 0.85));
    if (right <= left || bottom <= top) return null;
    const line = Object.freeze({ words: Object.freeze([]), x: left, y: top, width: right - left,
        height: bottom - top, center });
    return Object.freeze({ left, top, width: right - left, height: bottom - top, line });
}

/** @param {any} image @param {any} line */
function projectedBoundsAfter(image, line) {
    const height = Math.max(1, line.height);
    const top = Math.max(0, Math.floor(line.y + line.height + height * 0.05));
    const bottom = Math.min(image.bitmap.height, Math.ceil(top + height * 1.7));
    const left = Math.max(0, Math.floor(line.x - height * 0.25));
    const right = Math.min(image.bitmap.width, Math.ceil(line.x + line.width + height));
    if (right <= left || bottom <= top) return null;
    const projected = Object.freeze({ words: Object.freeze([]), x: left, y: top, width: right - left,
        height: bottom - top, center: (top + bottom) / 2 });
    return Object.freeze({ left, top, width: right - left, height: bottom - top, line: projected });
}

/** @param {any} image @param {{words:unknown}} block */
function missingCountBounds(image, block) {
    const lines = Layout.groupLines(block.words);
    const tagIndex = lines.findIndex(line => /clan\s*tag\s*:/iu.test(line.text));
    const rosterIndex = lines.findIndex(line => /clan\s+members\s*:/iu.test(line.text));
    if (tagIndex === -1 || rosterIndex <= tagIndex) return null;
    const candidates = lines.slice(tagIndex + 1, rosterIndex);
    if (candidates.length === 0) return projectedBoundsBetween(image, lines[tagIndex], lines[rosterIndex]);
    const line = [...candidates].sort((left, right) => {
        const digitDelta = (right.text.match(/\d/gu) || []).length - (left.text.match(/\d/gu) || []).length;
        return digitDelta || right.center - left.center;
    })[0];
    return lineValueBounds(image, line);
}

/** @param {string} text */
function numericFieldScore(text) {
    return (text.match(/\d/gu) || []).length * 2 + (text.match(/[\/:]/gu) || []).length * 3;
}

/** @param {any} image @param {{words:unknown}} block */
function missingEstablishedBounds(image, block) {
    const anchored = establishedBounds(image, block);
    if (anchored) return anchored;
    const lines = Layout.groupLines(block.words);
    const rosterIndex = lines.findIndex(line => /clan\s+members\s*:/iu.test(line.text));
    if (rosterIndex === -1) return null;
    const candidates = lines.slice(rosterIndex + 1);
    if (candidates.length === 0) return projectedBoundsAfter(image, lines[rosterIndex]);
    const plausible = candidates.filter(line => /[\/:]/u.test(line.text) || /establ/iu.test(line.text) ||
        (line.text.match(/\d/gu) || []).length >= 8);
    if (plausible.length === 0) return projectedBoundsAfter(image, candidates.at(-1));
    const line = [...plausible].sort((left, right) =>
        numericFieldScore(right.text) - numericFieldScore(left.text) || right.center - left.center)[0];
    return lineValueBounds(image, line);
}

/** @param {{words:unknown}} block @param {any} bounds @param {string} text @param {any} dependencies */
function replaceFieldLine(block, bounds, text, dependencies) {
    const wordKey = (/** @type {any} */ word) =>
        `${word.text}\0${word.x}\0${word.y}\0${word.width}\0${word.height}`;
    const targetWords = new Set(bounds.line.words.map(wordKey));
    const replacement = Object.freeze({ text, x: bounds.line.x, y: bounds.line.y,
        width: bounds.line.width, height: bounds.line.height, confidence: null });
    const words = Object.freeze([
        ...Layout.normalizeWords(block.words).filter(word => !targetWords.has(wordKey(word))), replacement
    ]);
    return Object.freeze({ words, parsed: parseCinfoWords(words, dependencies.cinfoOptions) });
}

/** @param {any} image @param {any} bounds @param {Function} recognize @param {any} ocrOptions
 * @param {any} dependencies @param {any} JimpImpl @param {string} preprocessName @param {any} recognizeOptions */
async function readIsolatedField(image, bounds, recognize, ocrOptions, dependencies, JimpImpl,
    preprocessName, recognizeOptions) {
    const crop = image.clone().crop(bounds.left, bounds.top, bounds.width, bounds.height);
    const cropBuffer = await crop.getBufferAsync(JimpImpl.MIME_PNG || Jimp.MIME_PNG);
    const preprocess = dependencies[preprocessName] || OcrImagePreprocess.createTextMask;
    const processed = await preprocess(cropBuffer.toString('base64'), {
        JimpImpl, scale: 4, minForegroundRatio: 0.001, maxForegroundRatio: 0.85
    });
    const words = await recognize(processed.imageBase64, {
        ...ocrOptions, psm: 7, timeoutMs: Math.min(20000, Number(ocrOptions.timeoutMs) || 20000),
        ...recognizeOptions
    });
    return Layout.cleanText(Array.isArray(words) ? words.map(word => `${word.text || ''}`).join(' ') : '');
}

/** @param {any} image @param {any} block @param {Function} recognize @param {any} ocrOptions
 * @param {any} dependencies @param {any} JimpImpl */
async function refineMissingFields(image, block, recognize, ocrOptions, dependencies, JimpImpl) {
    let selected = block;
    const tagLooksPolluted = /\s/u.test(`${selected.parsed.tag || ''}`);
    if (tagLooksPolluted && (!Number.isSafeInteger(selected.parsed.declaredCount) ||
        !selected.parsed.establishedAtUtc)) {
        const bounds = tagValueBounds(image, selected);
        if (bounds) {
            const raw = await readIsolatedField(image, bounds, recognize, ocrOptions, dependencies, JimpImpl,
                'preprocessTagImage', {});
            const tag = Layout.cleanText(raw.replace(/^clan\s*tag\s*:\s*/iu, ''));
            if (tag && tag.length <= 32 && !/^(?:members?|established)\s*:/iu.test(tag)) {
                selected = replaceFieldLine(selected, bounds, `ClanTag: ${tag}`, dependencies);
            }
        }
    }
    if (!Number.isSafeInteger(selected.parsed.declaredCount)) {
        const bounds = missingCountBounds(image, selected);
        if (bounds) {
            const raw = await readIsolatedField(image, bounds, recognize, ocrOptions, dependencies, JimpImpl,
                'preprocessCountImage', { userWords: [], characterWhitelist: '0123456789' });
            const matches = raw.match(/\d{1,4}/gu) || [];
            const count = matches.length === 1 ? Number(matches[0]) : null;
            if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 1 && count <= 1000) {
                selected = replaceFieldLine(selected, bounds, `Members: ${count}`, dependencies);
            }
        }
    }
    if (!selected.parsed.establishedAtUtc &&
        !Layout.groupLines(selected.words).some(line => /established\s*:/iu.test(line.text))) {
        const bounds = missingEstablishedBounds(image, selected);
        if (bounds) {
            const raw = await readIsolatedField(image, bounds, recognize, ocrOptions, dependencies, JimpImpl,
                'preprocessDateImage', { userWords: [], characterWhitelist: '0123456789/: ' });
            const match = /(\d{2}\/\d{2}\/\d{4})\s*(\d{2}:\d{2}:\d{2})/u.exec(raw);
            const establishedRaw = match ? `${match[1]} ${match[2]}` : '';
            if (parseEstablished(establishedRaw)) {
                selected = replaceFieldLine(selected, bounds, `Established: ${establishedRaw}`, dependencies);
            }
        }
    }
    return selected;
}

/** @param {any} image @param {{words:unknown}} block */
function rosterBounds(image, block) {
    const lines = Layout.groupLines(block.words);
    const start = lines.findIndex(line => /clan\s+members\s*:/iu.test(line.text));
    const end = lines.findIndex(line => /established\s*:/iu.test(line.text));
    if (start === -1 || end <= start) return null;
    const relevant = lines.slice(start, end);
    const typicalHeight = Math.max(1, Layout.median(relevant.map(line => line.height)));
    const left = Math.max(0, Math.floor(Math.min(...relevant.map(line => line.x)) - typicalHeight * 0.5));
    const top = Math.max(0, Math.floor(relevant[0].y - typicalHeight * 0.4));
    const recognizedRight = Math.max(...relevant.map(line => line.x + line.width));
    const right = Math.min(image.bitmap.width, Math.ceil(recognizedRight + typicalHeight * 3));
    const last = relevant.at(-1);
    if (!last) return null;
    const bottom = Math.min(image.bitmap.height, Math.ceil(last.y + last.height + typicalHeight * 0.4));
    if (right - left < typicalHeight * 3 || bottom <= top) return null;
    return Object.freeze({
        left, top, width: right - left, height: bottom - top,
        words: Object.freeze(relevant.flatMap(line => line.words))
    });
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

/** @param {unknown} value */
function alphanumericName(value) {
    return Layout.cleanText(value).normalize('NFKC').toLocaleLowerCase('en')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

/** @param {any} image @param {any} word */
function commaSeparatorBounds(image, word) {
    const text = `${word.text || ''}`;
    const units = Array.from(text);
    const commaIndex = units.indexOf(',');
    if (commaIndex === -1) return null;
    const left = Math.max(0, Math.floor(word.x));
    const right = Math.min(image.bitmap.width, Math.ceil(word.x + word.width));
    const top = Math.max(0, Math.floor(word.y));
    const bottom = Math.min(image.bitmap.height, Math.ceil(word.y + word.height));
    if (right <= left || bottom <= top) return null;
    if (units.length === 1) return Object.freeze({ left, right });
    const active = [];
    for (let x = left; x < right; x += 1) {
        let foreground = false;
        for (let y = top; y < bottom && !foreground; y += 1) {
            const { r, g, b, a } = Jimp.intToRGBA(image.getPixelColor(x, y));
            foreground = OcrImagePreprocess.isRustUiTextPixel(r, g, b, a);
        }
        active.push(foreground);
    }
    const runs = [];
    let start = -1;
    for (let index = 0; index <= active.length; index += 1) {
        if (active[index] === true && start === -1) start = index;
        if (active[index] !== true && start !== -1) {
            runs.push({ left: left + start, right: left + index });
            start = -1;
        }
    }
    if (commaIndex === units.length - 1 && runs.length >= 2) return Object.freeze(runs.at(-1));
    const fallbackLeft = word.x + word.width * commaIndex / units.length;
    const fallbackRight = word.x + word.width * (commaIndex + 1) / units.length;
    return Object.freeze({ left: fallbackLeft, right: fallbackRight });
}

/** @param {any} image @param {any} block */
function rosterMemberFragments(image, block) {
    const count = block.parsed && block.parsed.declaredCount;
    if (!block.parsed || !block.parsed.complete || !Number.isSafeInteger(count) || count < 1 ||
        count > MAX_ISOLATED_ROSTER_MEMBERS) return null;
    const lines = Layout.groupLines(block.words);
    const start = lines.findIndex(line => /clan\s+members\s*:/iu.test(line.text));
    const end = lines.findIndex(line => /established\s*:/iu.test(line.text));
    if (start === -1 || end <= start) return null;
    const rosterLines = lines.slice(start, end);
    const members = [];
    /** @type {{x:number,y:number,width:number,height:number}[]} */
    let current = [];
    for (let lineIndex = 0; lineIndex < rosterLines.length; lineIndex += 1) {
        const line = rosterLines[lineIndex];
        const words = [...line.words].sort((left, right) => left.x - right.x);
        let cursor = line.x;
        if (lineIndex === 0) {
            const anchorIndex = words.findIndex(word => /^members:?$/iu.test(word.text));
            if (anchorIndex === -1) return null;
            cursor = words[anchorIndex].x + words[anchorIndex].width;
        }
        const separators = [];
        for (const word of words) {
            if (word.x + word.width <= cursor) continue;
            const commaCount = ([...word.text].filter(character => character === ',')).length;
            if (commaCount > 1) return null;
            if (commaCount === 1) {
                const separator = commaSeparatorBounds(image, word);
                if (!separator) return null;
                separators.push({ kind: 'comma', ...separator });
            }
            else if (/^and$/iu.test(word.text)) {
                separators.push({ kind: 'and', left: word.x, right: word.x + word.width });
            }
        }
        separators.sort((left, right) => left.left - right.left);
        const lineRight = Math.min(image.bitmap.width,
            Math.ceil(Math.max(...words.map(word => word.x + word.width))));
        const top = Math.max(0, Math.floor(line.y));
        const bottom = Math.min(image.bitmap.height, Math.ceil(line.y + line.height));
        const append = (/** @type {number} */ right) => {
            const left = Math.max(0, Math.floor(cursor));
            const boundedRight = Math.min(image.bitmap.width, Math.ceil(right));
            if (boundedRight - left >= 2 && bottom > top) {
                current.push(Object.freeze({ x: left, y: top, width: boundedRight - left,
                    height: bottom - top }));
            }
        };
        for (const separator of separators) {
            if (separator.left <= cursor) continue;
            append(separator.left);
            if (current.length === 0) return null;
            members.push(Object.freeze(current));
            current = [];
            cursor = separator.right;
        }
        append(lineRight);
    }
    if (current.length > 0) members.push(Object.freeze(current));
    return members.length === count ? Object.freeze(members) : null;
}

/** @param {any} image @param {readonly (readonly any[])[]} fragments @param {any} JimpImpl */
async function createIsolatedRosterSheet(image, fragments, JimpImpl) {
    const typicalHeight = Math.max(1, Math.ceil(Layout.median(fragments.flat()
        .map(fragment => fragment.height))));
    const horizontalGap = Math.max(2, Math.ceil(typicalHeight * 0.5));
    const padding = Math.max(2, Math.ceil(typicalHeight * 0.5));
    const rowHeight = typicalHeight + padding * 2;
    const contentWidths = fragments.map(member => member.reduce((sum, fragment) =>
        sum + fragment.width, 0) + Math.max(0, member.length - 1) * horizontalGap);
    const width = Math.max(...contentWidths) + padding * 2;
    const height = rowHeight * fragments.length;
    const scale = 4;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width * scale * height * scale > MAX_ISOLATED_SHEET_PIXELS) {
        throw new Error('Isolated roster sheet exceeds the pixel limit.');
    }
    const sheet = await new Promise((resolve, reject) => {
        new JimpImpl(width, height, 0xffffffff, (/** @type {any} */ error, /** @type {any} */ value) =>
            error ? reject(error) : resolve(value));
    });
    for (let memberIndex = 0; memberIndex < fragments.length; memberIndex += 1) {
        let targetX = padding;
        const targetY = memberIndex * rowHeight + padding;
        for (const fragment of fragments[memberIndex]) {
            for (let y = 0; y < fragment.height; y += 1) {
                for (let x = 0; x < fragment.width; x += 1) {
                    const sourceX = fragment.x + x;
                    const sourceY = fragment.y + y;
                    const { r, g, b, a } = JimpImpl.intToRGBA(image.getPixelColor(sourceX, sourceY));
                    if (OcrImagePreprocess.isRustUiTextPixel(r, g, b, a)) {
                        sheet.setPixelColor(0x000000ff, targetX + x, targetY + y);
                    }
                }
            }
            targetX += fragment.width + horizontalGap;
        }
    }
    sheet.resize(width * scale, height * scale, JimpImpl.RESIZE_NEAREST_NEIGHBOR);
    const buffer = await sheet.getBufferAsync(JimpImpl.MIME_PNG || Jimp.MIME_PNG);
    return Object.freeze({ imageBase64: buffer.toString('base64'), scale, rowHeight });
}

/** @param {unknown} value */
function cleanIsolatedMember(value) {
    return Layout.cleanText(value).replace(/^\s*,+\s*|\s*,+\s*$/gu, '');
}

/** @param {readonly any[]} words @param {{scale:number,rowHeight:number}} sheet @param {number} count */
function isolatedMemberNames(words, sheet, count) {
    const names = Array(count).fill(null);
    for (const line of Layout.groupLines(words)) {
        const center = line.y + line.height / 2;
        const index = Math.floor(center / (sheet.rowHeight * sheet.scale));
        const name = cleanIsolatedMember(line.text);
        if (!Number.isSafeInteger(index) || index < 0 || index >= count || !name || names[index] !== null) {
            return null;
        }
        names[index] = name;
    }
    return names.every(Boolean) ? Object.freeze(names) : null;
}

/** @param {any} image @param {any} block @param {Function} recognize @param {any} ocrOptions
 * @param {any} dependencies @param {any} JimpImpl */
async function refineRosterMembers(image, block, recognize, ocrOptions, dependencies, JimpImpl) {
    const fragments = rosterMemberFragments(image, block);
    if (!fragments) return block;
    const sheet = await createIsolatedRosterSheet(image, fragments, JimpImpl);
    const timeoutMs = Number.isFinite(Number(dependencies.rosterOcrTimeoutMs)) ?
        Math.min(30000, Math.max(1000, Number(dependencies.rosterOcrTimeoutMs))) :
        Math.min(30000, Number(ocrOptions.timeoutMs) || 30000);
    const words = await recognize(sheet.imageBase64, { ...ocrOptions, psm: 6, timeoutMs });
    const readNames = isolatedMemberNames(words, sheet, block.parsed.members.length);
    if (!readNames) return block;
    const confirmedUserWords = Array.isArray(ocrOptions.confirmedUserWords) ? ocrOptions.confirmedUserWords : [];
    const names = readNames.map((name, index) => OcrCorrectionMemory.confirmedNameHint(name,
        confirmedUserWords) || OcrCorrectionMemory.confirmedNameHint(block.parsed.members[index].name,
        confirmedUserWords) || name);
    if (names.some(name => !name || name.length > 128) ||
        new Set(names.map(name => name.normalize('NFKC').toLocaleLowerCase('en'))).size !== names.length) return block;
    const sameBaseNames = names.every((name, index) => alphanumericName(name) ===
        alphanumericName(block.parsed.members[index].name) ||
        OcrCorrectionMemory.confirmedNameHint(block.parsed.members[index].name, confirmedUserWords) === name);
    if (!sameBaseNames) return block;
    const members = Object.freeze(names.map((name, index) => Object.freeze({
        ...block.parsed.members[index],
        name
    })));
    return Object.freeze({
        ...block,
        memberBoxes: fragments,
        parsed: Object.freeze({ ...block.parsed, members })
    });
}

/** @param {any} image @param {any} block @param {Function} recognize @param {any} ocrOptions
 * @param {any} dependencies @param {any} JimpImpl */
async function refineIncompleteRoster(image, block, recognize, ocrOptions, dependencies, JimpImpl) {
    if (block.parsed.complete) return block;
    const bounds = rosterBounds(image, block);
    if (!bounds) return block;
    const crop = image.clone().crop(bounds.left, bounds.top, bounds.width, bounds.height);
    const cropBuffer = await crop.getBufferAsync(JimpImpl.MIME_PNG || Jimp.MIME_PNG);
    const preprocess = dependencies.preprocessRosterImage || OcrImagePreprocess.createTextMask;
    const processed = await preprocess(cropBuffer.toString('base64'), {
        JimpImpl,
        scale: 4,
        minForegroundRatio: 0.001,
        maxForegroundRatio: 0.75
    });
    const timeoutMs = Number.isFinite(Number(dependencies.rosterOcrTimeoutMs)) ?
        Math.min(30000, Math.max(1000, Number(dependencies.rosterOcrTimeoutMs))) :
        Math.min(30000, Number(ocrOptions.timeoutMs) || 30000);
    const replacement = mapCropWords(await recognize(processed.imageBase64, {
        ...ocrOptions,
        psm: 6,
        timeoutMs
    }), processed.scale, bounds);
    if (!Layout.groupLines(replacement).some(line => /clan\s+members\s*:/iu.test(line.text))) return block;
    const wordKey = (/** @type {any} */ word) => `${word.text}\0${word.x}\0${word.y}\0${word.width}\0${word.height}`;
    const targets = new Set(bounds.words.map(wordKey));
    const candidateWords = Object.freeze([
        ...Layout.normalizeWords(block.words).filter(word => !targets.has(wordKey(word))),
        ...replacement
    ]);
    const candidate = Object.freeze({
        words: candidateWords,
        parsed: parseCinfoWords(candidateWords, dependencies.cinfoOptions)
    });
    return samePanel(block, candidate) && blockQuality(candidate) > blockQuality(block) ? candidate : block;
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
 * Runs bounded semantic OCR inputs for incomplete panels, dates and complete roster rows.
 * Each input is derived from one semantic field; none is a retry of the full screenshot.
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
    let rosterSkipped = 0;
    const reasons = [];
    const rosterReasons = [];
    for (const block of blocks) {
        try {
            let selected = await refineMissingFields(image, block, recognize, ocrOptions, dependencies, JimpImpl);
            if (!block.parsed.complete || !block.parsed.establishedAtUtc) {
                const bounds = panelBounds(image, block);
                if (!bounds) {
                    if (!selected.parsed.complete || !selected.parsed.establishedAtUtc) {
                        refined.push(selected);
                        failed += 1;
                        reasons.push('semantic panel bounds unavailable');
                        continue;
                    }
                }
                if (bounds && (!selected.parsed.complete || !selected.parsed.establishedAtUtc)) {
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
                    if (candidate && samePanel(selected, candidate) &&
                        blockQuality(candidate) > blockQuality(selected)) selected = candidate;
                }
                selected = await refineEstablished(image, selected, recognize, ocrOptions, dependencies, JimpImpl);
            }
            try {
                selected = await refineIncompleteRoster(image, selected, recognize, ocrOptions,
                    dependencies, JimpImpl);
                selected = await refineRosterMembers(image, selected, recognize, ocrOptions, dependencies, JimpImpl);
            }
            catch (error) {
                rosterSkipped += 1;
                rosterReasons.push(`${error instanceof Error ? error.message : error}`
                    .replace(/\s+/gu, ' ').slice(0, 160));
            }
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
        warning: [
            failed > 0 ? `${failed}/${blocks.length} panels remain structurally incomplete; ${
                [...new Set(reasons)].slice(0, 2).join('; ')}.` : null,
            rosterSkipped > 0 ? `${rosterSkipped}/${blocks.length} isolated roster reads skipped; ${
                [...new Set(rosterReasons)].slice(0, 2).join('; ')}.` : null
        ].filter(Boolean).join(' ') || null
    });
}

module.exports = Object.freeze({
    MAX_ISOLATED_ROSTER_MEMBERS,
    MAX_ISOLATED_SHEET_PIXELS,
    blockQuality,
    createIsolatedRosterSheet,
    establishedBounds,
    lineValueBounds,
    mapCropWords,
    missingCountBounds,
    missingEstablishedBounds,
    panelBounds,
    refineCinfoPanels,
    refineEstablished,
    refineIncompleteRoster,
    refineMissingFields,
    refineRosterMembers,
    isolatedMemberNames,
    rosterBounds,
    rosterMemberFragments,
    commaSeparatorBounds,
    samePanel,
    tagValueBounds
});
