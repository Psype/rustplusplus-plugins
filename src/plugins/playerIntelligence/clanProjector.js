// @ts-check
/* Clan/wipe snapshots and affinity counters derived from confirmed observations. */

const { deepFreeze } = require('./contracts.js');
const { nameKey } = require('./identityProjector.js');

const COUNTED_CONFIDENCE = new Set(['authoritative', 'verified']);
const ROLE_WEIGHT = Object.freeze({ leader: 3, moderator: 2, member: 1, unknown: 0 });

/** @param {readonly Readonly<Record<string, any>>[]} events @param {ReturnType<import('./identityProjector.js')['projectIdentities']>} identities */
function projectClans(events, identities) {
    const evidenceSeen = new Set();
    /** @type {any[]} */
    const snapshots = [];
    const known = new Map();
    const played = new Map();
    const tags = new Map();

    for (const event of events.filter(item => item.kind === 'clan_snapshot').slice().sort((left, right) =>
        left.observedAt.localeCompare(right.observedAt) || left.eventId.localeCompare(right.eventId))) {
        const evidenceKey = event.evidence ?
            `sha256:${event.evidence.hash.toLowerCase()}` : event.eventId;
        const confirmed = COUNTED_CONFIDENCE.has(event.confidence);
        const duplicate = evidenceSeen.has(evidenceKey);
        if (!duplicate) evidenceSeen.add(evidenceKey);

        const members = new Map();
        for (const member of event.payload.members) {
            const resolution = identities.resolveSubject({
                steamId: member.steamId,
                battlemetricsPlayerId: member.battlemetricsPlayerId,
                exactName: member.name
            });
            const previous = members.get(resolution.personId);
            const role = /** @type {keyof typeof ROLE_WEIGHT} */ (member.role);
            const previousRole = /** @type {keyof typeof ROLE_WEIGHT|undefined} */ (previous?.role);
            if (!previous || ROLE_WEIGHT[role] > ROLE_WEIGHT[/** @type {keyof typeof ROLE_WEIGHT} */ (previousRole)]) {
                members.set(resolution.personId, {
                    personId: resolution.personId,
                    name: member.name || identities.displayName(resolution.personId),
                    role: member.role,
                    resolutionConfidence: resolution.confidence,
                    ambiguous: resolution.ambiguous
                });
            }
        }
        const tagKey = nameKey(event.payload.tag);
        const instanceKey = [event.scope.serverKey, event.scope.wipeId, tagKey,
            event.payload.establishedAt || 'unknown'].join('|');
        const projected = deepFreeze({
            eventId: event.eventId,
            observedAt: event.observedAt,
            serverKey: event.scope.serverKey,
            wipeId: event.scope.wipeId,
            tag: event.payload.tag,
            tagKey,
            establishedAt: event.payload.establishedAt,
            complete: event.payload.complete,
            declaredMemberCount: event.payload.declaredMemberCount,
            members: [...members.values()].sort((left, right) => left.personId.localeCompare(right.personId)),
            instanceKey,
            confirmed,
            duplicate
        });
        snapshots.push(projected);
        if (!confirmed || duplicate) continue;

        if (!tags.has(tagKey)) tags.set(tagKey, {
            tag: event.payload.tag, wipeIds: new Set(), snapshotCount: 0, memberIds: new Set()
        });
        const tag = tags.get(tagKey);
        tag.tag = event.payload.tag;
        tag.wipeIds.add(event.scope.wipeId);
        tag.snapshotCount += 1;
        for (const personId of members.keys()) tag.memberIds.add(personId);

        for (const personId of members.keys()) {
            if (!known.has(personId)) known.set(personId, new Map());
            const values = known.get(personId);
            const entry = values.get(tagKey) || { tag: event.payload.tag, count: 0 };
            entry.tag = event.payload.tag;
            entry.count += 1;
            values.set(tagKey, entry);
        }

        const personIds = [...members.keys()].sort();
        for (let first = 0; first < personIds.length; first += 1) {
            for (let second = first + 1; second < personIds.length; second += 1) {
                const pair = `${personIds[first]}\u0000${personIds[second]}`;
                played.set(pair, (played.get(pair) || 0) + 1);
            }
        }
    }

    /** @param {{steamId: string|null, battlemetricsPlayerId: string|null, exactName: string|null}} subject */
    function getAffinity(subject) {
        const resolution = identities.resolveSubject(subject);
        const knownTags = [...(known.get(resolution.personId) || new Map()).values()]
            .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
        const playedWith = [];
        for (const [pair, count] of played.entries()) {
            const [first, second] = pair.split('\u0000');
            if (first !== resolution.personId && second !== resolution.personId) continue;
            const otherPersonId = first === resolution.personId ? second : first;
            playedWith.push({
                personId: otherPersonId,
                name: identities.displayName(otherPersonId),
                count
            });
        }
        playedWith.sort((left, right) => right.count - left.count ||
            left.name.localeCompare(right.name) || left.personId.localeCompare(right.personId));
        return deepFreeze({
            personId: resolution.personId,
            ambiguous: resolution.ambiguous,
            knownTags,
            playedWith
        });
    }

    /** @param {string} tag */
    function getTagHistory(tag) {
        const key = nameKey(tag);
        return deepFreeze(snapshots.filter(snapshot => snapshot.tagKey === key));
    }

    return deepFreeze({
        snapshots,
        tags: [...tags.values()].map(tag => deepFreeze({
            tag: tag.tag,
            wipeIds: [...tag.wipeIds].sort(),
            wipeCount: tag.wipeIds.size,
            snapshotCount: tag.snapshotCount,
            memberCount: tag.memberIds.size
        })).sort((left, right) => right.wipeCount - left.wipeCount ||
            right.snapshotCount - left.snapshotCount || left.tag.localeCompare(right.tag)),
        getAffinity,
        getTagHistory
    });
}

module.exports = Object.freeze({ projectClans });
