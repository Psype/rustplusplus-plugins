// @ts-check
/* Provider-neutral player-name reconciliation. It ranks candidates but never creates identity evidence. */

const MODE_FIRST = 'first';
const MODE_PRECISE = 'precise';
const MAX_FRAGMENTS = 8;
const MAX_TEXT_LENGTH = 128;

/** @typedef {Readonly<{target:any,key:string,alias:string,quality:number,coverage:number,ordered:boolean,
 * start:number,extraLength:number,priority:number,inputIndex:number}>} Match */

/** @param {unknown} value */
function clean(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {unknown} value */
function normalize(value) {
    return clean(value).normalize('NFKC').toLocaleLowerCase('en');
}

/** @param {unknown} value */
function compact(value) {
    return normalize(value).normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

/** @param {unknown} query */
function queryFragments(query) {
    const raw = Array.isArray(query) ? query : [query];
    if (raw.length < 1 || raw.length > MAX_FRAGMENTS) {
        throw new TypeError(`Player-name query must contain between 1 and ${MAX_FRAGMENTS} fragments.`);
    }
    const fragments = [...new Set(raw.map(clean))];
    if (fragments.some(value => !value || Array.from(value).length > MAX_TEXT_LENGTH)) {
        throw new TypeError('Player-name query fragments must be non-empty bounded strings.');
    }
    return Object.freeze(fragments);
}

/** @param {unknown} value */
function stringArray(value) {
    const source = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
    return Object.freeze([...new Set(source.map(clean).filter(item => item &&
        Array.from(item).length <= MAX_TEXT_LENGTH))]);
}

/** @param {string} alias @param {readonly string[]} fragments */
function aliasMatch(alias, fragments) {
    const normalizedAlias = normalize(alias);
    const compactAlias = compact(alias);
    const normalizedFragments = fragments.map(normalize);
    const compactFragments = fragments.map(compact);
    if (!normalizedAlias || !compactAlias || compactFragments.some(value => !value)) return null;

    const positions = normalizedFragments.map((fragment, index) => {
        const direct = normalizedAlias.indexOf(fragment);
        return direct >= 0 ? direct : compactAlias.indexOf(compactFragments[index]);
    });
    if (positions.some(position => position < 0)) return null;

    const phrase = normalizedFragments.join(' ');
    const compactPhrase = compactFragments.join('');
    const exact = fragments.length === 1 && normalizedAlias === normalizedFragments[0];
    const canonical = compactAlias === compactPhrase;
    let ordered = true;
    for (let index = 1; index < positions.length; index += 1) {
        if (positions[index] < positions[index - 1]) ordered = false;
    }
    const prefix = positions[0] === 0 && ordered;
    const quality = exact ? 4 : canonical ? 3 : prefix ? 2 : 1;
    const matchedLength = Math.min(compactAlias.length,
        compactFragments.reduce((sum, fragment) => sum + fragment.length, 0));
    const coverage = compactAlias.length === 0 ? 0 : matchedLength / compactAlias.length;
    const start = Math.min(...positions);
    return Object.freeze({ alias, quality, coverage, ordered, start,
        extraLength: Math.max(0, compactAlias.length - matchedLength) });
}

/** @param {any} left @param {any} right */
function compareMatches(left, right) {
    return right.priority - left.priority || right.quality - left.quality ||
        right.coverage - left.coverage || Number(right.ordered) - Number(left.ordered) ||
        left.start - right.start || left.extraLength - right.extraLength ||
        left.alias.localeCompare(right.alias) || left.key.localeCompare(right.key) ||
        left.inputIndex - right.inputIndex;
}

/** @param {any} left @param {any} right */
function compareAliasMatches(left, right) {
    return right.quality - left.quality || right.coverage - left.coverage ||
        Number(right.ordered) - Number(left.ordered) || left.start - right.start ||
        left.extraLength - right.extraLength || left.alias.localeCompare(right.alias);
}

/**
 * Reconciles one name or several high-confidence fragments against provider-neutral targets.
 * `first` returns the highest-ranked match deterministically. `precise` returns a target only
 * when the highest priority/quality bucket contains exactly one target.
 *
 * @param {string|readonly string[]} query
 * @param {readonly any[]} targets
 * @param {{mode?:'first'|'precise',getAliases?:(target:any)=>unknown,getIdentifiers?:(target:any)=>unknown,
 * getPriority?:(target:any)=>number,getKey?:(target:any,index:number)=>unknown}} [options]
 */
function reconcile(query, targets, options = {}) {
    if (!Array.isArray(targets)) throw new TypeError('Player-name targets must be an array.');
    const mode = options.mode || MODE_FIRST;
    if (![MODE_FIRST, MODE_PRECISE].includes(mode)) throw new TypeError('Player-name mode is invalid.');
    const fragments = queryFragments(query);
    const getAliases = options.getAliases || (target => target && (target.aliases || target.names || target.name));
    const getIdentifiers = options.getIdentifiers || (target => target && target.identifiers);
    const getPriority = options.getPriority || (() => 0);
    const getKey = options.getKey || ((_target, index) => `${index}`);
    const rawQuery = Array.isArray(query) ? null : clean(query);

    /** @type {Map<string,{target:any,key:string,aliases:string[],identifiers:string[],priority:number,
     * inputIndex:number}>} */
    const grouped = new Map();
    targets.forEach((target, inputIndex) => {
        const key = clean(getKey(target, inputIndex)) || `${inputIndex}`;
        const aliases = stringArray(getAliases(target));
        const identifiers = stringArray(getIdentifiers(target));
        const priority = Number(getPriority(target));
        if (!Number.isFinite(priority)) throw new TypeError('Player-name target priority must be finite.');
        const existing = grouped.get(key);
        if (existing) {
            existing.aliases.push(...aliases.filter(alias => !existing.aliases.includes(alias)));
            existing.identifiers.push(...identifiers.filter(identifier => !existing.identifiers.includes(identifier)));
            existing.priority = Math.max(existing.priority, priority);
            return;
        }
        grouped.set(key, { target, key, aliases: [...aliases], identifiers: [...identifiers],
            priority, inputIndex });
    });
    const entries = [...grouped.values()];

    /** @type {Match[]} */
    const direct = rawQuery === null ? [] : entries.filter(entry => entry.identifiers.includes(rawQuery))
        .map(entry => Object.freeze({ target: entry.target, key: entry.key, alias: rawQuery,
            quality: 5, coverage: 1, ordered: true, start: 0, extraLength: 0,
            priority: entry.priority, inputIndex: entry.inputIndex }));
    /** @type {Match[]} */
    const matches = direct.length > 0 ? direct : entries.flatMap(entry => {
        const best = entry.aliases.map(alias => aliasMatch(alias, fragments)).filter(Boolean)
            .sort(compareAliasMatches)[0];
        return best ? [Object.freeze({ target: entry.target, key: entry.key,
            alias: best.alias, quality: best.quality, coverage: best.coverage,
            ordered: best.ordered, start: best.start, extraLength: best.extraLength,
            priority: entry.priority, inputIndex: entry.inputIndex })] : [];
    });
    matches.sort(compareMatches);
    if (matches.length === 0) return Object.freeze({ mode, fragments, target: null,
        candidates: Object.freeze([]), matches: Object.freeze([]), ambiguous: false });

    /** @type {Match[]} */
    let finalists = matches;
    if (mode === MODE_PRECISE) {
        const best = matches[0];
        finalists = matches.filter(match => match.priority === best.priority && match.quality === best.quality);
    }
    const target = mode === MODE_FIRST || finalists.length === 1 ? finalists[0].target : null;
    return Object.freeze({
        mode,
        fragments,
        target,
        candidates: Object.freeze(finalists.map(match => match.target)),
        matches: Object.freeze(finalists),
        ambiguous: mode === MODE_PRECISE && finalists.length > 1
    });
}

module.exports = Object.freeze({
    MODE_FIRST,
    MODE_PRECISE,
    compact,
    normalize,
    reconcile
});
