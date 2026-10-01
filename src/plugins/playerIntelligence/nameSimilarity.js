// @ts-check
/* Unicode-aware candidate ranking. Retrieval views never replace the exact stored alias. */

const DEFAULT_RESOLVED_SCORE = 0.88;
const DEFAULT_RESOLVED_MARGIN = 0.08;
const DEFAULT_PROVISIONAL_SCORE = 0.55;
const MAX_ALTERNATIVES = 3;
const MAX_FUZZY_GROUPS_PER_NAME = 64;
const MIN_FUZZY_GROUPS_PER_NAME = 12;

/** @typedef {{name:string,steamId:string|null,battlemetricsPlayerId:string|null,caseFidelity:boolean,
 * corroborated:boolean,contextPriority:boolean,memberIndexes:readonly number[]|null,visualScore:number|null}} Candidate */
/** @typedef {{key:string,aliases:readonly Candidate[]}} CandidateGroup */

/** @param {unknown} value */
function clean(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {string} value */
function graphemes(value) {
    if (typeof Intl.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
        return [...segmenter.segment(value)].map(item => item.segment);
    }
    return Array.from(value);
}

/** @param {string} value */
function lower(value) {
    return value.normalize('NFKC').toLocaleLowerCase('en');
}

/** @param {string} value */
function lettersAndNumbers(value) {
    return lower(value).replace(/[^\p{L}\p{N}]/gu, '');
}

/** @param {string} value */
function accentless(value) {
    return lower(value).normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

/** @param {string} value */
function strongRetrievalKey(value) {
    return Object.freeze({
        exact: lower(value),
        alnum: lettersAndNumbers(value),
        accentless: lettersAndNumbers(accentless(value))
    });
}

/** @param {string} value */
function retrievalBigrams(value) {
    const units = graphemes(lettersAndNumbers(accentless(value)));
    if (units.length < 2) return Object.freeze([]);
    return Object.freeze([...new Set(Array.from({ length: units.length - 1 }, (_, index) =>
        `${units[index]}\u0000${units[index + 1]}`))]);
}

/** @param {string} value */
function scripts(value) {
    const result = new Set();
    const expressions = Object.freeze({
        Arabic: /\p{Script=Arabic}/u,
        Cyrillic: /\p{Script=Cyrillic}/u,
        Han: /\p{Script=Han}/u,
        Hangul: /\p{Script=Hangul}/u,
        Hiragana: /\p{Script=Hiragana}/u,
        Katakana: /\p{Script=Katakana}/u,
        Latin: /\p{Script=Latin}/u
    });
    for (const character of value) {
        for (const [name, expression] of Object.entries(expressions)) {
            if (expression.test(character)) result.add(name);
        }
    }
    return Object.freeze([...result].sort());
}

/** @param {readonly string[]} left @param {readonly string[]} right */
function damerauDistance(left, right) {
    const rows = left.length + 1;
    const columns = right.length + 1;
    const matrix = Array.from({ length: rows }, () => Array(columns).fill(0));
    for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
    for (let column = 0; column < columns; column += 1) matrix[0][column] = column;
    for (let row = 1; row < rows; row += 1) {
        for (let column = 1; column < columns; column += 1) {
            const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
            matrix[row][column] = Math.min(
                matrix[row - 1][column] + 1,
                matrix[row][column - 1] + 1,
                matrix[row - 1][column - 1] + substitution
            );
            if (row > 1 && column > 1 && left[row - 1] === right[column - 2] &&
                left[row - 2] === right[column - 1]) {
                matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + 1);
            }
        }
    }
    return matrix[left.length][right.length];
}

/** @param {readonly string[]} values */
function bigrams(values) {
    if (values.length < 2) return new Map([[values.join(''), 1]]);
    const result = new Map();
    for (let index = 0; index < values.length - 1; index += 1) {
        const key = `${values[index]}\u0000${values[index + 1]}`;
        result.set(key, (result.get(key) || 0) + 1);
    }
    return result;
}

/** @param {readonly string[]} left @param {readonly string[]} right */
function dice(left, right) {
    const leftPairs = bigrams(left);
    const rightPairs = bigrams(right);
    let overlap = 0;
    for (const [key, count] of leftPairs) overlap += Math.min(count, rightPairs.get(key) || 0);
    const total = [...leftPairs.values()].reduce((sum, value) => sum + value, 0) +
        [...rightPairs.values()].reduce((sum, value) => sum + value, 0);
    return total === 0 ? 0 : 2 * overlap / total;
}

/** @param {string} observed @param {string} candidate */
function similarity(observed, candidate) {
    const leftRaw = clean(observed);
    const rightRaw = clean(candidate);
    if (!leftRaw || !rightRaw) return 0;
    const left = lower(leftRaw);
    const right = lower(rightRaw);
    if (left === right) return 1;

    const leftAlnum = lettersAndNumbers(leftRaw);
    const rightAlnum = lettersAndNumbers(rightRaw);
    if (leftAlnum && leftAlnum === rightAlnum) return 0.96;
    const leftAccentless = lettersAndNumbers(accentless(leftRaw));
    const rightAccentless = lettersAndNumbers(accentless(rightRaw));
    if (leftAccentless && leftAccentless === rightAccentless) return 0.92;

    const leftUnits = graphemes(left);
    const rightUnits = graphemes(right);
    const maximum = Math.max(leftUnits.length, rightUnits.length);
    const edit = maximum === 0 ? 0 : 1 - damerauDistance(leftUnits, rightUnits) / maximum;
    const pairScore = dice(leftUnits, rightUnits);
    let score = edit * 0.68 + pairScore * 0.32;
    const leftScripts = scripts(leftRaw);
    const rightScripts = scripts(rightRaw);
    if (leftScripts.length > 0 && rightScripts.length > 0 &&
        !leftScripts.some(script => rightScripts.includes(script))) score *= 0.78;
    return Math.max(0, Math.min(1, score));
}

/** @param {readonly any[]} candidates */
function groupCandidates(candidates) {
    /** @type {Candidate[]} */
    const valid = [];
    /** @type {Map<string, Set<string>>} */
    const battlemetricsSteamGroups = new Map();
    for (const raw of Array.isArray(candidates) ? candidates : []) {
        if (!raw || typeof raw !== 'object') continue;
        const name = clean(raw.name);
        const steamId = /^7656119\d{10}$/u.test(`${raw.steamId || ''}`) ? `${raw.steamId}` : null;
        const battlemetricsPlayerId = /^\d{1,32}$/u.test(`${raw.battlemetricsPlayerId || ''}`) ?
            `${raw.battlemetricsPlayerId}` : null;
        if (!name || name.length > 128) continue;
        const memberIndexes = Number.isSafeInteger(raw.targetMemberIndex) && raw.targetMemberIndex >= 0 ?
            Object.freeze([raw.targetMemberIndex]) : null;
        const visualScore = memberIndexes !== null && typeof raw.visualScore === 'number' &&
            Number.isFinite(raw.visualScore) && raw.visualScore >= 0 && raw.visualScore <= 1 ? raw.visualScore : null;
        valid.push({ name, steamId, battlemetricsPlayerId, caseFidelity: raw.caseFidelity !== false,
            corroborated: raw.corroborated === true, contextPriority: raw.contextPriority === true,
            memberIndexes, visualScore });
        if (steamId && battlemetricsPlayerId) {
            const keys = battlemetricsSteamGroups.get(battlemetricsPlayerId) || new Set();
            keys.add(`steam:${steamId}`);
            battlemetricsSteamGroups.set(battlemetricsPlayerId, keys);
        }
    }

    /** @type {Map<string, {key:string,aliases:Candidate[],steamIds:Set<string>,battlemetricsIds:Set<string>}>} */
    const groups = new Map();
    for (const candidate of valid) {
        const linkedSteamGroups = candidate.battlemetricsPlayerId ?
            battlemetricsSteamGroups.get(candidate.battlemetricsPlayerId) : null;
        const key = candidate.steamId ? `steam:${candidate.steamId}` :
            linkedSteamGroups && linkedSteamGroups.size === 1 ? [...linkedSteamGroups][0] :
                candidate.battlemetricsPlayerId ? `battlemetrics:${candidate.battlemetricsPlayerId}` :
                    `name:${lower(candidate.name)}`;
        const group = groups.get(key) || {
            key, aliases: [], steamIds: new Set(), battlemetricsIds: new Set()
        };
        if (candidate.steamId) group.steamIds.add(candidate.steamId);
        if (candidate.battlemetricsPlayerId) group.battlemetricsIds.add(candidate.battlemetricsPlayerId);
        const existing = group.aliases.find(alias => alias.name === candidate.name &&
            alias.steamId === candidate.steamId &&
            alias.battlemetricsPlayerId === candidate.battlemetricsPlayerId &&
            `${alias.memberIndexes}` === `${candidate.memberIndexes}`);
        if (!existing) group.aliases.push(candidate);
        else {
            existing.caseFidelity = existing.caseFidelity || candidate.caseFidelity;
            existing.corroborated = existing.corroborated || candidate.corroborated;
            existing.contextPriority = existing.contextPriority || candidate.contextPriority;
            existing.visualScore = Math.max(existing.visualScore || 0, candidate.visualScore || 0) || null;
        }
        groups.set(key, group);
    }
    /** @type {CandidateGroup[]} */
    const result = [...groups.values()].map(group => {
        const steamId = group.steamIds.size === 1 ? [...group.steamIds][0] : null;
        const battlemetricsPlayerId = group.battlemetricsIds.size === 1 ? [...group.battlemetricsIds][0] : null;
        const contextPriority = group.aliases.some(alias => alias.contextPriority);
        /** @type {Candidate[]} */
        const aliases = [];
        for (const alias of group.aliases) {
            const enriched = Object.freeze({
                name: alias.name,
                steamId: steamId || alias.steamId,
                battlemetricsPlayerId: battlemetricsPlayerId || alias.battlemetricsPlayerId,
                caseFidelity: alias.caseFidelity,
                corroborated: alias.corroborated,
                contextPriority,
                memberIndexes: alias.memberIndexes,
                visualScore: alias.visualScore
            });
            if (!aliases.some(item => item.name === enriched.name && item.steamId === enriched.steamId &&
                item.battlemetricsPlayerId === enriched.battlemetricsPlayerId &&
                `${item.memberIndexes}` === `${enriched.memberIndexes}`)) aliases.push(enriched);
        }
        return Object.freeze({
            key: group.key,
            aliases: Object.freeze(aliases.sort((left, right) =>
                Number(right.corroborated) - Number(left.corroborated) ||
                Number(right.contextPriority) - Number(left.contextPriority) ||
                Number(right.caseFidelity) - Number(left.caseFidelity) || left.name.localeCompare(right.name)))
        });
    });
    return Object.freeze(result.sort((left, right) => left.key.localeCompare(right.key)));
}

/** @param {readonly string[]} observed @param {readonly CandidateGroup[]} groups */
function retrieveGroups(observed, groups) {
    /** @type {Record<'exact'|'alnum'|'accentless', Map<string, Set<number>>>} */
    const indexes = {
        exact: new Map(),
        alnum: new Map(),
        accentless: new Map()
    };
    /** @type {Map<string, Set<number>>} */
    const pairIndex = new Map();
    /** @param {Map<string, Set<number>>} index @param {string} key @param {number} groupIndex */
    function add(index, key, groupIndex) {
        if (!key) return;
        const values = index.get(key) || new Set();
        values.add(groupIndex);
        index.set(key, values);
    }
    groups.forEach((group, groupIndex) => {
        for (const alias of group.aliases) {
            const keys = strongRetrievalKey(alias.name);
            add(indexes.exact, keys.exact, groupIndex);
            add(indexes.alnum, keys.alnum, groupIndex);
            add(indexes.accentless, keys.accentless, groupIndex);
            for (const pair of retrievalBigrams(alias.name)) add(pairIndex, pair, groupIndex);
        }
    });

    const selected = new Set();
    groups.forEach((group, groupIndex) => {
        if (group.aliases.some(alias => alias.memberIndexes !== null)) selected.add(groupIndex);
    });
    for (const name of observed) {
        const keys = strongRetrievalKey(name);
        const strong = new Set([
            ...(indexes.exact.get(keys.exact) || []),
            ...(indexes.alnum.get(keys.alnum) || []),
            ...(indexes.accentless.get(keys.accentless) || [])
        ]);
        if (strong.size > 0) {
            for (const groupIndex of strong) selected.add(groupIndex);
            continue;
        }
        const fuzzy = new Set();
        const postings = retrievalBigrams(name).map(pair => ({
            pair,
            values: pairIndex.get(pair) || new Set()
        })).filter(posting => posting.values.size > 0)
            .sort((left, right) => left.values.size - right.values.size || left.pair.localeCompare(right.pair));
        for (const posting of postings) {
            const additions = [...posting.values].filter(groupIndex => !fuzzy.has(groupIndex));
            if (fuzzy.size + additions.length > MAX_FUZZY_GROUPS_PER_NAME) continue;
            for (const groupIndex of additions) fuzzy.add(groupIndex);
            if (fuzzy.size >= MIN_FUZZY_GROUPS_PER_NAME) break;
        }
        for (const groupIndex of fuzzy) selected.add(groupIndex);
    }
    return Object.freeze([...selected].sort((left, right) => left - right).map(index => groups[index]));
}

/** Maximum-weight rectangular assignment with one private zero-score dummy column per row. */
/** @param {readonly (readonly number[])[]} scores */
function assign(scores) {
    const rowCount = scores.length;
    if (rowCount === 0) return Object.freeze([]);
    const realColumns = scores[0].length;
    const columnCount = realColumns + rowCount;
    const u = Array(rowCount + 1).fill(0);
    const v = Array(columnCount + 1).fill(0);
    const p = Array(columnCount + 1).fill(0);
    const way = Array(columnCount + 1).fill(0);
    for (let row = 1; row <= rowCount; row += 1) {
        p[0] = row;
        let column0 = 0;
        const min = Array(columnCount + 1).fill(Infinity);
        const used = Array(columnCount + 1).fill(false);
        do {
            used[column0] = true;
            const row0 = p[column0];
            let delta = Infinity;
            let column1 = 0;
            for (let column = 1; column <= columnCount; column += 1) {
                if (used[column]) continue;
                const score = column <= realColumns ? scores[row0 - 1][column - 1] : 0;
                const current = (1 - score) - u[row0] - v[column];
                if (current < min[column]) {
                    min[column] = current;
                    way[column] = column0;
                }
                if (min[column] < delta) {
                    delta = min[column];
                    column1 = column;
                }
            }
            for (let column = 0; column <= columnCount; column += 1) {
                if (used[column]) {
                    u[p[column]] += delta;
                    v[column] -= delta;
                }
                else min[column] -= delta;
            }
            column0 = column1;
        } while (p[column0] !== 0);
        do {
            const column1 = way[column0];
            p[column0] = p[column1];
            column0 = column1;
        } while (column0 !== 0);
    }
    const result = Array(rowCount).fill(-1);
    for (let column = 1; column <= columnCount; column += 1) {
        if (p[column] !== 0 && column <= realColumns) result[p[column] - 1] = column - 1;
    }
    return Object.freeze(result);
}

/** @param {unknown} value @param {number} fallback @param {string} label */
function threshold(value, fallback, label) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`${label} must be a number between 0 and 1.`);
    }
    return value;
}

/** @param {readonly string[]} observedNames @param {readonly any[]} candidates @param {any} options */
function resolveRoster(observedNames, candidates, options = {}) {
    if (!Array.isArray(observedNames)) throw new TypeError('Observed roster names must be an array.');
    if (options.exactOnly !== undefined && typeof options.exactOnly !== 'boolean') {
        throw new TypeError('exactOnly must be a boolean.');
    }
    const exactOnly = options.exactOnly === true;
    const observed = observedNames.map(name => clean(name));
    if (observed.some(name => !name || name.length > 128)) {
        throw new TypeError('Observed roster names must be non-empty bounded strings.');
    }
    const groups = retrieveGroups(observed, groupCandidates(candidates));
    const aliases = observed.map((name, memberIndex) => groups.map(group => group.aliases.map(
        (/** @type {Candidate} */ alias) => {
            const eligible = alias.memberIndexes === null || alias.memberIndexes.includes(memberIndex);
            const visualExact = eligible && alias.visualScore === 1;
            return {
                alias,
                score: visualExact ? 1 : eligible ? similarity(name, alias.name) : 0,
                strong: (() => {
                    if (!eligible) return false;
                    if (visualExact) return true;
                    const left = strongRetrievalKey(name);
                    const right = strongRetrievalKey(alias.name);
                    return left.exact === right.exact || (!exactOnly &&
                        (Boolean(left.alnum && left.alnum === right.alnum) ||
                        Boolean(left.accentless && left.accentless === right.accentless)));
                })()
            };
        }).sort((/** @type {any} */ left, /** @type {any} */ right) =>
        right.score - left.score || Number(right.strong) - Number(left.strong) ||
        Number(right.alias.corroborated) - Number(left.alias.corroborated) ||
        Number(right.alias.contextPriority) - Number(left.alias.contextPriority) ||
        Number(right.alias.caseFidelity) - Number(left.alias.caseFidelity) ||
        left.alias.name.localeCompare(right.alias.name))[0]));
    const assignments = assign(aliases.map(row => row.map(item => item.score +
        (item.strong ? 0.000008 : 0) + (item.alias.corroborated ? 0.000004 : 0) +
        (item.alias.contextPriority ? 0.000002 : 0) +
        (item.alias.caseFidelity ? 0.000001 : 0))));
    const resolvedScore = threshold(options.resolvedScore, DEFAULT_RESOLVED_SCORE, 'resolvedScore');
    const resolvedMargin = threshold(options.resolvedMargin, DEFAULT_RESOLVED_MARGIN, 'resolvedMargin');
    const provisionalScore = threshold(options.provisionalScore, DEFAULT_PROVISIONAL_SCORE, 'provisionalScore');
    return Object.freeze(observed.map((name, index) => {
        const assignedIndex = assignments[index];
        const assigned = assignedIndex === -1 ? null : aliases[index][assignedIndex];
        const alternatives = aliases[index].map((item, groupIndex) => ({ ...item, groupIndex }))
            .sort((left, right) => right.score - left.score ||
                Number(right.strong) - Number(left.strong) ||
                Number(right.alias.corroborated) - Number(left.alias.corroborated) ||
                Number(right.alias.contextPriority) - Number(left.alias.contextPriority) ||
                Number(right.alias.caseFidelity) - Number(left.alias.caseFidelity) ||
                groups[left.groupIndex].key.localeCompare(groups[right.groupIndex].key));
        const assignedScore = assigned ? assigned.score : 0;
        const next = alternatives.find(item => item.groupIndex !== assignedIndex);
        const margin = assignedScore - (next ? next.score : 0);
        const compactLength = graphemes(lettersAndNumbers(name)).length;
        const requiredScore = compactLength <= 3 ? Math.max(resolvedScore, 0.96) :
            compactLength <= 5 ? Math.max(resolvedScore, 0.92) : resolvedScore;
        const requiredMargin = compactLength <= 3 ? Math.max(resolvedMargin, 0.18) :
            compactLength <= 5 ? Math.max(resolvedMargin, 0.12) : resolvedMargin;
        const corroboratedMatches = alternatives.filter(item => item.score >= requiredScore &&
            item.alias.corroborated);
        const externallyConfirmed = Boolean(assigned && assigned.alias.corroborated &&
            assignedScore >= requiredScore && corroboratedMatches.length === 1 &&
            (!exactOnly || assigned.strong));
        const status = assigned && assignedScore >= requiredScore &&
            ((assigned.strong && margin >= requiredMargin) || externallyConfirmed) ? 'resolved' :
            assigned && assignedScore >= provisionalScore ? 'provisional' : 'unresolved';
        return Object.freeze({
            observedText: name,
            status,
            score: Number(assignedScore.toFixed(6)),
            margin: Number(margin.toFixed(6)),
            candidate: status === 'resolved' && assigned ? assigned.alias : null,
            alternatives: Object.freeze(alternatives.slice(0, MAX_ALTERNATIVES).map(item => Object.freeze({
                name: item.alias.name,
                steamId: item.alias.steamId,
                battlemetricsPlayerId: item.alias.battlemetricsPlayerId,
                score: Number(item.score.toFixed(6))
            })))
        });
    }));
}

module.exports = Object.freeze({
    DEFAULT_PROVISIONAL_SCORE,
    DEFAULT_RESOLVED_MARGIN,
    DEFAULT_RESOLVED_SCORE,
    groupCandidates,
    resolveRoster,
    similarity
});
