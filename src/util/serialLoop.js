// @ts-check

const MAX_LOOPS = 256;
const activeLoops = new Set();

/** @param {unknown} error */
function safeError(error) {
    return error instanceof Error ? error : new Error(`${error || 'unknown error'}`);
}

/**
 * A self-scheduling async loop. The next run is never scheduled before the current promise settles.
 * @param {{name:string,intervalMs:number,task:()=>unknown|Promise<unknown>,onError?:(error:Error)=>void,
 * setTimeoutImpl?:Function,clearTimeoutImpl?:Function}} options
 */
function create(options) {
    if (!options || typeof options !== 'object') throw new TypeError('Serial loop options are required.');
    if (typeof options.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(options.name)) {
        throw new TypeError('Serial loop name is invalid.');
    }
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 10 || options.intervalMs > 24 * 60 * 60 * 1000) {
        throw new TypeError('Serial loop interval is invalid.');
    }
    if (typeof options.task !== 'function') throw new TypeError('Serial loop task is required.');
    const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
    const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
    /** @type {any} */
    let timer = null;
    let running = false;
    let stopped = true;
    let runs = 0;
    let failures = 0;

    const status = () => Object.freeze({
        name: options.name,
        running,
        scheduled: timer !== null,
        stopped,
        runs,
        failures
    });

    const report = (/** @type {unknown} */ error) => {
        failures += 1;
        if (typeof options.onError !== 'function') return;
        try { options.onError(safeError(error)); }
        catch (_error) { /* A diagnostic callback cannot break the scheduler. */ }
    };

    const schedule = (/** @type {number} */ delay) => {
        if (stopped || timer !== null) return;
        timer = setTimeoutImpl(() => {
            timer = null;
            void execute();
        }, delay);
        if (timer && typeof timer.unref === 'function') timer.unref();
    };

    const execute = async () => {
        if (stopped || running) return false;
        running = true;
        runs += 1;
        try { await options.task(); }
        catch (error) { report(error); }
        finally {
            running = false;
            schedule(options.intervalMs);
        }
        return true;
    };

    const controller = Object.freeze({
        start(immediate = true) {
            if (!stopped) return false;
            if (activeLoops.size >= MAX_LOOPS) throw new Error('Serial loop capacity reached.');
            stopped = false;
            activeLoops.add(controller);
            schedule(immediate ? 0 : options.intervalMs);
            return true;
        },
        stop() {
            if (stopped) return false;
            stopped = true;
            activeLoops.delete(controller);
            if (timer !== null) clearTimeoutImpl(timer);
            timer = null;
            return true;
        },
        runNow() {
            if (stopped || running) return false;
            if (timer !== null) clearTimeoutImpl(timer);
            timer = null;
            void execute();
            return true;
        },
        status
    });
    return controller;
}

function getRuntimeStatus() {
    let running = 0;
    let scheduled = 0;
    let failures = 0;
    for (const loop of activeLoops) {
        const status = loop.status();
        if (status.running) running += 1;
        if (status.scheduled) scheduled += 1;
        failures += status.failures;
    }
    return Object.freeze({ active: activeLoops.size, running, scheduled, failures });
}

/** Test-only cleanup for module-global metrics. */
function resetForTests() {
    for (const loop of [...activeLoops]) loop.stop();
}

module.exports = Object.freeze({ create, getRuntimeStatus, resetForTests });
