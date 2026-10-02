// @ts-check
const { similarity } = require('./nameSimilarity.js');

const STEAM_ID_MIN = 76561197960265728n;
const STEAM_ID_MAX = 76561202255233023n;
const MAX_PROFILE_LOOKUPS = 100;
const PROFILE_CONCURRENCY = 4;

/** @param {unknown} value */
function cleanName(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {unknown} value */
function isValidSteamId64(value) {
    const text = `${value || ''}`;
    if (!/^7656119\d{10}$/u.test(text)) return false;
    const numeric = BigInt(text);
    return numeric >= STEAM_ID_MIN && numeric <= STEAM_ID_MAX;
}

/**
 * Repairs only common OCR substitutions inside an otherwise numeric 17-character candidate.
 * Validity is still checked against the Steam individual-account range and later against the profile name.
 * @param {unknown} value
 */
function normalizeSteamIdOcr(value) {
    const compact = `${value || ''}`.normalize('NFKC').replace(/[\s.,:_-]+/gu, '');
    if (!/^[0-9OoIl|SB]{17}$/u.test(compact)) return null;
    /** @type {Readonly<Record<string,string>>} */
    const replacements = Object.freeze({ O: '0', o: '0', I: '1', l: '1', '|': '1', S: '5', B: '8' });
    let corrections = 0;
    const steamId = Array.from(compact).map(character => {
        const replacement = replacements[character];
        if (replacement !== undefined) corrections += 1;
        return replacement === undefined ? character : replacement;
    }).join('');
    return corrections <= 2 && isValidSteamId64(steamId) ? Object.freeze({ steamId, corrections }) : null;
}

/** @param {string} observed */
function requiredNameScore(observed) {
    const length = Array.from(observed.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '')).length;
    return length <= 3 ? 0.92 : length <= 5 ? 0.84 : 0.72;
}

/** @param {readonly any[]} values @param {number} concurrency @param {(value:any)=>Promise<any>} operation */
async function boundedMap(values, concurrency, operation) {
    const results = Array(values.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (cursor < values.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await operation(values[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Verifies F7 geometry-derived pairs against aliases already tied to the SteamID and the current Steam persona.
 * A mismatch removes that row; it never guesses another SteamID or silently commits a weak association.
 * @param {readonly any[]} items @param {readonly any[]} knownCandidates
 * @param {(steamId:string)=>Promise<unknown>} profileName
 */
async function verify(items, knownCandidates, profileName) {
    if (!Array.isArray(items) || !Array.isArray(knownCandidates) || typeof profileName !== 'function') {
        throw new TypeError('F7 identity verification input is invalid.');
    }
    const knownBySteam = new Map();
    for (const candidate of knownCandidates) {
        if (!isValidSteamId64(candidate && candidate.steamId)) continue;
        const name = cleanName(candidate.name);
        if (!name) continue;
        const values = knownBySteam.get(`${candidate.steamId}`) || [];
        values.push(name);
        knownBySteam.set(`${candidate.steamId}`, values);
    }
    const steamIds = [...new Set(items.flatMap(item => item.parsed && item.parsed.kind === 'f7' ?
        item.parsed.entries.filter((/** @type {any} */ entry) => {
            const aliases = knownBySteam.get(`${entry.steamId || ''}`) || [];
            const observed = entry.name ? [entry.name] : entry.ambiguous ? entry.alternatives || [] : [];
            return aliases.length === 0 || (observed.length > 0 && !observed.some((/** @type {string} */ name) =>
                aliases.some((/** @type {string} */ alias) =>
                    similarity(name, alias) >= requiredNameScore(name))));
        }).map((/** @type {any} */ entry) => `${entry.steamId || ''}`) : []))]
        .filter(isValidSteamId64).slice(0, MAX_PROFILE_LOOKUPS);
    const profiles = new Map();
    await boundedMap(steamIds, PROFILE_CONCURRENCY, async steamId => {
        try {
            const name = cleanName(await profileName(steamId));
            profiles.set(steamId, name || null);
        }
        catch {
            profiles.set(steamId, null);
        }
    });

    return Object.freeze(items.map(item => {
        if (!item.parsed || item.parsed.kind !== 'f7') return item;
        const accepted = [];
        const rejected = [];
        for (let entryIndex = 0; entryIndex < item.parsed.entries.length; entryIndex += 1) {
            const entry = item.parsed.entries[entryIndex];
            const visualMemberIndex = Number.isSafeInteger(entry.visualMemberIndex) ?
                entry.visualMemberIndex : entryIndex;
            if (!isValidSteamId64(entry.steamId)) {
                rejected.push(`${entry.steamId || 'unread'}: invalid SteamID64`);
                continue;
            }
            const aliases = [...new Set([profiles.get(entry.steamId), ...(knownBySteam.get(entry.steamId) || [])]
                .map(cleanName).filter(Boolean))];
            if (aliases.length === 0) {
                rejected.push(`${entry.steamId}: Steam profile unavailable`);
                continue;
            }
            const observedNames = entry.name ? [entry.name] : entry.ambiguous ? entry.alternatives || [] : [];
            if (observedNames.length === 0) {
                accepted.push(Object.freeze({ ...entry, visualMemberIndex, name: aliases[0], caseFidelity: true,
                    ambiguous: false, alternatives: Object.freeze([]),
                    verificationScore: 1 }));
                continue;
            }
            const ranked = aliases.flatMap(name => observedNames.map((/** @type {string} */ observed) =>
                ({ name, observed, score: similarity(observed, name) })))
                .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
            if (ranked[0].score < requiredNameScore(ranked[0].observed)) {
                rejected.push(`${entry.steamId}: OCR "${ranked[0].observed}" does not match Steam "${
                    ranked[0].name}"`);
                continue;
            }
            accepted.push(Object.freeze({ ...entry, visualMemberIndex, ocrObservedName: ranked[0].observed,
                name: ranked[0].name,
                caseFidelity: true, ambiguous: false, alternatives: Object.freeze([]),
                verificationScore: Number(ranked[0].score.toFixed(6)) }));
        }
        const errors = [...item.parsed.errors.filter((/** @type {string} */ error) =>
            !['No complete SteamID64 found.', 'At least one name association is ambiguous.'].includes(error))];
        if (rejected.length > 0) errors.push(`${rejected.length} F7 row(s) rejected by Steam validation: ${
            rejected.slice(0, 3).join('; ')}${rejected.length > 3 ? '; …' : ''}.`);
        if (accepted.length === 0) errors.push('No Steam-verified F7 row remains.');
        return Object.freeze({ ...item, parsed: Object.freeze({ ...item.parsed,
            entries: Object.freeze(accepted), rejectedIdentityRows: Object.freeze(rejected),
            complete: accepted.length > 0, errors: Object.freeze(errors) }) });
    }));
}

module.exports = Object.freeze({
    MAX_PROFILE_LOOKUPS,
    PROFILE_CONCURRENCY,
    STEAM_ID_MAX,
    STEAM_ID_MIN,
    isValidSteamId64,
    normalizeSteamIdOcr,
    requiredNameScore,
    verify
});
