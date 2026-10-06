// @ts-check
const Layout = require('./ocrLayout.js');
const { parseF7Words } = require('./parseF7.js');
const { hasEstablishedAnchor } = require('./parseCinfo.js');

/** @param {unknown} inputWords @returns {'cinfo'|'f7'} */
function detectImportKind(inputWords) {
    const words = Layout.normalizeWords(inputWords);
    const text = Layout.groupLines(words).map(line => line.text).join('\n')
        .normalize('NFKC').toLocaleLowerCase('en');
    const cinfo = /clan\s*tag\s*:/iu.test(text) &&
        (/clan\s+members\s*:/iu.test(text) || hasEstablishedAnchor(text));
    const f7 = /find\s+player/iu.test(text) || parseF7Words(words, { requireAnchor: false }).entries.length > 0;
    if (cinfo && f7) throw new Error('Image contains both cinfo and F7 signatures; split it before import.');
    if (cinfo) return 'cinfo';
    if (f7) return 'f7';
    throw new Error('Unable to detect cinfo or F7 from OCR anchors.');
}

module.exports = Object.freeze({ detectImportKind });
