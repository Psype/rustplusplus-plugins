// @ts-check
const Jimp = require('jimp');

const DEFAULT_MAX_PIXELS = 8 * 1024 * 1024;
const DEFAULT_SCALE = 3;

/**
 * Rust UI text is either bright neutral, yellow/orange, green or cyan/blue.
 * The thresholds intentionally exclude the common dark/brown world background.
 * @param {number} r @param {number} g @param {number} b @param {number} [a]
 */
function isRustUiTextPixel(r, g, b, a = 255) {
    if (a < 96) return false;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const neutral = maximum >= 145 && minimum >= maximum * 0.62;
    const yellow = r >= 155 && g >= 115 && r > b * 1.3 && g > b * 1.2;
    const green = g >= 95 && g > r * 1.16 && g > b * 1.12;
    const cyan = g >= 90 && b >= 105 && Math.max(g, b) > r * 1.28;
    return neutral || yellow || green || cyan;
}

/**
 * F7 SteamID64 text is deliberately dimmer than normal Rust UI labels.
 * Keep this relaxed neutral threshold isolated from cinfo/name preprocessing.
 * @param {number} r @param {number} g @param {number} b @param {number} [a]
 */
function isRustF7TextPixel(r, g, b, a = 255) {
    if (isRustUiTextPixel(r, g, b, a)) return true;
    if (a < 96) return false;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    return maximum >= 105 && maximum - minimum <= 38 && minimum >= maximum * 0.72;
}

/** @param {unknown} value @param {string} label */
function positiveInteger(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer.`);
    return number;
}

/**
 * Produces one deterministic high-contrast variant. This is an independent OCR input,
 * not a retry of the same image.
 * @param {string} imageBase64
 * @param {{JimpImpl?:any,maxPixels?:number,scale?:number,minForegroundRatio?:number,
 * maxForegroundRatio?:number,pixelMode?:'default'|'f7'}} [options]
 */
async function createTextMask(imageBase64, options = {}) {
    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
        throw new TypeError('OCR preprocessing requires a non-empty base64 image.');
    }
    const JimpImpl = options.JimpImpl || Jimp;
    const image = await JimpImpl.read(Buffer.from(imageBase64, 'base64'));
    const width = positiveInteger(image.bitmap && image.bitmap.width, 'Image width');
    const height = positiveInteger(image.bitmap && image.bitmap.height, 'Image height');
    const maxPixels = positiveInteger(options.maxPixels || DEFAULT_MAX_PIXELS, 'OCR preprocessing pixel limit');
    const requestedScale = Math.min(4, positiveInteger(options.scale || DEFAULT_SCALE, 'OCR preprocessing scale'));
    const scale = Math.max(1, Math.min(requestedScale, Math.floor(Math.sqrt(maxPixels / (width * height)))));
    if (width * height * scale * scale > maxPixels) {
        throw new Error('OCR preprocessing image exceeds the pixel limit.');
    }

    const mask = await new Promise((resolve, reject) => {
        // The callback form works across the supported Jimp 0.22 releases.
        new JimpImpl(width, height, 0xffffffff, (/** @type {any} */ error, /** @type {any} */ value) =>
            error ? reject(error) : resolve(value));
    });
    let foreground = 0;
    const pixelPredicate = options.pixelMode === 'f7' ? isRustF7TextPixel : isRustUiTextPixel;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const { r, g, b, a } = JimpImpl.intToRGBA(image.getPixelColor(x, y));
            if (!pixelPredicate(r, g, b, a)) continue;
            mask.setPixelColor(0x000000ff, x, y);
            foreground += 1;
        }
    }
    const ratio = foreground / (width * height);
    const minimum = options.minForegroundRatio === undefined ? 0.001 : Number(options.minForegroundRatio);
    const maximum = options.maxForegroundRatio === undefined ? 0.35 : Number(options.maxForegroundRatio);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum <= minimum || maximum > 1) {
        throw new TypeError('OCR preprocessing foreground ratios are invalid.');
    }
    if (ratio < minimum || ratio > maximum) {
        throw new Error(`OCR text mask foreground ratio ${ratio.toFixed(4)} is outside safe bounds.`);
    }
    if (scale > 1) {
        mask.resize(width * scale, height * scale, JimpImpl.RESIZE_NEAREST_NEIGHBOR);
    }
    const output = await mask.getBufferAsync(JimpImpl.MIME_PNG);
    return Object.freeze({
        imageBase64: output.toString('base64'),
        width: width * scale,
        height: height * scale,
        scale,
        foregroundRatio: ratio
    });
}

/** @param {string} imageBase64 @param {any} [options] */
function createF7TextMask(imageBase64, options = {}) {
    return createTextMask(imageBase64, { ...options, pixelMode: 'f7', maxForegroundRatio:
        options.maxForegroundRatio === undefined ? 0.55 : options.maxForegroundRatio });
}

module.exports = Object.freeze({
    DEFAULT_MAX_PIXELS,
    DEFAULT_SCALE,
    createF7TextMask,
    createTextMask,
    isRustF7TextPixel,
    isRustUiTextPixel
});
