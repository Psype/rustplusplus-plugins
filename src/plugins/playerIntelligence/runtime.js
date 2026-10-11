// @ts-check
const Crypto = require('node:crypto');
const Path = require('node:path');

const BoundedTtlCache = require('../../util/boundedTtlCache.js');
const Scrape = require('../../util/scrape.js');
const BattlemetricsProvider = require('../battlemetrics');
const Core = require('./index.js');
const F7IdentityValidation = require('./f7IdentityValidation.js');
const IdentityAdministration = require('./identityAdministration.js');
const PlayerScanDaemon = require('./scanDaemon.js');
const PlayerNameReconciler = require('../../util/playerNameReconciler.js');

const COLLECTOR_VERSION = 'player-intelligence-1';
const DATA_DIRECTORY = Path.join(__dirname, '..', '..', '..', 'data', 'player-intelligence');
const MAX_QUERY_LENGTH = 128;
const IN_GAME_BUDGET = 122;
const HOOK_STATE_MAX_ENTRIES = 32;
const HOOK_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const HOOK_ONLINE_IDENTITY_LIMIT = 2000;
const HOOK_APPEND_BATCH_LIMIT = 5000;
// Stable candidates are copied into a process-isolated job queue. Keep every job finite; tracker evidence is
// admitted first, then only the most recently recorded legacy CSV rows fill the remaining capacity.
const MAX_TRACKER_IDENTITY_CANDIDATES = 2048;
const MAX_LEGACY_IDENTITY_CANDIDATES = 10000;
const MAX_STABLE_IDENTITY_CANDIDATES =
    MAX_TRACKER_IDENTITY_CANDIDATES + MAX_LEGACY_IDENTITY_CANDIDATES;
const STABLE_CANDIDATE_WARNING_MAX_ENTRIES = 64;
const STABLE_CANDIDATE_WARNING_TTL_MS = 60 * 60 * 1000;
const hookStates = BoundedTtlCache.createBoundedTtlCache({
    maxEntries: HOOK_STATE_MAX_ENTRIES, defaultTtlMs: HOOK_STATE_TTL_MS
});
const stableCandidateWarningTimes = BoundedTtlCache.createBoundedTtlCache({
    maxEntries: STABLE_CANDIDATE_WARNING_MAX_ENTRIES,
    defaultTtlMs: STABLE_CANDIDATE_WARNING_TTL_MS
});

/** @param {any} context @returns {any} */
function getDependencies(context) {
    return context.playerIntelligenceDependencies || context.client.playerIntelligenceDependencies || {};
}

/** @param {unknown} value */
function normalize(value) {
    return `${value || ''}`.normalize('NFKC').trim().toLocaleLowerCase('en');
}

/** @param {unknown} value */
function sanitize(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** @param {string[]} values */
function stableFingerprint(values) {
    const hash = Crypto.createHash('sha256');
    for (const value of values.sort()) hash.update(`${value.length}:`, 'utf8').update(value, 'utf8');
    return hash.digest('hex');
}

/** @param {any} battlemetrics @param {string} playerId @param {{id:string,name:string|null}|null} [fallback] */
function battlemetricsIdentity(battlemetrics, playerId, fallback = null) {
    if (!/^\d{1,32}$/u.test(`${playerId}`)) return null;
    const current = bmPlayer(battlemetrics, playerId);
    if (current) return current;
    const fallbackName = fallback && `${fallback.id}` === `${playerId}` ? sanitize(fallback.name) || null : null;
    return Object.freeze({ steamId: null, battlemetricsPlayerId: `${playerId}`, name: fallbackName });
}

/** @param {any} battlemetrics */
function onlineBattlemetricsSnapshot(battlemetrics) {
    const source = Array.isArray(battlemetrics && battlemetrics.onlinePlayers) ?
        battlemetrics.onlinePlayers : Object.values(battlemetrics && battlemetrics.players || {})
            .filter((/** @type {any} */ player) => player && player.status === true)
            .map((/** @type {any} */ player) => player.id);
    let complete = source.length <= HOOK_ONLINE_IDENTITY_LIMIT;
    const values = new Map();
    for (const rawId of source.slice(0, HOOK_ONLINE_IDENTITY_LIMIT)) {
        const id = `${rawId && typeof rawId === 'object' ? rawId.id : rawId || ''}`;
        if (!/^\d{1,32}$/u.test(id)) {
            complete = false;
            continue;
        }
        if (values.has(id)) continue;
        const identity = bmPlayer(battlemetrics, id);
        values.set(id, Object.freeze({ id, name: identity ? identity.name : null }));
    }
    const identities = Object.freeze([...values.values()].sort((left, right) =>
        left.id.localeCompare(right.id, 'en', { numeric: true })));
    return Object.freeze({ complete, identities, ids: Object.freeze(identities.map(identity => identity.id)) });
}

/** @param {any} battlemetrics @param {readonly {id:string,name:string|null}[]} online */
function battlemetricsHookFingerprint(battlemetrics, online) {
    const values = online.map(identity => `online:${identity.id}:${identity.name}`);
    // Login/logout/new-player arrays are transient hints already represented by the authoritative roster. Keeping
    // them in the fingerprint would replay an unchanged sample after those arrays are cleared. Offline name changes
    // are the only delta-only input that produces an event, so retain just their current semantic value.
    const changed = Array.isArray(battlemetrics && battlemetrics.nameChangedPlayers) ?
        battlemetrics.nameChangedPlayers : [];
    for (const row of changed.slice(0, HOOK_ONLINE_IDENTITY_LIMIT)) {
        const id = `${row && typeof row === 'object' ? row.id : row || ''}`;
        if (!/^\d{1,32}$/u.test(id)) continue;
        const player = battlemetrics && battlemetrics.players && battlemetrics.players[id];
        const name = sanitize(player && player.name || row && typeof row === 'object' && row.name || '');
        const status = player && typeof player.status === 'boolean' ? `${player.status}` : 'unknown';
        values.push(`changed:${id}:${name}:${status}`);
    }
    return stableFingerprint(values);
}

/** @param {any} store @param {readonly any[]} events */
async function appendHookEvents(store, events) {
    for (let offset = 0; offset < events.length; offset += HOOK_APPEND_BATCH_LIMIT) {
        await store.appendMany(events.slice(offset, offset + HOOK_APPEND_BATCH_LIMIT));
    }
}

/** @param {unknown} value */
function canonicalIso(value) {
    if (value === null || value === undefined || value === '') return null;
    let date;
    if (typeof value === 'number' && Number.isFinite(value)) {
        date = new Date(value < 100000000000 ? value * 1000 : value);
    }
    else if (typeof value === 'string' || value instanceof Date) date = new Date(value);
    else return null;
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** @param {{now?:()=>unknown}} dependencies */
function nowIso(dependencies = {}) {
    const value = (dependencies.now || (() => new Date()))();
    const iso = canonicalIso(value);
    if (!iso) throw new Error('Player-intelligence clock returned an invalid time.');
    return iso;
}

/** @param {unknown} value */
function parseCaptureTime(value) {
    if (typeof value !== 'string') throw new TypeError('Capture time must be a string.');
    const clean = value.trim();
    const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(clean);
    if (local) {
        const [year, month, day, hour, minute] = local.slice(1, 6).map(Number);
        const second = local[6] === undefined ? 0 : Number(local[6]);
        const normalized = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
        if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 ||
            normalized.getUTCDate() !== day || normalized.getUTCHours() !== hour ||
            normalized.getUTCMinutes() !== minute || normalized.getUTCSeconds() !== second) {
            throw new Error('Capture time is not a valid calendar date.');
        }
        return normalized.toISOString();
    }
    const explicit = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/u
        .exec(clean);
    if (!explicit) {
        throw new Error('Use YYYY-MM-DD HH:mm (GMT) or an ISO timestamp with an explicit offset.');
    }
    const [year, month, day, hour, minute, second = 0] = explicit.slice(1, 7).map(value => Number(value || 0));
    const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    const offsetHour = explicit[9] === undefined ? 0 : Number(explicit[9]);
    const offsetMinute = explicit[10] === undefined ? 0 : Number(explicit[10]);
    if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day ||
        wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second ||
        offsetHour > 23 || offsetMinute > 59) throw new Error('Capture time is not a valid calendar date.');
    const iso = canonicalIso(clean);
    if (!iso) throw new Error('Capture time is invalid.');
    return iso;
}

/** @param {string} observedAt */
function regularWipeStart(observedAt) {
    const capture = new Date(observedAt);
    for (let daysBack = 0; daysBack < 7; daysBack += 1) {
        const calendar = new Date(Date.UTC(capture.getUTCFullYear(), capture.getUTCMonth(),
            capture.getUTCDate() - daysBack));
        const weekday = calendar.getUTCDay();
        if (weekday !== 2 && weekday !== 5) continue;
        const boundary = new Date(Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(),
            calendar.getUTCDate(), 14, 0, 0)).toISOString();
        if (boundary <= observedAt) return boundary;
    }
    throw new Error('Unable to derive the regular WarBandits wipe boundary.');
}

/** @param {any} context @param {unknown} captureTime */
async function resolveHistoricalScope(context, captureTime) {
    const active = getScope(context);
    if (!active || !active.wipeId) throw new Error('Current server or wipe is unavailable.');
    const observedAt = parseCaptureTime(captureTime);
    const recordedAt = nowIso(getDependencies(context));
    if (observedAt > recordedAt) throw new Error('Capture time cannot be in the future.');
    const wipeStart = regularWipeStart(observedAt);
    return Object.freeze({
        ...active,
        wipeStart,
        wipeId: `wipe:${wipeStart}`,
        observedAt,
        historical: active.wipeId !== `wipe:${wipeStart}` || observedAt !== recordedAt
    });
}

/** @param {any} context @param {unknown} establishedAt */
function resolveEstablishedScope(context, establishedAt) {
    const active = getScope(context);
    if (!active || !active.wipeId) throw new Error('Current server or wipe is unavailable.');
    const established = canonicalIso(establishedAt);
    const recordedAt = nowIso(getDependencies(context));
    if (!established || established > recordedAt) throw new Error('Clan Established time is invalid or in the future.');
    const wipeStart = regularWipeStart(established);
    return Object.freeze({
        ...active,
        wipeStart,
        wipeId: `wipe:${wipeStart}`,
        observedAt: established,
        historical: active.wipeId !== `wipe:${wipeStart}`,
        inferredFromEstablished: true
    });
}

/** @param {any} context @returns {any} */
function getScope(context) {
    const instance = context.client.getInstance(context.guildId);
    if (!instance || !instance.serverList) return null;
    const preferred = context.rustplus && context.rustplus.serverId;
    const serverId = preferred !== null && preferred !== undefined && instance.serverList[preferred] ?
        preferred : instance.activeServer;
    const server = serverId !== null && serverId !== undefined ? instance.serverList[serverId] : null;
    const battlemetricsId = server && server.battlemetricsId !== null && server.battlemetricsId !== undefined ?
        `${server.battlemetricsId}` : '';
    if (!server || !/^\d+$/u.test(battlemetricsId)) return null;
    const battlemetrics = context.client.battlemetricsInstances &&
        context.client.battlemetricsInstances[battlemetricsId];
    const wipeStart = canonicalIso(context.rustplus && context.rustplus.info && context.rustplus.info.wipeTime) ||
        canonicalIso(battlemetrics && battlemetrics.server_rust_last_wipe);
    return Object.freeze({
        instance,
        server,
        serverId: `${serverId}`,
        battlemetricsId,
        battlemetrics,
        serverKey: `battlemetrics:${battlemetricsId}`,
        wipeStart,
        wipeId: wipeStart ? `wipe:${wipeStart}` : null
    });
}

/** @param {any} context @param {any} scope */
function getDataDirectory(context, scope) {
    const dependencies = getDependencies(context);
    const directory = dependencies.dataDirectory || DATA_DIRECTORY;
    const guild = `${context.guildId}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    return Path.join(directory, guild, scope.battlemetricsId);
}

/** @param {any} context @param {any} scope */
function getStore(context, scope) {
    const dependencies = getDependencies(context);
    if (dependencies.store) return dependencies.store;
    return new Core.JsonlHistoryStore({ directory: getDataDirectory(context, scope) });
}

/** @param {any} context @param {any} scope @param {any} store @param {any} dependencies
 * @param {readonly any[]|null} [identityCandidates] */
function playerScanOptions(context, scope, store, dependencies, identityCandidates = null) {
    const scanDependencies = { ...dependencies };
    if (!Object.hasOwn(scanDependencies, 'steamProfileIdentity')) {
        scanDependencies.steamProfileIdentity = (/** @type {string} */ steamId) =>
            Scrape.scrapeSteamProfileIdentity(context.client, steamId);
    }
    if (!Object.hasOwn(scanDependencies, 'battlemetricsProvider')) {
        scanDependencies.battlemetricsProvider = BattlemetricsProvider;
    }
    return Object.freeze({
        context,
        scope,
        store,
        directory: typeof store.directory === 'string' ? store.directory : getDataDirectory(context, scope),
        dependencies: Object.freeze(scanDependencies),
        warBanditsProvider: dependencies.warBanditsProvider || null,
        stableIdentityCandidates: identityCandidates || stableIdentityCandidates(context, scope, dependencies),
        // The global worker FIFO can outlive a wipe boundary. Re-evaluate the canonical runtime scope
        // when the job is dispatched and again before its parent-side commit.
        resolveCurrentScope: getScope,
        // A configured store/daemon is a test or integration seam and stays deterministic in-process.
        // The standard file-backed production scan is planned in a disposable read-only child process.
        isolateProcess: !dependencies.store && !dependencies.playerScanDaemon &&
            dependencies.playerScanIsolation !== false
    });
}

/** @param {any} context @param {any} scope @param {any} store @param {any} dependencies
 * @param {readonly any[]|null} [identityCandidates] */
function schedulePlayerScan(context, scope, store, dependencies, identityCandidates = null) {
    const hasStablePairs = Array.isArray(identityCandidates) && identityCandidates.some(identity =>
        identity && identity.steamId && identity.battlemetricsPlayerId);
    if (!dependencies.playerScanDaemon && !dependencies.warBanditsProvider && !hasStablePairs) return false;
    const daemon = dependencies.playerScanDaemon || PlayerScanDaemon;
    if (!daemon || typeof daemon.schedule !== 'function') return false;
    return daemon.schedule(playerScanOptions(context, scope, store, dependencies, identityCandidates));
}

/** @param {any} context @param {any} scope @param {any} store @param {any} dependencies */
function requestPlayerScan(context, scope, store, dependencies) {
    const daemon = dependencies.playerScanDaemon || PlayerScanDaemon;
    if (!daemon) return Object.freeze({ accepted: false, state: 'unavailable', retryAfterSeconds: 0 });
    const options = playerScanOptions(context, scope, store, dependencies);
    if (typeof daemon.requestRescan === 'function') return daemon.requestRescan(options);
    if (typeof daemon.schedule !== 'function') {
        return Object.freeze({ accepted: false, state: 'unavailable', retryAfterSeconds: 0 });
    }
    const started = daemon.schedule({ ...options, forceWarBanditsRescan: true });
    return Object.freeze({ accepted: true, state: started ? 'started' : 'queued', retryAfterSeconds: 0 });
}

/** @param {string} kind @param {any} scope @param {any} subject @param {any} payload @param {any} details */
function baseEvent(kind, scope, subject, payload, details) {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind,
        observedAt: details.observedAt,
        recordedAt: details.recordedAt,
        scope: { guildId: `${details.guildId}`, serverKey: scope.serverKey, wipeId: scope.wipeId },
        subject,
        payload,
        provenance: {
            source: details.source,
            sourceEventId: details.sourceEventId,
            collectorVersion: COLLECTOR_VERSION
        },
        confidence: details.confidence,
        evidence: details.evidence || null
    });
}

/** @param {any} scope @param {any} identity @param {any} details */
function identityEvent(scope, identity, details) {
    return baseEvent('identity_observed', scope, {
        steamId: identity.steamId || null,
        battlemetricsPlayerId: identity.battlemetricsPlayerId || null,
        exactName: identity.name || null
    }, { caseFidelity: identity.caseFidelity !== false }, details);
}

/** @param {any} projection @param {any} identity */
function consolidateIdentity(projection, identity) {
    const result = Core.consolidateProjection(projection, identity);
    return Object.freeze({
        ...result,
        identity: Object.freeze({
            ...identity,
            steamId: result.identity.steamId,
            battlemetricsPlayerId: result.identity.battlemetricsPlayerId,
            name: result.identity.name,
            caseFidelity: result.identity.caseFidelity
        })
    });
}

/** @param {any} scope @param {any} identity @param {string} state @param {any} details */
function presenceEvent(scope, identity, state, details) {
    return baseEvent('presence_observed', scope, {
        steamId: identity.steamId || null,
        battlemetricsPlayerId: identity.battlemetricsPlayerId || null,
        exactName: identity.name || null
    }, {
        state,
        providerSessionId: identity.providerSessionId || null,
        reason: state === 'unknown' ? details.reason || 'provider unavailable' : null
    }, details);
}

/** @param {any} scope @param {'available'|'unavailable'} state @param {any} details */
function providerAvailabilityEvent(scope, state, details) {
    return baseEvent('provider_availability_observed', scope,
        { steamId: null, battlemetricsPlayerId: null, exactName: null }, {
            state,
            reason: state === 'unavailable' ? details.reason || 'provider unavailable' : null
        }, details);
}

/** @param {any} scope @param {number} [limit] @param {()=>void} [onIncomplete] */
function trackedIdentities(scope, limit = Number.MAX_SAFE_INTEGER, onIncomplete = () => undefined) {
    const identities = [];
    for (const tracker of Object.values(scope.instance.trackers || {})) {
        if (!tracker || typeof tracker !== 'object') {
            onIncomplete();
            return Object.freeze([]);
        }
        if (tracker.managedBy !== 'player-tracker' || `${tracker.serverId}` !== scope.serverId ||
            `${tracker.battlemetricsId}` !== scope.battlemetricsId) continue;
        if (!Array.isArray(tracker.players)) {
            onIncomplete();
            return Object.freeze([]);
        }
        for (const player of tracker.players) {
            if (!player || typeof player !== 'object') {
                onIncomplete();
                return Object.freeze([]);
            }
            const rawSteamId = player && typeof player.steamId === 'string' && player.steamId.length === 17 ?
                player.steamId : '';
            const rawBattlemetricsPlayerId = player && typeof player.playerId === 'string' &&
                player.playerId.length <= 32 ? player.playerId : '';
            const rawName = player && typeof player.name === 'string' && player.name.length <= 256 ?
                player.name : '';
            const steamId = /^7656119\d{10}$/u.test(rawSteamId) ? rawSteamId : null;
            const battlemetricsPlayerId = /^\d{1,32}$/u.test(rawBattlemetricsPlayerId) ?
                rawBattlemetricsPlayerId : null;
            const name = sanitize(rawName);
            if (steamId && battlemetricsPlayerId && !name) {
                onIncomplete();
                return Object.freeze([]);
            }
            if (steamId && battlemetricsPlayerId && name) {
                identities.push(Object.freeze({ steamId, battlemetricsPlayerId, name }));
                if (identities.length >= limit) return Object.freeze(identities);
            }
        }
    }
    return Object.freeze(identities);
}

/** @param {any} context @param {any} scope @param {string} code @param {string} message */
function warnStableCandidatesOnce(context, scope, code, message) {
    const fingerprint = Crypto.createHash('sha256').update(JSON.stringify([
        scope.serverKey || scope.serverId || '', scope.wipeId || '', code
    ])).digest('hex');
    if (stableCandidateWarningTimes.has(fingerprint)) return;
    stableCandidateWarningTimes.set(fingerprint, true);
    try {
        if (context.rustplus && typeof context.rustplus.log === 'function') {
            context.rustplus.log('PLAYER_INTELLIGENCE', message, 'warn');
        }
        else if (context.client && typeof context.client.log === 'function') {
            context.client.log('PLAYER_INTELLIGENCE', message, 'warn');
        }
    }
    catch (_error) { /* Optional diagnostics must not make the live hook fail. */ }
}

/** @param {any} context @param {any} scope @param {any} dependencies */
function stableIdentityCandidates(context, scope, dependencies) {
    const candidates = new Map();
    /** @param {any} identity @param {'player-tracker'|'teammate-language-database'} source
     * @param {unknown} observedAt */
    function add(identity, source, observedAt) {
        const rawSteamId = identity && typeof identity.steamId === 'string' &&
            identity.steamId.length === 17 ? identity.steamId : '';
        const rawBattlemetricsPlayerId = identity && typeof identity.battlemetricsPlayerId === 'string' &&
            identity.battlemetricsPlayerId.length <= 32 ? identity.battlemetricsPlayerId : '';
        const rawName = identity && typeof identity.name === 'string' && identity.name.length <= 256 ?
            identity.name : '';
        const rawObservedAt = typeof observedAt === 'string' && observedAt.length <= 64 ? observedAt : null;
        const steamId = /^7656119\d{10}$/u.test(rawSteamId) ? rawSteamId : null;
        const battlemetricsPlayerId = /^\d{1,32}$/u.test(rawBattlemetricsPlayerId) ?
            rawBattlemetricsPlayerId : null;
        const name = sanitize(rawName);
        const canonicalObservedAt = canonicalIso(rawObservedAt);
        if (!steamId || !name || Array.from(name).length > 128 || !canonicalObservedAt) return;
        const fingerprint = Crypto.createHash('sha256').update(JSON.stringify([
            source, steamId, battlemetricsPlayerId, name, canonicalObservedAt
        ])).digest('hex');
        const key = `${source}\u0000${steamId}\u0000${battlemetricsPlayerId || ''}\u0000${name}`;
        const previous = candidates.get(key);
        if (previous && previous.observedAt >= canonicalObservedAt) return;
        candidates.set(key, Object.freeze({
            steamId, battlemetricsPlayerId, name, observedAt: canonicalObservedAt, source,
            sourceEventId: `stable:${source}:${fingerprint}`
        }));
    }
    let trackerIncomplete = false;
    const trackerIdentities = trackedIdentities(scope, MAX_TRACKER_IDENTITY_CANDIDATES + 1,
        () => { trackerIncomplete = true; });
    if (trackerIncomplete || trackerIdentities.length > MAX_TRACKER_IDENTITY_CANDIDATES) {
        warnStableCandidatesOnce(context, scope, trackerIncomplete ? 'tracker-incomplete' : 'tracker-overflow',
            trackerIncomplete ?
                'Stable identity candidates were skipped safely because the player tracker was incomplete.' :
                'Stable identity candidates were skipped safely because the player tracker exceeded its limit.');
        return Object.freeze([]);
    }
    for (const identity of trackerIdentities) {
        add(identity, 'player-tracker', scope.wipeStart || '1970-01-01T00:00:00.000Z');
    }
    const history = dependencies.identityHistory;
    let rows = [];
    let historyUnavailable = false;
    const hasHistory = history && typeof history.getIdentityRows === 'function';
    try {
        rows = hasHistory ? history.getIdentityRows({ guildId: context.guildId, serverId: scope.serverId },
            {
                limit: MAX_LEGACY_IDENTITY_CANDIDATES,
                onWarning: () => { historyUnavailable = true; }
            }) : [];
    }
    catch (_error) { historyUnavailable = true; }
    if (hasHistory && (historyUnavailable || !Array.isArray(rows) ||
        rows.length > MAX_LEGACY_IDENTITY_CANDIDATES)) {
        warnStableCandidatesOnce(context, scope, 'history-incomplete',
            'Stable identity candidates were skipped safely because identity history was not read completely.');
        return Object.freeze([]);
    }
    for (const identity of rows) {
        add(identity, 'teammate-language-database', identity && identity.observedAt);
    }
    return Object.freeze([...candidates.values()]);
}

/** @param {any} context */
async function identityCandidates(context) {
    const scope = getScope(context);
    if (!scope) return Object.freeze([]);
    const events = await getStore(context, scope).readAll();
    const projection = Core.rebuild(events);
    const effective = Core.effectiveEvents(events);
    const inputs = new Map();
    /** @param {any} value */
    function addInput(value) {
        const name = sanitize(value && value.name);
        const steamId = /^7656119\d{10}$/u.test(`${value && value.steamId || ''}`) ?
            `${value.steamId}` : null;
        const battlemetricsPlayerId = /^\d{1,32}$/u.test(`${value && value.battlemetricsPlayerId || ''}`) ?
            `${value.battlemetricsPlayerId}` : null;
        if (!name || (!steamId && !battlemetricsPlayerId)) return;
        const key = `${steamId || ''}\u0000${battlemetricsPlayerId || ''}\u0000${name}`;
        const previous = inputs.get(key);
        if (previous) {
            previous.caseFidelity = previous.caseFidelity || value.caseFidelity !== false;
            for (const tag of value.knownClanTags || []) previous.knownClanTags.add(tag);
            return;
        }
        inputs.set(key, {
            name, steamId, battlemetricsPlayerId,
            caseFidelity: value.caseFidelity !== false,
            knownClanTags: new Set(value.knownClanTags || [])
        });
    }
    for (const person of projection.identities.persons) {
        const knownClanTags = projection.clans.getKnownTags({
            steamId: person.steamId,
            battlemetricsPlayerId: person.battlemetricsPlayerIds[0] || null,
            exactName: person.names[0] ? person.names[0].name : null
        }).map((/** @type {any} */ tag) => normalize(tag.tag));
        for (const alias of person.names.filter((/** @type {any} */ alias) => alias.verified)) addInput({
            name: alias.name,
            steamId: person.steamId,
            battlemetricsPlayerId: person.battlemetricsPlayerIds[0] || null,
            caseFidelity: true,
            knownClanTags
        });
    }
    for (const event of effective) {
        if (event.kind !== 'identity_observed' || event.subject.exactName === null ||
            (event.subject.steamId === null && event.subject.battlemetricsPlayerId === null)) continue;
        addInput({
            name: event.subject.exactName,
            steamId: event.subject.steamId,
            battlemetricsPlayerId: event.subject.battlemetricsPlayerId,
            caseFidelity: event.payload.caseFidelity
        });
    }
    for (const value of trackedIdentities(scope)) addInput({ ...value, caseFidelity: true });
    for (const player of Object.values(scope.battlemetrics && scope.battlemetrics.players || {})) {
        const record = /** @type {any} */ (player);
        const name = sanitize(record && record.name);
        const battlemetricsPlayerId = /^\d{1,32}$/u.test(`${record && record.id || ''}`) ? `${record.id}` : null;
        const steamId = /^7656119\d{10}$/u.test(`${record && record.steamId || ''}`) ? `${record.steamId}` : null;
        if (name && (steamId || battlemetricsPlayerId)) addInput({
            name, steamId, battlemetricsPlayerId, caseFidelity: true
        });
    }
    for (const player of context.rustplus && context.rustplus.team && context.rustplus.team.players || []) {
        const name = sanitize(player && player.name);
        const steamId = /^7656119\d{10}$/u.test(`${player && player.steamId || ''}`) ? `${player.steamId}` : null;
        if (name && steamId) addInput({ name, steamId, battlemetricsPlayerId: null, caseFidelity: true });
    }
    const unique = new Map();
    for (const input of inputs.values()) {
        const value = Object.freeze({
            name: input.name,
            steamId: input.steamId,
            battlemetricsPlayerId: input.battlemetricsPlayerId,
            caseFidelity: input.caseFidelity,
            knownClanTags: Object.freeze([...input.knownClanTags].sort())
        });
        const consolidated = consolidateIdentity(projection, value);
        if (consolidated.status === 'conflict' || !consolidated.identity.name) continue;
        const identity = consolidated.identity;
        const key = `${identity.steamId || ''}\u0000${identity.battlemetricsPlayerId || ''}\u0000${identity.name}`;
        const previous = unique.get(key);
        unique.set(key, Object.freeze({
            name: identity.name,
            steamId: identity.steamId || null,
            battlemetricsPlayerId: identity.battlemetricsPlayerId || null,
            caseFidelity: Boolean(previous && previous.caseFidelity) || identity.caseFidelity !== false,
            knownClanTags: Object.freeze([...new Set([
                ...(previous && previous.knownClanTags || []), ...(value.knownClanTags || [])
            ])].sort())
        }));
    }
    return Object.freeze([...unique.values()].sort((left, right) =>
        left.name.localeCompare(right.name) || `${left.steamId || ''}`.localeCompare(`${right.steamId || ''}`)));
}

/**
 * Return only the identity candidates needed to describe the supplied SteamID64 values.
 * Unlike identityCandidates(), this does not walk every projected person, historical
 * observation, clan affinity, or consolidated candidate.
 *
 * @param {any} context
 * @param {readonly string[]} steamIds
 */
async function identityCandidatesBySteamIds(context, steamIds) {
    const scope = getScope(context);
    if (!scope) return Object.freeze([]);
    const requested = new Set((Array.isArray(steamIds) ? steamIds : [])
        .map(value => `${value}`)
        .filter(value => /^7656119\d{10}$/u.test(value)));
    if (requested.size === 0) return Object.freeze([]);

    const projection = Core.rebuild(await getStore(context, scope).readAll());
    const knownBattlemetricsBySteamId = new Map();
    for (const steamId of requested) {
        const ids = new Set(projection.identities.findByIdentifier(steamId)
            .filter((/** @type {any} */ person) => person.steamId === steamId)
            .flatMap((/** @type {any} */ person) => person.battlemetricsPlayerIds));
        knownBattlemetricsBySteamId.set(steamId, ids);
    }
    /** @type {any[]} */
    const values = [];
    /** @param {any} value */
    const add = value => {
        const steamId = /^7656119\d{10}$/u.test(`${value && value.steamId || ''}`) ?
            `${value.steamId}` : null;
        const name = sanitize(value && value.name);
        if (!steamId || !requested.has(steamId) || !name) return;
        const battlemetricsPlayerId = /^\d{1,32}$/u.test(`${value.battlemetricsPlayerId || ''}`) ?
            `${value.battlemetricsPlayerId}` : null;
        const knownBattlemetricsIds = knownBattlemetricsBySteamId.get(steamId);
        if (battlemetricsPlayerId && knownBattlemetricsIds && knownBattlemetricsIds.size > 0 &&
            !knownBattlemetricsIds.has(battlemetricsPlayerId)) return;
        const preferredName = sanitize(value && value.preferredName) || null;
        values.push({ name, steamId, battlemetricsPlayerId, preferredName,
            caseFidelity: value.caseFidelity !== false });
    };

    for (const steamId of requested) {
        for (const person of projection.identities.findByIdentifier(steamId)) {
            if (person.steamId !== steamId) continue;
            const preferredName = person.names.some((/** @type {any} */ alias) => alias.verified) ?
                projection.identities.displayName(person.personId) : null;
            const battlemetricsIds = person.battlemetricsPlayerIds.length > 0 ?
                person.battlemetricsPlayerIds : [null];
            for (const alias of person.names.filter((/** @type {any} */ item) => item.verified)) {
                for (const battlemetricsPlayerId of battlemetricsIds) {
                    add({ name: alias.name, steamId, battlemetricsPlayerId, preferredName, caseFidelity: true });
                }
            }
            // A current BattleMetrics name is authoritative for the preview even when the
            // provider record does not repeat the already-projected SteamID.
            for (const battlemetricsPlayerId of person.battlemetricsPlayerIds) {
                const player = scope.battlemetrics && scope.battlemetrics.players &&
                    scope.battlemetrics.players[battlemetricsPlayerId];
                const recordSteamId = /^7656119\d{10}$/u.test(`${player && player.steamId || ''}`) ?
                    `${player.steamId}` : null;
                if (player && (!recordSteamId || recordSteamId === steamId)) {
                    add({ name: player.name, steamId, battlemetricsPlayerId, caseFidelity: true });
                }
            }
        }
    }
    for (const identity of trackedIdentities(scope)) add(identity);
    for (const player of Object.values(scope.battlemetrics && scope.battlemetrics.players || {})) {
        const record = /** @type {any} */ (player);
        add({
            name: record && record.name,
            steamId: record && record.steamId,
            battlemetricsPlayerId: record && (record.id || null),
            caseFidelity: true
        });
    }
    for (const player of context.rustplus && context.rustplus.team && context.rustplus.team.players || []) {
        add({ name: player && player.name, steamId: player && player.steamId,
            battlemetricsPlayerId: null, caseFidelity: true });
    }

    const unique = new Map();
    for (const value of values) {
        const key = `${value.steamId}\u0000${value.battlemetricsPlayerId || ''}\u0000${value.name}`;
        const previous = unique.get(key);
        unique.set(key, Object.freeze({
            ...value,
            preferredName: previous && previous.preferredName || value.preferredName,
            caseFidelity: Boolean(previous && previous.caseFidelity) || value.caseFidelity !== false
        }));
    }
    return Object.freeze([...unique.values()].sort((left, right) =>
        left.steamId.localeCompare(right.steamId) || left.name.localeCompare(right.name) ||
        `${left.battlemetricsPlayerId || ''}`.localeCompare(`${right.battlemetricsPlayerId || ''}`)));
}

/** @param {any} battlemetrics @param {string} playerId */
function bmPlayer(battlemetrics, playerId) {
    const player = battlemetrics && battlemetrics.players && battlemetrics.players[playerId];
    const id = player && /^\d+$/u.test(`${player.id || playerId}`) ? `${player.id || playerId}` : null;
    const name = player && sanitize(player.name);
    return id && name ? Object.freeze({ steamId: null, battlemetricsPlayerId: id, name }) : null;
}

/** @param {any} context */
async function onBattlemetricsUpdated(context) {
    const scope = getScope(context);
    if (!scope || !scope.battlemetrics) return;
    const dependencies = getDependencies(context);
    const store = getStore(context, scope);
    const reliable = scope.battlemetrics.lastUpdateSuccessful === true &&
        scope.battlemetrics.streamerMode !== true;
    const stableCandidates = stableIdentityCandidates(context, scope, dependencies);
    const trackerIdentities = stableCandidates.filter(identity => identity.source === 'player-tracker');
    const legacyRows = stableCandidates.filter(identity => identity.source === 'teammate-language-database');
    const trackerFingerprint = stableFingerprint(trackerIdentities.map(identity =>
        `${identity.steamId}:${identity.battlemetricsPlayerId}:${identity.name}`));
    const legacyFingerprint = stableFingerprint(legacyRows.map((/** @type {any} */ identity) =>
        `${identity.observedAt}:${identity.steamId}:${identity.battlemetricsPlayerId || ''}:${identity.name}`)
    );
    const stateKey = typeof store.directory === 'string' ? store.directory : null;
    const hookTime = stateKey ? Date.parse(nowIso(dependencies)) : undefined;
    const cachedHookState = stateKey ? hookStates.get(stateKey, hookTime) : null;
    // A wipe changes only the authoritative roster scope. Stable tracker/history fingerprints describe identities,
    // so keep comparing them across wipes to avoid journalling identical aliases once per wipe.
    const previousIdentityState = cachedHookState;
    const previousHookState = cachedHookState && cachedHookState.wipeId === scope.wipeId ? cachedHookState : null;
    const onlineSnapshot = onlineBattlemetricsSnapshot(scope.battlemetrics);
    const presenceReliable = reliable && onlineSnapshot.complete;
    const availabilityMode = presenceReliable ? 'complete' : reliable ? 'incomplete' :
        scope.battlemetrics.streamerMode === true ? 'censored' : 'failed';
    const currentOnline = onlineSnapshot.identities;
    const currentOnlineIds = new Set(onlineSnapshot.ids);
    const deltaFingerprint = battlemetricsHookFingerprint(scope.battlemetrics, currentOnline);
    if (!context.firstTime && previousHookState && previousHookState.reliable === presenceReliable &&
        previousHookState.availabilityMode === availabilityMode &&
        previousHookState.wipeId === scope.wipeId && previousHookState.trackerFingerprint === trackerFingerprint &&
        previousHookState.legacyFingerprint === legacyFingerprint &&
        previousHookState.deltaFingerprint === deltaFingerprint) {
        hookStates.set(stateKey, previousHookState, HOOK_STATE_TTL_MS, hookTime);
        schedulePlayerScan(context, scope, store, dependencies, stableCandidates);
        return;
    }
    const recordedAt = nowIso(dependencies);
    const providerObservedAt = canonicalIso(scope.battlemetrics.updatedAt) || recordedAt;
    const previousRecordedAt = canonicalIso(previousHookState && previousHookState.recordedAt);
    const recoveringFromUntrustedPoll = presenceReliable && previousHookState &&
        ['failed', 'censored'].includes(previousHookState.availabilityMode);
    // On process startup the hook cache cannot reveal whether the durable journal ends in an outage. Use the local
    // startup clock for a complete authoritative sample, so it can never sort before an already-journalled failure.
    // Ordinary in-process cache expiry keeps provider time and therefore remains restart-idempotent.
    const coldStartupSample = presenceReliable && !previousHookState && context.firstTime === true;
    // A failed/censored poll is observed on our local clock because its provider timestamp is not trustworthy.
    // If BattleMetrics then recovers with an unchanged or older timestamp, keep the recovery causally after that
    // outage instead of letting projector ordering place the stale recovery before it.
    const observedAt = coldStartupSample || (recoveringFromUntrustedPoll && previousRecordedAt &&
        providerObservedAt <= previousRecordedAt) ? recordedAt : providerObservedAt;
    // BattleMetrics can reuse updatedAt while roster completeness or membership changes. Include the bounded
    // snapshot fingerprint so distinct samples remain distinct events, while an identical replay after restart
    // is still idempotent.
    const sampleKey = `${availabilityMode}:${observedAt}:${deltaFingerprint}`;
    const common = { guildId: context.guildId, observedAt, recordedAt, source: 'battlemetrics',
        confidence: 'verified', evidence: null };
    const stableIdentityScope = { ...scope, wipeId: null };
    const events = [];
    if (!previousIdentityState || previousIdentityState.legacyFingerprint !== legacyFingerprint) {
        for (const identity of legacyRows) {
            // Historical CSV identity evidence is server-wide, not wipe evidence. A null wipe scope keeps its
            // deterministic event ID stable across Tuesday/Friday boundaries and prevents thousands of aliases
            // from being appended again after every wipe.
            events.push(identityEvent(stableIdentityScope, { ...identity, battlemetricsPlayerId: null }, {
                guildId: context.guildId,
                observedAt: identity.observedAt,
                recordedAt,
                source: 'teammate-language-database',
                sourceEventId: `${identity.sourceEventId}:alias`,
                confidence: 'verified',
                evidence: null
            }));
        }
    }
    // Tracker/history evidence is local and stable: commit it even while BattleMetrics presence is unavailable.
    // Fingerprints are stored only after this shared event batch was durably appended, so recovery cannot mistake
    // a tracker change observed during an outage for evidence that was already journalled.
    if (!previousIdentityState || previousIdentityState.trackerFingerprint !== trackerFingerprint) {
        const trackerObservedAt = previousIdentityState &&
            previousIdentityState.trackerFingerprint !== trackerFingerprint ?
            recordedAt : scope.wipeStart || '1970-01-01T00:00:00.000Z';
        for (const identity of trackerIdentities) {
            events.push(identityEvent(scope, { ...identity, battlemetricsPlayerId: null }, {
                ...common,
                observedAt: trackerObservedAt,
                source: 'player-tracker',
                sourceEventId: `${identity.sourceEventId}:alias`,
                confidence: 'verified'
            }));
        }
    }

    if (!presenceReliable) {
        const previousOnline = new Map((previousHookState && previousHookState.onlineIdentities || [])
            .map((/** @type {{id:string,name:string|null}} */ identity) => [identity.id, identity]));
        // A successful but incomplete roster still contains valid positive presence. Failed or censored polls may
        // contain stale/redacted names and must never overwrite the last reliable cache.
        const availabilityChanged = !previousHookState || previousHookState.availabilityMode !== availabilityMode;
        if (availabilityChanged) {
            events.push(providerAvailabilityEvent(scope, 'unavailable', {
                ...common,
                observedAt: reliable ? observedAt : recordedAt,
                sourceEventId: `unavailable:${sampleKey}`,
                reason: scope.battlemetrics.streamerMode === true ? 'provider identities censored' :
                    !reliable ? 'provider update failed' : 'provider online snapshot incomplete'
            }));
        }
        if (reliable) {
            if (availabilityChanged) {
                // The global unavailable marker first makes the old complete roster unknown. Re-assert every valid
                // positive afterwards; absent identities need no individual unknown event on this first transition.
                for (const identity of currentOnline) {
                    const observed = battlemetricsIdentity(scope.battlemetrics, identity.id, identity);
                    if (!observed) continue;
                    events.push(identityEvent(scope, observed, {
                        ...common, sourceEventId: `poll:${sampleKey}:identity:${identity.id}`
                    }));
                    events.push(presenceEvent(scope, observed, 'online', {
                        ...common, sourceEventId: `poll:${sampleKey}:presence:online:${identity.id}`
                    }));
                }
            }
            else {
                // While the provider remains incomplete, emit only semantic deltas. Replaying every positive on
                // each partial poll made the journal grow with O(roster) duplicates and obscured actual changes.
                for (const [playerId, identity] of previousOnline) {
                    if (currentOnlineIds.has(playerId)) continue;
                    const observed = battlemetricsIdentity(scope.battlemetrics, playerId, identity);
                    if (!observed) continue;
                    events.push(presenceEvent(scope, observed, 'unknown', {
                        ...common,
                        reason: 'provider online snapshot incomplete',
                        sourceEventId: `partial:${sampleKey}:presence:unknown:${playerId}`
                    }));
                }
                for (const identity of currentOnline) {
                    const previous = previousOnline.get(identity.id);
                    const observed = battlemetricsIdentity(scope.battlemetrics, identity.id, identity);
                    if (!observed || (previous && previous.name === identity.name)) continue;
                    events.push(identityEvent(scope, observed, {
                        ...common, sourceEventId: `poll:${sampleKey}:identity:${identity.id}`
                    }));
                    if (!previous) events.push(presenceEvent(scope, observed, 'online', {
                        ...common, sourceEventId: `poll:${sampleKey}:presence:online:${identity.id}`
                    }));
                }
            }
        }
        if (events.length > 0) await appendHookEvents(store, events);
        if (stateKey) hookStates.set(stateKey, {
            reliable: presenceReliable, wipeId: scope.wipeId, trackerFingerprint, legacyFingerprint, deltaFingerprint,
            availabilityMode, recordedAt,
            onlineIdentities: reliable ? currentOnline : Object.freeze([])
        }, HOOK_STATE_TTL_MS, hookTime);
        schedulePlayerScan(context, scope, store, dependencies, stableCandidates);
        return;
    }

    const recovering = Boolean(previousHookState && previousHookState.availabilityMode !== 'complete');
    const previousOnline = new Map((previousHookState && previousHookState.onlineIdentities || [])
        .map((/** @type {{id:string,name:string|null}} */ identity) => [identity.id, identity]));
    const availability = !previousHookState || context.firstTime || recovering ?
        providerAvailabilityEvent(scope, 'available', {
            ...common,
            sourceEventId: `available:${sampleKey}`,
            reason: null
        }) : null;
    /** @type {string[]} */
    let onlineIds;
    /** @type {string[]} */
    let offlineIds;
    if (!previousHookState || context.firstTime || recovering) {
        onlineIds = [...currentOnlineIds];
        // The complete-roster availability marker closes every absent identity without materializing thousands of
        // redundant per-player offline observations.
        offlineIds = [];
    }
    else {
        onlineIds = [...currentOnlineIds].filter(id => !previousOnline.has(id));
        const explicitLogoutIds = (scope.battlemetrics.logoutPlayers || [])
            .map((/** @type {any} */ value) => `${value && typeof value === 'object' ? value.id : value}`)
            .filter((/** @type {string} */ id) => !currentOnlineIds.has(id) &&
                scope.battlemetrics.players && scope.battlemetrics.players[id]?.status === false);
        offlineIds = [...new Set([
            ...explicitLogoutIds,
            ...(onlineSnapshot.complete ? [...previousOnline.keys()].filter(id => !currentOnlineIds.has(id)) : [])
        ])];
    }
    const changedIds = [...new Set([
        ...(scope.battlemetrics.nameChangedPlayers || [])
            .map((/** @type {any} */ player) => `${player && typeof player === 'object' ? player.id : player}`),
        ...currentOnline.filter(identity => previousOnline.has(identity.id) &&
            previousOnline.get(identity.id).name !== identity.name).map(identity => identity.id)
    ])];
    /** @type {Map<string, 'online'|'offline'>} */
    const presenceStates = new Map();
    for (const id of onlineIds) presenceStates.set(`${id}`, 'online');
    for (const id of offlineIds) presenceStates.set(`${id}`, 'offline');
    const identityIds = new Set([...presenceStates.keys(),
        ...changedIds.map((/** @type {any} */ id) => `${id}`)]);
    for (const playerId of identityIds) {
        const observed = battlemetricsIdentity(scope.battlemetrics, playerId, previousOnline.get(playerId) || null);
        if (!observed) continue;
        events.push(identityEvent(scope, observed, {
            ...common, sourceEventId: `poll:${sampleKey}:identity:${playerId}`
        }));
    }
    for (const [playerId, state] of presenceStates) {
        const observed = battlemetricsIdentity(scope.battlemetrics, playerId, previousOnline.get(playerId) || null);
        if (!observed) continue;
        events.push(presenceEvent(scope, observed, state, {
            ...common, sourceEventId: `poll:${sampleKey}:presence:${state}:${playerId}`
        }));
    }
    if (scope.wipeId && !previousHookState) {
        events.push(baseEvent('wipe_snapshot', scope,
            { steamId: null, battlemetricsPlayerId: null, exactName: null },
            { startsAt: scope.wipeStart, endsAt: null }, {
                ...common, observedAt: scope.wipeStart,
                sourceEventId: `wipe:${scope.wipeId}`, confidence: 'verified'
            }));
    }
    // Commit the complete-roster marker after every positive presence. If a chunked append is interrupted, the
    // durable prefix remains conservative (possibly stale/unknown) and can never fabricate an offline player.
    if (availability) events.push(availability);
    if (events.length > 0) await appendHookEvents(store, events);
    if (stateKey) hookStates.set(stateKey, {
        reliable: presenceReliable, wipeId: scope.wipeId, trackerFingerprint, legacyFingerprint, deltaFingerprint,
        availabilityMode, recordedAt,
        onlineIdentities: currentOnline
    }, HOOK_STATE_TTL_MS, hookTime);
    schedulePlayerScan(context, scope, store, dependencies, stableCandidates);
}

/** @param {any} context */
function parseCommand(context) {
    const raw = context.command.trim();
    if (!raw.startsWith(context.prefix)) return null;
    const body = raw.slice(context.prefix.length).trim();
    const separator = body.search(/\s/u);
    const name = normalize(separator === -1 ? body : body.slice(0, separator));
    const query = sanitize(separator === -1 ? '' : body.slice(separator + 1));
    if (!['intel', 'steamid', 'who', 'record', 'scanplayers', 'affinity', 'activity', 'clan',
        'clanhistory', 'clantop'].includes(name)) return null;
    return Object.freeze({ name, query });
}

/** @param {string} query */
function parseManualIdentity(query) {
    const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(query);
    if (!match) return null;
    const steamId = match[1];
    const battlemetricsPlayerId = match[2];
    const name = sanitize(match[3]);
    if (!F7IdentityValidation.isValidSteamId64(steamId) ||
        !/^\d{1,32}$/u.test(battlemetricsPlayerId) || !name || Array.from(name).length > MAX_QUERY_LENGTH) {
        return null;
    }
    return Object.freeze({ steamId, battlemetricsPlayerId, name });
}

/** @param {any} context @param {any} scope @param {any} store @param {any} identity */
async function recordManualIdentity(context, scope, store, identity) {
    const projection = Core.rebuild(await store.readAll());
    const consolidated = consolidateIdentity(projection, identity);
    if (consolidated.status === 'conflict') {
        const battlemetricsMatches = projection.identities.findByIdentifier(identity.battlemetricsPlayerId);
        const [conflictSteamId] = [...new Set(battlemetricsMatches
            .map((/** @type {any} */ person) => person.steamId).filter(Boolean))]
            .filter((/** @type {string} */ steamId) => steamId !== identity.steamId);
        return Object.freeze({ appended: false, conflictSteamId: conflictSteamId || identity.steamId });
    }
    const exact = projection.identities.findByIdentifier(consolidated.identity.steamId)
        .some((/** @type {any} */ person) =>
            person.battlemetricsPlayerIds.includes(consolidated.identity.battlemetricsPlayerId) &&
            person.names.some((/** @type {any} */ alias) => alias.name === consolidated.identity.name));
    if (exact) return Object.freeze({ appended: false, conflictSteamId: null });
    const recordedAt = nowIso(getDependencies(context));
    const sourceEventId = `manual:${Crypto.createHash('sha256').update([
        identity.steamId, identity.battlemetricsPlayerId, identity.name
    ].join('\u0000')).digest('hex')}`;
    const event = identityEvent(scope, { ...consolidated.identity, caseFidelity: true }, {
        guildId: context.guildId,
        observedAt: recordedAt,
        recordedAt,
        source: 'manual-command',
        sourceEventId,
        confidence: 'verified',
        evidence: null
    });
    return Object.freeze({ appended: (await store.append(event)).appended, conflictSteamId: null });
}

/** @param {any} context */
async function identityAdministrationState(context) {
    const scope = getScope(context);
    if (!scope) throw new Error('BattleMetrics must be configured for the active server.');
    const store = getStore(context, scope);
    const projection = Core.rebuild(await store.readAll());
    return Object.freeze({ scope, store, projection });
}

/** @param {any} context */
async function listPendingAliases(context) {
    const state = await identityAdministrationState(context);
    const dependencies = getDependencies(context);
    const daemon = dependencies.playerScanDaemon || PlayerScanDaemon;
    if (daemon && typeof daemon.getPendingReconciliationStatus === 'function') {
        const status = await daemon.getPendingReconciliationStatus(
            playerScanOptions(context, state.scope, state.store, dependencies), state.projection);
        if (status && Array.isArray(status.rows)) return status.rows;
    }
    return IdentityAdministration.pendingAliases(state.projection).map(row => Object.freeze({
        ...row,
        reconciliationState: 'unavailable',
        retryAt: null,
        campaignActive: false,
        campaignStartedAt: null
    }));
}

/** @param {any} context */
async function listIdentityLinks(context) {
    const state = await identityAdministrationState(context);
    return IdentityAdministration.activeLinks(state.projection);
}

/** @param {any} context @param {string} query */
async function resolveIdentityTarget(context, query) {
    const clean = sanitize(query);
    if (!clean || clean.length > MAX_QUERY_LENGTH) {
        return Object.freeze({ person: null, requestedAlias: null, reason: 'invalid-target' });
    }
    const state = await identityAdministrationState(context);
    const result = IdentityAdministration.resolveVerifiedSteamTarget(state.projection, clean);
    if (!result.person) return result;
    return Object.freeze({
        person: result.person,
        steamId: result.person.steamId,
        requestedAlias: result.requestedAlias,
        displayName: state.projection.identities.displayName(result.person.personId),
        reason: null
    });
}

/** @param {any} context @param {{alias:string,targetSteamId:string,targetName:string,
 * targetNameSource:string,actorId:string}} request */
async function linkIdentityAlias(context, request) {
    const state = await identityAdministrationState(context);
    return IdentityAdministration.linkAlias(state.store, state.scope, {
        guildId: `${context.guildId}`,
        recordedAt: nowIso(getDependencies(context)),
        alias: request.alias,
        targetSteamId: request.targetSteamId,
        targetName: request.targetName,
        targetNameSource: request.targetNameSource,
        actorId: `${request.actorId}`
    });
}

/** @param {any} context @param {{alias:string,actorId:string}} request */
async function unlinkIdentityAlias(context, request) {
    const state = await identityAdministrationState(context);
    return IdentityAdministration.unlinkAlias(state.store, state.scope, {
        guildId: `${context.guildId}`,
        recordedAt: nowIso(getDependencies(context)),
        alias: request.alias,
        actorId: `${request.actorId}`
    });
}

/** @param {any} context */
function commandAllowed(context) {
    if (context.source !== 'inGame') return true;
    if (context.rustplus.isOperational === false) return false;
    return !context.rustplus.generalSettings || context.rustplus.generalSettings.inGameCommandsEnabled !== false;
}

/** @param {string|readonly string[]} response */
function handled(response) {
    return Object.freeze({ handled: true, response: Array.isArray(response) ? Object.freeze(response) : response,
        logType: 'PlayerIntelligence' });
}

/** @param {any} projection @param {string} query */
function resolveQuery(projection, query) {
    if (!query || query.length > MAX_QUERY_LENGTH) return Object.freeze({ person: null, matches: [] });
    const exactId = projection.identities.findByIdentifier(query);
    if (exactId.length === 1) return Object.freeze({ person: exactId[0], matches: exactId });
    if (exactId.length > 1) return Object.freeze({ person: null, matches: exactId });
    const reconciliation = PlayerNameReconciler.reconcile(query, projection.identities.persons, {
        mode: PlayerNameReconciler.MODE_FIRST,
        getAliases: person => person.names.map((/** @type {any} */ alias) => alias.name),
        getKey: person => person.personId
    });
    return Object.freeze({
        person: reconciliation.target,
        matches: reconciliation.candidates
    });
}

/** @param {string} label @param {string[]} values @param {number} budget */
function boundedList(label, values, budget = IN_GAME_BUDGET) {
    if (values.length === 0) return `${label}: none`;
    let line = `${label}: `;
    let used = 0;
    for (let index = 0; index < values.length; index += 1) {
        const suffixCount = values.length - index - 1;
        const item = `${used > 0 ? ', ' : ''}${values[index]}`;
        const suffix = suffixCount > 0 ? ` +${suffixCount}` : '';
        if (Array.from(`${line}${item}${suffix}`).length > budget) break;
        line += item;
        used += 1;
    }
    const remaining = values.length - used;
    if (remaining > 0) line += `${used > 0 ? ',' : ''} +${remaining}`;
    return line;
}

/** @param {any} projection @param {any} person */
function subjectForPerson(projection, person) {
    return Object.freeze({
        steamId: person.steamId,
        battlemetricsPlayerId: person.battlemetricsPlayerIds[0] || null,
        exactName: person.steamId || person.battlemetricsPlayerIds.length > 0 ? null :
            projection.identities.displayName(person.personId)
    });
}

/** @param {any} projection @param {any} scope @param {any} person */
function identityLine(projection, scope, person) {
    const name = projection.identities.displayName(person.personId);
    const fields = [name];
    if (person.steamId) fields.push(`Steam:${person.steamId}`);
    if (person.battlemetricsPlayerIds.length > 0) fields.push(`BM:${person.battlemetricsPlayerIds[0]}`);
    const subject = subjectForPerson(projection, person);
    const state = projection.presence.getStatus(subject, scope.serverKey).state;
    if (state === 'online') fields.push('on');
    else if (state === 'offline') fields.push('off');
    const playtime = projection.metrics.getLatest(subject, scope.serverKey, 'warbandits', 'playtime');
    if (playtime) fields.push(`WB hours:${Math.floor(playtime.value)}+`);
    return fields.join(' | ');
}

/** @param {any} projection @param {any} person */
function affinityLines(projection, person) {
    const subject = subjectForPerson(projection, person);
    const affinity = projection.clans.getAffinity(subject);
    return Object.freeze([
        boundedList('Known tags', affinity.knownTags.map((/** @type {any} */ item) => `${item.tag} ${item.count}x`)),
        boundedList('Played with', affinity.playedWith.map((/** @type {any} */ item) =>
            `${item.name} ${item.count}x`))
    ]);
}

/** @param {any} person */
function aliasesLine(person) {
    return boundedList('Aliases', person.names.filter((/** @type {any} */ alias) => alias.verified)
    .sort((/** @type {any} */ left, /** @type {any} */ right) =>
        Number(right.steamStatus === 'current') - Number(left.steamStatus === 'current') ||
        `${right.lastVerifiedAt || right.lastObservedAt}`.localeCompare(
            `${left.lastVerifiedAt || left.lastObservedAt}`) || left.name.localeCompare(right.name))
    .map((/** @type {any} */ alias) => alias.name));
}

/** @param {number} milliseconds */
function formatDuration(milliseconds) {
    const minutes = Math.floor(Math.max(0, milliseconds) / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    return `${days > 0 ? `${days}d ` : ''}${hours}h${String(rest).padStart(2, '0')}m`;
}

/** @param {any} projection @param {any} scope @param {any} person @param {string} range
 * @param {number} currentTime */
function activityLine(projection, scope, person, range, currentTime) {
    const from = range === '1mo' ? currentTime - 30 * 24 * 60 * 60 * 1000 : -Infinity;
    const intervals = [];
    for (const provider of projection.presence.providers.filter((/** @type {any} */ item) =>
        item.personId === person.personId &&
        item.serverKey === scope.serverKey)) {
        for (const segment of provider.segments.filter((/** @type {any} */ item) => item.state === 'online')) {
            const start = Math.max(Date.parse(segment.startAt), from);
            const end = Math.min(Date.parse(segment.endAt || new Date(currentTime).toISOString()), currentTime);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push([start, end]);
        }
    }
    intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged = [];
    for (const interval of intervals) {
        const last = merged[merged.length - 1];
        if (!last || interval[0] > last[1]) merged.push([...interval]);
        else last[1] = Math.max(last[1], interval[1]);
    }
    const duration = merged.reduce((sum, interval) => sum + interval[1] - interval[0], 0);
    return `Activity ${range}: ${formatDuration(duration)}`;
}

/** @param {any[]} matches */
function ambiguousResponse(matches) {
    if (matches.length === 0) return 'Player not found.';
    return boundedList('Ambiguous player', matches.slice(0, 5).map(person =>
        `${person.names[person.names.length - 1]?.name || person.personId}`));
}

/** @param {any} context */
async function handleCommand(context) {
    const parsed = parseCommand(context);
    if (!parsed || !commandAllowed(context)) return Object.freeze({ handled: false });
    const scope = getScope(context);
    if (!scope) return handled('Player intelligence unavailable: configure BattleMetrics for the active server.');
    try {
        const store = getStore(context, scope);
        if (parsed.name === 'scanplayers') {
            if (parsed.query !== '') return handled(`Usage: ${context.prefix}scanplayers.`);
            if (!scope.wipeId) return handled('Player scan unavailable: current wipe is unknown.');
            const request = requestPlayerScan(context, scope, store, getDependencies(context));
            if (request.state === 'started') {
                return handled('Player scan and a new pending identity reconciliation pass started in background; ' +
                    'progress continues on BattleMetrics polling ticks.');
            }
            if (request.state === 'queued') {
                return handled('Player scan and a new pending identity reconciliation pass queued behind the ' +
                    'active background cycle.');
            }
            if (request.state === 'cooldown') {
                return handled(`Player scan cooldown: retry in ${request.retryAfterSeconds}s.`);
            }
            return handled('Player scan unavailable: no background identity provider is configured.');
        }
        if (parsed.name === 'record') {
            const identity = parseManualIdentity(parsed.query);
            if (!identity) {
                return handled(`Usage: ${context.prefix}record <SteamID64> <BattleMetrics ID> <exact name>.`);
            }
            const result = await recordManualIdentity(context, scope, store, identity);
            if (result.conflictSteamId) {
                return handled(`BM:${identity.battlemetricsPlayerId} is already linked to Steam:${
                    result.conflictSteamId}; nothing changed.`);
            }
            return handled(result.appended ?
                `Identity recorded | Steam:${identity.steamId} | BM:${identity.battlemetricsPlayerId}` :
                `Identity already known | Steam:${identity.steamId} | BM:${identity.battlemetricsPlayerId}`);
        }
        const projection = Core.rebuild(await store.readAll());
        if (parsed.name === 'clantop') {
            const requested = parsed.query === '' ? 5 : Number(parsed.query);
            if (!Number.isInteger(requested) || requested < 1 || requested > 10) {
                return handled(`Usage: ${context.prefix}clantop [1-10].`);
            }
            return handled(boundedList('Known tags', projection.clans.tags.slice(0, requested)
                .map(tag => `${tag.tag} ${tag.snapshotCount}x`)));
        }
        if (parsed.name === 'clan' || parsed.name === 'clanhistory') {
            if (!parsed.query || parsed.query.length > 32) {
                return handled(`Usage: ${context.prefix}${parsed.name} <ClanTag>.`);
            }
            const history = projection.clans.getTagHistory(parsed.query);
            if (history.length === 0) return handled(`ClanTag not found: ${parsed.query}.`);
            if (parsed.name === 'clan') {
                const latest = history[history.length - 1];
                return handled([
                    `${latest.tag} | ${latest.members.length}/${latest.declaredMemberCount || '?'} | seen ${
                        latest.observedAt.slice(0, 10)}`,
                    boundedList('Members', latest.members.map((/** @type {any} */ member) => member.name))
                ]);
            }
            return handled(history.slice(-5).reverse().map(snapshot =>
                `${snapshot.observedAt.slice(0, 10)} ${snapshot.tag}: ${snapshot.members.length} members`));
        }

        const effectiveName = parsed.name === 'steamid' ? 'intel' : parsed.name;
        let query = parsed.query;
        let range = '1mo';
        if (effectiveName === 'activity') {
            const match = /\s+(1mo|all)$/iu.exec(query);
            if (match) {
                range = normalize(match[1]);
                query = sanitize(query.slice(0, match.index));
            }
        }
        if (!query || query.length > MAX_QUERY_LENGTH) {
            const suffix = effectiveName === 'activity' ? ' [1mo|all]' : '';
            return handled(`Usage: ${context.prefix}${parsed.name} <SteamID64|BM ID|partial name>${suffix}.`);
        }
        const resolved = resolveQuery(projection, query);
        if (!resolved.person) return handled(ambiguousResponse(resolved.matches));
        if (effectiveName === 'activity') {
            return handled(activityLine(projection, scope, resolved.person, range,
                Date.parse(nowIso(getDependencies(context)))));
        }
        if (effectiveName === 'who') return handled(aliasesLine(resolved.person));
        const lines = affinityLines(projection, resolved.person);
        return handled(effectiveName === 'affinity' ? lines : Object.freeze([
            identityLine(projection, scope, resolved.person),
            aliasesLine(resolved.person),
            ...lines,
            activityLine(projection, scope, resolved.person, '1mo', Date.parse(nowIso(getDependencies(context))))
        ]));
    }
    catch (error) {
        if (context.rustplus && typeof context.rustplus.log === 'function') {
            context.rustplus.log('PLAYER_INTELLIGENCE',
                `Command failed safely: ${error instanceof Error ? error.message : error}.`, 'warn');
        }
        return handled('Player intelligence failed safely; nothing was changed. Check the logs.');
    }
}

/** @param {any} parsed @param {any} metadata @param {any} scope */
function validateParsedImport(parsed, metadata, scope) {
    if (!metadata || !/^[a-f0-9]{64}$/iu.test(`${metadata.sha256 || ''}`)) {
        throw new TypeError('Import hash is invalid.');
    }
    if (!['cinfo', 'f7'].includes(parsed.kind)) throw new TypeError('Unsupported import kind.');
    if (!scope.wipeId && parsed.kind === 'cinfo') throw new Error('Current wipe is unknown; import was not committed.');
    if (parsed.kind === 'f7' && !parsed.complete) throw new Error('Import contains unresolved F7 OCR errors.');
    if (parsed.kind === 'f7' && parsed.textSteamIdList === true) {
        if (!Array.isArray(parsed.entries) || parsed.entries.length < 1 || parsed.entries.length > 100 ||
            new Set(parsed.entries.map((/** @type {any} */ entry) => entry.steamId)).size !== parsed.entries.length ||
            parsed.entries.some((/** @type {any} */ entry) => !/^7656119\d{10}$/u.test(`${entry.steamId || ''}`) ||
                (entry.battlemetricsPlayerId !== null && entry.battlemetricsPlayerId !== undefined &&
                    !/^\d{1,32}$/u.test(`${entry.battlemetricsPlayerId}`)) ||
                (entry.name !== null && entry.name !== undefined &&
                    (typeof entry.name !== 'string' || !sanitize(entry.name) ||
                        Array.from(entry.name).length > 128)))) {
            throw new Error('SteamID text import is invalid.');
        }
    }
    if (parsed.kind === 'cinfo' && parsed.complete !== true && parsed.importable !== true) {
        throw new Error('Import does not contain enough cinfo structure for a partial snapshot.');
    }
}

/** @param {any} activeScope @param {any} metadata */
function scopeForImport(activeScope, metadata) {
    const observedAt = canonicalIso(metadata && metadata.observedAt);
    const wipeStart = canonicalIso(metadata && metadata.wipeStart);
    const wipeId = metadata && metadata.wipeId;
    if (!observedAt && !wipeStart && !wipeId) return activeScope;
    if (!observedAt || !wipeStart || wipeId !== `wipe:${wipeStart}` || observedAt < wipeStart) {
        throw new Error('Historical import time or wipe boundary is inconsistent.');
    }
    const expected = regularWipeStart(observedAt);
    if (wipeStart !== expected) throw new Error('Historical import does not target the applicable wipe boundary.');
    return Object.freeze({ ...activeScope, wipeStart, wipeId });
}

/** @param {any} activeScope @param {readonly any[]} events */
function scopeForReplacement(activeScope, events) {
    const wipeIds = [...new Set(events.map(event => event.scope && event.scope.wipeId))];
    if (wipeIds.length !== 1 || typeof wipeIds[0] !== 'string' || !wipeIds[0].startsWith('wipe:')) {
        throw new Error('Previous import has an inconsistent wipe scope.');
    }
    const wipeStart = canonicalIso(wipeIds[0].slice(5));
    if (!wipeStart || wipeIds[0] !== `wipe:${wipeStart}`) {
        throw new Error('Previous import wipe scope is invalid.');
    }
    return Object.freeze({ ...activeScope, wipeStart, wipeId: wipeIds[0] });
}

/** @param {any} projection @param {any} identity */
function consolidatedImportIdentity(projection, identity) {
    const result = consolidateIdentity(projection, identity);
    if (result.status === 'conflict') {
        throw new Error(`Imported identity conflicts with local stable-ID history: ${identity.name ||
            identity.steamId || identity.battlemetricsPlayerId}.`);
    }
    return result.identity;
}

/** @param {any} context @param {any} scope @param {any} parsed @param {any} metadata @param {string} recordedAt
 * @param {string|null} revision @param {any} projection */
function importEvents(context, scope, parsed, metadata, recordedAt, revision = null,
    projection = Core.rebuild(Object.freeze([]))) {
    const hash = `${metadata.sha256}`.toLowerCase();
    const sourceBase = revision === null ? hash : `${hash}:revision:${revision}`;
    const observedAt = canonicalIso(metadata.observedAt) || recordedAt;
    const textSteamIdList = parsed.kind === 'f7' && parsed.textSteamIdList === true;
    const common = { guildId: context.guildId, observedAt, recordedAt,
        source: parsed.kind === 'cinfo' ? 'discord-cinfo' :
            textSteamIdList ? 'discord-steamid-list' : 'discord-f7', confidence: 'verified',
        evidence: { hash, reference: metadata.reference || null, expiresAt: null } };
    const events = [];
    if (parsed.kind === 'f7') {
        parsed.entries.forEach((/** @type {any} */ entry, /** @type {number} */ index) => {
            const identity = consolidatedImportIdentity(projection, {
                steamId: entry.steamId,
                battlemetricsPlayerId: textSteamIdList ? entry.battlemetricsPlayerId || null : null,
                name: entry.name,
                caseFidelity: textSteamIdList ? entry.caseFidelity !== false : false
            });
            events.push(identityEvent(scope, identity,
                { ...common, confidence: entry.identityConfidence || common.confidence,
                    sourceEventId: `${sourceBase}:${textSteamIdList ? 'steamid-list' : 'f7'}:${index}:${entry.steamId}` }));
        });
    }
    else {
        const sourceMembers = Array.isArray(parsed.resolvedMembers) ? parsed.resolvedMembers :
            parsed.members.map((/** @type {any} */ member) => ({
                observedText: member.name,
                name: member.name,
                steamId: null,
                battlemetricsPlayerId: null,
                role: member.role
            }));
        const resolvedMembers = sourceMembers.map((/** @type {any} */ member) => ({
            ...member,
            ...consolidatedImportIdentity(projection, {
                steamId: member.steamId,
                battlemetricsPlayerId: member.battlemetricsPlayerId,
                name: member.name,
                caseFidelity: member.caseFidelity !== false
            })
        }));
        const unresolvedMembers = Array.isArray(parsed.unresolvedMembers) ? parsed.unresolvedMembers : [];
        resolvedMembers.forEach((/** @type {any} */ member, /** @type {number} */ index) =>
            events.push(identityEvent(scope, {
            steamId: member.steamId, battlemetricsPlayerId: member.battlemetricsPlayerId,
            name: member.name, caseFidelity: member.caseFidelity !== false
        }, { ...common, sourceEventId: `${sourceBase}:cinfo-name:${index}` })));
        events.push(baseEvent('clan_snapshot', scope,
            { steamId: null, battlemetricsPlayerId: null, exactName: null }, {
                tag: parsed.tag,
                establishedAt: parsed.establishedAtUtc,
                complete: parsed.complete,
                declaredMemberCount: parsed.declaredCount,
                members: resolvedMembers.map((/** @type {any} */ member) => ({
                    name: member.name,
                    steamId: member.steamId,
                    battlemetricsPlayerId: member.battlemetricsPlayerId,
                    role: member.role
                })),
                unresolvedMembers: unresolvedMembers.map((/** @type {any} */ member) => ({
                    observedText: member.observedText,
                    role: member.role,
                    candidates: (member.candidates || []).map((/** @type {any} */ candidate) => ({
                        name: candidate.name,
                        steamId: candidate.steamId,
                        battlemetricsPlayerId: candidate.battlemetricsPlayerId,
                        score: candidate.score
                    }))
                }))
            }, { ...common, sourceEventId: `${sourceBase}:cinfo-snapshot` }));
    }
    return Object.freeze(events);
}

/** @param {readonly any[]} events @param {string} recordedAt @param {any} parsed */
function replacementRevision(events, recordedAt, parsed) {
    return Crypto.createHash('sha256')
        .update(events.map(event => event.eventId).sort().join('\n'))
        .update('\0').update(recordedAt).update('\0').update(JSON.stringify(parsed))
        .digest('hex').slice(0, 24);
}

/** @param {any} context @param {any} scope @param {any} metadata @param {string} recordedAt
 * @param {string} revision @param {readonly any[]} previousEvents */
function supersessionEvent(context, scope, metadata, recordedAt, revision, previousEvents) {
    const hash = `${metadata.sha256}`.toLowerCase();
    return baseEvent('events_superseded', scope,
        { steamId: null, battlemetricsPlayerId: null, exactName: null }, {
            eventIds: previousEvents.map(event => event.eventId).sort(),
            reason: 'Confirmed Discord import replacement'
        }, {
            guildId: context.guildId,
            observedAt: recordedAt,
            recordedAt,
            source: 'discord-import-replacement',
            sourceEventId: `${hash}:supersede:${revision}`,
            confidence: 'verified',
            evidence: { hash, reference: metadata.reference || null, expiresAt: null }
        });
}

/** @param {readonly any[]} groups */
function expectedGroupMap(groups) {
    if (!Array.isArray(groups)) throw new TypeError('Expected duplicate revisions must be an array.');
    const result = new Map();
    for (const group of groups) {
        const hash = `${group && group.hash || ''}`.toLowerCase();
        const eventIds = group && group.eventIds;
        if (!/^[a-f0-9]{64}$/u.test(hash) || !Array.isArray(eventIds) || eventIds.length < 1 ||
            eventIds.some(eventId => typeof eventId !== 'string' || !/^pi:[a-f0-9]{64}$/u.test(eventId))) {
            throw new TypeError('Expected duplicate revision is invalid.');
        }
        result.set(hash, [...eventIds].sort());
    }
    return result;
}

/** @param {any} item @param {readonly any[]} events */
function isIdempotentSteamIdTextList(item, events) {
    if (!item || !item.parsed || item.parsed.kind !== 'f7' || item.parsed.textSteamIdList !== true ||
        !Array.isArray(item.parsed.entries) || !Array.isArray(events) || events.length < 1 ||
        events.some(event => event.kind !== 'identity_observed' ||
            event.provenance.source !== 'discord-steamid-list')) return false;
    const proposed = item.parsed.entries.map((/** @type {any} */ entry) => `${entry.steamId}`).sort();
    const previous = events.map((/** @type {any} */ event) => `${event.subject.steamId || ''}`).sort();
    return proposed.length === previous.length && proposed.every(
        (/** @type {string} */ steamId, /** @type {number} */ index) => steamId === previous[index]);
}

/** @param {any} context @param {readonly {parsed:any,metadata:any}[]} imports
 * @param {{onDuplicate?:'prompt'|'skip'|'replace',expectedDuplicates?:readonly any[]}} options */
async function commitParsedImports(context, imports, options = {}) {
    if (!Array.isArray(imports) || imports.length < 1 || imports.length > 100) {
        throw new TypeError('Import batch must contain between 1 and 100 parsed observations.');
    }
    const scope = getScope(context);
    if (!scope) throw new Error('BattleMetrics must be configured for the active server.');
    imports.forEach(item => validateParsedImport(item && item.parsed, item && item.metadata, scope));
    const store = getStore(context, scope);
    const previous = await store.readAll();
    const effective = Core.effectiveEvents(previous);
    const recordedAt = nowIso(getDependencies(context));
    const hashes = new Set(previous.filter((/** @type {any} */ event) => event.evidence)
        .map((/** @type {any} */ event) => event.evidence.hash.toLowerCase()));
    const activeByHash = new Map();
    for (const event of effective) {
        if (!event.evidence) continue;
        const hash = event.evidence.hash.toLowerCase();
        const values = activeByHash.get(hash) || [];
        values.push(event);
        activeByHash.set(hash, values);
    }
    const onDuplicate = options.onDuplicate || 'prompt';
    if (!['prompt', 'skip', 'replace'].includes(onDuplicate)) {
        throw new TypeError('Duplicate import policy is unsupported.');
    }
    const duplicateImports = imports.filter(item => hashes.has(`${item.metadata.sha256}`.toLowerCase()));
    const duplicateGroups = duplicateImports.map(item => {
        const hash = `${item.metadata.sha256}`.toLowerCase();
        const events = activeByHash.get(hash);
        if (!events || events.length === 0) {
            throw new Error('Duplicate evidence has no effective event revision.');
        }
        return Object.freeze({ item, hash, events: Object.freeze([...events]),
            idempotentTextList: isIdempotentSteamIdTextList(item, events) });
    });
    const idempotentTextLists = duplicateGroups.filter(group => group.idempotentTextList).length;
    const existing = Object.freeze(duplicateGroups.filter(group => !group.idempotentTextList)
        .map(group => Object.freeze({ hash: group.hash, events: group.events })));
    if (onDuplicate === 'prompt' && existing.length > 0) {
        return Object.freeze({ appended: 0, duplicate: true, duplicates: existing.length,
            existing, idempotentTextLists, imported: 0, replaced: 0, committedHashes: Object.freeze([]) });
    }
    const expected = onDuplicate === 'replace' ? expectedGroupMap(options.expectedDuplicates || []) : new Map();
    const events = [];
    let duplicates = 0;
    let imported = 0;
    let replaced = 0;
    const committedHashes = [];
    for (const item of imports) {
        const hash = `${item.metadata.sha256}`.toLowerCase();
        if (hashes.has(hash)) {
            const previousEvents = activeByHash.get(hash);
            if (previousEvents && isIdempotentSteamIdTextList(item, previousEvents)) {
                duplicates += 1;
                continue;
            }
            if (onDuplicate === 'skip') {
                duplicates += 1;
                continue;
            }
            if (!previousEvents || previousEvents.length === 0) {
                throw new Error('Duplicate evidence has no effective event revision.');
            }
            const expectedIds = expected.get(hash);
            const currentIds = previousEvents.map((/** @type {any} */ event) => event.eventId).sort();
            if (!expectedIds || expectedIds.length !== currentIds.length ||
                currentIds.some((/** @type {string} */ eventId, /** @type {number} */ index) =>
                    eventId !== expectedIds[index])) {
                throw new Error('Existing import changed after preview; upload it again before replacing.');
            }
            const revision = replacementRevision(previousEvents, recordedAt, item.parsed);
            const replacementMetadata = { ...item.metadata,
                observedAt: canonicalIso(item.metadata.observedAt) || previousEvents[0].observedAt };
            const replacementScope = item.metadata.observedAt ? scopeForImport(scope, item.metadata) :
                scopeForReplacement(scope, previousEvents);
            const replacedIds = new Set(previousEvents.map((/** @type {any} */ event) => event.eventId));
            const replacementProjection = Core.rebuild(Object.freeze(
                [...effective, ...events].filter((/** @type {any} */ event) => !replacedIds.has(event.eventId))));
            events.push(...importEvents(context, replacementScope, item.parsed, replacementMetadata, recordedAt,
                revision, replacementProjection));
            events.push(supersessionEvent(context, replacementScope, replacementMetadata, recordedAt, revision,
                previousEvents));
            replaced += 1;
            committedHashes.push(hash);
            continue;
        }
        hashes.add(hash);
        imported += 1;
        committedHashes.push(hash);
        const importProjection = Core.rebuild(Object.freeze([...effective, ...events]));
        events.push(...importEvents(context, scopeForImport(scope, item.metadata), item.parsed, item.metadata,
            recordedAt, null, importProjection));
    }
    const results = events.length > 0 ? await store.appendMany(events) : [];
    return Object.freeze({
        appended: results.filter((/** @type {any} */ result) => result.appended).length,
        duplicate: imported === 0 && replaced === 0 && idempotentTextLists === 0,
        committedHashes: Object.freeze(committedHashes),
        duplicates,
        existing: Object.freeze([]),
        idempotentTextLists,
        replaced,
        imported
    });
}

/** @param {any} context @param {any} parsed @param {any} metadata */
async function commitParsedImport(context, parsed, metadata) {
    const result = await commitParsedImports(context, [{ parsed, metadata }]);
    return Object.freeze({ appended: result.appended, duplicate: result.duplicate });
}

/** @param {any} context */
async function linkedClanSteamCandidates(context) {
    const scope = getScope(context);
    if (!scope) return Object.freeze([]);
    const projection = Core.rebuild(await getStore(context, scope).readAll());
    const candidates = [];
    for (const snapshot of projection.clans.snapshots) {
        if (!snapshot.confirmed || snapshot.duplicate) continue;
        for (const member of snapshot.members) {
            if (member.ambiguous || !member.personId.startsWith('steam:')) continue;
            candidates.push(Object.freeze({ name: member.name, steamId: member.personId.slice(6) }));
        }
    }
    return Object.freeze([...new Map(candidates.map(item => [item.steamId, item])).values()]);
}

/** @param {any} context @param {any} player @param {unknown} observedAt */
async function recordWarBanditsIdentity(context, player, observedAt) {
    const scope = getScope(context);
    if (!scope || !player || !/^7656119\d{10}$/u.test(`${player.steamId || ''}`)) return false;
    const name = sanitize(player.name);
    const time = canonicalIso(observedAt);
    if (!name || !time) return false;
    const store = getStore(context, scope);
    const projection = Core.rebuild(await store.readAll());
    const consolidated = consolidateIdentity(projection, {
        steamId: `${player.steamId}`, battlemetricsPlayerId: null, name, caseFidelity: true
    });
    if (consolidated.status === 'conflict') return false;
    const event = identityEvent(scope, consolidated.identity, {
        guildId: context.guildId,
        observedAt: time,
        recordedAt: nowIso(getDependencies(context)),
        source: 'warbandits',
        sourceEventId: `identity:${player.steamId}:${time}`,
        confidence: 'verified',
        evidence: null
    });
    return (await store.append(event)).appended;
}

function getRuntimeCacheStatus(nowMs = Date.now()) {
    return Object.freeze({ hookStates: hookStates.count(nowMs), hookStateLimit: HOOK_STATE_MAX_ENTRIES });
}

function resetRuntimeCachesForTests() {
    hookStates.clear();
    stableCandidateWarningTimes.clear();
}

module.exports = Object.freeze({
    DATA_DIRECTORY,
    MAX_LEGACY_IDENTITY_CANDIDATES,
    MAX_STABLE_IDENTITY_CANDIDATES,
    MAX_TRACKER_IDENTITY_CANDIDATES,
    boundedList,
    commitParsedImport,
    commitParsedImports,
    consolidateIdentity,
    getDataDirectory,
    getRuntimeCacheStatus,
    getScope,
    handleCommand,
    identityCandidates,
    identityCandidatesBySteamIds,
    linkIdentityAlias,
    listIdentityLinks,
    listPendingAliases,
    linkedClanSteamCandidates,
    onBattlemetricsUpdated,
    parseCommand,
    parseManualIdentity,
    parseCaptureTime,
    recordWarBanditsIdentity,
    recordManualIdentity,
    regularWipeStart,
    resetRuntimeCachesForTests,
    resolveEstablishedScope,
    resolveHistoricalScope,
    resolveIdentityTarget,
    resolveQuery,
    unlinkIdentityAlias
});
