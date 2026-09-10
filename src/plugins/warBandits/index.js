/* Detached WarBandits identity/activity provider. It never infers player presence. */

const Axios = require('axios');
const Fs = require('fs');
const Path = require('path');

const API_TIMEOUT_MS = 5000;
const DEFAULT_API_ROOT = 'https://api.warbandits.gg';
const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CLOUDFLARE_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_GAP_MS = 5000;
const DEFAULT_STATS_TTL_MS = 5 * 60 * 1000;
const DATA_DIRECTORY = Path.join(__dirname, '..', '..', '..', 'data', 'warbandits');
const SCHEMA_VERSION = 1;

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function asNonEmptyString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`WarBandits ${field} must be a non-empty string.`);
    }
    return value.trim();
}

function asIdentifier(value, field) {
    if ((typeof value !== 'string' && typeof value !== 'number') || `${value}`.trim() === '') {
        throw new TypeError(`WarBandits ${field} must be a scalar identifier.`);
    }
    return `${value}`.trim();
}

function asNonNegativeNumber(value, field) {
    const number = typeof value === 'number' ? value :
        (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`WarBandits ${field} must be a non-negative number.`);
    }
    return number;
}

function asNullableScalar(value, field) {
    if (value === null) return null;
    if (!['string', 'number'].includes(typeof value)) {
        throw new TypeError(`WarBandits ${field} must be a scalar or null.`);
    }
    return value;
}

function asBoolean(value, field) {
    if (typeof value === 'boolean') return value;
    if (value === 0 || value === 1 || value === '0' || value === '1') return `${value}` === '1';
    throw new TypeError(`WarBandits ${field} must be a boolean.`);
}

function normalize(value) {
    return `${value || ''}`.normalize('NFKC').trim().toLocaleLowerCase('en');
}

function sanitizeFilePart(value) {
    return `${value}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function normalizeHostname(value) {
    let hostname = normalize(value);
    if (!hostname) return '';
    hostname = hostname.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0];
    if (hostname.startsWith('[')) {
        const end = hostname.indexOf(']');
        return end === -1 ? hostname : hostname.slice(1, end);
    }
    hostname = hostname.replace(/:\d+$/, '').replace(/\.$/, '');
    return hostname;
}

function parseServerCatalog(payload) {
    if (!Array.isArray(payload)) {
        throw new TypeError('WarBandits server catalogue response is invalid.');
    }

    const required = [
        'sid', 'nextwipe', 'wipetime', 'lastwipe', 'serverip', 'serverid', 'joining', 'queued',
        'connected', 'max_pop', 'grouplimit', 'region', 'multiplier', 'ismain', 'isnobps',
        'name', 'fullname', 'bmid'
    ];
    const seenSlugs = new Set();
    const servers = payload.map(raw => {
        if (!isObject(raw) || required.some(field => !hasOwn(raw, field))) {
            throw new TypeError('WarBandits server catalogue entry is incomplete.');
        }
        const slug = asNonEmptyString(raw.name, 'name');
        if (!/^[a-zA-Z0-9_-]+$/.test(slug) || seenSlugs.has(slug)) {
            throw new TypeError('WarBandits name slug is invalid or duplicated.');
        }
        seenSlugs.add(slug);
        const sid = asIdentifier(raw.sid, 'sid');
        const serverId = asIdentifier(raw.serverid, 'serverid');
        if (!/^\d+$/.test(sid) || !/^\d+$/.test(serverId)) {
            throw new TypeError('WarBandits sid and serverid must be numeric.');
        }
        const battlemetricsId = asIdentifier(raw.bmid, 'bmid');
        if (!/^\d+$/.test(battlemetricsId)) throw new TypeError('WarBandits bmid must be numeric.');

        return deepFreeze({
            slug,
            nextWipe: asNullableScalar(raw.nextwipe, 'nextwipe'),
            wipeTime: asNullableScalar(raw.wipetime, 'wipetime'),
            lastWipe: asNullableScalar(raw.lastwipe, 'lastwipe'),
            hostname: asNonEmptyString(raw.serverip, 'serverip'),
            serverId,
            sid,
            joining: asNonNegativeNumber(raw.joining, 'joining'),
            queued: asNonNegativeNumber(raw.queued, 'queued'),
            connected: asNonNegativeNumber(raw.connected, 'connected'),
            maxPopulation: asNonNegativeNumber(raw.max_pop, 'max_pop'),
            groupLimit: asNonNegativeNumber(raw.grouplimit, 'grouplimit'),
            region: asNonEmptyString(raw.region, 'region'),
            multiplier: asNonNegativeNumber(raw.multiplier, 'multiplier'),
            isMain: asBoolean(raw.ismain, 'ismain'),
            isNoBps: asBoolean(raw.isnobps, 'isnobps'),
            name: slug,
            fullName: asNonEmptyString(raw.fullname, 'fullname'),
            battlemetricsId
        });
    });
    return deepFreeze(servers);
}

function parseStatistic(raw) {
    if (!isObject(raw) || !hasOwn(raw, 'name') || !hasOwn(raw, 'amount')) {
        throw new TypeError('WarBandits statistic is invalid.');
    }
    if (hasOwn(raw, 'ID') && raw.ID !== null) asIdentifier(raw.ID, 'stat ID');
    return deepFreeze({
        id: hasOwn(raw, 'ID') && raw.ID !== null ? `${raw.ID}` : null,
        name: asNonEmptyString(raw.name, 'stat name'),
        amount: asNonNegativeNumber(raw.amount, 'stat amount')
    });
}

function parseStatsPayload(payload) {
    if (!isObject(payload) || payload.code !== 200 || !Array.isArray(payload.stats) ||
        !hasOwn(payload, 'utils') || (!isObject(payload.utils) && !Array.isArray(payload.utils))) {
        throw new TypeError('WarBandits stats response is invalid.');
    }

    const rows = payload.stats.map(raw => {
        if (!isObject(raw) || !isObject(raw.player) || !Array.isArray(raw.stats)) {
            throw new TypeError('WarBandits stats row is invalid.');
        }
        const player = raw.player;
        for (const field of ['ID', 'steam_64_ID', 'name', 'rank', 'playtime']) {
            if (!hasOwn(player, field)) throw new TypeError(`WarBandits player ${field} is missing.`);
        }
        const steamId = asIdentifier(player.steam_64_ID, 'steam_64_ID');
        if (!/^7656119\d{10}$/.test(steamId)) throw new TypeError('WarBandits steam_64_ID is invalid.');
        return deepFreeze({
            warBanditsPlayerId: asIdentifier(player.ID, 'player ID'),
            steamId,
            name: asNonEmptyString(player.name, 'player name'),
            rank: asNonNegativeNumber(player.rank, 'player rank'),
            playtime: asNonNegativeNumber(player.playtime, 'player playtime'),
            stats: raw.stats.map(parseStatistic)
        });
    });

    return deepFreeze({ rows, utils: JSON.parse(JSON.stringify(payload.utils)) });
}

function scopeBattlemetricsId(scope) {
    const value = scope && (scope.battlemetricsId || scope.battlemetricsServerId ||
        (scope.server && scope.server.battlemetricsId));
    return value === null || value === undefined ? '' : `${value}`;
}

function scopeHostname(scope) {
    if (!scope) return '';
    return scope.hostname || scope.serverHostname || scope.serverIp ||
        (scope.server && (scope.server.hostname || scope.server.serverIp)) || '';
}

function selectServer(servers, scope) {
    if (!Array.isArray(servers)) throw new TypeError('WarBandits servers must be an array.');
    const battlemetricsId = scopeBattlemetricsId(scope);
    if (battlemetricsId) {
        const matches = servers.filter(server => `${server.battlemetricsId}` === battlemetricsId);
        if (matches.length > 1) throw new Error('WarBandits BattleMetrics server match is ambiguous.');
        if (matches.length === 1) return matches[0];
    }

    const hostname = normalizeHostname(scopeHostname(scope));
    if (!hostname) return null;
    const matches = servers.filter(server => normalizeHostname(server.hostname) === hostname);
    if (matches.length > 1) throw new Error('WarBandits hostname match is ambiguous.');
    return matches.length === 1 ? matches[0] : null;
}

function groupPlayers(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const current = grouped.get(row.steamId);
        if (!current) {
            grouped.set(row.steamId, {
                source: 'warbandits',
                warBanditsPlayerId: row.warBanditsPlayerId,
                warBanditsPlayerIds: [row.warBanditsPlayerId],
                steamId: row.steamId,
                name: row.name,
                aliases: [row.name],
                rank: row.rank,
                playtime: row.playtime,
                stats: row.stats
            });
            continue;
        }
        if (!current.aliases.some(alias => normalize(alias) === normalize(row.name))) current.aliases.push(row.name);
        if (!current.warBanditsPlayerIds.includes(row.warBanditsPlayerId)) {
            current.warBanditsPlayerIds.push(row.warBanditsPlayerId);
        }
    }
    return [...grouped.values()].map(deepFreeze);
}

function selectPlayer(rows, query) {
    const players = groupPlayers(rows);
    const rawQuery = `${query}`.trim();
    if (/^7656119\d{10}$/.test(rawQuery)) {
        const matches = players.filter(player => player.steamId === rawQuery);
        return deepFreeze({ player: matches.length === 1 ? matches[0] : null, candidates: matches,
            ambiguous: matches.length > 1 });
    }

    const wanted = normalize(rawQuery);
    const aliasesMatch = (player, predicate) => player.aliases.some(alias => predicate(normalize(alias)));
    const exact = players.filter(player => aliasesMatch(player, alias => alias === wanted));
    if (exact.length > 0) {
        return deepFreeze({ player: exact.length === 1 ? exact[0] : null, candidates: exact,
            ambiguous: exact.length > 1 });
    }
    const prefix = players.filter(player => aliasesMatch(player, alias => alias.startsWith(wanted)));
    if (prefix.length > 0) {
        return deepFreeze({ player: prefix.length === 1 ? prefix[0] : null, candidates: prefix,
            ambiguous: prefix.length > 1 });
    }
    const partial = players.filter(player => aliasesMatch(player, alias => alias.includes(wanted)));
    return deepFreeze({ player: partial.length === 1 ? partial[0] : null, candidates: partial,
        ambiguous: partial.length > 1 });
}

function createProvider(dependencies = {}) {
    const httpClient = dependencies.httpClient || Axios;
    const fs = dependencies.fs || Fs;
    const dataDirectory = dependencies.dataDirectory || DATA_DIRECTORY;
    const apiRoot = `${dependencies.apiRoot || process.env.RPP_WARBANDITS_API_URL || DEFAULT_API_ROOT}`
        .replace(/\/+$/, '');
    const enabled = dependencies.enabled !== undefined ? Boolean(dependencies.enabled) :
        process.env.RPP_WARBANDITS_ENABLED !== 'false';
    const now = dependencies.now || (() => new Date());
    const sleep = dependencies.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const requestGapMs = dependencies.requestGapMs === undefined ? DEFAULT_REQUEST_GAP_MS :
        Math.max(0, Number(dependencies.requestGapMs));
    const catalogTtlMs = dependencies.catalogTtlMs === undefined ? DEFAULT_CATALOG_TTL_MS :
        Math.max(0, Number(dependencies.catalogTtlMs));
    const statsTtlMs = dependencies.statsTtlMs === undefined ? DEFAULT_STATS_TTL_MS :
        Math.max(0, Number(dependencies.statsTtlMs));
    const cloudflareCooldownMs = dependencies.cloudflareCooldownMs === undefined ?
        DEFAULT_CLOUDFLARE_COOLDOWN_MS : Math.max(0, Number(dependencies.cloudflareCooldownMs));
    const serversPath = Path.join(dataDirectory, 'servers.json');
    const responseCache = new Map();
    const inFlight = new Map();
    let requestTail = Promise.resolve();
    let lastRequestStartedAt = null;
    let temporaryCounter = 0;
    let memoryCatalog = null;

    function dateNow() {
        const value = now();
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) throw new TypeError('WarBandits clock returned an invalid date.');
        return date;
    }

    function log(context, message) {
        if (context && context.rustplus && typeof context.rustplus.log === 'function') {
            context.rustplus.log('WARBANDITS', message, 'warn');
        }
        else if (context && context.client && typeof context.client.log === 'function') {
            context.client.log('WARBANDITS', message, 'warn');
        }
    }

    function writeJsonAtomic(path, value) {
        const directory = Path.dirname(path);
        fs.mkdirSync(directory, { recursive: true });
        const temporaryPath = `${path}.tmp-${process.pid}-${temporaryCounter++}`;
        try {
            fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
            fs.renameSync(temporaryPath, path);
        }
        catch (error) {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            throw error;
        }
    }

    function validateCatalogCache(value) {
        if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION ||
            typeof value.savedAt !== 'string' || Number.isNaN(Date.parse(value.savedAt)) ||
            (value.cooldownUntil !== null &&
                (typeof value.cooldownUntil !== 'string' || Number.isNaN(Date.parse(value.cooldownUntil)))) ||
            !Array.isArray(value.servers)) {
            throw new TypeError('WarBandits server cache is invalid.');
        }
        for (const server of value.servers) {
            if (!isObject(server) || typeof server.slug !== 'string' ||
                !/^\d+$/.test(`${server.battlemetricsId}`) || typeof server.hostname !== 'string') {
                throw new TypeError('WarBandits cached server is invalid.');
            }
        }
        return deepFreeze(value);
    }

    function readCatalogCache() {
        if (memoryCatalog) return memoryCatalog;
        if (!fs.existsSync(serversPath)) return null;
        memoryCatalog = validateCatalogCache(JSON.parse(fs.readFileSync(serversPath, 'utf8')));
        return memoryCatalog;
    }

    function saveCatalog(servers, cooldownUntil = null) {
        const value = deepFreeze({
            schemaVersion: SCHEMA_VERSION,
            savedAt: dateNow().toISOString(),
            cooldownUntil,
            servers
        });
        writeJsonAtomic(serversPath, value);
        memoryCatalog = value;
        return value;
    }

    function isFresh(value) {
        return value && dateNow().getTime() - Date.parse(value.savedAt) <= catalogTtlMs;
    }

    function coalesce(key, callback) {
        if (inFlight.has(key)) return inFlight.get(key);
        const promise = Promise.resolve().then(callback).finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
        return promise;
    }

    function serializeRequest(callback) {
        const request = requestTail.catch(() => undefined).then(async () => {
            const current = dateNow().getTime();
            if (lastRequestStartedAt !== null) {
                const wait = requestGapMs - (current - lastRequestStartedAt);
                if (wait > 0) await sleep(wait);
            }
            lastRequestStartedAt = dateNow().getTime();
            return callback();
        });
        requestTail = request.catch(() => undefined);
        return request;
    }

    function headerValue(headers, name) {
        if (!headers) return null;
        if (typeof headers.get === 'function') return headers.get(name);
        const key = Object.keys(headers).find(value => value.toLowerCase() === name.toLowerCase());
        return key ? headers[key] : null;
    }

    function isCloudflareChallenge(error) {
        const headers = error && error.response && error.response.headers;
        const server = normalize(headerValue(headers, 'server'));
        const contentType = normalize(headerValue(headers, 'content-type'));
        const body = typeof (error && error.response && error.response.data) === 'string' ?
            error.response.data.trim().toLowerCase() : '';
        const isHtml = contentType.includes('text/html') || body.startsWith('<!doctype html') ||
            body.startsWith('<html');
        return isHtml && (Boolean(headerValue(headers, 'cf-ray')) || server.includes('cloudflare'));
    }

    function isHtmlResponse(response) {
        const contentType = normalize(headerValue(response && response.headers, 'content-type'));
        const body = typeof (response && response.data) === 'string' ? response.data.trim().toLowerCase() : '';
        return contentType.includes('text/html') || body.startsWith('<!doctype html') || body.startsWith('<html');
    }

    function parseRetryAfter(value, currentDate) {
        if (value === null || value === undefined || `${value}`.trim() === '') return null;
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) return new Date(currentDate.getTime() + seconds * 1000);
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function persistCooldown(error) {
        const current = dateNow();
        const status = error && error.response && error.response.status;
        const cloudflare = isCloudflareChallenge(error);
        if (status !== 429 && !cloudflare) return null;
        const retryAfter = parseRetryAfter(
            headerValue(error.response && error.response.headers, 'retry-after'), current);
        const until = retryAfter || new Date(current.getTime() + cloudflareCooldownMs);
        const previous = readCatalogCache();
        saveCatalog(previous ? previous.servers : [], until.toISOString());
        return deepFreeze({ reason: status === 429 ? 'rate limited' : 'cloudflare',
            cooldownUntil: until.toISOString() });
    }

    async function request(key, url, options) {
        return coalesce(`request:${key}`, () => serializeRequest(async () => {
            const state = readCatalogCache();
            if (state && state.cooldownUntil && Date.parse(state.cooldownUntil) > dateNow().getTime()) {
                const error = new Error('WarBandits provider cooldown is active.');
                error.code = 'WARBANDITS_COOLDOWN';
                throw error;
            }
            try {
                const response = await httpClient.get(url, { ...options, timeout: API_TIMEOUT_MS });
                if (isHtmlResponse(response)) {
                    const error = new Error('WarBandits returned an HTML challenge.');
                    error.response = {
                        status: response.status || 200,
                        headers: response.headers || { 'content-type': 'text/html' }
                    };
                    throw error;
                }
                return response;
            }
            catch (error) {
                if (error.code !== 'WARBANDITS_COOLDOWN') persistCooldown(error);
                throw error;
            }
        }));
    }

    function unavailable(reason, extra = {}) {
        return deepFreeze({ available: false, reason, ...extra });
    }

    async function ensureServerCatalog(context = null) {
        if (!enabled) return unavailable('disabled', { servers: [] });
        let cached;
        try {
            cached = readCatalogCache();
        }
        catch (error) {
            log(context, `Server cache rejected: ${error.message}`);
            throw error;
        }
        const currentTime = dateNow().getTime();
        if (cached && cached.cooldownUntil && Date.parse(cached.cooldownUntil) > currentTime) {
            return deepFreeze({ available: cached.servers.length > 0, reason: 'cooldown',
                source: 'disk', stale: !isFresh(cached), cooldownUntil: cached.cooldownUntil,
                servers: cached.servers });
        }
        if (isFresh(cached)) {
            return deepFreeze({ available: true, reason: null, source: 'cache', stale: false,
                cooldownUntil: null, servers: cached.servers });
        }

        return coalesce('catalog', async () => {
            try {
                const response = await request('servers', `${apiRoot}/servers`, {});
                const servers = parseServerCatalog(response && response.data);
                const saved = saveCatalog(servers);
                return deepFreeze({ available: true, reason: null, source: 'network', stale: false,
                    cooldownUntil: null, servers: saved.servers });
            }
            catch (error) {
                const fallback = readCatalogCache();
                const cooldownUntil = fallback && fallback.cooldownUntil;
                log(context, `Server catalogue unavailable: ${cooldownUntil ? 'cooldown' : 'request failed'}.`);
                if (fallback && fallback.servers.length > 0) {
                    return deepFreeze({ available: true, reason: cooldownUntil ? 'cooldown' : 'stale cache',
                        source: 'disk', stale: true, cooldownUntil, servers: fallback.servers });
                }
                return unavailable(cooldownUntil ? 'cooldown' : 'request failed', {
                    servers: [], cooldownUntil: cooldownUntil || null
                });
            }
        });
    }

    function statsCacheKey(server, query) {
        return `${server.slug}:${normalize(query)}`;
    }

    function statsCacheGet(key) {
        const cached = responseCache.get(key);
        if (!cached || dateNow().getTime() - cached.savedAt > statsTtlMs) {
            responseCache.delete(key);
            return null;
        }
        return cached.value;
    }

    function resultTotal(utils) {
        if (!isObject(utils) || !hasOwn(utils, 'total')) return null;
        const total = typeof utils.total === 'number' ? utils.total : Number(utils.total);
        return Number.isSafeInteger(total) && total >= 0 ? total : null;
    }

    async function resolvePlayer(context, scope, query) {
        const rawQuery = `${query || ''}`.trim();
        if (!rawQuery || rawQuery.length > 64) return unavailable('invalid query', { candidates: [] });
        const catalog = await ensureServerCatalog(context);
        if (!catalog.available || catalog.reason === 'cooldown') {
            return unavailable(catalog.reason, { candidates: [], server: null });
        }

        let server;
        try {
            server = selectServer(catalog.servers, scope);
        }
        catch (error) {
            return unavailable(error.message, { candidates: [], server: null });
        }
        if (!server) return unavailable('server not supported', { candidates: [], server: null });

        const key = statsCacheKey(server, rawQuery);
        const cached = statsCacheGet(key);
        let result = cached;
        if (!result) {
            result = await coalesce(`stats:${key}`, async () => {
                const secondCached = statsCacheGet(key);
                if (secondCached) return secondCached;
                const steamQuery = /^7656119\d{10}$/.test(rawQuery);
                const params = {
                    limit: 10,
                    wipe: 'all-time',
                    category_ID: 1,
                    sort_direction: 'DESC',
                    [steamQuery ? 'steam_64_ID' : 'player_name']: rawQuery
                };
                try {
                    const response = await request(`stats:${key}`,
                        `${apiRoot}/stats/${encodeURIComponent(server.slug)}`, { params });
                    const parsed = parseStatsPayload(response && response.data);
                    const selection = selectPlayer(parsed.rows, rawQuery);
                    const total = resultTotal(parsed.utils);
                    const truncated = !steamQuery && total !== null && total > parsed.rows.length;
                    const value = deepFreeze({
                        available: true,
                        reason: null,
                        server,
                        query: rawQuery,
                        player: truncated ? null : selection.player,
                        candidates: selection.candidates,
                        ambiguous: truncated || selection.ambiguous,
                        truncated,
                        observedAt: dateNow().toISOString(),
                        utils: parsed.utils
                    });
                    responseCache.set(key, { savedAt: dateNow().getTime(), value });
                    return value;
                }
                catch (error) {
                    const state = readCatalogCache();
                    const reason = state && state.cooldownUntil &&
                        Date.parse(state.cooldownUntil) > dateNow().getTime() ? 'cooldown' : 'request failed';
                    log(context, `Player lookup unavailable: ${reason}.`);
                    return unavailable(reason, { server, candidates: [], player: null, ambiguous: false });
                }
            });
        }

        if (result.available && context && context.guildId) {
            try {
                persistResolution(context, server, result);
            }
            catch (error) {
                log(context, `Player sidecar update failed: ${error.message}.`);
                return unavailable('cache write failed', {
                    server, candidates: [], player: null, ambiguous: false
                });
            }
        }
        return result;
    }

    function sidecarPath(guildId, server) {
        return Path.join(dataDirectory,
            `${sanitizeFilePart(guildId)}-${sanitizeFilePart(server.slug)}.json`);
    }

    function emptySidecar(guildId, server) {
        return {
            schemaVersion: SCHEMA_VERSION,
            guildId: `${guildId}`,
            warBanditsServer: server.slug,
            battlemetricsServerId: server.battlemetricsId,
            hostname: server.hostname,
            updatedAt: dateNow().toISOString(),
            lastResolution: null,
            players: []
        };
    }

    function validateSidecar(value, guildId, server) {
        if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION ||
            `${value.guildId}` !== `${guildId}` || value.warBanditsServer !== server.slug ||
            `${value.battlemetricsServerId}` !== `${server.battlemetricsId}` ||
            typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt)) ||
            !Array.isArray(value.players)) {
            throw new TypeError('WarBandits sidecar is invalid.');
        }
        return value;
    }

    function readSidecar(guildId, server) {
        const path = sidecarPath(guildId, server);
        if (!fs.existsSync(path)) return emptySidecar(guildId, server);
        return validateSidecar(JSON.parse(fs.readFileSync(path, 'utf8')), guildId, server);
    }

    function metricMap(player) {
        const metrics = new Map([['playtime', player.playtime]]);
        for (const statistic of player.stats) {
            const key = statistic.id ? `stat:${statistic.id}` : `stat:${normalize(statistic.name)}`;
            metrics.set(key, statistic.amount);
        }
        return metrics;
    }

    function activityDelta(previousStats, player) {
        if (!previousStats) return [];
        const before = new Map((previousStats.metrics || []).map(metric => [metric.key, metric.amount]));
        const deltas = [];
        for (const [key, amount] of metricMap(player)) {
            const prior = before.get(key);
            if (Number.isFinite(prior) && amount > prior) deltas.push({ key, amount: amount - prior });
        }
        return deltas;
    }

    function buildStats(player, observedAt) {
        return {
            observedAt,
            rank: player.rank,
            playtime: player.playtime,
            metrics: [...metricMap(player)].map(([key, amount]) => ({ key, amount }))
        };
    }

    function unknownPresence(previous) {
        const prior = previous && previous.presence;
        return {
            source: 'battlemetrics',
            status: 'unknown',
            lastKnownStatus: prior && prior.status !== 'unknown' ? prior.status :
                (prior && prior.lastKnownStatus) || null,
            observedAt: prior ? prior.observedAt : null,
            lastSeenAt: prior ? prior.lastSeenAt : null
        };
    }

    function persistResolution(context, server, resolution) {
        const sidecar = readSidecar(context.guildId, server);
        const observedAt = resolution.observedAt;
        for (const candidate of resolution.candidates) {
            const previous = sidecar.players.find(player => player.identity &&
                player.identity.steamId === candidate.steamId);
            if (previous && previous.stats && previous.stats.observedAt === observedAt) continue;
            const deltas = activityDelta(previous && previous.stats, candidate);
            const aliases = [...new Set([
                ...((previous && previous.identity && previous.identity.aliases) || []),
                candidate.name,
                ...candidate.aliases
            ])];
            const record = {
                identity: {
                    source: 'warbandits',
                    warBanditsPlayerId: candidate.warBanditsPlayerId,
                    warBanditsPlayerIds: candidate.warBanditsPlayerIds,
                    battlemetricsPlayerId: previous && previous.identity ?
                        previous.identity.battlemetricsPlayerId : null,
                    steamId: candidate.steamId,
                    name: candidate.name,
                    aliases,
                    observedAt
                },
                stats: buildStats(candidate, observedAt),
                activity: {
                    source: 'warbandits-stats-delta',
                    observedAt,
                    lastActivityAt: deltas.length > 0 ? observedAt :
                        (previous && previous.activity && previous.activity.lastActivityAt) || null,
                    deltas
                },
                presence: unknownPresence(previous)
            };
            sidecar.players = sidecar.players.filter(player => !player.identity ||
                player.identity.steamId !== candidate.steamId);
            sidecar.players.push(record);
        }
        sidecar.players.sort((a, b) => `${a.identity.steamId}`.localeCompare(`${b.identity.steamId}`));
        sidecar.lastResolution = {
            query: resolution.query,
            observedAt,
            ambiguous: resolution.ambiguous,
            candidateSteamIds: resolution.candidates.map(candidate => candidate.steamId)
        };
        sidecar.updatedAt = dateNow().toISOString();
        writeJsonAtomic(sidecarPath(context.guildId, server), sidecar);
    }

    function battlemetricsPresence(context, scope, battlemetricsPlayerId, previous, observedAt) {
        const battlemetricsId = scopeBattlemetricsId(scope);
        const battlemetrics = context.client && context.client.battlemetricsInstances &&
            context.client.battlemetricsInstances[battlemetricsId];
        const reliable = Boolean(battlemetrics && battlemetrics.lastUpdateSuccessful === true &&
            battlemetrics.streamerMode !== true);
        const prior = previous && previous.presence;
        if (!reliable) {
            return { ...unknownPresence(previous), observedAt };
        }

        const live = battlemetrics.players && battlemetrics.players[battlemetricsPlayerId];
        const status = live && typeof live.status === 'boolean' ?
            (live.status ? 'online' : 'offline') : 'offline';
        let lastSeenAt = prior ? prior.lastSeenAt : null;
        if (status === 'online') lastSeenAt = observedAt;
        else if (live && live.logoutDate && !Number.isNaN(Date.parse(live.logoutDate))) {
            lastSeenAt = new Date(live.logoutDate).toISOString();
        }
        else if (prior && prior.status === 'online') lastSeenAt = observedAt;
        return { source: 'battlemetrics', status, lastKnownStatus: status, observedAt, lastSeenAt };
    }

    function linkBattlemetricsPlayer(context, scope, link) {
        try {
            if (!enabled || !context || !context.guildId || !isObject(link)) {
                return unavailable('invalid link');
            }
            const steamId = `${link.steamId || ''}`;
            const battlemetricsPlayerId = `${link.battlemetricsPlayerId || ''}`;
            const name = typeof link.name === 'string' ? link.name.trim() : '';
            if (!/^7656119\d{10}$/.test(steamId) || !/^\d+$/.test(battlemetricsPlayerId) || !name) {
                return unavailable('invalid link');
            }
            const catalogue = readCatalogCache();
            if (!catalogue || catalogue.servers.length === 0) return unavailable('server cache missing');
            const server = selectServer(catalogue.servers, scope);
            if (!server) return unavailable('server not supported');
            const path = sidecarPath(context.guildId, server);
            if (!fs.existsSync(path)) return unavailable('identity cache missing');
            const sidecar = readSidecar(context.guildId, server);
            const index = sidecar.players.findIndex(player => player.identity &&
                player.identity.steamId === steamId);
            if (index === -1) return unavailable('identity cache missing');
            const previous = sidecar.players[index];
            const aliases = previous.identity.aliases || [];
            if (normalize(previous.identity.name) !== normalize(name) &&
                !aliases.some(alias => normalize(alias) === normalize(name))) {
                return unavailable('identity name mismatch');
            }
            const observedAt = dateNow().toISOString();
            const record = {
                ...previous,
                identity: {
                    ...previous.identity,
                    battlemetricsPlayerId,
                    name,
                    aliases: [...new Set([...aliases, name])]
                },
                presence: battlemetricsPresence(
                    context, scope, battlemetricsPlayerId, previous, observedAt)
            };
            sidecar.players[index] = record;
            sidecar.updatedAt = observedAt;
            writeJsonAtomic(path, sidecar);
            return deepFreeze({ available: true, reason: null,
                identity: record.identity, presence: record.presence });
        }
        catch (error) {
            log(context, `BattleMetrics link skipped safely: ${error.message}.`);
            return unavailable('link failed');
        }
    }

    return Object.freeze({
        ensureServerCatalog,
        linkBattlemetricsPlayer,
        resolvePlayer
    });
}

const singleton = createProvider();

module.exports = Object.freeze({
    createProvider,
    ensureServerCatalog: context => singleton.ensureServerCatalog(context),
    linkBattlemetricsPlayer: (context, scope, link) =>
        singleton.linkBattlemetricsPlayer(context, scope, link),
    parseServerCatalog,
    parseStatsPayload,
    resolvePlayer: (context, scope, query) => singleton.resolvePlayer(context, scope, query),
    selectPlayer,
    selectServer
});
