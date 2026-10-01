// @ts-check
const Crypto = require('node:crypto');

const Jimp = require('jimp');

const ALLOWED_HOSTS = Object.freeze(new Set(['cdn.discordapp.com', 'media.discordapp.net']));
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 20 * 1000 * 1000;
const TIMEOUT_MS = 10 * 1000;

/** @typedef {{maxBytes?:number,maxPixels?:number,timeoutMs?:number,fetchImpl?:Function,JimpImpl?:any}} ImageDependencies */

/** @param {unknown} attachment @param {ImageDependencies} options */
function validateMetadata(attachment, options = {}) {
    const maxBytes = options.maxBytes || MAX_BYTES;
    if (!attachment || typeof attachment !== 'object') throw new TypeError('Image attachment is required.');
    const record = /** @type {Record<string, any>} */ (attachment);
    const url = new URL(`${record.url || ''}`);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
        throw new Error('Image attachment must use the Discord CDN.');
    }
    const contentType = `${record.contentType || ''}`.split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg'].includes(contentType)) throw new Error('Only PNG and JPEG images are accepted.');
    const extension = (url.pathname.split('.').pop() || '').toLowerCase();
    if ((contentType === 'image/png' && extension !== 'png') ||
        (contentType === 'image/jpeg' && !['jpg', 'jpeg'].includes(extension))) {
        throw new Error('Image extension and content type do not match.');
    }
    if (!Number.isSafeInteger(record.size) || record.size <= 0 || record.size > maxBytes) {
        throw new Error(`Image size must be between 1 and ${maxBytes} bytes.`);
    }
    return Object.freeze({ url: url.href, contentType, declaredSize: Number(record.size) });
}

/** @param {Buffer} buffer */
function detectMime(buffer) {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    return null;
}

/** @param {any} response @param {number} maxBytes */
async function readLimitedBody(response, maxBytes) {
    const declared = Number(response.headers && response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Downloaded image exceeds the size limit.');
    if (!response.body || typeof response.body.getReader !== 'function') {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error('Downloaded image exceeds the size limit.');
        return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
            await reader.cancel();
            throw new Error('Downloaded image exceeds the size limit.');
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
}

/** @param {unknown} attachment @param {ImageDependencies} dependencies */
async function downloadImage(attachment, dependencies = {}) {
    const metadata = validateMetadata(attachment, dependencies);
    const fetchImpl = dependencies.fetchImpl || global.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('Image download is unavailable.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs || TIMEOUT_MS);
    let response;
    try {
        response = await fetchImpl(metadata.url, { signal: controller.signal, redirect: 'error' });
        if (!response || response.ok !== true) throw new Error(`Image download failed with HTTP ${response && response.status}.`);
        const buffer = await readLimitedBody(response, dependencies.maxBytes || MAX_BYTES);
        if (buffer.length !== metadata.declaredSize) throw new Error('Downloaded image length does not match Discord metadata.');
        const mime = detectMime(buffer);
        if (mime !== metadata.contentType) throw new Error('Image signature and content type do not match.');
        const JimpImpl = dependencies.JimpImpl || Jimp;
        const image = await JimpImpl.read(buffer);
        const width = image && image.bitmap && image.bitmap.width;
        const height = image && image.bitmap && image.bitmap.height;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
            width * height > (dependencies.maxPixels || MAX_PIXELS)) {
            throw new Error('Decoded image dimensions exceed the pixel limit.');
        }
        return Object.freeze({
            sha256: Crypto.createHash('sha256').update(buffer).digest('hex'),
            mime,
            width,
            height,
            imageBase64: buffer.toString('base64')
        });
    }
    finally {
        clearTimeout(timeout);
    }
}

module.exports = Object.freeze({
    ALLOWED_HOSTS,
    MAX_BYTES,
    MAX_PIXELS,
    detectMime,
    downloadImage,
    validateMetadata
});
