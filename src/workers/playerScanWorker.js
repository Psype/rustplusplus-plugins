// @ts-check
/* Read-only planner for player-intelligence scans. Durable mutations are returned to, validated and committed by parent. */

const Performance = require('node:perf_hooks').performance;

const Core = require('../plugins/playerIntelligence/index.js');
const ScanDaemon = require('../plugins/playerIntelligence/scanDaemon.js');
const Ipc = require('./playerScanIpc.js');

let nextCallId = 1;
let running = false;
const providerCalls = new Map();
const MAX_REPORTED_MEMORY_MIB = 4096;

/** @param {unknown} error */
function safeError(error) {
    const message = error instanceof Error ? error.message : `${error || 'unknown error'}`;
    return message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300) ||
        'unknown error';
}

/** @param {any} message */
function send(message) {
    Ipc.send(process, message);
}

/** @param {number} bytes */
function memoryMiB(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(MAX_REPORTED_MEMORY_MIB, Math.round(value / (1024 * 1024)));
}

/** @param {string} stage */
function reportProgress(stage) {
    let memory = {};
    try { memory = process.memoryUsage(); }
    catch (_error) { /* Progress is diagnostic-only and must never affect the scan. */ }
    send({
        v: 1,
        type: 'progress',
        stage,
        rssMiB: memoryMiB(/** @type {any} */ (memory).rss),
        heapUsedMiB: memoryMiB(/** @type {any} */ (memory).heapUsed)
    });
}

/** @param {string} provider @param {string} method @param {any[]} args */
function providerRequest(provider, method, args) {
    const callId = nextCallId++;
    return Ipc.request(process, providerCalls,
        { v: 1, type: 'provider_request', callId, provider, method, args });
}

/** @param {any} payload */
function optionsFrom(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.directory !== 'string' ||
        !payload.context || typeof payload.context.guildId !== 'string' || !payload.scope ||
        typeof payload.scope.wipeId !== 'string' || typeof payload.now !== 'string' ||
        Number.isNaN(Date.parse(payload.now)) || !payload.providers || typeof payload.providers !== 'object') {
        throw new TypeError('Player scan worker payload is invalid.');
    }
    const diskStore = new Core.JsonlHistoryStore({ directory: payload.directory });
    const readOnlyStore = Object.freeze({
        directory: diskStore.directory,
        readAll: () => diskStore.readAll(),
        readSnapshot: () => diskStore.readSnapshot()
    });
    const context = {
        guildId: payload.context.guildId,
        rustplus: {
            log: (/** @type {unknown} */ _category, /** @type {unknown} */ message) =>
                send({ v: 1, type: 'warning', message: safeError(message) })
        }
    };
    /** @type {any} */
    const dependencies = {
        now: () => new Date(payload.now),
        monotonicNow: () => Performance.now(),
        scanProgress: reportProgress
    };
    if (payload.providers.steamProfileIdentity === true) {
        dependencies.steamProfileIdentity = (/** @type {string} */ steamId) =>
            providerRequest('steam', 'profileIdentity', [steamId]);
    }
    if (payload.providers.battlemetricsResolveSteamId === true) {
        dependencies.battlemetricsProvider = Object.freeze({
            resolveSteamId: (/** @type {string} */ battlemetricsPlayerId) =>
                providerRequest('battlemetrics', 'resolveSteamId', [battlemetricsPlayerId])
        });
    }
    /** @type {any} */
    const warBanditsProvider = {};
    if (payload.providers.warBanditsResolvePlayerRecent === true) {
        warBanditsProvider.resolvePlayerRecent = (/** @type {unknown} */ _context,
            /** @type {unknown} */ _scope, /** @type {string} */ query) =>
            providerRequest('warbandits', 'resolvePlayerRecent', [query]);
    }
    if (payload.providers.warBanditsResolvePlayer === true) {
        warBanditsProvider.resolvePlayer = (/** @type {unknown} */ _context,
            /** @type {unknown} */ _scope, /** @type {string} */ query) =>
            providerRequest('warbandits', 'resolvePlayer', [query]);
    }
    if (payload.providers.warBanditsScanCurrentWipePage === true) {
        warBanditsProvider.scanCurrentWipePage = (/** @type {unknown} */ _context,
            /** @type {unknown} */ _scope, /** @type {number} */ page) =>
            providerRequest('warbandits', 'scanCurrentWipePage', [page]);
    }
    return {
        context,
        scope: payload.scope,
        stableIdentityCandidates: Array.isArray(payload.stableIdentityCandidates) ?
            payload.stableIdentityCandidates : [],
        store: readOnlyStore,
        directory: diskStore.directory,
        dependencies,
        warBanditsProvider: Object.keys(warBanditsProvider).length > 0 ? Object.freeze(warBanditsProvider) : null,
        forceWarBanditsRescan: payload.forceWarBanditsRescan === true,
        planOnly: true
    };
}

/** @param {any} payload */
async function run(payload) {
    if (running) throw new Error('Player scan worker already has an active request.');
    running = true;
    reportProgress('initializing');
    try { return await ScanDaemon.runCycle(optionsFrom(payload)); }
    finally { running = false; }
}

process.on('message', rawMessage => {
    if (!rawMessage || typeof rawMessage !== 'object') return;
    const message = /** @type {any} */ (rawMessage);
    if (message.v !== 1) return;
    if (message.type === 'provider_response' && Number.isSafeInteger(message.callId)) {
        const call = providerCalls.get(message.callId);
        if (!call) return;
        providerCalls.delete(message.callId);
        if (message.ok === true) call.resolve(message.result);
        else call.reject(new Error(safeError(message.error)));
        return;
    }
    if (message.type !== 'run') return;
    void run(message.payload).then(plan => {
        reportProgress('sending_result');
        Ipc.sendPlan(process, plan);
    }).catch(error => {
        Ipc.sendFinal(process, { v: 1, type: 'failure',
            code: `${error && error.code || 'SCAN_FAILED'}`.slice(0, 64), message: safeError(error) });
    });
});

process.on('disconnect', () => {
    for (const call of providerCalls.values()) call.reject(new Error('Player scan parent disconnected.'));
    providerCalls.clear();
    // Preserve the dedicated non-zero exit selected when the final IPC callback reports failed delivery.
    if (process.exitCode === undefined || process.exitCode === null) process.exitCode = 0;
});
