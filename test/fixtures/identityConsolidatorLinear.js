'use strict';

/* Frozen linear oracle copied from the 1.22.31 consolidator. Tests use it to prove indexed semantic parity. */

const { deepFreeze } = require('../../src/plugins/playerIntelligence/contracts.js');

function cleanName(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function nameKey(value) {
    return cleanName(value).normalize('NFKC').toLocaleLowerCase('en');
}

function steamId(value) {
    const result = `${value || ''}`;
    return /^7656119\d{10}$/u.test(result) ? result : null;
}

function battlemetricsId(value) {
    const result = `${value || ''}`;
    return /^\d{1,32}$/u.test(result) ? result : null;
}

function normalizeCandidates(candidates) {
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

function battlemetricsForSteam(rows, knownSteamId) {
    return [...new Set(rows.filter(row => row.steamId === knownSteamId && row.battlemetricsPlayerId)
        .map(row => row.battlemetricsPlayerId))];
}

function steamForBattlemetrics(rows, knownBattlemetricsId) {
    return [...new Set(rows.filter(row => row.battlemetricsPlayerId === knownBattlemetricsId && row.steamId)
        .map(row => row.steamId))];
}

function pairConflicts(rows, knownSteamId, knownBattlemetricsId) {
    return battlemetricsForSteam(rows, knownSteamId).some(value => value !== knownBattlemetricsId) ||
        steamForBattlemetrics(rows, knownBattlemetricsId).some(value => value !== knownSteamId);
}

function consolidateCandidates(candidates, observation) {
    const rows = normalizeCandidates(candidates);
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
        pairConflicts(rows, resolvedSteamId, resolvedBattlemetricsId)) {
        conflicts.push('stable identifiers are already linked to different local identities');
    }

    if (conflicts.length === 0 && resolvedSteamId && !resolvedBattlemetricsId) {
        const matches = battlemetricsForSteam(rows, resolvedSteamId);
        if (matches.length === 1) {
            resolvedBattlemetricsId = matches[0];
            changedFields.push('battlemetricsPlayerId');
            linkVia = 'identifier';
        }
        else if (matches.length > 1) ambiguities.push('SteamID64 maps to several BattleMetrics IDs');
    }
    if (conflicts.length === 0 && resolvedBattlemetricsId && !resolvedSteamId) {
        const matches = steamForBattlemetrics(rows, resolvedBattlemetricsId);
        if (matches.length === 1) {
            resolvedSteamId = matches[0];
            changedFields.push('steamId');
            linkVia = 'identifier';
        }
        else if (matches.length > 1) ambiguities.push('BattleMetrics ID maps to several SteamID64 values');
    }

    const exactKey = nameKey(resolvedName);
    const exact = allowExactName && exactKey && Array.from(exactKey).length >= 3 ?
        rows.filter(row => row.nameTrusted && row.nameKey === exactKey) : [];
    if (conflicts.length === 0 && exact.length > 0 && !resolvedSteamId && !resolvedBattlemetricsId) {
        const personIds = [...new Set(exact.map(row => row.personId))];
        const steamIds = [...new Set(exact.map(row => row.steamId).filter(Boolean))];
        const battlemetricsIds = [...new Set(exact.map(row => row.battlemetricsPlayerId).filter(Boolean))];
        if (personIds.length === 1 && steamIds.length <= 1 && battlemetricsIds.length <= 1) {
            if (steamIds.length === 1) {
                resolvedSteamId = steamIds[0];
                changedFields.push('steamId');
            }
            if (battlemetricsIds.length === 1) {
                resolvedBattlemetricsId = battlemetricsIds[0];
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
        const [matchedBattlemetricsId] = matches;
        if (!foreignSteam && matches.length === 1 && matchedBattlemetricsId &&
            !pairConflicts(rows, resolvedSteamId, matchedBattlemetricsId)) {
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
        const [matchedSteamId] = matches;
        if (!foreignBattlemetrics && matches.length === 1 && matchedSteamId &&
            !pairConflicts(rows, matchedSteamId, resolvedBattlemetricsId)) {
            resolvedSteamId = matchedSteamId;
            changedFields.push('steamId');
            linkVia = 'exact-name';
        }
        else if (foreignBattlemetrics || matches.length > 1) {
            ambiguities.push('exact name has several local identities');
        }
    }

    if (resolvedSteamId && resolvedBattlemetricsId &&
        pairConflicts(rows, resolvedSteamId, resolvedBattlemetricsId)) {
        conflicts.push('consolidated stable identifiers conflict with local history');
        if (!original.steamId) resolvedSteamId = null;
        if (!original.battlemetricsPlayerId) resolvedBattlemetricsId = null;
    }

    const stableRows = rows.filter(row =>
        (resolvedSteamId && row.steamId === resolvedSteamId) ||
        (resolvedBattlemetricsId && row.battlemetricsPlayerId === resolvedBattlemetricsId));
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

    const matchedPersonIds = [...new Set(rows.filter(row =>
        (resolvedSteamId && row.steamId === resolvedSteamId) ||
        (resolvedBattlemetricsId && row.battlemetricsPlayerId === resolvedBattlemetricsId) ||
        (allowExactName && exactKey && row.nameTrusted && row.nameKey === exactKey))
        .map(row => row.personId))].sort();
    if (!linkVia && conflicts.length === 0 && resolvedSteamId && resolvedBattlemetricsId && rows.some(row =>
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

module.exports = Object.freeze({ consolidateCandidates });
