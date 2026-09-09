const Axios = require('axios');
const { translate: GoogleTranslate } = require('@vitalets/google-translate-api');

const BingWebTranslate = require('./providers/bingWeb.js');

const DEEPLX_ENDPOINT = 'https://deeplx.1stg.me/translate';
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
const REQUEST_TIMEOUT_MS = 5000;
const MYMEMORY_MAX_QUERY_BYTES = 500;
const BING_LANGUAGE_CODES = Object.freeze({ zh: 'zh-Hans' });
const MYMEMORY_LANGUAGE_CODES = Object.freeze({ zh: 'zh-CN' });

class TranslationProvidersError extends Error {
    constructor(failures) {
        const snapshot = freezeFailures(failures);
        super(`Translation providers failed: ${snapshot
            .map(failure => `${failure.provider} (${failure.reason})`).join(', ')}`);
        this.name = 'TranslationProvidersError';
        this.failures = snapshot;
        Object.freeze(this);
    }
}

async function translate(text, options, dependencies = {}) {
    const normalizedOptions = normalizeInputs(text, options);
    const timeoutMs = getRequestTimeout(dependencies);
    const configuredProviders = Object.prototype.hasOwnProperty.call(dependencies, 'providers') ?
        dependencies.providers : getDefaultProviders(dependencies);
    const providers = validateProviderChain(configuredProviders);

    const failures = [];
    for (const provider of providers) {
        try {
            const translated = await executeProvider(provider, text, normalizedOptions, timeoutMs);
            validateTranslatedText(text, translated, normalizedOptions.to);
            return Object.freeze({
                text: translated.trim(),
                provider: provider.name,
                failures: freezeFailures(failures)
            });
        }
        catch (error) {
            failures.push(Object.freeze({ provider: provider.name, reason: getFailureReason(error) }));
        }
    }

    throw new TranslationProvidersError(failures);
}

function getDefaultProviders(dependencies) {
    const googleClient = dependencies.googleClient || GoogleTranslate;
    const deepLxClient = dependencies.deepLxClient;
    const bingClient = dependencies.bingClient || BingWebTranslate;
    const httpClient = dependencies.httpClient || Axios;
    const libreTranslateUrl = Object.prototype.hasOwnProperty.call(dependencies, 'libreTranslateUrl') ?
        dependencies.libreTranslateUrl : process.env.RPP_LIBRETRANSLATE_URL;
    const libreTranslateApiKey = Object.prototype.hasOwnProperty.call(dependencies, 'libreTranslateApiKey') ?
        dependencies.libreTranslateApiKey : process.env.RPP_LIBRETRANSLATE_API_KEY;
    const providers = [Object.freeze({
        name: 'google-web',
        translate: async (text, options, execution) => {
            const response = await googleClient(text, {
                from: options.from,
                to: options.to,
                fetchOptions: { timeout: execution.timeoutMs, signal: execution.signal }
            });
            return response && response.text;
        }
    })];

    if (typeof libreTranslateUrl === 'string' && libreTranslateUrl.trim() !== '') {
        providers.push(Object.freeze({
            name: 'libretranslate',
            translate: async (text, options, execution) => {
                validateHttpMethod(httpClient, 'post', 'LibreTranslate');
                const payload = {
                    q: text,
                    source: options.from,
                    target: options.to,
                    format: 'text'
                };
                if (typeof libreTranslateApiKey === 'string' && libreTranslateApiKey.trim() !== '') {
                    payload.api_key = libreTranslateApiKey.trim();
                }
                const response = await httpClient.post(getLibreTranslateEndpoint(libreTranslateUrl), payload, {
                    timeout: execution.timeoutMs,
                    signal: execution.signal
                });
                return response && response.data && response.data.translatedText;
            }
        }));
    }
    else {
        providers.push(Object.freeze({
            name: 'deeplx',
            translate: async (text, options, execution) => {
                if (typeof deepLxClient === 'function') return deepLxClient(text, options, execution);
                validateHttpMethod(httpClient, 'post', 'DeepLX');
                const response = await httpClient.post(DEEPLX_ENDPOINT, {
                    text,
                    source_lang: options.from.toUpperCase(),
                    target_lang: options.to.toUpperCase()
                }, {
                    timeout: execution.timeoutMs,
                    signal: execution.signal
                });
                const data = response && response.data;
                if (!data || Number(data.code) !== 200) {
                    throw new Error(`Invalid response code ${data && data.code || 'unknown'}.`);
                }
                if (typeof data.targetLang === 'string' && data.targetLang.toLowerCase() !== options.to) {
                    throw new Error(`Unexpected target language ${data.targetLang}.`);
                }
                return data.data;
            }
        }));
    }

    providers.push(Object.freeze({
        name: 'bing-web',
        translate: async (text, options, execution) => bingClient(text, {
            from: getBingLanguage(options.from),
            to: getBingLanguage(options.to)
        }, execution)
    }));

    providers.push(Object.freeze({
        name: 'mymemory',
        translate: async (text, options, execution) => {
            validateHttpMethod(httpClient, 'get', 'MyMemory');
            if (Buffer.byteLength(text, 'utf8') > MYMEMORY_MAX_QUERY_BYTES) {
                throw new RangeError(`MyMemory query exceeds ${MYMEMORY_MAX_QUERY_BYTES} bytes.`);
            }
            const response = await httpClient.get(MYMEMORY_ENDPOINT, {
                params: {
                    q: text,
                    langpair: `${getMyMemoryLanguage(options.from)}|${getMyMemoryLanguage(options.to)}`
                },
                timeout: execution.timeoutMs,
                signal: execution.signal
            });
            const data = response && response.data;
            if (!data || Number(data.responseStatus) !== 200) {
                throw new Error(`Invalid response status ${data && data.responseStatus || 'unknown'}.`);
            }
            return data.responseData && data.responseData.translatedText;
        }
    }));

    return Object.freeze(providers);
}

async function executeProvider(provider, text, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error(`Timed out after ${timeoutMs} ms.`), { code: 'ETIMEDOUT' });
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort(timeoutError);
            reject(timeoutError);
        }, timeoutMs);
    });
    const execution = Object.freeze({ signal: controller.signal, timeoutMs });

    try {
        return await Promise.race([
            Promise.resolve().then(() => provider.translate(text, options, execution)),
            timeout
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}

function normalizeInputs(text, options) {
    if (typeof text !== 'string' || text.trim() === '') {
        throw new TypeError('Translation text must be a non-empty string.');
    }
    if (!options || !isLanguageCode(options.from) || !isLanguageCode(options.to)) {
        throw new TypeError('Translation languages must be ISO language codes.');
    }
    const normalized = Object.freeze({ from: options.from.toLowerCase(), to: options.to.toLowerCase() });
    if (normalized.from === normalized.to) throw new TypeError('Source and target languages must differ.');
    return normalized;
}

function validateTranslatedText(sourceText, translated, targetLanguage) {
    if (typeof translated !== 'string' || translated.trim() === '') {
        throw new Error('Provider returned no translated text.');
    }
    const normalized = translated.trim();
    if (normalized === sourceText.trim()) throw new Error('Provider returned unchanged text.');

    const letters = [...normalized].filter(character => /\p{L}/u.test(character));
    const hanLetters = letters.filter(character => /\p{Script=Han}/u.test(character)).length;
    if (targetLanguage === 'zh' && hanLetters === 0) {
        throw new Error('Provider response does not match the Chinese target script.');
    }
    if (['en', 'fr'].includes(targetLanguage) && letters.length > 0 && hanLetters / letters.length >= 0.5) {
        throw new Error(`Provider response does not match the ${targetLanguage} target script.`);
    }
}

function getRequestTimeout(dependencies) {
    if (!Object.prototype.hasOwnProperty.call(dependencies, 'requestTimeoutMs')) return REQUEST_TIMEOUT_MS;
    const value = dependencies.requestTimeoutMs;
    if (!Number.isInteger(value) || value <= 0) throw new TypeError('Translation timeout must be a positive integer.');
    return value;
}

function validateProviderChain(providers) {
    if (!Array.isArray(providers) || providers.length === 0) {
        throw new TypeError('Translation providers must be a non-empty array.');
    }
    const snapshot = [...providers];
    const names = new Set();
    for (const provider of snapshot) {
        if (!provider || typeof provider.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider.name) ||
            typeof provider.translate !== 'function') {
            throw new TypeError('Each translation provider must have a safe name and translate function.');
        }
        if (names.has(provider.name)) throw new TypeError(`Duplicate translation provider: ${provider.name}.`);
        names.add(provider.name);
    }
    return Object.freeze(snapshot);
}

function validateHttpMethod(httpClient, method, provider) {
    if (!httpClient || typeof httpClient[method] !== 'function') {
        throw new TypeError(`${provider} HTTP client must expose ${method}().`);
    }
}

function isLanguageCode(value) {
    return typeof value === 'string' && /^[a-z]{2,3}$/i.test(value);
}

function getBingLanguage(language) {
    return BING_LANGUAGE_CODES[language] || language;
}

function getMyMemoryLanguage(language) {
    return MYMEMORY_LANGUAGE_CODES[language] || language;
}

function getLibreTranslateEndpoint(value) {
    let endpoint;
    try { endpoint = new URL(value.trim()); }
    catch (error) { throw new TypeError('LibreTranslate URL is invalid.'); }
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
        throw new TypeError('LibreTranslate URL must use HTTP or HTTPS.');
    }
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
    if (!endpoint.pathname.endsWith('/translate')) endpoint.pathname += '/translate';
    return endpoint.toString();
}

function getFailureReason(error) {
    const status = error && (error.status || error.statusCode || (error.response && error.response.status));
    let reason;
    if (status) reason = `HTTP ${status}`;
    else if (error && typeof error.code === 'string') reason = error.code;
    else if (error && typeof error.message === 'string') reason = error.message;
    else reason = 'unknown error';
    return reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown error';
}

function freezeFailures(failures) {
    return Object.freeze(failures.map(failure => Object.freeze({
        provider: failure.provider,
        reason: failure.reason
    })));
}

module.exports = translate;
module.exports.TranslationProvidersError = TranslationProvidersError;
