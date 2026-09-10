/* Read-only BattleMetrics API provider for the detached player-tracker plugin. */

const Axios = require('axios');

const Config = require('../../../config');

const API_ROOT = 'https://api.battlemetrics.com';
const API_TIMEOUT_MS = 5000;
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;
const MAX_PLAYER_NAME_LENGTH = 128;
const MAX_RELATED_PLAYERS = 10;
const MAX_SESSIONS = 10;
const cache = new Map();
const inFlight = new Map();
const clientIds = new WeakMap();
const cooldowns = new Map();
let nextClientId = 1;

class BattlemetricsApiError extends Error {
    constructor(reason, status = null, retryAt = null) {
        super(reason);
        this.name = 'BattlemetricsApiError';
        this.reason = reason;
        this.status = status;
        this.retryAt = retryAt;
    }
}

function immutable(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) immutable(child);
    return Object.freeze(value);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeName(value) {
    const name = `${value || ''}`.replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ').trim();
    return name.length > 0 && name.length <= MAX_PLAYER_NAME_LENGTH ? name : null;
}

function toIsoDate(value) {
    if (typeof value !== 'string' && !(value instanceof Date)) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNonNegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function getNow(dependencies) {
    const now = (dependencies.now || (() => new Date()))();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('Invalid clock.');
    return now;
}

function getToken(dependencies) {
    const raw = dependencies.token !== undefined ? dependencies.token : Config.battlemetrics.token;
    if (typeof raw !== 'string') throw new TypeError('BattleMetrics token must be a string.');
    const token = raw.trim();
    if (token.length === 0) throw new BattlemetricsApiError('token missing');
    if (token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
        throw new BattlemetricsApiError('token invalid');
    }
    return token;
}

function validateId(value, label) {
    const id = `${value || ''}`;
    if (!/^\d+$/.test(id)) throw new TypeError(`${label} must be a numeric BattleMetrics ID.`);
    return id;
}

function validateDocument(document, collection, allowMissingPrimary = false) {
    const validPrimary = collection ? Array.isArray(document && document.data) :
        isObject(document && document.data);
    if (!isObject(document) || (!validPrimary &&
        !(allowMissingPrimary && document.data === undefined && Array.isArray(document.included)))) {
        throw new BattlemetricsApiError('invalid response');
    }
    if (document.included !== undefined && !Array.isArray(document.included)) {
        throw new BattlemetricsApiError('invalid response');
    }
    return document;
}

function parseRetryAt(headers, now) {
    const source = headers || {};
    const retryAfter = source['retry-after'] !== undefined ? source['retry-after'] : source['Retry-After'];
    const reset = source['x-ratelimit-reset'] !== undefined ?
        source['x-ratelimit-reset'] : source['X-RateLimit-Reset'];
    let retryAtMs = null;
    if (retryAfter !== undefined) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) retryAtMs = now.getTime() + (seconds * 1000);
        else {
            const parsed = Date.parse(`${retryAfter}`);
            if (!Number.isNaN(parsed)) retryAtMs = parsed;
        }
    }
    if (retryAtMs === null && reset !== undefined) {
        const parsed = Number(reset);
        if (Number.isFinite(parsed) && parsed > 0) retryAtMs = parsed > 100000000000 ? parsed : parsed * 1000;
    }
    const minimum = now.getTime() + 60000;
    const maximum = now.getTime() + (60 * 60 * 1000);
    return new Date(Math.min(maximum, Math.max(minimum, retryAtMs || minimum))).toISOString();
}

function normalizeHttpError(error, dependencies, cooldownKey) {
    if (error instanceof BattlemetricsApiError) return error;
    const status = error && error.response && Number(error.response.status);
    if (Number.isInteger(status)) {
        if (status === 401) return new BattlemetricsApiError('token invalid', status);
        if (status === 403) return new BattlemetricsApiError('subscription or permission denied', status);
        if (status === 404) return new BattlemetricsApiError('not found', status);
        if (status === 429) {
            const retryAt = parseRetryAt(error.response.headers, getNow(dependencies));
            cooldowns.set(cooldownKey, Math.max(cooldowns.get(cooldownKey) || 0, Date.parse(retryAt)));
            return new BattlemetricsApiError('HTTP 429', status, retryAt);
        }
        return new BattlemetricsApiError(`HTTP ${status}`, status);
    }
    if (error && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')) {
        return new BattlemetricsApiError('timeout');
    }
    return new BattlemetricsApiError('request failed');
}

function stableParams(params) {
    return Object.entries(params || {}).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(`${value}`)}`).join('&');
}

async function requestDocument(path, params, dependencies = {}, options = {}) {
    if (typeof path !== 'string' || !/^\/[a-z0-9/_-]+$/i.test(path) || path.includes('..')) {
        throw new TypeError('Invalid BattleMetrics API path.');
    }
    const now = getNow(dependencies);
    const token = getToken(dependencies);
    const httpClient = dependencies.httpClient || Axios;
    if (!clientIds.has(httpClient)) clientIds.set(httpClient, nextClientId++);
    const clientId = clientIds.get(httpClient);
    const cooldownUntilMs = cooldowns.get(clientId) || 0;
    if (cooldownUntilMs > now.getTime()) {
        throw new BattlemetricsApiError('HTTP 429', 429, new Date(cooldownUntilMs).toISOString());
    }
    const key = `${clientId}:${path}?${stableParams(params)}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now.getTime()) return cached.document;
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
        try {
            const response = await httpClient.get(`${API_ROOT}${path}`, {
                headers: {
                    Accept: 'application/vnd.api+json',
                    Authorization: `Bearer ${token}`,
                    'User-Agent': 'rustplusplus-player-tracker'
                },
                params,
                timeout: API_TIMEOUT_MS,
                maxContentLength: MAX_CONTENT_LENGTH,
                maxRedirects: 0
            });
            if (Number.isInteger(response && response.status) &&
                (response.status < 200 || response.status >= 300)) {
                const statusError = new Error('HTTP failure');
                statusError.response = response;
                throw statusError;
            }
            const document = validateDocument(response && response.data, options.collection === true,
                options.allowMissingPrimary === true);
            const frozen = immutable(document);
            if (Number.isFinite(options.cacheTtlMs) && options.cacheTtlMs > 0) {
                cache.set(key, Object.freeze({
                    expiresAt: now.getTime() + options.cacheTtlMs,
                    document: frozen
                }));
            }
            return frozen;
        }
        catch (error) {
            throw normalizeHttpError(error, dependencies, clientId);
        }
        finally {
            inFlight.delete(key);
        }
    })();
    inFlight.set(key, promise);
    return promise;
}

function failed(error) {
    const normalized = error instanceof BattlemetricsApiError ? error : new BattlemetricsApiError('request failed');
    return immutable({
        available: false,
        reason: normalized.reason,
        status: normalized.status,
        retryAt: normalized.retryAt
    });
}

function getServerRelation(entity, serverId) {
    const servers = entity && entity.relationships && entity.relationships.servers &&
        entity.relationships.servers.data;
    if (!Array.isArray(servers)) return null;
    return servers.find(server => server && `${server.id}` === serverId) || null;
}

async function searchPlayers(scope, query, dependencies = {}) {
    try {
        const serverId = validateId(scope && scope.battlemetricsId, 'Server ID');
        const search = sanitizeName(query);
        if (!search || search.length > 64) throw new TypeError('Invalid BattleMetrics player query.');
        const document = await requestDocument('/players', {
            'filter[search]': search,
            'filter[servers]': serverId,
            'page[size]': 10,
            include: 'server'
        }, dependencies, { collection: true });
        const normalizedQuery = search.normalize('NFKC').toLocaleLowerCase('en');
        const candidates = [];
        let invalidRelationships = 0;
        for (const entity of document.data) {
            const name = sanitizeName(entity && entity.attributes && entity.attributes.name);
            const playerId = entity && `${entity.id || ''}`;
            if (!name || !/^\d+$/.test(playerId)) continue;
            const relation = getServerRelation(entity, serverId);
            if (!relation) {
                invalidRelationships += 1;
                continue;
            }
            if (playerId !== search &&
                !name.normalize('NFKC').toLocaleLowerCase('en').includes(normalizedQuery)) continue;
            const online = relation.meta && relation.meta.online;
            candidates.push(immutable({
                playerId,
                name,
                status: typeof online === 'boolean' ? (online ? 'online' : 'offline') : 'unknown',
                lastSeenAt: toIsoDate(relation.meta && relation.meta.lastSeen),
                steamId: null
            }));
        }
        if (candidates.length === 0 && document.data.length > 0 && invalidRelationships > 0) {
            throw new BattlemetricsApiError('invalid response');
        }
        const pagination = document.meta && document.meta.pagination;
        const total = toNonNegativeInteger(pagination && pagination.total);
        return immutable({
            available: true,
            reason: null,
            candidates,
            truncated: Boolean(document.links && document.links.next) ||
                (total !== null && total > document.data.length)
        });
    }
    catch (error) {
        return failed(error);
    }
}

function parseSteamId(document) {
    if (!document || !Array.isArray(document.included)) return null;
    for (const entity of document.included) {
        if (!entity || entity.type !== 'identifier' || !isObject(entity.attributes)) continue;
        const type = `${entity.attributes.type || ''}`.toLocaleLowerCase('en').replace(/[^a-z0-9]/g, '');
        const identifier = `${entity.attributes.identifier || ''}`;
        if (type === 'steamid' && /^7656119\d{10}$/.test(identifier)) return identifier;
    }
    return null;
}

async function resolveSteamId(playerId, dependencies = {}) {
    try {
        const id = validateId(playerId, 'Player ID');
        const document = await requestDocument(`/players/${id}`, { include: 'identifier' }, dependencies,
            { cacheTtlMs: 10 * 60 * 1000, allowMissingPrimary: true });
        return immutable({ available: true, reason: null, steamId: parseSteamId(document) });
    }
    catch (error) {
        return failed(error);
    }
}

function mergeMetadata(entity, serverId) {
    const relation = getServerRelation(entity, serverId);
    return Object.assign({}, isObject(entity && entity.attributes) ? entity.attributes : {},
        isObject(entity && entity.meta) ? entity.meta : {},
        isObject(relation && relation.meta) ? relation.meta : {});
}

function firstValue(source, keys) {
    for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    return null;
}

function parseServerPlayer(document, playerId, serverId) {
    const entity = document.data;
    const metadata = mergeMetadata(entity, serverId);
    const online = firstValue(metadata, ['online', 'connected']);
    const name = sanitizeName(firstValue(metadata, ['name', 'displayName']));
    return immutable({
        battlemetricsPlayerId: playerId,
        battlemetricsServerId: serverId,
        name,
        online: typeof online === 'boolean' ? online : null,
        firstSeenAt: toIsoDate(firstValue(metadata, ['firstSeen', 'firstSeenAt'])),
        lastSeenAt: toIsoDate(firstValue(metadata, ['lastSeen', 'lastSeenAt'])),
        timePlayedSeconds: toNonNegativeInteger(firstValue(metadata,
            ['timePlayed', 'timePlayedSeconds', 'playTime', 'duration']))
    });
}

async function getServerPlayer(playerId, serverId, dependencies = {}) {
    try {
        const validPlayerId = validateId(playerId, 'Player ID');
        const validServerId = validateId(serverId, 'Server ID');
        const document = await requestDocument(`/players/${validPlayerId}/servers/${validServerId}`, {},
            dependencies, { cacheTtlMs: 5 * 60 * 1000 });
        return immutable({
            available: true,
            reason: null,
            player: parseServerPlayer(document, validPlayerId, validServerId)
        });
    }
    catch (error) {
        return failed(error);
    }
}

function relationId(entity, name) {
    const data = entity && entity.relationships && entity.relationships[name] &&
        entity.relationships[name].data;
    if (Array.isArray(data)) return null;
    return data && data.id !== undefined ? `${data.id}` : null;
}

function parseSessions(document, playerId, serverId) {
    const sessions = [];
    for (const entity of document.data) {
        if (!entity || !['session', 'playerSession'].includes(`${entity.type || ''}`) ||
            !isObject(entity.attributes)) continue;
        const relatedServerId = relationId(entity, 'server') || `${entity.attributes.serverId || ''}`;
        if (relatedServerId !== serverId) continue;
        const relatedPlayerId = relationId(entity, 'player');
        if (relatedPlayerId && relatedPlayerId !== playerId) continue;
        const startAt = toIsoDate(firstValue(entity.attributes, ['start', 'startAt', 'startedAt']));
        const stopAt = toIsoDate(firstValue(entity.attributes, ['stop', 'stopAt', 'stoppedAt']));
        const sessionId = `${entity.id || ''}`;
        if (!sessionId || sessionId.length > 128 || !startAt) continue;
        const durationSeconds = stopAt ? Math.max(0,
            Math.floor((Date.parse(stopAt) - Date.parse(startAt)) / 1000)) : null;
        sessions.push(immutable({
            id: sessionId,
            startAt,
            stopAt,
            durationSeconds
        }));
    }
    sessions.sort((left, right) => Date.parse(right.startAt) - Date.parse(left.startAt));
    return immutable(sessions.slice(0, MAX_SESSIONS));
}

async function getSessions(playerId, serverId, dependencies = {}) {
    try {
        const validPlayerId = validateId(playerId, 'Player ID');
        const validServerId = validateId(serverId, 'Server ID');
        const document = await requestDocument(`/players/${validPlayerId}/relationships/sessions`, {
            'filter[servers]': validServerId,
            'page[size]': MAX_SESSIONS,
            include: 'server'
        }, dependencies, { collection: true, cacheTtlMs: 5 * 60 * 1000 });
        return immutable({
            available: true,
            reason: null,
            sessions: parseSessions(document, validPlayerId, validServerId),
            truncated: Boolean(document.links && document.links.next)
        });
    }
    catch (error) {
        return failed(error);
    }
}

function includedPlayers(document) {
    const players = new Map();
    for (const entity of document.included || []) {
        if (!entity || entity.type !== 'player' || !/^\d+$/.test(`${entity.id || ''}`)) continue;
        const name = sanitizeName(entity.attributes && entity.attributes.name);
        if (name) players.set(`${entity.id}`, name);
    }
    return players;
}

function numericAttribute(attributes, keys) {
    return toNonNegativeInteger(firstValue(attributes, keys));
}

function parseRelatedPlayers(document, targetPlayerId, serverId) {
    const names = includedPlayers(document);
    const related = [];
    const seen = new Set();
    for (const entity of document.data) {
        if (!entity || !isObject(entity.attributes)) continue;
        const playerRelation = relationId(entity, 'player');
        const candidateId = entity.type === 'player' ? `${entity.id || ''}` :
            (playerRelation || `${entity.attributes.playerId || ''}`);
        if (!/^\d+$/.test(candidateId) || candidateId === targetPlayerId || seen.has(candidateId)) continue;
        const relatedServerId = relationId(entity, 'server') || `${entity.attributes.serverId || ''}`;
        if (relatedServerId && relatedServerId !== serverId) continue;
        const name = sanitizeName(entity.attributes.name) || names.get(candidateId) || `BM:${candidateId}`;
        related.push(immutable({
            battlemetricsPlayerId: candidateId,
            name,
            overlapSeconds: numericAttribute(entity.attributes,
                ['timePlayed', 'overlap', 'duration', 'value', 'seconds']),
            sessionCount: numericAttribute(entity.attributes, ['sessions', 'sessionCount', 'count'])
        }));
        seen.add(candidateId);
    }
    related.sort((left, right) => (right.overlapSeconds || 0) - (left.overlapSeconds || 0) ||
        (right.sessionCount || 0) - (left.sessionCount || 0) || left.name.localeCompare(right.name));
    return immutable(related.slice(0, MAX_RELATED_PLAYERS));
}

async function getRelatedPlayers(playerId, serverId, dependencies = {}) {
    try {
        const validPlayerId = validateId(playerId, 'Player ID');
        const validServerId = validateId(serverId, 'Server ID');
        const document = await requestDocument(`/players/${validPlayerId}/relationships/coplay`, {
            'filter[servers]': validServerId,
            'page[size]': MAX_RELATED_PLAYERS,
            include: 'player,server'
        }, dependencies, { collection: true, cacheTtlMs: 10 * 60 * 1000 });
        return immutable({
            available: true,
            reason: null,
            players: parseRelatedPlayers(document, validPlayerId, validServerId),
            truncated: Boolean(document.links && document.links.next)
        });
    }
    catch (error) {
        return failed(error);
    }
}

function resetForTests() {
    cache.clear();
    inFlight.clear();
    cooldowns.clear();
}

module.exports = Object.freeze({
    API_TIMEOUT_MS,
    getRelatedPlayers,
    getServerPlayer,
    getSessions,
    parseRelatedPlayers,
    parseServerPlayer,
    parseSessions,
    parseSteamId,
    resolveSteamId,
    searchPlayers,
    resetForTests
});
