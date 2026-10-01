// @ts-check
/* Strict immutable contracts for player-intelligence observations. */

const Crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const CONFIDENCE_VALUES = Object.freeze([
    'authoritative', 'verified', 'probable', 'ambiguous', 'untrusted'
]);
const EVENT_KINDS = Object.freeze([
    'identity_observed',
    'identity_linked',
    'identity_link_revoked',
    'clan_snapshot',
    'presence_observed',
    'wipe_snapshot'
]);
const PRESENCE_STATES = Object.freeze(['online', 'offline', 'unknown']);
const CLAN_ROLES = Object.freeze(['leader', 'moderator', 'member', 'unknown']);
const STEAM_ID_PATTERN = /^7656119\d{10}$/;
const BATTLEMETRICS_ID_PATTERN = /^\d{1,32}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

/** @param {unknown} value @param {string} label @param {number} maximum */
function assertString(value, label, maximum = 256) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum ||
        value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${label} must be a non-empty bounded string without control characters.`);
    }
}

/** @param {unknown} value @param {string} label */
function optionalString(value, label, maximum = 256) {
    if (value !== null) assertString(value, label, maximum);
}

/** @param {unknown} value @param {string} label */
function normalizeIso(value, label) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new TypeError(`${label} must be an ISO timestamp.`);
    }
    const normalized = new Date(value).toISOString();
    if (normalized !== value) throw new TypeError(`${label} must be a canonical UTC ISO timestamp.`);
    return normalized;
}

/** @param {unknown} value @param {string} label */
function optionalIso(value, label) {
    return value === null ? null : normalizeIso(value, label);
}

/** @param {object} value @param {readonly string[]} keys @param {string} label */
function assertExactKeys(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new TypeError(`${label} has unsupported or missing fields.`);
    }
}

/** @param {unknown} value @param {string} label */
function optionalSteamId(value, label) {
    if (value !== null && (typeof value !== 'string' || !STEAM_ID_PATTERN.test(value))) {
        throw new TypeError(`${label} must be a valid SteamID64 or null.`);
    }
}

/** @param {unknown} value @param {string} label */
function optionalBattlemetricsId(value, label) {
    if (value !== null && (typeof value !== 'string' || !BATTLEMETRICS_ID_PATTERN.test(value))) {
        throw new TypeError(`${label} must be a numeric BattleMetrics ID or null.`);
    }
}

/** @param {unknown} value */
function validateScope(value) {
    assertExactKeys(/** @type {object} */ (value), ['guildId', 'serverKey', 'wipeId'], 'scope');
    const scope = /** @type {{guildId: unknown, serverKey: unknown, wipeId: unknown}} */ (value);
    assertString(scope.guildId, 'scope.guildId', 128);
    assertString(scope.serverKey, 'scope.serverKey', 256);
    optionalString(scope.wipeId, 'scope.wipeId', 128);
}

/** @param {unknown} value @param {boolean} required */
function validateSubject(value, required) {
    assertExactKeys(/** @type {object} */ (value),
        ['steamId', 'battlemetricsPlayerId', 'exactName'], 'subject');
    const subject = /** @type {{steamId: unknown, battlemetricsPlayerId: unknown, exactName: unknown}} */ (value);
    optionalSteamId(subject.steamId, 'subject.steamId');
    optionalBattlemetricsId(subject.battlemetricsPlayerId, 'subject.battlemetricsPlayerId');
    optionalString(subject.exactName, 'subject.exactName', 128);
    if (required && subject.steamId === null && subject.battlemetricsPlayerId === null &&
        subject.exactName === null) throw new TypeError('subject must contain at least one identity reference.');
}

/** @param {unknown} value */
function validateProvenance(value) {
    assertExactKeys(/** @type {object} */ (value),
        ['source', 'sourceEventId', 'collectorVersion'], 'provenance');
    const provenance = /** @type {{source: unknown, sourceEventId: unknown, collectorVersion: unknown}} */ (value);
    assertString(provenance.source, 'provenance.source', 64);
    assertString(provenance.sourceEventId, 'provenance.sourceEventId', 256);
    assertString(provenance.collectorVersion, 'provenance.collectorVersion', 64);
}

/** @param {unknown} value */
function validateEvidence(value) {
    if (value === null) return;
    assertExactKeys(/** @type {object} */ (value), ['hash', 'reference', 'expiresAt'], 'evidence');
    const evidence = /** @type {{hash: unknown, reference: unknown, expiresAt: unknown}} */ (value);
    if (typeof evidence.hash !== 'string' || !HASH_PATTERN.test(evidence.hash)) {
        throw new TypeError('evidence.hash must be a SHA-256 hex digest.');
    }
    optionalString(evidence.reference, 'evidence.reference', 512);
    optionalIso(evidence.expiresAt, 'evidence.expiresAt');
}

/** @param {unknown} value */
function validateIdentityObserved(value) {
    assertExactKeys(/** @type {object} */ (value), ['caseFidelity'], 'identity_observed payload');
    if (typeof /** @type {{caseFidelity: unknown}} */ (value).caseFidelity !== 'boolean') {
        throw new TypeError('identity_observed payload.caseFidelity must be boolean.');
    }
}

/** @param {unknown} value */
function validateIdentityLinked(value) {
    assertExactKeys(/** @type {object} */ (value),
        ['linkId', 'targetSteamId', 'targetBattlemetricsPlayerId', 'reason'], 'identity_linked payload');
    const payload = /** @type {{linkId: unknown, targetSteamId: unknown,
        targetBattlemetricsPlayerId: unknown, reason: unknown}} */ (value);
    assertString(payload.linkId, 'identity_linked payload.linkId', 128);
    optionalSteamId(payload.targetSteamId, 'identity_linked payload.targetSteamId');
    optionalBattlemetricsId(payload.targetBattlemetricsPlayerId,
        'identity_linked payload.targetBattlemetricsPlayerId');
    assertString(payload.reason, 'identity_linked payload.reason', 256);
    if (payload.targetSteamId === null && payload.targetBattlemetricsPlayerId === null) {
        throw new TypeError('identity_linked payload must contain a target identity.');
    }
}

/** @param {unknown} value */
function validateIdentityLinkRevoked(value) {
    assertExactKeys(/** @type {object} */ (value), ['linkId', 'reason'], 'identity_link_revoked payload');
    const payload = /** @type {{linkId: unknown, reason: unknown}} */ (value);
    assertString(payload.linkId, 'identity_link_revoked payload.linkId', 128);
    assertString(payload.reason, 'identity_link_revoked payload.reason', 256);
}

/** @param {unknown} value @param {number} index */
function validateClanMember(value, index) {
    const label = `clan_snapshot payload.members[${index}]`;
    assertExactKeys(/** @type {object} */ (value),
        ['name', 'steamId', 'battlemetricsPlayerId', 'role'], label);
    const member = /** @type {{name: unknown, steamId: unknown,
        battlemetricsPlayerId: unknown, role: unknown}} */ (value);
    optionalString(member.name, `${label}.name`, 128);
    optionalSteamId(member.steamId, `${label}.steamId`);
    optionalBattlemetricsId(member.battlemetricsPlayerId, `${label}.battlemetricsPlayerId`);
    if (member.name === null && member.steamId === null && member.battlemetricsPlayerId === null) {
        throw new TypeError(`${label} must contain an identity reference.`);
    }
    if (!CLAN_ROLES.includes(/** @type {string} */ (member.role))) {
        throw new TypeError(`${label}.role is unsupported.`);
    }
}

/** @param {unknown} value @param {string} label */
function validateClanCandidate(value, label) {
    assertExactKeys(/** @type {object} */ (value),
        ['name', 'steamId', 'battlemetricsPlayerId', 'score'], label);
    const candidate = /** @type {{name:unknown,steamId:unknown,battlemetricsPlayerId:unknown,score:unknown}} */ (value);
    assertString(candidate.name, `${label}.name`, 128);
    optionalSteamId(candidate.steamId, `${label}.steamId`);
    optionalBattlemetricsId(candidate.battlemetricsPlayerId, `${label}.battlemetricsPlayerId`);
    if (typeof candidate.score !== 'number' || !Number.isFinite(candidate.score) ||
        candidate.score < 0 || candidate.score > 1) throw new TypeError(`${label}.score is invalid.`);
}

/** @param {unknown} value @param {number} index */
function validateUnresolvedClanMember(value, index) {
    const label = `clan_snapshot payload.unresolvedMembers[${index}]`;
    assertExactKeys(/** @type {object} */ (value), ['observedText', 'role', 'candidates'], label);
    const member = /** @type {{observedText:unknown,role:unknown,candidates:unknown}} */ (value);
    assertString(member.observedText, `${label}.observedText`, 128);
    if (!CLAN_ROLES.includes(/** @type {string} */ (member.role))) {
        throw new TypeError(`${label}.role is unsupported.`);
    }
    if (!Array.isArray(member.candidates) || member.candidates.length > 3) {
        throw new TypeError(`${label}.candidates must be a bounded array.`);
    }
    member.candidates.forEach((candidate, candidateIndex) =>
        validateClanCandidate(candidate, `${label}.candidates[${candidateIndex}]`));
}

/** @param {unknown} value @param {unknown} scope */
function validateClanSnapshot(value, scope) {
    const hasUnresolved = Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, 'unresolvedMembers'));
    assertExactKeys(/** @type {object} */ (value), hasUnresolved ?
        ['tag', 'establishedAt', 'complete', 'declaredMemberCount', 'members', 'unresolvedMembers'] :
        ['tag', 'establishedAt', 'complete', 'declaredMemberCount', 'members'], 'clan_snapshot payload');
    const payload = /** @type {{tag: unknown, establishedAt: unknown, complete: unknown,
        declaredMemberCount: unknown, members: unknown, unresolvedMembers?: unknown}} */ (value);
    assertString(payload.tag, 'clan_snapshot payload.tag', 32);
    optionalIso(payload.establishedAt, 'clan_snapshot payload.establishedAt');
    if (typeof payload.complete !== 'boolean') {
        throw new TypeError('clan_snapshot payload.complete must be boolean.');
    }
    if (payload.declaredMemberCount !== null &&
        (!Number.isSafeInteger(payload.declaredMemberCount) || Number(payload.declaredMemberCount) < 0 ||
            Number(payload.declaredMemberCount) > 1000)) {
        throw new TypeError('clan_snapshot payload.declaredMemberCount is invalid.');
    }
    if (!Array.isArray(payload.members) || payload.members.length > 1000) {
        throw new TypeError('clan_snapshot payload.members must be a bounded array.');
    }
    payload.members.forEach(validateClanMember);
    if (hasUnresolved) {
        if (!Array.isArray(payload.unresolvedMembers) || payload.unresolvedMembers.length > 1000) {
            throw new TypeError('clan_snapshot payload.unresolvedMembers must be a bounded array.');
        }
        payload.unresolvedMembers.forEach(validateUnresolvedClanMember);
        if (payload.declaredMemberCount !== null &&
            payload.members.length + payload.unresolvedMembers.length > Number(payload.declaredMemberCount)) {
            throw new TypeError('clan_snapshot resolved and unresolved members exceed the declared count.');
        }
    }
    const unresolvedCount = hasUnresolved ? /** @type {any[]} */ (payload.unresolvedMembers).length : 0;
    if (payload.complete && (payload.declaredMemberCount === null ||
        payload.members.length !== Number(payload.declaredMemberCount) || unresolvedCount !== 0)) {
        throw new TypeError('complete clan_snapshot must contain every declared member and no unresolved slot.');
    }
    if (/** @type {{wipeId: unknown}} */ (scope).wipeId === null) {
        throw new TypeError('clan_snapshot scope.wipeId is required.');
    }
}

/** @param {unknown} value */
function validatePresence(value) {
    assertExactKeys(/** @type {object} */ (value),
        ['state', 'providerSessionId', 'reason'], 'presence_observed payload');
    const payload = /** @type {{state: unknown, providerSessionId: unknown, reason: unknown}} */ (value);
    if (!PRESENCE_STATES.includes(/** @type {string} */ (payload.state))) {
        throw new TypeError('presence_observed payload.state is unsupported.');
    }
    optionalString(payload.providerSessionId, 'presence_observed payload.providerSessionId', 128);
    optionalString(payload.reason, 'presence_observed payload.reason', 256);
    if (payload.state === 'unknown' && payload.reason === null) {
        throw new TypeError('unknown presence requires a reason.');
    }
}

/** @param {unknown} value @param {unknown} scope */
function validateWipeSnapshot(value, scope) {
    assertExactKeys(/** @type {object} */ (value), ['startsAt', 'endsAt'], 'wipe_snapshot payload');
    const payload = /** @type {{startsAt: unknown, endsAt: unknown}} */ (value);
    normalizeIso(payload.startsAt, 'wipe_snapshot payload.startsAt');
    optionalIso(payload.endsAt, 'wipe_snapshot payload.endsAt');
    if (payload.endsAt !== null && Date.parse(/** @type {string} */ (payload.endsAt)) <=
        Date.parse(/** @type {string} */ (payload.startsAt))) {
        throw new TypeError('wipe_snapshot payload.endsAt must be after startsAt.');
    }
    if (/** @type {{wipeId: unknown}} */ (scope).wipeId === null) {
        throw new TypeError('wipe_snapshot scope.wipeId is required.');
    }
}

/** @param {string} kind @param {unknown} payload @param {unknown} scope */
function validatePayload(kind, payload, scope) {
    if (kind === 'identity_observed') return validateIdentityObserved(payload);
    if (kind === 'identity_linked') return validateIdentityLinked(payload);
    if (kind === 'identity_link_revoked') return validateIdentityLinkRevoked(payload);
    if (kind === 'clan_snapshot') return validateClanSnapshot(payload, scope);
    if (kind === 'presence_observed') return validatePresence(payload);
    if (kind === 'wipe_snapshot') return validateWipeSnapshot(payload, scope);
    throw new TypeError('Unsupported player-intelligence event kind.');
}

/** @param {unknown} value @returns {string} */
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${stableStringify(/** @type {Record<string, unknown>} */ (value)[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** @param {Record<string, unknown>} event */
function computeEventId(event) {
    const identity = {
        schemaVersion: event.schemaVersion,
        kind: event.kind,
        observedAt: event.observedAt,
        scope: event.scope,
        provenance: event.provenance
    };
    return `pi:${Crypto.createHash('sha256').update(stableStringify(identity)).digest('hex')}`;
}

/**
 * Validates, clones and deeply freezes one canonical event.
 * @param {unknown} input
 * @returns {Readonly<Record<string, any>>}
 */
function createEvent(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Player-intelligence event must be an object.');
    }
    const raw = /** @type {Record<string, any>} */ (input);
    const allowed = ['schemaVersion', 'eventId', 'kind', 'observedAt', 'recordedAt', 'scope', 'subject',
        'payload', 'provenance', 'confidence', 'evidence'];
    const actual = Object.keys(raw);
    if (actual.some(key => !allowed.includes(key)) ||
        allowed.filter(key => key !== 'eventId').some(key => !actual.includes(key))) {
        throw new TypeError('Player-intelligence event has unsupported or missing fields.');
    }
    if (raw.schemaVersion !== SCHEMA_VERSION || !EVENT_KINDS.includes(raw.kind)) {
        throw new TypeError('Player-intelligence event schema or kind is unsupported.');
    }
    normalizeIso(raw.observedAt, 'observedAt');
    normalizeIso(raw.recordedAt, 'recordedAt');
    validateScope(raw.scope);
    const subjectRequired = ['identity_observed', 'identity_linked', 'identity_link_revoked',
        'presence_observed'].includes(raw.kind);
    validateSubject(raw.subject, subjectRequired);
    validatePayload(raw.kind, raw.payload, raw.scope);
    validateProvenance(raw.provenance);
    if (!CONFIDENCE_VALUES.includes(raw.confidence)) throw new TypeError('confidence is unsupported.');
    validateEvidence(raw.evidence);
    if (raw.kind === 'identity_linked' && raw.subject.exactName === null) {
        throw new TypeError('identity_linked subject.exactName is required.');
    }

    const clone = JSON.parse(JSON.stringify(raw));
    const computed = computeEventId(clone);
    if (clone.eventId !== undefined && clone.eventId !== computed) {
        throw new TypeError('eventId does not match the deterministic event identity.');
    }
    clone.eventId = computed;
    return deepFreeze(clone);
}

module.exports = Object.freeze({
    BATTLEMETRICS_ID_PATTERN,
    CLAN_ROLES,
    CONFIDENCE_VALUES,
    EVENT_KINDS,
    PRESENCE_STATES,
    SCHEMA_VERSION,
    STEAM_ID_PATTERN,
    createEvent,
    deepFreeze,
    stableStringify
});
