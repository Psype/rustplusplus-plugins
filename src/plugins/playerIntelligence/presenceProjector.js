// @ts-check
/* Presence state and provider sessions. Unknown is explicit and never synthesized as offline. */

const { deepFreeze } = require('./contracts.js');

/** @param {readonly Readonly<Record<string, any>>[]} events @param {ReturnType<import('./identityProjector.js')['projectIdentities']>} identities */
function projectPresence(events, identities) {
    /** @type {Map<string, {personId: string, serverKey: string, source: string, events: any[]}>} */
    const groups = new Map();
    for (const event of events.filter(item => item.kind === 'presence_observed')) {
        const resolution = identities.resolveSubject(event.subject);
        const key = `${resolution.personId}\u0000${event.scope.serverKey}\u0000${event.provenance.source}`;
        if (!groups.has(key)) groups.set(key, {
            personId: resolution.personId,
            serverKey: event.scope.serverKey,
            source: event.provenance.source,
            events: []
        });
        const group = groups.get(key);
        if (!group) throw new Error('Presence projection group invariant failed.');
        group.events.push(event);
    }

    /** @type {any[]} */
    const providers = [];
    for (const group of groups.values()) {
        group.events.sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
            left.eventId.localeCompare(right.eventId));
        const transitions = [];
        const segments = [];
        const sessions = [];
        let previous = null;
        let segment = null;
        let session = null;
        for (const event of group.events) {
            const state = event.payload.state;
            const sessionChanged = state === 'online' && session && event.payload.providerSessionId !== null &&
                session.providerSessionId !== null && event.payload.providerSessionId !== session.providerSessionId;
            if (state === previous && !sessionChanged) continue;
            if (segment) {
                segments.push({ ...segment, endAt: event.observedAt });
            }
            if (sessionChanged) {
                sessions.push({ ...session, endedAt: event.observedAt, preciseEnd: true });
                session = null;
            }
            if (state === 'online' && !session) {
                session = {
                    startedAt: event.observedAt,
                    endedAt: null,
                    preciseEnd: null,
                    uncertainFrom: null,
                    providerSessionId: event.payload.providerSessionId
                };
            }
            else if (state === 'unknown' && session && session.uncertainFrom === null) {
                session.uncertainFrom = event.observedAt;
            }
            else if (state === 'offline' && session) {
                sessions.push({
                    ...session,
                    endedAt: event.observedAt,
                    preciseEnd: session.uncertainFrom === null
                });
                session = null;
            }
            segment = {
                state,
                startAt: event.observedAt,
                endAt: null,
                reason: event.payload.reason
            };
            transitions.push({
                state,
                observedAt: event.observedAt,
                providerSessionId: event.payload.providerSessionId,
                reason: event.payload.reason
            });
            previous = state;
        }
        if (segment) segments.push(segment);
        if (session) sessions.push(session);
        providers.push(deepFreeze({
            personId: group.personId,
            serverKey: group.serverKey,
            source: group.source,
            currentState: previous || 'unknown',
            lastObservedAt: transitions.length > 0 ? transitions[transitions.length - 1].observedAt : null,
            transitions,
            segments,
            sessions
        }));
    }
    providers.sort((left, right) => left.personId.localeCompare(right.personId) ||
        left.serverKey.localeCompare(right.serverKey) || left.source.localeCompare(right.source));

    /**
     * @param {{steamId: string|null, battlemetricsPlayerId: string|null, exactName: string|null}} subject
     * @param {string} serverKey
     */
    function getStatus(subject, serverKey) {
        const resolution = identities.resolveSubject(subject);
        const matching = providers.filter(provider => provider.personId === resolution.personId &&
            provider.serverKey === serverKey);
        let state = 'unknown';
        if (matching.some(provider => provider.currentState === 'online')) state = 'online';
        else if (matching.length > 0 && matching.every(provider => provider.currentState === 'offline')) {
            state = 'offline';
        }
        return deepFreeze({
            personId: resolution.personId,
            serverKey,
            state,
            providers: matching.map(provider => ({
                source: provider.source,
                state: provider.currentState,
                lastObservedAt: provider.lastObservedAt
            }))
        });
    }

    return deepFreeze({ providers, getStatus });
}

module.exports = Object.freeze({ projectPresence });
