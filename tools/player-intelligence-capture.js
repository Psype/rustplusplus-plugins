// @ts-check
'use strict';

const ChildProcess = require('node:child_process');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

const MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBHOOK_HOSTS = Object.freeze(new Set(['discord.com', 'ptb.discord.com', 'canary.discord.com']));

/** @param {unknown} value @returns {'auto'|'cinfo'|'f7'} */
function parseKind(value) {
    const kind = `${value || 'auto'}`.trim().toLowerCase();
    if (!['auto', 'cinfo', 'f7'].includes(kind)) throw new Error('Capture type must be auto, cinfo or f7.');
    return /** @type {'auto'|'cinfo'|'f7'} */ (kind);
}

/** @param {unknown} value */
function validateWebhookUrl(value) {
    const url = new URL(`${value || ''}`);
    const match = url.pathname.match(/^\/api(?:\/v\d+)?\/webhooks\/(\d{17,20})\/([A-Za-z0-9._-]+)$/);
    if (url.protocol !== 'https:' || !WEBHOOK_HOSTS.has(url.hostname) || !match || url.username || url.password ||
        url.search || url.hash) throw new Error('RPP_INTEL_DISCORD_WEBHOOK_URL is not a valid Discord webhook URL.');
    return Object.freeze({ url: url.href, webhookId: match[1] });
}

/** @param {Buffer} image */
function validatePng(image) {
    if (!Buffer.isBuffer(image) || image.length <= PNG_SIGNATURE.length || image.length > MAX_BYTES ||
        !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error(`Captured PNG must be between 1 and ${MAX_BYTES} bytes.`);
    }
}

/**
 * @param {string} webhookUrl @param {'auto'|'cinfo'|'f7'} kind @param {Buffer} image
 * @param {Function} fetchImpl @param {number} timeoutMs
 */
async function upload(webhookUrl, kind, image, fetchImpl = global.fetch, timeoutMs = 10_000) {
    if (typeof fetchImpl !== 'function') throw new Error('Node fetch is unavailable.');
    validatePng(image);
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: kind, allowed_mentions: { parse: [] } }));
    form.append('files[0]', new Blob([image], { type: 'image/png' }), `${kind}-${Date.now()}.png`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(webhookUrl,
            { method: 'POST', body: form, redirect: 'error', signal: controller.signal });
        if (!response || response.ok !== true) {
            throw new Error(`Discord upload failed with HTTP ${response && response.status}.`);
        }
    }
    finally {
        clearTimeout(timeout);
    }
}

/** @param {string} outputPath */
function captureRegion(outputPath) {
    if (process.platform !== 'win32') throw new Error('The region capture helper runs only on Windows.');
    const script = Path.join(__dirname, 'capture-player-intelligence-region.ps1');
    ChildProcess.execFileSync('powershell.exe', [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputPath', outputPath
    ], { stdio: 'inherit', windowsHide: true });
}

async function main() {
    const kind = parseKind(process.argv[2]);
    const webhook = validateWebhookUrl(process.env.RPP_INTEL_DISCORD_WEBHOOK_URL);
    const temporaryDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-intel-capture-'));
    const outputPath = Path.join(temporaryDirectory, `${kind}.png`);
    try {
        captureRegion(outputPath);
        const image = Fs.readFileSync(outputPath);
        await upload(webhook.url, kind, image);
        process.stdout.write(`Uploaded ${kind} capture to approved webhook ${webhook.webhookId}.\n`);
    }
    finally {
        if (Fs.existsSync(outputPath)) Fs.unlinkSync(outputPath);
        if (Fs.existsSync(temporaryDirectory)) Fs.rmdirSync(temporaryDirectory);
    }
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
        process.exitCode = 1;
    });
}

module.exports = Object.freeze({ MAX_BYTES, parseKind, upload, validatePng, validateWebhookUrl });
