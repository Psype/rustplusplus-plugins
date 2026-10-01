const Assert = require('node:assert/strict');
const Test = require('node:test');

const Capture = require('../tools/player-intelligence-capture.js');

function png() {
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([1])]);
}

Test('Windows capture helper validates type, PNG and exact Discord webhook origin', () => {
    Assert.equal(Capture.parseKind(), 'auto');
    Assert.equal(Capture.parseKind('F7'), 'f7');
    Assert.throws(() => Capture.parseKind('other'), /auto, cinfo or f7/);
    Assert.equal(Capture.validateWebhookUrl(
        'https://discord.com/api/webhooks/12345678901234567/token_VALUE').webhookId,
    '12345678901234567');
    Assert.throws(() => Capture.validateWebhookUrl(
        'https://discord.com.evil.invalid/api/webhooks/12345678901234567/token'), /valid Discord webhook/);
    Assert.doesNotThrow(() => Capture.validatePng(png()));
    Assert.throws(() => Capture.validatePng(Buffer.from('not png')), /Captured PNG/);
});

Test('Windows capture helper uploads one classified image without retry', async () => {
    const calls = [];
    await Capture.upload('https://discord.com/api/webhooks/12345678901234567/token', 'cinfo', png(),
        async (url, options) => {
            calls.push({ url, options });
            return { ok: true, status: 204 };
        });
    Assert.equal(calls.length, 1);
    Assert.equal(calls[0].options.method, 'POST');
    Assert.equal(calls[0].options.redirect, 'error');
});
