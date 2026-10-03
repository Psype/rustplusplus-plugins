// @ts-check
const Crypto = require('node:crypto');
const Path = require('node:path');

const Core = require('./index.js');
const F7IdentityValidation = require('./f7IdentityValidation.js');
const PlayerScanDaemon = require('./scanDaemon.js');

const COLLECTOR_VERSION = 'player-intelligence-1';
const DATA_DIRECTORY = Path.join(__dirname, '..', '..', '..', 'data', 'player-intelligence');
const MAX_QUERY_LENGTH = 128;
const IN_GAME_BUDGET = 122;
const hookStates = new Map();

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

/** @param {any} context @param {any} scope @param {any} store @param {any} dependencies */
function playerScanOptions(context, scope, store, dependencies) {
    return Object.freeze({
        context,
        scope,
        store,
        directory: typeof store.directory === 'string' ? store.directory : getDataDirectory(context, scope),
        dependencies,
        warBanditsProvider: dependencies.warBanditsProvider || null
    });
}

/** @param {any} context @param {any} scope @param {any} store @param {any} dependencies */
function schedulePlayerScan(context, scope, store, dependencies) {
    if (!dependencies.playerScanDaemon && !dependencies.warBanditsProvider) return false;
    const daemon = dependencies.playerScanDaemon || PlayerScanDaemon;
    if (!daemon || typeof daemon.schedule !== 'function') return false;
    return daemon.schedule(playerScanOptions(context, scope, store, dependencies));
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

/** @param {any} projection @param {string} personId */
function subjectFromPerson(projection, personId) {
    const person = projection.identities.persons.find((/** @type {any} */ item) => item.personId === personId);
    if (person) return Object.freeze({
        steamId: person.steamId,
        battlemetricsPlayerId: person.battlemetricsPlayerIds[0] || null,
        exactName: person.names.length > 0 ? person.names[person.names.length - 1].name : null
    });
    if (personId.startsWith('steam:')) return Object.freeze({
        steamId: personId.slice(6), battlemetricsPlayerId: null, exactName: null
    });
    if (personId.startsWith('battlemetrics:')) return Object.freeze({
        steamId: null, battlemetricsPlayerId: personId.slice(14), exactName: null
    });
    return null;
}

/** @param {any} scope */
function trackedIdentities(scope) {
    const identities = [];
    for (const tracker of Object.values(scope.instance.trackers || {})) {
        if (tracker.managedBy !== 'player-tracker' || `${tracker.serverId}` !== scope.serverId ||
            `${tracker.battlemetricsId}` !== scope.battlemetricsId) continue;
        for (const player of tracker.players || []) {
            const steamId = /^7656119\d{10}$/u.test(`${player.steamId || ''}`) ? `${player.steamId}` : null;
            const battlemetricsPlayerId = /^\d+$/u.test(`${player.playerId || ''}`) ? `${player.playerId}` : null;
            const name = sanitize(player.name);
            if (steamId && battlemetricsPlayerId && name) {
                identities.push(Object.freeze({ steamId, battlemetricsPlayerId, name }));
            }
        }
    }
    return Object.freeze(identities);
}

/** @param {any} context */
async function identityCandidates(context) {
    const scope = getScope(context);
    if (!scope) return Object.freeze([]);
    const events = await getStore(context, scope).readAll();
    const projection = Core.rebuild(events);
    const values = [];
    for (const person of projection.identities.persons) {
        const knownClanTags = projection.clans.getAffinity({
            steamId: person.steamId,
            battlemetricsPlayerId: person.battlemetricsPlayerIds[0] || null,
            exactName: person.names[0] ? person.names[0].name : null
        }).knownTags.map((/** @type {any} */ tag) => normalize(tag.tag));
        for (const alias of person.names) values.push({
            name: alias.name,
            steamId: person.steamId,
            battlemetricsPlayerId: person.battlemetricsPlayerIds[0] || null,
            caseFidelity: true,
            knownClanTags
        });
    }
    for (const event of events) {
        if (event.kind !== 'identity_observed' || event.subject.exactName === null ||
            (event.subject.steamId === null && event.subject.battlemetricsPlayerId === null)) continue;
        values.push({
            name: event.subject.exactName,
            steamId: event.subject.steamId,
            battlemetricsPlayerId: event.subject.battlemetricsPlayerId,
            caseFidelity: event.payload.caseFidelity
        });
    }
    values.push(...trackedIdentities(scope).map(value => ({ ...value, caseFidelity: true })));
    for (const player of Object.values(scope.battlemetrics && scope.battlemetrics.players || {})) {
        const record = /** @type {any} */ (player);
        const name = sanitize(record && record.name);
        const battlemetricsPlayerId = /^\d{1,32}$/u.test(`${record && record.id || ''}`) ? `${record.id}` : null;
        const steamId = /^7656119\d{10}$/u.test(`${record && record.steamId || ''}`) ? `${record.steamId}` : null;
        if (name && (steamId || battlemetricsPlayerId)) values.push({
            name, steamId, battlemetricsPlayerId, caseFidelity: true
        });
    }
    for (const player of context.rustplus && context.rustplus.team && context.rustplus.team.players || []) {
        const name = sanitize(player && player.name);
        const steamId = /^7656119\d{10}$/u.test(`${player && player.steamId || ''}`) ? `${player.steamId}` : null;
        if (name && steamId) values.push({ name, steamId, battlemetricsPlayerId: null, caseFidelity: true });
    }
    const unique = new Map();
    for (const value of values) {
        if (!value.name) continue;
        const key = `${value.steamId || ''}\u0000${value.battlemetricsPlayerId || ''}\u0000${value.name}`;
        const previous = unique.get(key);
        unique.set(key, Object.freeze({
            name: value.name,
            steamId: value.steamId || null,
            battlemetricsPlayerId: value.battlemetricsPlayerId || null,
            caseFidelity: Boolean(previous && previous.caseFidelity) || value.caseFidelity !== false,
            knownClanTags: Object.freeze([...new Set([
                ...(previous && previous.knownClanTags || []), ...(value.knownClanTags || [])
            ])].sort())
        }));
    }
    return Object.freeze([...unique.values()].sort((left, right) =>
        left.name.localeCompare(right.name) || `${left.steamId || ''}`.localeCompare(`${right.steamId || ''}`)));
}

/** @param {any} battlemetrics @param {string} playerId */
function bmPlayer(battlemetrics, playerId) {
    const player = battlemetrics && battlemetrics.players && battlemetrics.players[playerId];
    const id = player && /^\d+$/u.test(`${player.id || playerId}`) ? `${player.id || playerId}` : null;
    const name = player && sanitize(player.name);
    return id && name ? Object.freeze({ steamId: null, battlemetricsPlayerId: id, name }) : null;
}

/** @param {any} projection @param {any} identity */
function hasIdentity(projection, identity) {
    return projection.identities.persons.some((/** @type {any} */ person) =>
        (!identity.steamId || person.steamId === identity.steamId) &&
        (!identity.battlemetricsPlayerId || person.battlemetricsPlayerIds.includes(identity.battlemetricsPlayerId)) &&
        (!identity.name || person.names.some((/** @type {any} */ alias) => alias.name === identity.name)));
}

/** @param {any} context */
async function onBattlemetricsUpdated(context) {
    const scope = getScope(context);
    if (!scope || !scope.battlemetrics) return;
    const dependencies = getDependencies(context);
    const store = getStore(context, scope);
    const reliable = scope.battlemetrics.lastUpdateSuccessful === true &&
        scope.battlemetrics.streamerMode !== true;
    const trackerIdentities = trackedIdentities(scope);
    const identityHistory = dependencies.identityHistory;
    const legacyRows = identityHistory && typeof identityHistory.getIdentityRows === 'function' ?
        identityHistory.getIdentityRows({ guildId: context.guildId, serverId: scope.serverId }) : [];
    const trackerFingerprint = trackerIdentities.map(identity =>
        `${identity.steamId}:${identity.battlemetricsPlayerId}:${identity.name}`).sort().join('|');
    const legacyFingerprint = legacyRows.map((/** @type {any} */ identity) =>
        `${identity.observedAt}:${identity.steamId}:${identity.battlemetricsPlayerId || ''}:${identity.name}`)
        .sort().join('|');
    const hasDeltas = reliable && (context.firstTime ||
        ['newPlayers', 'loginPlayers', 'logoutPlayers', 'nameChangedPlayers']
            .some(key => Array.isArray(scope.battlemetrics[key]) && scope.battlemetrics[key].length > 0));
    const stateKey = typeof store.directory === 'string' ? store.directory : null;
    const previousHookState = stateKey ? hookStates.get(stateKey) : null;
    if (previousHookState && previousHookState.reliable === reliable && !hasDeltas &&
        previousHookState.wipeId === scope.wipeId && previousHookState.trackerFingerprint === trackerFingerprint &&
        previousHookState.legacyFingerprint === legacyFingerprint) {
        schedulePlayerScan(context, scope, store, dependencies);
        return;
    }
    const existing = await store.readAll();
    const projection = Core.rebuild(existing);
    const recordedAt = nowIso(dependencies);
    const observedAt = canonicalIso(scope.battlemetrics.updatedAt) || recordedAt;
    const common = { guildId: context.guildId, observedAt, recordedAt, source: 'battlemetrics',
        confidence: 'verified', evidence: null };
    const events = [];
    for (const identity of legacyRows) {
        if (hasIdentity(projection, identity)) continue;
        events.push(identityEvent(scope, identity, {
            guildId: context.guildId,
            observedAt: identity.observedAt,
            recordedAt,
            source: 'teammate-language-database',
            sourceEventId: `legacy:${identity.steamId}:${identity.battlemetricsPlayerId || 'none'}:${
                identity.observedAt}:${identity.name}`,
            confidence: 'verified',
            evidence: null
        }));
    }

    if (!reliable) {
        for (const provider of projection.presence.providers.filter(item =>
            item.serverKey === scope.serverKey && item.source === 'battlemetrics' && item.currentState !== 'unknown')) {
            const subject = subjectFromPerson(projection, provider.personId);
            if (!subject) continue;
            events.push(presenceEvent(scope, subject, 'unknown', {
                ...common,
                observedAt: recordedAt,
                sourceEventId: `unavailable:${provider.personId}:${provider.lastObservedAt || 'initial'}`,
                reason: scope.battlemetrics.streamerMode === true ? 'provider identities censored' :
                    'provider update failed'
            }));
        }
        if (events.length > 0) await store.appendMany(events);
        if (stateKey) hookStates.set(stateKey, {
            reliable, wipeId: scope.wipeId, trackerFingerprint, legacyFingerprint
        });
        schedulePlayerScan(context, scope, store, dependencies);
        return;
    }

    const recovering = projection.presence.providers.some(item => item.serverKey === scope.serverKey &&
        item.source === 'battlemetrics' && item.currentState === 'unknown');
    let onlineIds;
    let offlineIds;
    if (context.firstTime || recovering) {
        onlineIds = Array.isArray(scope.battlemetrics.onlinePlayers) ? scope.battlemetrics.onlinePlayers :
            Object.values(scope.battlemetrics.players || {}).filter((/** @type {any} */ player) =>
                player.status === true).map((/** @type {any} */ player) => player.id);
        offlineIds = recovering ? Object.values(scope.battlemetrics.players || {})
            .filter((/** @type {any} */ player) => player.status === false)
            .map((/** @type {any} */ player) => player.id) : [];
    }
    else {
        onlineIds = [...(scope.battlemetrics.newPlayers || []), ...(scope.battlemetrics.loginPlayers || [])];
        offlineIds = [...(scope.battlemetrics.logoutPlayers || [])];
    }
    const changedIds = (scope.battlemetrics.nameChangedPlayers || [])
        .map((/** @type {any} */ player) => player.id);
    const presenceStates = new Map([
        ...onlineIds.map((/** @type {any} */ id) => [`${id}`, 'online']),
        ...offlineIds.map((/** @type {any} */ id) => [`${id}`, 'offline'])
    ]);
    const identityIds = new Set([...presenceStates.keys(),
        ...changedIds.map((/** @type {any} */ id) => `${id}`)]);
    for (const playerId of identityIds) {
        const identity = bmPlayer(scope.battlemetrics, playerId);
        if (!identity) continue;
        events.push(identityEvent(scope, identity, {
            ...common, sourceEventId: `poll:${observedAt}:identity:${playerId}`
        }));
    }
    for (const [playerId, state] of presenceStates) {
        const identity = bmPlayer(scope.battlemetrics, playerId);
        if (!identity) continue;
        events.push(presenceEvent(scope, identity, state, {
            ...common, sourceEventId: `poll:${observedAt}:presence:${state}:${playerId}`
        }));
    }
    for (const identity of trackerIdentities) {
        if (hasIdentity(projection, identity)) continue;
        events.push(identityEvent(scope, identity, {
            ...common,
            source: 'player-tracker',
            sourceEventId: `link:${identity.battlemetricsPlayerId}:${identity.steamId}:${identity.name}`,
            confidence: 'verified'
        }));
    }
    if (scope.wipeId && !projection.wipes.snapshots.some(item =>
        item.serverKey === scope.serverKey && item.wipeId === scope.wipeId)) {
        events.push(baseEvent('wipe_snapshot', scope,
            { steamId: null, battlemetricsPlayerId: null, exactName: null },
            { startsAt: scope.wipeStart, endsAt: null }, {
                ...common, sourceEventId: `wipe:${scope.wipeId}`, confidence: 'verified'
            }));
    }
    if (events.length > 0) await store.appendMany(events);
    if (stateKey) hookStates.set(stateKey, {
        reliable, wipeId: scope.wipeId, trackerFingerprint, legacyFingerprint
    });
    schedulePlayerScan(context, scope, store, dependencies);
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
    const battlemetricsMatches = projection.identities.findByIdentifier(identity.battlemetricsPlayerId);
    const conflictingSteamIds = [...new Set(battlemetricsMatches
        .map((/** @type {any} */ person) => person.steamId).filter(Boolean))]
        .filter((/** @type {string} */ steamId) => steamId !== identity.steamId);
    if (conflictingSteamIds.length > 0) return Object.freeze({
        appended: false, conflictSteamId: conflictingSteamIds[0]
    });
    const exact = projection.identities.findByIdentifier(identity.steamId).some((/** @type {any} */ person) =>
        person.battlemetricsPlayerIds.includes(identity.battlemetricsPlayerId) &&
        person.names.some((/** @type {any} */ alias) => alias.name === identity.name));
    if (exact) return Object.freeze({ appended: false, conflictSteamId: null });
    const recordedAt = nowIso(getDependencies(context));
    const sourceEventId = `manual:${Crypto.createHash('sha256').update([
        identity.steamId, identity.battlemetricsPlayerId, identity.name
    ].join('\u0000')).digest('hex')}`;
    const event = identityEvent(scope, { ...identity, caseFidelity: true }, {
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
    const names = projection.identities.findByExactName(query);
    if (names.length > 0) return Object.freeze({ person: names.length === 1 ? names[0] : null, matches: names });
    const inferred = projection.identities.resolveSubject({
        steamId: null, battlemetricsPlayerId: null, exactName: query
    });
    const person = inferred.ambiguous ? null : projection.identities.getPerson(inferred.personId);
    return Object.freeze({ person, matches: person ? [person] : [] });
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
    return boundedList('Aliases', person.names.slice().sort((/** @type {any} */ left, /** @type {any} */ right) =>
        right.lastObservedAt.localeCompare(left.lastObservedAt) || left.name.localeCompare(right.name))
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
                return handled('Player scan started in background; progress continues on BattleMetrics polling ticks.');
            }
            if (request.state === 'queued') {
                return handled('Player scan queued behind the active background cycle.');
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
            return handled(`Usage: ${context.prefix}${parsed.name} <SteamID64|BM ID|exact name>${suffix}.`);
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

/** @param {any} context @param {any} scope @param {any} parsed @param {any} metadata @param {string} recordedAt
 * @param {string|null} revision */
function importEvents(context, scope, parsed, metadata, recordedAt, revision = null) {
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
        parsed.entries.forEach((/** @type {any} */ entry, /** @type {number} */ index) =>
            events.push(identityEvent(scope, {
            steamId: entry.steamId,
            battlemetricsPlayerId: textSteamIdList ? entry.battlemetricsPlayerId || null : null,
            name: entry.name,
            caseFidelity: textSteamIdList ? entry.caseFidelity !== false : false
        }, { ...common, confidence: entry.identityConfidence || common.confidence,
            sourceEventId: `${sourceBase}:${textSteamIdList ? 'steamid-list' : 'f7'}:${index}:${entry.steamId}` })));
    }
    else {
        const resolvedMembers = Array.isArray(parsed.resolvedMembers) ? parsed.resolvedMembers :
            parsed.members.map((/** @type {any} */ member) => ({
                observedText: member.name,
                name: member.name,
                steamId: null,
                battlemetricsPlayerId: null,
                role: member.role
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
    const existing = Object.freeze(duplicateImports.map(item => {
        const hash = `${item.metadata.sha256}`.toLowerCase();
        const events = activeByHash.get(hash);
        if (!events || events.length === 0) {
            throw new Error('Duplicate evidence has no effective event revision.');
        }
        return Object.freeze({ hash, events: Object.freeze([...events]) });
    }));
    if (onDuplicate === 'prompt' && existing.length > 0) {
        return Object.freeze({ appended: 0, duplicate: true, duplicates: existing.length,
            existing, imported: 0, replaced: 0, committedHashes: Object.freeze([]) });
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
            if (onDuplicate === 'skip') {
                duplicates += 1;
                continue;
            }
            const previousEvents = activeByHash.get(hash);
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
            events.push(...importEvents(context, replacementScope, item.parsed, replacementMetadata, recordedAt,
                revision));
            events.push(supersessionEvent(context, replacementScope, replacementMetadata, recordedAt, revision,
                previousEvents));
            replaced += 1;
            committedHashes.push(hash);
            continue;
        }
        hashes.add(hash);
        imported += 1;
        committedHashes.push(hash);
        events.push(...importEvents(context, scopeForImport(scope, item.metadata), item.parsed, item.metadata,
            recordedAt));
    }
    const results = events.length > 0 ? await store.appendMany(events) : [];
    return Object.freeze({
        appended: results.filter((/** @type {any} */ result) => result.appended).length,
        duplicate: imported === 0 && replaced === 0,
        committedHashes: Object.freeze(committedHashes),
        duplicates,
        existing: Object.freeze([]),
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
    const event = identityEvent(scope, {
        steamId: `${player.steamId}`, battlemetricsPlayerId: null, name, caseFidelity: true
    }, {
        guildId: context.guildId,
        observedAt: time,
        recordedAt: nowIso(getDependencies(context)),
        source: 'warbandits',
        sourceEventId: `identity:${player.steamId}:${time}`,
        confidence: 'verified',
        evidence: null
    });
    return (await getStore(context, scope).append(event)).appended;
}

module.exports = Object.freeze({
    DATA_DIRECTORY,
    boundedList,
    commitParsedImport,
    commitParsedImports,
    getDataDirectory,
    getScope,
    handleCommand,
    identityCandidates,
    linkedClanSteamCandidates,
    onBattlemetricsUpdated,
    parseCommand,
    parseManualIdentity,
    parseCaptureTime,
    recordWarBanditsIdentity,
    recordManualIdentity,
    regularWipeStart,
    resolveEstablishedScope,
    resolveHistoricalScope,
    resolveQuery
});
