const Axios = require('axios');

const TRANSLATOR_URL = 'https://bing.com/translator';
const TRANSLATE_PATH = '/ttranslatev3';
const MAX_TEXT_LENGTH = 3000;
const TOKEN_EXPIRY_MARGIN_MS = 60000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    'Chrome/150.0.0.0 Safari/537.36 Edg/151.0.0.0';

function createTranslator(defaultDependencies = {}) {
    const httpClient = defaultDependencies.httpClient || Axios;
    const now = defaultDependencies.now || Date.now;
    let configuration = null;
    let requestSequence = 0;

    return async function translate(text, options, execution = {}) {
        validateInputs(text, options, httpClient, execution);
        if (text.length > MAX_TEXT_LENGTH) {
            throw new RangeError(`Bing Web text exceeds ${MAX_TEXT_LENGTH} characters.`);
        }

        if (!configuration || configuration.expiresAt - now() <= TOKEN_EXPIRY_MARGIN_MS) {
            configuration = await fetchConfiguration(httpClient, execution, now);
            requestSequence = 0;
        }

        const sequence = ++requestSequence;
        const endpoint = new URL(TRANSLATE_PATH, `https://${configuration.subdomain}.bing.com`);
        endpoint.searchParams.set('isVertical', '1');
        endpoint.searchParams.set('IG', configuration.ig);
        endpoint.searchParams.set('IID', configuration.iid);
        endpoint.searchParams.set('SFX', sequence.toString());
        endpoint.searchParams.set('ref', 'TThis');
        endpoint.searchParams.set('edgepdftranslator', '1');
        const body = new URLSearchParams({
            fromLang: options.from,
            text,
            token: configuration.token,
            key: configuration.key.toString(),
            to: options.to,
            tryFetchingGenderDebiasedTranslations: 'true'
        });

        try {
            const response = await httpClient.post(endpoint.toString(), body.toString(), {
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    'user-agent': USER_AGENT,
                    referer: `https://${configuration.subdomain}.bing.com/translator`
                },
                responseType: 'json',
                timeout: execution.timeoutMs,
                signal: execution.signal
            });
            const translation = response && response.data && response.data[0] &&
                response.data[0].translations && response.data[0].translations[0];
            return translation && translation.text;
        }
        catch (error) {
            if (error && error.response && error.response.status === 401) configuration = null;
            throw error;
        }
    };
}

async function fetchConfiguration(httpClient, execution, now) {
    const response = await httpClient.get(TRANSLATOR_URL, {
        headers: { 'user-agent': USER_AGENT },
        responseType: 'text',
        timeout: execution.timeoutMs,
        signal: execution.signal
    });
    const html = response && response.data;
    if (typeof html !== 'string') throw new Error('Bing Web returned no configuration page.');

    const ig = matchRequired(html, /IG:"([^"]+)"/, 'IG');
    const iid = matchRequired(html, /data-iid="([^"]+)"/, 'IID');
    let tokenConfiguration;
    try {
        tokenConfiguration = JSON.parse(matchRequired(html,
            /params_AbusePreventionHelper\s?=\s?([^\]]+\])/, 'token configuration'));
    }
    catch (error) {
        throw new Error('Bing Web returned invalid token configuration.');
    }
    const [key, token, expiryInterval] = tokenConfiguration;
    if (!Number.isFinite(Number(key)) || typeof token !== 'string' || token === '' ||
        !Number.isFinite(Number(expiryInterval))) {
        throw new Error('Bing Web returned incomplete token configuration.');
    }

    return Object.freeze({
        ig,
        iid,
        key: Number(key),
        token,
        expiresAt: Math.max(Number(key) + Number(expiryInterval), now() + Number(expiryInterval)),
        subdomain: getResponseSubdomain(response)
    });
}

function validateInputs(text, options, httpClient, execution) {
    if (typeof text !== 'string' || text.trim() === '') throw new TypeError('Bing Web text must be non-empty.');
    if (!options || typeof options.from !== 'string' || typeof options.to !== 'string') {
        throw new TypeError('Bing Web languages are required.');
    }
    if (!httpClient || typeof httpClient.get !== 'function' || typeof httpClient.post !== 'function') {
        throw new TypeError('Bing Web HTTP client must expose get() and post().');
    }
    if (!execution.signal || !Number.isFinite(execution.timeoutMs) || execution.timeoutMs <= 0) {
        throw new TypeError('Bing Web requires an abort signal and timeout.');
    }
}

function matchRequired(value, expression, field) {
    const match = value.match(expression);
    if (!match || !match[1]) throw new Error(`Bing Web configuration is missing ${field}.`);
    return match[1];
}

function getResponseSubdomain(response) {
    const responseUrl = response && response.request && response.request.res && response.request.res.responseUrl;
    if (typeof responseUrl !== 'string') return 'www';
    try {
        const hostname = new URL(responseUrl).hostname;
        const match = hostname.match(/^([a-z0-9-]+)\.bing\.com$/i);
        return match ? match[1] : 'www';
    }
    catch (error) { return 'www'; }
}

module.exports = createTranslator();
module.exports.createTranslator = createTranslator;
