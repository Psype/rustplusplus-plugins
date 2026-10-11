const TesseractOcr = require('../plugins/playerIntelligence/tesseractOcr.js');

function safeError(error) {
    const message = error instanceof Error ? error.message : `${error || 'OCR failed'}`;
    return message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300);
}

function reply(message) {
    if (typeof process.send !== 'function' || !process.connected) return;
    try { process.send(message); }
    catch (_error) { /* The supervisor observes disconnect/exit. */ }
}

function optionsFrom(payload) {
    const source = payload && payload.options && typeof payload.options === 'object' ? payload.options : {};
    return {
        executable: typeof source.executable === 'string' ? source.executable : undefined,
        language: typeof source.language === 'string' ? source.language : undefined,
        psm: Number.isInteger(source.psm) ? source.psm : undefined,
        timeoutMs: Number.isInteger(source.timeoutMs) ? source.timeoutMs : undefined,
        userWords: Array.isArray(source.userWords) ? source.userWords : [],
        characterWhitelist: typeof source.characterWhitelist === 'string' ? source.characterWhitelist : undefined
    };
}

async function handle(message) {
    if (!message || typeof message !== 'object' || message.v !== 1) return;
    if (message.type === 'shutdown') {
        process.disconnect();
        return;
    }
    if (message.type !== 'request' || !Number.isSafeInteger(message.id) || message.method !== 'recognize') return;
    try {
        const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
        const result = await TesseractOcr.recognize(payload.imageBase64, optionsFrom(payload));
        reply({ v: 1, type: 'response', id: message.id, ok: true, result });
    }
    catch (error) {
        reply({
            v: 1,
            type: 'response',
            id: message.id,
            ok: false,
            error: { code: `${error && error.code || 'OCR_FAILED'}`.slice(0, 64), message: safeError(error) }
        });
    }
}

process.on('message', message => { void handle(message); });
process.on('disconnect', () => { process.exitCode = 0; });
