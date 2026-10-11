// @ts-check
const PerfHooks = require('node:perf_hooks');
const V8 = require('node:v8');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const MIN_INTERVAL_MS = 10 * 1000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_GAUGE = Number.MAX_SAFE_INTEGER;
const DURATION_BUCKETS_MS = Object.freeze([
    10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000,
    Number.POSITIVE_INFINITY
]);
const OPERATIONS = Object.freeze([
    'translation',
    'ocr_queue_wait',
    'ocr_run',
    'import_prepare',
    'import_decision',
    'scan_cycle',
    'pi_rebuild_identities',
    'pi_rebuild_metrics',
    'pi_rebuild_clans',
    'pi_rebuild_presence',
    'pi_rebuild_wipes',
    'pi_rebuild_total',
    'pi_history_append'
]);
const OUTCOMES = Object.freeze(['success', 'failure', 'timeout', 'skipped', 'dropped']);
const SLOW_THRESHOLDS_MS = Object.freeze({
    translation: 3000,
    ocr_queue_wait: 5000,
    ocr_run: 30000,
    import_prepare: 30000,
    import_decision: 5000,
    scan_cycle: 30000,
    pi_rebuild_identities: 1000,
    pi_rebuild_metrics: 1000,
    pi_rebuild_clans: 1000,
    pi_rebuild_presence: 1000,
    pi_rebuild_wipes: 1000,
    pi_rebuild_total: 2000,
    pi_history_append: 1000
});
const SOURCE_FIELDS = Object.freeze({
    imports: Object.freeze(['active', 'previewsPending', 'decisionsClaimed', 'decisionQueues']),
    ocr: Object.freeze(['active', 'queued', 'queuedBytes']),
    scans: Object.freeze([
        'active', 'forcedRerunsQueued', 'automaticBackoffs', 'automaticBackoffSkips', 'workerActive',
        'workerQueued', 'workerCompleted', 'workerFailures', 'workerStalePlans', 'workerConsecutiveFailures',
        'workerRssMiB', 'workerHeapUsedMiB', 'workerProviderInvocationsOutstanding',
        'workerProviderCircuitsOpen'
    ]),
    translations: Object.freeze(['active', 'queued']),
    services: Object.freeze(['active', 'queued', 'running', 'restarts', 'failures', 'circuitOpen']),
    loops: Object.freeze(['active', 'running', 'scheduled', 'failures'])
});
const SOURCE_TEXT_FIELDS = Object.freeze({
    scans: Object.freeze(['workerStage', 'workerLastCode', 'workerLastMessage', 'workerLastAt', 'workerLastStage'])
});
const WORKER_STAGES = new Set([
    'idle', 'initializing', 'reading_state', 'reading_history', 'rebuilding', 'reconciling',
    'steam_profiles', 'online_players', 'warbandits', 'finalizing', 'sending_result',
    'committing', 'queued'
]);
const SAFE_WORKER_MESSAGE = /^(?:(?:Worker process (?:could not start|emitted an error|exited before commit|exceeded its deadline)|Queued worker inputs expired|Worker queue is full|Worker (?:plan|request) exceeded its size limit|Worker plan became stale before commit|Worker IPC delivery failed|Stable identity candidate input (?:exceeded its limit|was invalid))\.|Worker scan failed \([A-Z0-9_]{1,64}\)\.)(?: stderr: (?:final IPC result delivery failed|JavaScript heap out of memory|worker module not found|Node\.js assertion failure|uncaught (?:RangeError|ReferenceError|SyntaxError|TypeError)|fatal Node\.js runtime error)\.)?$/u;

/** @returns {any} */
function operationWindow() {
    return {
        started: 0,
        outcomes: Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0])),
        completed: 0,
        totalMs: 0,
        maxMs: 0,
        slow: 0,
        buckets: DURATION_BUCKETS_MS.map(() => 0)
    };
}

/** @returns {Record<string, any>} */
function operationsWindow() {
    return Object.fromEntries(OPERATIONS.map(operation => [operation, operationWindow()]));
}

/** @param {number} value */
function finiteNonNegative(value) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** @param {unknown} value */
function boundedGauge(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(MAX_GAUGE, Math.max(0, Math.round(number))) : 0;
}

/** @param {string} field @param {unknown} value */
function boundedSourceText(field, value) {
    if (typeof value !== 'string') return null;
    if ((field === 'workerStage' || field === 'workerLastStage') && WORKER_STAGES.has(value)) return value;
    if (field === 'workerLastCode' && /^[A-Z0-9_]{1,64}$/u.test(value)) return value;
    if (field === 'workerLastAt' && value.length <= 32 && !Number.isNaN(Date.parse(value))) {
        return new Date(value).toISOString();
    }
    if (field === 'workerLastMessage' && value.length <= 180 && SAFE_WORKER_MESSAGE.test(value)) return value;
    return null;
}

/** @param {number} bytes */
function mebibytes(bytes) {
    return Number((finiteNonNegative(bytes) / (1024 * 1024)).toFixed(1));
}

/** @param {number} value */
function rounded(value) {
    return Number(finiteNonNegative(value).toFixed(1));
}

/** @param {number} nanoseconds */
function nanosecondsToMilliseconds(nanoseconds) {
    return rounded(nanoseconds / 1000000);
}

/** @param {any} value */
function immutable(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) immutable(child);
    return Object.freeze(value);
}

/** @param {any} operation @param {number} percentile */
function bucketPercentile(operation, percentile) {
    if (operation.completed === 0) return 0;
    const target = Math.max(1, Math.ceil(operation.completed * percentile));
    let count = 0;
    for (let index = 0; index < operation.buckets.length; index += 1) {
        count += operation.buckets[index];
        if (count < target) continue;
        const boundary = DURATION_BUCKETS_MS[index];
        return Number.isFinite(boundary) ? boundary : Math.round(operation.maxMs);
    }
    return Math.round(operation.maxMs);
}

/** @param {any} operation */
function operationSnapshot(operation) {
    return {
        started: operation.started,
        completed: operation.completed,
        success: operation.outcomes.success,
        failure: operation.outcomes.failure,
        timeout: operation.outcomes.timeout,
        skipped: operation.outcomes.skipped,
        dropped: operation.outcomes.dropped,
        averageMs: operation.completed === 0 ? 0 : rounded(operation.totalMs / operation.completed),
        maxMs: rounded(operation.maxMs),
        p50Ms: bucketPercentile(operation, 0.5),
        p95Ms: bucketPercentile(operation, 0.95),
        p99Ms: bucketPercentile(operation, 0.99),
        slow: operation.slow
    };
}

/** @param {Record<string, Function>} sources */
function normalizeSources(sources) {
    /** @type {Record<string, Function>} */
    const normalized = {};
    /** @type {Record<string, Function>} */
    const input = sources && typeof sources === 'object' ? sources : {};
    for (const name of Object.keys(SOURCE_FIELDS)) {
        if (typeof input[name] === 'function') normalized[name] = input[name];
    }
    return normalized;
}

/** @param {Record<string, Function>} sources */
function collectSources(sources) {
    /** @type {Record<string, any>} */
    const values = {};
    let failures = 0;
    for (const [source, fields] of Object.entries(SOURCE_FIELDS)) {
        let failed = false;
        /** @type {Record<string, any>} */
        let current = Object.fromEntries(fields.map(field => [field, 0]));
        try {
            const supplied = sources[source] ? sources[source]() : null;
            if (supplied && typeof supplied === 'object') {
                current = Object.fromEntries(fields.map(field => [field, boundedGauge(supplied[field])]));
                const textFields = /** @type {Record<string, readonly string[]>} */ (SOURCE_TEXT_FIELDS)[source] || [];
                for (const field of textFields) current[field] = boundedSourceText(field, supplied[field]);
            }
            else if (sources[source]) failed = true;
        }
        catch (_error) {
            failed = true;
        }
        if (failed) failures += 1;
        values[source] = current;
    }
    return { values, failures };
}

/** @param {Record<string, any>} operations */
function formatWork(operations) {
    return OPERATIONS.map(operation => {
        const value = operations[operation];
        return `${operation}_started=${value.started} ${operation}_completed=${value.completed} ` +
            `${operation}_success=${value.success} ${operation}_failure=${value.failure} ` +
            `${operation}_timeout=${value.timeout} ${operation}_skipped=${value.skipped} ` +
            `${operation}_dropped=${value.dropped} ${operation}_p95Ms=${value.p95Ms} ` +
            `${operation}_maxMs=${value.maxMs}`;
    }).join(' ');
}

/** @param {any} snapshot */
function formatRuntime(snapshot) {
    const imports = snapshot.sources.imports;
    const ocr = snapshot.sources.ocr;
    const scans = snapshot.sources.scans;
    const translations = snapshot.sources.translations;
    const services = snapshot.sources.services;
    const loops = snapshot.sources.loops;
    return `windowSec=${rounded(snapshot.windowMs / 1000)} rssMiB=${snapshot.process.rssMiB} ` +
        `heapUsedMiB=${snapshot.process.heapUsedMiB} heapTotalMiB=${snapshot.process.heapTotalMiB} ` +
        `heapLimitMiB=${snapshot.process.heapLimitMiB} externalMiB=${snapshot.process.externalMiB} ` +
        `arrayBuffersMiB=${snapshot.process.arrayBuffersMiB} cpuPct=${snapshot.process.cpuPct} ` +
        `eluPct=${snapshot.eventLoop.utilizationPct} loopP99Ms=${snapshot.eventLoop.p99Ms} ` +
        `loopMaxMs=${snapshot.eventLoop.maxMs} importsActive=${imports.active} ` +
        `previewsPending=${imports.previewsPending} decisionsClaimed=${imports.decisionsClaimed} ` +
        `decisionQueues=${imports.decisionQueues} ocrActive=${ocr.active} ocrQueued=${ocr.queued} ` +
        `ocrQueuedMiB=${mebibytes(ocr.queuedBytes)} scansActive=${scans.active} ` +
        `scansQueued=${scans.forcedRerunsQueued} scanBackoffs=${scans.automaticBackoffs} ` +
        `scanBackoffSkips=${scans.automaticBackoffSkips} scanWorkersActive=${scans.workerActive} ` +
        `scanWorkersQueued=${scans.workerQueued} scanWorkersCompleted=${scans.workerCompleted} ` +
        `scanWorkerFailures=${scans.workerFailures} scanWorkerStalePlans=${scans.workerStalePlans} ` +
        `scanWorkerConsecutiveFailures=${scans.workerConsecutiveFailures} ` +
        `scanWorkerStage=${scans.workerStage || 'unknown'} scanWorkerRssMiB=${scans.workerRssMiB} ` +
        `scanWorkerHeapUsedMiB=${scans.workerHeapUsedMiB} ` +
        `scanWorkerProviderOutstanding=${scans.workerProviderInvocationsOutstanding} ` +
        `scanWorkerProviderCircuitsOpen=${scans.workerProviderCircuitsOpen} ` +
        `scanWorkerLastCode=${scans.workerLastCode || 'none'} ` +
        `scanWorkerLastStage=${scans.workerLastStage || 'none'} ` +
        `scanWorkerLastAt=${scans.workerLastAt || 'none'} ` +
        `translationsActive=${translations.active} ` +
        `translationsQueued=${translations.queued} loopsActive=${loops.active} loopsRunning=${loops.running} ` +
        `loopsScheduled=${loops.scheduled} loopFailures=${loops.failures} ` +
        `servicesActive=${services.active} servicesQueued=${services.queued} servicesRunning=${services.running} ` +
        `serviceRestarts=${services.restarts} serviceFailures=${services.failures} ` +
        `serviceCircuitOpen=${services.circuitOpen} ` +
        `sourceFailures=${snapshot.sourceFailures} ` +
        `collectorFailures=${snapshot.collectorFailures}`;
}

/** @param {Record<string, any>} [dependencies] */
function createRuntimeTelemetry(dependencies = {}) {
    const now = dependencies.now || (() => PerfHooks.performance.now());
    const memoryUsage = dependencies.memoryUsage || (() => process.memoryUsage());
    const cpuUsage = dependencies.cpuUsage || (() => process.cpuUsage());
    const heapStatistics = dependencies.heapStatistics || (() => V8.getHeapStatistics());
    const eventLoopUtilization = dependencies.eventLoopUtilization ||
        (() => PerfHooks.performance.eventLoopUtilization());
    const createEventLoopMonitor = dependencies.createEventLoopMonitor ||
        (() => PerfHooks.monitorEventLoopDelay({ resolution: 20 }));
    const setIntervalImpl = dependencies.setIntervalImpl || setInterval;
    const clearIntervalImpl = dependencies.clearIntervalImpl || clearInterval;

    let enabled = false;
    /** @type {any} */
    let interval = null;
    /** @type {Function|null} */
    let logger = null;
    /** @type {any} */
    let monitor = null;
    /** @type {Record<string, Function>} */
    let sources = {};
    let windowStartedAt = 0;
    let previousCpu = { user: 0, system: 0 };
    let previousElu = { active: 0, idle: 0 };
    let cpuBaselineValid = false;
    let eluBaselineValid = false;
    let pendingCollectorFailures = 0;
    let windowOperations = operationsWindow();
    /** @type {Set<string>} */
    let slowLogged = new Set();
    /** @type {any} */
    let lastSnapshot = null;

    /** @param {string} title @param {string} message @param {string} level */
    function log(title, message, level) {
        if (typeof logger !== 'function') return;
        try { logger(title, message, level); }
        catch (_error) { /* Telemetry must never affect bot work. */ }
    }

    /** @param {string} operation @param {string} outcome @param {number} elapsedMs */
    function finish(operation, outcome, elapsedMs) {
        if (!OPERATIONS.includes(operation)) throw new TypeError('Unknown runtime telemetry operation.');
        if (!OUTCOMES.includes(outcome)) throw new TypeError('Unknown runtime telemetry outcome.');
        if (!enabled) return;
        const duration = Math.min(MAX_DURATION_MS, finiteNonNegative(Number(elapsedMs)));
        const value = windowOperations[operation];
        value.outcomes[outcome] += 1;
        value.completed += 1;
        value.totalMs += duration;
        value.maxMs = Math.max(value.maxMs, duration);
        const bucket = DURATION_BUCKETS_MS.findIndex(boundary => duration <= boundary);
        value.buckets[bucket < 0 ? value.buckets.length - 1 : bucket] += 1;
        const threshold = /** @type {Record<string, number>} */ (SLOW_THRESHOLDS_MS)[operation];
        if (duration >= threshold) {
            value.slow += 1;
            if (!slowLogged.has(operation)) {
                slowLogged.add(operation);
                log('RUNTIME_SLOW', `operation=${operation} outcome=${outcome} ` +
                    `elapsedMs=${Math.round(duration)} thresholdMs=${threshold}`, 'warn');
            }
        }
    }

    /** @param {string} operation */
    function startSpan(operation) {
        if (!OPERATIONS.includes(operation)) throw new TypeError('Unknown runtime telemetry operation.');
        if (!enabled) return Object.freeze({
            /** @param {string} outcome */
            finish(outcome) {
                if (!OUTCOMES.includes(outcome)) throw new TypeError('Unknown runtime telemetry outcome.');
            }
        });
        windowOperations[operation].started += 1;
        const startedAt = now();
        let completed = false;
        return Object.freeze({
            /** @param {string} outcome */
            finish(outcome) {
                if (completed) return;
                if (!OUTCOMES.includes(outcome)) throw new TypeError('Unknown runtime telemetry outcome.');
                completed = true;
                finish(operation, outcome, now() - startedAt);
            }
        });
    }

    function flush() {
        if (!enabled) return null;
        const endedAt = now();
        const windowMs = Math.max(1, endedAt - windowStartedAt);
        let collectorFailures = pendingCollectorFailures;
        pendingCollectorFailures = 0;
        /** @type {Record<string, any>} */
        let memory = {};
        /** @type {Record<string, any>} */
        let heap = {};
        let currentCpu = previousCpu;
        let currentElu = previousElu;
        let cpuCollected = false;
        let eluCollected = false;
        try { memory = memoryUsage() || {}; }
        catch (_error) { memory = {}; collectorFailures += 1; }
        try { heap = heapStatistics() || {}; }
        catch (_error) { heap = {}; collectorFailures += 1; }
        try {
            const supplied = cpuUsage();
            if (!supplied || typeof supplied !== 'object') throw new TypeError('Invalid CPU metrics.');
            currentCpu = supplied;
            cpuCollected = true;
        }
        catch (_error) { currentCpu = previousCpu; collectorFailures += 1; }
        try {
            const supplied = eventLoopUtilization();
            if (!supplied || typeof supplied !== 'object') throw new TypeError('Invalid ELU metrics.');
            currentElu = supplied;
            eluCollected = true;
        }
        catch (_error) { currentElu = previousElu; collectorFailures += 1; }
        const cpuMicroseconds = cpuCollected && cpuBaselineValid ?
            Math.max(0, Number(currentCpu.user || 0) - Number(previousCpu.user || 0)) +
                Math.max(0, Number(currentCpu.system || 0) - Number(previousCpu.system || 0)) : 0;
        const active = eluCollected && eluBaselineValid ?
            Math.max(0, Number(currentElu.active || 0) - Number(previousElu.active || 0)) : 0;
        const idle = eluCollected && eluBaselineValid ?
            Math.max(0, Number(currentElu.idle || 0) - Number(previousElu.idle || 0)) : 0;
        const loopTotal = active + idle;
        const eventLoop = {
            utilizationPct: rounded(loopTotal === 0 ? 0 : active / loopTotal * 100),
            p50Ms: 0,
            p95Ms: 0,
            p99Ms: 0,
            maxMs: 0
        };
        try {
            if (monitor) {
                eventLoop.p50Ms = nanosecondsToMilliseconds(monitor.percentile(50));
                eventLoop.p95Ms = nanosecondsToMilliseconds(monitor.percentile(95));
                eventLoop.p99Ms = nanosecondsToMilliseconds(monitor.percentile(99));
                eventLoop.maxMs = nanosecondsToMilliseconds(monitor.max);
                monitor.reset();
            }
        }
        catch (_error) { collectorFailures += 1; }
        const collected = collectSources(sources);
        const operations = Object.fromEntries(OPERATIONS.map(operation =>
            [operation, operationSnapshot(windowOperations[operation])]));
        const snapshot = immutable({
            windowMs: rounded(windowMs),
            process: {
                rssMiB: mebibytes(memory.rss),
                heapUsedMiB: mebibytes(memory.heapUsed),
                heapTotalMiB: mebibytes(memory.heapTotal),
                heapLimitMiB: mebibytes(heap.heap_size_limit),
                externalMiB: mebibytes(memory.external),
                arrayBuffersMiB: mebibytes(memory.arrayBuffers),
                cpuPct: rounded(cpuMicroseconds / (windowMs * 1000) * 100)
            },
            eventLoop,
            sources: collected.values,
            sourceFailures: collected.failures,
            collectorFailures,
            operations
        });
        lastSnapshot = snapshot;
        windowOperations = operationsWindow();
        slowLogged = new Set();
        windowStartedAt = endedAt;
        previousCpu = currentCpu;
        previousElu = currentElu;
        cpuBaselineValid = cpuCollected;
        eluBaselineValid = eluCollected;
        const heapPressure = snapshot.process.heapLimitMiB > 0 &&
            snapshot.process.heapUsedMiB / snapshot.process.heapLimitMiB >= 0.75;
        const scans = snapshot.sources.scans || {};
        const degraded = snapshot.eventLoop.p99Ms >= 250 || snapshot.eventLoop.maxMs >= 1000 ||
            snapshot.sourceFailures > 0 || snapshot.collectorFailures > 0 || heapPressure ||
            scans.workerConsecutiveFailures > 0 || scans.automaticBackoffs > 0 ||
            scans.workerProviderCircuitsOpen > 0;
        log('RUNTIME', formatRuntime(snapshot), degraded ? 'warn' : 'info');
        log('RUNTIME_WORK', formatWork(snapshot.operations), 'info');
        return snapshot;
    }

    function stop() {
        if (interval !== null) clearIntervalImpl(interval);
        interval = null;
        if (monitor && typeof monitor.disable === 'function') {
            try { monitor.disable(); }
            catch (_error) { /* Ignore monitor shutdown failures. */ }
        }
        monitor = null;
        enabled = false;
    }

    /** @param {{enabled?:boolean,intervalMs?:number,logger?:Function,sources?:Record<string,Function>}} [options] */
    function start(options = {}) {
        stop();
        logger = typeof options.logger === 'function' ? options.logger : null;
        sources = normalizeSources(options.sources || {});
        lastSnapshot = null;
        windowOperations = operationsWindow();
        slowLogged = new Set();
        pendingCollectorFailures = 0;
        if (options.enabled === false) return false;
        const requestedInterval = Number(options.intervalMs || DEFAULT_INTERVAL_MS);
        if (!Number.isSafeInteger(requestedInterval) || requestedInterval < MIN_INTERVAL_MS ||
            requestedInterval > MAX_INTERVAL_MS) {
            throw new TypeError('Runtime telemetry interval must be an integer between 10000 and 300000 ms.');
        }
        enabled = true;
        windowStartedAt = now();
        cpuBaselineValid = false;
        eluBaselineValid = false;
        try {
            const supplied = cpuUsage();
            if (!supplied || typeof supplied !== 'object') throw new TypeError('Invalid CPU metrics.');
            previousCpu = supplied;
            cpuBaselineValid = true;
        }
        catch (_error) { previousCpu = { user: 0, system: 0 }; pendingCollectorFailures += 1; }
        try {
            const supplied = eventLoopUtilization();
            if (!supplied || typeof supplied !== 'object') throw new TypeError('Invalid ELU metrics.');
            previousElu = supplied;
            eluBaselineValid = true;
        }
        catch (_error) { previousElu = { active: 0, idle: 0 }; pendingCollectorFailures += 1; }
        try {
            monitor = createEventLoopMonitor();
            if (monitor && typeof monitor.enable === 'function') monitor.enable();
        }
        catch (_error) { monitor = null; pendingCollectorFailures += 1; }
        interval = setIntervalImpl(flush, requestedInterval);
        if (interval && typeof interval.unref === 'function') interval.unref();
        return true;
    }

    return Object.freeze({
        flush,
        getLastSnapshot: () => lastSnapshot,
        isEnabled: () => enabled,
        start,
        startSpan,
        stop
    });
}

const RuntimeTelemetry = createRuntimeTelemetry();

module.exports = Object.freeze({
    ...RuntimeTelemetry,
    DURATION_BUCKETS_MS,
    OPERATIONS,
    OUTCOMES,
    SOURCE_FIELDS,
    createRuntimeTelemetry
});
