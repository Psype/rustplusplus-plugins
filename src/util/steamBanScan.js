// @ts-check
'use strict';

const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');

const SteamApi = require('./steamBanApi.js');
const { atomicWrite } = require('./steamBanExport.js');

const RESULT_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_HOURS = 24;

/** @param {number} milliseconds */
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** @param {unknown} value @param {string} label @param {number} minimum @param {number} maximum */
function boundedInteger(value, label, minimum, maximum) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
    }
    return number;
}

/** @param {string} path */
async function readJson(path) {
    return JSON.parse(await Fs.promises.readFile(path, 'utf8'));
}

/** @param {string} path */
async function readJsonl(path) {
    let text;
    try {
        text = await Fs.promises.readFile(path, 'utf8');
    }
    catch (error) {
        if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
        throw error;
    }
    const values = [];
    for (const [index, line] of text.split('\n').entries()) {
        if (!line) continue;
        try {
            values.push(JSON.parse(line));
        }
        catch (error) {
            throw new Error(`Invalid scanner JSONL at ${path}:${index + 1}.`, { cause: error });
        }
    }
    return values;
}

/** @param {string} path @param {readonly any[]} values */
async function appendJsonl(path, values) {
    if (values.length === 0) return;
    await Fs.promises.mkdir(Path.dirname(path), { recursive: true });
    const handle = await Fs.promises.open(path, 'a', 0o600);
    try {
        await handle.writeFile(`${values.map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}

/** @param {string} contents */
function sha256(contents) {
    return Crypto.createHash('sha256').update(contents).digest('hex');
}

/** @param {unknown} value */
function validateIdentity(value) {
    const identity = /** @type {any} */ (value);
    if (!value || typeof value !== 'object' || !SteamApi.STEAM_ID_PATTERN.test(`${identity.steamId || ''}`)) {
        throw new TypeError('Identity snapshot row is invalid.');
    }
    for (const field of ['priorityRank', 'wipeCount', 'observationCount', 'confirmedClanSnapshotCount']) {
        boundedInteger(identity[field], `Identity ${field}`, 0, Number.MAX_SAFE_INTEGER);
    }
    if (!Array.isArray(identity.verifiedAliases) || identity.verifiedAliases.length > 1024 ||
        !Array.isArray(identity.battlemetricsPlayerIds) || identity.battlemetricsPlayerIds.length > 1024 ||
        !Array.isArray(identity.warBanditsByServer) || identity.warBanditsByServer.length > 256) {
        throw new TypeError('Identity snapshot collections are invalid.');
    }
    return identity;
}

/** @param {string} outputDirectory */
async function loadSnapshot(outputDirectory) {
    const jsonlPath = Path.join(outputDirectory, 'identities.jsonl');
    const contents = await Fs.promises.readFile(jsonlPath, 'utf8');
    const metadata = await readJson(Path.join(outputDirectory, 'identity-export.json'));
    const hash = sha256(contents);
    if (!metadata || metadata.schemaVersion !== 1 || metadata.sha256 !== hash) {
        throw new Error('Identity snapshot metadata/hash mismatch; run export again.');
    }
    const rows = [];
    for (const [index, line] of contents.split('\n').entries()) {
        if (!line) continue;
        try {
            rows.push(validateIdentity(JSON.parse(line)));
        }
        catch (error) {
            throw new Error(`Invalid identity snapshot at ${jsonlPath}:${index + 1}.`, { cause: error });
        }
    }
    if (rows.length !== metadata.identityCount) throw new Error('Identity snapshot count mismatch.');
    return Object.freeze({ hash, metadata, rows: Object.freeze(rows) });
}

/** @param {any} error @param {number} attempt */
function retryDelay(error, attempt) {
    if (error instanceof SteamApi.SteamApiError) {
        if (error.status !== null && error.status < 500 && error.status !== 429) return null;
        if (error.retryAfterMs !== null) return error.retryAfterMs;
    }
    return Math.min(10 * 60_000, 5_000 * (2 ** attempt));
}

/** @param {()=>Promise<any>} action @param {{attempts:number,sleep:(ms:number)=>Promise<void>,
 * onRetry?:(value:{attempt:number,delayMs:number,status:number|null})=>void}} options */
async function withRetries(action, options) {
    let lastError;
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
        try {
            return await action();
        }
        catch (error) {
            lastError = error;
            const delay = retryDelay(error, attempt);
            if (delay === null || attempt + 1 >= options.attempts) throw error;
            options.onRetry?.({
                attempt: attempt + 1,
                delayMs: delay,
                status: error instanceof SteamApi.SteamApiError ? error.status : null
            });
            await options.sleep(delay);
        }
    }
    throw lastError;
}

/** @param {number} delayMs @param {()=>number} nowMs @param {(ms:number)=>Promise<void>} sleepImpl */
function requestGate(delayMs, nowMs, sleepImpl) {
    /** @type {number|null} */
    let lastStartedAt = null;
    return async function wait() {
        if (lastStartedAt !== null) {
            const remaining = delayMs - (nowMs() - lastStartedAt);
            if (remaining > 0) await sleepImpl(remaining);
        }
        lastStartedAt = nowMs();
    };
}

/** @param {string} checkedAt @param {number} days */
function approximateBanDate(checkedAt, days) {
    const date = new Date(checkedAt);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
}

/** @param {unknown} value */
function csv(value) {
    const text = `${value ?? ''}`;
    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** @param {readonly any[]} matches */
function reportCsv(matches) {
    const headers = [
        'steamid64', 'profile_url', 'steam_name', 'local_display_name', 'verified_aliases', 'battlemetrics_ids',
        'days_since_last_ban', 'approx_last_ban_date', 'game_bans', 'vac_bans', 'vac_banned', 'community_banned',
        'economy_ban', 'rust_hours_steam', 'warbandits_hours_max', 'warbandits_by_server', 'priority_rank',
        'wipe_count', 'observation_count', 'confirmed_clan_snapshots', 'first_observed_at', 'last_observed_at',
        'checked_at', 'recency_basis'
    ];
    const lines = matches.map(value => [
        value.steamId, value.profileUrl, value.steamName || '', value.localDisplayName || '',
        value.verifiedAliases.join(' | '), value.battlemetricsPlayerIds.join(' | '), value.daysSinceLastBan,
        value.approximateLastBanDate, value.numberOfGameBans, value.numberOfVacBans, value.vacBanned,
        value.communityBanned, value.economyBan, value.steamRustHours ?? '', value.warBanditsHoursMax ?? '',
        value.warBanditsByServer.map((/** @type {any} */ item) =>
            `${item.serverKey}=${item.hours}`).join(' | '), value.priorityRank,
        value.wipeCount, value.observationCount, value.confirmedClanSnapshotCount, value.firstObservedAt || '',
        value.lastObservedAt || '', value.checkedAt, value.recencyBasis
    ].map(item => csv(item)).join(','));
    return `${headers.join(',')}\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

/** @param {readonly any[]} rows @param {Map<string, any>} results @param {number} days */
function buildMatches(rows, results, days) {
    const matches = [];
    for (const identity of rows) {
        const result = results.get(identity.steamId);
        if (!result || result.numberOfGameBans < 1 || result.daysSinceLastBan >= days) continue;
        matches.push(Object.freeze({
            steamId: identity.steamId,
            profileUrl: result.profileUrl || identity.profileUrl,
            steamName: result.steamName || identity.currentSteamName || null,
            localDisplayName: identity.localDisplayName,
            verifiedAliases: identity.verifiedAliases,
            battlemetricsPlayerIds: identity.battlemetricsPlayerIds,
            daysSinceLastBan: result.daysSinceLastBan,
            approximateLastBanDate: approximateBanDate(result.checkedAt, result.daysSinceLastBan),
            numberOfGameBans: result.numberOfGameBans,
            numberOfVacBans: result.numberOfVacBans,
            vacBanned: result.vacBanned,
            communityBanned: result.communityBanned,
            economyBan: result.economyBan,
            detailedBans: result.detailedBans,
            steamRustMinutes: result.steamRustMinutes,
            steamRustHours: result.steamRustMinutes === null ? null :
                Math.round((result.steamRustMinutes / 60) * 10) / 10,
            steamEnrichment: result.steamEnrichment,
            warBanditsHoursMax: identity.warBanditsHoursMax,
            warBanditsByServer: identity.warBanditsByServer,
            priorityRank: identity.priorityRank,
            wipeCount: identity.wipeCount,
            observationCount: identity.observationCount,
            confirmedClanSnapshotCount: identity.confirmedClanSnapshotCount,
            firstObservedAt: identity.firstObservedAt,
            lastObservedAt: identity.lastObservedAt,
            checkedAt: result.checkedAt,
            recencyBasis: 'game-ban count > 0 and aggregate Steam DaysSinceLastBan strictly below threshold'
        }));
    }
    return Object.freeze(matches);
}

/** @param {string} outputDirectory @param {readonly any[]} matches */
async function writeReports(outputDirectory, matches) {
    const jsonl = matches.map(value => JSON.stringify(value)).join('\n') + (matches.length > 0 ? '\n' : '');
    await atomicWrite(Path.join(outputDirectory, 'recent-game-bans.jsonl'), jsonl);
    await atomicWrite(Path.join(outputDirectory, 'recent-game-bans.csv'), reportCsv(matches));
}

/** @param {string} path @param {string} runId */
async function loadRunResults(path, runId) {
    const results = new Map();
    for (const value of await readJsonl(path)) {
        if (!value || value.schemaVersion !== RESULT_SCHEMA_VERSION || value.runId !== runId ||
            !SteamApi.STEAM_ID_PATTERN.test(`${value.steamId || ''}`)) continue;
        results.set(value.steamId, value);
    }
    return results;
}

/** @param {string} path @param {number} maximumAgeMs @param {number} nowMs */
async function loadBanCache(path, maximumAgeMs, nowMs) {
    const results = new Map();
    let lineCount = 0;
    for (const value of await readJsonl(path)) {
        lineCount += 1;
        if (!value || value.schemaVersion !== RESULT_SCHEMA_VERSION ||
            !SteamApi.STEAM_ID_PATTERN.test(`${value.steamId || ''}`) ||
            typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt)) ||
            nowMs - Date.parse(value.checkedAt) > maximumAgeMs) continue;
        const previous = results.get(value.steamId);
        if (!previous || previous.checkedAt < value.checkedAt) results.set(value.steamId, value);
    }
    return Object.freeze({ results, lineCount });
}

/**
 * @param {{outputDirectory:string,client:any,days?:number,delayMs?:number,batchSize?:number,maxIds?:number,
 * minWipes?:number,minObservations?:number,restart?:boolean,force?:boolean,cacheHours?:number,
 * now?:()=>Date,nowMs?:()=>number,
 * sleep?:(ms:number)=>Promise<void>,stopRequested?:()=>boolean,onProgress?:(value:any)=>void,
 * onMatch?:(value:any)=>void,
 * onRetry?:(value:{provider:string,operation:string,attempt:number,delayMs:number,status:number|null})=>void}} options
 */
async function scan(options) {
    const outputDirectory = Path.resolve(options.outputDirectory);
    const days = boundedInteger(options.days ?? 5, 'days', 1, 3650);
    const delayMs = boundedInteger(options.delayMs ?? 15_000, 'delayMs', 1000, 10 * 60_000);
    const batchSize = boundedInteger(options.batchSize ?? 25, 'batchSize', 1, 100);
    const maxIds = boundedInteger(options.maxIds ?? 0, 'maxIds', 0, 10_000_000);
    const minWipes = boundedInteger(options.minWipes ?? 0, 'minWipes', 0, 100_000);
    const minObservations = boundedInteger(options.minObservations ?? 1, 'minObservations', 1, 100_000_000);
    const cacheHours = boundedInteger(options.cacheHours ?? DEFAULT_CACHE_HOURS, 'cacheHours', 0, 365 * 24);
    const cacheMaxAgeMs = cacheHours * 60 * 60 * 1000;
    const now = options.now || (() => new Date());
    const nowMs = options.nowMs || Date.now;
    const sleepImpl = options.sleep || sleep;
    const snapshot = await loadSnapshot(outputDirectory);
    let selected = snapshot.rows.filter(row => row.wipeCount >= minWipes &&
        row.observationCount >= minObservations);
    if (maxIds > 0) selected = selected.slice(0, maxIds);
    const selection = Object.freeze({ days, maxIds, minWipes, minObservations,
        selectedIdentityCount: selected.length });
    const requestPolicy = Object.freeze({ delayMs, batchSize, cacheHours });
    const restart = options.restart === true || options.force === true;
    const ignoreCache = options.force === true;
    const statePath = Path.join(outputDirectory, 'scan-state.json');
    let state = null;
    try {
        state = await readJson(statePath);
    }
    catch (error) {
        if (!error || /** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
    const completedAtMs = state && typeof state.completedAt === 'string' ? Date.parse(state.completedAt) : Number.NaN;
    const completedFresh = !state || state.completedAt === null || (cacheHours > 0 &&
        Number.isFinite(completedAtMs) && nowMs() - completedAtMs <= cacheMaxAgeMs);
    const compatible = state && state.schemaVersion === STATE_SCHEMA_VERSION && completedFresh &&
        state.snapshotSha256 === snapshot.hash && JSON.stringify(state.selection) === JSON.stringify(selection);
    let startedNewRun = false;
    if (!state || !compatible || restart) {
        const startedAt = now().toISOString();
        const nonce = Crypto.randomBytes(16).toString('hex');
        const runId = sha256(`${snapshot.hash}\u0000${startedAt}\u0000${nonce}\u0000${JSON.stringify(selection)}`)
            .slice(0, 24);
        state = {
            schemaVersion: STATE_SCHEMA_VERSION,
            runId,
            snapshotSha256: snapshot.hash,
            startedAt,
            updatedAt: startedAt,
            completedAt: null,
            selection,
            requestPolicy,
            checkedIdentityCount: 0,
            recentCandidateCount: 0,
            lastError: null
        };
        await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
        startedNewRun = true;
    }
    const runDirectory = Path.join(outputDirectory, 'runs', state.runId);
    const resultsPath = Path.join(runDirectory, 'results.jsonl');
    const results = await loadRunResults(resultsPath, state.runId);
    const cachePath = Path.join(outputDirectory, 'ban-cache.jsonl');
    const cache = cacheHours > 0 ? await loadBanCache(cachePath, cacheMaxAgeMs, nowMs()) :
        Object.freeze({ results: new Map(), lineCount: 0 });
    let cacheLineCount = cache.lineCount;
    if (cacheHours > 0) {
        const repair = [...results.values()].filter(value => nowMs() - Date.parse(value.checkedAt) <= cacheMaxAgeMs &&
            (!cache.results.has(value.steamId) || cache.results.get(value.steamId).checkedAt < value.checkedAt));
        if (repair.length > 0) {
            await appendJsonl(cachePath, repair);
            cacheLineCount += repair.length;
        }
        for (const value of repair) cache.results.set(value.steamId, value);
    }
    if (!ignoreCache) {
        const selectedIds = new Set(selected.map(row => row.steamId));
        for (const [id, value] of cache.results) {
            if (selectedIds.has(id) && !results.has(id)) results.set(id, value);
        }
    }
    const waitForRequest = requestGate(delayMs, nowMs, sleepImpl);
    const stopRequested = options.stopRequested || (() => false);
    let cursor = 0;

    /** @param {string|null} [lastError] */
    const saveState = async (lastError = null) => {
        state.checkedIdentityCount = Math.min(results.size, selected.length);
        state.recentCandidateCount = buildMatches(selected, results, days).length;
        state.updatedAt = now().toISOString();
        state.requestPolicy = requestPolicy;
        state.lastError = lastError;
        await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
    };

    if (startedNewRun) {
        await writeReports(outputDirectory, buildMatches(selected, results, days));
        await saveState(null);
    }

    while (!stopRequested()) {
        /** @type {any[]} */
        const batch = [];
        while (cursor < selected.length && batch.length < batchSize) {
            const identity = selected[cursor++];
            if (!results.has(identity.steamId)) batch.push(identity);
        }
        if (batch.length === 0) break;
        let bans;
        try {
            bans = await withRetries(async () => {
                await waitForRequest();
                return options.client.getPlayerBans(batch.map(row => row.steamId));
            }, {
                attempts: 5,
                sleep: sleepImpl,
                onRetry: value => options.onRetry?.({ provider: 'steam', operation: 'player-bans', ...value })
            });
        }
        catch (error) {
            await saveState(error instanceof Error ? error.message : 'Steam Web API failure.');
            throw error;
        }
        const recentIds = bans.filter((/** @type {any} */ value) =>
            value.numberOfGameBans > 0 && value.daysSinceLastBan < days)
        .map((/** @type {any} */ value) => value.steamId);
        const summaries = new Map();
        let summaryAvailable = true;
        if (recentIds.length > 0) {
            try {
                for (const value of await withRetries(async () => {
                    await waitForRequest();
                    return options.client.getPlayerSummaries(recentIds);
                }, {
                    attempts: 3,
                    sleep: sleepImpl,
                    onRetry: value => options.onRetry?.({ provider: 'steam', operation: 'player-summaries', ...value })
                })) summaries.set(value.steamId, value);
            }
            catch {
                summaryAvailable = false;
            }
        }
        const playtimes = new Map();
        for (const id of recentIds) {
            try {
                playtimes.set(id, await withRetries(async () => {
                    await waitForRequest();
                    return options.client.getRustPlaytimeMinutes(id);
                }, {
                    attempts: 2,
                    sleep: sleepImpl,
                    onRetry: value => options.onRetry?.({ provider: 'steam', operation: 'rust-playtime', ...value })
                }));
            }
            catch {
                playtimes.set(id, null);
            }
        }
        const checkedAt = now().toISOString();
        const additions = bans.map((/** @type {any} */ value) => {
            const summary = summaries.get(value.steamId) || null;
            const recent = recentIds.includes(value.steamId);
            return Object.freeze({
                schemaVersion: RESULT_SCHEMA_VERSION,
                runId: state.runId,
                checkedAt,
                ...value,
                profileUrl: summary?.profileUrl || `https://steamcommunity.com/profiles/${value.steamId}/`,
                steamName: summary?.personaName || null,
                steamRustMinutes: recent ? (playtimes.get(value.steamId) ?? null) : null,
                steamEnrichment: recent ?
                    (summaryAvailable && playtimes.has(value.steamId) ? 'attempted' : 'partial') : 'not-requested'
            });
        });
        await appendJsonl(resultsPath, additions);
        if (cacheHours > 0) {
            await appendJsonl(cachePath, additions);
            cacheLineCount += additions.length;
        }
        for (const value of additions) results.set(value.steamId, value);
        for (const value of additions) cache.results.set(value.steamId, value);
        const matches = buildMatches(selected, results, days);
        await writeReports(outputDirectory, matches);
        await saveState(null);
        const addedIds = new Set(additions.map((/** @type {any} */ value) => value.steamId));
        for (const match of matches) {
            if (addedIds.has(match.steamId)) options.onMatch?.(match);
        }
        options.onProgress?.(Object.freeze({
            runId: state.runId,
            checked: state.checkedIdentityCount,
            total: selected.length,
            matches: matches.length
        }));
    }
    const remaining = selected.some(row => !results.has(row.steamId));
    if (!remaining) {
        state.completedAt = now().toISOString();
        await saveState(null);
        if (cacheHours > 0 && (cacheLineCount > cache.results.size * 2 + 1000 || options.force === true)) {
            const compact = [...cache.results.values()].sort((left, right) =>
                left.steamId.localeCompare(right.steamId)).map(value => JSON.stringify(value)).join('\n');
            await atomicWrite(cachePath, compact ? `${compact}\n` : '');
        }
    }
    const matches = buildMatches(selected, results, days);
    await writeReports(outputDirectory, matches);
    return Object.freeze({
        runId: state.runId,
        checked: state.checkedIdentityCount,
        total: selected.length,
        matches: matches.length,
        completed: !remaining,
        stopped: remaining && stopRequested(),
        reportCsv: Path.join(outputDirectory, 'recent-game-bans.csv'),
        reportJsonl: Path.join(outputDirectory, 'recent-game-bans.jsonl')
    });
}

module.exports = Object.freeze({
    DEFAULT_CACHE_HOURS,
    RESULT_SCHEMA_VERSION,
    STATE_SCHEMA_VERSION,
    approximateBanDate,
    buildMatches,
    loadBanCache,
    loadSnapshot,
    reportCsv,
    scan,
    withRetries,
    writeReports
});
