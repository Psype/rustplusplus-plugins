// @ts-check
const { similarity } = require('./nameSimilarity.js');

const STEAM_ID_MIN = 76561197960265728n;
const STEAM_ID_MAX = 76561202255233023n;
const MAX_PROFILE_LOOKUPS = 100;
const PROFILE_CONCURRENCY = 2;
const EXACT_ID_PROFILE_MIN_CONFIDENCE = 80;
const CONSENSUS_ID_MIN_CONFIDENCE = 60;

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

/** @param {unknown} value */
function compactName(value) {
    return Array.from(cleanName(value).normalize('NFKC').toLocaleLowerCase('en'))
        .filter(character => /[\p{L}\p{N}]/u.test(character));
}

/** @param {readonly string[]} left @param {readonly string[]} right */
function longestCommonRun(left, right) {
    let best = 0;
    let previous = Array(right.length + 1).fill(0);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = Array(right.length + 1).fill(0);
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
            current[rightIndex] = previous[rightIndex - 1] + 1;
            best = Math.max(best, current[rightIndex]);
        }
        previous = current;
    }
    return best;
}

/**
 * F7 decorations may be destroyed while a long inner name remains intact. This score is only used against an alias
 * already tied to the same SteamID; it never retrieves another identity.
 * @param {string} observed @param {string} candidate
 */
function f7NameScore(observed, candidate) {
    const base = similarity(observed, candidate);
    const left = compactName(observed);
    const right = compactName(candidate);
    const shortest = Math.min(left.length, right.length);
    const longest = Math.max(left.length, right.length);
    if (shortest < 6 || longest === 0) return base;
    const run = longestCommonRun(left, right);
    if (run < 6 || run / shortest < 0.7 || run / longest < 0.6) return base;
    return Math.max(base, run / shortest);
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
                    f7NameScore(name, alias) >= requiredNameScore(name))));
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
        const recovered = [];
        const consensusOnly = [];
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
                const exactConsensusId = entry.idOcrCorrected !== true && entry.idOcrPasses >= 2 &&
                    typeof entry.idOcrConfidence === 'number' &&
                    entry.idOcrConfidence >= CONSENSUS_ID_MIN_CONFIDENCE && entry.ambiguous !== true;
                if (exactConsensusId) {
                    accepted.push(Object.freeze({ ...entry, visualMemberIndex,
                        identityConfidence: 'probable', ocrConsensusOnly: true }));
                    consensusOnly.push(`${entry.steamId}${entry.name ? ` — ${entry.name}` : ''}`);
                    continue;
                }
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
                ({ name, observed, score: f7NameScore(observed, name) })))
                .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
            if (ranked[0].score < requiredNameScore(ranked[0].observed)) {
                const profile = cleanName(profiles.get(entry.steamId));
                const exactHighConfidenceId = entry.idOcrCorrected !== true &&
                    typeof entry.idOcrConfidence === 'number' &&
                    entry.idOcrConfidence >= EXACT_ID_PROFILE_MIN_CONFIDENCE;
                if (profile && exactHighConfidenceId && entry.ambiguous !== true && entry.name) {
                    const score = similarity(entry.name, profile);
                    accepted.push(Object.freeze({ ...entry, visualMemberIndex,
                        ocrObservedName: entry.name, name: profile, caseFidelity: true,
                        ambiguous: false, alternatives: Object.freeze([]), profileNameRecovered: true,
                        verificationScore: Number(score.toFixed(6)) }));
                    recovered.push(`${entry.steamId}: OCR "${entry.name}" -> Steam "${profile}"`);
                    continue;
                }
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
        if (recovered.length > 0) errors.push(`${recovered.length} F7 name(s) recovered from an exact high-confidence ` +
            `SteamID: ${recovered.slice(0, 3).join('; ')}${recovered.length > 3 ? '; ...' : ''}.`);
        if (consensusOnly.length > 0) errors.push(`${consensusOnly.length} F7 row(s) retained as probable from ` +
            `independent OCR-pass agreement while Steam was unavailable: ${consensusOnly.slice(0, 3).join('; ')}${
                consensusOnly.length > 3 ? '; ...' : ''}.`);
        if (accepted.length === 0) errors.push('No Steam-verified F7 row remains.');
        return Object.freeze({ ...item, parsed: Object.freeze({ ...item.parsed,
            entries: Object.freeze(accepted), rejectedIdentityRows: Object.freeze(rejected),
            complete: accepted.length > 0, errors: Object.freeze(errors) }) });
    }));
}

module.exports = Object.freeze({
    CONSENSUS_ID_MIN_CONFIDENCE,
    EXACT_ID_PROFILE_MIN_CONFIDENCE,
    f7NameScore,
    MAX_PROFILE_LOOKUPS,
    PROFILE_CONCURRENCY,
    STEAM_ID_MAX,
    STEAM_ID_MIN,
    isValidSteamId64,
    normalizeSteamIdOcr,
    requiredNameScore,
    verify
});
