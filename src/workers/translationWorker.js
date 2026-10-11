const Translate = require('../plugins/autoTranslate/translator.js');

function safeError(error) {
    const message = error instanceof Error ? error.message : `${error || 'translation failed'}`;
    return message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300);
}

function reply(message) {
    if (typeof process.send !== 'function' || !process.connected) return;
    try { process.send(message); }
    catch (_error) { /* The parent will observe disconnect/exit. */ }
}

async function handle(message) {
    if (!message || typeof message !== 'object' || message.v !== 1) return;
    if (message.type === 'shutdown') {
        process.disconnect();
        return;
    }
    if (message.type !== 'request' || !Number.isSafeInteger(message.id) || message.method !== 'translate') return;
    try {
        const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
        const result = await Translate(payload.text, payload.options);
        reply({ v: 1, type: 'response', id: message.id, ok: true, result });
    }
    catch (error) {
        const failures = error && Array.isArray(error.failures) ? error.failures.map(failure => ({
            provider: `${failure && failure.provider || 'unknown'}`.slice(0, 64),
            reason: `${failure && failure.reason || 'unknown error'}`.slice(0, 160)
        })) : undefined;
        reply({
            v: 1,
            type: 'response',
            id: message.id,
            ok: false,
            error: { code: 'TRANSLATION_FAILED', message: safeError(error), failures }
        });
    }
}

process.on('message', message => { void handle(message); });
process.on('disconnect', () => { process.exitCode = 0; });
