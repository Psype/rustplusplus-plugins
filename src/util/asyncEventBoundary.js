// @ts-check

const MAX_ERROR_LENGTH = 500;

/** @param {unknown} error */
function formatError(error) {
    const value = error instanceof Error ? `${error.name}: ${error.message}` : `${error || 'unknown error'}`;
    return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
        .slice(0, MAX_ERROR_LENGTH) || 'unknown error';
}

/**
 * EventEmitter ignores returned promises. This boundary always observes a sync throw or rejection.
 * @param {string} label
 * @param {()=>unknown|Promise<unknown>} callback
 * @param {(label:string,error:string)=>void} report
 */
async function run(label, callback, report) {
    try {
        return await callback();
    }
    catch (error) {
        const formatted = formatError(error);
        try { report(label, formatted); }
        catch (_reportError) {
            try { console.error(`${label}: ${formatted}`); }
            catch (_consoleError) { /* Last-resort reporting must not create another fatal error. */ }
        }
        return undefined;
    }
}

/**
 * @param {string} label
 * @param {(...args:any[])=>unknown|Promise<unknown>} callback
 * @param {(label:string,error:string)=>void} report
 */
function listener(label, callback, report) {
    /** @param {any[]} args */
    const guardedListener = (...args) => { void run(label, () => callback(...args), report); };
    return guardedListener;
}

module.exports = Object.freeze({ formatError, listener, run });
