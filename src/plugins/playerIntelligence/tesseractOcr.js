// @ts-check
const ChildProcess = require('node:child_process');

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 45 * 1000;
let queue = Promise.resolve();

/** @typedef {{executable?:string,language?:string,psm?:number,spawnImpl?:Function,timeoutMs?:number,maxOutputBytes?:number}} OcrOptions */

/** @param {string} tsv */
function parseTsv(tsv) {
    if (typeof tsv !== 'string') throw new TypeError('Tesseract TSV output must be a string.');
    const words = [];
    const lines = tsv.split(/\r?\n/u);
    for (let index = 1; index < lines.length; index += 1) {
        if (!lines[index]) continue;
        const columns = lines[index].split('\t');
        if (columns.length < 12 || columns[0] !== '5') continue;
        const [x, y, width, height, confidence] = columns.slice(6, 11).map(Number);
        const text = columns.slice(11).join('\t').trim();
        if (!text || ![x, y, width, height, confidence].every(Number.isFinite) || confidence < 0) continue;
        words.push(Object.freeze({ text, x, y, width, height, confidence }));
    }
    return Object.freeze(words);
}

/** @param {string} imageBase64 @param {OcrOptions} options */
function recognizeOnce(imageBase64, options = {}) {
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
        throw new TypeError('OCR image must be a non-empty base64 string.');
    }
    const image = Buffer.from(imageBase64, 'base64');
    if (image.length === 0) throw new TypeError('OCR image is empty.');
    const executable = options.executable || process.env.RPP_TESSERACT_PATH || 'tesseract';
    const language = typeof options.language === 'string' && /^[a-z+_]+$/iu.test(options.language) ?
        options.language : 'eng';
    const requestedPsm = options.psm;
    const psm = typeof requestedPsm === 'number' && Number.isInteger(requestedPsm) &&
        requestedPsm >= 3 && requestedPsm <= 13 ? requestedPsm : 11;
    const spawnImpl = options.spawnImpl || ChildProcess.spawn;

    return new Promise((resolve, reject) => {
        const child = spawnImpl(executable,
            ['stdin', 'stdout', '-l', language, '--psm', `${psm}`, 'tsv'],
            { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        /** @type {Buffer[]} */
        const stdout = [];
        /** @type {Buffer[]} */
        const stderr = [];
        let stdoutLength = 0;
        let settled = false;
        /** @param {()=>void} callback */
        const finish = callback => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            callback();
        };
        const timeout = setTimeout(() => {
            child.kill();
            finish(() => reject(new Error('Tesseract OCR timed out.')));
        }, options.timeoutMs || TIMEOUT_MS);

        child.once('error', (/** @type {any} */ error) => finish(() => reject(new Error(
            `Tesseract OCR unavailable: ${error instanceof Error ? error.message : error}.`))));
        child.stdout.on('data', (/** @type {any} */ chunk) => {
            chunk = Buffer.from(chunk);
            stdoutLength += chunk.length;
            if (stdoutLength > (options.maxOutputBytes || MAX_OUTPUT_BYTES)) {
                child.kill();
                finish(() => reject(new Error('Tesseract OCR output exceeds the limit.')));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on('data', (/** @type {any} */ chunk) => {
            chunk = Buffer.from(chunk);
            if (Buffer.concat(stderr).length < 8192) stderr.push(chunk);
        });
        child.once('close', (/** @type {any} */ code) => finish(() => {
            if (code !== 0) {
                const detail = Buffer.concat(stderr).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 300);
                reject(new Error(`Tesseract OCR failed with code ${code}${detail ? `: ${detail}` : '.'}`));
                return;
            }
            try {
                resolve(parseTsv(Buffer.concat(stdout, stdoutLength).toString('utf8')));
            }
            catch (error) {
                reject(error);
            }
        }));
        child.stdin.once('error', (/** @type {any} */ error) => finish(() => reject(error)));
        child.stdin.end(image);
    });
}

/** @param {string} imageBase64 @param {OcrOptions} options */
function recognize(imageBase64, options = {}) {
    const task = queue.then(() => recognizeOnce(imageBase64, options));
    queue = task.catch(() => undefined);
    return task;
}

module.exports = Object.freeze({ parseTsv, recognize });
