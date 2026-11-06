// @ts-check
'use strict';

const Axios = require('axios');

const DEFAULT_API_ROOT = 'https://api.steampowered.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RUST_APP_ID = 252490;
const STEAM_ID_PATTERN = /^7656119\d{10}$/u;

class SteamApiError extends Error {
    /** @param {string} message @param {number|null} [status] @param {number|null} [retryAfterMs] */
    constructor(message, status = null, retryAfterMs = null) {
        super(message);
        this.name = 'SteamApiError';
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {string} field */
function nonNegativeInteger(value, field) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`Steam ${field} must be a non-negative integer.`);
    }
    return Number(value);
}

/** @param {unknown} value @param {string} field */
function boolean(value, field) {
    if (typeof value !== 'boolean') throw new TypeError(`Steam ${field} must be boolean.`);
    return value;
}

/** @param {unknown} value @param {string} field @param {number} [maximum] */
function boundedString(value, field, maximum = 512) {
    if (typeof value !== 'string' || value.length > maximum) {
        throw new TypeError(`Steam ${field} must be a bounded string.`);
    }
    return value;
}

/** @param {unknown} value @param {string} field */
function steamId(value, field) {
    const id = boundedString(value, field, 17);
    if (!STEAM_ID_PATTERN.test(id)) throw new TypeError(`Steam ${field} is not a SteamID64.`);
    return id;
}

/** @param {unknown} value */
function projectDetailedBans(value) {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value) || value.length > 64) throw new TypeError('Steam detailed bans are invalid.');
    return Object.freeze(value.map(item => {
        if (!isObject(item)) throw new TypeError('Steam detailed ban is invalid.');
        return Object.freeze({
            appIdMin: nonNegativeInteger(item.AppIdMin, 'ban AppIdMin'),
            appIdMax: nonNegativeInteger(item.AppIdMax, 'ban AppIdMax'),
            banStartTime: nonNegativeInteger(item.BanStartTime, 'ban BanStartTime'),
            banType: nonNegativeInteger(item.BanType, 'ban BanType'),
            banProviderId: nonNegativeInteger(item.BanProviderId, 'ban BanProviderId')
        });
    }));
}

/** @param {unknown} value */
function projectBanPlayer(value) {
    if (!isObject(value)) throw new TypeError('Steam ban player is invalid.');
    return Object.freeze({
        steamId: steamId(value.SteamId, 'SteamId'),
        communityBanned: boolean(value.CommunityBanned, 'CommunityBanned'),
        vacBanned: boolean(value.VACBanned, 'VACBanned'),
        numberOfVacBans: nonNegativeInteger(value.NumberOfVACBans, 'NumberOfVACBans'),
        daysSinceLastBan: nonNegativeInteger(value.DaysSinceLastBan, 'DaysSinceLastBan'),
        numberOfGameBans: nonNegativeInteger(value.NumberOfGameBans, 'NumberOfGameBans'),
        economyBan: boundedString(value.EconomyBan, 'EconomyBan', 64),
        detailedBans: projectDetailedBans(value.bans)
    });
}

/** @param {unknown} payload @param {readonly string[]} expectedIds */
function projectBanResponse(payload, expectedIds) {
    if (!isObject(payload) || !Array.isArray(payload.players) || payload.players.length > expectedIds.length) {
        throw new TypeError('Steam ban response is invalid.');
    }
    const expected = new Set(expectedIds);
    const players = payload.players.map(projectBanPlayer);
    const returned = new Set();
    for (const player of players) {
        if (!expected.has(player.steamId) || returned.has(player.steamId)) {
            throw new TypeError('Steam ban response contains an unexpected or duplicate SteamID64.');
        }
        returned.add(player.steamId);
    }
    if (returned.size !== expected.size) throw new TypeError('Steam ban response omitted a requested SteamID64.');
    return Object.freeze(players);
}

/** @param {unknown} payload @param {readonly string[]} expectedIds */
function projectSummaryResponse(payload, expectedIds) {
    if (!isObject(payload) || !isObject(payload.response) || !Array.isArray(payload.response.players) ||
        payload.response.players.length > expectedIds.length) {
        throw new TypeError('Steam summary response is invalid.');
    }
    const expected = new Set(expectedIds);
    const returned = new Set();
    return Object.freeze(payload.response.players.map((/** @type {any} */ item) => {
        if (!isObject(item)) throw new TypeError('Steam player summary is invalid.');
        const id = steamId(item.steamid, 'summary steamid');
        if (!expected.has(id) || returned.has(id)) {
            throw new TypeError('Steam summary contains an unexpected or duplicate SteamID64.');
        }
        returned.add(id);
        return Object.freeze({
            steamId: id,
            personaName: boundedString(item.personaname, 'personaname', 256),
            profileUrl: boundedString(item.profileurl, 'profileurl', 1024),
            visibilityState: nonNegativeInteger(item.communityvisibilitystate, 'communityvisibilitystate')
        });
    }));
}

/** @param {unknown} payload */
function projectRustPlaytime(payload) {
    if (!isObject(payload) || !isObject(payload.response)) {
        throw new TypeError('Steam owned-games response is invalid.');
    }
    if (payload.response.games === undefined) return null;
    if (!Array.isArray(payload.response.games) || payload.response.games.length > 1) {
        throw new TypeError('Steam owned-games result is invalid.');
    }
    const rust = payload.response.games.find((/** @type {any} */ game) =>
        isObject(game) && game.appid === RUST_APP_ID);
    if (!rust) return null;
    return nonNegativeInteger(rust.playtime_forever, 'Rust playtime_forever');
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
function apiError(error) {
    const status = Number.isInteger(error && error.response && error.response.status) ? error.response.status : null;
    const retryAfterMs = parseRetryAfter(error && error.response && error.response.headers &&
        error.response.headers['retry-after']);
    if (status !== null) return new SteamApiError(`Steam Web API returned HTTP ${status}.`, status, retryAfterMs);
    if (error && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) return new SteamApiError('Steam Web API timeout.');
    return new SteamApiError('Steam Web API request failed.');
}

/**
 * Read-only Steam Web API client. It validates and projects every response so arbitrary provider fields never enter
 * reports, and errors never include the API key or request URL.
 * @param {{apiKey?:string,apiRoot?:string,httpClient?:any,timeoutMs?:number}} [options]
 */
function createClient(options = {}) {
    const apiKey = `${options.apiKey ?? process.env.RPP_STEAM_WEB_API_KEY ?? ''}`.trim();
    if (!apiKey || apiKey.length > 256) throw new Error('RPP_STEAM_WEB_API_KEY is missing or invalid.');
    const apiRoot = `${options.apiRoot || process.env.RPP_STEAM_WEB_API_URL || DEFAULT_API_ROOT}`
        .replace(/\/+$/u, '');
    const root = new URL(apiRoot);
    if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash) {
        throw new Error('Steam Web API root must be an HTTPS origin.');
    }
    const httpClient = options.httpClient || Axios;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    /** @param {string} path @param {Record<string, any>} params */
    async function request(path, params) {
        try {
            const response = await httpClient.get(`${root.origin}${path}`, {
                params: { key: apiKey, ...params },
                timeout: timeoutMs,
                maxContentLength: MAX_RESPONSE_BYTES,
                maxBodyLength: MAX_RESPONSE_BYTES,
                maxRedirects: 0,
                headers: { 'User-Agent': 'rustplusplus-steam-ban-scanner' }
            });
            if (Number.isInteger(response && response.status) && response.status !== 200) {
                throw Object.assign(new Error('HTTP response'), { response });
            }
            return response && response.data;
        }
        catch (error) {
            if (error instanceof TypeError) throw error;
            throw apiError(error);
        }
    }

    /** @param {readonly string[]} ids */
    async function getPlayerBans(ids) {
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => !STEAM_ID_PATTERN.test(id))) {
            throw new TypeError('Steam ban batch must contain 1 to 100 valid SteamID64 values.');
        }
        return projectBanResponse(await request('/ISteamUser/GetPlayerBans/v1/', {
            steamids: ids.join(',')
        }), ids);
    }

    /** @param {readonly string[]} ids */
    async function getPlayerSummaries(ids) {
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => !STEAM_ID_PATTERN.test(id))) {
            throw new TypeError('Steam summary batch must contain 1 to 100 valid SteamID64 values.');
        }
        return projectSummaryResponse(await request('/ISteamUser/GetPlayerSummaries/v2/', {
            steamids: ids.join(',')
        }), ids);
    }

    /** @param {string} id */
    async function getRustPlaytimeMinutes(id) {
        if (!STEAM_ID_PATTERN.test(id)) throw new TypeError('Rust playtime requires a valid SteamID64.');
        return projectRustPlaytime(await request('/IPlayerService/GetOwnedGames/v1/', {
            steamid: id,
            include_appinfo: false,
            include_played_free_games: true,
            'appids_filter[0]': RUST_APP_ID
        }));
    }

    return Object.freeze({ getPlayerBans, getPlayerSummaries, getRustPlaytimeMinutes });
}

module.exports = Object.freeze({
    DEFAULT_API_ROOT,
    DEFAULT_TIMEOUT_MS,
    MAX_RESPONSE_BYTES,
    RUST_APP_ID,
    STEAM_ID_PATTERN,
    SteamApiError,
    createClient,
    projectBanPlayer,
    projectBanResponse,
    projectRustPlaytime,
    projectSummaryResponse
});
