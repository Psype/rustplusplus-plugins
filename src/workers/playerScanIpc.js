// @ts-check

const FINAL_SEND_FAILURE_MARKER = 'RPP_PLAYER_SCAN_FINAL_IPC_FAILURE';
const FINAL_SEND_FAILURE_EXIT_CODE = 74;
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;

/** @param {unknown} error @param {string} fallback */
function asError(error, fallback) {
    return error instanceof Error ? error : new Error(fallback);
}

/**
 * Send one worker message while preserving the asynchronous delivery error. Callers that do not care about
 * best-effort progress messages may omit the callback; final messages must use sendFinal instead.
 * @param {any} target
 * @param {any} message
 * @param {(error:Error|null)=>void} [callback]
 */
function send(target, message, callback) {
    let settled = false;
    /** @param {unknown} [error] */
    const finish = error => {
        if (settled) return;
        settled = true;
        if (callback) callback(error ? asError(error, 'Player scan IPC delivery failed.') : null);
    };
    if (!target || typeof target.send !== 'function' || target.connected !== true) {
        finish(new Error('Player scan IPC channel is unavailable.'));
        return false;
    }
    try {
        return target.send(message, (/** @type {unknown} */ error) => finish(error));
    }
    catch (error) {
        finish(error);
        return false;
    }
}

/**
 * Register a request before sending it so a synchronous transport failure cannot strand its promise. The
 * rejection is deliberately fixed: IPC callback details can contain provider payloads or local paths.
 * @param {any} target
 * @param {Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void}>} pending
 * @param {{callId:number,[key:string]:any}} message
 */
function request(target, pending, message) {
    return new Promise((resolve, reject) => {
        const call = { resolve, reject };
        pending.set(message.callId, call);
        send(target, message, error => {
            if (!error || pending.get(message.callId) !== call) return;
            pending.delete(message.callId);
            reject(new Error('Player scan provider IPC request could not be delivered.'));
        });
    });
}

/**
 * Count the UTF-8 bytes used by JSON.stringify for a string without materializing its escaped representation.
 * Returning limit + 1 allows callers to stop walking an oversized value immediately.
 * @param {string} value @param {number} limit
 */
function jsonStringByteLength(value, limit) {
    let bytes = 2; // Opening and closing quotes.
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a ||
            code === 0x0c || code === 0x0d) bytes += 2;
        else if (code <= 0x1f) bytes += 6;
        else if (code >= 0xd800 && code <= 0xdbff) {
            const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                index += 1;
            }
            else bytes += 6;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
        else if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else bytes += 3;
        if (bytes > limit) return limit + 1;
    }
    return bytes;
}

/**
 * Compute an exact JSON byte size for the plain data emitted by the scan planner. The walk is bounded by the
 * supplied byte limit and rejects accessors, exotic prototypes, unsupported values, cycles and excessive depth
 * instead of invoking application code or constructing an oversized JSON string in the worker.
 * @param {unknown} value @param {number} limit
 */
function boundedJsonByteLength(value, limit) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('JSON byte limit is invalid.');
    let bytes = 0;
    const active = new WeakSet();
    /** @param {number} count */
    const add = count => {
        bytes += count;
        if (bytes > limit) throw new RangeError('JSON value exceeds its byte limit.');
    };
    /** @param {unknown} current @param {number} depth */
    const visit = (current, depth) => {
        if (depth > MAX_JSON_DEPTH) throw new TypeError('JSON value is nested too deeply.');
        if (current === null) {
            add(4);
            return;
        }
        if (typeof current === 'string') {
            add(jsonStringByteLength(current, limit - bytes));
            return;
        }
        if (typeof current === 'boolean') {
            add(current ? 4 : 5);
            return;
        }
        if (typeof current === 'number') {
            add(Number.isFinite(current) ? /** @type {string} */ (JSON.stringify(current)).length : 4);
            return;
        }
        if (typeof current !== 'object') throw new TypeError('JSON value contains an unsupported type.');
        const object = /** @type {Record<string, unknown>} */ (current);
        if (active.has(object)) throw new TypeError('JSON value contains a cycle.');
        active.add(object);
        try {
            if (Array.isArray(object)) {
                // Every JSON array element needs at least one byte plus its separator. Reject pathological sparse
                // arrays before iterating millions of holes.
                if (object.length > 0 && object.length * 2 + 1 > limit - bytes) {
                    throw new RangeError('JSON value exceeds its byte limit.');
                }
                add(1);
                for (let index = 0; index < object.length; index += 1) {
                    if (index > 0) add(1);
                    if (!Object.hasOwn(object, index)) throw new TypeError('JSON value contains a sparse array.');
                    const descriptor = Object.getOwnPropertyDescriptor(object, `${index}`);
                    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                        throw new TypeError('JSON value contains an accessor.');
                    }
                    visit(descriptor.value, depth + 1);
                }
                add(1);
                return;
            }
            const prototype = Object.getPrototypeOf(object);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new TypeError('JSON value contains a non-plain object.');
            }
            add(1);
            const keys = Object.keys(object);
            for (let index = 0; index < keys.length; index += 1) {
                const key = keys[index];
                const descriptor = Object.getOwnPropertyDescriptor(object, key);
                if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                    throw new TypeError('JSON value contains an accessor.');
                }
                if (index > 0) add(1);
                add(jsonStringByteLength(key, limit - bytes));
                add(1);
                visit(descriptor.value, depth + 1);
            }
            add(1);
        }
        finally { active.delete(object); }
    };
    visit(value, 0);
    return bytes;
}

/** @param {any} target @param {Error|null} error */
function finishFinalSend(target, error) {
    if (error) {
        target.exitCode = FINAL_SEND_FAILURE_EXIT_CODE;
        try {
            // A fixed marker lets the parent diagnose the transport without leaking the plan or provider data.
            target.stderr.write(`${FINAL_SEND_FAILURE_MARKER}\n`);
        }
        catch (_error) { /* The non-zero exit still reports a failed delivery. */ }
    }
    if (target.connected === true && typeof target.disconnect === 'function') {
        try { target.disconnect(); }
        catch (_error) { target.exitCode = FINAL_SEND_FAILURE_EXIT_CODE; }
    }
}

/** @param {any} target @param {any} message */
function sendFinal(target, message) {
    return send(target, message, error => finishFinalSend(target, error));
}

/** @param {any} target @param {unknown} plan */
function sendPlan(target, plan) {
    try {
        boundedJsonByteLength(plan, MAX_PLAN_BYTES);
    }
    catch (_error) {
        return sendFinal(target, { v: 1, type: 'failure', code: 'PLAN_TOO_LARGE',
            message: 'Player scan worker plan exceeded its limit.' });
    }
    return sendFinal(target, { v: 1, type: 'result', plan });
}

module.exports = Object.freeze({
    FINAL_SEND_FAILURE_EXIT_CODE,
    FINAL_SEND_FAILURE_MARKER,
    MAX_PLAN_BYTES,
    boundedJsonByteLength,
    request,
    send,
    sendFinal,
    sendPlan
});
