/* BattleMetrics player tracking commands, isolated from upstream handlers. */

const Axios = require('axios');
const Fs = require('fs');
const Path = require('path');

const Constants = require('../../util/constants.js');
const Utils = require('../../util/utils.js');
const BattlemetricsProvider = require('../battlemetrics');

const API_TIMEOUT_MS = 5000;
const DATA_DIRECTORY = Path.join(__dirname, '..', '..', '..', 'data', 'player-trackers');
const MANAGED_BY = 'player-tracker';
const MAX_PREMIUM_RESULTS = 10;
const MAX_QUERY_LENGTH = 64;
const SCHEMA_VERSION = 2;
const SELECTION_TTL_MS = 5 * 60 * 1000;
const STATUS_VALUES = Object.freeze(['online', 'offline', 'unknown']);
const mutationLocks = new Map();
const pendingSelections = new Map();

function handled(response) {
    return Object.freeze({ handled: true, response, logType: 'PlayerTracker' });
}

function normalize(value) {
    return `${value || ''}`.normalize('NFKC').trim().toLocaleLowerCase('en');
}

function sanitizeName(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseCommand(context) {
    const raw = context.command.trim();
    if (!raw.startsWith(context.prefix)) return null;

    const body = raw.slice(context.prefix.length).trim();
    const separator = body.search(/\s/);
    const name = normalize(separator === -1 ? body : body.slice(0, separator));
    const query = sanitizeName(separator === -1 ? '' : body.slice(separator + 1));

    if (!['track', 'trackinfo', 'trackhistory', 'trackrelated', 'tracklist', 'tracks', 'untrack']
        .includes(name)) return null;
    return Object.freeze({ name, query });
}

function commandAllowed(context) {
    if (context.source !== 'inGame') return true;
    if (context.rustplus.isOperational === false) return false;
    return !context.rustplus.generalSettings ||
        context.rustplus.generalSettings.inGameCommandsEnabled !== false;
}

function getScope(context) {
    const instance = context.client.getInstance(context.guildId);
    if (!instance || !instance.serverList) return null;

    const serverId = instance.serverList[context.rustplus.serverId] ?
        context.rustplus.serverId : instance.activeServer;
    const server = serverId !== null && serverId !== undefined ? instance.serverList[serverId] : null;
    const battlemetricsId = server && server.battlemetricsId !== null &&
        server.battlemetricsId !== undefined ? `${server.battlemetricsId}` : '';

    if (!server || !/^\d+$/.test(battlemetricsId)) return null;
    return Object.freeze({ instance, server, serverId: `${serverId}`, battlemetricsId });
}

function findManagedTracker(instance, serverId, battlemetricsId) {
    for (const [trackerId, tracker] of Object.entries(instance.trackers || {})) {
        if (tracker.managedBy !== MANAGED_BY) continue;
        if (`${tracker.serverId}` !== serverId || `${tracker.battlemetricsId}` !== battlemetricsId) continue;
        return Object.freeze({ trackerId: `${trackerId}`, tracker });
    }
    return null;
}

function findAvailableTrackerId(context, instance) {
    if (typeof context.client.findAvailableTrackerId === 'function') {
        return `${context.client.findAvailableTrackerId(context.guildId)}`;
    }
    for (let id = 0; id < 1000; id += 1) {
        if (!Object.prototype.hasOwnProperty.call(instance.trackers || {}, id)) return `${id}`;
    }
    throw new Error('No tracker slot is available.');
}

function createManagedTracker(context, scope) {
    return Object.freeze({
        trackerId: findAvailableTrackerId(context, scope.instance),
        tracker: {
            name: 'Enemies',
            serverId: scope.serverId,
            battlemetricsId: scope.battlemetricsId,
            title: scope.server.title || scope.server.name || 'Rust server',
            img: scope.server.img || Constants.DEFAULT_SERVER_IMG,
            clanTag: '',
            everyone: false,
            inGame: true,
            players: [],
            messageId: null,
            managedBy: MANAGED_BY
        }
    });
}

function getDataPath(guildId, battlemetricsId, dependencies = {}) {
    const directory = dependencies.dataDirectory || DATA_DIRECTORY;
    const safeGuildId = `${guildId}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    return Path.join(directory, `${safeGuildId}-${battlemetricsId}.json`);
}

function validIsoDate(value) {
    return value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

function validOptionalCount(value) {
    return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validBattlemetricsDetails(details) {
    if (!details || typeof details !== 'object' ||
        !Object.prototype.hasOwnProperty.call(details, 'server') ||
        !Object.prototype.hasOwnProperty.call(details, 'sessions') ||
        !Object.prototype.hasOwnProperty.call(details, 'related')) return false;
    if (details.server !== null && (!validIsoDate(details.server.fetchedAt) ||
        details.server.fetchedAt === null || !validIsoDate(details.server.firstSeenAt) ||
        !validIsoDate(details.server.lastSeenAt) ||
        !validOptionalCount(details.server.timePlayedSeconds))) return false;
    if (details.sessions !== null && (!validIsoDate(details.sessions.fetchedAt) ||
        details.sessions.fetchedAt === null || typeof details.sessions.truncated !== 'boolean' ||
        !Array.isArray(details.sessions.items) || details.sessions.items.length > MAX_PREMIUM_RESULTS)) return false;
    for (const session of (details.sessions && details.sessions.items) || []) {
        if (!session || typeof session.id !== 'string' || session.id.length === 0 || session.id.length > 128 ||
            !validIsoDate(session.startAt) ||
            session.startAt === null || !validIsoDate(session.stopAt) ||
            !validOptionalCount(session.durationSeconds)) return false;
    }
    if (details.related !== null && (!validIsoDate(details.related.fetchedAt) ||
        details.related.fetchedAt === null || typeof details.related.truncated !== 'boolean' ||
        !Array.isArray(details.related.players) || details.related.players.length > MAX_PREMIUM_RESULTS)) return false;
    for (const player of (details.related && details.related.players) || []) {
        if (!player || !/^\d+$/.test(`${player.battlemetricsPlayerId}`) ||
            typeof player.name !== 'string' || player.name === '' || player.name.length > 128 ||
            !validOptionalCount(player.overlapSeconds) || !validOptionalCount(player.sessionCount)) return false;
    }
    return true;
}

function migrateSnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.players)) return snapshot;
    return {
        ...snapshot,
        schemaVersion: SCHEMA_VERSION,
        players: snapshot.players.map(player => ({
            ...player,
            battlemetrics: { server: null, sessions: null, related: null }
        }))
    };
}

function validateSnapshot(snapshot) {
    snapshot = migrateSnapshot(snapshot);
    if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== SCHEMA_VERSION ||
        typeof snapshot.guildId !== 'string' || typeof snapshot.serverId !== 'string' ||
        !/^\d+$/.test(`${snapshot.battlemetricsServerId}`) ||
        !/^\d+$/.test(`${snapshot.nativeTrackerId}`) || !validIsoDate(snapshot.updatedAt) ||
        snapshot.updatedAt === null || !Array.isArray(snapshot.players)) {
        throw new Error('Player tracker save has an unsupported or invalid schema.');
    }

    for (const player of snapshot.players) {
        if (!player || typeof player !== 'object' || !/^\d+$/.test(`${player.battlemetricsPlayerId}`) ||
            typeof player.name !== 'string' || player.name === '' || !Array.isArray(player.aliases) ||
            !player.aliases.every(alias => typeof alias === 'string') ||
            !STATUS_VALUES.includes(player.status) || !validIsoDate(player.addedAt) ||
            !validIsoDate(player.lastSeenAt) || !validIsoDate(player.statusUpdatedAt) ||
            player.addedAt === null || player.statusUpdatedAt === null ||
            ![null, 'online', 'offline'].includes(player.lastKnownStatus) ||
            typeof player.profileUrl !== 'string' || !validBattlemetricsDetails(player.battlemetrics) ||
            (player.steamId !== null && !/^7656119\d{10}$/.test(`${player.steamId}`))) {
            throw new Error('Player tracker save contains an invalid player record.');
        }
    }
    return snapshot;
}

function readSnapshot(path) {
    if (!Fs.existsSync(path)) return null;
    return validateSnapshot(JSON.parse(Fs.readFileSync(path, 'utf8')));
}

function writeSnapshot(path, snapshot) {
    const directory = Path.dirname(path);
    Fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}`;
    try {
        Fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        Fs.renameSync(temporaryPath, path);
    }
    catch (error) {
        if (Fs.existsSync(temporaryPath)) Fs.unlinkSync(temporaryPath);
        throw error;
    }
}

function toIsoDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestIsoDate(first, second) {
    const firstIso = toIsoDate(first);
    const secondIso = toIsoDate(second);
    if (!firstIso) return secondIso;
    if (!secondIso) return firstIso;
    return Date.parse(firstIso) >= Date.parse(secondIso) ? firstIso : secondIso;
}

function statusFromPlayer(player) {
    if (!player || typeof player.status !== 'boolean') return 'unknown';
    return player.status ? 'online' : 'offline';
}

function makeCandidate(player, now) {
    return Object.freeze({
        playerId: `${player.id}`,
        name: sanitizeName(player.name),
        status: statusFromPlayer(player),
        lastSeenAt: player.status === true ? now : toIsoDate(player.logoutDate),
        steamId: null
    });
}

function selectCandidate(candidates, query) {
    const unique = [];
    const ids = new Set();
    for (const candidate of candidates) {
        if (!candidate || !/^\d+$/.test(`${candidate.playerId}`) || ids.has(`${candidate.playerId}`)) continue;
        ids.add(`${candidate.playerId}`);
        unique.push(candidate);
    }

    const normalizedQuery = normalize(query);
    const byId = unique.filter(candidate => `${candidate.playerId}` === query);
    if (byId.length === 1) return Object.freeze({ candidate: byId[0], candidates: unique });

    const nameMatches = unique.filter(candidate => normalize(candidate.name).includes(normalizedQuery));
    const onlineMatches = nameMatches.filter(candidate => candidate.status === 'online');
    const prioritized = onlineMatches.length > 0 ? onlineMatches : nameMatches;

    const exact = prioritized.filter(candidate => normalize(candidate.name) === normalizedQuery);
    if (exact.length === 1) return Object.freeze({ candidate: exact[0], candidates: unique });
    if (exact.length > 1) return Object.freeze({ candidate: null, candidates: exact });

    const prefix = prioritized.filter(candidate => normalize(candidate.name).startsWith(normalizedQuery));
    if (prefix.length === 1) return Object.freeze({ candidate: prefix[0], candidates: unique });
    if (prefix.length > 1) return Object.freeze({ candidate: null, candidates: prefix });

    const partial = prioritized;
    return Object.freeze({ candidate: partial.length === 1 ? partial[0] : null, candidates: partial });
}

function localCandidates(battlemetrics, query, now) {
    if (!battlemetrics || battlemetrics.lastUpdateSuccessful !== true || battlemetrics.streamerMode === true) {
        return [];
    }
    const normalizedQuery = normalize(query);
    return Object.values(battlemetrics.players || {})
        .filter(player => `${player.id}` === query || normalize(player.name).includes(normalizedQuery))
        .map(player => makeCandidate(player, now));
}

function getHttpErrorReason(error) {
    if (error && error.response && Number.isInteger(error.response.status)) {
        return `HTTP ${error.response.status}`;
    }
    if (error && error.code === 'ECONNABORTED') return 'timeout';
    if (error && error.message === 'invalid response') return 'invalid response';
    return 'request failed';
}

function parseSteamProfileName(data) {
    if (typeof data !== 'string') return null;
    const xml = /<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/i.exec(data);
    const html = /class=["']actual_persona_name["'][^>]*>([\s\S]*?)<\/span>/i.exec(data);
    const match = xml || html;
    if (!match) return null;
    const name = sanitizeName(Utils.decodeHtml(match[1].replace(/<[^>]+>/g, '')));
    return name && name.length <= MAX_QUERY_LENGTH ? name : null;
}

async function resolveSteamProfileName(context, steamId, dependencies) {
    const httpClient = dependencies.steamHttpClient || dependencies.httpClient || Axios;
    try {
        const response = await httpClient.get(`${Constants.STEAM_PROFILES_URL}${steamId}?xml=1`, {
            headers: { 'User-Agent': 'rustplusplus-player-tracker' },
            timeout: API_TIMEOUT_MS,
            maxContentLength: 256 * 1024
        });
        const name = parseSteamProfileName(response && response.data);
        if (!name) throw new Error('invalid response');
        return Object.freeze({ name, unavailable: false, reason: null });
    }
    catch (error) {
        const reason = getHttpErrorReason(error);
        logWarning(context, `Steam profile name lookup unavailable: ${reason}.`);
        return Object.freeze({ name: null, unavailable: true, reason });
    }
}

function matchesSteamProfileName(steamName, battlemetricsName) {
    const expected = normalize(steamName);
    const observed = normalize(battlemetricsName);
    if (observed === expected) return true;
    return observed.replace(/^\[[^\]]{1,16}\]\s*/, '') === expected;
}

function logWarning(context, text) {
    if (context.rustplus && typeof context.rustplus.log === 'function') {
        context.rustplus.log('PLAYER_TRACKER', text, 'warn');
    }
}

async function resolveWarBanditsPlayer(context, scope, query, dependencies) {
    const provider = dependencies.warBanditsProvider;
    if (!provider || typeof provider.resolvePlayer !== 'function') return null;
    try {
        const result = await provider.resolvePlayer(context, {
            battlemetricsId: scope.battlemetricsId,
            server: scope.server
        }, query);
        const player = result && result.available === true && result.player;
        if (!player || !/^7656119\d{10}$/.test(`${player.steamId || ''}`) ||
            !/^\d+$/.test(`${player.warBanditsPlayerId || ''}`)) return null;
        const name = sanitizeName(player.name);
        if (!name || name.length > MAX_QUERY_LENGTH) return null;
        if (/^7656119\d{10}$/.test(query) && `${player.steamId}` !== query) {
            logWarning(context, 'WarBandits returned a mismatched SteamID; identity enrichment rejected.');
            return null;
        }
        return Object.freeze({
            name,
            steamId: `${player.steamId}`,
            warBanditsPlayerId: `${player.warBanditsPlayerId}`
        });
    }
    catch (error) {
        logWarning(context, `WarBandits identity enrichment unavailable: ${error.message || error}.`);
        return null;
    }
}

async function linkWarBanditsPlayer(context, scope, battlemetricsPlayer, warBanditsPlayer, steamId, dependencies) {
    const provider = dependencies.warBanditsProvider;
    if (!provider || typeof provider.linkBattlemetricsPlayer !== 'function' || !warBanditsPlayer || !steamId) return;
    if (`${warBanditsPlayer.steamId}` !== `${steamId}`) {
        logWarning(context, 'WarBandits link skipped because its SteamID no longer matches.');
        return;
    }
    try {
        await provider.linkBattlemetricsPlayer(context, {
            battlemetricsId: scope.battlemetricsId,
            server: scope.server
        }, Object.freeze({
            steamId: `${steamId}`,
            battlemetricsPlayerId: `${battlemetricsPlayer.playerId}`,
            name: sanitizeName(battlemetricsPlayer.name)
        }));
    }
    catch (error) {
        logWarning(context, `WarBandits cache link unavailable: ${error.message || error}.`);
    }
}

async function searchRemote(context, scope, query, dependencies) {
    const provider = dependencies.battlemetricsProvider || BattlemetricsProvider;
    const result = await provider.searchPlayers(scope, query, dependencies);
    if (result.available === true) return Object.freeze({
        candidates: result.candidates,
        unavailable: false,
        reason: null,
        truncated: result.truncated
    });
    logWarning(context, `BattleMetrics player search unavailable: ${result.reason}.`);
    return Object.freeze({ candidates: [], unavailable: true, reason: result.reason, truncated: false });
}

async function resolveCandidate(context, scope, query, dependencies) {
    const now = (dependencies.now || (() => new Date()))().toISOString();
    const battlemetrics = context.client.battlemetricsInstances &&
        context.client.battlemetricsInstances[scope.battlemetricsId];
    const local = localCandidates(battlemetrics, query, now);
    const localSelection = selectCandidate(local, query);
    const localIsExact = localSelection.candidate &&
        (`${localSelection.candidate.playerId}` === query ||
            normalize(localSelection.candidate.name) === normalize(query));
    if (localIsExact) {
        return Object.freeze({ ...localSelection, unavailable: false, ambiguous: false, moreResults: false });
    }

    const remote = await searchRemote(context, scope, query, dependencies);
    if (remote.unavailable) {
        if (localSelection.candidates.length > 1) {
            return Object.freeze({ ...localSelection, unavailable: false, ambiguous: true, moreResults: false });
        }
        if (localSelection.candidate && localSelection.candidate.status === 'online') {
            return Object.freeze({ ...localSelection, unavailable: false, ambiguous: false, moreResults: false });
        }
        return Object.freeze({ candidate: null, candidates: localSelection.candidates, unavailable: true,
            ambiguous: false, moreResults: false, reason: remote.reason });
    }

    const selection = selectCandidate([...local, ...remote.candidates], query);
    const isDirectId = selection.candidate && `${selection.candidate.playerId}` === query;
    const ambiguous = (!selection.candidate && selection.candidates.length > 1) ||
        (remote.truncated && !isDirectId);
    return Object.freeze({
        candidate: ambiguous ? null : selection.candidate,
        candidates: selection.candidates,
        unavailable: false,
        ambiguous,
        moreResults: remote.truncated,
        reason: null
    });
}

function parseSteamId(data) {
    return BattlemetricsProvider.parseSteamId(data);
}

async function resolveSteamId(context, playerId, dependencies) {
    const provider = dependencies.battlemetricsProvider || BattlemetricsProvider;
    const result = await provider.resolveSteamId(playerId, dependencies);
    if (result.available === true) return result.steamId;
    logWarning(context, `BattleMetrics SteamID enrichment unavailable: ${result.reason}.`);
    return null;
}

function getPlayerRecord(previous, playerId) {
    return previous && previous.players.find(player => `${player.battlemetricsPlayerId}` === `${playerId}`);
}

function buildSnapshot(context, scope, trackerId, tracker, previous, seeds, dependencies) {
    const now = (dependencies.now || (() => new Date()))().toISOString();
    const battlemetrics = context.client.battlemetricsInstances &&
        context.client.battlemetricsInstances[scope.battlemetricsId];
    const reliable = Boolean(battlemetrics && battlemetrics.lastUpdateSuccessful === true &&
        battlemetrics.streamerMode !== true);
    const records = [];

    for (const tracked of tracker.players) {
        const playerId = `${tracked.playerId || ''}`;
        if (!/^\d+$/.test(playerId)) throw new Error('Managed tracker contains an invalid BattleMetrics player ID.');

        const prior = getPlayerRecord(previous, playerId);
        const seed = seeds && seeds[playerId];
        const live = reliable && battlemetrics.players ? battlemetrics.players[playerId] : null;
        const currentName = sanitizeName((live && live.name) || (seed && seed.name) || tracked.name);
        let status = 'unknown';
        let lastSeenAt = prior ? prior.lastSeenAt : null;

        if (live) {
            status = statusFromPlayer(live);
            if (status === 'online') lastSeenAt = latestIsoDate(lastSeenAt, now);
            else lastSeenAt = latestIsoDate(lastSeenAt, live.logoutDate);
        }
        else if (seed && STATUS_VALUES.includes(seed.status)) {
            status = seed.status;
            lastSeenAt = latestIsoDate(lastSeenAt, seed.lastSeenAt);
        }
        else if (reliable) {
            status = 'offline';
            if (prior && prior.status === 'online') lastSeenAt = latestIsoDate(lastSeenAt, now);
        }

        const previousKnownStatus = prior && prior.status !== 'unknown' ? prior.status :
            (prior && prior.lastKnownStatus) || null;
        const lastKnownStatus = status === 'unknown' ? previousKnownStatus : status;
        const aliases = Array.from(new Set([
            ...((prior && prior.aliases) || []),
            prior && prior.name,
            tracked.name,
            currentName
        ].filter(Boolean).map(sanitizeName))).slice(-20);
        const statusUpdatedAt = prior && prior.status === status ? prior.statusUpdatedAt : now;

        records.push(Object.freeze({
            battlemetricsPlayerId: playerId,
            steamId: /^7656119\d{10}$/.test(`${tracked.steamId || ''}`) ? `${tracked.steamId}` : null,
            name: currentName,
            aliases,
            status,
            lastKnownStatus,
            lastSeenAt,
            addedAt: prior ? prior.addedAt : now,
            statusUpdatedAt,
            profileUrl: `${Constants.BATTLEMETRICS_PROFILE_URL}${playerId}`,
            battlemetrics: prior && validBattlemetricsDetails(prior.battlemetrics) ? prior.battlemetrics : {
                server: null,
                sessions: null,
                related: null
            }
        }));
    }

    records.sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)));
    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        guildId: `${context.guildId}`,
        serverId: scope.serverId,
        battlemetricsServerId: scope.battlemetricsId,
        nativeTrackerId: `${trackerId}`,
        updatedAt: now,
        players: Object.freeze(records)
    });
}

async function withMutationLock(key, callback) {
    const previous = mutationLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    mutationLocks.set(key, tail);
    await previous;
    try {
        return await callback();
    }
    finally {
        release();
        if (mutationLocks.get(key) === tail) mutationLocks.delete(key);
    }
}

function commitTracker(context, scope, trackerId, tracker, previous, seeds, dependencies) {
    const path = getDataPath(context.guildId, scope.battlemetricsId, dependencies);
    const snapshot = buildSnapshot(context, scope, trackerId, tracker, previous, seeds, dependencies);
    writeSnapshot(path, snapshot);

    const current = context.client.getInstance(context.guildId);
    const next = {
        ...current,
        trackers: { ...(current.trackers || {}), [trackerId]: tracker }
    };
    try {
        context.client.setInstance(context.guildId, next);
    }
    catch (error) {
        if (previous) writeSnapshot(path, previous);
        else if (Fs.existsSync(path)) Fs.unlinkSync(path);
        throw error;
    }
    return snapshot;
}

function formatCandidates(candidates, numbered = false) {
    return candidates.slice(0, 5).map((candidate, index) => {
        const prefix = numbered ? `${index + 1}) ` : '';
        return `${prefix}${candidate.name} (BM:${candidate.playerId}, ${candidate.status})`;
    }).join(' | ');
}

function getRequesterId(context) {
    if (context.source === 'inGame') {
        const message = context.message && context.message.broadcast && context.message.broadcast.teamMessage &&
            context.message.broadcast.teamMessage.message;
        if (message && message.steamId !== undefined) return `steam:${message.steamId}`;
    }
    if (context.source === 'discord' && context.message && context.message.author && context.message.author.id) {
        return `discord:${context.message.author.id}`;
    }
    return `${context.source}:shared`;
}

function getSelectionKey(context, scope) {
    return `${context.guildId}:${scope.battlemetricsId}:${getRequesterId(context)}`;
}

function getNowMs(dependencies) {
    return (dependencies.now || (() => new Date()))().getTime();
}

function rememberSelection(context, scope, commandQuery, lookupQuery, requestedSteamId, candidates, dependencies) {
    const key = getSelectionKey(context, scope);
    const choices = Object.freeze(candidates.slice(0, 5));
    pendingSelections.set(key, Object.freeze({
        commandQuery: normalize(commandQuery),
        displayQuery: commandQuery,
        lookupQuery,
        requestedSteamId,
        candidates: choices,
        expiresAt: getNowMs(dependencies) + SELECTION_TTL_MS
    }));
    return Object.freeze({ key, choices });
}

function resolveRememberedSelection(context, scope, query, dependencies) {
    const shorthand = /^#([1-9]\d*)$/.exec(query);
    const qualified = /^(.+?)\s+([1-9]\d*)$/.exec(query);
    if (!shorthand && !qualified) return null;
    const key = getSelectionKey(context, scope);
    const pending = pendingSelections.get(key);
    if (!pending || (qualified && pending.commandQuery !== normalize(qualified[1]))) return null;
    if (pending.expiresAt < getNowMs(dependencies)) {
        pendingSelections.delete(key);
        return Object.freeze({ error: 'expired', key, pending });
    }
    const index = Number(shorthand ? shorthand[1] : qualified[2]) - 1;
    if (!Number.isSafeInteger(index) || !pending.candidates[index]) {
        return Object.freeze({ error: 'invalid', key, pending });
    }
    return Object.freeze({
        error: null,
        key,
        pending,
        candidate: pending.candidates[index]
    });
}

function formatSelectionPrompt(context, query, choices, moreResults = false) {
    const more = moreResults ? ' | more matches exist' : '';
    return `Choose: ${formatCandidates(choices, true)}${more} | Reply: ${context.prefix}track #<number> or ${context.prefix}track ${query} <number>`;
}

function formatAge(value, now) {
    if (!value) return null;
    const seconds = Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

function splitBoundedResponse(value) {
    const maxLength = Constants.MAX_LENGTH_TEAM_MESSAGE - '[BOT] '.length;
    const messages = [];
    let remaining = `${value}`.trim();
    while (Array.from(remaining).length > maxLength) {
        const characters = Array.from(remaining);
        const candidate = characters.slice(0, maxLength).join('');
        const whitespace = candidate.lastIndexOf(' ');
        const cut = whitespace > 0 ? whitespace : maxLength;
        messages.push(characters.slice(0, cut).join('').trim());
        remaining = characters.slice(cut).join('').trim();
    }
    if (remaining !== '') messages.push(remaining);
    return messages;
}

function packCompactList(entries) {
    const maxLength = Constants.MAX_LENGTH_TEAM_MESSAGE - '[BOT] '.length;
    const messages = [];
    let message = '';

    for (const entry of entries) {
        const parts = splitBoundedResponse(entry);
        if (parts.length > 1) {
            if (message !== '') messages.push(message);
            messages.push(...parts);
            message = '';
            continue;
        }
        const separator = message === '' ? '' : ' | ';
        if (message !== '' && Array.from(message + separator + entry).length > maxLength) {
            messages.push(message);
            message = entry;
        }
        else {
            message += separator + entry;
        }
    }
    if (message !== '') messages.push(message);
    return messages.length === 1 ? messages[0] : Object.freeze(messages);
}

function formatDetailedList(players, now) {
    const entries = players.map(player => {
        const age = formatAge(player.lastSeenAt, now);
        const status = player.status === 'online' ? 'on' :
            `${player.status === 'offline' ? 'off' : 'unk'}${age ? `:${age}` : ''}`;
        return [
            player.name,
            player.battlemetricsPlayerId,
            player.steamId || '-',
            status
        ].join(',');
    });
    return packCompactList(entries);
}

function formatTrackList(snapshot, dependencies, all = false) {
    if (!snapshot || snapshot.players.length === 0) return 'No tracked players.';
    const now = (dependencies.now || (() => new Date()))();
    const rank = { online: 0, offline: 1, unknown: 2 };
    const players = [...snapshot.players].sort((a, b) => {
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        const lastSeen = (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0);
        return lastSeen || normalize(a.name).localeCompare(normalize(b.name));
    });
    if (all) return formatDetailedList(players, now);

    const entries = players.map(player => {
        if (player.status === 'online') return `${player.name}: Online`;
        const age = formatAge(player.lastSeenAt, now);
        const seen = age === 'now' ? 'now' : (age ? `${age} ago` : null);
        if (player.status === 'offline') return `${player.name}: ${seen || 'Offline'}`;
        return `${player.name}: Unknown${seen ? ` (${seen})` : ''}`;
    });
    return packCompactList(entries);
}

function fitSingleResponse(value) {
    const maxLength = Constants.MAX_LENGTH_TEAM_MESSAGE - '[BOT] '.length;
    const characters = Array.from(`${value}`);
    if (characters.length <= maxLength) return `${value}`;
    return `${characters.slice(0, Math.max(1, maxLength - 3)).join('')}...`;
}

function formatDuration(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
    return `${Math.floor(seconds / 86400)}d${Math.floor((seconds % 86400) / 3600)}h`;
}

function ambiguousTrackedResponse(selection) {
    const candidates = selection.matches.map(player => ({
        name: player.name,
        playerId: `${player.playerId}`,
        status: 'tracked'
    }));
    return `Ambiguous tracked player: ${formatCandidates(candidates)}.`;
}

function resolveTrackedSelection(context, query, dependencies) {
    const scope = getScope(context);
    if (!scope) return Object.freeze({
        error: 'Player tracker unavailable: configure BattleMetrics for the active server.'
    });
    const entry = findManagedTracker(scope.instance, scope.serverId, scope.battlemetricsId);
    if (!entry || entry.tracker.players.length === 0) return Object.freeze({ error: 'No tracked players.' });
    const selection = selectTrackedPlayer(entry.tracker.players, query);
    if (!selection.player) return Object.freeze({
        error: selection.matches.length > 1 ? ambiguousTrackedResponse(selection) : `Tracked player not found: ${query}.`
    });
    const path = getDataPath(context.guildId, scope.battlemetricsId, dependencies);
    const previous = readSnapshot(path);
    const snapshot = previous || buildSnapshot(
        context, scope, entry.trackerId, entry.tracker, null, null, dependencies);
    const record = getPlayerRecord(snapshot, selection.player.playerId);
    if (!record) throw new Error('Tracked player projection is missing.');
    return Object.freeze({ error: null, scope, entry, player: selection.player, record });
}

async function persistBattlemetricsSection(context, originalScope, playerId, section, value, dependencies) {
    const lockKey = `${context.guildId}:${originalScope.battlemetricsId}`;
    await withMutationLock(lockKey, async () => {
        const scope = getScope(context);
        if (!scope || scope.battlemetricsId !== originalScope.battlemetricsId ||
            scope.serverId !== originalScope.serverId) return;
        const path = getDataPath(context.guildId, scope.battlemetricsId, dependencies);
        let snapshot = readSnapshot(path);
        const entry = findManagedTracker(scope.instance, scope.serverId, scope.battlemetricsId);
        if (!entry) return;
        if (!snapshot || !getPlayerRecord(snapshot, playerId)) {
            snapshot = buildSnapshot(context, scope, entry.trackerId, entry.tracker, snapshot, null, dependencies);
        }
        let changed = false;
        const players = snapshot.players.map(player => {
            if (`${player.battlemetricsPlayerId}` !== `${playerId}`) return player;
            changed = true;
            return {
                ...player,
                battlemetrics: {
                    ...player.battlemetrics,
                    [section]: value
                }
            };
        });
        if (!changed) return;
        const next = validateSnapshot({
            ...snapshot,
            updatedAt: (dependencies.now || (() => new Date()))().toISOString(),
            players
        });
        writeSnapshot(path, next);
    });
}

function getBattlemetricsProvider(dependencies) {
    return dependencies.battlemetricsProvider || BattlemetricsProvider;
}

async function trackInfo(context, query, dependencies) {
    if (!query) return handled(`Usage: ${context.prefix}trackinfo <tracked player>.`);
    const selection = resolveTrackedSelection(context, query, dependencies);
    if (selection.error) return handled(selection.error);
    const result = await getBattlemetricsProvider(dependencies).getServerPlayer(
        selection.player.playerId, selection.scope.battlemetricsId, dependencies);
    if (result.available !== true) {
        return handled(`BattleMetrics details unavailable (${result.reason}); tracker unchanged.`);
    }
    const fetchedAt = (dependencies.now || (() => new Date()))().toISOString();
    await persistBattlemetricsSection(context, selection.scope, selection.player.playerId, 'server', {
        fetchedAt,
        firstSeenAt: result.player.firstSeenAt,
        lastSeenAt: result.player.lastSeenAt,
        timePlayedSeconds: result.player.timePlayedSeconds
    }, dependencies);
    const now = (dependencies.now || (() => new Date()))();
    const status = selection.record.status === 'online' ? 'online' :
        `${selection.record.status}${selection.record.lastSeenAt ? `, last ${formatAge(selection.record.lastSeenAt, now)}` : ''}`;
    const played = formatDuration(result.player.timePlayedSeconds);
    const first = formatAge(result.player.firstSeenAt, now);
    return handled(fitSingleResponse([
        `${selection.record.name}: ${status}`,
        played ? `played ${played}` : null,
        first ? `first ${first}` : null,
        `BM:${selection.record.battlemetricsPlayerId}`,
        selection.record.steamId ? `Steam:${selection.record.steamId}` : null
    ].filter(Boolean).join(' | ')));
}

function compactSessionDate(value) {
    if (!value) return 'online';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '?';
    return `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ` +
        `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
}

function formatSession(session) {
    const start = compactSessionDate(session.startAt);
    const stop = session.stopAt ? compactSessionDate(session.stopAt) : 'online';
    const duration = formatDuration(session.durationSeconds);
    return `${start}-${stop}${duration ? ` (${duration})` : ''}`;
}

async function trackHistory(context, query, dependencies) {
    if (!query) return handled(`Usage: ${context.prefix}trackhistory <tracked player>.`);
    const selection = resolveTrackedSelection(context, query, dependencies);
    if (selection.error) return handled(selection.error);
    const result = await getBattlemetricsProvider(dependencies).getSessions(
        selection.player.playerId, selection.scope.battlemetricsId, dependencies);
    if (result.available !== true) {
        return handled(`BattleMetrics sessions unavailable (${result.reason}); tracker unchanged.`);
    }
    await persistBattlemetricsSection(context, selection.scope, selection.player.playerId, 'sessions', {
        fetchedAt: (dependencies.now || (() => new Date()))().toISOString(),
        truncated: result.truncated,
        items: result.sessions
    }, dependencies);
    if (result.sessions.length === 0) {
        return handled(`No BattleMetrics sessions found for ${selection.record.name} on the current server.`);
    }
    const suffix = result.truncated || result.sessions.length > 2 ? ` | +${Math.max(1, result.sessions.length - 2)}` : '';
    return handled(fitSingleResponse(`Sessions ${selection.record.name}: ${result.sessions.slice(0, 2)
        .map(formatSession).join(' | ')}${suffix}`));
}

async function trackRelated(context, query, dependencies) {
    if (!query) return handled(`Usage: ${context.prefix}trackrelated <tracked player>.`);
    const selection = resolveTrackedSelection(context, query, dependencies);
    if (selection.error) return handled(selection.error);
    const result = await getBattlemetricsProvider(dependencies).getRelatedPlayers(
        selection.player.playerId, selection.scope.battlemetricsId, dependencies);
    if (result.available !== true) {
        return handled(`BattleMetrics related players unavailable (${result.reason}); tracker unchanged.`);
    }
    await persistBattlemetricsSection(context, selection.scope, selection.player.playerId, 'related', {
        fetchedAt: (dependencies.now || (() => new Date()))().toISOString(),
        truncated: result.truncated,
        players: result.players
    }, dependencies);
    if (result.players.length === 0) return handled(`No BattleMetrics related players found for ${selection.record.name}.`);
    const entries = result.players.slice(0, 3).map(player => {
        const overlap = formatDuration(player.overlapSeconds);
        const sessions = player.sessionCount !== null ? `${player.sessionCount} sessions` : null;
        return `${player.name}${overlap ? ` ${overlap}` : sessions ? ` ${sessions}` : ''}`;
    });
    const suffix = result.truncated || result.players.length > 3 ? ` | +${Math.max(1, result.players.length - 3)}` : '';
    return handled(fitSingleResponse(`Related ${selection.record.name}: ${entries.join(' | ')}${suffix}`));
}

async function track(context, query, dependencies) {
    if (!query) {
        return handled(`Usage: ${context.prefix}track <partial player name|SteamID64>.`);
    }
    const scope = getScope(context);
    if (!scope) return handled('Player tracker unavailable: configure BattleMetrics for the active server.');

    const remembered = resolveRememberedSelection(context, scope, query, dependencies);
    if (remembered && remembered.error === 'expired') {
        return handled(`Selection expired; run ${context.prefix}track ${remembered.pending.displayQuery} again.`);
    }
    if (remembered && remembered.error === 'invalid') {
        return handled(`Invalid selection; choose 1-${remembered.pending.candidates.length}.`);
    }
    if (!remembered && query.length > MAX_QUERY_LENGTH) {
        return handled(`Usage: ${context.prefix}track <partial player name|SteamID64>.`);
    }

    let selectionKey = remembered && remembered.key;
    let candidate = remembered && remembered.candidate;
    let requestedSteamId = remembered ? remembered.pending.requestedSteamId :
        (/^7656119\d{10}$/.test(query) ? query : null);
    let lookupQuery = remembered ? remembered.pending.lookupQuery : query;
    let warBanditsPlayer = null;

    const existingBySteam = requestedSteamId &&
        findManagedTracker(scope.instance, scope.serverId, scope.battlemetricsId);
    const existingSteamPlayer = existingBySteam && existingBySteam.tracker.players
        .find(player => `${player.steamId}` === requestedSteamId);
    if (existingSteamPlayer) {
        const existingWarBanditsPlayer = await resolveWarBanditsPlayer(
            context, scope, requestedSteamId, dependencies);
        await linkWarBanditsPlayer(
            context, scope, existingSteamPlayer, existingWarBanditsPlayer,
            requestedSteamId, dependencies);
        if (selectionKey) pendingSelections.delete(selectionKey);
        return handled(`Already tracked: ${existingSteamPlayer.name} (BM:${existingSteamPlayer.playerId}).`);
    }

    if (!remembered && requestedSteamId) {
        warBanditsPlayer = await resolveWarBanditsPlayer(
            context, scope, requestedSteamId, dependencies);
        if (warBanditsPlayer) {
            lookupQuery = warBanditsPlayer.name;
        }
        else {
            const steamProfile = await resolveSteamProfileName(context, requestedSteamId, dependencies);
            if (!steamProfile.name) {
                return handled(`Steam profile name unavailable (${steamProfile.reason}); nothing was saved.`);
            }
            lookupQuery = steamProfile.name;
        }
    }

    if (!candidate) {
        const resolution = await resolveCandidate(context, scope, lookupQuery, dependencies);
        if (!resolution.candidate) {
            if ((resolution.ambiguous || resolution.candidates.length > 1) &&
                resolution.candidates.length > 0) {
                const stored = rememberSelection(
                    context, scope, query, lookupQuery, requestedSteamId, resolution.candidates, dependencies);
                return handled(formatSelectionPrompt(
                    context, query, stored.choices, resolution.moreResults || resolution.candidates.length > 5));
            }
            if (resolution.unavailable) {
                if (resolution.candidates.length === 1) {
                    const stored = rememberSelection(
                        context, scope, query, lookupQuery, requestedSteamId, resolution.candidates, dependencies);
                    return handled(`BattleMetrics search unavailable (${resolution.reason}). ${formatSelectionPrompt(
                        context, query, stored.choices)}`);
                }
                return handled(`BattleMetrics search unavailable (${resolution.reason}); nothing was saved.`);
            }
            const steamDetail = requestedSteamId ? ` (Steam name: ${lookupQuery})` : '';
            return handled(`Player not found on the current server: ${lookupQuery}${steamDetail}.`);
        }
        candidate = resolution.candidate;
    }

    const existingEntry = findManagedTracker(scope.instance, scope.serverId, scope.battlemetricsId);
    const existingPlayer = existingEntry && existingEntry.tracker.players
        .find(player => `${player.playerId}` === candidate.playerId);
    if (existingPlayer && (!requestedSteamId || existingPlayer.steamId)) {
        const existingWarBanditsPlayer = await resolveWarBanditsPlayer(
            context, scope, existingPlayer.steamId || candidate.name, dependencies);
        await linkWarBanditsPlayer(
            context, scope, existingPlayer, existingWarBanditsPlayer,
            existingPlayer.steamId || (existingWarBanditsPlayer && existingWarBanditsPlayer.steamId), dependencies);
        if (selectionKey) pendingSelections.delete(selectionKey);
        return handled(`Already tracked: ${candidate.name} (BM:${candidate.playerId}).`);
    }

    const battlemetricsSteamId = await resolveSteamId(context, candidate.playerId, dependencies);
    if (!warBanditsPlayer) {
        const enriched = await resolveWarBanditsPlayer(context, scope, candidate.name, dependencies);
        if (enriched && normalize(enriched.name) === normalize(candidate.name)) warBanditsPlayer = enriched;
    }
    const warBanditsSteamId = warBanditsPlayer && warBanditsPlayer.steamId;
    if (requestedSteamId && battlemetricsSteamId && battlemetricsSteamId !== requestedSteamId) {
        logWarning(context, 'SteamID and BattleMetrics identifier mismatch; tracker mutation rejected.');
        return handled('SteamID does not match the resolved BattleMetrics player; nothing was saved.');
    }
    if (battlemetricsSteamId && warBanditsSteamId && battlemetricsSteamId !== warBanditsSteamId) {
        logWarning(context, 'WarBandits and BattleMetrics SteamID mismatch; tracker mutation rejected.');
        return handled('WarBandits identity does not match the resolved BattleMetrics player; nothing was saved.');
    }
    if (requestedSteamId && !battlemetricsSteamId &&
        !matchesSteamProfileName(lookupQuery, candidate.name)) {
        return handled(`Steam name resolved as ${lookupQuery}, but no exact current-server match was proven; nothing was saved.`);
    }
    const steamId = requestedSteamId || battlemetricsSteamId || warBanditsSteamId;
    const lockKey = `${context.guildId}:${scope.battlemetricsId}`;
    return withMutationLock(lockKey, async () => {
        const freshScope = getScope(context);
        if (!freshScope || freshScope.battlemetricsId !== scope.battlemetricsId ||
            freshScope.serverId !== scope.serverId) {
            return handled('Active server changed; nothing was saved.');
        }
        const entry = findManagedTracker(freshScope.instance, freshScope.serverId, freshScope.battlemetricsId) ||
            createManagedTracker(context, freshScope);
        const duplicate = entry.tracker.players.find(player => `${player.playerId}` === candidate.playerId ||
            (steamId && `${player.steamId}` === steamId));

        const path = getDataPath(context.guildId, freshScope.battlemetricsId, dependencies);
        const previous = readSnapshot(path);
        if (duplicate) {
            if (requestedSteamId && !duplicate.steamId && `${duplicate.playerId}` === candidate.playerId) {
                const tracker = {
                    ...entry.tracker,
                    players: entry.tracker.players.map(player => player === duplicate ?
                        { ...player, steamId: requestedSteamId, playerIdLocked: true } : player)
                };
                commitTracker(context, freshScope, entry.trackerId, tracker, previous,
                    { [candidate.playerId]: candidate }, dependencies);
                await linkWarBanditsPlayer(
                    context, freshScope, duplicate, warBanditsPlayer, requestedSteamId, dependencies);
                if (selectionKey) pendingSelections.delete(selectionKey);
                return handled(`Tracking updated: ${duplicate.name} | BM:${duplicate.playerId} | Steam:${requestedSteamId}.`);
            }
            if (selectionKey) pendingSelections.delete(selectionKey);
            return handled(`Already tracked: ${duplicate.name} (BM:${duplicate.playerId}).`);
        }
        const tracker = {
            ...entry.tracker,
            managedBy: MANAGED_BY,
            players: [...entry.tracker.players, {
                name: candidate.name,
                steamId,
                playerId: candidate.playerId,
                playerIdLocked: true
            }]
        };
        commitTracker(context, freshScope, entry.trackerId, tracker, previous,
            { [candidate.playerId]: candidate }, dependencies);
        await linkWarBanditsPlayer(
            context, freshScope, candidate, warBanditsPlayer, steamId, dependencies);
        if (selectionKey) pendingSelections.delete(selectionKey);
        return handled(`Tracking: ${candidate.name} | BM:${candidate.playerId} | Steam:${steamId || 'unavailable'} | ${candidate.status}.`);
    });
}

async function trackList(context, query, dependencies) {
    const normalizedQuery = normalize(query);
    if (normalizedQuery !== '' && normalizedQuery !== 'all') {
        return handled(`Usage: ${context.prefix}tracklist [all] or ${context.prefix}tracks [all].`);
    }
    const scope = getScope(context);
    if (!scope) return handled('Player tracker unavailable: configure BattleMetrics for the active server.');
    const lockKey = `${context.guildId}:${scope.battlemetricsId}`;
    return withMutationLock(lockKey, async () => {
        const freshScope = getScope(context);
        if (!freshScope || freshScope.battlemetricsId !== scope.battlemetricsId ||
            freshScope.serverId !== scope.serverId) {
            return handled('Active server changed; retry the command.');
        }
        const entry = findManagedTracker(
            freshScope.instance, freshScope.serverId, freshScope.battlemetricsId);
        if (!entry) return handled('No tracked players.');
        const path = getDataPath(context.guildId, freshScope.battlemetricsId, dependencies);
        const previous = readSnapshot(path);
        const snapshot = buildSnapshot(context, freshScope, entry.trackerId, entry.tracker,
            previous, null, dependencies);
        writeSnapshot(path, snapshot);
        return handled(formatTrackList(snapshot, dependencies, normalizedQuery === 'all'));
    });
}

function selectTrackedPlayer(players, query) {
    const normalizedQuery = normalize(query);
    const ids = players.filter(player => `${player.playerId}` === query || `${player.steamId}` === query);
    if (ids.length === 1) return Object.freeze({ player: ids[0], matches: ids });
    if (ids.length > 1) return Object.freeze({ player: null, matches: ids });
    const exact = players.filter(player => normalize(player.name) === normalizedQuery);
    if (exact.length === 1) return Object.freeze({ player: exact[0], matches: exact });
    if (exact.length > 1) return Object.freeze({ player: null, matches: exact });
    const partial = players.filter(player => normalize(player.name).includes(normalizedQuery));
    return Object.freeze({ player: partial.length === 1 ? partial[0] : null, matches: partial });
}

async function untrack(context, query, dependencies) {
    if (!query || query.length > MAX_QUERY_LENGTH) {
        return handled(`Usage: ${context.prefix}untrack <partial player name|BattleMetrics ID|SteamID64>.`);
    }
    const scope = getScope(context);
    if (!scope) return handled('Player tracker unavailable: configure BattleMetrics for the active server.');

    const lockKey = `${context.guildId}:${scope.battlemetricsId}`;
    return withMutationLock(lockKey, async () => {
        const freshScope = getScope(context);
        if (!freshScope || freshScope.battlemetricsId !== scope.battlemetricsId ||
            freshScope.serverId !== scope.serverId) {
            return handled('Active server changed; nothing was changed.');
        }
        const entry = freshScope && findManagedTracker(
            freshScope.instance, freshScope.serverId, freshScope.battlemetricsId);
        if (!entry) return handled('No tracked players.');

        const selection = selectTrackedPlayer(entry.tracker.players, query);
        if (!selection.player) {
            if (selection.matches.length > 1) {
                return handled(`Ambiguous tracked player: ${formatCandidates(selection.matches.map(player => ({
                    name: player.name, playerId: player.playerId, status: 'unknown'
                })))}.`);
            }
            return handled(`Tracked player not found: ${query}.`);
        }

        const path = getDataPath(context.guildId, freshScope.battlemetricsId, dependencies);
        const previous = readSnapshot(path);
        const tracker = {
            ...entry.tracker,
            players: entry.tracker.players.filter(player => player !== selection.player)
        };
        commitTracker(context, freshScope, entry.trackerId, tracker, previous, null, dependencies);
        return handled(`Stopped tracking: ${selection.player.name} (BM:${selection.player.playerId}).`);
    });
}

async function handleCommand(context) {
    const parsed = parseCommand(context);
    if (!parsed || !commandAllowed(context)) return Object.freeze({ handled: false });
    const dependencies = context.playerTrackerDependencies || {};
    try {
        if (parsed.name === 'track') return await track(context, parsed.query, dependencies);
        if (parsed.name === 'trackinfo') return await trackInfo(context, parsed.query, dependencies);
        if (parsed.name === 'trackhistory') return await trackHistory(context, parsed.query, dependencies);
        if (parsed.name === 'trackrelated') return await trackRelated(context, parsed.query, dependencies);
        if (parsed.name === 'untrack') return await untrack(context, parsed.query, dependencies);
        return await trackList(context, parsed.query, dependencies);
    }
    catch (error) {
        logWarning(context, `Command failed safely: ${error.message || error}.`);
        return handled('Player tracker failed safely; nothing was changed. Check the logs.');
    }
}

async function onBattlemetricsUpdated(context) {
    const instance = context.client.getInstance(context.guildId);
    if (!instance || !instance.trackers) return;
    const dependencies = context.playerTrackerDependencies || {};

    for (const [trackerId, tracker] of Object.entries(instance.trackers)) {
        if (tracker.managedBy !== MANAGED_BY || !/^\d+$/.test(`${tracker.battlemetricsId}`)) continue;
        const server = instance.serverList && instance.serverList[tracker.serverId];
        if (!server) continue;
        const lockKey = `${context.guildId}:${tracker.battlemetricsId}`;
        await withMutationLock(lockKey, async () => {
            const current = context.client.getInstance(context.guildId);
            const currentTracker = current && current.trackers && current.trackers[trackerId];
            const currentServer = current && current.serverList &&
                currentTracker && current.serverList[currentTracker.serverId];
            if (!currentTracker || currentTracker.managedBy !== MANAGED_BY || !currentServer) return;
            const scope = Object.freeze({
                instance: current,
                server: currentServer,
                serverId: `${currentTracker.serverId}`,
                battlemetricsId: `${currentTracker.battlemetricsId}`
            });
            const path = getDataPath(context.guildId, scope.battlemetricsId, dependencies);
            const previous = readSnapshot(path);
            const snapshot = buildSnapshot(
                context, scope, trackerId, currentTracker, previous, null, dependencies);
            writeSnapshot(path, snapshot);

            const currentNames = new Map(snapshot.players.map(player =>
                [player.battlemetricsPlayerId, player.name]));
            let changed = false;
            const players = currentTracker.players.map(player => {
                const name = currentNames.get(`${player.playerId}`);
                if (!name || name === player.name) return player;
                changed = true;
                return { ...player, name };
            });
            if (changed) {
                context.client.setInstance(context.guildId, {
                    ...current,
                    trackers: {
                        ...current.trackers,
                        [trackerId]: { ...currentTracker, players }
                    }
                });
            }
        });
    }
}

module.exports = Object.freeze({
    handleCommand,
    onBattlemetricsUpdated,
    parseSteamProfileName,
    parseSteamId,
    selectCandidate
});
