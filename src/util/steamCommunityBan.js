// @ts-check
'use strict';

const Axios = require('axios');

const Utils = require('./utils.js');

const DEFAULT_PROFILE_ROOT = 'https://steamcommunity.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const STEAM_ID_PATTERN = /^7656119\d{10}$/u;

class SteamCommunityError extends Error {
    /** @param {string} message @param {number|null} [status] @param {number|null} [retryAfterMs] */
    constructor(message, status = null, retryAfterMs = null) {
        super(message);
        this.name = 'SteamCommunityError';
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

/** @param {unknown} value */
function parseRetryAfter(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10 * 60_000, Math.ceil(seconds * 1000));
    const date = Date.parse(`${value}`);
    return Number.isFinite(date) ? Math.max(0, Math.min(10 * 60_000, date - Date.now())) : null;
}

/** @param {any} error */
function providerError(error) {
    const status = Number.isInteger(error && error.response && error.response.status) ? error.response.status : null;
    const retryAfterMs = parseRetryAfter(error && error.response && error.response.headers &&
        error.response.headers['retry-after']);
    if (status !== null) return new SteamCommunityError(`Steam Community returned HTTP ${status}.`,
        status, retryAfterMs);
    if (error && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) {
        return new SteamCommunityError('Steam Community profile request timed out.');
    }
    return new SteamCommunityError('Steam Community profile request failed.');
}

/** @param {any} headers @param {string} name */
function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const key = Object.keys(headers).find(value => value.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
}

/** @param {unknown} value @param {URL} root @param {string} expectedId */
function safeRedirect(value, root, expectedId) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    let target;
    try {
        target = new URL(value, root.origin);
    }
    catch {
        return null;
    }
    const vanity = /^\/id\/[^/]{1,256}\/?$/u.test(target.pathname);
    const numeric = target.pathname === `/profiles/${expectedId}/` || target.pathname === `/profiles/${expectedId}`;
    if (target.origin !== root.origin || target.username || target.password || target.hash || (!vanity && !numeric)) {
        return null;
    }
    for (const [key, item] of target.searchParams) {
        if (key !== 'l' || item !== 'english') return null;
    }
    target.search = '?l=english';
    return target.toString();
}

/** @param {string} value */
function visibleText(value) {
    const numeric = value.replace(/&#(?:x([0-9a-f]+)|(\d+));/giu, (match, hexadecimal, decimal) => {
        const codePoint = Number.parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff &&
            !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : match;
    });
    return Utils.decodeHtml(numeric.replace(/<[^>]*>/gu, ' '))
        .replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {string} text @param {RegExp} pattern */
function count(text, pattern) {
    const match = pattern.exec(text);
    if (!match) return 0;
    const value = Number(match[1].replace(/,/gu, ''));
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) {
        throw new TypeError('Steam Community ban count is invalid.');
    }
    return value;
}

/**
 * Project only the visible ban header from a bounded public Steam Community profile page. User-authored profile
 * content is ignored because parsing starts at Steam's profile_ban_status component and is capped at 12 KiB.
 * @param {unknown} payload @param {string} expectedId
 */
function parseProfileHtml(payload, expectedId) {
    if (!STEAM_ID_PATTERN.test(expectedId)) throw new TypeError('SteamID64 is invalid.');
    if (typeof payload !== 'string' || payload.length < 64 || Buffer.byteLength(payload, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new TypeError('Steam Community profile response is invalid.');
    }
    if (!/(?:profile_header|profile_page)/iu.test(payload) ||
        !/<title[^>]*>\s*Steam Community\s*::/iu.test(payload)) {
        throw new TypeError('Steam Community profile page markers are missing.');
    }
    const nameMatch = /<span[^>]*class=(['"])[^'"]*\bactual_persona_name\b[^'"]*\1[^>]*>([\s\S]{0,1024}?)<\/span>/iu
        .exec(payload);
    const steamName = nameMatch ? visibleText(nameMatch[2]) : null;
    const markerMatch = /class=(['"])[^'"]*\bprofile_ban_status\b[^'"]*\1/iu.exec(payload);
    if (!markerMatch) {
        return Object.freeze({
            steamId: expectedId,
            profileUrl: `https://steamcommunity.com/profiles/${expectedId}/`,
            steamName: steamName || null,
            numberOfGameBans: 0,
            numberOfVacBans: 0,
            vacBanned: false,
            daysSinceLastBan: null,
            source: 'steam-community-public-profile'
        });
    }
    const section = visibleText(payload.slice(markerMatch.index, markerMatch.index + 12 * 1024));
    const numberOfGameBans = count(section, /(\d[\d,]*)\s+game bans?\s+on record/iu);
    const numberOfVacBans = count(section, /(\d[\d,]*)\s+VAC bans?\s+on record/iu);
    const daysMatch = /(\d[\d,]*)\s+days?\s+since last ban/iu.exec(section);
    const daysSinceLastBan = daysMatch ? Number(daysMatch[1].replace(/,/gu, '')) : null;
    if ((numberOfGameBans > 0 || numberOfVacBans > 0) &&
        (!Number.isSafeInteger(daysSinceLastBan) || /** @type {number} */ (daysSinceLastBan) < 0)) {
        throw new TypeError('Steam Community last-ban age is missing or invalid.');
    }
    return Object.freeze({
        steamId: expectedId,
        profileUrl: `https://steamcommunity.com/profiles/${expectedId}/`,
        steamName: steamName || null,
        numberOfGameBans,
        numberOfVacBans,
        vacBanned: numberOfVacBans > 0,
        daysSinceLastBan,
        source: 'steam-community-public-profile'
    });
}

/** @param {{profileRoot?:string,httpClient?:any,timeoutMs?:number}} [options] */
function createClient(options = {}) {
    const profileRoot = `${options.profileRoot || DEFAULT_PROFILE_ROOT}`.replace(/\/+$/u, '');
    const root = new URL(profileRoot);
    if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash || root.pathname !== '/') {
        throw new TypeError('Steam Community profile root must be an HTTPS origin.');
    }
    const httpClient = options.httpClient || Axios;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    /** @param {string} id */
    async function getPlayerBan(id) {
        if (!STEAM_ID_PATTERN.test(id)) throw new TypeError('SteamID64 is invalid.');
        /** @param {string} url @param {boolean} permitRedirect @param {Record<string,string>|undefined} params */
        async function request(url, permitRedirect, params) {
            try {
                const response = await httpClient.get(url, {
                    params,
                    responseType: 'text',
                    timeout: timeoutMs,
                    maxContentLength: MAX_RESPONSE_BYTES,
                    maxBodyLength: MAX_RESPONSE_BYTES,
                    maxRedirects: 0,
                    headers: { 'User-Agent': 'rustplusplus-steam-ban-scanner/1.22' }
                });
                if (Number.isInteger(response && response.status) && response.status !== 200) {
                    throw Object.assign(new Error('HTTP response'), { response });
                }
                return response;
            }
            catch (error) {
                if (error instanceof TypeError || error instanceof SteamCommunityError) throw error;
                const response = /** @type {any} */ (error)?.response;
                const status = Number.isInteger(response?.status) ? response.status : null;
                if (permitRedirect && [301, 302, 307, 308].includes(status)) {
                    const redirect = safeRedirect(headerValue(response.headers, 'location'), root, id);
                    if (!redirect) {
                        throw new SteamCommunityError('Steam Community returned an unsafe profile redirect.', status);
                    }
                    return request(redirect, false, undefined);
                }
                throw providerError(error);
            }
        }
        const response = await request(`${root.origin}/profiles/${id}/`, true, { l: 'english' });
        return parseProfileHtml(response && response.data, id);
    }

    return Object.freeze({ getPlayerBan });
}

module.exports = Object.freeze({
    DEFAULT_PROFILE_ROOT,
    DEFAULT_TIMEOUT_MS,
    MAX_RESPONSE_BYTES,
    STEAM_ID_PATTERN,
    SteamCommunityError,
    createClient,
    parseProfileHtml,
    safeRedirect
});
