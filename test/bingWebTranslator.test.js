const Assert = require('node:assert/strict');
const Test = require('node:test');

const { createTranslator } = require('../src/plugins/autoTranslate/providers/bingWeb.js');

const CONFIGURATION_HTML = 'IG:"ig-value" data-iid="translator.1" ' +
    'params_AbusePreventionHelper = [1700000000000,"token-value",3600000]';

function execution() {
    return Object.freeze({ signal: new AbortController().signal, timeoutMs: 5000 });
}

Test('Bing adapter fetches one token, caches it and performs no retry', async () => {
    const calls = [];
    const httpClient = {
        get: async (url, options) => {
            calls.push({ method: 'get', url, options });
            return {
                data: CONFIGURATION_HTML,
                request: { res: { responseUrl: 'https://www.bing.com/translator' } }
            };
        },
        post: async (url, body, options) => {
            calls.push({ method: 'post', url, body, options });
            return { data: [{ translations: [{ text: '翻译测试', to: 'zh-Hans' }] }] };
        }
    };
    const translate = createTranslator({ httpClient, now: () => 1700000000000 });

    Assert.equal(await translate('test de traduction', { from: 'fr', to: 'zh-Hans' }, execution()), '翻译测试');
    Assert.equal(await translate('encore', { from: 'fr', to: 'zh-Hans' }, execution()), '翻译测试');

    Assert.equal(calls.filter(call => call.method === 'get').length, 1);
    Assert.equal(calls.filter(call => call.method === 'post').length, 2);
    const post = calls.find(call => call.method === 'post');
    const endpoint = new URL(post.url);
    const body = new URLSearchParams(post.body);
    Assert.equal(endpoint.hostname, 'www.bing.com');
    Assert.equal(endpoint.pathname, '/ttranslatev3');
    Assert.equal(endpoint.searchParams.get('SFX'), '1');
    Assert.equal(body.get('fromLang'), 'fr');
    Assert.equal(body.get('to'), 'zh-Hans');
    Assert.equal(body.get('text'), 'test de traduction');
    Assert.equal(post.options.timeout, 5000);
    Assert.equal(post.options.signal instanceof AbortSignal, true);
});

Test('Bing adapter fails fast on malformed configuration without posting', async () => {
    let postCalls = 0;
    const translate = createTranslator({
        httpClient: {
            get: async () => ({ data: '<html>changed</html>' }),
            post: async () => { postCalls += 1; }
        }
    });

    await Assert.rejects(
        () => translate('hello', { from: 'en', to: 'fr' }, execution()),
        /missing IG/
    );
    Assert.equal(postCalls, 0);
});

Test('Bing adapter invalidates a rejected token without retrying the failed call', async () => {
    let getCalls = 0;
    let postCalls = 0;
    const translate = createTranslator({
        now: () => 1700000000000,
        httpClient: {
            get: async () => {
                getCalls += 1;
                return { data: CONFIGURATION_HTML };
            },
            post: async () => {
                postCalls += 1;
                if (postCalls === 1) throw Object.assign(new Error('unauthorized'), { response: { status: 401 } });
                return { data: [{ translations: [{ text: 'bonjour' }] }] };
            }
        }
    });

    await Assert.rejects(() => translate('hello', { from: 'en', to: 'fr' }, execution()), /unauthorized/);
    Assert.equal(postCalls, 1);
    Assert.equal(await translate('hello', { from: 'en', to: 'fr' }, execution()), 'bonjour');
    Assert.equal(getCalls, 2);
    Assert.equal(postCalls, 2);
});
