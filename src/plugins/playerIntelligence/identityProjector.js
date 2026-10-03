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
        if (event.kind === 'identity_observed') {
            if (event.subject.exactName !== null &&
                (event.subject.steamId !== null || event.subject.battlemetricsPlayerId !== null)) {
                const key = nameKey(event.subject.exactName);
                const values = observedNameTargets.get(key) || new Set();
                values.add(targetPersonId(event.subject, bmToSteam));
                observedNameTargets.set(key, values);
            }
        }
        else if (event.kind === 'identity_linked') activeLinks.set(event.payload.linkId, event);
        else activeLinks.delete(event.payload.linkId);
    }

    const explicitNameTargets = new Map();
    for (const link of activeLinks.values()) {
        const key = nameKey(link.subject.exactName);
        const target = targetPersonId({
            steamId: link.payload.targetSteamId,
            battlemetricsPlayerId: link.payload.targetBattlemetricsPlayerId
        }, bmToSteam);
        const values = explicitNameTargets.get(key) || new Set();
        values.add(target);
        explicitNameTargets.set(key, values);
    }

    /** @param {{steamId: string|null, battlemetricsPlayerId: string|null, exactName: string|null}} subject */
    function resolveSubject(subject) {
        if (subject.steamId !== null) return deepFreeze({
            personId: `steam:${subject.steamId}`, confidence: 'authoritative', ambiguous: false
        });
        if (subject.battlemetricsPlayerId !== null) {
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
        if (event.subject.battlemetricsPlayerId !== null) {
            person.battlemetricsPlayerIds.add(event.subject.battlemetricsPlayerId);
        }
        if (event.subject.exactName !== null && event.payload.caseFidelity) {
            const previous = person.names.get(event.subject.exactName) || {
                name: event.subject.exactName, firstObservedAt: event.observedAt,
                lastObservedAt: event.observedAt, caseFidelity: event.payload.caseFidelity
            };
            previous.firstObservedAt = previous.firstObservedAt < event.observedAt ?
                previous.firstObservedAt : event.observedAt;
            previous.lastObservedAt = previous.lastObservedAt > event.observedAt ?
                previous.lastObservedAt : event.observedAt;
            previous.caseFidelity = previous.caseFidelity && event.payload.caseFidelity;
            person.names.set(event.subject.exactName, previous);
        }
    }

    const persons = [...people.values()].map(person => deepFreeze({
        personId: person.personId,
        steamId: person.steamId,
        battlemetricsPlayerIds: [...person.battlemetricsPlayerIds].sort(),
        names: [...person.names.values()].sort((left, right) =>
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
        return person.names.slice().sort((left, right) =>
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
