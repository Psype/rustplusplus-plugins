// @ts-check
/* Reversible identity projection. Raw observations are never rewritten. */

const Crypto = require('node:crypto');

const { deepFreeze } = require('./contracts.js');

/** @param {string} name */
function nameKey(name) {
    return name.normalize('NFKC').toLocaleLowerCase('en');
}

/** @param {string} key */
function namePersonId(key) {
    return `name:${Crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/** @param {{steamId: string|null, battlemetricsPlayerId: string|null}} target @param {Map<string, Set<string>>} bmToSteam */
function targetPersonId(target, bmToSteam) {
    if (target.steamId !== null) return `steam:${target.steamId}`;
    const steamIds = bmToSteam.get(/** @type {string} */ (target.battlemetricsPlayerId));
    if (steamIds && steamIds.size === 1) return `steam:${[...steamIds][0]}`;
    return `battlemetrics:${target.battlemetricsPlayerId}`;
}

/** @param {readonly Readonly<Record<string, any>>[]} events */
function projectIdentities(events) {
    const ordered = events.filter(event => ['identity_observed', 'identity_linked',
        'identity_link_revoked'].includes(event.kind)).slice().sort((left, right) =>
        left.recordedAt.localeCompare(right.recordedAt) || left.eventId.localeCompare(right.eventId));
    const bmToSteam = new Map();
    const observedNameTargets = new Map();
    const activeLinks = new Map();

    for (const event of ordered) {
        if (event.kind === 'identity_observed' && event.subject.steamId !== null &&
            event.subject.battlemetricsPlayerId !== null) {
            const values = bmToSteam.get(event.subject.battlemetricsPlayerId) || new Set();
            values.add(event.subject.steamId);
            bmToSteam.set(event.subject.battlemetricsPlayerId, values);
        }
    }

    for (const event of ordered) {
        if (event.kind === 'identity_linked') activeLinks.set(event.payload.linkId, event);
        else if (event.kind === 'identity_link_revoked') activeLinks.delete(event.payload.linkId);
    }

    const explicitNameTargets = new Map();
    const explicitBattlemetricsTargets = new Map();
    for (const link of activeLinks.values()) {
        const key = nameKey(link.subject.exactName);
        const target = targetPersonId({
            steamId: link.payload.targetSteamId,
            battlemetricsPlayerId: link.payload.targetBattlemetricsPlayerId
        }, bmToSteam);
        const values = explicitNameTargets.get(key) || new Set();
        values.add(target);
        explicitNameTargets.set(key, values);
        if (link.subject.battlemetricsPlayerId !== null) {
            const battlemetricsValues = explicitBattlemetricsTargets.get(link.subject.battlemetricsPlayerId) ||
                new Set();
            battlemetricsValues.add(target);
            explicitBattlemetricsTargets.set(link.subject.battlemetricsPlayerId, battlemetricsValues);
        }
    }

    /** @param {{steamId: string|null, battlemetricsPlayerId: string|null}} subject */
    function resolveStableSubject(subject) {
        if (subject.steamId !== null) return `steam:${subject.steamId}`;
        if (subject.battlemetricsPlayerId !== null) {
            const explicit = explicitBattlemetricsTargets.get(subject.battlemetricsPlayerId);
            if (explicit && explicit.size === 1) return [...explicit][0];
        }
        return targetPersonId(subject, bmToSteam);
    }

    for (const event of ordered) {
        if (event.kind !== 'identity_observed' || event.subject.exactName === null ||
            (event.subject.steamId === null && event.subject.battlemetricsPlayerId === null)) continue;
        const key = nameKey(event.subject.exactName);
        const values = observedNameTargets.get(key) || new Set();
        values.add(resolveStableSubject(event.subject));
        observedNameTargets.set(key, values);
    }

    /** @param {{steamId: string|null, battlemetricsPlayerId: string|null, exactName: string|null}} subject */
    function resolveSubject(subject) {
        if (subject.steamId !== null) return deepFreeze({
            personId: `steam:${subject.steamId}`, confidence: 'authoritative', ambiguous: false
        });
        if (subject.battlemetricsPlayerId !== null) {
            const explicit = explicitBattlemetricsTargets.get(subject.battlemetricsPlayerId);
            if (explicit && explicit.size === 1) return deepFreeze({
                personId: [...explicit][0], confidence: 'verified', ambiguous: false
            });
            if (explicit && explicit.size > 1) return deepFreeze({
                personId: `battlemetrics:${subject.battlemetricsPlayerId}`,
                confidence: 'ambiguous', ambiguous: true
            });
            const steamIds = bmToSteam.get(subject.battlemetricsPlayerId);
            if (steamIds && steamIds.size === 1) return deepFreeze({
                personId: `steam:${[...steamIds][0]}`, confidence: 'verified', ambiguous: false
            });
            return deepFreeze({
                personId: `battlemetrics:${subject.battlemetricsPlayerId}`,
                confidence: steamIds && steamIds.size > 1 ? 'ambiguous' : 'verified',
                ambiguous: Boolean(steamIds && steamIds.size > 1)
            });
        }

        const key = nameKey(/** @type {string} */ (subject.exactName));
        const explicit = explicitNameTargets.get(key);
        if (explicit && explicit.size === 1) return deepFreeze({
            personId: [...explicit][0], confidence: 'verified', ambiguous: false
        });
        if (explicit && explicit.size > 1) return deepFreeze({
            personId: namePersonId(key), confidence: 'ambiguous', ambiguous: true
        });
        const inferred = new Set(observedNameTargets.get(key) || []);
        if (inferred.size === 1) return deepFreeze({
            personId: [...inferred][0], confidence: 'probable', ambiguous: false
        });
        return deepFreeze({
            personId: namePersonId(key),
            confidence: inferred.size > 1 ? 'ambiguous' : 'probable',
            ambiguous: inferred.size > 1
        });
    }

    const people = new Map();
    const steamCurrentNames = new Map();
    const steamPastNames = new Map();
    /** @param {string} personId */
    function ensurePerson(personId) {
        if (!people.has(personId)) people.set(personId, {
            personId,
            steamId: personId.startsWith('steam:') ? personId.slice(6) : null,
            battlemetricsPlayerIds: new Set(),
            names: new Map()
        });
        return people.get(personId);
    }

    for (const event of ordered) {
        if (event.kind !== 'identity_observed') continue;
        const resolution = resolveSubject(event.subject);
        const person = ensurePerson(resolution.personId);
        if (event.subject.exactName !== null && resolution.personId.startsWith('steam:')) {
            if (event.provenance.source === 'steam-profile-current') {
                const previous = steamCurrentNames.get(resolution.personId);
                if (!previous || `${previous.observedAt}\u0000${previous.eventId}` <
                    `${event.observedAt}\u0000${event.eventId}`) {
                    steamCurrentNames.set(resolution.personId, {
                        name: event.subject.exactName, observedAt: event.observedAt, eventId: event.eventId
                    });
                }
            }
            else if (event.provenance.source === 'steam-profile-alias-history') {
                const values = steamPastNames.get(resolution.personId) || new Set();
                values.add(event.subject.exactName);
                steamPastNames.set(resolution.personId, values);
            }
        }
        if (event.subject.battlemetricsPlayerId !== null) {
            person.battlemetricsPlayerIds.add(event.subject.battlemetricsPlayerId);
        }
        if (event.subject.exactName !== null && event.payload.caseFidelity) {
            const previous = person.names.get(event.subject.exactName) || {
                name: event.subject.exactName, firstObservedAt: event.observedAt,
                lastObservedAt: event.observedAt, caseFidelity: event.payload.caseFidelity,
                verified: false, lastVerifiedAt: null
            };
            const verified = resolution.personId.startsWith('steam:') &&
                (event.subject.steamId !== null || event.subject.battlemetricsPlayerId !== null);
            previous.firstObservedAt = previous.firstObservedAt < event.observedAt ?
                previous.firstObservedAt : event.observedAt;
            previous.lastObservedAt = previous.lastObservedAt > event.observedAt ?
                previous.lastObservedAt : event.observedAt;
            previous.caseFidelity = previous.caseFidelity && event.payload.caseFidelity;
            previous.verified = previous.verified || verified;
            if (verified && (previous.lastVerifiedAt === null || previous.lastVerifiedAt < event.observedAt)) {
                previous.lastVerifiedAt = event.observedAt;
            }
            person.names.set(event.subject.exactName, previous);
        }
    }

    for (const link of activeLinks.values()) {
        if (typeof link.payload.targetName !== 'string' || link.payload.targetName === '') continue;
        if (!['steam-profile', 'warbandits', 'verified-history'].includes(link.payload.targetNameSource)) continue;
        const personId = targetPersonId({
            steamId: link.payload.targetSteamId,
            battlemetricsPlayerId: link.payload.targetBattlemetricsPlayerId
        }, bmToSteam);
        const person = ensurePerson(personId);
        if (link.payload.targetNameSource === 'steam-profile') {
            const previousCurrent = steamCurrentNames.get(personId);
            if (!previousCurrent || `${previousCurrent.observedAt}\u0000${previousCurrent.eventId}` <
                `${link.observedAt}\u0000${link.eventId}`) {
                steamCurrentNames.set(personId, {
                    name: link.payload.targetName, observedAt: link.observedAt, eventId: link.eventId
                });
            }
        }
        const previous = person.names.get(link.payload.targetName) || {
            name: link.payload.targetName, firstObservedAt: link.observedAt,
            lastObservedAt: link.observedAt, caseFidelity: true, verified: true,
            lastVerifiedAt: link.observedAt
        };
        previous.firstObservedAt = previous.firstObservedAt < link.observedAt ?
            previous.firstObservedAt : link.observedAt;
        previous.lastObservedAt = previous.lastObservedAt > link.observedAt ?
            previous.lastObservedAt : link.observedAt;
        previous.caseFidelity = true;
        previous.verified = true;
        previous.lastVerifiedAt = previous.lastVerifiedAt !== null && previous.lastVerifiedAt > link.observedAt ?
            previous.lastVerifiedAt : link.observedAt;
        person.names.set(link.payload.targetName, previous);
    }

    const persons = [...people.values()].map(person => deepFreeze({
        personId: person.personId,
        steamId: person.steamId,
        battlemetricsPlayerIds: [...person.battlemetricsPlayerIds].sort(),
        names: [...person.names.values()].map(alias => ({
            ...alias,
            steamStatus: steamCurrentNames.get(person.personId)?.name === alias.name ? 'current' :
                steamPastNames.get(person.personId)?.has(alias.name) ? 'past' : null
        })).sort((left, right) =>
            left.firstObservedAt.localeCompare(right.firstObservedAt) || left.name.localeCompare(right.name))
    })).sort((left, right) => left.personId.localeCompare(right.personId));
    const personById = new Map(persons.map(person => [person.personId, person]));
    const personsByIdentifier = new Map();
    const personsByExactName = new Map();
    for (const person of persons) {
        for (const identifier of [person.steamId, ...person.battlemetricsPlayerIds].filter(Boolean)) {
            const values = personsByIdentifier.get(identifier) || [];
            values.push(person);
            personsByIdentifier.set(identifier, values);
        }
        for (const alias of person.names) {
            const key = nameKey(alias.name);
            const values = personsByExactName.get(key) || [];
            if (!values.includes(person)) values.push(person);
            personsByExactName.set(key, values);
        }
    }
    for (const [key, values] of personsByIdentifier) {
        personsByIdentifier.set(key, deepFreeze(values));
    }
    for (const [key, values] of personsByExactName) {
        personsByExactName.set(key, deepFreeze(values));
    }

    /** @param {string} personId */
    function displayName(personId) {
        const person = personById.get(personId);
        if (!person || person.names.length === 0) return personId;
        const verified = person.names.filter(alias => alias.verified);
        const current = verified.filter(alias => alias.steamStatus === 'current');
        return (current.length > 0 ? current : verified.length > 0 ? verified : person.names).slice()
        .sort((left, right) =>
            `${right.lastVerifiedAt || right.lastObservedAt}`.localeCompare(
                `${left.lastVerifiedAt || left.lastObservedAt}`) ||
            right.lastObservedAt.localeCompare(left.lastObservedAt) || left.name.localeCompare(right.name))[0].name;
    }

    /** @param {string} identifier */
    function findByIdentifier(identifier) {
        return personsByIdentifier.get(identifier) || deepFreeze([]);
    }

    /** @param {string} name */
    function findByExactName(name) {
        return personsByExactName.get(nameKey(name)) || deepFreeze([]);
    }

    /** @param {string} personId */
    function getPerson(personId) {
        return personById.get(personId) || null;
    }

    return deepFreeze({
        persons,
        activeLinks: [...activeLinks.values()].map(event => ({
            linkId: event.payload.linkId,
            exactName: event.subject.exactName,
            sourceBattlemetricsPlayerId: event.subject.battlemetricsPlayerId,
            targetName: event.payload.targetName || null,
            targetNameSource: event.payload.targetNameSource || null,
            targetPersonId: targetPersonId({
                steamId: event.payload.targetSteamId,
                battlemetricsPlayerId: event.payload.targetBattlemetricsPlayerId
            }, bmToSteam)
        })).sort((left, right) => left.linkId.localeCompare(right.linkId)),
        resolveSubject,
        displayName,
        findByIdentifier,
        findByExactName,
        getPerson
    });
}

module.exports = Object.freeze({ nameKey, projectIdentities });
