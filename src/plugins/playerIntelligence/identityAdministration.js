// @ts-check
/* Discord-facing, append-only identity reconciliation. Raw observations are never rewritten. */

const Crypto = require('node:crypto');

const Core = require('./index.js');
const { nameKey } = require('./identityProjector.js');

const COLLECTOR_VERSION = 'player-intelligence-1';
const MAX_NAME_LENGTH = 128;

/** @param {unknown} value */
function cleanName(value) {
    return `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {string} exactName @param {string|null} battlemetricsPlayerId
 * @param {string} targetSteamId @param {string} targetName @param {string} targetNameSource */
function linkId(exactName, battlemetricsPlayerId, targetSteamId, targetName, targetNameSource) {
    const digest = Crypto.createHash('sha256').update(nameKey(exactName)).digest('hex').slice(0, 24);
    const targetDigest = Crypto.createHash('sha256').update(
        `${targetSteamId}\u0000${nameKey(targetName)}\u0000${targetNameSource}`)
        .digest('hex').slice(0, 12);
    return `discord-name:${digest}:${battlemetricsPlayerId || 'name'}:${targetDigest}`;
}

/** @param {string} value */
function validSteamId(value) {
    return /^7656119\d{10}$/u.test(value);
}

/** @param {any} scope @param {string} guildId @param {string} recordedAt @param {string} kind
 * @param {any} subject @param {any} payload @param {string} sourceEventId */
function adminEvent(scope, guildId, recordedAt, kind, subject, payload, sourceEventId) {
    return Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind,
        observedAt: recordedAt,
        recordedAt,
        scope: { guildId, serverKey: scope.serverKey, wipeId: scope.wipeId },
        subject,
        payload,
        provenance: {
            source: 'discord-identity-admin',
            sourceEventId,
            collectorVersion: COLLECTOR_VERSION
        },
        confidence: 'verified',
        evidence: null
    });
}

/** @param {any} projection */
function snapshotCounts(projection) {
    const counts = new Map();
    for (const snapshot of projection.clans.snapshots) {
        if (!snapshot.confirmed || snapshot.duplicate) continue;
        for (const member of snapshot.members) {
            counts.set(member.personId, (counts.get(member.personId) || 0) + 1);
        }
    }
    return counts;
}

/** @param {any} projection */
function pendingAliases(projection) {
    const counts = snapshotCounts(projection);
    const rows = [];
    for (const person of projection.identities.persons) {
        if (person.steamId !== null) continue;
        const aliases = person.names.slice().sort((/** @type {any} */ left, /** @type {any} */ right) =>
            right.lastObservedAt.localeCompare(left.lastObservedAt) || left.name.localeCompare(right.name));
        if (aliases.length === 0) continue;
        rows.push(Object.freeze({
            name: projection.identities.displayName(person.personId),
            aliases: Object.freeze(aliases.map((/** @type {any} */ alias) => alias.name)),
            personId: person.personId,
            battlemetricsPlayerIds: Object.freeze([...person.battlemetricsPlayerIds]),
            firstObservedAt: aliases.reduce((/** @type {string} */ earliest, /** @type {any} */ alias) =>
                alias.firstObservedAt < earliest ? alias.firstObservedAt : earliest, aliases[0].firstObservedAt),
            lastObservedAt: aliases[0].lastObservedAt,
            snapshotCount: counts.get(person.personId) || 0
        }));
    }
    return Object.freeze(rows.sort((left, right) => right.snapshotCount - left.snapshotCount ||
        right.lastObservedAt.localeCompare(left.lastObservedAt) || left.name.localeCompare(right.name)));
}

/** @param {any} projection */
function activeLinks(projection) {
    const grouped = new Map();
    for (const link of projection.identities.activeLinks) {
        const key = `${nameKey(link.exactName)}\u0000${link.targetPersonId}`;
        const previous = grouped.get(key) || {
            exactName: link.exactName,
            targetPersonId: link.targetPersonId,
            targetName: link.targetName,
            targetNameSource: link.targetNameSource,
            sourceBattlemetricsPlayerIds: []
        };
        if (link.sourceBattlemetricsPlayerId !== null &&
            !previous.sourceBattlemetricsPlayerIds.includes(link.sourceBattlemetricsPlayerId)) {
            previous.sourceBattlemetricsPlayerIds.push(link.sourceBattlemetricsPlayerId);
        }
        if (link.targetName) previous.targetName = link.targetName;
        if (link.targetNameSource) previous.targetNameSource = link.targetNameSource;
        grouped.set(key, previous);
    }
    return Object.freeze([...grouped.values()].map(value => Object.freeze({
        ...value,
        sourceBattlemetricsPlayerIds: Object.freeze(value.sourceBattlemetricsPlayerIds.sort())
    })).sort((left, right) => left.exactName.localeCompare(right.exactName) ||
        left.targetPersonId.localeCompare(right.targetPersonId)));
}

/** @param {any} projection @param {string} query */
function resolveVerifiedSteamTarget(projection, query) {
    const identifierMatches = projection.identities.findByIdentifier(query);
    let matches = identifierMatches;
    let requestedAlias = null;
    if (matches.length === 0) {
        matches = projection.identities.findByExactName(query).filter((/** @type {any} */ person) =>
            person.names.some((/** @type {any} */ alias) => alias.verified &&
                nameKey(alias.name) === nameKey(query)));
        if (matches.length === 1) {
            requestedAlias = matches[0].names.find((/** @type {any} */ alias) => alias.verified &&
                nameKey(alias.name) === nameKey(query))?.name || null;
        }
    }
    const unique = [...new Map(matches.map((/** @type {any} */ person) => [person.personId, person])).values()];
    if (unique.length !== 1) return Object.freeze({ person: null, requestedAlias,
        reason: unique.length === 0 ? 'target-not-found' : 'target-ambiguous' });
    if (!unique[0].steamId) return Object.freeze({ person: null, requestedAlias,
        reason: 'target-without-steamid' });
    return Object.freeze({ person: unique[0], requestedAlias, reason: null });
}

/** @param {any} projection @param {string} alias @param {string} targetSteamId */
function validateSource(projection, alias, targetSteamId) {
    const matches = projection.identities.findByExactName(alias);
    if (matches.length === 0) return Object.freeze({ ok: false, reason: 'alias-not-found', matches: [] });
    const conflicting = matches.filter((/** @type {any} */ person) => person.steamId &&
        person.steamId !== targetSteamId);
    if (conflicting.length > 0) return Object.freeze({ ok: false, reason: 'alias-has-other-steamid',
        matches: conflicting });
    return Object.freeze({ ok: true, reason: null, matches });
}

/** @param {any} projection @param {string} alias */
function affectedSnapshotCount(projection, alias) {
    const personIds = new Set(projection.identities.findByExactName(alias)
        .map((/** @type {any} */ person) => person.personId));
    return projection.clans.snapshots.filter((/** @type {any} */ snapshot) => snapshot.confirmed &&
        !snapshot.duplicate && snapshot.members.some((/** @type {any} */ member) =>
            personIds.has(member.personId))).length;
}

/**
 * @param {any} store @param {any} scope
 * @param {{guildId:string,recordedAt:string,alias:string,targetSteamId:string,targetName:string,
 * targetNameSource:string,actorId:string}} request
 */
async function linkAlias(store, scope, request) {
    const alias = cleanName(request.alias);
    const targetName = cleanName(request.targetName);
    const targetNameSource = `${request.targetNameSource || ''}`;
    const targetSteamId = `${request.targetSteamId || ''}`;
    if (!alias || Array.from(alias).length > MAX_NAME_LENGTH) {
        return Object.freeze({ changed: false, reason: 'invalid-alias' });
    }
    if (!targetName || Array.from(targetName).length > MAX_NAME_LENGTH) {
        return Object.freeze({ changed: false, reason: 'invalid-target-name' });
    }
    if (!['steam-profile', 'warbandits', 'verified-history'].includes(targetNameSource)) {
        return Object.freeze({ changed: false, reason: 'invalid-target-name-source' });
    }
    if (!validSteamId(targetSteamId)) return Object.freeze({ changed: false, reason: 'invalid-steamid' });

    const events = await store.readAll();
    const before = Core.rebuild(events);
    const source = validateSource(before, alias, targetSteamId);
    if (!source.ok) return Object.freeze({ changed: false, reason: source.reason });
    const affectedSnapshots = affectedSnapshotCount(before, alias);
    const sourceBattlemetricsIds = [...new Set(source.matches.flatMap((/** @type {any} */ person) =>
        person.steamId === null ? person.battlemetricsPlayerIds : []))].sort();
    const subjects = sourceBattlemetricsIds.length > 0 ? sourceBattlemetricsIds : [null];
    const matchingLinks = before.identities.activeLinks.filter((/** @type {any} */ link) =>
        nameKey(link.exactName) === nameKey(alias));
    const desiredIds = new Set(subjects.map(battlemetricsId =>
        linkId(alias, battlemetricsId, targetSteamId, targetName, targetNameSource)));
    const additions = [];
    for (const link of matchingLinks) {
        if (desiredIds.has(link.linkId)) continue;
        additions.push(adminEvent(scope, request.guildId, request.recordedAt, 'identity_link_revoked', {
            steamId: null,
            battlemetricsPlayerId: link.sourceBattlemetricsPlayerId,
            exactName: link.exactName
        }, {
            linkId: link.linkId,
            reason: `Discord operator ${request.actorId} replaced or revoked this reconciliation.`
        }, `revoke:${link.linkId}:${request.recordedAt}`));
    }
    for (const battlemetricsPlayerId of subjects) {
        const id = linkId(alias, battlemetricsPlayerId, targetSteamId, targetName, targetNameSource);
        const current = matchingLinks.find((/** @type {any} */ link) => link.linkId === id &&
            link.targetPersonId === `steam:${targetSteamId}` && link.targetName === targetName &&
            link.targetNameSource === targetNameSource);
        if (current) continue;
        additions.push(adminEvent(scope, request.guildId, request.recordedAt, 'identity_linked', {
            steamId: null,
            battlemetricsPlayerId,
            exactName: alias
        }, {
            linkId: id,
            targetSteamId,
            targetBattlemetricsPlayerId: null,
            targetName,
            targetNameSource,
            reason: `Discord operator ${request.actorId} reconciled a pending alias.`
        }, `link:${id}:${targetSteamId}:${request.recordedAt}`));
    }
    if (additions.length === 0) return Object.freeze({ changed: false, reason: 'already-linked',
        alias, targetSteamId, targetName, affectedSnapshots });
    const results = await store.appendMany(additions);
    const after = Core.rebuild(await store.readAll());
    const target = after.identities.findByIdentifier(targetSteamId)[0] || null;
    return Object.freeze({
        changed: results.some((/** @type {any} */ result) => result.appended),
        reason: null,
        alias,
        targetSteamId,
        targetName: target ? after.identities.displayName(target.personId) : targetName,
        affectedSnapshots,
        verifiedAliases: Object.freeze(target ? target.names.filter((/** @type {any} */ item) => item.verified)
            .map((/** @type {any} */ item) => item.name) : [targetName])
    });
}

/**
 * @param {any} store @param {any} scope
 * @param {{guildId:string,recordedAt:string,alias:string,actorId:string}} request
 */
async function unlinkAlias(store, scope, request) {
    const alias = cleanName(request.alias);
    if (!alias || Array.from(alias).length > MAX_NAME_LENGTH) {
        return Object.freeze({ changed: false, reason: 'invalid-alias' });
    }
    const projection = Core.rebuild(await store.readAll());
    const matches = projection.identities.activeLinks.filter((/** @type {any} */ link) =>
        nameKey(link.exactName) === nameKey(alias));
    if (matches.length === 0) return Object.freeze({ changed: false, reason: 'link-not-found' });
    const events = matches.map((/** @type {any} */ link) => adminEvent(
        scope, request.guildId, request.recordedAt, 'identity_link_revoked', {
            steamId: null,
            battlemetricsPlayerId: link.sourceBattlemetricsPlayerId,
            exactName: link.exactName
        }, {
            linkId: link.linkId,
            reason: `Discord operator ${request.actorId} revoked this reconciliation.`
        }, `revoke:${link.linkId}:${request.recordedAt}`));
    const results = await store.appendMany(events);
    return Object.freeze({ changed: results.some((/** @type {any} */ result) => result.appended),
        reason: null, alias, revoked: matches.length });
}

module.exports = Object.freeze({
    activeLinks,
    linkAlias,
    pendingAliases,
    resolveVerifiedSteamTarget,
    unlinkAlias,
    validSteamId
});
