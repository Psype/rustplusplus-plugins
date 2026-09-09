const Assert = require('node:assert/strict');
const Test = require('node:test');

const Translator = require('../src/plugins/autoTranslate/translator.js');

Test('uses Google Web first with the production five-second deadline', async () => {
    const calls = [];
    const googleClient = async (text, options) => {
        calls.push({ text, options });
        return { text: 'Le bot fonctionne' };
    };

    const result = await Translator('The bot works', { from: 'EN', to: 'FR' }, { googleClient });

    Assert.deepEqual(result, { text: 'Le bot fonctionne', provider: 'google-web', failures: [] });
    Assert.equal(Object.isFrozen(result), true);
    Assert.equal(Object.isFrozen(result.failures), true);
    Assert.equal(calls.length, 1);
    Assert.equal(calls[0].options.from, 'en');
    Assert.equal(calls[0].options.to, 'fr');
    Assert.equal(calls[0].options.fetchOptions.timeout, 5000);
    Assert.equal(calls[0].options.fetchOptions.signal instanceof AbortSignal, true);
});

Test('uses DeepLX after Google and validates its request schema', async () => {
    const postCalls = [];
    const result = await Translator('test de traduction', { from: 'fr', to: 'zh' }, {
        googleClient: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); },
        httpClient: {
            post: async (url, payload, options) => {
                postCalls.push({ url, payload, options });
                return { data: { code: 200, data: '翻译测试', targetLang: 'ZH' } };
            }
        }
    });

    Assert.equal(result.provider, 'deeplx');
    Assert.deepEqual(result.failures, [{ provider: 'google-web', reason: 'HTTP 429' }]);
    Assert.equal(postCalls.length, 1);
    Assert.equal(postCalls[0].url, 'https://deeplx.1stg.me/translate');
    Assert.deepEqual(postCalls[0].payload, {
        text: 'test de traduction', source_lang: 'FR', target_lang: 'ZH'
    });
    Assert.equal(postCalls[0].options.timeout, 5000);
    Assert.equal(postCalls[0].options.signal instanceof AbortSignal, true);
});

Test('falls back from Google and DeepLX to Bing and maps Chinese for Bing', async () => {
    const googleError = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const bingCalls = [];
    const result = await Translator('the bot should work', { from: 'en', to: 'zh' }, {
        googleClient: async () => { throw googleError; },
        deepLxClient: async () => { throw new Error('offline'); },
        bingClient: async (text, options, execution) => {
            bingCalls.push({ text, options, execution });
            return '机器人应该工作';
        }
    });

    Assert.deepEqual(result, {
        text: '机器人应该工作',
        provider: 'bing-web',
        failures: [
            { provider: 'google-web', reason: 'HTTP 429' },
            { provider: 'deeplx', reason: 'offline' }
        ]
    });
    Assert.equal(bingCalls.length, 1);
    Assert.deepEqual(bingCalls[0].options, { from: 'en', to: 'zh-Hans' });
    Assert.equal(bingCalls[0].execution.timeoutMs, 5000);
    Assert.equal(Object.isFrozen(bingCalls[0].execution), true);
});

Test('configured LibreTranslate replaces DeepLX and runs before Bing', async () => {
    const postCalls = [];
    const httpClient = {
        post: async (url, payload, options) => {
            postCalls.push({ url, payload, options });
            return { data: { translatedText: 'le bot marche' } };
        }
    };
    const result = await Translator('the bot works', { from: 'en', to: 'fr' }, {
        googleClient: async () => { throw new Error('offline'); },
        bingClient: async () => { throw new Error('must not run'); },
        httpClient,
        libreTranslateUrl: 'https://translate.example/base/',
        libreTranslateApiKey: 'secret'
    });

    Assert.equal(result.provider, 'libretranslate');
    Assert.deepEqual(result.failures, [{ provider: 'google-web', reason: 'offline' }]);
    Assert.equal(postCalls.length, 1);
    Assert.equal(postCalls[0].url, 'https://translate.example/base/translate');
    Assert.deepEqual(postCalls[0].payload, {
        q: 'the bot works', source: 'en', target: 'fr', format: 'text', api_key: 'secret'
    });
    Assert.equal(postCalls[0].options.timeout, 5000);
    Assert.equal(postCalls[0].options.signal instanceof AbortSignal, true);
});

Test('falls back once to MyMemory after the other default providers fail', async () => {
    const httpCalls = [];
    const httpClient = {
        get: async (url, options) => {
            httpCalls.push({ url, options });
            return { data: {
                responseStatus: 200,
                responseData: { translatedText: '机器人应该工作' }
            } };
        }
    };

    const result = await Translator('the bot should work', { from: 'en', to: 'zh' }, {
        googleClient: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); },
        deepLxClient: async () => { throw new Error('bad gateway'); },
        bingClient: async () => { throw new Error('offline'); },
        httpClient
    });

    Assert.deepEqual(result, {
        text: '机器人应该工作',
        provider: 'mymemory',
        failures: [
            { provider: 'google-web', reason: 'HTTP 429' },
            { provider: 'deeplx', reason: 'bad gateway' },
            { provider: 'bing-web', reason: 'offline' }
        ]
    });
    Assert.equal(httpCalls.length, 1);
    Assert.equal(httpCalls[0].options.params.langpair, 'en|zh-CN');
    Assert.equal(httpCalls[0].options.timeout, 5000);
    Assert.equal(httpCalls[0].options.signal instanceof AbortSignal, true);
});

Test('aborts a timed-out provider then advances exactly once', async () => {
    const calls = [];
    let aborted = false;
    const providers = [
        {
            name: 'slow',
            translate: async (_text, _options, execution) => new Promise((resolve, reject) => {
                calls.push('slow');
                execution.signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(execution.signal.reason);
                }, { once: true });
            })
        },
        { name: 'next', translate: async () => { calls.push('next'); return 'bonjour'; } }
    ];

    const result = await Translator('hello', { from: 'en', to: 'fr' }, { providers, requestTimeoutMs: 15 });

    Assert.equal(aborted, true);
    Assert.deepEqual(calls, ['slow', 'next']);
    Assert.deepEqual(result, {
        text: 'bonjour', provider: 'next', failures: [{ provider: 'slow', reason: 'ETIMEDOUT' }]
    });
});

Test('validates the entire provider chain before any provider call', async () => {
    let calls = 0;
    const providers = [
        { name: 'valid', translate: async () => { calls += 1; return 'bonjour'; } },
        { name: 'invalid log\nname', translate: async () => 'ignored' }
    ];

    await Assert.rejects(
        () => Translator('hello', { from: 'en', to: 'fr' }, { providers }),
        /safe name/
    );
    Assert.equal(calls, 0);
});

Test('reports immutable sanitized failures without retrying providers', async () => {
    const calls = [];
    const providers = [
        { name: 'first', translate: async () => { calls.push('first'); throw new Error('off\nline'); } },
        { name: 'second', translate: async () => { calls.push('second'); throw new Error('quota'); } }
    ];

    let error;
    try { await Translator('hello', { from: 'en', to: 'fr' }, { providers }); }
    catch (caught) { error = caught; }
    Assert.ok(error);
    Assert.equal(error.name, 'TranslationProvidersError');
    Assert.deepEqual(error.failures, [
        { provider: 'first', reason: 'off line' },
        { provider: 'second', reason: 'quota' }
    ]);
    Assert.equal(Object.isFrozen(error), true);
    Assert.equal(Object.isFrozen(error.failures), true);
    Assert.equal(Object.isFrozen(error.failures[0]), true);
    Assert.deepEqual(calls, ['first', 'second']);
});

Test('rejects a successful response in the wrong target script and advances', async () => {
    const providers = [
        { name: 'wrong-language', translate: async () => 'Hello world' },
        { name: 'correct-language', translate: async () => '大家好' }
    ];

    const result = await Translator('bonjour le monde', { from: 'fr', to: 'zh' }, { providers });
    Assert.equal(result.provider, 'correct-language');
    Assert.deepEqual(result.failures, [{
        provider: 'wrong-language',
        reason: 'Provider response does not match the Chinese target script.'
    }]);
});

Test('rejects invalid inputs, duplicate providers and malformed responses', async () => {
    const invalidResponse = { name: 'invalid', translate: async () => ({ text: '' }) };
    const duplicateProviders = [
        { name: 'same', translate: async () => 'one' },
        { name: 'same', translate: async () => 'two' }
    ];

    await Assert.rejects(() => Translator('', { from: 'en', to: 'zh' }), /non-empty/);
    await Assert.rejects(() => Translator('hello', { from: 'english', to: 'zh' }), /ISO language codes/);
    await Assert.rejects(() => Translator('hello', { from: 'en', to: 'en' }), /must differ/);
    await Assert.rejects(() => Translator('hello', { from: 'en', to: 'zh' }, { providers: null }), /non-empty array/);
    await Assert.rejects(() => Translator('hello', { from: 'en', to: 'zh' },
        { providers: duplicateProviders }), /Duplicate/);
    await Assert.rejects(() => Translator('hello', { from: 'en', to: 'zh' },
        { providers: [invalidResponse] }), /Provider returned no translated text/);
});
