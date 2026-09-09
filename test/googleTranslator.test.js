const Assert = require('node:assert/strict');
const Test = require('node:test');

const GoogleTranslator = require('../src/plugins/autoTranslate/googleTranslator.js');

Test('parses and joins translated Google response segments', async () => {
    const calls = [];
    const httpClient = {
        get: async (url, options) => {
            calls.push({ url, options });
            return { data: [[['Le bot ', 'The bot '], ['fonctionne', 'works']]] };
        }
    };

    const result = await GoogleTranslator('The bot works', { from: 'en', to: 'fr' }, { httpClient });

    Assert.equal(result, 'Le bot fonctionne');
    Assert.equal(calls.length, 1);
    Assert.equal(calls[0].options.params.sl, 'en');
    Assert.equal(calls[0].options.params.tl, 'fr');
    Assert.equal(calls[0].options.params.q, 'The bot works');
    Assert.equal(calls[0].options.timeout, 10000);
});

Test('rejects malformed translation responses', async () => {
    const httpClient = { get: async () => ({ data: { error: 'not json segments' } }) };

    await Assert.rejects(
        () => GoogleTranslator('hello', { from: 'en', to: 'zh' }, { httpClient }),
        /did not contain translated text/
    );
});

Test('validates translation inputs before the HTTP request', async () => {
    const httpClient = { get: async () => { throw new Error('must not run'); } };

    await Assert.rejects(() => GoogleTranslator('', { from: 'en', to: 'zh' }, { httpClient }), /non-empty/);
    await Assert.rejects(() => GoogleTranslator('hello', { from: 'english', to: 'zh' }, { httpClient }),
        /ISO language codes/);
});
