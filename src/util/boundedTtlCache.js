// @ts-check

const MAX_CONFIGURED_ENTRIES = 1000000;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** @param {unknown} value @param {string} label @param {number} maximum */
function positiveInteger(value, label, maximum) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
        throw new TypeError(`${label} must be an integer between 1 and ${maximum}.`);
    }
    return number;
}

/**
 * In-memory cache for rebuildable/provider data only. Expiry is absolute; reads update LRU order but never extend TTL.
 * @param {{maxEntries:number,defaultTtlMs:number,now?:()=>number}} options
 */
function createBoundedTtlCache(options) {
    if (!options || typeof options !== 'object') throw new TypeError('Bounded cache options are required.');
    const maxEntries = positiveInteger(options.maxEntries, 'Bounded cache maxEntries', MAX_CONFIGURED_ENTRIES);
    const defaultTtlMs = positiveInteger(options.defaultTtlMs, 'Bounded cache defaultTtlMs', MAX_TTL_MS);
    const now = options.now || (() => Date.now());
    if (typeof now !== 'function') throw new TypeError('Bounded cache clock must be a function.');
    /** @type {Map<any,{value:any,expiresAt:number}>} */
    const entries = new Map();

    /** @param {unknown} [supplied] */
    function currentTime(supplied) {
        const value = supplied === undefined ? Number(now()) : Number(supplied);
        if (!Number.isFinite(value) || value < 0) throw new TypeError('Bounded cache clock is invalid.');
        return value;
    }

    /** @param {number} at */
    function pruneAt(at) {
        let removed = 0;
        for (const [key, entry] of entries) {
            if (entry.expiresAt > at) continue;
            entries.delete(key);
            removed += 1;
        }
        return removed;
    }

    /** @param {any} key @param {number} [at] */
    function get(key, at) {
        const current = currentTime(at);
        const entry = entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= current) {
            entries.delete(key);
            return undefined;
        }
        entries.delete(key);
        entries.set(key, entry);
        return entry.value;
    }

    /** @param {any} key @param {any} value @param {number} [ttlMs] @param {number} [at] */
    function set(key, value, ttlMs = defaultTtlMs, at) {
        const ttl = positiveInteger(ttlMs, 'Bounded cache ttlMs', MAX_TTL_MS);
        const current = currentTime(at);
        pruneAt(current);
        entries.delete(key);
        while (entries.size >= maxEntries) {
            const oldest = entries.keys().next();
            if (oldest.done) break;
            entries.delete(oldest.value);
        }
        entries.set(key, { value, expiresAt: Math.min(Number.MAX_SAFE_INTEGER, current + ttl) });
        return value;
    }

    const cache = {
        clear() { entries.clear(); },
        /** @param {number} [at] */
        count(at) {
            pruneAt(currentTime(at));
            return entries.size;
        },
        /** @param {any} key */
        delete(key) { return entries.delete(key); },
        get,
        /** @param {any} key @param {number} [at] */
        has(key, at) { return get(key, at) !== undefined; },
        /** @param {number} [at] */
        prune(at) { return pruneAt(currentTime(at)); },
        set,
        get maxEntries() { return maxEntries; },
        get size() {
            return cache.count();
        }
    };
    return Object.freeze(cache);
}

module.exports = Object.freeze({ createBoundedTtlCache });
