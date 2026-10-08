// @ts-check
/* Pure queue selection and checkpoint validation for manually triggered pending-identity reconciliation. */

const Crypto = require('node:crypto');

const IdentityAdministration = require('./identityAdministration.js');

const MAX_CHECKED = 200000;
const MAX_RETRIES = 10000;
const FRESH_BURST_LIMIT = 2;

/** @param {unknown} value */
function normalize(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
        .normalize('NFKC').toLocaleLowerCase('en');
}

/** @returns {any} */
function emptyCheckpoint() {
    return {
        active: false,
        startedAt: null,
        completedAt: null,
        checkedBattlemetricsIds: [],
        battlemetricsRetries: [],
        battlemetricsFreshStreak: 0,
        battlemetricsRetryAt: null,
        battlemetricsFailures: 0,
        checkedWarBanditsKeys: [],
        warBanditsRetries: [],
        warBanditsFreshStreak: 0,
        warBanditsRetryAt: null,
        warBanditsFailures: 0,
        linked: 0,
        noMatch: 0,
        conflicts: 0
    };
}

/** @param {unknown} value @param {string} label */
function validTimestamp(value, label) {
    if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
        throw new TypeError(`pending reconciliation ${label} is invalid`);
    }
}

/** @param {unknown} value @param {(id:string)=>boolean} validId @param {string} label */
function validateIds(value, validId, label) {
    if (!Array.isArray(value) || value.length > MAX_CHECKED || new Set(value).size !== value.length ||
        value.some(id => typeof id !== 'string' || !validId(id))) {
        throw new TypeError(`pending reconciliation ${label} are invalid`);
    }
}

/** @param {unknown} value @param {string} idField @param {(id:string)=>boolean} validId @param {string} label */
function validateRetries(value, idField, validId, label) {
    if (!Array.isArray(value) || value.length > MAX_RETRIES) {
        throw new TypeError(`pending reconciliation ${label} are invalid`);
    }
    const ids = new Set();
    for (const retry of value) {
        const id = retry && typeof retry === 'object' ? `${retry[idField] || ''}` : '';
        if (!validId(id) || ids.has(id) || !Number.isSafeInteger(retry.failures) || retry.failures < 1 ||
            retry.failures > 1000 || typeof retry.nextAttemptAt !== 'string' ||
            Number.isNaN(Date.parse(retry.nextAttemptAt))) {
            throw new TypeError(`pending reconciliation ${label} entry is invalid`);
        }
        ids.add(id);
    }
}

/** @param {unknown} value */
function validateCheckpoint(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('pending reconciliation checkpoint is invalid');
    }
    const checkpoint = /** @type {any} */ (value);
    if (typeof checkpoint.active !== 'boolean') throw new TypeError('pending reconciliation state is invalid');
    validTimestamp(checkpoint.startedAt, 'start time');
    validTimestamp(checkpoint.completedAt, 'completion time');
    const validBm = (/** @type {string} */ id) => /^\d{1,32}$/u.test(id);
    const validKey = (/** @type {string} */ id) =>
        /^(?:bm:\d{1,32}(?::name:[a-f0-9]{64})?|name:[a-f0-9]{64})$/u.test(id);
    validateIds(checkpoint.checkedBattlemetricsIds, validBm, 'checked BattleMetrics IDs');
    validateIds(checkpoint.checkedWarBanditsKeys, validKey, 'checked WarBandits keys');
    validateRetries(checkpoint.battlemetricsRetries, 'battlemetricsPlayerId', validBm,
        'BattleMetrics retries');
    validateRetries(checkpoint.warBanditsRetries, 'key', validKey, 'WarBandits retries');
    for (const field of ['battlemetricsFreshStreak', 'warBanditsFreshStreak']) {
        if (!Number.isSafeInteger(checkpoint[field]) || checkpoint[field] < 0 ||
            checkpoint[field] > FRESH_BURST_LIMIT) {
            throw new TypeError('pending reconciliation fairness counter is invalid');
        }
    }
    for (const prefix of ['battlemetrics', 'warBandits']) {
        const failures = checkpoint[`${prefix}Failures`];
        const retryAt = checkpoint[`${prefix}RetryAt`];
        if (!Number.isSafeInteger(failures) || failures < 0 || failures > 1000 ||
            (retryAt !== null && (typeof retryAt !== 'string' || Number.isNaN(Date.parse(retryAt)))) ||
            (failures === 0) !== (retryAt === null)) {
            throw new TypeError(`pending reconciliation ${prefix} provider retry is invalid`);
        }
    }
    for (const field of ['linked', 'noMatch', 'conflicts']) {
        if (!Number.isSafeInteger(checkpoint[field]) || checkpoint[field] < 0) {
            throw new TypeError('pending reconciliation counter is invalid');
        }
    }
    if (checkpoint.active && checkpoint.startedAt === null) {
        throw new TypeError('active pending reconciliation has no start time');
    }
    return checkpoint;
}

/** @param {string} now */
function startCheckpoint(now) {
    const checkpoint = emptyCheckpoint();
    checkpoint.active = true;
    checkpoint.startedAt = now;
    return checkpoint;
}

/** @param {any} projection */
function pendingRows(projection) {
    return IdentityAdministration.pendingAliases(projection);
}

/** @param {any} projection @param {readonly any[]} [preparedRows] */
function battlemetricsCandidates(projection, preparedRows) {
    const rows = preparedRows || pendingRows(projection);
    const values = new Map();
    for (const row of rows) {
        if (row.battlemetricsPlayerIds.length !== 1) continue;
        for (const battlemetricsPlayerId of row.battlemetricsPlayerIds) {
            if (!values.has(battlemetricsPlayerId)) values.set(battlemetricsPlayerId, Object.freeze({
                battlemetricsPlayerId, personId: row.personId, snapshotCount: row.snapshotCount,
                lastObservedAt: row.lastObservedAt
            }));
        }
    }
    return [...values.values()].sort((left, right) => right.snapshotCount - left.snapshotCount ||
        right.lastObservedAt.localeCompare(left.lastObservedAt) ||
        left.battlemetricsPlayerId.localeCompare(right.battlemetricsPlayerId, 'en', { numeric: true }));
}

/** @param {any} row @param {string} alias */
function warBanditsKey(row, alias) {
    const digest = Crypto.createHash('sha256').update(normalize(alias)).digest('hex');
    if (row.battlemetricsPlayerIds.length === 1) {
        return `bm:${row.battlemetricsPlayerIds[0]}:name:${digest}`;
    }
    return `name:${digest}`;
}

/** @param {any} projection @param {Set<string>} checkedBattlemetricsIds
 * @param {boolean} battlemetricsEnabled @param {readonly any[]} [preparedRows] */
function warBanditsCandidates(projection, checkedBattlemetricsIds, battlemetricsEnabled, preparedRows) {
    const rows = preparedRows || pendingRows(projection);
    const nameOwners = new Map();
    for (const row of rows) {
        for (const alias of new Set([row.name, ...row.aliases])) {
            const key = normalize(alias);
            if (!key) continue;
            const owners = nameOwners.get(key) || new Set();
            owners.add(row.personId);
            nameOwners.set(key, owners);
        }
    }
    const candidates = [];
    for (const row of rows) {
        if (row.battlemetricsPlayerIds.length > 1 || (battlemetricsEnabled &&
            row.battlemetricsPlayerIds.some((/** @type {string} */ id) => !checkedBattlemetricsIds.has(id)))) {
            continue;
        }
        for (const alias of row.aliases) {
            const query = normalize(alias);
            const queryLength = Array.from(query).length;
            if (queryLength < 3 || queryLength > 64 || nameOwners.get(query)?.size !== 1) continue;
            candidates.push(Object.freeze({
                key: warBanditsKey(row, alias),
                personId: row.personId,
                query: alias,
                battlemetricsPlayerId: row.battlemetricsPlayerIds[0] || null,
                snapshotCount: row.snapshotCount,
                lastObservedAt: row.lastObservedAt
            }));
        }
    }
    return candidates;
}

/** @param {readonly any[]} candidates @param {Set<string>} checked @param {Map<string,any>} retries
 * @param {string} idField @param {Date} now @param {number} freshStreak */
function selectWork(candidates, checked, retries, idField, now, freshStreak) {
    const pending = candidates.filter(candidate => !checked.has(`${candidate[idField]}`));
    const fresh = pending.filter(candidate => !retries.has(`${candidate[idField]}`));
    const priority = new Map(candidates.map((candidate, index) => [`${candidate[idField]}`, index]));
    const due = pending.filter(candidate => {
        const retry = retries.get(`${candidate[idField]}`);
        return retry && Date.parse(retry.nextAttemptAt) <= now.getTime();
    }).sort((left, right) => {
        const leftRetry = retries.get(`${left[idField]}`);
        const rightRetry = retries.get(`${right[idField]}`);
        return (priority.get(`${left[idField]}`) ?? Number.MAX_SAFE_INTEGER) -
            (priority.get(`${right[idField]}`) ?? Number.MAX_SAFE_INTEGER) ||
            leftRetry.nextAttemptAt.localeCompare(rightRetry.nextAttemptAt) ||
            `${left[idField]}`.localeCompare(`${right[idField]}`);
    });
    const useRetry = due.length > 0 && (fresh.length === 0 || freshStreak >= FRESH_BURST_LIMIT);
    const candidate = useRetry ? due[0] : fresh[0];
    return Object.freeze({
        candidate: candidate || null,
        usedRetry: Boolean(candidate && useRetry),
        nextFreshStreak: candidate ? (useRetry ? 0 : Math.min(FRESH_BURST_LIMIT, freshStreak + 1)) : freshStreak,
        outstanding: pending.length > 0
    });
}

/** @param {any} player @param {string} query */
function exactWarBanditsMatch(player, query) {
    if (!player || !/^7656119\d{10}$/u.test(`${player.steamId || ''}`)) return false;
    const expected = normalize(query);
    const aliases = [player.name, ...(Array.isArray(player.aliases) ? player.aliases : [])];
    return aliases.some(alias => normalize(alias) === expected);
}

/** @param {any} projection @param {any} checkpoint
 * @param {{battlemetricsEnabled?:boolean,warBanditsEnabled?:boolean,now?:Date}} [options]
 * @param {readonly any[]} [preparedRows] */
function reconciliationStatus(projection, checkpoint, options = {}, preparedRows) {
    const state = validateCheckpoint(checkpoint);
    const rows = preparedRows || pendingRows(projection);
    const current = options.now instanceof Date ? options.now : new Date();
    if (Number.isNaN(current.getTime())) throw new TypeError('pending reconciliation status clock is invalid');
    const battlemetricsEnabled = options.battlemetricsEnabled === true;
    const warBanditsEnabled = options.warBanditsEnabled === true;
    const checkedBattlemetricsIds = new Set(state.checkedBattlemetricsIds);
    const checkedWarBanditsKeys = new Set(state.checkedWarBanditsKeys);
    const battlemetricsRetries = new Map(state.battlemetricsRetries.map((/** @type {any} */ retry) =>
        [`${retry.battlemetricsPlayerId}`, retry]));
    const warBanditsRetries = new Map(state.warBanditsRetries.map((/** @type {any} */ retry) =>
        [`${retry.key}`, retry]));
    const warBanditsByPerson = new Map();
    for (const candidate of warBanditsCandidates(
        projection, checkedBattlemetricsIds, battlemetricsEnabled, rows)) {
        const candidates = warBanditsByPerson.get(candidate.personId) || [];
        candidates.push(candidate);
        warBanditsByPerson.set(candidate.personId, candidates);
    }
    const providerRetry = (/** @type {string|null} */ value) =>
        value !== null && Date.parse(value) > current.getTime() ? value : null;
    const battlemetricsProviderRetryAt = providerRetry(state.battlemetricsRetryAt);
    const warBanditsProviderRetryAt = providerRetry(state.warBanditsRetryAt);

    const annotated = rows.map(row => {
        const battlemetricsId = row.battlemetricsPlayerIds.length === 1 ? row.battlemetricsPlayerIds[0] : null;
        const battlemetricsChecked = Boolean(battlemetricsId && checkedBattlemetricsIds.has(battlemetricsId));
        const battlemetricsRetry = battlemetricsId ? battlemetricsRetries.get(battlemetricsId) : null;
        const warBandits = warBanditsByPerson.get(row.personId) || [];
        const uncheckedWarBandits = warBandits.filter((/** @type {any} */ candidate) =>
            !checkedWarBanditsKeys.has(candidate.key));
        const warBanditsRetry = uncheckedWarBandits.map((/** @type {any} */ candidate) =>
            warBanditsRetries.get(candidate.key)).filter(Boolean)
            .sort((/** @type {any} */ left, /** @type {any} */ right) =>
                left.nextAttemptAt.localeCompare(right.nextAttemptAt))[0] || null;
        const warBanditsAttempted = warBandits.some((/** @type {any} */ candidate) =>
            checkedWarBanditsKeys.has(candidate.key));
        const attempted = battlemetricsChecked || warBanditsAttempted;
        const automatable = Boolean((battlemetricsId && battlemetricsEnabled) ||
            (warBanditsEnabled && warBandits.length > 0));
        let reconciliationState = 'manual';
        let retryAt = null;

        if (row.battlemetricsPlayerIds.length > 1) reconciliationState = 'manual';
        else if (!state.active) {
            reconciliationState = attempted ? 'attempted-unresolved' : automatable ? 'waiting' : 'manual';
        }
        else if (battlemetricsId && battlemetricsEnabled && !battlemetricsChecked) {
            if (battlemetricsProviderRetryAt) {
                reconciliationState = 'paused-battlemetrics';
                retryAt = battlemetricsProviderRetryAt;
            }
            else if (battlemetricsRetry) {
                reconciliationState = 'retry-battlemetrics';
                retryAt = battlemetricsRetry.nextAttemptAt;
            }
            else reconciliationState = 'queued-battlemetrics';
        }
        else if (warBanditsEnabled && uncheckedWarBandits.length > 0) {
            if (warBanditsProviderRetryAt) {
                reconciliationState = 'paused-warbandits';
                retryAt = warBanditsProviderRetryAt;
            }
            else if (warBanditsRetry && uncheckedWarBandits.every((/** @type {any} */ candidate) =>
                warBanditsRetries.has(candidate.key))) {
                reconciliationState = 'retry-warbandits';
                retryAt = warBanditsRetry.nextAttemptAt;
            }
            else reconciliationState = 'queued-warbandits';
        }
        else if (attempted) reconciliationState = 'attempted-unresolved';

        return Object.freeze({
            ...row,
            reconciliationState,
            retryAt,
            campaignActive: state.active,
            campaignStartedAt: state.startedAt
        });
    });
    return Object.freeze({
        active: state.active,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        linked: state.linked,
        noMatch: state.noMatch,
        conflicts: state.conflicts,
        rows: Object.freeze(annotated)
    });
}

module.exports = Object.freeze({
    FRESH_BURST_LIMIT,
    MAX_RETRIES,
    battlemetricsCandidates,
    emptyCheckpoint,
    exactWarBanditsMatch,
    pendingRows,
    reconciliationStatus,
    selectWork,
    startCheckpoint,
    validateCheckpoint,
    warBanditsCandidates
});
