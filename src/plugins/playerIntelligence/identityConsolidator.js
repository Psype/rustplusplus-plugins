// @ts-check
/* One conservative local boundary for filling and joining stable player identity fields. */

const { deepFreeze } = require('./contracts.js');

/** @typedef {Readonly<{steamId:string|null,battlemetricsPlayerId:string|null,name:string|null,nameKey:string|null,
 * nameTrusted:boolean,preferredName:string|null,personId:string}>} CandidateRow */
/** @typedef {Readonly<{rows:readonly CandidateRow[],rowsBySteamId:Map<string,readonly number[]>,
 * rowsByBattlemetricsId:Map<string,readonly number[]>,trustedRowsByNameKey:Map<string,readonly number[]>,
 * battlemetricsIdsBySteamId:Map<string,readonly string[]>,
 * steamIdsByBattlemetricsId:Map<string,readonly string[]>}>} CandidateIndex */
/** @type {readonly any[]} */
const EMPTY = Object.freeze([]);
/** @type {WeakMap<object, (observation:any) => any>} */
const projectionConsolidators = new WeakMap();

/** @param {unknown} value */
function cleanName(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {unknown} value */
function nameKey(value) {
    return cleanName(value).normalize('NFKC').toLocaleLowerCase('en');
}

/** @param {unknown} value */
function steamId(value) {
    const result = `${value || ''}`;
    return /^7656119\d{10}$/u.test(result) ? result : null;
}

/** @param {unknown} value */
function battlemetricsId(value) {
    const result = `${value || ''}`;
    return /^\d{1,32}$/u.test(result) ? result : null;
}

/** @param {readonly any[]} candidates @returns {readonly CandidateRow[]} */
function normalizeCandidates(candidates) {
    /** @type {CandidateRow[]} */
    const rows = [];
    for (const raw of Array.isArray(candidates) ? candidates : []) {
        if (!raw || typeof raw !== 'object') continue;
        const knownSteamId = steamId(raw.steamId);
        const knownBattlemetricsId = battlemetricsId(raw.battlemetricsPlayerId);
        if (!knownSteamId && !knownBattlemetricsId) continue;
        const name = cleanName(raw.name);
        const preferredName = cleanName(raw.preferredName);
        rows.push(Object.freeze({
            steamId: knownSteamId,
            battlemetricsPlayerId: knownBattlemetricsId,
            name: name || null,
            nameKey: name ? nameKey(name) : null,
            nameTrusted: raw.nameTrusted !== false && raw.caseFidelity !== false,
            preferredName: preferredName || null,
            personId: typeof raw.personId === 'string' && raw.personId ? raw.personId :
                knownSteamId ? `steam:${knownSteamId}` : `battlemetrics:${knownBattlemetricsId}`
        }));
    }
    return Object.freeze(rows);
}

/** @param {Map<string, number[]>} index @param {string|null} key @param {number} rowIndex */
function addRowIndex(index, key, rowIndex) {
    if (!key) return;
    const values = index.get(key) || [];
    values.push(rowIndex);
    index.set(key, values);
}

/** @param {Map<string, Set<string>>} index @param {string|null} key @param {string|null} value */
function addUniqueValue(index, key, value) {
    if (!key || !value) return;
    const values = index.get(key) || new Set();
    values.add(value);
    index.set(key, values);
}

/** @param {Map<string, any>} index */
function freezeIndexValues(index) {
    for (const [key, values] of index) index.set(key, Object.freeze(values));
    return index;
}

/** @param {Map<string, Set<string>>} index @returns {Map<string, readonly string[]>} */
function freezeUniqueValueIndex(index) {
    return new Map([...index].map(([key, values]) => [key, Object.freeze([...values])]));
}

/** @param {readonly (readonly number[])[]} groups */
function mergeRowIndexes(groups) {
    if (groups.length === 0) return EMPTY;
    if (groups.length === 1) return groups[0];
    return Object.freeze([...new Set(groups.flat())].sort((left, right) => left - right));
}

/** @param {CandidateIndex} prepared @param {string} knownSteamId @returns {readonly string[]} */
function battlemetricsForSteam(prepared, knownSteamId) {
    return prepared.battlemetricsIdsBySteamId.get(knownSteamId) || EMPTY;
}

/** @param {CandidateIndex} prepared @param {string} knownBattlemetricsId @returns {readonly string[]} */
function steamForBattlemetrics(prepared, knownBattlemetricsId) {
    return prepared.steamIdsByBattlemetricsId.get(knownBattlemetricsId) || EMPTY;
}

/** @param {CandidateIndex} prepared @param {string} knownSteamId @param {string} knownBattlemetricsId */
function pairConflicts(prepared, knownSteamId, knownBattlemetricsId) {
    return battlemetricsForSteam(prepared, knownSteamId).some(value => value !== knownBattlemetricsId) ||
        steamForBattlemetrics(prepared, knownBattlemetricsId).some(value => value !== knownSteamId);
}

/** @param {readonly any[]} candidates @returns {CandidateIndex} */
function prepareCandidateIndex(candidates) {
    const rows = normalizeCandidates(candidates);
    /** @type {Map<string, number[]>} */
    const rowsBySteamId = new Map();
    /** @type {Map<string, number[]>} */
    const rowsByBattlemetricsId = new Map();
    /** @type {Map<string, number[]>} */
    const trustedRowsByNameKey = new Map();
    /** @type {Map<string, Set<string>>} */
    const battlemetricsIdsBySteamId = new Map();
    /** @type {Map<string, Set<string>>} */
    const steamIdsByBattlemetricsId = new Map();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        addRowIndex(rowsBySteamId, row.steamId, rowIndex);
        addRowIndex(rowsByBattlemetricsId, row.battlemetricsPlayerId, rowIndex);
        if (row.nameTrusted) addRowIndex(trustedRowsByNameKey, row.nameKey, rowIndex);
        addUniqueValue(battlemetricsIdsBySteamId, row.steamId, row.battlemetricsPlayerId);
        addUniqueValue(steamIdsByBattlemetricsId, row.battlemetricsPlayerId, row.steamId);
    }
    freezeIndexValues(rowsBySteamId);
    freezeIndexValues(rowsByBattlemetricsId);
    freezeIndexValues(trustedRowsByNameKey);
    return Object.freeze({
        rows,
        rowsBySteamId,
        rowsByBattlemetricsId,
        trustedRowsByNameKey,
        battlemetricsIdsBySteamId: freezeUniqueValueIndex(battlemetricsIdsBySteamId),
        steamIdsByBattlemetricsId: freezeUniqueValueIndex(steamIdsByBattlemetricsId)
    });
}

/**
 * @param {CandidateIndex} prepared @param {any} observation
 */
function consolidatePrepared(prepared, observation) {
    const rows = prepared.rows;
    const original = Object.freeze({
        steamId: steamId(observation && observation.steamId),
        battlemetricsPlayerId: battlemetricsId(observation && observation.battlemetricsPlayerId),
        name: cleanName(observation && (observation.name ?? observation.exactName)) || null,
        caseFidelity: observation && observation.caseFidelity !== false
    });
    let resolvedSteamId = original.steamId;
    let resolvedBattlemetricsId = original.battlemetricsPlayerId;
    let resolvedName = original.name;
    let linkVia = null;
    const allowExactName = original.caseFidelity && observation && observation.nameTrusted !== false &&
        observation.allowExactName !== false;
    const changedFields = [];
    const conflicts = [];
    const ambiguities = [];

    if (resolvedSteamId && resolvedBattlemetricsId &&
        pairConflicts(prepared, resolvedSteamId, resolvedBattlemetricsId)) {
        conflicts.push('stable identifiers are already linked to different local identities');
    }

    if (conflicts.length === 0 && resolvedSteamId && !resolvedBattlemetricsId) {
        const matches = battlemetricsForSteam(prepared, resolvedSteamId);
        if (matches.length === 1) {
            resolvedBattlemetricsId = matches[0];
            changedFields.push('battlemetricsPlayerId');
            linkVia = 'identifier';
        }
        else if (matches.length > 1) ambiguities.push('SteamID64 maps to several BattleMetrics IDs');
    }
    if (conflicts.length === 0 && resolvedBattlemetricsId && !resolvedSteamId) {
        const matches = steamForBattlemetrics(prepared, resolvedBattlemetricsId);
        if (matches.length === 1) {
            resolvedSteamId = matches[0];
            changedFields.push('steamId');
            linkVia = 'identifier';
        }
        else if (matches.length > 1) ambiguities.push('BattleMetrics ID maps to several SteamID64 values');
    }

    const exactKey = nameKey(resolvedName);
    const exactRowIndexes = allowExactName && exactKey ?
        prepared.trustedRowsByNameKey.get(exactKey) || EMPTY : EMPTY;
    const exact = Array.from(exactKey).length >= 3 ? exactRowIndexes.map(rowIndex => rows[rowIndex]) : EMPTY;
    if (conflicts.length === 0 && exact.length > 0 && !resolvedSteamId && !resolvedBattlemetricsId) {
        const personIds = [...new Set(exact.map(row => row.personId))];
        const steamIds = [...new Set(exact.map(row => row.steamId).filter(Boolean))];
        const battlemetricsIds = [...new Set(exact.map(row => row.battlemetricsPlayerId).filter(Boolean))];
        if (personIds.length === 1 && steamIds.length <= 1 && battlemetricsIds.length <= 1) {
            if (steamIds.length === 1) {
                resolvedSteamId = /** @type {string} */ (steamIds[0]);
                changedFields.push('steamId');
            }
            if (battlemetricsIds.length === 1) {
                resolvedBattlemetricsId = /** @type {string} */ (battlemetricsIds[0]);
                changedFields.push('battlemetricsPlayerId');
            }
            if (resolvedSteamId || resolvedBattlemetricsId) linkVia = 'exact-name';
        }
        else if (personIds.length > 1 || steamIds.length > 1 || battlemetricsIds.length > 1) {
            ambiguities.push('exact name has several local identities');
        }
    }
    if (conflicts.length === 0 && exact.length > 0 && resolvedSteamId && !resolvedBattlemetricsId) {
        const foreignSteam = exact.some(row => row.steamId && row.steamId !== resolvedSteamId);
        const matches = [...new Set(exact.filter(row => !row.steamId || row.steamId === resolvedSteamId)
            .map(row => row.battlemetricsPlayerId).filter(Boolean))];
        const [matchedBattlemetricsId] = /** @type {string[]} */ (matches);
        if (!foreignSteam && matches.length === 1 && matchedBattlemetricsId &&
            !pairConflicts(prepared, resolvedSteamId, matchedBattlemetricsId)) {
            resolvedBattlemetricsId = matchedBattlemetricsId;
            changedFields.push('battlemetricsPlayerId');
            linkVia = 'exact-name';
        }
        else if (foreignSteam || matches.length > 1) ambiguities.push('exact name has several local identities');
    }
    if (conflicts.length === 0 && exact.length > 0 && resolvedBattlemetricsId && !resolvedSteamId) {
        const foreignBattlemetrics = exact.some(row => row.battlemetricsPlayerId &&
            row.battlemetricsPlayerId !== resolvedBattlemetricsId);
        const matches = [...new Set(exact
            .filter(row => !row.battlemetricsPlayerId || row.battlemetricsPlayerId === resolvedBattlemetricsId)
            .map(row => row.steamId).filter(Boolean))];
        const [matchedSteamId] = /** @type {string[]} */ (matches);
        if (!foreignBattlemetrics && matches.length === 1 && matchedSteamId &&
            !pairConflicts(prepared, matchedSteamId, resolvedBattlemetricsId)) {
            resolvedSteamId = matchedSteamId;
            changedFields.push('steamId');
            linkVia = 'exact-name';
        }
        else if (foreignBattlemetrics || matches.length > 1) {
            ambiguities.push('exact name has several local identities');
        }
    }

    if (resolvedSteamId && resolvedBattlemetricsId &&
        pairConflicts(prepared, resolvedSteamId, resolvedBattlemetricsId)) {
        conflicts.push('consolidated stable identifiers conflict with local history');
        if (!original.steamId) resolvedSteamId = null;
        if (!original.battlemetricsPlayerId) resolvedBattlemetricsId = null;
    }

    const stableRowIndexes = mergeRowIndexes([
        ...(resolvedSteamId ? [prepared.rowsBySteamId.get(resolvedSteamId) || EMPTY] : []),
        ...(resolvedBattlemetricsId ?
            [prepared.rowsByBattlemetricsId.get(resolvedBattlemetricsId) || EMPTY] : [])
    ]);
    const stableRows = stableRowIndexes.map(rowIndex => rows[rowIndex]);
    if (!resolvedName && stableRows.length > 0) {
        const preferred = [...new Set(stableRows.map(row => row.preferredName).filter(Boolean))];
        const available = preferred.length > 0 ? preferred :
            [...new Set(stableRows.filter(row => row.nameTrusted).map(row => row.name).filter(Boolean))];
        if (available.length === 1) {
            resolvedName = available[0];
            changedFields.push('name');
        }
        else if (available.length > 1) ambiguities.push('stable identifier has several equally current names');
    }

    const matchedRowIndexes = mergeRowIndexes([stableRowIndexes, exactRowIndexes]);
    const matchedPersonIds = [...new Set(matchedRowIndexes.map(rowIndex => rows[rowIndex].personId))].sort();
    if (!linkVia && conflicts.length === 0 && resolvedSteamId && resolvedBattlemetricsId && stableRows.some(row =>
        (row.steamId === resolvedSteamId || row.battlemetricsPlayerId === resolvedBattlemetricsId) &&
        (!row.steamId || row.steamId === resolvedSteamId) &&
        (!row.battlemetricsPlayerId || row.battlemetricsPlayerId === resolvedBattlemetricsId))) {
        linkVia = 'identifier';
    }
    const links = resolvedSteamId && resolvedBattlemetricsId && linkVia ? [Object.freeze({
        steamId: resolvedSteamId,
        battlemetricsPlayerId: resolvedBattlemetricsId,
        via: linkVia
    })] : [];
    return deepFreeze({
        identity: {
            steamId: resolvedSteamId,
            battlemetricsPlayerId: resolvedBattlemetricsId,
            name: resolvedName,
            caseFidelity: original.caseFidelity
        },
        original,
        changedFields,
        matchedPersonIds,
        links,
        conflicts,
        ambiguities,
        status: conflicts.length > 0 ? 'conflict' : ambiguities.length > 0 && changedFields.length === 0 ?
            'ambiguous' : changedFields.length > 0 ? 'enriched' : matchedPersonIds.length > 0 ? 'matched' : 'new'
    });
}

/**
 * Prepares one immutable, indexed consolidator for repeated observations against the same candidate snapshot.
 * Only stable-ID equality or a unique exact trusted name may fill missing fields.
 * @param {readonly any[]} candidates
 */
function prepareIdentityConsolidator(candidates) {
    const prepared = prepareCandidateIndex(candidates);
    return Object.freeze((/** @type {any} */ observation) => consolidatePrepared(prepared, observation));
}

/**
 * Consolidates one observation against local identity candidates. This compatibility entry point intentionally
 * snapshots its candidates on every call; repeated callers should use prepareIdentityConsolidator().
 * @param {readonly any[]} candidates @param {any} observation
 */
function consolidateCandidates(candidates, observation) {
    return prepareIdentityConsolidator(candidates)(observation);
}

/** @param {any} projection */
function projectionCandidates(projection) {
    if (!projection || !projection.identities || !Array.isArray(projection.identities.persons)) {
        throw new TypeError('Player-intelligence projection is required.');
    }
    const candidates = [];
    for (const person of projection.identities.persons) {
        const preferredName = projection.identities.displayName(person.personId);
        const battlemetricsIds = person.battlemetricsPlayerIds.length > 0 ?
            person.battlemetricsPlayerIds : [null];
        const names = person.names.length > 0 ? person.names : [null];
        for (const knownBattlemetricsId of battlemetricsIds) {
            for (const alias of names) candidates.push({
                personId: person.personId,
                steamId: person.steamId,
                battlemetricsPlayerId: knownBattlemetricsId,
                name: alias && alias.name,
                preferredName,
                caseFidelity: alias ? alias.caseFidelity : true,
                nameTrusted: alias ?
                    (alias.verified && alias.steamStatus !== 'past') || person.steamId === null : false
            });
        }
    }
    return Object.freeze(candidates);
}

/** @param {any} projection @param {any} observation */
function consolidateProjection(projection, observation) {
    const cacheable = projection && typeof projection === 'object' && Object.isFrozen(projection) &&
        projection.identities && Object.isFrozen(projection.identities) &&
        Array.isArray(projection.identities.persons) && Object.isFrozen(projection.identities.persons);
    let consolidate = cacheable ? projectionConsolidators.get(projection) : null;
    if (!consolidate) {
        consolidate = prepareIdentityConsolidator(projectionCandidates(projection));
        if (cacheable) projectionConsolidators.set(projection, consolidate);
    }
    return consolidate(observation);
}

module.exports = Object.freeze({
    consolidateCandidates,
    consolidateProjection,
    prepareIdentityConsolidator,
    projectionCandidates
});
