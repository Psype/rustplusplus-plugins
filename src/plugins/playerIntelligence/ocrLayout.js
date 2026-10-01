// @ts-check
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** @typedef {Readonly<{text:string,x:number,y:number,width:number,height:number,confidence:number|null}>} OcrWord */

/** @param {unknown} value */
function cleanText(value) {
    return `${value || ''}`.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {number[]} values */
function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** @param {unknown} word @returns {OcrWord|null} */
function validateWord(word) {
    if (!word || typeof word !== 'object') return null;
    const record = /** @type {Record<string, unknown>} */ (word);
    const text = cleanText(record.text);
    const x = Number(record.x);
    const y = Number(record.y);
    const width = Number(record.width);
    const height = Number(record.height);
    const confidence = Number(record.confidence);
    if (!text || ![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 ||
        width <= 0 || height <= 0) return null;
    return Object.freeze({
        text,
        x,
        y,
        width,
        height,
        confidence: Number.isFinite(confidence) ? confidence : null
    });
}

/** @param {unknown} words @returns {readonly OcrWord[]} */
function normalizeWords(words) {
    if (!Array.isArray(words)) throw new TypeError('OCR words must be an array.');
    return Object.freeze(words.map(validateWord).filter((word) => word !== null));
}

/** @param {unknown} inputWords */
function groupLines(inputWords) {
    const words = normalizeWords(inputWords);
    if (words.length === 0) return Object.freeze([]);
    const typicalHeight = Math.max(1, median(words.map(word => word.height)));
    const ordered = [...words].sort((left, right) => {
        const vertical = (left.y + left.height / 2) - (right.y + right.height / 2);
        return Math.abs(vertical) > typicalHeight * 0.35 ? vertical : left.x - right.x;
    });
    /** @type {{words: OcrWord[], center:number}[]} */
    const lines = [];
    for (const word of ordered) {
        const center = word.y + word.height / 2;
        let target = null;
        let distance = Infinity;
        for (const line of lines) {
            const candidateDistance = Math.abs(center - line.center);
            if (candidateDistance <= typicalHeight * 0.7 && candidateDistance < distance) {
                target = line;
                distance = candidateDistance;
            }
        }
        if (!target) {
            target = { words: [], center };
            lines.push(target);
        }
        target.words.push(word);
        target.center = target.words.reduce((sum, item) => sum + item.y + item.height / 2, 0) /
            target.words.length;
    }
    return Object.freeze(lines.sort((left, right) => left.center - right.center).map(line => {
        const lineWords = [...line.words].sort((left, right) => left.x - right.x);
        const x = Math.min(...lineWords.map(word => word.x));
        const right = Math.max(...lineWords.map(word => word.x + word.width));
        const y = Math.min(...lineWords.map(word => word.y));
        const bottom = Math.max(...lineWords.map(word => word.y + word.height));
        return Object.freeze({
            text: lineWords.map(word => word.text).join(' '),
            words: Object.freeze(lineWords),
            x,
            y,
            width: right - x,
            height: bottom - y,
            center: line.center
        });
    }));
}

/** @param {readonly OcrWord[]} words @param {number} typicalHeight */
function clusterWordsByGap(words, typicalHeight) {
    if (words.length === 0) return Object.freeze([]);
    const ordered = [...words].sort((left, right) => left.x - right.x);
    const clusters = [[ordered[0]]];
    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const gap = ordered[index].x - (previous.x + previous.width);
        if (gap > Math.max(1, typicalHeight) * 2.75) clusters.push([]);
        clusters[clusters.length - 1].push(ordered[index]);
    }
    return Object.freeze(clusters.map(cluster => Object.freeze(cluster)));
}

module.exports = Object.freeze({
    cleanText,
    clusterWordsByGap,
    groupLines,
    median,
    normalizeWords
});
