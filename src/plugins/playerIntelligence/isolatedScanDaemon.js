// @ts-check
/*
 * Process boundary for the expensive player-intelligence scan. The worker may read the journal and call
 * providers through RPC, but the parent remains the only process allowed to append events or replace scan state.
 */

const ChildProcess = require('node:child_process');
const Crypto = require('node:crypto');
const Path = require('node:path');
const BoundedTtlCache = require('../../util/boundedTtlCache.js');
const PlayerScanIpc = require('../../workers/playerScanIpc.js');
const PlayerScanProviderResponses = require('../../workers/playerScanProviderResponses.js');

const WORKER_PATH = Path.join(__dirname, '..', '..', 'workers', 'playerScanWorker.js');
const WORKER_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_PROVIDER_CALL_TIMEOUT_MS = 45000;
const configuredProviderTimeoutMs = Number(process.env.RPP_PLAYER_SCAN_PROVIDER_TIMEOUT_MS);
const PROVIDER_CALL_TIMEOUT_MS = Number.isSafeInteger(configuredProviderTimeoutMs) &&
    configuredProviderTimeoutMs >= 1000 && configuredProviderTimeoutMs <= MAX_PROVIDER_CALL_TIMEOUT_MS ?
    configuredProviderTimeoutMs : 30000;
const configuredHeapMiB = Number(process.env.RPP_PLAYER_SCAN_WORKER_HEAP_MIB);
const WORKER_HEAP_MIB = Number.isSafeInteger(configuredHeapMiB) && configuredHeapMiB >= 512 &&
    configuredHeapMiB <= 2048 ? configuredHeapMiB : 1536;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PLAN_BYTES = PlayerScanIpc.MAX_PLAN_BYTES;
const MAX_PROVIDER_REQUEST_BYTES = 4 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_WORKER_MEMORY_MIB = 4096;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const MAX_CONCURRENT_WORKERS = 1;
const MAX_PENDING_WORKERS = 8;
const MAX_STABLE_IDENTITY_CANDIDATES = 12048;
// Eight queued jobs retain at most 96 MiB of projected candidate strings in aggregate; no caller-owned object
// survives admission and accepted 10k-row CSV histories fit without silent truncation.
const MAX_STABLE_IDENTITY_CANDIDATE_BYTES = 12 * 1024 * 1024;
const MAX_IN_FLIGHT_PROVIDER_CALLS = 4;
const MAX_OUTSTANDING_PROVIDER_INVOCATIONS = 8;
const MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER = 4;
const MAX_BATTLEMETRICS_PLAYERS = 20000;
const PARENT_WARNING_TTL_MS = 60 * 60 * 1000;
const PARENT_WARNING_MAX_ENTRIES = 256;
const EMPTY_DEPENDENCIES = Object.freeze({});
/** @type {readonly any[]} */
const EMPTY_STABLE_IDENTITY_CANDIDATES = Object.freeze([]);
const parentWarningTimes = BoundedTtlCache.createBoundedTtlCache({
    maxEntries: PARENT_WARNING_MAX_ENTRIES, defaultTtlMs: PARENT_WARNING_TTL_MS
});
const WORKER_PROGRESS_STAGES = new Set([
    'initializing', 'reading_state', 'reading_history', 'rebuilding', 'reconciling',
    'steam_profiles', 'online_players', 'warbandits', 'finalizing', 'sending_result'
]);

/** @typedef {{resolve:(value:any)=>void,reject:(reason?:any)=>void}} ScanWaiter */
/** @typedef {{forkImpl?:Function,timeoutMs?:number,providerTimeoutMs?:number}} ScanAdapters */
/** @typedef {{key:string,resolveOptions:(forced:boolean)=>any|null,forced:boolean,adapters:ScanAdapters,
 * waiters:ScanWaiter[],done?:Promise<void>,finish?:()=>void}} ScanJob */
/** @typedef {{active:boolean,callId:number,provider:string|null,requestProvider:string|null,
 * method:string|null,requestedArg:unknown,target:WeakRef<any>|null,
 * timer:NodeJS.Timeout|null,remove:(()=>void)|null,sendFailure:(()=>void)|null}} ProviderCall */

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
let consecutiveFailures = 0;
let currentStage = 'idle';
let workerRssMiB = 0;
let workerHeapUsedMiB = 0;
let outstandingProviderInvocations = 0;
/** @type {Map<string,number>} */
const outstandingProviderInvocationsByProvider = new Map();
/** @type {string|null} */
let lastCode = null;
/** @type {string|null} */
let lastMessage = null;
/** @type {string|null} */
let lastAt = null;
/** @type {string|null} */
let lastStage = null;

/** @param {number} value */
function increment(value) {
    return Math.min(MAX_COUNTER, value + 1);
}

class IsolatedScanError extends Error {
    /** @param {string} code @param {string} message @param {string|null} [diagnostic] */
    constructor(code, message, diagnostic = null) {
        super(message);
        this.name = 'IsolatedScanError';
        this.code = code;
        this.diagnostic = diagnostic;
    }
}

/** @param {unknown} error */
function safeError(error) {
    const message = error instanceof Error ? error.message : `${error || 'unknown error'}`;
    return message.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300) ||
        'unknown error';
}

/**
 * stderr is deliberately reduced to a fixed, privacy-safe runtime classification. Arbitrary worker output,
 * paths, identifiers and provider payloads never enter status telemetry or logs through this channel.
 * @param {string} value
 */
function safeStderrExcerpt(value) {
    if (value.includes(PlayerScanIpc.FINAL_SEND_FAILURE_MARKER)) {
        return 'stderr: final IPC result delivery failed';
    }
    if (/heap out of memory|allocation failed[^\r\n]*heap limit/iu.test(value)) {
        return 'stderr: JavaScript heap out of memory';
    }
    if (/module_not_found|cannot find module/iu.test(value)) return 'stderr: worker module not found';
    if (/assertion failed|node::abort|check failed/iu.test(value)) return 'stderr: Node.js assertion failure';
    const exception = value.match(/\b(RangeError|ReferenceError|SyntaxError|TypeError)\b/u);
    if (exception) return `stderr: uncaught ${exception[1]}`;
    if (/fatal error/iu.test(value)) return 'stderr: fatal Node.js runtime error';
    return null;
}

/** @param {any} child */
function captureStderr(child) {
    let buffered = Buffer.alloc(0);
    const stream = child && child.stderr;
    const onData = (/** @type {unknown} */ chunk) => {
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(`${chunk || ''}`, 'utf8');
        if (incoming.length >= MAX_STDERR_BYTES) {
            buffered = Buffer.from(incoming.subarray(incoming.length - MAX_STDERR_BYTES));
            return;
        }
        const retained = Math.min(buffered.length, MAX_STDERR_BYTES - incoming.length);
        buffered = Buffer.concat([buffered.subarray(buffered.length - retained), incoming], retained + incoming.length);
    };
    const onError = () => undefined;
    if (stream && typeof stream.on === 'function') {
        stream.on('data', onData);
        stream.on('error', onError);
    }
    return Object.freeze({
        excerpt: () => safeStderrExcerpt(buffered.toString('utf8')),
        stop: () => {
            if (stream && typeof stream.removeListener === 'function') {
                stream.removeListener('data', onData);
                stream.removeListener('error', onError);
            }
            buffered = Buffer.alloc(0);
        }
    });
}

/** @param {string} message @param {string|null} diagnostic */
function withDiagnostic(message, diagnostic) {
    return diagnostic ? `${message} ${diagnostic}.` : message;
}

/** @param {unknown} error */
function diagnosticCode(error) {
    const code = error && typeof /** @type {any} */ (error).code === 'string' ?
        /** @type {any} */ (error).code : 'WORKER_FAILURE';
    return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'WORKER_FAILURE';
}

/** @param {unknown} error */
function publicDiagnostic(error) {
    const code = diagnosticCode(error);
    const diagnostic = error && typeof /** @type {any} */ (error).diagnostic === 'string' ?
        /** @type {any} */ (error).diagnostic : null;
    const messages = {
        WORKER_SPAWN_FAILED: 'Worker process could not start.',
        WORKER_ERROR: 'Worker process emitted an error.',
        WORKER_EXITED: 'Worker process exited before commit.',
        WORKER_TIMEOUT: 'Worker process exceeded its deadline.',
        WORKER_OPTIONS_EXPIRED: 'Queued worker inputs expired.',
        WORKER_QUEUE_FULL: 'Worker queue is full.',
        PLAN_TOO_LARGE: 'Worker plan exceeded its size limit.',
        REQUEST_TOO_LARGE: 'Worker request exceeded its size limit.',
        STALE_SCAN_PLAN: 'Worker plan became stale before commit.',
        WORKER_IPC_SEND_FAILED: 'Worker IPC delivery failed.',
        STABLE_IDENTITY_CANDIDATES_TOO_LARGE: 'Stable identity candidate input exceeded its limit.',
        STABLE_IDENTITY_CANDIDATES_INVALID: 'Stable identity candidate input was invalid.'
    };
    const base = Object.hasOwn(messages, code) ? /** @type {any} */ (messages)[code] :
        `Worker scan failed (${code}).`;
    return diagnostic ? `${base} ${diagnostic}.` : base;
}

/** @param {unknown} error @param {string} [stage] */
function recordFailure(error, stage = currentStage) {
    failures = increment(failures);
    consecutiveFailures = increment(consecutiveFailures);
    lastCode = diagnosticCode(error);
    lastMessage = publicDiagnostic(error);
    lastAt = new Date().toISOString();
    lastStage = stage;
}

function recordSuccess() {
    consecutiveFailures = 0;
}

function markIdle() {
    currentStage = 'idle';
    workerRssMiB = 0;
    workerHeapUsedMiB = 0;
}

/** @param {any} message */
function acceptProgress(message) {
    if (Object.keys(message).length !== 5 || !WORKER_PROGRESS_STAGES.has(message.stage) ||
        !Number.isSafeInteger(message.rssMiB) || message.rssMiB < 0 ||
        message.rssMiB > MAX_WORKER_MEMORY_MIB || !Number.isSafeInteger(message.heapUsedMiB) ||
        message.heapUsedMiB < 0 || message.heapUsedMiB > MAX_WORKER_MEMORY_MIB) return false;
    currentStage = message.stage;
    workerRssMiB = message.rssMiB;
    workerHeapUsedMiB = message.heapUsedMiB;
    return true;
}

/** @param {unknown} value */
function byteLength(value) {
    try { return Buffer.byteLength(JSON.stringify(value)); }
    catch (_error) { return Number.POSITIVE_INFINITY; }
}

/** @returns {IsolatedScanError} */
function ipcSendFailure() {
    return new IsolatedScanError('WORKER_IPC_SEND_FAILED',
        'Player scan worker IPC delivery failed safely.');
}

/** @returns {never} */
function stableCandidatesTooLarge() {
    throw new IsolatedScanError('STABLE_IDENTITY_CANDIDATES_TOO_LARGE',
        'Player scan stable identity candidates exceeded their bounded admission limit.');
}

/** @returns {never} */
function invalidStableCandidates() {
    throw new IsolatedScanError('STABLE_IDENTITY_CANDIDATES_INVALID',
        'Player scan stable identity candidates are invalid.');
}

/**
 * Validate and project candidates before queue retention. Unknown properties and caller-owned objects are never
 * retained; count, strings and aggregate UTF-8 bytes are all bounded before a job can enter the 8-slot FIFO.
 * @param {unknown} value
 * @returns {readonly any[]}
 */
function admittedStableIdentityCandidates(value) {
    if (value === undefined || value === null) return EMPTY_STABLE_IDENTITY_CANDIDATES;
    if (!Array.isArray(value)) invalidStableCandidates();
    if (value.length > MAX_STABLE_IDENTITY_CANDIDATES) stableCandidatesTooLarge();
    const admitted = [];
    let retainedBytes = 0;
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalidStableCandidates();
        const candidate = /** @type {any} */ (raw);
        const steamId = typeof candidate.steamId === 'string' && candidate.steamId.length === 17 &&
            /^7656119\d{10}$/u.test(candidate.steamId) ?
            candidate.steamId : null;
        const battlemetricsPlayerId = candidate.battlemetricsPlayerId === null ||
            candidate.battlemetricsPlayerId === undefined ? null : candidate.battlemetricsPlayerId;
        const name = typeof candidate.name === 'string' ? candidate.name : '';
        const source = candidate.source;
        const sourceEventId = typeof candidate.sourceEventId === 'string' ? candidate.sourceEventId : '';
        const observedText = typeof candidate.observedAt === 'string' && candidate.observedAt.length <= 64 ?
            candidate.observedAt : null;
        const observedDate = observedText ? new Date(observedText) : null;
        if (!steamId || battlemetricsPlayerId !== null &&
            (typeof battlemetricsPlayerId !== 'string' || battlemetricsPlayerId.length > 32 ||
                !/^\d{1,32}$/u.test(battlemetricsPlayerId)) ||
            !name || name.length > 256 || name !== name.trim() || Array.from(name).length > 128 ||
            /[\u0000-\u001f\u007f]/u.test(name) ||
            !['player-tracker', 'teammate-language-database'].includes(source) ||
            !sourceEventId || sourceEventId.length > 256 || /[\u0000-\u001f\u007f]/u.test(sourceEventId) ||
            !observedDate || Number.isNaN(observedDate.getTime())) invalidStableCandidates();
        const observedAt = observedDate.toISOString();
        retainedBytes += Buffer.byteLength(steamId) + Buffer.byteLength(battlemetricsPlayerId || '') +
            Buffer.byteLength(name) + Buffer.byteLength(source) + Buffer.byteLength(sourceEventId) +
            Buffer.byteLength(observedAt);
        if (retainedBytes > MAX_STABLE_IDENTITY_CANDIDATE_BYTES) stableCandidatesTooLarge();
        admitted.push(Object.freeze({
            steamId, battlemetricsPlayerId, name, observedAt, source, sourceEventId
        }));
    }
    return admitted.length === 0 ? EMPTY_STABLE_IDENTITY_CANDIDATES : Object.freeze(admitted);
}

/** @param {any} value @param {readonly string[]} keys */
function hasExactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** @param {unknown} value */
function validProviderQuery(value) {
    return typeof value === 'string' && value === value.trim() && value.length > 0 &&
        Array.from(value).length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * The worker has a deliberately tiny RPC surface. Validate the complete envelope and each method's exact
 * argument shape before allowing it to invoke anything held by the long-lived parent.
 * @param {any} message
 */
function validProviderRequest(message) {
    if (!hasExactKeys(message, ['v', 'type', 'callId', 'provider', 'method', 'args']) ||
        message.v !== 1 || message.type !== 'provider_request' ||
        !Number.isSafeInteger(message.callId) || message.callId <= 0 || !Array.isArray(message.args) ||
        message.args.length !== 1) return false;
    const value = message.args[0];
    if (message.provider === 'steam' && message.method === 'profileIdentity') {
        return typeof value === 'string' && /^7656119\d{10}$/u.test(value);
    }
    if (message.provider === 'battlemetrics' && message.method === 'resolveSteamId') {
        return typeof value === 'string' && /^\d{1,32}$/u.test(value);
    }
    if (message.provider === 'warbandits' &&
        (message.method === 'resolvePlayerRecent' || message.method === 'resolvePlayer')) {
        return validProviderQuery(value);
    }
    return message.provider === 'warbandits' && message.method === 'scanCurrentWipePage' &&
        Number.isSafeInteger(value) && value >= 1;
}

/** @param {ProviderCall} call @param {any|null} response */
function finishProviderCall(call, response) {
    if (!call.active) return false;
    call.active = false;
    if (call.timer) clearTimeout(call.timer);
    call.timer = null;
    const remove = call.remove;
    call.remove = null;
    if (remove) remove();
    const child = call.target ? call.target.deref() : null;
    call.target = null;
    call.requestProvider = null;
    call.method = null;
    call.requestedArg = null;
    const sendFailure = call.sendFailure;
    call.sendFailure = null;
    if (response && child) send(child, response, sendFailure || undefined);
    return true;
}

/** @param {ProviderCall} call @param {unknown} result */
function resolveProviderCall(call, result) {
    if (!call.active) return;
    let projected;
    try {
        projected = PlayerScanProviderResponses.project(
            call.requestProvider, call.method, call.requestedArg, result);
        PlayerScanIpc.boundedJsonByteLength(projected, MAX_PROVIDER_RESPONSE_BYTES);
    }
    catch (error) {
        finishProviderCall(call, { v: 1, type: 'provider_response', callId: call.callId,
            ok: false, error: safeError(error) });
        return;
    }
    finishProviderCall(call,
        { v: 1, type: 'provider_response', callId: call.callId, ok: true, result: projected });
}

/** @param {ProviderCall} call @param {unknown} error */
function rejectProviderCall(call, error) {
    if (!call.active) return;
    finishProviderCall(call, { v: 1, type: 'provider_response', callId: call.callId,
        ok: false, error: safeError(error) });
}

/** @param {ProviderCall} call */
function releaseProviderInvocation(call) {
    if (!call.provider) return;
    const provider = call.provider;
    call.provider = null;
    outstandingProviderInvocations = Math.max(0, outstandingProviderInvocations - 1);
    const remaining = Math.max(0, (outstandingProviderInvocationsByProvider.get(provider) || 0) - 1);
    if (remaining === 0) outstandingProviderInvocationsByProvider.delete(provider);
    else outstandingProviderInvocationsByProvider.set(provider, remaining);
}

/**
 * Attach completion outside executeCycle's message-listener closure. Once a call is timed out or abandoned,
 * a provider that resolves late retains only this tiny inactive ticket (whose child reference is weak), never
 * the scan options or supervisor closure.
 * @param {ProviderCall} call @param {unknown} result
 */
function trackProviderResult(call, result) {
    Promise.resolve(result).then(value => {
        releaseProviderInvocation(call);
        resolveProviderCall(call, value);
    }, error => {
        releaseProviderInvocation(call);
        rejectProviderCall(call, error);
    });
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
    const stableIdentityCandidates = admittedStableIdentityCandidates(options.stableIdentityCandidates);
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
            stableIdentityCandidates: currentScope.wipeId === resolvedScope.wipeId ?
                stableIdentityCandidates : Object.freeze([]),
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
    const stableIdentityCandidates = admittedStableIdentityCandidates(options.stableIdentityCandidates);
    return jsonClone({
        directory: Path.resolve(options.directory),
        context: { guildId: `${options.context.guildId}` },
        scope: scopeForWorker(options.scope),
        stableIdentityCandidates,
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
function callProvider(options, message) {
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
    try {
        if (options.context && options.context.rustplus && typeof options.context.rustplus.log === 'function') {
            options.context.rustplus.log('PLAYER_INTELLIGENCE', message, 'warn');
        }
        else if (options.context && options.context.client && typeof options.context.client.log === 'function') {
            options.context.client.log('PLAYER_INTELLIGENCE', message, 'warn');
        }
    }
    catch (_error) { /* Worker diagnostics are optional and must never settle a scan cycle. */ }
}

/** @param {any} options @param {unknown} message */
function logWarningOnce(options, message) {
    const safe = safeError(message);
    const fingerprint = Crypto.createHash('sha256').update(safe).digest('hex');
    if (parentWarningTimes.has(fingerprint)) return false;
    parentWarningTimes.set(fingerprint, true);
    logWarning(options, safe);
    return true;
}

/** @param {any} child @param {any} message @param {()=>void} [onFailure] */
function send(child, message, onFailure = () => undefined) {
    let failed = false;
    const fail = () => {
        if (failed) return;
        failed = true;
        onFailure();
    };
    if (!child.connected) {
        fail();
        return false;
    }
    try {
        child.send(message, (/** @type {unknown} */ error) => {
            if (error) fail();
        });
        return true;
    }
    catch (_error) {
        fail();
        return false;
    }
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

/** @param {any} options @param {ScanAdapters} adapters */
async function executeCycle(options, adapters) {
    currentStage = 'initializing';
    workerRssMiB = 0;
    workerHeapUsedMiB = 0;
    let payload;
    try { payload = payloadFor(options); }
    catch (error) {
        recordFailure(error, 'initializing');
        markIdle();
        throw error;
    }
    const forkImpl = adapters.forkImpl || ChildProcess.fork;
    const requestedWorkerTimeout = Number(adapters.timeoutMs);
    const timeoutMs = Number.isSafeInteger(requestedWorkerTimeout) && requestedWorkerTimeout > 1 ?
        requestedWorkerTimeout : WORKER_TIMEOUT_MS;
    const requestedProviderTimeout = Number(adapters.providerTimeoutMs);
    const configuredCallTimeout = Number.isSafeInteger(requestedProviderTimeout) &&
        requestedProviderTimeout > 0 ? requestedProviderTimeout : PROVIDER_CALL_TIMEOUT_MS;
    const providerTimeoutMs = Math.max(1,
        Math.min(configuredCallTimeout, MAX_PROVIDER_CALL_TIMEOUT_MS, timeoutMs - 1));
    let child;
    try {
        child = forkImpl(WORKER_PATH, [], /** @type {any} */ ({
            execArgv: [`--max-old-space-size=${WORKER_HEAP_MIB}`],
            serialization: 'json',
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            windowsHide: true
        }));
    }
    catch (error) {
        const failure = new IsolatedScanError('WORKER_SPAWN_FAILED',
            `Player scan worker could not start: ${safeError(error)}.`);
        recordFailure(failure, 'initializing');
        markIdle();
        throw failure;
    }
    const stderr = captureStderr(child);
    const errorGuard = () => undefined;
    errorGuards.set(child, errorGuard);
    child.on('error', errorGuard);
    workers.add(child);
    let settled = false;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    /** @type {Map<number,ProviderCall>} */
    const providerCalls = new Map();
    let lastProviderCallId = 0;

    try {
        const plan = await new Promise((resolve, reject) => {
            /** @type {(error:Error|null,value?:any)=>void} */
            let finish = () => undefined;
            const onIpcSendFailure = () => finish(ipcSendFailure());
            const onMessage = (/** @type {any} */ rawMessage) => {
                if (!rawMessage || typeof rawMessage !== 'object') return;
                const message = /** @type {any} */ (rawMessage);
                if (message.v !== 1) return;
                if (message.type === 'progress') {
                    acceptProgress(message);
                    return;
                }
                if (message.type === 'warning') {
                    logWarningOnce(options, message.message);
                    return;
                }
                if (message.type === 'provider_request' && Number.isSafeInteger(message.callId) &&
                    message.callId > 0) {
                    if (byteLength(message) > MAX_PROVIDER_REQUEST_BYTES) {
                        send(child, { v: 1, type: 'provider_response', callId: message.callId,
                            ok: false, error: 'Player scan provider request exceeded its limit.' },
                        onIpcSendFailure);
                        return;
                    }
                    if (!validProviderRequest(message) || message.callId <= lastProviderCallId) {
                        send(child, { v: 1, type: 'provider_response', callId: message.callId,
                            ok: false, error: 'Player scan provider request is invalid.' }, onIpcSendFailure);
                        return;
                    }
                    lastProviderCallId = message.callId;
                    if (providerCalls.size >= MAX_IN_FLIGHT_PROVIDER_CALLS) {
                        send(child, { v: 1, type: 'provider_response', callId: message.callId,
                            ok: false, error: 'Player scan provider request limit reached.' }, onIpcSendFailure);
                        return;
                    }
                    if ((outstandingProviderInvocationsByProvider.get(message.provider) || 0) >=
                        MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER) {
                        send(child, { v: 1, type: 'provider_response', callId: message.callId,
                            ok: false, error: 'Player scan provider-specific capacity is exhausted.' },
                        onIpcSendFailure);
                        return;
                    }
                    if (outstandingProviderInvocations >= MAX_OUTSTANDING_PROVIDER_INVOCATIONS) {
                        send(child, { v: 1, type: 'provider_response', callId: message.callId,
                            ok: false, error: 'Player scan provider capacity is exhausted.' }, onIpcSendFailure);
                        return;
                    }
                    /** @type {ProviderCall} */
                    const call = { active: true, callId: message.callId, provider: message.provider,
                        requestProvider: message.provider, method: message.method, requestedArg: message.args[0],
                        target: new WeakRef(child), timer: null, remove: null, sendFailure: onIpcSendFailure };
                    call.remove = () => providerCalls.delete(call.callId);
                    providerCalls.set(call.callId, call);
                    call.timer = setTimeout(() => {
                        finishProviderCall(call, { v: 1, type: 'provider_response', callId: call.callId,
                            ok: false, error: 'Player scan provider request timed out.' });
                    }, providerTimeoutMs);
                    if (call.timer && typeof call.timer.unref === 'function') call.timer.unref();
                    let providerResult;
                    outstandingProviderInvocations += 1;
                    outstandingProviderInvocationsByProvider.set(message.provider,
                        (outstandingProviderInvocationsByProvider.get(message.provider) || 0) + 1);
                    try { providerResult = callProvider(options, message); }
                    catch (error) {
                        releaseProviderInvocation(call);
                        rejectProviderCall(call, error);
                        return;
                    }
                    trackProviderResult(call, providerResult);
                    return;
                }
                if (message.type === 'result') {
                    try {
                        PlayerScanIpc.boundedJsonByteLength(message.plan, MAX_PLAN_BYTES);
                    }
                    catch (_error) {
                        finish(new IsolatedScanError('PLAN_TOO_LARGE',
                            'Player scan worker plan exceeded its limit.'));
                        return;
                    }
                    finish(null, message.plan);
                    return;
                }
                if (message.type === 'failure') {
                    finish(new IsolatedScanError(`${message.code || 'WORKER_FAILURE'}`.slice(0, 64),
                        `Player scan worker failed: ${safeError(message.message)}`));
                }
            };
            const onError = (/** @type {unknown} */ error) => {
                const diagnostic = stderr.excerpt();
                finish(new IsolatedScanError('WORKER_ERROR', withDiagnostic(
                    `Player scan worker error: ${safeError(error)}`, diagnostic), diagnostic));
            };
            const onExit = (/** @type {number|null} */ code, /** @type {string|null} */ signal) =>
            {
                const diagnostic = stderr.excerpt();
                finish(new IsolatedScanError('WORKER_EXITED', withDiagnostic(
                    `Player scan worker stopped before commit: exit=${code ?? '-'} signal=${signal || '-'}.`,
                    diagnostic), diagnostic));
            };
            finish = (/** @type {Error|null} */ error, /** @type {any} */ value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                for (const call of providerCalls.values()) finishProviderCall(call, null);
                providerCalls.clear();
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
            send(child, { v: 1, type: 'run', payload }, onIpcSendFailure);
        });
        // The planner is deliberately one-shot: release its projection heap before committing in the parent.
        await reapChild(child);
        // Lazy loading prevents the worker supervisor from creating a scan-daemon module cycle.
        const ScanDaemon = require('./scanDaemon.js');
        currentStage = 'committing';
        const result = await ScanDaemon.commitPlan(options, plan);
        completed = increment(completed);
        recordSuccess();
        markIdle();
        return result;
    }
    catch (error) {
        if (error && /** @type {any} */ (error).code === 'STALE_SCAN_PLAN') stalePlans = increment(stalePlans);
        else recordFailure(error);
        markIdle();
        throw error;
    }
    finally {
        stderr.stop();
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
    const resolver = job.resolveOptions;
    job.resolveOptions = () => null;
    const options = resolver(job.forced);
    if (!options) {
        const error = new IsolatedScanError('WORKER_OPTIONS_EXPIRED',
            'Player scan inputs expired while waiting; a future scan can retry safely.');
        recordFailure(error, 'queued');
        finishJob(job, error, null);
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

/** @param {any} options @param {ScanAdapters} [adapters] */
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
            const error = new IsolatedScanError('WORKER_QUEUE_FULL',
                'Player scan worker coalescing limit was reached.');
            recordFailure(error, 'queued');
            throw error;
        }
        const resolver = queuedOptionsResolver(options);
        existing.forced = existing.forced || options.forceWarBanditsRescan === true;
        existing.resolveOptions = resolver;
        existing.adapters = adapters;
        return new Promise((resolve, reject) => existing.waiters.push({ resolve, reject }));
    }
    if (activeJob && pendingJobs.length >= MAX_PENDING_WORKERS) {
        const error = new IsolatedScanError('WORKER_QUEUE_FULL', 'Player scan worker queue is full.');
        recordFailure(error, 'queued');
        throw error;
    }
    const resolver = queuedOptionsResolver(options);
    const job = /** @type {ScanJob} */ ({ key, resolveOptions: resolver,
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
    let providerCircuitsOpen = 0;
    for (const count of outstandingProviderInvocationsByProvider.values()) {
        if (count >= MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER) providerCircuitsOpen += 1;
    }
    if (outstandingProviderInvocations >= MAX_OUTSTANDING_PROVIDER_INVOCATIONS) {
        providerCircuitsOpen = Math.max(1, providerCircuitsOpen);
    }
    return Object.freeze({
        active: workers.size,
        queued: pendingJobs.length,
        completed,
        failures,
        stalePlans,
        consecutiveFailures,
        stage: currentStage,
        rssMiB: workerRssMiB,
        heapUsedMiB: workerHeapUsedMiB,
        providerInvocationsOutstanding: Math.min(MAX_OUTSTANDING_PROVIDER_INVOCATIONS,
            Math.max(0, outstandingProviderInvocations)),
        providerCircuitsOpen: Math.min(outstandingProviderInvocationsByProvider.size,
            providerCircuitsOpen),
        lastCode,
        lastMessage,
        lastAt,
        lastStage
    });
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
    MAX_IN_FLIGHT_PROVIDER_CALLS,
    MAX_OUTSTANDING_PROVIDER_INVOCATIONS,
    MAX_OUTSTANDING_PROVIDER_INVOCATIONS_PER_PROVIDER,
    MAX_PENDING_WORKERS,
    MAX_PLAN_BYTES,
    MAX_PROVIDER_REQUEST_BYTES,
    MAX_PROVIDER_RESPONSE_BYTES,
    MAX_REQUEST_BYTES,
    MAX_STABLE_IDENTITY_CANDIDATES,
    MAX_STABLE_IDENTITY_CANDIDATE_BYTES,
    PROVIDER_CALL_TIMEOUT_MS,
    WORKER_HEAP_MIB,
    WORKER_TIMEOUT_MS,
    getRuntimeStatus,
    runCycle,
    shutdown
});
