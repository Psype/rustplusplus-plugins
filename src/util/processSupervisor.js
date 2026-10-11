const ChildProcess = require('node:child_process');

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const CIRCUIT_COOLDOWN_MS = 60 * 1000;

class IsolatedServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'IsolatedServiceError';
        this.code = code;
        if (Array.isArray(details.failures)) this.failures = details.failures;
    }
}

function byteLength(value) {
    try { return Buffer.byteLength(JSON.stringify(value)); }
    catch (_error) { return Number.POSITIVE_INFINITY; }
}

function safeError(error) {
    const text = error instanceof Error ? error.message : `${error || 'unknown error'}`;
    return text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300) ||
        'unknown error';
}

/**
 * Supervise one optional service process. Requests are serialized so a blocked provider cannot create unbounded work.
 * @param {{name:string,modulePath:string,timeoutMs:number,maxQueue:number,maxOldSpaceMiB?:number,
 * forkImpl?:Function,now?:()=>number,setTimeoutImpl?:Function,clearTimeoutImpl?:Function}} options
 */
function create(options) {
    if (!options || typeof options !== 'object') throw new TypeError('Supervisor options are required.');
    if (typeof options.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(options.name)) {
        throw new TypeError('Supervisor name is invalid.');
    }
    if (typeof options.modulePath !== 'string' || options.modulePath.trim() === '') {
        throw new TypeError('Supervisor module path is required.');
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 10 * 60 * 1000) {
        throw new TypeError('Supervisor timeout is invalid.');
    }
    if (!Number.isSafeInteger(options.maxQueue) || options.maxQueue < 0 || options.maxQueue > 100) {
        throw new TypeError('Supervisor queue limit is invalid.');
    }
    const forkImpl = options.forkImpl || ChildProcess.fork;
    const now = options.now || Date.now;
    const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
    const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
    const heapMiB = Number.isSafeInteger(options.maxOldSpaceMiB) ? options.maxOldSpaceMiB : 128;
    const maxRequestBytes = Number.isSafeInteger(options.maxRequestBytes) ? options.maxRequestBytes : MAX_REQUEST_BYTES;
    const maxResponseBytes = Number.isSafeInteger(options.maxResponseBytes) ?
        options.maxResponseBytes : MAX_RESPONSE_BYTES;
    if (maxRequestBytes < 1024 || maxRequestBytes > 32 * 1024 * 1024 ||
        maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) {
        throw new TypeError('Supervisor IPC size limits are invalid.');
    }
    let child = null;
    let active = null;
    let stopped = false;
    let nextId = 1;
    let restarts = 0;
    let completed = 0;
    let failures = 0;
    let circuitUntil = 0;
    let crashes = [];
    const queue = [];

    const status = () => Object.freeze({
        active: active ? 1 : 0,
        queued: queue.length,
        queuedBytes: queue.reduce((total, job) => total + job.bytes, 0),
        running: child ? 1 : 0,
        restarts,
        failures,
        circuitOpen: circuitUntil > now() ? 1 : 0,
        completed
    });

    const serviceError = (code, message, details) => new IsolatedServiceError(code, message, details);

    function recordCrash() {
        const current = now();
        crashes = crashes.filter(value => current - value <= CRASH_WINDOW_MS);
        crashes.push(current);
        restarts += 1;
        if (crashes.length >= 5) circuitUntil = current + CIRCUIT_COOLDOWN_MS;
    }

    function rejectActive(error) {
        if (!active) return;
        const current = active;
        active = null;
        if (current.timer !== null) clearTimeoutImpl(current.timer);
        failures += 1;
        current.reject(error);
    }

    function detach(current) {
        if (!current || typeof current.removeAllListeners !== 'function') return;
        current.removeAllListeners('message');
        current.removeAllListeners('error');
        current.removeAllListeners('exit');
    }

    function loseChild(current, reason, crash = true) {
        if (child !== current) return;
        child = null;
        detach(current);
        if (crash && !stopped) recordCrash();
        rejectActive(serviceError('SERVICE_EXITED', `${options.name} service stopped: ${reason}`));
        queueMicrotask(drain);
    }

    function spawn() {
        if (stopped) throw serviceError('SERVICE_STOPPED', `${options.name} service is stopped.`);
        if (circuitUntil > now()) {
            throw serviceError('CIRCUIT_OPEN', `${options.name} service circuit is temporarily open.`);
        }
        let spawned;
        try {
            spawned = forkImpl(options.modulePath, [], {
                execArgv: [`--max-old-space-size=${heapMiB}`],
                serialization: 'json',
                stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                windowsHide: true
            });
        }
        catch (error) {
            recordCrash();
            throw serviceError('SPAWN_FAILED', `${options.name} service could not start: ${safeError(error)}`);
        }
        child = spawned;
        spawned.on('message', message => onMessage(spawned, message));
        spawned.on('error', error => loseChild(spawned, safeError(error)));
        spawned.on('exit', (code, signal) => loseChild(spawned, `exit=${code ?? '-'} signal=${signal || '-'}`));
        return spawned;
    }

    function onMessage(sender, message) {
        if (sender !== child || !active || !message || typeof message !== 'object' || message.v !== 1 ||
            message.type !== 'response' || message.id !== active.id) return;
        if (byteLength(message) > maxResponseBytes) {
            const error = serviceError('RESPONSE_TOO_LARGE', `${options.name} response exceeded its limit.`);
            const current = child;
            rejectActive(error);
            if (current && typeof current.kill === 'function') current.kill();
            if (child === current) loseChild(current, 'oversized response');
            return;
        }
        const current = active;
        active = null;
        if (current.timer !== null) clearTimeoutImpl(current.timer);
        if (message.ok === true) {
            completed += 1;
            current.resolve(message.result);
        }
        else {
            failures += 1;
            const remote = message.error && typeof message.error === 'object' ? message.error : {};
            current.reject(serviceError(`${remote.code || 'REMOTE_FAILURE'}`,
                safeError(remote.message || `${options.name} request failed.`), remote));
        }
        queueMicrotask(drain);
    }

    function execute(job) {
        let service;
        try { service = child || spawn(); }
        catch (error) {
            failures += 1;
            job.reject(error);
            queueMicrotask(drain);
            return;
        }
        active = job;
        job.timer = setTimeoutImpl(() => {
            if (active !== job) return;
            rejectActive(serviceError('SERVICE_TIMEOUT', `${options.name} request timed out.`));
            const current = child;
            if (current && typeof current.kill === 'function') current.kill();
            if (child === current) loseChild(current, 'timeout');
        }, options.timeoutMs);
        if (job.timer && typeof job.timer.unref === 'function') job.timer.unref();
        try {
            service.send({ v: 1, type: 'request', id: job.id, method: job.method, payload: job.payload }, error => {
                if (error) loseChild(service, `send failed: ${safeError(error)}`);
            });
        }
        catch (error) {
            loseChild(service, `send failed: ${safeError(error)}`);
        }
    }

    function drain() {
        if (stopped || active || queue.length === 0) return;
        execute(queue.shift());
    }

    function request(method, payload) {
        if (stopped) return Promise.reject(serviceError('SERVICE_STOPPED', `${options.name} service is stopped.`));
        if (typeof method !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/u.test(method)) {
            return Promise.reject(new TypeError('Service method is invalid.'));
        }
        if (byteLength(payload) > maxRequestBytes) {
            return Promise.reject(serviceError('REQUEST_TOO_LARGE', `${options.name} request exceeded its limit.`));
        }
        if (active && queue.length >= options.maxQueue) {
            failures += 1;
            return Promise.reject(serviceError('QUEUE_FULL', `${options.name} service queue is full.`));
        }
        return new Promise((resolve, reject) => {
            const job = { id: nextId++, method, payload, bytes: byteLength(payload), resolve, reject, timer: null };
            if (!active) execute(job);
            else queue.push(job);
        });
    }

    function stop() {
        if (stopped) return false;
        stopped = true;
        rejectActive(serviceError('SERVICE_STOPPED', `${options.name} service is stopping.`));
        while (queue.length > 0) queue.shift().reject(
            serviceError('SERVICE_STOPPED', `${options.name} service is stopping.`));
        const current = child;
        child = null;
        if (current) {
            detach(current);
            try {
                if (typeof current.connected === 'boolean' && current.connected && typeof current.send === 'function') {
                    current.send({ v: 1, type: 'shutdown' });
                }
                if (typeof current.kill === 'function') current.kill();
            }
            catch (_error) { /* Shutdown remains best effort. */ }
        }
        return true;
    }

    return Object.freeze({ request, status, stop });
}

module.exports = Object.freeze({ create, IsolatedServiceError });
