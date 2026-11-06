// @ts-check
'use strict';

const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');

const PlayerIntelligence = require('../plugins/playerIntelligence/index.js');

const SHARD_PATTERN = /^\d{4}-\d{2}\.jsonl$/u;
const STEAM_ID_PATTERN = /^7656119\d{10}$/u;

/** @param {unknown} value */
function cleanText(value) {
    return `${value ?? ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {string} value */
function csv(value) {
    const text = `${value ?? ''}`;
    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** @param {string} path @param {string} contents */
async function atomicWrite(path, contents) {
    await Fs.promises.mkdir(Path.dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
        handle = await Fs.promises.open(temporary, 'wx', 0o600);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await Fs.promises.rename(temporary, path);
    }
    finally {
        if (handle) await handle.close().catch(() => undefined);
        await Fs.promises.unlink(temporary).catch(error => {
            if (error && /** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
        });
    }
}

/** @param {string} root */
async function discoverHistoryDirectories(root) {
    const resolvedRoot = Path.resolve(root);
    /** @type {string[]} */
    const directories = [];
    /** @param {string} directory @param {number} depth */
    async function visit(directory, depth) {
        if (depth > 4) throw new Error(`Player-intelligence directory nesting is too deep under ${resolvedRoot}.`);
        let entries;
        try {
            entries = await Fs.promises.readdir(directory, { withFileTypes: true });
        }
        catch (error) {
            if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return;
            throw error;
        }
        if (entries.some(entry => entry.isFile() && SHARD_PATTERN.test(entry.name))) {
            directories.push(directory);
            return;
        }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            await visit(Path.join(directory, entry.name), depth + 1);
        }
    }
    await visit(resolvedRoot, 0);
    return Object.freeze(directories.sort());
}

/** @param {Map<string, any>} rows @param {string} id */
function ensureRow(rows, id) {
    if (!rows.has(id)) rows.set(id, {
        steamId: id,
        displayNames: new Map(),
        aliases: new Map(),
        currentSteamNames: new Map(),
        battlemetricsPlayerIds: new Set(),
        serverKeys: new Set(),
        wipeKeys: new Set(),
        identityObservationCount: 0,
        confirmedClanSnapshotCount: 0,
        firstObservedAt: null,
        lastObservedAt: null,
        warBanditsByServer: new Map()
    });
    return rows.get(id);
}

/** @param {any} row @param {string|null} observedAt */
function observeTime(row, observedAt) {
    if (!observedAt) return;
    if (row.firstObservedAt === null || observedAt < row.firstObservedAt) row.firstObservedAt = observedAt;
    if (row.lastObservedAt === null || observedAt > row.lastObservedAt) row.lastObservedAt = observedAt;
}

/** @param {Map<string, any>} target @param {string} value @param {string|null} observedAt */
function addDatedText(target, value, observedAt) {
    const text = cleanText(value);
    if (!text) return;
    const previous = target.get(text);
    if (!previous || `${previous}` < `${observedAt || ''}`) target.set(text, observedAt || '');
}

/** @param {any} row */
function finalizeRow(row) {
    const currentSteamName = [...row.currentSteamNames.entries()].sort((left, right) =>
        `${right[1]}`.localeCompare(`${left[1]}`) || left[0].localeCompare(right[0]))[0]?.[0] || null;
    const localDisplayName = currentSteamName || [...row.displayNames.entries()].sort((left, right) =>
        `${right[1]}`.localeCompare(`${left[1]}`) || left[0].localeCompare(right[0]))[0]?.[0] || null;
    const aliases = [...row.aliases.keys()].sort((left, right) => left.localeCompare(right));
    const warBanditsByServer = [...row.warBanditsByServer.entries()].map(([serverKey, metric]) => ({
        serverKey,
        hours: metric.hours,
        observedAt: metric.observedAt
    })).sort((left, right) => left.serverKey.localeCompare(right.serverKey));
    const observationCount = row.identityObservationCount + row.confirmedClanSnapshotCount;
    return Object.freeze({
        steamId: row.steamId,
        profileUrl: `https://steamcommunity.com/profiles/${row.steamId}/`,
        localDisplayName,
        currentSteamName,
        verifiedAliases: Object.freeze(aliases),
        battlemetricsPlayerIds: Object.freeze([...row.battlemetricsPlayerIds].sort((left, right) =>
            left.localeCompare(right, 'en', { numeric: true }))),
        serverKeys: Object.freeze([...row.serverKeys].sort()),
        serverCount: row.serverKeys.size,
        wipeCount: row.wipeKeys.size,
        observationCount,
        identityObservationCount: row.identityObservationCount,
        confirmedClanSnapshotCount: row.confirmedClanSnapshotCount,
        firstObservedAt: row.firstObservedAt,
        lastObservedAt: row.lastObservedAt,
        warBanditsHoursMax: warBanditsByServer.length > 0 ?
            Math.max(...warBanditsByServer.map((/** @type {any} */ value) => value.hours)) : null,
        warBanditsByServer: Object.freeze(warBanditsByServer),
        warBanditsRank: null,
        warBanditsPlayerId: null
    });
}

/** @param {any} left @param {any} right */
function priorityCompare(left, right) {
    return right.wipeCount - left.wipeCount ||
        right.confirmedClanSnapshotCount - left.confirmedClanSnapshotCount ||
        right.observationCount - left.observationCount ||
        `${left.firstObservedAt || '9999'}`.localeCompare(`${right.firstObservedAt || '9999'}`) ||
        left.steamId.localeCompare(right.steamId);
}

/**
 * Export every consolidated Steam identity without changing the journal. Each database is rebuilt independently so
 * peak memory is bounded by the largest server database, not the sum of every configured server.
 * @param {{dataRoot:string,onDatabase?:(value:{directory:string,index:number,total:number})=>void}} options
 */
async function collectIdentities(options) {
    const directories = await discoverHistoryDirectories(options.dataRoot);
    const rows = new Map();
    for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
        const directory = directories[directoryIndex];
        options.onDatabase?.({ directory, index: directoryIndex + 1, total: directories.length });
        const store = new PlayerIntelligence.JsonlHistoryStore({ directory });
        const events = await store.readAll();
        const effective = PlayerIntelligence.effectiveEvents(events);
        const projection = PlayerIntelligence.rebuildForScan(events);
        const identities = projection.identities;

        for (const person of identities.persons) {
            if (!person.steamId || !STEAM_ID_PATTERN.test(person.steamId)) continue;
            const row = ensureRow(rows, person.steamId);
            for (const id of person.battlemetricsPlayerIds) row.battlemetricsPlayerIds.add(id);
            const displayed = identities.displayName(person.personId);
            const displayAlias = person.names.find((/** @type {any} */ alias) => alias.name === displayed);
            if (displayAlias?.verified) {
                addDatedText(row.displayNames, displayed,
                    displayAlias.lastVerifiedAt || displayAlias.lastObservedAt || null);
            }
            for (const alias of person.names) {
                if (!alias.verified) continue;
                addDatedText(row.aliases, alias.name, alias.lastVerifiedAt || alias.lastObservedAt);
                if (alias.steamStatus === 'current') {
                    addDatedText(row.currentSteamNames, alias.name, alias.lastVerifiedAt || alias.lastObservedAt);
                }
                observeTime(row, alias.firstObservedAt);
                observeTime(row, alias.lastObservedAt);
            }
        }

        for (const event of effective) {
            if (event.kind !== 'identity_observed') continue;
            const resolved = identities.resolveSubject(event.subject);
            if (resolved.ambiguous || !resolved.personId.startsWith('steam:')) continue;
            const id = resolved.personId.slice(6);
            if (!STEAM_ID_PATTERN.test(id)) continue;
            const row = ensureRow(rows, id);
            row.identityObservationCount += 1;
            row.serverKeys.add(event.scope.serverKey);
            if (event.scope.wipeId) row.wipeKeys.add(`${event.scope.serverKey}\u0000${event.scope.wipeId}`);
            observeTime(row, event.observedAt);
        }

        const clanEvents = effective.filter(event => event.kind === 'clan_snapshot').slice().sort((left, right) =>
            left.observedAt.localeCompare(right.observedAt) || left.eventId.localeCompare(right.eventId));
        if (clanEvents.length !== projection.clans.snapshots.length) {
            throw new Error(`Compact clan projection mismatch in ${directory}.`);
        }
        for (let snapshotIndex = 0; snapshotIndex < projection.clans.snapshots.length; snapshotIndex += 1) {
            const snapshot = projection.clans.snapshots[snapshotIndex];
            const clanEvent = clanEvents[snapshotIndex];
            if (!snapshot.confirmed || snapshot.duplicate) continue;
            for (const member of snapshot.members) {
                if (!member.personId.startsWith('steam:')) continue;
                const id = member.personId.slice(6);
                if (!STEAM_ID_PATTERN.test(id)) continue;
                const row = ensureRow(rows, id);
                row.confirmedClanSnapshotCount += 1;
                row.serverKeys.add(clanEvent.scope.serverKey);
                if (clanEvent.scope.wipeId) {
                    row.wipeKeys.add(`${clanEvent.scope.serverKey}\u0000${clanEvent.scope.wipeId}`);
                }
                observeTime(row, clanEvent.observedAt);
            }
        }

        for (const metric of projection.metrics.observations) {
            if (!metric.personId.startsWith('steam:') || metric.provider !== 'warbandits' ||
                metric.metric !== 'playtime' || metric.unit !== 'hours') continue;
            const id = metric.personId.slice(6);
            if (!STEAM_ID_PATTERN.test(id)) continue;
            const row = ensureRow(rows, id);
            const previous = row.warBanditsByServer.get(metric.serverKey);
            if (!previous || previous.observedAt < metric.observedAt) {
                row.warBanditsByServer.set(metric.serverKey, {
                    hours: metric.value,
                    observedAt: metric.observedAt
                });
            }
        }
    }
    return Object.freeze([...rows.values()].map(finalizeRow).sort(priorityCompare)
        .map((row, index) => Object.freeze({ priorityRank: index + 1, ...row })));
}

/** @param {readonly any[]} rows */
function identityJsonl(rows) {
    return rows.map(row => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/** @param {readonly any[]} rows */
function identityCsv(rows) {
    const headers = [
        'priority_rank', 'steamid64', 'profile_url', 'local_display_name', 'current_steam_name',
        'verified_aliases', 'battlemetrics_ids', 'server_count', 'wipe_count', 'observation_count',
        'identity_observation_count', 'confirmed_clan_snapshot_count', 'first_observed_at', 'last_observed_at',
        'warbandits_hours_max', 'warbandits_by_server', 'warbandits_rank', 'warbandits_player_id'
    ];
    const lines = rows.map(row => [
        row.priorityRank, row.steamId, row.profileUrl, row.localDisplayName || '', row.currentSteamName || '',
        row.verifiedAliases.join(' | '), row.battlemetricsPlayerIds.join(' | '), row.serverCount, row.wipeCount,
        row.observationCount, row.identityObservationCount, row.confirmedClanSnapshotCount,
        row.firstObservedAt || '', row.lastObservedAt || '', row.warBanditsHoursMax ?? '',
        row.warBanditsByServer.map((/** @type {any} */ value) =>
            `${value.serverKey}=${value.hours}`).join(' | '),
        row.warBanditsRank ?? '', row.warBanditsPlayerId ?? ''
    ].map(value => csv(`${value}`)).join(','));
    return `${headers.join(',')}\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

/** @param {readonly any[]} rows @param {{outputDirectory:string,source:string,sourceRoot:string,now?:()=>Date}} options */
async function writeIdentitySnapshot(rows, options) {
    const jsonl = identityJsonl(rows);
    const hash = Crypto.createHash('sha256').update(jsonl).digest('hex');
    const outputDirectory = Path.resolve(options.outputDirectory);
    await atomicWrite(Path.join(outputDirectory, 'identities.jsonl'), jsonl);
    await atomicWrite(Path.join(outputDirectory, 'identities.csv'), identityCsv(rows));
    const metadata = Object.freeze({
        schemaVersion: 1,
        generatedAt: (options.now || (() => new Date()))().toISOString(),
        source: options.source,
        sourceRoot: options.sourceRoot,
        identityCount: rows.length,
        sha256: hash,
        priority: [
            'distinct wipe count descending',
            'confirmed non-duplicate clan snapshot count descending',
            'identity plus confirmed clan observation count descending',
            'oldest first observation ascending'
        ]
    });
    await atomicWrite(Path.join(outputDirectory, 'identity-export.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    return Object.freeze({ rows, metadata });
}

/** @param {{dataRoot:string,outputDirectory:string,now?:()=>Date,onDatabase?:Function}} options */
async function exportIdentities(options) {
    const rows = await collectIdentities({
        dataRoot: options.dataRoot,
        onDatabase: /** @type {any} */ (options.onDatabase)
    });
    return writeIdentitySnapshot(rows, {
        outputDirectory: options.outputDirectory,
        source: 'local-player-intelligence',
        sourceRoot: Path.resolve(options.dataRoot),
        now: options.now
    });
}

module.exports = Object.freeze({
    atomicWrite,
    collectIdentities,
    discoverHistoryDirectories,
    exportIdentities,
    identityCsv,
    identityJsonl,
    priorityCompare,
    writeIdentitySnapshot
});
