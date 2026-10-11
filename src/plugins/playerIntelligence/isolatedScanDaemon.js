// @ts-check
/*
 * Process boundary for the expensive player-intelligence scan. The worker may read the journal and call
 * providers through RPC, but the parent remains the only process allowed to append events or replace scan state.
 */

const ChildProcess = require('node:child_process');
const Path = require('node:path');

const WORKER_PATH = Path.join(__dirname, '..', '..', 'workers', 'playerScanWorker.js');
const WORKER_TIMEOUT_MS = 4 * 60 * 1000;
const configuredHeapMiB = Number(process.env.RPP_PLAYER_SCAN_WORKER_HEAP_MIB);
const WORKER_HEAP_MIB = Number.isSafeInteger(configuredHeapMiB) && configuredHeapMiB >= 512 &&
    configuredHeapMiB <= 2048 ? configuredHeapMiB : 1536;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_REQUEST_BYTES = 4 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_CONCURRENT_WORKERS = 1;
const MAX_PENDING_WORKERS = 32;
const MAX_BATTLEMETRICS_PLAYERS = 20000;
const EMPTY_DEPENDENCIES = Object.freeze({});

/** @typedef {{resolve:(value:any)=>void,reject:(reason?:any)=>void}} ScanWaiter */
/** @typedef {{forkImpl?:Function,timeoutMs?:number}} ScanAdapters */
/** @typedef {{key:string,resolveOptions:(forced:boolean)=>any|null,forced:boolean,adapters:ScanAdapters,
 * waiters:ScanWaiter[],done?:Promise<void>,finish?:()=>void}} ScanJob */

const workers = new Set();
/** @type {ScanJob[]} */
const pendingJobs = [];
/** @type {Map<string,ScanJob>} */
const pendingByKey = new Map();
const reapPromises = new WeakMap();
const errorGuards = new WeakMap();
/** @type {ScanJob|null} */
let activeJob = null;
let stopping = false;
/** @type {Promise<void>|null} */
let shutdownPromise = null;
let completed = 0;
let failures = 0;
let stalePlans = 0;

/** @param {number} value */
function increment(value) {
    return Math.min(MAX_COUNTER, value + 1);
}

class IsolatedScanError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'IsolatedScanError';
        this.code = code;
    }
}

/** @param {unknown} error */
function safeError(error) {
    const message = error instanceof Error ? error.message : `${error || 'unknown error'}`;
    return message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300) ||
        'unknown error';
}

/** @param {unknown} value */
function byteLength(value) {
    try { return Buffer.byteLength(JSON.stringify(value)); }
    catch (_error) { return Number.POSITIVE_INFINITY; }
}

/** @param {unknown} value @param {number} maxBytes @param {string} code @param {string} message */
function jsonClone(value, maxBytes, code, message) {
    const text = JSON.stringify(value);
    if (text === undefined || Buffer.byteLength(text) > maxBytes) {
        throw new IsolatedScanError(code, message);
    }
    return JSON.parse(text);
}

/** @param {unknown} value */
function scalar(value) {
    return typeof value === 'string' || typeof value === 'number' ? `${value}` : null;
}

/**
 * Explicitly project the mutable Rust+/BattleMetrics runtime object into the only fields used by the planner.
 * This both bounds IPC and makes circular framework instances irrelevant.
 * @param {any} input
 */
function scopeForWorker(input) {
    const source = input && typeof input === 'object' ? input : {};
    const battlemetricsSource = source.battlemetrics && typeof source.battlemetrics === 'object' ?
        source.battlemetrics : {};
    /** @type {Record<string,{id:string,name:string,status:boolean}>} */
    const players = {};
    const rawPlayers = battlemetricsSource.players && typeof battlemetricsSource.players === 'object' ?
        battlemetricsSource.players : {};
    let playerCount = 0;
    for (const key in rawPlayers) {
        if (!Object.hasOwn(rawPlayers, key)) continue;
        if (playerCount >= MAX_BATTLEMETRICS_PLAYERS) break;
        playerCount += 1;
        const raw = rawPlayers[key];
        if (!raw || typeof raw !== 'object') continue;
        const player = /** @type {any} */ (raw);
        const id = scalar(player.id) || scalar(key);
        const name = typeof player.name === 'string' ? player.name.slice(0, 128) : '';
        if (!id || !/^\d{1,32}$/u.test(id) || !name || typeof player.status !== 'boolean') continue;
        players[id] = { id, name, status: player.status };
    }
    let onlinePlayers = null;
    if (Array.isArray(battlemetricsSource.onlinePlayers)) {
        onlinePlayers = [];
        const uniqueOnline = new Set();
        const inspectionLimit = Math.min(battlemetricsSource.onlinePlayers.length, MAX_BATTLEMETRICS_PLAYERS);
        for (let index = 0; index < inspectionLimit; index += 1) {
            const value = scalar(battlemetricsSource.onlinePlayers[index]);
            if (!value || !/^\d{1,32}$/u.test(value) || uniqueOnline.has(value)) continue;
            uniqueOnline.add(value);
            onlinePlayers.push(value);
        }
    }
    const serverSource = source.server && typeof source.server === 'object' ? source.server : {};
    const minimal = {
        serverKey: scalar(source.serverKey),
        wipeId: scalar(source.wipeId),
        wipeStart: scalar(source.wipeStart),
        battlemetricsId: scalar(source.battlemetricsId),
        hostname: scalar(source.hostname),
        serverHostname: scalar(source.serverHostname),
        serverIp: scalar(source.serverIp),
        server: {
            battlemetricsId: scalar(serverSource.battlemetricsId),
            hostname: scalar(serverSource.hostname),
            serverIp: scalar(serverSource.serverIp)
        },
        battlemetrics: {
            lastUpdateSuccessful: battlemetricsSource.lastUpdateSuccessful === true,
            streamerMode: battlemetricsSource.streamerMode === true,
            updatedAt: scalar(battlemetricsSource.updatedAt),
            onlinePlayers,
            players
        }
    };
    if (!minimal.serverKey || !minimal.wipeId) throw new TypeError('Player scan worker scope is invalid.');
    return minimal;
}

/**
 * Queue tickets must not pin a Discord client or a BattleMetrics player table. The normal scheduler owns
 * those objects for the lifetime of the returned promise; the supervisor keeps only weak resolvers plus
 * the small journal writer handle and scalar flags until dispatch.
 * @param {any} options
 */
function queuedOptionsResolver(options) {
    if (!options.context || typeof options.context !== 'object' ||
        !options.scope || typeof options.scope !== 'object') {
        throw new TypeError('Player scan isolation context is invalid.');
    }
    const context = new WeakRef(options.context);
    const scope = new WeakRef(options.scope);
    const dependenciesValue = options.dependencies && typeof options.dependencies === 'object' ?
        options.dependencies : null;
    const dependencies = dependenciesValue ? new WeakRef(dependenciesValue) : null;
    const providerValue = options.warBanditsProvider && typeof options.warBanditsProvider === 'object' ?
        options.warBanditsProvider : null;
    const provider = providerValue ? new WeakRef(providerValue) : null;
    const resolveCurrentScope = typeof options.resolveCurrentScope === 'function' ?
        options.resolveCurrentScope : null;
    const directory = Path.resolve(options.directory);
    const store = options.store;
    return (/** @type {boolean} */ forced) => {
        const resolvedContext = context.deref();
        const resolvedScope = scope.deref();
        const resolvedDependencies = dependencies ? dependencies.deref() : EMPTY_DEPENDENCIES;
        if (!resolvedContext || !resolvedScope || !resolvedDependencies) return null;
        let currentScope = resolvedScope;
        if (resolveCurrentScope) {
            try { currentScope = resolveCurrentScope(resolvedContext); }
            catch (_error) { return null; }
            // A server switch implies another journal directory. A wipe switch on the same server is
            // safe only after replacing the stale queued scope with this freshly derived one.
            if (!currentScope || !currentScope.wipeId || currentScope.serverKey !== resolvedScope.serverKey) {
                return null;
            }
        }
        return Object.freeze({
            context: resolvedContext,
            scope: currentScope,
            store,
            directory,
            dependencies: resolvedDependencies,
            warBanditsProvider: provider ? provider.deref() || null : null,
            resolveCurrentScope,
            forceWarBanditsRescan: forced
        });
    };
}

/** @param {any} options */
function payloadFor(options) {
    const dependencies = options.dependencies || {};
    const clockValue = (dependencies.now || (() => new Date()))();
    const now = clockValue instanceof Date ? clockValue : new Date(clockValue);
    if (Number.isNaN(now.getTime())) throw new TypeError('Player scan worker clock is invalid.');
    const battlemetrics = dependencies.battlemetricsProvider;
    const warBandits = options.warBanditsProvider;
    return jsonClone({
        directory: Path.resolve(options.directory),
        context: { guildId: `${options.context.guildId}` },
        scope: scopeForWorker(options.scope),
        forceWarBanditsRescan: options.forceWarBanditsRescan === true,
        now: now.toISOString(),
        providers: {
            steamProfileIdentity: typeof dependencies.steamProfileIdentity === 'function',
            battlemetricsResolveSteamId: Boolean(battlemetrics &&
                typeof battlemetrics.resolveSteamId === 'function'),
            warBanditsResolvePlayerRecent: Boolean(warBandits &&
                typeof warBandits.resolvePlayerRecent === 'function'),
            warBanditsResolvePlayer: Boolean(warBandits && typeof warBandits.resolvePlayer === 'function'),
            warBanditsScanCurrentWipePage: Boolean(warBandits &&
                typeof warBandits.scanCurrentWipePage === 'function')
        }
    }, MAX_REQUEST_BYTES, 'REQUEST_TOO_LARGE', 'Player scan worker request exceeded its limit.');
}

/** @param {any} options @param {any} message */
async function callProvider(options, message) {
    const dependencies = options.dependencies || {};
    const args = Array.isArray(message.args) ? message.args : [];
    if (message.provider === 'steam' && message.method === 'profileIdentity' &&
        typeof dependencies.steamProfileIdentity === 'function') {
        return dependencies.steamProfileIdentity(`${args[0] || ''}`);
    }
    if (message.provider === 'battlemetrics' && message.method === 'resolveSteamId' &&
        dependencies.battlemetricsProvider &&
        typeof dependencies.battlemetricsProvider.resolveSteamId === 'function') {
        return dependencies.battlemetricsProvider.resolveSteamId(`${args[0] || ''}`, dependencies);
    }
    const provider = options.warBanditsProvider;
    if (message.provider === 'warbandits' && provider) {
        if (message.method === 'resolvePlayerRecent' && typeof provider.resolvePlayerRecent === 'function') {
            return provider.resolvePlayerRecent(options.context, options.scope, args[0]);
        }
        if (message.method === 'resolvePlayer' && typeof provider.resolvePlayer === 'function') {
            return provider.resolvePlayer(options.context, options.scope, args[0]);
        }
        if (message.method === 'scanCurrentWipePage' && typeof provider.scanCurrentWipePage === 'function') {
            return provider.scanCurrentWipePage(options.context, options.scope, args[0]);
        }
    }
    throw new IsolatedScanError('PROVIDER_UNAVAILABLE',
        `Player scan provider method ${message.provider}.${message.method} is unavailable.`);
}

/** @param {any} options @param {string} message */
function logWarning(options, message) {
    if (options.context && options.context.rustplus && typeof options.context.rustplus.log === 'function') {
        options.context.rustplus.log('PLAYER_INTELLIGENCE', message, 'warn');
    }
    else if (options.context && options.context.client && typeof options.context.client.log === 'function') {
        options.context.client.log('PLAYER_INTELLIGENCE', message, 'warn');
    }
}

/** @param {any} child @param {any} message */
function send(child, message) {
    if (!child.connected) return;
    try { child.send(message, () => undefined); }
    catch (_error) { /* Worker exit/timeout is handled by its lifecycle listeners. */ }
}

/** @param {any} child */
function reapChild(child) {
    if (reapPromises.has(child)) return reapPromises.get(child);
    const promise = new Promise(resolve => {
        const guard = errorGuards.get(child) || (() => undefined);
        if (!errorGuards.has(child)) {
            errorGuards.set(child, guard);
            child.on('error', guard);
        }
        /** @type {NodeJS.Timeout|null} */
        let forceTimer = null;
        /** @type {NodeJS.Timeout|null} */
        let giveUpTimer = null;
        let finished = false;
        /** @param {boolean} [reaped] */
        const done = (reaped = true) => {
            if (finished) return;
            finished = true;
            if (forceTimer) clearTimeout(forceTimer);
            if (giveUpTimer) clearTimeout(giveUpTimer);
            if (reaped) {
                child.removeListener('exit', onExit);
                child.removeListener('error', guard);
                errorGuards.delete(child);
            }
            resolve(undefined);
        };
        const onExit = () => {
            if (finished) {
                child.removeListener('error', guard);
                errorGuards.delete(child);
                return;
            }
            done(true);
        };
        if (child.exitCode !== null || child.signalCode !== null) {
            done();
            return;
        }
        child.once('exit', onExit);
        forceTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); }
            catch (_error) { /* The final guard below still bounds shutdown. */ }
        }, 2000);
        // Bound shutdown even for a broken ChildProcess implementation, while retaining the error guard
        // until a late exit so a post-kill error cannot become an uncaught process error.
        giveUpTimer = setTimeout(() => done(false), 4000);
        if (forceTimer && typeof forceTimer.unref === 'function') forceTimer.unref();
        if (giveUpTimer && typeof giveUpTimer.unref === 'function') giveUpTimer.unref();
        try { child.kill('SIGTERM'); }
        catch (_error) { done(); }
    });
    reapPromises.set(child, promise);
    return promise;
}

/** @param {any} options @param {{forkImpl?:Function,timeoutMs?:number}} adapters */
async function executeCycle(options, adapters) {
    const payload = payloadFor(options);
    const forkImpl = adapters.forkImpl || ChildProcess.fork;
    const timeoutMs = Number.isSafeInteger(adapters.timeoutMs) ? adapters.timeoutMs : WORKER_TIMEOUT_MS;
    let child;
    try {
        child = forkImpl(WORKER_PATH, [], /** @type {any} */ ({
            execArgv: [`--max-old-space-size=${WORKER_HEAP_MIB}`],
            serialization: 'json',
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            windowsHide: true
        }));
    }
    catch (error) {
        failures = increment(failures);
        throw new IsolatedScanError('WORKER_SPAWN_FAILED',
            `Player scan worker could not start: ${safeError(error)}.`);
    }
    const errorGuard = () => undefined;
    errorGuards.set(child, errorGuard);
    child.on('error', errorGuard);
    workers.add(child);
    let settled = false;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;

    try {
        const plan = await new Promise((resolve, reject) => {
            const onMessage = (/** @type {any} */ rawMessage) => {
                if (!rawMessage || typeof rawMessage !== 'object') return;
                const message = /** @type {any} */ (rawMessage);
                if (message.v !== 1) return;
                if (message.type === 'warning') {
                    logWarning(options, safeError(message.message));
                    return;
                }
                if (message.type === 'provider_request' && Number.isSafeInteger(message.callId)) {
                    if (byteLength(message) > MAX_PROVIDER_REQUEST_BYTES) {
                        send(child, { v: 1, type: 'provider_response', callId: message.callId,
                            ok: false, error: 'Player scan provider request exceeded its limit.' });
                        return;
                    }
                    Promise.resolve().then(() => callProvider(options, message)).then(result => {
                        send(child, { v: 1, type: 'provider_response', callId: message.callId,
                            ok: true, result: jsonClone(result, MAX_PROVIDER_RESPONSE_BYTES,
                                'PROVIDER_RESPONSE_TOO_LARGE',
                                'Player scan provider response exceeded its limit.') });
                    }).catch(error => {
                        send(child, { v: 1, type: 'provider_response', callId: message.callId,
                            ok: false, error: safeError(error) });
                    });
                    return;
                }
                if (message.type === 'result') {
                    if (byteLength(message.plan) > MAX_PLAN_BYTES) {
                        finish(new IsolatedScanError('PLAN_TOO_LARGE',
                            'Player scan worker plan exceeded its limit.'));
                    }
                    else finish(null, message.plan);
                    return;
                }
                if (message.type === 'failure') {
                    finish(new IsolatedScanError(`${message.code || 'WORKER_FAILURE'}`.slice(0, 64),
                        `Player scan worker failed: ${safeError(message.message)}`));
                }
            };
            const onError = (/** @type {unknown} */ error) => finish(new IsolatedScanError('WORKER_ERROR',
                `Player scan worker error: ${safeError(error)}`));
            const onExit = (/** @type {number|null} */ code, /** @type {string|null} */ signal) =>
                finish(new IsolatedScanError('WORKER_EXITED',
                    `Player scan worker stopped before commit: exit=${code ?? '-'} signal=${signal || '-'}.`));
            const finish = (/** @type {Error|null} */ error, /** @type {any} */ value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                child.removeListener('message', onMessage);
                child.removeListener('error', onError);
                child.removeListener('exit', onExit);
                if (error) reject(error);
                else resolve(value);
            };
            child.on('message', onMessage);
            child.once('error', onError);
            child.once('exit', onExit);
            timer = setTimeout(() => {
                finish(new IsolatedScanError('WORKER_TIMEOUT', 'Player scan worker timed out safely.'));
            }, timeoutMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
            send(child, { v: 1, type: 'run', payload });
        });
        // The planner is deliberately one-shot: release its projection heap before committing in the parent.
        await reapChild(child);
        // Lazy loading prevents the worker supervisor from creating a scan-daemon module cycle.
        const ScanDaemon = require('./scanDaemon.js');
        const result = await ScanDaemon.commitPlan(options, plan);
        completed = increment(completed);
        return result;
    }
    catch (error) {
        if (error && /** @type {any} */ (error).code === 'STALE_SCAN_PLAN') stalePlans = increment(stalePlans);
        else failures = increment(failures);
        throw error;
    }
    finally {
        await reapChild(child);
        workers.delete(child);
    }
}

function drain() {
    if (stopping || activeJob || pendingJobs.length === 0) return;
    const job = pendingJobs.shift();
    if (!job) return;
    pendingByKey.delete(job.key);
    startJob(job);
}

/** @param {ScanJob} job */
function startJob(job) {
    activeJob = job;
    job.done = new Promise(resolve => { job.finish = resolve; });
    const options = job.resolveOptions(job.forced);
    if (!options) {
        finishJob(job, new IsolatedScanError('WORKER_OPTIONS_EXPIRED',
            'Player scan inputs expired while waiting; a future scan can retry safely.'), null);
        return;
    }
    void executeCycle(options, job.adapters).then(result => finishJob(job, null, result),
        error => finishJob(job, error, null));
}

/** @param {ScanJob} job @param {unknown} error @param {any} result */
function finishJob(job, error, result) {
    if (activeJob === job) activeJob = null;
    drain();
    for (const waiter of job.waiters) {
        if (error) waiter.reject(error);
        else waiter.resolve(result);
    }
    if (job.finish) job.finish();
    job.finish = undefined;
}

/** @param {any} options @param {{forkImpl?:Function,timeoutMs?:number}} [adapters] */
function runCycle(options, adapters = {}) {
    if (!options || typeof options.directory !== 'string' || !options.scope || !options.scope.wipeId ||
        !options.store) throw new TypeError('Player scan isolation options are invalid.');
    if (typeof options.store.directory === 'string' &&
        Path.resolve(options.store.directory) !== Path.resolve(options.directory)) {
        throw new TypeError('Player scan journal and checkpoint directories must match.');
    }
    if (stopping) throw new IsolatedScanError('SERVICE_STOPPED', 'Player scan worker service is stopping.');
    const key = Path.resolve(options.directory);
    const existing = pendingByKey.get(key);
    if (existing) {
        if (existing.waiters.length >= 32) {
            throw new IsolatedScanError('WORKER_QUEUE_FULL', 'Player scan worker coalescing limit was reached.');
        }
        existing.forced = existing.forced || options.forceWarBanditsRescan === true;
        existing.resolveOptions = queuedOptionsResolver(options);
        existing.adapters = adapters;
        return new Promise((resolve, reject) => existing.waiters.push({ resolve, reject }));
    }
    if (activeJob && pendingJobs.length >= MAX_PENDING_WORKERS) {
        failures = increment(failures);
        throw new IsolatedScanError('WORKER_QUEUE_FULL', 'Player scan worker queue is full.');
    }
    const job = /** @type {ScanJob} */ ({ key, resolveOptions: queuedOptionsResolver(options),
        forced: options.forceWarBanditsRescan === true, adapters, waiters: [] });
    const promise = new Promise((resolve, reject) => job.waiters.push({ resolve, reject }));
    if (activeJob) {
        pendingJobs.push(job);
        pendingByKey.set(key, job);
    }
    else startJob(job);
    return promise;
}

function getRuntimeStatus() {
    return Object.freeze({ active: workers.size, queued: pendingJobs.length, completed, failures, stalePlans });
}

function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    const error = new IsolatedScanError('SERVICE_STOPPED', 'Player scan worker service is stopping.');
    while (pendingJobs.length > 0) {
        const job = pendingJobs.shift();
        if (!job) break;
        pendingByKey.delete(job.key);
        for (const waiter of job.waiters) waiter.reject(error);
    }
    // Reaping a one-shot child is not enough: executeCycle may already be applying its validated plan
    // in the parent. Wait for finishJob too, so process shutdown cannot cut a journal/checkpoint commit.
    const activeDone = activeJob && activeJob.done ? activeJob.done : Promise.resolve();
    shutdownPromise = Promise.allSettled([...workers].map(reapChild))
        .then(() => activeDone)
        .then(() => undefined);
    return shutdownPromise;
}

module.exports = Object.freeze({
    IsolatedScanError,
    MAX_CONCURRENT_WORKERS,
    MAX_PENDING_WORKERS,
    MAX_PLAN_BYTES,
    MAX_PROVIDER_REQUEST_BYTES,
    MAX_PROVIDER_RESPONSE_BYTES,
    MAX_REQUEST_BYTES,
    WORKER_HEAP_MIB,
    WORKER_TIMEOUT_MS,
    getRuntimeStatus,
    runCycle,
    shutdown
});
