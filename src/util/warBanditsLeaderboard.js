// @ts-check
'use strict';

const Axios = require('axios');
const Fs = require('node:fs');
const Path = require('node:path');

const WarBandits = require('../plugins/warBandits/index.js');
const { atomicWrite } = require('./steamBanExport.js');

const DEFAULT_API_ROOT = 'https://api.warbandits.gg';
const PAGE_SIZE = 25;
const MAX_TOP = 10_000;
const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** @param {number} milliseconds */
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** @param {any} error */
function responseStatus(error) {
    return Number.isInteger(error && error.response && error.response.status) ? error.response.status : null;
}

/** @param {unknown} value @param {number} nowMs */
function retryAfterMs(value, nowMs) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10 * 60_000, Math.ceil(seconds * 1000));
    const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(timestamp) ? Math.max(0, Math.min(10 * 60_000, timestamp - nowMs)) : null;
}

/** @param {string} cacheDirectory @param {string} server @param {number} page */
function cachePath(cacheDirectory, server, page) {
    return Path.join(cacheDirectory, server, `all-time-pvp-kills-page-${page}.json`);
}

/** @param {string} path @param {string} server @param {number} page @param {number} maximumAgeMs
 * @param {number} nowMs */
async function readCachedPage(path, server, page, maximumAgeMs, nowMs) {
    try {
        const stat = await Fs.promises.stat(path);
        if (stat.size > MAX_PAGE_BYTES) return null;
        const value = JSON.parse(await Fs.promises.readFile(path, 'utf8'));
        if (!value || value.schemaVersion !== CACHE_SCHEMA_VERSION || value.server !== server ||
            value.page !== page || value.pageSize !== PAGE_SIZE || typeof value.fetchedAt !== 'string' ||
            !Number.isFinite(Date.parse(value.fetchedAt)) || nowMs - Date.parse(value.fetchedAt) > maximumAgeMs) {
            return null;
        }
        const parsed = WarBandits.parseStatsPayload(value.payload);
        if (parsed.rows.length > PAGE_SIZE) return null;
        return Object.freeze({ parsed, observedAt: value.fetchedAt, cached: true });
    }
    catch (error) {
        if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
        return null;
    }
}

/**
 * Fetch a deliberately small all-time leaderboard window. This is identity/activity enrichment only and never
 * creates presence evidence.
 * @param {{server:string,top?:number,delayMs?:number,apiRoot?:string,httpClient?:any,sleep?:(ms:number)=>Promise<void>,
 * now?:()=>Date,cacheDirectory?:string,cacheMaxAgeMs?:number,force?:boolean,
 * onPage?:(value:{page:number,pages:number,rows:number,cached:boolean})=>void,
 * onRetry?:(value:{page:number,attempt:number,delayMs:number,status:number|null})=>void}} options
 */
async function fetchLeaderboard(options) {
    const server = `${options.server || ''}`.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/u.test(server)) throw new TypeError('WarBandits server slug is invalid.');
    const top = Number(options.top ?? 300);
    if (!Number.isSafeInteger(top) || top < 1 || top > MAX_TOP) {
        throw new TypeError(`WarBandits top must be from 1 to ${MAX_TOP}.`);
    }
    const delayMs = Number(options.delayMs ?? 5000);
    if (!Number.isSafeInteger(delayMs) || delayMs < 1000 || delayMs > 10 * 60_000) {
        throw new TypeError('WarBandits delay must be from 1000 to 600000 milliseconds.');
    }
    const apiRoot = `${options.apiRoot || process.env.RPP_WARBANDITS_API_URL || DEFAULT_API_ROOT}`
        .replace(/\/+$/u, '');
    const root = new URL(apiRoot);
    if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash) {
        throw new TypeError('WarBandits API root must be an HTTPS origin.');
    }
    const httpClient = options.httpClient || Axios;
    const sleepImpl = options.sleep || sleep;
    const now = options.now || (() => new Date());
    const cacheDirectory = options.cacheDirectory ? Path.resolve(options.cacheDirectory) : null;
    const cacheMaxAgeMs = Number(options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
    if (!Number.isSafeInteger(cacheMaxAgeMs) || cacheMaxAgeMs < 0 || cacheMaxAgeMs > 365 * 24 * 60 * 60 * 1000) {
        throw new TypeError('WarBandits cache age must be from 0 to 365 days.');
    }
    const pageCount = Math.ceil(top / PAGE_SIZE);
    const bySteamId = new Map();
    /** @type {number|null} */
    let lastRequestAt = null;
    for (let page = 1; page <= pageCount; page += 1) {
        const pagePath = cacheDirectory ? cachePath(cacheDirectory, server, page) : null;
        /** @type {{parsed:any,observedAt:string,cached:boolean}|null} */
        let pageResult = !options.force && cacheMaxAgeMs > 0 && pagePath ?
            await readCachedPage(pagePath, server, page, cacheMaxAgeMs, now().getTime()) : null;
        if (!pageResult) {
            let lastError = null;
            for (let attempt = 1; attempt <= 5; attempt += 1) {
                const requestAt = now().getTime();
                if (lastRequestAt !== null && requestAt - lastRequestAt < delayMs) {
                    await sleepImpl(delayMs - (requestAt - lastRequestAt));
                }
                lastRequestAt = now().getTime();
                try {
                    const response = await httpClient.get(`${root.origin}/stats/${encodeURIComponent(server)}`, {
                        params: {
                            limit: PAGE_SIZE,
                            wipe: 'all-time',
                            category_ID: 1,
                            sort_direction: 'DESC',
                            sort_key: 'kills',
                            page
                        },
                        timeout: 15_000,
                        maxContentLength: MAX_PAGE_BYTES,
                        maxBodyLength: MAX_PAGE_BYTES,
                        maxRedirects: 0,
                        headers: { 'User-Agent': 'rustplusplus-steam-ban-scanner' }
                    });
                    const parsed = WarBandits.parseStatsPayload(response && response.data);
                    if (parsed.rows.length > PAGE_SIZE) {
                        throw new TypeError('WarBandits leaderboard page exceeds its bound.');
                    }
                    const observedAt = now().toISOString();
                    if (pagePath) {
                        try {
                            await atomicWrite(pagePath, `${JSON.stringify({
                                schemaVersion: CACHE_SCHEMA_VERSION,
                                server,
                                page,
                                pageSize: PAGE_SIZE,
                                fetchedAt: observedAt,
                                payload: response.data
                            })}\n`);
                        }
                        catch (error) {
                            throw Object.assign(new Error('WarBandits leaderboard cache write failed.',
                                { cause: error }), { nonRetryable: true });
                        }
                    }
                    pageResult = Object.freeze({ parsed, observedAt, cached: false });
                    break;
                }
                catch (error) {
                    lastError = error;
                    const status = responseStatus(error);
                    if (/** @type {any} */ (error)?.nonRetryable === true ||
                        (status !== null && status !== 429 && status < 500)) break;
                    if (attempt >= 5) break;
                    const response = /** @type {any} */ (error)?.response;
                    const header = response && response.headers && response.headers['retry-after'];
                    const retry = retryAfterMs(header, now().getTime()) ??
                        Math.min(10 * 60_000, 5000 * (2 ** (attempt - 1)));
                    options.onRetry?.({ page, attempt, delayMs: retry, status });
                    await sleepImpl(retry);
                }
            }
            if (!pageResult) {
                const status = responseStatus(lastError);
                throw new Error(/** @type {any} */ (lastError)?.nonRetryable === true ?
                    'WarBandits leaderboard cache write failed.' :
                    status === 429 ? 'WarBandits leaderboard rate limit persisted after retries.' :
                    status !== null ? `WarBandits leaderboard returned HTTP ${status}.` :
                        'WarBandits leaderboard request failed after retries.');
            }
        }
        const { parsed, observedAt } = pageResult;
        for (const row of parsed.rows) {
            const previous = bySteamId.get(row.steamId);
            if (!previous || row.rank < previous.row.rank) bySteamId.set(row.steamId, { row, observedAt });
        }
        options.onPage?.({ page, pages: pageCount, rows: parsed.rows.length, cached: pageResult.cached });
        if (parsed.rows.length < PAGE_SIZE) break;
    }
    const observedAt = now().toISOString();
    const rows = [...bySteamId.values()].sort((left, right) => left.row.rank - right.row.rank ||
        left.row.steamId.localeCompare(right.row.steamId)).slice(0, top).map((value, index) => {
        const { row } = value;
        return Object.freeze({
        priorityRank: index + 1,
        steamId: row.steamId,
        profileUrl: `https://steamcommunity.com/profiles/${row.steamId}/`,
        localDisplayName: row.name,
        currentSteamName: null,
        verifiedAliases: Object.freeze([row.name]),
        battlemetricsPlayerIds: Object.freeze([]),
        serverKeys: Object.freeze([`warbandits:${server}`]),
        serverCount: 1,
        wipeCount: 0,
        observationCount: 1,
        identityObservationCount: 0,
        confirmedClanSnapshotCount: 0,
        firstObservedAt: null,
        lastObservedAt: value.observedAt,
        warBanditsHoursMax: row.playtime,
        warBanditsByServer: Object.freeze([Object.freeze({
            serverKey: server,
            hours: row.playtime,
            observedAt: value.observedAt
        })]),
        warBanditsRank: row.rank,
        warBanditsPlayerId: row.warBanditsPlayerId
    });
    });
    return Object.freeze({
        server,
        top,
        observedAt,
        rows: Object.freeze(rows)
    });
}

module.exports = Object.freeze({
    CACHE_SCHEMA_VERSION,
    DEFAULT_API_ROOT,
    DEFAULT_CACHE_MAX_AGE_MS,
    MAX_TOP,
    PAGE_SIZE,
    fetchLeaderboard
});
