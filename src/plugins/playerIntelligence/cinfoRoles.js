// @ts-check
const Jimp = require('jimp');

const Layout = require('./ocrLayout.js');
const { hasEstablishedAnchor } = require('./parseCinfo.js');

/** @typedef {Readonly<{text:string,x:number,y:number,width:number,height:number,confidence:number|null}>} OcrWord */

/** @param {unknown} value */
function token(value) {
    return Layout.cleanText(value).normalize('NFKC').toLocaleLowerCase('en')
        .replace(/^[,;:]+|[,;:]+$/gu, '');
}

/** @param {unknown} words @returns {readonly OcrWord[]} */
function rosterWords(words) {
    const lines = Layout.groupLines(words);
    const start = lines.findIndex(line => /clan\s+members\s*:/iu.test(line.text));
    const end = lines.findIndex(line => hasEstablishedAnchor(line.text));
    if (start === -1) return Object.freeze([]);
    const result = [];
    for (let index = start; index < (end > start ? end : lines.length); index += 1) {
        let lineWords = lines[index].words;
        if (index === start) {
            const anchor = lineWords.findIndex(word => /^members:?$/iu.test(word.text));
            if (anchor !== -1) lineWords = lineWords.slice(anchor + 1);
        }
        result.push(...lineWords);
    }
    return Object.freeze(result);
}

/** @param {readonly OcrWord[]} words @param {string} name */
function findMemberBoxes(words, name) {
    const expected = name.split(/\s+/u).map(token).filter(Boolean);
    if (expected.length === 0) return Object.freeze([]);
    for (let start = 0; start <= words.length - expected.length; start += 1) {
        const candidate = words.slice(start, start + expected.length);
        if (candidate.every((word, index) => token(word.text) === expected[index])) {
            return Object.freeze(candidate);
        }
    }
    return Object.freeze([]);
}

/** @param {readonly OcrWord[]} words @param {string} name @param {number} minimumStart */
function findMemberMatches(words, name, minimumStart) {
    const expected = name.split(/\s+/u).map(token).filter(Boolean);
    if (expected.length === 0) return Object.freeze([]);
    const matches = [];
    for (let start = minimumStart; start <= words.length - expected.length; start += 1) {
        const candidate = words.slice(start, start + expected.length);
        if (candidate.every((word, index) => token(word.text) === expected[index])) {
            matches.push(Object.freeze({ start, end: start + expected.length, boxes: Object.freeze(candidate) }));
        }
    }
    return Object.freeze(matches);
}

/**
 * Proves a one-to-one roster partition. A partial roster has no stable positional
 * indexes, and a repeated spelling is ambiguous, so both fail closed.
 * @param {readonly OcrWord[]} words @param {readonly string[]} names
 */
function findMemberBoxAssignments(words, names) {
    if (!Array.isArray(words) || !Array.isArray(names) || names.length === 0) return Object.freeze([]);
    const assignments = [];
    let cursor = 0;
    for (const name of names) {
        const matches = findMemberMatches(words, name, cursor);
        if (matches.length !== 1) return Object.freeze([]);
        const match = matches[0];
        assignments.push(match.boxes);
        cursor = match.end;
    }
    return Object.freeze(assignments);
}

/** @param {{r:number,g:number,b:number,a:number}} color */
function roleColor(color) {
    const { r, g, b, a } = color;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    if (a < 128 || maximum < 90) return null;
    const chroma = maximum - minimum;
    const saturation = maximum === 0 ? 0 : chroma / maximum;
    let hue = 0;
    if (chroma !== 0) {
        if (maximum === r) hue = 60 * (((g - b) / chroma) % 6);
        else if (maximum === g) hue = 60 * (((b - r) / chroma) + 2);
        else hue = 60 * (((r - g) / chroma) + 4);
        if (hue < 0) hue += 360;
    }

    if (saturation >= 0.38 && hue >= 175 && hue <= 245 && b > r * 1.15) return 'moderator';
    if (saturation >= 0.38 && hue >= 40 && hue <= 110 && g > b * 1.35) return 'leader';
    if (maximum >= 145 && saturation < 0.38) return 'member';
    return null;
}

/** @param {any} image @param {readonly {x:number,y:number,width:number,height:number}[]} boxes @param {any} JimpImpl */
function colorVotes(image, boxes, JimpImpl) {
    let blue = 0;
    let yellow = 0;
    let beige = 0;
    for (const box of boxes) {
        const step = Math.max(1, Math.floor(Math.sqrt(box.width * box.height / 1200)));
        const right = Math.min(image.bitmap.width, Math.ceil(box.x + box.width));
        const bottom = Math.min(image.bitmap.height, Math.ceil(box.y + box.height));
        for (let y = Math.max(0, Math.floor(box.y)); y < bottom; y += step) {
            for (let x = Math.max(0, Math.floor(box.x)); x < right; x += step) {
                const role = roleColor(JimpImpl.intToRGBA(image.getPixelColor(x, y)));
                if (role === 'moderator') blue += 1;
                else if (role === 'leader') yellow += 1;
                else if (role === 'member') beige += 1;
            }
        }
    }
    if (blue >= 3 && blue > yellow * 1.5 && blue > beige * 0.2) return 'moderator';
    if (yellow >= 3 && yellow > blue * 1.5 && yellow > beige * 0.2) return 'leader';
    if (beige >= 3) return 'member';
    return 'unknown';
}

/** @param {any} image
 * @param {readonly {words:unknown,parsed:any,memberBoxes?:readonly (readonly any[])[]}[]} blocks
 * @param {any} JimpImpl */
function inferFromImage(image, blocks, JimpImpl) {
    return Object.freeze(blocks.map(block => {
        if (!block.parsed || block.parsed.kind !== 'cinfo' || !Array.isArray(block.parsed.members)) {
            return Object.freeze([]);
        }
        const candidates = rosterWords(block.words);
        const names = block.parsed.members.map((/** @type {any} */ member) => member.name);
        const suppliedAssignments = Array.isArray(block.memberBoxes) &&
            block.memberBoxes.length === names.length ? block.memberBoxes : null;
        const assignments = suppliedAssignments || (block.parsed.complete ?
            findMemberBoxAssignments(candidates, names) : []);
        return Object.freeze(block.parsed.members.map((/** @type {any} */ member,
            /** @type {number} */ index) => Object.freeze({
            name: member.name,
            role: colorVotes(image, assignments[index] || [], JimpImpl)
        })));
    }));
}

/** @param {string} imageBase64
 * @param {readonly {words:unknown,parsed:any,memberBoxes?:readonly (readonly any[])[]}[]} blocks
 * @param {{JimpImpl?:any}} dependencies */
async function inferCinfoRoleHintsBatch(imageBase64, blocks, dependencies = {}) {
    const JimpImpl = dependencies.JimpImpl || Jimp;
    const image = await JimpImpl.read(Buffer.from(imageBase64, 'base64'));
    return inferFromImage(image, blocks, JimpImpl);
}

/** @param {string} imageBase64 @param {unknown} words @param {any} parsed
 * @param {{JimpImpl?:any}} dependencies */
async function inferCinfoRoleHints(imageBase64, words, parsed, dependencies = {}) {
    return (await inferCinfoRoleHintsBatch(imageBase64, [{ words, parsed }], dependencies))[0];
}

module.exports = Object.freeze({
    colorVotes,
    findMemberBoxAssignments,
    findMemberBoxes,
    inferCinfoRoleHints,
    inferCinfoRoleHintsBatch,
    inferFromImage,
    roleColor,
    rosterWords
});
