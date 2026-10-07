// @ts-check
/* Incremental background identity discovery. It is clocked by the existing BattleMetrics update hook. */

const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');

const BoundedTtlCache = require('../../util/boundedTtlCache.js');
const RuntimeTelemetry = require('../../util/runtimeTelemetry.js');
const Core = require('./index.js');

const STATE_SCHEMA_VERSION = 5;
const COLLECTOR_VERSION = 'player-scan-daemon-5';
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
const ONLINE_SOURCE = 'battlemetrics-online-wipe-daemon';
const WARBANDITS_SOURCE = 'warbandits-current-wipe-daemon';
const WARBANDITS_LOOKUP_SOURCE = 'warbandits-direct-lookup-daemon';
const STEAM_CURRENT_SOURCE = 'steam-profile-current';
const STEAM_ALIAS_SOURCE = 'steam-profile-alias-history';
const inFlight = new Map();
const forcedReruns = new Map();
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
        refreshedSteamIds: [],
        profiledSteamIds: [],
        profileAttemptedSteamIds: [],
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
    if (![1, 2, 3, 4, STATE_SCHEMA_VERSION].includes(state.schemaVersion) ||
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
    const profileAttemptedSteamIds = state.schemaVersion < 4 ? [...profiledSteamIds] :
        state.profileAttemptedSteamIds;
    const targetedLookupRetries = state.schemaVersion < 5 ? [] : state.targetedLookupRetries;
    const warBanditsRetryAt = state.schemaVersion < 5 ? null : state.warBanditsRetryAt;
    const warBanditsFailures = state.schemaVersion < 5 ? 0 : state.warBanditsFailures;
    if (!Array.isArray(targetedLookupSteamIds)) throw new TypeError('state targeted lookup set is invalid');
    if (!Array.isArray(profiledSteamIds)) throw new TypeError('state Steam profile set is invalid');
    if (!Array.isArray(profileAttemptedSteamIds)) throw new TypeError('state Steam profile attempt set is invalid');
    if (!Array.isArray(targetedLookupRetries) || targetedLookupRetries.length > MAX_TARGETED_RETRIES) {
        throw new TypeError('state targeted lookup retries are invalid');
    }
    const retryIds = new Set();
    for (const retry of targetedLookupRetries) {
        if (!retry || typeof retry !== 'object' || !/^7656119\d{10}$/u.test(`${retry.steamId}`) ||
            !Number.isSafeInteger(retry.failures) || retry.failures < 1 || retry.failures > 1000 ||
            typeof retry.nextAttemptAt !== 'string' || Number.isNaN(Date.parse(retry.nextAttemptAt)) ||
            retryIds.has(`${retry.steamId}`)) {
            throw new TypeError('state targeted lookup retry is invalid');
        }
        retryIds.add(`${retry.steamId}`);
    }
    if (!Number.isSafeInteger(warBanditsFailures) || warBanditsFailures < 0 || warBanditsFailures > 1000 ||
        (warBanditsRetryAt !== null && (typeof warBanditsRetryAt !== 'string' ||
            Number.isNaN(Date.parse(warBanditsRetryAt)))) ||
        (warBanditsFailures === 0) !== (warBanditsRetryAt === null)) {
        throw new TypeError('state WarBandits retry is invalid');
    }
    for (const values of /** @type {any[][]} */ ([state.seenWarBanditsSteamIds, state.refreshedSteamIds,
        targetedLookupSteamIds, profiledSteamIds, profileAttemptedSteamIds])) {
        if (values.length > 200000 || new Set(values).size !== values.length ||
            values.some(value => !/^7656119\d{10}$/u.test(`${value}`))) {
            throw new TypeError('state SteamID set is invalid');
        }
    }
    const attempted = new Set(profileAttemptedSteamIds);
    if (profiledSteamIds.some((/** @type {string} */ steamId) => !attempted.has(steamId))) {
        throw new TypeError('completed Steam profiles must also be marked attempted');
    }
    return { ...state, schemaVersion: STATE_SCHEMA_VERSION, targetedLookupSteamIds, targetedLookupRetries,
        profiledSteamIds, profileAttemptedSteamIds, warBanditsRetryAt, warBanditsFailures };
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
 * @param {Date} current @param {unknown} [suggested] */
function recordTargetedRetry(retries, steamId, current, suggested = null) {
    const previous = retries.get(steamId);
    if (!previous && retries.size >= MAX_TARGETED_RETRIES) {
        const oldest = [...retries.values()].sort((left, right) =>
            left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.steamId.localeCompare(right.steamId))[0];
        if (oldest) retries.delete(oldest.steamId);
    }
    const failures = Math.min(1000, (previous ? previous.failures : 0) + 1);
    retries.set(steamId, { steamId, failures, nextAttemptAt: retryAt(current, failures, suggested) });
}

/** @param {any} options @param {Date} now */
async function readState(options, now) {
    const file = statePath(options.directory);
    let text;
    try {
        text = await Fs.promises.readFile(file, 'utf8');
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return emptyState(options, now);
        throw error;
    }
    try {
        const parsed = validateState(JSON.parse(text), options);
        return parsed.serverKey === options.scope.serverKey && parsed.wipeId === options.scope.wipeId ? parsed :
            emptyState(options, now);
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
 * forceWarBanditsRescan?:boolean}} options
 */
async function runCycle(options) {
    if (!options || !options.scope || !options.scope.wipeId || !options.store ||
        typeof options.directory !== 'string') return Object.freeze({ skipped: true });
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
        state.profileAttemptedSteamIds = [...state.profiledSteamIds];
        state.warBanditsRetryAt = null;
        state.warBanditsFailures = 0;
    }
    const seen = new Set(state.seenWarBanditsSteamIds);
    const refreshed = new Set(state.refreshedSteamIds);
    const targeted = new Set(state.targetedLookupSteamIds);
    const targetedRetries = new Map(state.targetedLookupRetries.map((/** @type {any} */ retry) =>
        [`${retry.steamId}`, { ...retry, steamId: `${retry.steamId}` }]));
    const profiled = new Set(state.profiledSteamIds);
    const profileAttempts = new Set(state.profileAttemptedSteamIds);
    const existing = await options.store.readAll();
    recoverSetsFromJournal(existing, options.scope, seen, refreshed);
    const projection = Core.rebuild(existing);
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
    let targetedLookupFailures = 0;
    let warBanditsPageFailures = 0;
    let retryChanged = forcedRescan;
    for (const steamId of targeted) {
        if (targetedRetries.delete(steamId)) retryChanged = true;
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

    const steamProfileIdentity = dependencies.steamProfileIdentity;
    if (typeof steamProfileIdentity === 'function') {
        const profileSteamId = projection.identities.persons
            .map((/** @type {any} */ person) => person.steamId)
            .filter((/** @type {any} */ steamId) => steamId && !profileAttempts.has(steamId))
            .sort()[0];
        if (profileSteamId) {
            profileAttempts.add(profileSteamId);
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
                }
            }
        }
    }

    for (const match of onlineSteamMatches(projection, online)) {
        if (events.length >= MAX_LOCAL_REFRESHES_PER_CYCLE || refreshed.has(match.steamId)) continue;
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

    const provider = options.warBanditsProvider;
    if (provider && (typeof provider.resolvePlayerRecent === 'function' ||
        typeof provider.resolvePlayer === 'function')) {
        const blocked = new Set([...targeted, ...targetedRetries.keys()]);
        let [steamId] = targetedLookupCandidates(existing, projection, options.scope, blocked);
        const blockedUntilDue = new Set(targeted);
        for (const retry of targetedRetries.values()) {
            if (Date.parse(retry.nextAttemptAt) > current.getTime()) blockedUntilDue.add(retry.steamId);
        }
        if (!steamId) [steamId] = targetedLookupCandidates(existing, projection, options.scope, blockedUntilDue);
        if (steamId) {
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
                        if (consolidated.status === 'conflict') {
                            consolidated = Core.consolidateProjection(projection, {
                                steamId, battlemetricsPlayerId: null, name,
                                caseFidelity: true, allowExactName: false
                            });
                        }
                        events.push(identityEvent(options.scope, consolidated.identity, {
                            guildId: options.context.guildId,
                            observedAt,
                            recordedAt,
                            source: WARBANDITS_LOOKUP_SOURCE,
                            sourceEventId: `warbandits-lookup:${token}:${steamId}`,
                            confidence: consolidated.identity.battlemetricsPlayerId ? 'probable' : 'verified'
                        }));
                        if (consolidated.identity.battlemetricsPlayerId) newlyRefreshed.add(steamId);
                    }
                    observePlaytime(player, WARBANDITS_LOOKUP_SOURCE, observedAt);
                }
            }
            else {
                recordTargetedRetry(targetedRetries, steamId, current,
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
                if (!seen.has(steamId) && !newlySeen.has(steamId)) {
                    const live = onlineNames.get(normalize(name)) || [];
                    const liveBattlemetricsPlayerId = Array.from(normalize(name)).length >= 3 && live.length === 1 ?
                        live[0].battlemetricsPlayerId : null;
                    let consolidated = Core.consolidateProjection(projection, {
                        steamId, battlemetricsPlayerId: liveBattlemetricsPlayerId, name, caseFidelity: true
                    });
                    if (consolidated.status === 'conflict') {
                        consolidated = Core.consolidateProjection(projection, {
                            steamId, battlemetricsPlayerId: null, name,
                            caseFidelity: true, allowExactName: false
                        });
                    }
                    events.push(identityEvent(options.scope, consolidated.identity, {
                        guildId: options.context.guildId,
                        observedAt,
                        recordedAt,
                        source: WARBANDITS_SOURCE,
                        sourceEventId: `warbandits:${token}:${steamId}`,
                        confidence: consolidated.identity.battlemetricsPlayerId ? 'probable' : 'verified'
                    }));
                    newlySeen.add(steamId);
                    if (consolidated.identity.battlemetricsPlayerId) newlyRefreshed.add(steamId);
                }
                observePlaytime(row, WARBANDITS_SOURCE, observedAt);
            }
        }
    }

    if (events.length > 0) await options.store.appendMany(events);
    newlySeen.forEach(value => seen.add(value));
    newlyRefreshed.forEach(value => refreshed.add(value));
    let changed = forcedRescan || retryChanged || events.length > 0 ||
        seen.size !== state.seenWarBanditsSteamIds.length ||
        targeted.size !== state.targetedLookupSteamIds.length ||
        refreshed.size !== state.refreshedSteamIds.length || profiled.size !== state.profiledSteamIds.length ||
        profileAttempts.size !== state.profileAttemptedSteamIds.length;
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
    state.profileAttemptedSteamIds = [...profileAttempts].sort();
    state.updatedAt = recordedAt;
    if (changed || !Fs.existsSync(statePath(options.directory))) {
        await writeStateAtomic(statePath(options.directory), validateState(state, options));
    }
    return Object.freeze({
        skipped: false,
        appended: events.length,
        onlineRefreshed: newlyRefreshed.size,
        warBanditsSeen: newlySeen.size,
        targetedLookups,
        targetedLookupFailures,
        warBanditsPageFailures,
        metricsObserved,
        steamProfileAttempts,
        steamProfilesRefreshed,
        nextWarBanditsPage: state.nextWarBanditsPage,
        warBanditsResumeAt: state.warBanditsResumeAt,
        warBanditsRetryAt: state.warBanditsRetryAt
    });
}

/** @param {Parameters<typeof runCycle>[0]} options */
function schedule(options) {
    if (!options || typeof options.directory !== 'string' || !options.scope || !options.scope.wipeId) return false;
    const key = Path.resolve(options.directory);
    if (inFlight.has(key)) return false;
    const span = RuntimeTelemetry.startSpan('scan_cycle');
    const promise = Promise.resolve().then(() => runCycle(options)).then(result => {
        span.finish('success');
        return result;
    }).catch(error => {
        span.finish('failure');
        logWarningOnce(options.context, key,
            `Background player scan paused safely: ${error && error.message ? error.message : error}.`);
        return null;
    }).finally(() => {
        inFlight.delete(key);
        const rerun = forcedReruns.get(key);
        if (rerun) {
            forcedReruns.delete(key);
            schedule(rerun);
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
    manualTriggerTimes.set(key, current, MANUAL_RESCAN_COOLDOWN_MS, current);
    const forced = Object.freeze({ ...options, forceWarBanditsRescan: true });
    if (inFlight.has(key)) {
        forcedReruns.set(key, forced);
        return Object.freeze({ accepted: true, state: 'queued', retryAfterSeconds: 0 });
    }
    const started = schedule(forced);
    return Object.freeze({ accepted: started, state: started ? 'started' : 'unavailable', retryAfterSeconds: 0 });
}

/** @param {string} directory */
async function waitForIdle(directory) {
    const key = Path.resolve(directory);
    while (inFlight.has(key)) await inFlight.get(key);
}

function getRuntimeStatus() {
    return Object.freeze({ active: inFlight.size, forcedRerunsQueued: forcedReruns.size });
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
    ScanDaemonStateError,
    WARBANDITS_SOURCE,
    WARBANDITS_LOOKUP_SOURCE,
    getRuntimeCacheStatus,
    getRuntimeStatus,
    requestRescan,
    resetRuntimeCachesForTests,
    runCycle,
    schedule,
    waitForIdle
});
