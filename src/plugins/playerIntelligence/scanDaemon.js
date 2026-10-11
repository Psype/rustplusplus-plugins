// @ts-check
/* Incremental background identity discovery. It is clocked by the existing BattleMetrics update hook. */

const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');
const Performance = require('node:perf_hooks').performance;

const BoundedTtlCache = require('../../util/boundedTtlCache.js');
const RuntimeTelemetry = require('../../util/runtimeTelemetry.js');
const Core = require('./index.js');
const PendingReconciler = require('./pendingReconciler.js');

const STATE_SCHEMA_VERSION = 7;
const COLLECTOR_VERSION = 'player-scan-daemon-9';
const STATE_FILE = 'scan-daemon.json';
const MAX_LOCAL_REFRESHES_PER_CYCLE = 100;
const RESCAN_DELAY_MS = 12 * 60 * 60 * 1000;
const MANUAL_RESCAN_COOLDOWN_MS = 5 * 60 * 1000;
const MANUAL_TRIGGER_MAX_ENTRIES = 256;
const WARNING_TTL_MS = 60 * 60 * 1000;
const WARNING_MAX_ENTRIES = 256;
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const MAX_TARGETED_RETRIES = 10000;
const MAX_STEAM_PROFILE_RETRIES = 10000;
const FRESH_BURST_LIMIT = 2;
const PENDING_BATTLEMETRICS_BATCH_SIZE = 4;
const PENDING_WARBANDITS_BATCH_SIZE = 4;
const PENDING_RECONCILIATION_BUDGET_MS = 45 * 1000;
const ONLINE_SOURCE = 'battlemetrics-online-wipe-daemon';
const WARBANDITS_SOURCE = 'warbandits-current-wipe-daemon';
const WARBANDITS_LOOKUP_SOURCE = 'warbandits-direct-lookup-daemon';
const WARBANDITS_PENDING_SOURCE = 'warbandits-pending-reconciliation-daemon';
const BATTLEMETRICS_IDENTIFIER_SOURCE = 'battlemetrics-identifier-daemon';
const STEAM_CURRENT_SOURCE = 'steam-profile-current';
const STEAM_ALIAS_SOURCE = 'steam-profile-alias-history';
const PLAN_IDENTITY_SOURCES = new Set([
    ONLINE_SOURCE, WARBANDITS_SOURCE, WARBANDITS_LOOKUP_SOURCE, WARBANDITS_PENDING_SOURCE,
    BATTLEMETRICS_IDENTIFIER_SOURCE, STEAM_CURRENT_SOURCE, STEAM_ALIAS_SOURCE
]);
const PLAN_METRIC_SOURCES = new Set([
    WARBANDITS_SOURCE, WARBANDITS_LOOKUP_SOURCE, WARBANDITS_PENDING_SOURCE
]);
const PLAN_PROTOCOL_VERSION = 3;
const MAX_IDENTITY_GUARDS = 512;
const PLAN_FIELDS = Object.freeze([
    'protocolVersion', 'baseRevision', 'baseControlRevision', 'baseStateRevision',
    'identityGuards', 'result', 'events', 'state'
]);
const IDENTITY_CONTROL_REVISION_KINDS = new Set([
    'identity_linked', 'identity_link_revoked', 'events_superseded'
]);
const STATE_FIELDS = Object.freeze([
    'schemaVersion', 'guildId', 'serverKey', 'wipeId', 'nextWarBanditsPage', 'warBanditsResumeAt',
    'warBanditsSweeps', 'seenWarBanditsSteamIds', 'targetedLookupSteamIds', 'targetedLookupRetries',
    'targetedFreshStreak', 'refreshedSteamIds', 'profiledSteamIds', 'steamProfileRetries',
    'steamProfileFreshStreak', 'pendingReconciliation', 'warBanditsRetryAt', 'warBanditsFailures', 'updatedAt'
]);
const inFlight = new Map();
const forcedReruns = new Map();
const staleRetryCounts = new Map();
const MAX_IMMEDIATE_STALE_RETRIES = 1;
const manualTriggerTimes = BoundedTtlCache.createBoundedTtlCache({
    maxEntries: MANUAL_TRIGGER_MAX_ENTRIES, defaultTtlMs: MANUAL_RESCAN_COOLDOWN_MS
});
const warningTimes = BoundedTtlCache.createBoundedTtlCache({
    maxEntries: WARNING_MAX_ENTRIES, defaultTtlMs: WARNING_TTL_MS
});
let temporaryCounter = 0;

class ScanDaemonStateError extends Error {
    /** @param {string} file @param {unknown} cause */
    constructor(file, cause) {
        super(`Player scan daemon state is corrupt at ${file}; it was preserved.`);
        this.name = 'ScanDaemonStateError';
        this.file = file;
        this.cause = cause;
    }
}

class StaleScanPlanError extends Error {
    /** @param {'journal'|'checkpoint'|'scope'} [component] */
    constructor(component = 'journal') {
        super(`Player scan ${component} changed while the worker was planning; a fresh cycle was queued.`);
        this.name = 'StaleScanPlanError';
        this.code = 'STALE_SCAN_PLAN';
        this.component = component;
        this.retryable = true;
    }
}

/** @param {unknown} value */
function sanitize(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {unknown} value */
function normalize(value) {
    return sanitize(value).normalize('NFKC').toLocaleLowerCase('en');
}

/** @param {unknown} value */
function canonicalIso(value) {
    const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** @param {any} options */
function assertMatchingStoreDirectory(options) {
    if (options && options.store && typeof options.store.directory === 'string' &&
        Path.resolve(options.store.directory) !== Path.resolve(options.directory)) {
        throw new TypeError('Player scan journal and checkpoint directories must match.');
    }
}

/** @param {any} options */
function assertCurrentScope(options) {
    if (!options || typeof options.resolveCurrentScope !== 'function') return;
    let current;
    try { current = options.resolveCurrentScope(options.context); }
    catch (_error) { throw new StaleScanPlanError('scope'); }
    if (!current || !current.wipeId || current.serverKey !== options.scope.serverKey ||
        current.wipeId !== options.scope.wipeId) throw new StaleScanPlanError('scope');
}

/** @param {any} dependencies */
function nowDate(dependencies) {
    const value = (dependencies.now || (() => new Date()))();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Player scan daemon clock is invalid.');
    return date;
}

/** @param {string} wipeId */
function wipeToken(wipeId) {
    return Crypto.createHash('sha256').update(wipeId).digest('hex').slice(0, 20);
}

/** @param {string} value */
function shortToken(value) {
    return Crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** @param {string} directory */
function statePath(directory) {
    return Path.join(directory, STATE_FILE);
}

/** @param {string|null} text */
function stateRevision(text) {
    if (text === null) return 'pi-scan-state:absent';
    return `pi-scan-state:${Crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Hashes non-monotonic identity controls. Ordinary immutable observations may be rebased and are checked
 * semantically below, but a manual link/revocation or supersession must force a fresh plan so stale work cannot
 * restore evidence an operator just corrected.
 * @param {readonly Readonly<Record<string, any>>[]} events
 */
function controlRevision(events) {
    const hash = Crypto.createHash('sha256');
    let count = 0;
    hash.update('player-intelligence-identity-control-revision-v1\u0000', 'utf8');
    for (const event of events) {
        if (!IDENTITY_CONTROL_REVISION_KINDS.has(event.kind)) continue;
        const encoded = JSON.stringify(event);
        hash.update(`${Buffer.byteLength(encoded)}:`, 'utf8').update(encoded, 'utf8');
        count += 1;
    }
    hash.update(`:${count}`, 'utf8');
    return `pi-control-revision:${hash.digest('hex')}`;
}

/**
 * Derives the journal read-set behind every new Steam/BattleMetrics pair. Names emitted for the same SteamID are
 * included because pending and online reconciliation may have selected a BattleMetrics identity by exact name.
 * @param {readonly Readonly<Record<string, any>>[]} events
 */
function plannedIdentityGuardDescriptors(events) {
    const namesBySteamId = new Map();
    for (const event of events) {
        if (event.kind !== 'identity_observed' || !event.subject.steamId || !event.subject.exactName) continue;
        const names = namesBySteamId.get(event.subject.steamId) || new Set();
        names.add(normalize(event.subject.exactName));
        namesBySteamId.set(event.subject.steamId, names);
    }
    const pairs = new Map();
    for (const event of events) {
        if (event.kind !== 'identity_observed' || !event.subject.steamId ||
            !event.subject.battlemetricsPlayerId) continue;
        const key = `${event.subject.steamId}\u0000${event.subject.battlemetricsPlayerId}`;
        if (!pairs.has(key)) pairs.set(key, {
            steamId: event.subject.steamId,
            battlemetricsPlayerId: event.subject.battlemetricsPlayerId,
            names: [...(namesBySteamId.get(event.subject.steamId) || [])].sort()
        });
    }
    const pairedSteamIds = new Set([...pairs.values()].map(pair => pair.steamId));
    for (const event of events) {
        if (event.kind !== 'identity_observed' || event.provenance.source !== WARBANDITS_PENDING_SOURCE ||
            !event.subject.steamId || !event.subject.exactName || pairedSteamIds.has(event.subject.steamId)) continue;
        const key = `${event.subject.steamId}\u0000`;
        if (!pairs.has(key)) pairs.set(key, {
            steamId: event.subject.steamId,
            battlemetricsPlayerId: null,
            names: [...(namesBySteamId.get(event.subject.steamId) || [])].sort()
        });
    }
    return [...pairs.values()].sort((left, right) =>
        `${left.steamId}\u0000${left.battlemetricsPlayerId || ''}`.localeCompare(
            `${right.steamId}\u0000${right.battlemetricsPlayerId || ''}`));
}

/**
 * Computes all guard digests in one journal pass. An unrelated login therefore remains rebasable, while a new
 * observation sharing a selected SteamID, BattleMetrics ID or decision name invalidates the stale inference.
 * @param {readonly Readonly<Record<string, any>>[]} events
 * @param {readonly {steamId:string,battlemetricsPlayerId:string|null,names:readonly string[]}[]} descriptors
 */
function identityGuardRevisions(events, descriptors) {
    if (descriptors.length === 0) return [];
    const steamIndexes = new Map();
    const battlemetricsIndexes = new Map();
    const nameIndexes = new Map();
    const hashes = descriptors.map(descriptor => Crypto.createHash('sha256')
        .update('player-intelligence-identity-guard-v1\u0000', 'utf8')
        .update(JSON.stringify([descriptor.steamId, descriptor.battlemetricsPlayerId, descriptor.names]), 'utf8')
        .update('\u0000', 'utf8'));
    const counts = descriptors.map(() => 0);
    /** @param {Map<string,Set<number>>} index @param {string} key @param {number} position */
    function add(index, key, position) {
        const positions = index.get(key) || new Set();
        positions.add(position);
        index.set(key, positions);
    }
    descriptors.forEach((descriptor, position) => {
        add(steamIndexes, descriptor.steamId, position);
        if (descriptor.battlemetricsPlayerId) {
            add(battlemetricsIndexes, descriptor.battlemetricsPlayerId, position);
        }
        for (const name of descriptor.names) add(nameIndexes, name, position);
    });
    for (const event of events) {
        if (event.kind !== 'identity_observed') continue;
        const positions = new Set();
        if (event.subject.steamId) {
            for (const position of steamIndexes.get(event.subject.steamId) || []) positions.add(position);
        }
        if (event.subject.battlemetricsPlayerId) {
            for (const position of battlemetricsIndexes.get(event.subject.battlemetricsPlayerId) || []) {
                positions.add(position);
            }
        }
        if (event.subject.exactName) {
            for (const position of nameIndexes.get(normalize(event.subject.exactName)) || []) positions.add(position);
        }
        if (positions.size === 0) continue;
        const encoded = JSON.stringify(event);
        const prefix = `${Buffer.byteLength(encoded)}:`;
        for (const position of positions) {
            hashes[position].update(prefix, 'utf8').update(encoded, 'utf8');
            counts[position] += 1;
        }
    }
    return hashes.map((hash, position) => {
        hash.update(`:${counts[position]}`, 'utf8');
        return `pi-identity-guard-revision:${hash.digest('hex')}`;
    });
}

/** @param {readonly Readonly<Record<string, any>>[]} existing @param {readonly any[]} planned */
function plannedIdentityGuards(existing, planned) {
    const descriptors = plannedIdentityGuardDescriptors(planned);
    if (descriptors.length > MAX_IDENTITY_GUARDS) {
        throw new TypeError('Player scan plan produced too many identity guards.');
    }
    const revisions = identityGuardRevisions(existing, descriptors);
    return descriptors.map((descriptor, index) => Object.freeze({
        ...descriptor, names: Object.freeze([...descriptor.names]), revision: revisions[index]
    }));
}

/** @param {any} state @param {string} revision */
function attachStateRevision(state, revision) {
    Object.defineProperty(state, 'baseStateRevision', { value: revision, enumerable: false });
    return state;
}

/** @param {string} directory */
async function currentStateRevision(directory) {
    try {
        return stateRevision(await Fs.promises.readFile(statePath(directory), 'utf8'));
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return stateRevision(null);
        throw error;
    }
}

/** @param {any} options @param {Date} now */
function emptyState(options, now) {
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        guildId: `${options.context.guildId}`,
        serverKey: options.scope.serverKey,
        wipeId: options.scope.wipeId,
        nextWarBanditsPage: 1,
        warBanditsResumeAt: null,
        warBanditsSweeps: 0,
        seenWarBanditsSteamIds: [],
        targetedLookupSteamIds: [],
        targetedLookupRetries: [],
        targetedFreshStreak: 0,
        refreshedSteamIds: [],
        profiledSteamIds: [],
        steamProfileRetries: [],
        steamProfileFreshStreak: 0,
        pendingReconciliation: PendingReconciler.emptyCheckpoint(),
        warBanditsRetryAt: null,
        warBanditsFailures: 0,
        updatedAt: now.toISOString()
    };
}

/** @param {unknown} value @param {any} options */
function validateState(value, options) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('state must be an object');
    }
    const state = /** @type {any} */ (value);
    if (![1, 2, 3, 4, 5, 6, STATE_SCHEMA_VERSION].includes(state.schemaVersion) ||
        `${state.guildId}` !== `${options.context.guildId}` ||
        typeof state.serverKey !== 'string' || typeof state.wipeId !== 'string' ||
        !Number.isSafeInteger(state.nextWarBanditsPage) || state.nextWarBanditsPage < 1 ||
        state.nextWarBanditsPage > 1000000 || !Number.isSafeInteger(state.warBanditsSweeps) ||
        state.warBanditsSweeps < 0 || !Array.isArray(state.seenWarBanditsSteamIds) ||
        !Array.isArray(state.refreshedSteamIds) || typeof state.updatedAt !== 'string' ||
        Number.isNaN(Date.parse(state.updatedAt)) || (state.warBanditsResumeAt !== null &&
            (typeof state.warBanditsResumeAt !== 'string' || Number.isNaN(Date.parse(state.warBanditsResumeAt))))) {
        throw new TypeError('state fields are invalid');
    }
    const targetedLookupSteamIds = state.schemaVersion === 1 ? [] : state.targetedLookupSteamIds;
    const profiledSteamIds = state.schemaVersion < 3 ? [] : state.profiledSteamIds;
    const legacyProfileAttempts = state.schemaVersion < 4 ? [...profiledSteamIds] :
        state.schemaVersion < 6 ? state.profileAttemptedSteamIds : [];
    if (!Array.isArray(targetedLookupSteamIds)) throw new TypeError('state targeted lookup set is invalid');
    if (!Array.isArray(profiledSteamIds)) throw new TypeError('state Steam profile set is invalid');
    if (!Array.isArray(legacyProfileAttempts) || legacyProfileAttempts.length > 200000 ||
        new Set(legacyProfileAttempts).size !== legacyProfileAttempts.length ||
        legacyProfileAttempts.some((/** @type {any} */ value) => !/^7656119\d{10}$/u.test(`${value}`))) {
        throw new TypeError('state Steam profile attempt set is invalid');
    }
    const targetedLookupRetries = state.schemaVersion < 5 ? [] : state.targetedLookupRetries;
    const warBanditsRetryAt = state.schemaVersion < 5 ? null : state.warBanditsRetryAt;
    const warBanditsFailures = state.schemaVersion < 5 ? 0 : state.warBanditsFailures;
    const targetedFreshStreak = state.schemaVersion < 6 ? 0 : state.targetedFreshStreak;
    const profiledSet = new Set(profiledSteamIds);
    const steamProfileRetries = state.schemaVersion < 6 ? legacyProfileAttempts
        .filter((/** @type {string} */ steamId) => !profiledSet.has(steamId))
        .sort().slice(0, MAX_STEAM_PROFILE_RETRIES)
        .map((/** @type {string} */ steamId) => ({ steamId, failures: 1, nextAttemptAt: state.updatedAt })) :
        state.steamProfileRetries;
    const steamProfileFreshStreak = state.schemaVersion < 6 ? 0 : state.steamProfileFreshStreak;
    const pendingReconciliation = state.schemaVersion < 7 ? PendingReconciler.emptyCheckpoint() :
        PendingReconciler.validateCheckpoint(state.pendingReconciliation);
    if (!Array.isArray(targetedLookupRetries) || targetedLookupRetries.length > MAX_TARGETED_RETRIES) {
        throw new TypeError('state targeted lookup retries are invalid');
    }
    if (!Array.isArray(steamProfileRetries) || steamProfileRetries.length > MAX_STEAM_PROFILE_RETRIES) {
        throw new TypeError('state Steam profile retries are invalid');
    }
    for (const [label, retries] of [['targeted lookup', targetedLookupRetries],
        ['Steam profile', steamProfileRetries]]) {
        const retryIds = new Set();
        for (const retry of /** @type {any[]} */ (retries)) {
            if (!retry || typeof retry !== 'object' || Object.keys(retry).length !== 3 ||
                !Object.hasOwn(retry, 'steamId') || !Object.hasOwn(retry, 'failures') ||
                !Object.hasOwn(retry, 'nextAttemptAt') || !/^7656119\d{10}$/u.test(`${retry.steamId}`) ||
                !Number.isSafeInteger(retry.failures) || retry.failures < 1 || retry.failures > 1000 ||
                typeof retry.nextAttemptAt !== 'string' || Number.isNaN(Date.parse(retry.nextAttemptAt)) ||
                retryIds.has(`${retry.steamId}`)) {
                throw new TypeError(`state ${label} retry is invalid`);
            }
            retryIds.add(`${retry.steamId}`);
        }
    }
    if (!Number.isSafeInteger(targetedFreshStreak) || targetedFreshStreak < 0 ||
        targetedFreshStreak > FRESH_BURST_LIMIT || !Number.isSafeInteger(steamProfileFreshStreak) ||
        steamProfileFreshStreak < 0 || steamProfileFreshStreak > FRESH_BURST_LIMIT) {
        throw new TypeError('state retry fairness counters are invalid');
    }
    if (!Number.isSafeInteger(warBanditsFailures) || warBanditsFailures < 0 || warBanditsFailures > 1000 ||
        (warBanditsRetryAt !== null && (typeof warBanditsRetryAt !== 'string' ||
            Number.isNaN(Date.parse(warBanditsRetryAt)))) ||
        (warBanditsFailures === 0) !== (warBanditsRetryAt === null)) {
        throw new TypeError('state WarBandits retry is invalid');
    }
    for (const values of /** @type {any[][]} */ ([state.seenWarBanditsSteamIds, state.refreshedSteamIds,
        targetedLookupSteamIds, profiledSteamIds, legacyProfileAttempts])) {
        if (values.length > 200000 || new Set(values).size !== values.length ||
            values.some(value => !/^7656119\d{10}$/u.test(`${value}`))) {
            throw new TypeError('state SteamID set is invalid');
        }
    }
    const attempted = new Set(legacyProfileAttempts);
    if (state.schemaVersion < 6 && profiledSteamIds.some((/** @type {string} */ steamId) => !attempted.has(steamId))) {
        throw new TypeError('completed Steam profiles must also be marked attempted');
    }
    const migrated = { ...state, schemaVersion: STATE_SCHEMA_VERSION, targetedLookupSteamIds,
        targetedLookupRetries, targetedFreshStreak, profiledSteamIds, steamProfileRetries,
        steamProfileFreshStreak, pendingReconciliation, warBanditsRetryAt, warBanditsFailures };
    delete migrated.profileAttemptedSteamIds;
    return migrated;
}

/** @param {Date} current @param {number} failures @param {unknown} [suggested] */
function retryAt(current, failures, suggested = null) {
    const exponent = Math.min(16, Math.max(0, failures - 1));
    const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exponent));
    const suggestedMs = typeof suggested === 'string' ? Date.parse(suggested) : Number.NaN;
    return new Date(Math.max(current.getTime() + backoff,
        Number.isNaN(suggestedMs) ? 0 : suggestedMs)).toISOString();
}

/** @param {Map<string,{steamId:string,failures:number,nextAttemptAt:string}>} retries @param {string} steamId
 * @param {Date} current @param {number} limit @param {unknown} [suggested] */
function recordRetry(retries, steamId, current, limit, suggested = null) {
    const previous = retries.get(steamId);
    if (!previous && retries.size >= limit) {
        const oldest = [...retries.values()].sort((left, right) =>
            left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.steamId.localeCompare(right.steamId))[0];
        if (oldest) retries.delete(oldest.steamId);
    }
    const failures = Math.min(1000, (previous ? previous.failures : 0) + 1);
    retries.set(steamId, { steamId, failures, nextAttemptAt: retryAt(current, failures, suggested) });
}

/** @param {Map<string,any>} retries @param {string} id @param {string} idField @param {Date} current
 * @param {unknown} [suggested] */
function recordPendingRetry(retries, id, idField, current, suggested = null) {
    const previous = retries.get(id);
    if (!previous && retries.size >= PendingReconciler.MAX_RETRIES) {
        const oldest = [...retries.values()].sort((left, right) =>
            left.nextAttemptAt.localeCompare(right.nextAttemptAt) ||
            `${left[idField]}`.localeCompare(`${right[idField]}`))[0];
        if (oldest) retries.delete(`${oldest[idField]}`);
    }
    const failures = Math.min(1000, (previous ? previous.failures : 0) + 1);
    retries.set(id, { [idField]: id, failures, nextAttemptAt: retryAt(current, failures, suggested) });
}

/** @param {any} options @param {Date} now */
async function readState(options, now) {
    const file = statePath(options.directory);
    let text;
    try {
        text = await Fs.promises.readFile(file, 'utf8');
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
            return attachStateRevision(emptyState(options, now), stateRevision(null));
        }
        throw error;
    }
    const revision = stateRevision(text);
    try {
        const raw = JSON.parse(text);
        const parsed = validateState(raw, options);
        if (parsed.serverKey !== options.scope.serverKey) {
            return attachStateRevision(emptyState(options, now), revision);
        }
        if (parsed.wipeId !== options.scope.wipeId) {
            const reset = emptyState(options, now);
            reset.pendingReconciliation = parsed.pendingReconciliation;
            Object.defineProperty(reset, 'needsMigrationWrite', { value: true, enumerable: false });
            return attachStateRevision(reset, revision);
        }
        Object.defineProperty(parsed, 'needsMigrationWrite', {
            value: raw.schemaVersion !== STATE_SCHEMA_VERSION,
            enumerable: false
        });
        return attachStateRevision(parsed, revision);
    }
    catch (error) {
        throw new ScanDaemonStateError(file, error);
    }
}

/** @param {string} file @param {any} state */
async function writeStateAtomic(file, state) {
    await Fs.promises.mkdir(Path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${temporaryCounter++}`;
    let handle;
    try {
        handle = await Fs.promises.open(temporary, 'wx');
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await Fs.promises.rename(temporary, file);
    }
    catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await Fs.promises.unlink(temporary).catch(() => undefined);
        throw error;
    }
}

/** @param {any} context @param {string} message */
function logWarning(context, message) {
    if (context.rustplus && typeof context.rustplus.log === 'function') {
        context.rustplus.log('PLAYER_INTELLIGENCE', message, 'warn');
    }
    else if (context.client && typeof context.client.log === 'function') {
        context.client.log('PLAYER_INTELLIGENCE', message, 'warn');
    }
}

/** @param {any} context @param {string} key @param {string} message */
function logWarningOnce(context, key, message) {
    const current = Date.now();
    if (warningTimes.get(key, current)) return;
    warningTimes.set(key, true, WARNING_TTL_MS, current);
    logWarning(context, message);
}

/** @param {any} scope @param {any} identity @param {any} details */
function identityEvent(scope, identity, details) {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_observed',
        observedAt: details.observedAt,
        recordedAt: details.recordedAt,
        scope: { guildId: `${details.guildId}`, serverKey: scope.serverKey, wipeId: scope.wipeId },
        subject: {
            steamId: identity.steamId,
            battlemetricsPlayerId: identity.battlemetricsPlayerId || null,
            exactName: identity.name
        },
        payload: { caseFidelity: true },
        provenance: {
            source: details.source,
            sourceEventId: details.sourceEventId,
            collectorVersion: COLLECTOR_VERSION
        },
        confidence: details.confidence,
        evidence: null
    });
}

/** @param {any} scope @param {string} steamId @param {number} playtime @param {any} details */
function playtimeEvent(scope, steamId, playtime, details) {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'player_metric_observed',
        observedAt: details.observedAt,
        recordedAt: details.recordedAt,
        scope: { guildId: `${details.guildId}`, serverKey: scope.serverKey, wipeId: scope.wipeId },
        subject: { steamId, battlemetricsPlayerId: null, exactName: null },
        payload: { provider: 'warbandits', metric: 'playtime', value: playtime, unit: 'hours' },
        provenance: {
            source: details.source,
            sourceEventId: details.sourceEventId,
            collectorVersion: COLLECTOR_VERSION
        },
        confidence: 'verified',
        evidence: null
    });
}

/** @param {readonly any[]} events @param {any} projection @param {any} scope @param {Set<string>} attempted */
function targetedLookupCandidates(events, projection, scope, attempted) {
    const requested = new Set(events.filter(event => event.kind === 'identity_observed' &&
        event.provenance.source === 'discord-steamid-list' && event.subject.steamId)
    .map(event => event.subject.steamId));
    const urgent = new Set();
    for (const person of projection.identities.persons) {
        if (!person.steamId || person.names.length > 0) continue;
        requested.add(person.steamId);
        urgent.add(person.steamId);
    }
    for (const steamId of requested) {
        const [person] = projection.identities.findByIdentifier(steamId);
        const metric = projection.metrics.getLatest({
            steamId, battlemetricsPlayerId: null, exactName: null
        }, scope.serverKey, 'warbandits', 'playtime');
        if (!person || person.names.length === 0 || !metric) urgent.add(steamId);
    }
    return [...requested].filter(steamId => !attempted.has(steamId)).sort((left, right) =>
        Number(urgent.has(right)) - Number(urgent.has(left)) || left.localeCompare(right));
}

/** @param {any} battlemetrics */
function onlinePlayers(battlemetrics) {
    const ids = Array.isArray(battlemetrics && battlemetrics.onlinePlayers) ?
        battlemetrics.onlinePlayers.map((/** @type {any} */ value) => `${value}`) :
        Object.values(battlemetrics && battlemetrics.players || {})
            .filter((/** @type {any} */ player) => player && player.status === true)
            .map((/** @type {any} */ player) => `${player.id}`);
    return [...new Set(ids)].sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
        .map(id => {
            const player = battlemetrics && battlemetrics.players && battlemetrics.players[id];
            const name = sanitize(player && player.name);
            return /^\d{1,32}$/u.test(id) && name ? { battlemetricsPlayerId: id, name } : null;
        }).filter(Boolean);
}

/** @param {any} projection @param {any[]} online */
function onlineSteamMatches(projection, online) {
    const nameCounts = new Map();
    for (const player of online) {
        const key = normalize(player.name);
        nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }
    return online.map(player => {
        const key = normalize(player.name);
        const result = Core.consolidateProjection(projection, {
            ...player,
            caseFidelity: true,
            allowExactName: Array.from(key).length >= 3 && nameCounts.get(key) === 1
        });
        if (result.status === 'conflict' || !result.identity.steamId) return null;
        return {
            ...player,
            steamId: result.identity.steamId,
            inferred: result.links.some((/** @type {any} */ link) => link.via === 'exact-name')
        };
    }).filter(Boolean);
}

/** @param {any[]} online */
function uniqueOnlineNames(online) {
    const values = new Map();
    for (const player of online) {
        const key = normalize(player.name);
        if (!key) continue;
        const list = values.get(key) || [];
        list.push(player);
        values.set(key, list);
    }
    return values;
}

/** @param {readonly any[]} events @param {any} scope @param {Set<string>} seen @param {Set<string>} refreshed */
function recoverSetsFromJournal(events, scope, seen, refreshed) {
    for (const event of events) {
        if (event.scope.serverKey !== scope.serverKey || event.scope.wipeId !== scope.wipeId ||
            !event.subject.steamId) continue;
        if (event.provenance.source === WARBANDITS_SOURCE) seen.add(event.subject.steamId);
        if (event.provenance.source === ONLINE_SOURCE ||
            (event.provenance.source === WARBANDITS_SOURCE && event.subject.battlemetricsPlayerId)) {
            refreshed.add(event.subject.steamId);
        }
    }
}

/**
 * Runs one bounded unit of work. The caller supplies the already-selected current server scope.
 * @param {{context:any,scope:any,store:any,directory:string,dependencies?:any,warBanditsProvider?:any,
 * forceWarBanditsRescan?:boolean,planOnly?:boolean,isolateProcess?:boolean}} options
 */
async function runCycle(options) {
    if (!options || !options.scope || !options.scope.wipeId || !options.store ||
        typeof options.directory !== 'string') return Object.freeze({ skipped: true });
    assertMatchingStoreDirectory(options);
    const dependencies = options.dependencies || {};
    const current = nowDate(dependencies);
    const recordedAt = current.toISOString();
    const state = await readState(options, current);
    const forcedRescan = options.forceWarBanditsRescan === true;
    if (forcedRescan) {
        state.nextWarBanditsPage = 1;
        state.warBanditsResumeAt = null;
        state.targetedLookupSteamIds = [];
        state.targetedLookupRetries = [];
        state.targetedFreshStreak = 0;
        state.steamProfileRetries = [];
        state.steamProfileFreshStreak = 0;
        state.pendingReconciliation = PendingReconciler.startCheckpoint(recordedAt);
        state.warBanditsRetryAt = null;
        state.warBanditsFailures = 0;
    }
    const seen = new Set(state.seenWarBanditsSteamIds);
    const refreshed = new Set(state.refreshedSteamIds);
    const targeted = new Set(state.targetedLookupSteamIds);
    const targetedRetries = new Map(state.targetedLookupRetries.map((/** @type {any} */ retry) =>
        [`${retry.steamId}`, { ...retry, steamId: `${retry.steamId}` }]));
    const profiled = new Set(state.profiledSteamIds);
    const steamProfileRetries = new Map(state.steamProfileRetries.map((/** @type {any} */ retry) =>
        [`${retry.steamId}`, { ...retry, steamId: `${retry.steamId}` }]));
    let baseRevision = null;
    let baseControlRevision = null;
    let existing;
    if (options.planOnly === true) {
        if (typeof options.store.readSnapshot !== 'function') {
            throw new TypeError('Read-only player scan planning requires a revisioned journal snapshot.');
        }
        const snapshot = await options.store.readSnapshot();
        existing = snapshot.events;
        baseRevision = snapshot.revision;
        baseControlRevision = controlRevision(existing);
    }
    else existing = await options.store.readAll();
    recoverSetsFromJournal(existing, options.scope, seen, refreshed);
    const projection = Core.rebuild(existing);
    const provider = options.warBanditsProvider;
    const battlemetricsProvider = dependencies.battlemetricsProvider;
    const reliable = options.scope.battlemetrics &&
        options.scope.battlemetrics.lastUpdateSuccessful === true &&
        options.scope.battlemetrics.streamerMode !== true;
    const online = reliable ? onlinePlayers(options.scope.battlemetrics) : [];
    const token = wipeToken(options.scope.wipeId);
    const events = [];
    const newlyRefreshed = new Set();
    const newlySeen = new Set();
    let targetedLookups = 0;
    let metricsObserved = 0;
    let steamProfilesRefreshed = 0;
    let steamProfileAttempts = 0;
    let steamProfileFailures = 0;
    let targetedLookupFailures = 0;
    let warBanditsPageFailures = 0;
    let pendingBattlemetricsAttempts = 0;
    let pendingWarBanditsAttempts = 0;
    let pendingIdentitiesLinked = 0;
    let pendingReconciliationCompleted = false;
    const newlyLinkedPairs = new Set();
    const cycleBattlemetricsBySteamId = new Map();
    const cycleSteamByBattlemetricsId = new Map();
    let retryChanged = forcedRescan;
    let reconciliationChanged = forcedRescan;

    /** @param {string|null} steamId @param {string|null} battlemetricsPlayerId */
    function cyclePairConflicts(steamId, battlemetricsPlayerId) {
        if (!steamId || !battlemetricsPlayerId) return false;
        const knownBattlemetricsId = cycleBattlemetricsBySteamId.get(steamId);
        const knownSteamId = cycleSteamByBattlemetricsId.get(battlemetricsPlayerId);
        return Boolean((knownBattlemetricsId && knownBattlemetricsId !== battlemetricsPlayerId) ||
            (knownSteamId && knownSteamId !== steamId));
    }

    /** @param {string|null} steamId @param {string|null} battlemetricsPlayerId */
    function rememberCyclePair(steamId, battlemetricsPlayerId) {
        if (!steamId || !battlemetricsPlayerId) return;
        cycleBattlemetricsBySteamId.set(steamId, battlemetricsPlayerId);
        cycleSteamByBattlemetricsId.set(battlemetricsPlayerId, steamId);
    }
    for (const steamId of targeted) {
        if (targetedRetries.delete(steamId)) retryChanged = true;
    }
    for (const steamId of profiled) {
        if (steamProfileRetries.delete(steamId)) retryChanged = true;
    }
    const latestPlaytimes = new Map(projection.metrics.observations
        .filter(value => value.serverKey === options.scope.serverKey && value.provider === 'warbandits' &&
            value.metric === 'playtime' && value.personId.startsWith('steam:'))
        .map(value => [value.personId.slice(6), value.value]));

    /** @param {any} row @param {string} source @param {string} observedAt */
    function observePlaytime(row, source, observedAt) {
        const steamId = `${row && row.steamId || ''}`;
        const playtime = Number(row && row.playtime);
        if (!/^7656119\d{10}$/u.test(steamId) || !Number.isFinite(playtime) || playtime < 0 ||
            latestPlaytimes.get(steamId) === playtime) return;
        events.push(playtimeEvent(options.scope, steamId, playtime, {
            guildId: options.context.guildId,
            observedAt,
            recordedAt,
            source,
            sourceEventId: `playtime:${token}:${steamId}:${playtime}`
        }));
        latestPlaytimes.set(steamId, playtime);
        metricsObserved += 1;
    }

    const reconciliation = state.pendingReconciliation;
    const checkedBattlemetricsIds = new Set(reconciliation.checkedBattlemetricsIds);
    const battlemetricsRetries = new Map(reconciliation.battlemetricsRetries.map((/** @type {any} */ retry) =>
        [`${retry.battlemetricsPlayerId}`, { ...retry, battlemetricsPlayerId: `${retry.battlemetricsPlayerId}` }]));
    const checkedWarBanditsKeys = new Set(reconciliation.checkedWarBanditsKeys);
    const pendingWarBanditsRetries = new Map(reconciliation.warBanditsRetries.map((/** @type {any} */ retry) =>
        [`${retry.key}`, { ...retry, key: `${retry.key}` }]));
    const reconciliationRows = reconciliation.active ? PendingReconciler.pendingRows(projection) : [];
    const pendingBattlemetricsCandidates = reconciliation.active ?
        PendingReconciler.battlemetricsCandidates(projection, reconciliationRows) : [];
    const campaignBattlemetricsIds = new Set(pendingBattlemetricsCandidates
        .map(candidate => candidate.battlemetricsPlayerId));
    const battlemetricsEnabled = battlemetricsProvider && typeof battlemetricsProvider.resolveSteamId === 'function';
    const warBanditsLookupEnabled = provider && (typeof provider.resolvePlayerRecent === 'function' ||
        typeof provider.resolvePlayer === 'function');
    const pendingBattlemetricsReady = reconciliation.battlemetricsRetryAt === null ||
        Date.parse(reconciliation.battlemetricsRetryAt) <= current.getTime();
    const pendingWarBanditsReady = reconciliation.warBanditsRetryAt === null ||
        Date.parse(reconciliation.warBanditsRetryAt) <= current.getTime();
    const warBanditsCandidates = () => PendingReconciler.warBanditsCandidates(
        projection, checkedBattlemetricsIds, Boolean(battlemetricsEnabled), reconciliationRows);
    const finishWarBanditsPerson = (/** @type {string} */ personId) => {
        for (const candidate of warBanditsCandidates().filter(item => item.personId === personId)) {
            checkedWarBanditsKeys.add(candidate.key);
            pendingWarBanditsRetries.delete(candidate.key);
        }
    };
    const pendingClock = typeof dependencies.monotonicNow === 'function' ?
        dependencies.monotonicNow : () => Performance.now();
    const pendingStartedAt = Number(pendingClock());
    const pendingBudgetAvailable = () => {
        const elapsed = Number(pendingClock()) - pendingStartedAt;
        return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < PENDING_RECONCILIATION_BUDGET_MS;
    };

    if (reconciliation.active && battlemetricsEnabled && pendingBattlemetricsReady) {
        for (let attempt = 0; attempt < PENDING_BATTLEMETRICS_BATCH_SIZE && pendingBudgetAvailable(); attempt += 1) {
            const selection = PendingReconciler.selectWork(
                pendingBattlemetricsCandidates, checkedBattlemetricsIds,
                battlemetricsRetries, 'battlemetricsPlayerId', current, reconciliation.battlemetricsFreshStreak);
            const candidate = selection.candidate;
            if (!candidate) break;
            reconciliation.battlemetricsFreshStreak = selection.nextFreshStreak;
            pendingBattlemetricsAttempts += 1;
            reconciliationChanged = true;
            let result = null;
            try {
                result = await battlemetricsProvider.resolveSteamId(candidate.battlemetricsPlayerId, dependencies);
            }
            catch (error) {
                logWarningOnce(options.context, `battlemetrics-identifier:${candidate.battlemetricsPlayerId}`,
                    `BattleMetrics identifier lookup paused safely: ${error instanceof Error ? error.message : error}.`);
            }
            const returnedSteamId = result && result.steamId;
            if (result && result.available === true && returnedSteamId === null) {
                reconciliation.battlemetricsFailures = 0;
                reconciliation.battlemetricsRetryAt = null;
                checkedBattlemetricsIds.add(candidate.battlemetricsPlayerId);
                battlemetricsRetries.delete(candidate.battlemetricsPlayerId);
                reconciliation.noMatch += 1;
            }
            else if (result && result.available === true && /^7656119\d{10}$/u.test(`${returnedSteamId || ''}`)) {
                reconciliation.battlemetricsFailures = 0;
                reconciliation.battlemetricsRetryAt = null;
                const steamId = `${returnedSteamId}`;
                const consolidated = Core.consolidateProjection(projection, {
                    steamId, battlemetricsPlayerId: candidate.battlemetricsPlayerId,
                    name: null, caseFidelity: true, allowExactName: false
                });
                checkedBattlemetricsIds.add(candidate.battlemetricsPlayerId);
                battlemetricsRetries.delete(candidate.battlemetricsPlayerId);
                finishWarBanditsPerson(candidate.personId);
                if (consolidated.status === 'conflict' ||
                    cyclePairConflicts(steamId, candidate.battlemetricsPlayerId)) {
                    reconciliation.conflicts += 1;
                }
                else {
                    rememberCyclePair(steamId, candidate.battlemetricsPlayerId);
                    events.push(identityEvent(options.scope, {
                        steamId, battlemetricsPlayerId: candidate.battlemetricsPlayerId, name: null
                    }, {
                        guildId: options.context.guildId,
                        observedAt: recordedAt,
                        recordedAt,
                        source: BATTLEMETRICS_IDENTIFIER_SOURCE,
                        sourceEventId: `battlemetrics-identifier:${candidate.battlemetricsPlayerId}:${steamId}`,
                        confidence: 'verified'
                    }));
                    reconciliation.linked += 1;
                    pendingIdentitiesLinked += 1;
                    newlyLinkedPairs.add(`${steamId}\u0000${candidate.battlemetricsPlayerId}`);
                }
            }
            else if (result && result.available === false && result.reason === 'not found') {
                reconciliation.battlemetricsFailures = 0;
                reconciliation.battlemetricsRetryAt = null;
                checkedBattlemetricsIds.add(candidate.battlemetricsPlayerId);
                battlemetricsRetries.delete(candidate.battlemetricsPlayerId);
                reconciliation.noMatch += 1;
            }
            else {
                recordPendingRetry(battlemetricsRetries, candidate.battlemetricsPlayerId,
                    'battlemetricsPlayerId', current, result && result.retryAt);
                reconciliation.battlemetricsFailures = Math.min(1000,
                    reconciliation.battlemetricsFailures + 1);
                reconciliation.battlemetricsRetryAt = retryAt(current,
                    reconciliation.battlemetricsFailures, result && result.retryAt);
                break;
            }
        }
    }

    if (reconciliation.active && warBanditsLookupEnabled && pendingWarBanditsReady) {
        for (let attempt = 0; attempt < PENDING_WARBANDITS_BATCH_SIZE && pendingBudgetAvailable(); attempt += 1) {
            const candidates = warBanditsCandidates();
            const selection = PendingReconciler.selectWork(candidates, checkedWarBanditsKeys,
                pendingWarBanditsRetries, 'key', current, reconciliation.warBanditsFreshStreak);
            const candidate = selection.candidate;
            if (!candidate) break;
            reconciliation.warBanditsFreshStreak = selection.nextFreshStreak;
            pendingWarBanditsAttempts += 1;
            reconciliationChanged = true;
            let result = null;
            try {
                result = typeof provider.resolvePlayerRecent === 'function' ?
                    await provider.resolvePlayerRecent(options.context, options.scope, candidate.query) :
                    await provider.resolvePlayer(options.context, options.scope, candidate.query);
            }
            catch (error) {
                logWarningOnce(options.context, `warbandits-pending:${candidate.key}`,
                    `WarBandits pending reconciliation paused safely: ${error instanceof Error ?
                        error.message : error}.`);
            }
            const player = result && result.available === true && result.ambiguous !== true ? result.player : null;
            if (PendingReconciler.exactWarBanditsMatch(player, candidate.query)) {
                reconciliation.warBanditsFailures = 0;
                reconciliation.warBanditsRetryAt = null;
                const steamId = `${player.steamId}`;
                const consolidated = Core.consolidateProjection(projection, {
                    steamId, battlemetricsPlayerId: candidate.battlemetricsPlayerId,
                    name: candidate.query, caseFidelity: true,
                    allowExactName: candidate.battlemetricsPlayerId === null
                });
                checkedWarBanditsKeys.add(candidate.key);
                pendingWarBanditsRetries.delete(candidate.key);
                if (candidate.battlemetricsPlayerId) {
                    checkedBattlemetricsIds.add(candidate.battlemetricsPlayerId);
                    battlemetricsRetries.delete(candidate.battlemetricsPlayerId);
                }
                if (consolidated.status === 'conflict' ||
                    cyclePairConflicts(steamId, candidate.battlemetricsPlayerId)) {
                    finishWarBanditsPerson(candidate.personId);
                    reconciliation.conflicts += 1;
                }
                else {
                    finishWarBanditsPerson(candidate.personId);
                    if (candidate.battlemetricsPlayerId) {
                        rememberCyclePair(steamId, candidate.battlemetricsPlayerId);
                        events.push(identityEvent(options.scope, {
                            steamId, battlemetricsPlayerId: candidate.battlemetricsPlayerId, name: null
                        }, {
                            guildId: options.context.guildId,
                            observedAt: canonicalIso(result.observedAt) || recordedAt,
                            recordedAt,
                            source: WARBANDITS_PENDING_SOURCE,
                            sourceEventId: `warbandits-pending-pair:${candidate.key}:${steamId}`,
                            confidence: 'probable'
                        }));
                    }
                    const names = new Set([candidate.query, player.name,
                        ...(Array.isArray(player.aliases) ? player.aliases : [])]
                        .map(sanitize).filter(name => name && Array.from(name).length <= 128));
                    for (const name of names) {
                        events.push(identityEvent(options.scope, {
                            steamId, battlemetricsPlayerId: null, name
                        }, {
                            guildId: options.context.guildId,
                            observedAt: canonicalIso(result.observedAt) || recordedAt,
                            recordedAt,
                            source: WARBANDITS_PENDING_SOURCE,
                            sourceEventId: `warbandits-pending:${candidate.key}:${steamId}:${shortToken(name)}`,
                            confidence: 'verified'
                        }));
                    }
                    reconciliation.linked += 1;
                    pendingIdentitiesLinked += 1;
                    if (candidate.battlemetricsPlayerId) {
                        newlyLinkedPairs.add(`${steamId}\u0000${candidate.battlemetricsPlayerId}`);
                    }
                    observePlaytime(player, WARBANDITS_PENDING_SOURCE,
                        canonicalIso(result.observedAt) || recordedAt);
                }
            }
            else if (result && result.available === true) {
                reconciliation.warBanditsFailures = 0;
                reconciliation.warBanditsRetryAt = null;
                checkedWarBanditsKeys.add(candidate.key);
                pendingWarBanditsRetries.delete(candidate.key);
                reconciliation.noMatch += 1;
            }
            else {
                recordPendingRetry(pendingWarBanditsRetries, candidate.key, 'key', current,
                    result && (result.retryAt || result.cooldownUntil));
                reconciliation.warBanditsFailures = Math.min(1000, reconciliation.warBanditsFailures + 1);
                reconciliation.warBanditsRetryAt = retryAt(current, reconciliation.warBanditsFailures,
                    result && (result.retryAt || result.cooldownUntil));
                break;
            }
        }
    }

    const steamProfileIdentity = dependencies.steamProfileIdentity;
    if (typeof steamProfileIdentity === 'function') {
        const profileSteamIds = projection.identities.persons
            .map((/** @type {any} */ person) => person.steamId)
            .filter((/** @type {any} */ steamId) => steamId && !profiled.has(steamId));
        const freshSteamIds = profileSteamIds.filter((/** @type {string} */ steamId) =>
            !steamProfileRetries.has(steamId)).sort();
        const dueSteamIds = profileSteamIds.filter((/** @type {string} */ steamId) => {
            const retry = steamProfileRetries.get(steamId);
            return retry && Date.parse(retry.nextAttemptAt) <= current.getTime();
        }).sort((left, right) => {
            const leftRetry = /** @type {any} */ (steamProfileRetries.get(left));
            const rightRetry = /** @type {any} */ (steamProfileRetries.get(right));
            return leftRetry.nextAttemptAt.localeCompare(rightRetry.nextAttemptAt) || left.localeCompare(right);
        });
        const useRetry = dueSteamIds.length > 0 &&
            (freshSteamIds.length === 0 || state.steamProfileFreshStreak >= FRESH_BURST_LIMIT);
        const profileSteamId = useRetry ? dueSteamIds[0] : freshSteamIds[0];
        if (profileSteamId) {
            state.steamProfileFreshStreak = useRetry ? 0 :
                Math.min(FRESH_BURST_LIMIT, state.steamProfileFreshStreak + 1);
            retryChanged = true;
            steamProfileAttempts = 1;
            let profile = null;
            try {
                profile = await steamProfileIdentity(profileSteamId);
            }
            catch (error) {
                logWarningOnce(options.context, `steam-profile:${profileSteamId}`,
                    `Steam profile history unavailable for ${profileSteamId}: ${error instanceof Error ?
                        error.message : error}.`);
            }
            const currentName = sanitize(profile && profile.currentName);
            let profileComplete = false;
            if (profile && `${profile.steamId}` === profileSteamId && currentName) {
                let current = Core.consolidateProjection(projection, {
                    steamId: profileSteamId, battlemetricsPlayerId: null,
                    name: currentName, caseFidelity: true
                });
                if (current.status === 'conflict') {
                    current = Core.consolidateProjection(projection, {
                        steamId: profileSteamId, battlemetricsPlayerId: null,
                        name: currentName, caseFidelity: true, allowExactName: false
                    });
                }
                const knownProfile = projection.identities.getPerson(`steam:${profileSteamId}`);
                const currentAlreadyKnown = knownProfile && knownProfile.names.some((/** @type {any} */ alias) =>
                    alias.name === currentName && alias.steamStatus === 'current');
                if (!currentAlreadyKnown) {
                    events.push(identityEvent(options.scope, current.identity, {
                        guildId: options.context.guildId,
                        observedAt: recordedAt,
                        recordedAt,
                        source: STEAM_CURRENT_SOURCE,
                        sourceEventId: `steam-current:${token}:${profileSteamId}:${shortToken(currentName)}`,
                        confidence: 'verified'
                    }));
                }
                const pastNames = new Set((Array.isArray(profile.pastAliases) ? profile.pastAliases : [])
                    .map((/** @type {any} */ alias) => sanitize(alias && alias.name || alias))
                    .filter((/** @type {string} */ name) => name && name !== currentName));
                for (const name of pastNames) {
                    const pastAlreadyKnown = knownProfile && knownProfile.names.some((/** @type {any} */ alias) =>
                        alias.name === name && alias.steamStatus === 'past');
                    if (pastAlreadyKnown) continue;
                    const historical = Core.consolidateProjection(projection, {
                        steamId: profileSteamId, battlemetricsPlayerId: null,
                        name, caseFidelity: true, allowExactName: false
                    });
                    events.push(identityEvent(options.scope, historical.identity, {
                        guildId: options.context.guildId,
                        observedAt: recordedAt,
                        recordedAt,
                        source: STEAM_ALIAS_SOURCE,
                        sourceEventId: `steam-alias:${token}:${profileSteamId}:${shortToken(name)}`,
                        confidence: 'verified'
                    }));
                }
                if (profile.aliasesComplete !== false) {
                    profiled.add(profileSteamId);
                    steamProfilesRefreshed = 1;
                    profileComplete = true;
                }
            }
            if (profileComplete) {
                if (steamProfileRetries.delete(profileSteamId)) retryChanged = true;
            }
            else {
                recordRetry(steamProfileRetries, profileSteamId, current, MAX_STEAM_PROFILE_RETRIES);
                steamProfileFailures = 1;
                retryChanged = true;
            }
        }
    }

    for (const match of onlineSteamMatches(projection, online)) {
        if (events.length >= MAX_LOCAL_REFRESHES_PER_CYCLE || refreshed.has(match.steamId)) continue;
        if (cyclePairConflicts(match.steamId, match.battlemetricsPlayerId)) continue;
        rememberCyclePair(match.steamId, match.battlemetricsPlayerId);
        events.push(identityEvent(options.scope, match, {
            guildId: options.context.guildId,
            observedAt: canonicalIso(options.scope.battlemetrics.updatedAt) || recordedAt,
            recordedAt,
            source: ONLINE_SOURCE,
            sourceEventId: `online:${token}:${match.steamId}`,
            confidence: match.inferred ? 'probable' : 'verified'
        }));
        newlyRefreshed.add(match.steamId);
    }

    if (provider && (typeof provider.resolvePlayerRecent === 'function' ||
        typeof provider.resolvePlayer === 'function')) {
        const candidates = targetedLookupCandidates(existing, projection, options.scope, targeted);
        const freshSteamId = candidates.find(steamId => !targetedRetries.has(steamId));
        const dueSteamId = candidates.filter(steamId => {
            const retry = targetedRetries.get(steamId);
            return retry && Date.parse(retry.nextAttemptAt) <= current.getTime();
        }).sort((left, right) => {
            const leftRetry = /** @type {any} */ (targetedRetries.get(left));
            const rightRetry = /** @type {any} */ (targetedRetries.get(right));
            return leftRetry.nextAttemptAt.localeCompare(rightRetry.nextAttemptAt) || left.localeCompare(right);
        })[0];
        const useRetry = Boolean(dueSteamId) &&
            (!freshSteamId || state.targetedFreshStreak >= FRESH_BURST_LIMIT);
        const steamId = useRetry ? dueSteamId : freshSteamId;
        if (steamId) {
            state.targetedFreshStreak = useRetry ? 0 :
                Math.min(FRESH_BURST_LIMIT, state.targetedFreshStreak + 1);
            retryChanged = true;
            let lookup = null;
            try {
                lookup = typeof provider.resolvePlayerRecent === 'function' ?
                    await provider.resolvePlayerRecent(options.context, options.scope, steamId) :
                    await provider.resolvePlayer(options.context, options.scope, steamId);
            }
            catch (error) {
                logWarningOnce(options.context, `warbandits-lookup:${steamId}`,
                    `WarBandits targeted lookup paused safely for ${steamId}: ${error instanceof Error ?
                        error.message : error}.`);
            }
            const lookupValid = lookup && lookup.available && (!lookup.player ||
                `${lookup.player.steamId}` === steamId);
            if (lookupValid) {
                targeted.add(steamId);
                if (targetedRetries.delete(steamId)) retryChanged = true;
                targetedLookups = 1;
                const player = lookup.player;
                if (player && `${player.steamId}` === steamId) {
                    const name = sanitize(player.name);
                    const observedAt = canonicalIso(lookup.observedAt) || recordedAt;
                    if (name) {
                        const live = uniqueOnlineNames(online).get(normalize(name)) || [];
                        const liveBattlemetricsPlayerId = Array.from(normalize(name)).length >= 3 && live.length === 1 ?
                            live[0].battlemetricsPlayerId : null;
                        let consolidated = Core.consolidateProjection(projection, {
                            steamId, battlemetricsPlayerId: liveBattlemetricsPlayerId, name, caseFidelity: true
                        });
                        if (consolidated.status === 'conflict' || cyclePairConflicts(
                            consolidated.identity.steamId, consolidated.identity.battlemetricsPlayerId)) {
                            consolidated = Core.consolidateProjection(projection, {
                                steamId, battlemetricsPlayerId: null, name,
                                caseFidelity: true, allowExactName: false
                            });
                        }
                        if (!cyclePairConflicts(consolidated.identity.steamId,
                            consolidated.identity.battlemetricsPlayerId)) {
                            rememberCyclePair(consolidated.identity.steamId,
                                consolidated.identity.battlemetricsPlayerId);
                        }
                        else {
                            consolidated = { ...consolidated, identity: {
                                ...consolidated.identity, battlemetricsPlayerId: null
                            } };
                        }
                        events.push(identityEvent(options.scope, consolidated.identity, {
                            guildId: options.context.guildId,
                            observedAt,
                            recordedAt,
                            source: WARBANDITS_LOOKUP_SOURCE,
                            sourceEventId: `warbandits-lookup:${token}:${steamId}`,
                            confidence: 'verified'
                        }));
                        if (consolidated.identity.battlemetricsPlayerId) newlyRefreshed.add(steamId);
                    }
                    observePlaytime(player, WARBANDITS_LOOKUP_SOURCE, observedAt);
                }
            }
            else {
                recordRetry(targetedRetries, steamId, current, MAX_TARGETED_RETRIES,
                    lookup && (lookup.retryAt || lookup.cooldownUntil));
                targetedLookupFailures = 1;
                retryChanged = true;
            }
        }
    }
    const resumeDue = state.warBanditsResumeAt === null || Date.parse(state.warBanditsResumeAt) <= current.getTime();
    const retryDue = state.warBanditsRetryAt === null || Date.parse(state.warBanditsRetryAt) <= current.getTime();
    let scan = null;
    let scanSucceeded = false;
    if (provider && typeof provider.scanCurrentWipePage === 'function' && resumeDue && retryDue) {
        try {
            scan = await provider.scanCurrentWipePage(options.context, options.scope, state.nextWarBanditsPage);
        }
        catch (error) {
            logWarningOnce(options.context, `warbandits-page:${state.nextWarBanditsPage}`,
                `WarBandits page ${state.nextWarBanditsPage} paused safely: ${error instanceof Error ?
                    error.message : error}.`);
        }
        scanSucceeded = Boolean(scan && scan.available && Array.isArray(scan.rows) && scan.rows.length <= 100 &&
            (scan.page === undefined || scan.page === state.nextWarBanditsPage) &&
            ((scan.complete === true && scan.nextPage === null) ||
                (scan.complete === false && scan.nextPage === state.nextWarBanditsPage + 1)));
        if (scanSucceeded) {
            if (state.warBanditsFailures > 0 || state.warBanditsRetryAt !== null) retryChanged = true;
            state.warBanditsFailures = 0;
            state.warBanditsRetryAt = null;
        }
        else {
            state.warBanditsFailures = Math.min(1000, state.warBanditsFailures + 1);
            state.warBanditsRetryAt = retryAt(current, state.warBanditsFailures,
                scan && (scan.retryAt || scan.cooldownUntil));
            warBanditsPageFailures = 1;
            retryChanged = true;
        }
        if (scanSucceeded) {
            const onlineNames = uniqueOnlineNames(online);
            for (const row of scan.rows) {
                const steamId = `${row && row.steamId || ''}`;
                const name = sanitize(row && row.name);
                if (!/^7656119\d{10}$/u.test(steamId) || !name) continue;
                const observedAt = canonicalIso(scan.observedAt) || recordedAt;
                const firstObservation = !seen.has(steamId) && !newlySeen.has(steamId);
                if (firstObservation || reconciliation.active) {
                    const live = onlineNames.get(normalize(name)) || [];
                    const liveBattlemetricsPlayerId = Array.from(normalize(name)).length >= 3 && live.length === 1 ?
                        live[0].battlemetricsPlayerId : null;
                    let consolidated = Core.consolidateProjection(projection, {
                        steamId, battlemetricsPlayerId: liveBattlemetricsPlayerId, name, caseFidelity: true
                    });
                    if (consolidated.status === 'conflict' || cyclePairConflicts(
                        consolidated.identity.steamId, consolidated.identity.battlemetricsPlayerId)) {
                        consolidated = Core.consolidateProjection(projection, {
                            steamId, battlemetricsPlayerId: null, name,
                            caseFidelity: true, allowExactName: false
                        });
                    }
                    if (!cyclePairConflicts(consolidated.identity.steamId,
                        consolidated.identity.battlemetricsPlayerId)) {
                        rememberCyclePair(consolidated.identity.steamId,
                            consolidated.identity.battlemetricsPlayerId);
                    }
                    else {
                        consolidated = { ...consolidated, identity: {
                            ...consolidated.identity, battlemetricsPlayerId: null
                        } };
                    }
                    const battlemetricsPlayerId = consolidated.identity.battlemetricsPlayerId;
                    const pairKey = battlemetricsPlayerId ? `${steamId}\u0000${battlemetricsPlayerId}` : null;
                    const pairKnown = battlemetricsPlayerId && projection.identities.findByIdentifier(steamId)
                        .some((/** @type {any} */ person) =>
                            person.battlemetricsPlayerIds.includes(battlemetricsPlayerId));
                    if (firstObservation || (reconciliation.active && pairKey &&
                        !pairKnown && !newlyLinkedPairs.has(pairKey))) {
                        events.push(identityEvent(options.scope, consolidated.identity, {
                            guildId: options.context.guildId,
                            observedAt,
                            recordedAt,
                            source: WARBANDITS_SOURCE,
                            sourceEventId: `warbandits:${token}:${steamId}:${battlemetricsPlayerId || 'none'}`,
                            confidence: 'verified'
                        }));
                        if (firstObservation) newlySeen.add(steamId);
                        if (battlemetricsPlayerId) {
                            newlyRefreshed.add(steamId);
                            newlyLinkedPairs.add(/** @type {string} */ (pairKey));
                        }
                        if (battlemetricsPlayerId && campaignBattlemetricsIds.has(battlemetricsPlayerId)) {
                            checkedBattlemetricsIds.add(battlemetricsPlayerId);
                            battlemetricsRetries.delete(battlemetricsPlayerId);
                            const candidate = pendingBattlemetricsCandidates.find(item =>
                                item.battlemetricsPlayerId === battlemetricsPlayerId);
                            if (candidate) finishWarBanditsPerson(candidate.personId);
                            reconciliation.linked += 1;
                            pendingIdentitiesLinked += 1;
                            reconciliationChanged = true;
                        }
                    }
                }
                observePlaytime(row, WARBANDITS_SOURCE, observedAt);
            }
        }
    }

    if (reconciliation.active) {
        const battlemetricsOutstanding = Boolean(battlemetricsEnabled) &&
            pendingBattlemetricsCandidates.some(candidate =>
                !checkedBattlemetricsIds.has(candidate.battlemetricsPlayerId));
        const warBanditsOutstanding = Boolean(warBanditsLookupEnabled) &&
            warBanditsCandidates()
                .some(candidate => !checkedWarBanditsKeys.has(candidate.key));
        if (pendingIdentitiesLinked === 0 && !battlemetricsOutstanding && !warBanditsOutstanding) {
            reconciliation.active = false;
            reconciliation.completedAt = recordedAt;
            pendingReconciliationCompleted = true;
            reconciliationChanged = true;
        }
    }

    newlySeen.forEach(value => seen.add(value));
    newlyRefreshed.forEach(value => refreshed.add(value));
    let changed = forcedRescan || state.needsMigrationWrite === true || retryChanged || reconciliationChanged ||
        events.length > 0 ||
        seen.size !== state.seenWarBanditsSteamIds.length ||
        targeted.size !== state.targetedLookupSteamIds.length ||
        refreshed.size !== state.refreshedSteamIds.length || profiled.size !== state.profiledSteamIds.length ||
        steamProfileRetries.size !== state.steamProfileRetries.length;
    if (scanSucceeded) {
        changed = true;
        if (scan.complete || scan.nextPage === null) {
            state.nextWarBanditsPage = 1;
            state.warBanditsResumeAt = new Date(current.getTime() + RESCAN_DELAY_MS).toISOString();
            state.warBanditsSweeps += 1;
        }
        else {
            state.nextWarBanditsPage = scan.nextPage;
            state.warBanditsResumeAt = null;
        }
    }
    state.seenWarBanditsSteamIds = [...seen].sort();
    state.targetedLookupSteamIds = [...targeted].sort();
    state.targetedLookupRetries = [...targetedRetries.values()].sort((left, right) =>
        left.steamId.localeCompare(right.steamId));
    state.refreshedSteamIds = [...refreshed].sort();
    state.profiledSteamIds = [...profiled].sort();
    state.steamProfileRetries = [...steamProfileRetries.values()].sort((left, right) =>
        left.steamId.localeCompare(right.steamId));
    reconciliation.checkedBattlemetricsIds = [...checkedBattlemetricsIds].sort((left, right) =>
        left.localeCompare(right, 'en', { numeric: true }));
    reconciliation.battlemetricsRetries = [...battlemetricsRetries.values()].sort((left, right) =>
        left.battlemetricsPlayerId.localeCompare(right.battlemetricsPlayerId, 'en', { numeric: true }));
    reconciliation.checkedWarBanditsKeys = [...checkedWarBanditsKeys].sort();
    reconciliation.warBanditsRetries = [...pendingWarBanditsRetries.values()].sort((left, right) =>
        left.key.localeCompare(right.key));
    state.updatedAt = recordedAt;
    const shouldWriteState = changed || !Fs.existsSync(statePath(options.directory));
    const validatedState = shouldWriteState ? validateState(state, options) : null;
    const result = Object.freeze({
        skipped: false,
        appended: events.length,
        onlineRefreshed: newlyRefreshed.size,
        warBanditsSeen: newlySeen.size,
        targetedLookups,
        targetedLookupFailures,
        warBanditsPageFailures,
        metricsObserved,
        steamProfileAttempts,
        steamProfileFailures,
        steamProfilesRefreshed,
        pendingBattlemetricsAttempts,
        pendingWarBanditsAttempts,
        pendingIdentitiesLinked,
        pendingReconciliationActive: reconciliation.active,
        pendingReconciliationCompleted,
        nextWarBanditsPage: state.nextWarBanditsPage,
        warBanditsResumeAt: state.warBanditsResumeAt,
        warBanditsRetryAt: state.warBanditsRetryAt
    });
    if (options.planOnly === true) {
        return Object.freeze({
            protocolVersion: PLAN_PROTOCOL_VERSION,
            baseRevision,
            baseControlRevision,
            baseStateRevision: state.baseStateRevision,
            identityGuards: Object.freeze(plannedIdentityGuards(existing, events)),
            result,
            events: Object.freeze([...events]),
            state: validatedState
        });
    }
    if (events.length > 0) await options.store.appendMany(events);
    if (validatedState) await writeStateAtomic(statePath(options.directory), validatedState);
    return result;
}

/**
 * Applies a worker-created plan. Only the parent process calls this function, preserving the journal's
 * single-writer boundary. Events are canonicalized again and constrained to the requested guild/server/wipe.
 * @param {Parameters<typeof runCycle>[0]} options @param {unknown} input
 */
async function commitPlan(options, input) {
    if (!options || !options.scope || !options.scope.wipeId || !options.store ||
        typeof options.directory !== 'string') throw new TypeError('Player scan commit options are invalid.');
    assertMatchingStoreDirectory(options);
    assertCurrentScope(options);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Player scan plan is invalid.');
    }
    const plan = /** @type {any} */ (input);
    const planKeys = Object.keys(plan);
    if (planKeys.length !== PLAN_FIELDS.length || planKeys.some(key => !PLAN_FIELDS.includes(key)) ||
        plan.protocolVersion !== PLAN_PROTOCOL_VERSION ||
        typeof plan.baseRevision !== 'string' || !/^pi-revision:[a-f0-9]{64}$/u.test(plan.baseRevision) ||
        typeof plan.baseControlRevision !== 'string' ||
        !/^pi-control-revision:[a-f0-9]{64}$/u.test(plan.baseControlRevision) ||
        typeof plan.baseStateRevision !== 'string' ||
        !/^pi-scan-state:(?:absent|[a-f0-9]{64})$/u.test(plan.baseStateRevision) ||
        !plan.result || typeof plan.result !== 'object' ||
        Array.isArray(plan.result) ||
        !Array.isArray(plan.events) || plan.events.length > 5000 ||
        !Array.isArray(plan.identityGuards) || plan.identityGuards.length > MAX_IDENTITY_GUARDS ||
        (plan.state !== null && (!plan.state || typeof plan.state !== 'object' || Array.isArray(plan.state)))) {
        throw new TypeError('Player scan plan protocol is invalid.');
    }
    // Capture all worker-controlled scalars before the first await. IPC normally clones the object, but this also
    // makes direct/injected runners immune to a caller mutating a previously validated plan during commit.
    const baseRevision = plan.baseRevision;
    const baseControlRevision = plan.baseControlRevision;
    const baseStateRevision = plan.baseStateRevision;
    const expectedScope = {
        guildId: `${options.context.guildId}`,
        serverKey: `${options.scope.serverKey}`,
        wipeId: `${options.scope.wipeId}`
    };
    const events = plan.events.map((/** @type {unknown} */ event, /** @type {number} */ index) => {
        const canonical = Core.createEvent(event);
        if (canonical.scope.guildId !== expectedScope.guildId ||
            canonical.scope.serverKey !== expectedScope.serverKey ||
            canonical.scope.wipeId !== expectedScope.wipeId) {
            throw new TypeError(`Player scan plan event ${index} escaped its requested scope.`);
        }
        const sources = canonical.kind === 'identity_observed' ? PLAN_IDENTITY_SOURCES :
            canonical.kind === 'player_metric_observed' ? PLAN_METRIC_SOURCES : null;
        if (!sources || !sources.has(canonical.provenance.source) ||
            canonical.provenance.collectorVersion !== COLLECTOR_VERSION || canonical.evidence !== null) {
            throw new TypeError(`Player scan plan event ${index} is outside the daemon event capability.`);
        }
        return canonical;
    });
    const plannedSteamByBattlemetrics = new Map();
    const plannedBattlemetricsBySteam = new Map();
    for (const event of events) {
        if (event.kind !== 'identity_observed' || !event.subject.steamId ||
            !event.subject.battlemetricsPlayerId) continue;
        const steamId = event.subject.steamId;
        const battlemetricsPlayerId = event.subject.battlemetricsPlayerId;
        const knownSteamId = plannedSteamByBattlemetrics.get(battlemetricsPlayerId);
        const knownBattlemetricsId = plannedBattlemetricsBySteam.get(steamId);
        if ((knownSteamId && knownSteamId !== steamId) ||
            (knownBattlemetricsId && knownBattlemetricsId !== battlemetricsPlayerId)) {
            throw new TypeError('Player scan plan contains conflicting stable identity pairs.');
        }
        plannedSteamByBattlemetrics.set(battlemetricsPlayerId, steamId);
        plannedBattlemetricsBySteam.set(steamId, battlemetricsPlayerId);
    }
    const expectedGuardDescriptors = plannedIdentityGuardDescriptors(events);
    if (plan.identityGuards.length !== expectedGuardDescriptors.length) {
        throw new TypeError('Player scan plan identity guards are invalid.');
    }
    const identityGuards = plan.identityGuards.map((/** @type {any} */ guard,
        /** @type {number} */ index) => {
        const expected = expectedGuardDescriptors[index];
        if (!guard || typeof guard !== 'object' || Array.isArray(guard) || Object.keys(guard).length !== 4 ||
            !Object.hasOwn(guard, 'steamId') || !Object.hasOwn(guard, 'battlemetricsPlayerId') ||
            !Object.hasOwn(guard, 'names') || !Object.hasOwn(guard, 'revision') ||
            guard.steamId !== expected.steamId || guard.battlemetricsPlayerId !== expected.battlemetricsPlayerId ||
            !Array.isArray(guard.names) || guard.names.length !== expected.names.length ||
            guard.names.some((/** @type {unknown} */ name,
                /** @type {number} */ nameIndex) => name !== expected.names[nameIndex]) ||
            typeof guard.revision !== 'string' ||
            !/^pi-identity-guard-revision:[a-f0-9]{64}$/u.test(guard.revision)) {
            throw new TypeError('Player scan plan identity guards are invalid.');
        }
        return Object.freeze({ steamId: expected.steamId,
            battlemetricsPlayerId: expected.battlemetricsPlayerId,
            names: Object.freeze([...expected.names]), revision: guard.revision });
    });
    const validatedState = plan.state === null ? null : validateState(plan.state, options);
    if (validatedState && (validatedState.guildId !== expectedScope.guildId ||
        validatedState.serverKey !== expectedScope.serverKey || validatedState.wipeId !== expectedScope.wipeId)) {
        throw new TypeError('Player scan plan state escaped its requested scope.');
    }
    // Reconstruct instead of spreading worker input so unknown fields never reach durable state.
    const state = validatedState === null ? null : JSON.parse(JSON.stringify(Object.fromEntries(
        STATE_FIELDS.map(field => [field, validatedState[field]]))));
    if (events.length > 0 && state === null) {
        throw new TypeError('Player scan plan omitted state for its pending events.');
    }
    const counterFields = [
        'onlineRefreshed', 'warBanditsSeen', 'targetedLookups', 'targetedLookupFailures',
        'warBanditsPageFailures', 'metricsObserved', 'steamProfileAttempts', 'steamProfileFailures',
        'steamProfilesRefreshed', 'pendingBattlemetricsAttempts', 'pendingWarBanditsAttempts',
        'pendingIdentitiesLinked'
    ];
    const resultFields = ['skipped', 'appended', ...counterFields, 'pendingReconciliationActive',
        'pendingReconciliationCompleted', 'nextWarBanditsPage', 'warBanditsResumeAt', 'warBanditsRetryAt'];
    if (Object.keys(plan.result).length !== resultFields.length ||
        Object.keys(plan.result).some(key => !resultFields.includes(key)) || plan.result.skipped !== false ||
        plan.result.appended !== events.length || counterFields.some(field =>
            !Number.isSafeInteger(plan.result[field]) || plan.result[field] < 0 || plan.result[field] > 5000) ||
        typeof plan.result.pendingReconciliationActive !== 'boolean' ||
        typeof plan.result.pendingReconciliationCompleted !== 'boolean' ||
        !Number.isSafeInteger(plan.result.nextWarBanditsPage) || plan.result.nextWarBanditsPage < 1 ||
        plan.result.nextWarBanditsPage > 1000000 ||
        [plan.result.warBanditsResumeAt, plan.result.warBanditsRetryAt].some(value =>
            value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value))))) {
        throw new TypeError('Player scan plan result is invalid.');
    }
    if (state && (state.nextWarBanditsPage !== plan.result.nextWarBanditsPage ||
        state.warBanditsResumeAt !== plan.result.warBanditsResumeAt ||
        state.warBanditsRetryAt !== plan.result.warBanditsRetryAt ||
        state.pendingReconciliation.active !== plan.result.pendingReconciliationActive ||
        (plan.result.pendingReconciliationCompleted === true &&
            (state.pendingReconciliation.active === true ||
                state.pendingReconciliation.completedAt === null)))) {
        throw new TypeError('Player scan plan result does not match its durable state.');
    }
    const result = Object.freeze(Object.fromEntries(resultFields.map(field =>
        [field, field === 'appended' ? events.length : plan.result[field]])));
    if (typeof options.store.appendManyIfRevision !== 'function') {
        throw new TypeError('Player scan commit requires a revision-aware journal store.');
    }
    let rebased = false;
    const commit = await options.store.appendManyIfRevision(events, null, {
        beforeAppend: async (/** @type {readonly any[]} */ currentEvents,
            /** @type {string} */ currentRevision) => {
            if (await currentStateRevision(options.directory) !== baseStateRevision) {
                throw new StaleScanPlanError('checkpoint');
            }
            // Scope is mutable outside the journal queue; check it at the last parent-side gate before
            // any worker event or checkpoint can become durable.
            assertCurrentScope(options);
            if (currentRevision !== baseRevision) {
                rebased = true;
                if (controlRevision(currentEvents) !== baseControlRevision) {
                    throw new StaleScanPlanError('journal');
                }
                const currentGuardRevisions = identityGuardRevisions(currentEvents, identityGuards);
                if (identityGuards.some((/** @type {any} */ guard,
                    /** @type {number} */ index) => guard.revision !== currentGuardRevisions[index])) {
                    throw new StaleScanPlanError('journal');
                }
                // Journal entries are immutable observations, so unrelated BattleMetrics/Discord appends
                // can safely coexist with a planned provider result. The scan checkpoint is the exclusive
                // cursor and remains exact-CAS protected above. If the old projection thought a manual
                // reconciliation was complete, keep it active so aliases appended during the RPC are not
                // missed by that campaign.
                const plannedPairs = events.filter((/** @type {Readonly<Record<string, any>>} */ event) =>
                    event.kind === 'identity_observed' &&
                    event.subject.steamId && event.subject.battlemetricsPlayerId);
                let currentProjection = null;
                if (plannedPairs.length > 0 || (state && result.pendingReconciliationCompleted === true)) {
                    currentProjection = Core.rebuild(currentEvents);
                }
                for (const event of plannedPairs) {
                    const consolidation = Core.consolidateProjection(currentProjection, {
                        steamId: event.subject.steamId,
                        battlemetricsPlayerId: event.subject.battlemetricsPlayerId,
                        name: event.subject.exactName,
                        caseFidelity: event.payload.caseFidelity,
                        allowExactName: false
                    });
                    if (consolidation.status === 'conflict') throw new StaleScanPlanError('journal');
                }
                if (state && result.pendingReconciliationCompleted === true) {
                    const checkpoint = state.pendingReconciliation;
                    const dependencies = options.dependencies || {};
                    const battlemetricsEnabled = Boolean(dependencies.battlemetricsProvider &&
                        typeof dependencies.battlemetricsProvider.resolveSteamId === 'function');
                    const provider = options.warBanditsProvider;
                    const warBanditsEnabled = Boolean(provider &&
                        (typeof provider.resolvePlayerRecent === 'function' ||
                            typeof provider.resolvePlayer === 'function'));
                    const rows = PendingReconciler.pendingRows(currentProjection);
                    const checkedBattlemetricsIds = new Set(checkpoint.checkedBattlemetricsIds);
                    const hasBattlemetricsWork = battlemetricsEnabled &&
                        PendingReconciler.battlemetricsCandidates(currentProjection, rows)
                            .some(candidate => !checkedBattlemetricsIds.has(candidate.battlemetricsPlayerId));
                    const checkedWarBanditsKeys = new Set(checkpoint.checkedWarBanditsKeys);
                    const hasWarBanditsWork = warBanditsEnabled && PendingReconciler.warBanditsCandidates(
                        currentProjection, checkedBattlemetricsIds, battlemetricsEnabled, rows)
                        .some(candidate => !checkedWarBanditsKeys.has(candidate.key));
                    if (hasBattlemetricsWork || hasWarBanditsWork) {
                        checkpoint.active = true;
                        checkpoint.completedAt = null;
                    }
                }
            }
        },
        afterAppend: state ? async () => writeStateAtomic(statePath(options.directory), state) : undefined
    });
    if (!commit || commit.committed !== true) throw new StaleScanPlanError('journal');
    if (rebased && state && state.pendingReconciliation.active === true &&
        result.pendingReconciliationCompleted === true) {
        return Object.freeze({ ...result, pendingReconciliationActive: true,
            pendingReconciliationCompleted: false });
    }
    return result;
}

/** @param {Parameters<typeof runCycle>[0]} options */
function schedule(options) {
    if (!options || typeof options.directory !== 'string' || !options.scope || !options.scope.wipeId) return false;
    const key = Path.resolve(options.directory);
    if (inFlight.has(key)) return false;
    // A previously admitted rerun may have missed the bounded global worker queue. Preserve it and let
    // the next scheduler tick start that exact request before ordinary background work.
    const queuedRerun = forcedReruns.get(key);
    const runOptions = queuedRerun || options;
    const span = RuntimeTelemetry.startSpan('scan_cycle');
    const runner = runOptions.isolateProcess === true ?
        ((runOptions.dependencies && runOptions.dependencies.isolatedScanRunner) ||
            // Lazy loading avoids a scan-daemon/worker-supervisor module cycle.
            require('./isolatedScanDaemon.js').runCycle) : runCycle;
    let execution;
    try {
        execution = runner(runOptions);
    }
    catch (error) {
        span.finish('failure');
        const reason = error instanceof Error ? error.message : `${error}`;
        logWarningOnce(runOptions.context, key,
            `Background player scan paused safely: ${reason}.`);
        return false;
    }
    if (forcedReruns.get(key) === runOptions) forcedReruns.delete(key);
    const promise = Promise.resolve(execution).then(result => {
        staleRetryCounts.delete(key);
        span.finish('success');
        return result;
    }).catch(error => {
        span.finish('failure');
        if (error && error.code === 'STALE_SCAN_PLAN') {
            // A manual !scanplayers request can already be queued behind this cycle. Keep its
            // forced flag, current scope and providers, and give that distinct request its own
            // bounded stale retry instead of replacing it with the failed background options.
            if (forcedReruns.has(key)) staleRetryCounts.delete(key);
            else {
                const attempts = staleRetryCounts.get(key) || 0;
                if (attempts < MAX_IMMEDIATE_STALE_RETRIES) {
                    staleRetryCounts.set(key, attempts + 1);
                    forcedReruns.set(key, runOptions);
                }
                else staleRetryCounts.delete(key);
            }
        }
        else staleRetryCounts.delete(key);
        logWarningOnce(runOptions.context, key,
            `Background player scan paused safely: ${error && error.message ? error.message : error}.`);
        return null;
    }).finally(() => {
        inFlight.delete(key);
        const rerun = forcedReruns.get(key);
        if (rerun) {
            const started = schedule(rerun);
            // Admission can fail synchronously when the global worker FIFO is full or stopping. Keep
            // the request for a future tick, but refund the manual cooldown so the user is not locked
            // out after a command that could not actually restart.
            if (!started && rerun.forceWarBanditsRescan === true) manualTriggerTimes.delete(key);
        }
    });
    inFlight.set(key, promise);
    return true;
}

/** @param {Parameters<typeof runCycle>[0]} options */
function requestRescan(options) {
    if (!options || typeof options.directory !== 'string' || !options.scope || !options.scope.wipeId) {
        return Object.freeze({ accepted: false, state: 'unavailable', retryAfterSeconds: 0 });
    }
    const key = Path.resolve(options.directory);
    const current = nowDate(options.dependencies || {}).getTime();
    const previous = manualTriggerTimes.get(key, current);
    const retryAfter = previous === undefined ? 0 : MANUAL_RESCAN_COOLDOWN_MS - (current - previous);
    if (retryAfter > 0) {
        return Object.freeze({ accepted: false, state: 'cooldown',
            retryAfterSeconds: Math.ceil(retryAfter / 1000) });
    }
    const forced = Object.freeze({ ...options, forceWarBanditsRescan: true });
    if (inFlight.has(key)) {
        manualTriggerTimes.set(key, current, MANUAL_RESCAN_COOLDOWN_MS, current);
        forcedReruns.set(key, forced);
        return Object.freeze({ accepted: true, state: 'queued', retryAfterSeconds: 0 });
    }
    const started = schedule(forced);
    if (started) manualTriggerTimes.set(key, current, MANUAL_RESCAN_COOLDOWN_MS, current);
    return Object.freeze({ accepted: started, state: started ? 'started' : 'unavailable', retryAfterSeconds: 0 });
}

/** @param {string} directory */
async function waitForIdle(directory) {
    const key = Path.resolve(directory);
    while (inFlight.has(key)) await inFlight.get(key);
}

/** @param {Parameters<typeof runCycle>[0]} options @param {any} projection */
async function getPendingReconciliationStatus(options, projection) {
    if (!options || typeof options.directory !== 'string' || !options.scope || !options.scope.wipeId || !projection) {
        return null;
    }
    const dependencies = options.dependencies || {};
    const current = nowDate(dependencies);
    const state = await readState(options, current);
    const battlemetricsProvider = dependencies.battlemetricsProvider;
    const provider = options.warBanditsProvider;
    return PendingReconciler.reconciliationStatus(projection, state.pendingReconciliation, {
        battlemetricsEnabled: Boolean(battlemetricsProvider &&
            typeof battlemetricsProvider.resolveSteamId === 'function'),
        warBanditsEnabled: Boolean(provider && (typeof provider.resolvePlayerRecent === 'function' ||
            typeof provider.resolvePlayer === 'function')),
        now: current
    });
}

function getRuntimeStatus() {
    const worker = require('./isolatedScanDaemon.js').getRuntimeStatus();
    return Object.freeze({
        active: inFlight.size,
        forcedRerunsQueued: forcedReruns.size,
        workerActive: worker.active,
        workerQueued: worker.queued,
        workerCompleted: worker.completed,
        workerFailures: worker.failures,
        workerStalePlans: worker.stalePlans
    });
}

function shutdown() {
    // Keep this dependency lazy: the isolated runner requires commitPlan from this module after planning.
    return require('./isolatedScanDaemon.js').shutdown();
}

function getRuntimeCacheStatus(nowMs = Date.now()) {
    return Object.freeze({
        manualTriggers: manualTriggerTimes.count(nowMs),
        manualTriggerLimit: MANUAL_TRIGGER_MAX_ENTRIES,
        warnings: warningTimes.count(nowMs),
        warningLimit: WARNING_MAX_ENTRIES
    });
}

function resetRuntimeCachesForTests() {
    manualTriggerTimes.clear();
    warningTimes.clear();
}

module.exports = Object.freeze({
    ONLINE_SOURCE,
    MANUAL_RESCAN_COOLDOWN_MS,
    PENDING_BATTLEMETRICS_BATCH_SIZE,
    PENDING_RECONCILIATION_BUDGET_MS,
    PENDING_WARBANDITS_BATCH_SIZE,
    PLAN_PROTOCOL_VERSION,
    ScanDaemonStateError,
    StaleScanPlanError,
    WARBANDITS_SOURCE,
    WARBANDITS_LOOKUP_SOURCE,
    getRuntimeCacheStatus,
    getRuntimeStatus,
    getPendingReconciliationStatus,
    commitPlan,
    requestRescan,
    resetRuntimeCachesForTests,
    runCycle,
    schedule,
    shutdown,
    waitForIdle
});
