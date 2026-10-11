// @ts-check
/* Pure, fail-closed projection of parent provider results onto the worker's narrow data contract. */

const MAX_ALIASES = 256;
const MAX_PAGE_ROWS = 100;
const MAX_NAME_CODE_POINTS = 128;
const MAX_REASON_CODE_POINTS = 256;
const MAX_TIME_CHANGED_CODE_POINTS = 256;
const MISSING = Symbol('missing');

class ProviderResponseError extends Error {
    /** @param {'PROVIDER_RESPONSE_INVALID'|'PROVIDER_RESPONSE_TOO_LARGE'} code */
    constructor(code) {
        super(code === 'PROVIDER_RESPONSE_TOO_LARGE' ?
            'Player scan provider response exceeded its limit.' :
            'Player scan provider response is invalid.');
        this.name = 'ProviderResponseError';
        this.code = code;
    }
}

/** @returns {never} */
function invalid() {
    throw new ProviderResponseError('PROVIDER_RESPONSE_INVALID');
}

/** @returns {never} */
function tooLarge() {
    throw new ProviderResponseError('PROVIDER_RESPONSE_TOO_LARGE');
}

/** @param {unknown} value @returns {Record<string,unknown>} */
function objectValue(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    return /** @type {Record<string,unknown>} */ (value);
}

/**
 * Read only an explicitly whitelisted own data property. Accessors are rejected without being invoked, and
 * unknown properties are never enumerated or read.
 * @param {Record<string,unknown>} object @param {string} key @param {boolean} [required]
 */
function dataProperty(object, key, required = true) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) {
        if (required) invalid();
        return MISSING;
    }
    if (!Object.hasOwn(descriptor, 'value')) invalid();
    return descriptor.value;
}

/** @param {unknown} value @param {number} maximum @returns {string} */
function boundedText(value, maximum) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum * 2 ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) ||
        Array.from(value).length > maximum) invalid();
    return value;
}

/** @param {unknown} value @returns {string} */
function steamId(value) {
    if (typeof value !== 'string' || !/^7656119\d{10}$/u.test(value)) invalid();
    return value;
}

/** @param {unknown} value @returns {string} */
function battlemetricsId(value) {
    if (typeof value !== 'string' || !/^\d{1,32}$/u.test(value)) invalid();
    return value;
}

/** @param {unknown} value @returns {string} */
function isoTimestamp(value) {
    if (typeof value !== 'string' || value.length > 64) invalid();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) invalid();
    return value;
}

/** @param {unknown} value @returns {string|null} */
function optionalTimestamp(value) {
    return value === null ? null : isoTimestamp(value);
}

/** @param {unknown} value @returns {number} */
function nonNegativeNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid();
    return value;
}

/**
 * Iterate a bounded dense array through data descriptors so an indexed accessor is never invoked.
 * @param {unknown} value @param {number} maximum @param {(value:unknown,index:number)=>unknown} callback
 */
function boundedArray(value, maximum, callback) {
    if (!Array.isArray(value)) invalid();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) invalid();
    const length = /** @type {number} */ (lengthDescriptor.value);
    if (length > maximum) tooLarge();
    const result = new Array(length);
    for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
        result[index] = callback(descriptor.value, index);
    }
    return result;
}

/** @param {Record<string,unknown>} object */
function nullableReason(object) {
    const value = dataProperty(object, 'reason', false);
    if (value === MISSING || value === null) return null;
    invalid();
}

/** @param {Record<string,unknown>} object */
function failedResponse(object) {
    const reason = boundedText(dataProperty(object, 'reason'), MAX_REASON_CODE_POINTS);
    /** @type {{available:false,reason:string,retryAt?:string|null,cooldownUntil?:string|null}} */
    const result = { available: false, reason };
    const retryAt = dataProperty(object, 'retryAt', false);
    if (retryAt !== MISSING) result.retryAt = optionalTimestamp(retryAt);
    const cooldownUntil = dataProperty(object, 'cooldownUntil', false);
    if (cooldownUntil !== MISSING) result.cooldownUntil = optionalTimestamp(cooldownUntil);
    return Object.freeze(result);
}

/** @param {Record<string,unknown>} object */
function availability(object) {
    const value = dataProperty(object, 'available');
    if (typeof value !== 'boolean') invalid();
    return value;
}

/** @param {unknown} raw @param {string} requestedSteamId */
function steamProfile(raw, requestedSteamId) {
    steamId(requestedSteamId);
    if (raw === null) return null;
    const object = objectValue(raw);
    const projectedSteamId = steamId(dataProperty(object, 'steamId'));
    if (projectedSteamId !== requestedSteamId) invalid();
    const currentName = boundedText(dataProperty(object, 'currentName'), MAX_NAME_CODE_POINTS);
    const aliasesComplete = dataProperty(object, 'aliasesComplete');
    if (typeof aliasesComplete !== 'boolean') invalid();
    const pastAliases = boundedArray(dataProperty(object, 'pastAliases'), MAX_ALIASES, value => {
        const alias = objectValue(value);
        const name = boundedText(dataProperty(alias, 'name'), MAX_NAME_CODE_POINTS);
        const timeChangedValue = dataProperty(alias, 'timeChanged');
        const timeChanged = timeChangedValue === null ? null :
            boundedText(timeChangedValue, MAX_TIME_CHANGED_CODE_POINTS);
        return Object.freeze({ name, timeChanged });
    });
    return Object.freeze({
        steamId: projectedSteamId,
        currentName,
        pastAliases: Object.freeze(pastAliases),
        aliasesComplete
    });
}

/** @param {unknown} raw @param {string} requestedBattlemetricsId */
function battlemetricsResolution(raw, requestedBattlemetricsId) {
    battlemetricsId(requestedBattlemetricsId);
    const object = objectValue(raw);
    if (!availability(object)) return failedResponse(object);
    const reason = nullableReason(object);
    const rawSteamId = dataProperty(object, 'steamId');
    const projectedSteamId = rawSteamId === null ? null : steamId(rawSteamId);
    return Object.freeze({ available: true, reason, steamId: projectedSteamId });
}

/** @param {unknown} raw @param {boolean} includeAliases */
function warBanditsPlayer(raw, includeAliases) {
    const object = objectValue(raw);
    const projectedSteamId = steamId(dataProperty(object, 'steamId'));
    const name = boundedText(dataProperty(object, 'name'), MAX_NAME_CODE_POINTS);
    const playtime = nonNegativeNumber(dataProperty(object, 'playtime'));
    if (!includeAliases) return Object.freeze({ steamId: projectedSteamId, name, playtime });
    const aliases = boundedArray(dataProperty(object, 'aliases'), MAX_ALIASES, value =>
        boundedText(value, MAX_NAME_CODE_POINTS));
    return Object.freeze({ steamId: projectedSteamId, name,
        aliases: Object.freeze(aliases), playtime });
}

/** @param {unknown} raw @param {string} query */
function warBanditsLookup(raw, query) {
    boundedText(query, 64);
    const object = objectValue(raw);
    if (!availability(object)) return failedResponse(object);
    const reason = nullableReason(object);
    const ambiguous = dataProperty(object, 'ambiguous');
    const truncated = dataProperty(object, 'truncated');
    if (typeof ambiguous !== 'boolean' || typeof truncated !== 'boolean') invalid();
    const rawPlayer = dataProperty(object, 'player');
    const player = rawPlayer === null ? null : warBanditsPlayer(rawPlayer, true);
    if ((ambiguous || truncated) && player !== null) invalid();
    if (truncated && !ambiguous) invalid();
    if (player && /^7656119\d{10}$/u.test(query) && player.steamId !== query) invalid();
    const observedAt = isoTimestamp(dataProperty(object, 'observedAt'));
    return Object.freeze({ available: true, reason, player, ambiguous, truncated, observedAt });
}

/** @param {unknown} raw @param {number} requestedPage */
function warBanditsPage(raw, requestedPage) {
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 1000000) invalid();
    const object = objectValue(raw);
    if (!availability(object)) return failedResponse(object);
    const reason = nullableReason(object);
    const page = dataProperty(object, 'page');
    const pageSize = dataProperty(object, 'pageSize');
    const nextPage = dataProperty(object, 'nextPage');
    const complete = dataProperty(object, 'complete');
    if (page !== requestedPage || !Number.isSafeInteger(pageSize) || pageSize < 1 ||
        pageSize > MAX_PAGE_ROWS || typeof complete !== 'boolean') invalid();
    if ((complete && nextPage !== null) || (!complete && nextPage !== requestedPage + 1)) invalid();
    const rows = boundedArray(dataProperty(object, 'rows'), MAX_PAGE_ROWS, value =>
        warBanditsPlayer(value, false));
    if (rows.length > pageSize || (!complete && rows.length !== pageSize)) invalid();
    const observedAt = isoTimestamp(dataProperty(object, 'observedAt'));
    return Object.freeze({
        available: true,
        reason,
        page,
        pageSize,
        nextPage,
        complete,
        observedAt,
        rows: Object.freeze(rows)
    });
}

/**
 * Copy one provider response into a small, deeply data-only object understood by the scan worker.
 * Unsupported method tuples and malformed provider values fail with a fixed, non-sensitive error.
 * @param {unknown} provider @param {unknown} method @param {unknown} requestedArg @param {unknown} raw
 */
function project(provider, method, requestedArg, raw) {
    if (provider === 'steam' && method === 'profileIdentity') {
        if (typeof requestedArg !== 'string') invalid();
        return steamProfile(raw, requestedArg);
    }
    if (provider === 'battlemetrics' && method === 'resolveSteamId') {
        if (typeof requestedArg !== 'string') invalid();
        return battlemetricsResolution(raw, requestedArg);
    }
    if (provider === 'warbandits' &&
        (method === 'resolvePlayerRecent' || method === 'resolvePlayer')) {
        if (typeof requestedArg !== 'string') invalid();
        return warBanditsLookup(raw, requestedArg);
    }
    if (provider === 'warbandits' && method === 'scanCurrentWipePage') {
        if (typeof requestedArg !== 'number') invalid();
        return warBanditsPage(raw, requestedArg);
    }
    invalid();
}

module.exports = Object.freeze({
    MAX_ALIASES,
    MAX_PAGE_ROWS,
    ProviderResponseError,
    project
});
