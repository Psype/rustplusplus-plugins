// @ts-check
const Jimp = require('jimp');

const Layout = require('./ocrLayout.js');

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
    const end = lines.findIndex(line => /established\s*:/iu.test(line.text));
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

/** @param {any} image @param {readonly {x:number,y:number,width:number,height:number}[]} boxes @param {any} JimpImpl */
function colorVotes(image, boxes, JimpImpl) {
    let blue = 0;
    let yellow = 0;
    for (const box of boxes) {
        const step = Math.max(1, Math.floor(Math.sqrt(box.width * box.height / 1200)));
        const right = Math.min(image.bitmap.width, Math.ceil(box.x + box.width));
        const bottom = Math.min(image.bitmap.height, Math.ceil(box.y + box.height));
        for (let y = Math.max(0, Math.floor(box.y)); y < bottom; y += step) {
            for (let x = Math.max(0, Math.floor(box.x)); x < right; x += step) {
                const { r, g, b, a } = JimpImpl.intToRGBA(image.getPixelColor(x, y));
                if (a < 128 || Math.max(r, g, b) < 90) continue;
                if (b > r * 1.25 && b > g * 1.05) blue += 1;
                else if (r > b * 1.35 && g > b * 1.25 && Math.abs(r - g) < Math.max(r, g) * 0.45) {
                    yellow += 1;
                }
            }
        }
    }
    if (blue >= 3 && blue > yellow * 1.5) return 'moderator';
    if (yellow >= 3 && yellow > blue * 1.5) return 'leader';
    return 'member';
}

/** @param {any} image @param {readonly {words:unknown,parsed:any}[]} blocks @param {any} JimpImpl */
function inferFromImage(image, blocks, JimpImpl) {
    return Object.freeze(blocks.map(block => {
        if (!block.parsed || block.parsed.kind !== 'cinfo' || !Array.isArray(block.parsed.members)) {
            return Object.freeze([]);
        }
        const candidates = rosterWords(block.words);
        return Object.freeze(block.parsed.members.map((/** @type {any} */ member) => Object.freeze({
            name: member.name,
            role: colorVotes(image, findMemberBoxes(candidates, member.name), JimpImpl)
        })));
    }));
}

/** @param {string} imageBase64 @param {readonly {words:unknown,parsed:any}[]} blocks
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
    findMemberBoxes,
    inferCinfoRoleHints,
    inferCinfoRoleHintsBatch,
    inferFromImage
});
