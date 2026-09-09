const Axios = require('axios');

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const REQUEST_TIMEOUT_MS = 10000;

async function translate(text, options, dependencies = {}) {
    if (typeof text !== 'string' || text.trim() === '') {
        throw new TypeError('Translation text must be a non-empty string.');
    }
    if (!options || !isLanguageCode(options.from) || !isLanguageCode(options.to)) {
        throw new TypeError('Translation languages must be ISO language codes.');
    }

    const httpClient = dependencies.httpClient || Axios;
    if (!httpClient || typeof httpClient.get !== 'function') {
        throw new TypeError('Translation HTTP client must expose get().');
    }

    const response = await httpClient.get(ENDPOINT, {
        params: {
            client: 'gtx',
            sl: options.from,
            tl: options.to,
            dt: 't',
            q: text
        },
        timeout: REQUEST_TIMEOUT_MS
    });
    const segments = response && response.data && Array.isArray(response.data[0]) ? response.data[0] : [];
    const translated = segments
        .map(segment => Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '')
        .join('')
        .trim();

    if (!translated) throw new Error('Google translation response did not contain translated text.');
    return translated;
}

function isLanguageCode(value) {
    return typeof value === 'string' && /^[a-z]{2,3}$/i.test(value);
}

module.exports = translate;
