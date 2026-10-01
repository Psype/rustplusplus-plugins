// @ts-check
/* Wipe observations remain versioned snapshots rather than mutable dates. */

const { deepFreeze } = require('./contracts.js');

/** @param {readonly Readonly<Record<string, any>>[]} events */
function projectWipes(events) {
    const snapshots = events.filter(event => event.kind === 'wipe_snapshot').map(event => ({
        eventId: event.eventId,
        observedAt: event.observedAt,
        serverKey: event.scope.serverKey,
        wipeId: event.scope.wipeId,
        startsAt: event.payload.startsAt,
        endsAt: event.payload.endsAt,
        source: event.provenance.source,
        confidence: event.confidence
    })).sort((left, right) => left.serverKey.localeCompare(right.serverKey) ||
        left.wipeId.localeCompare(right.wipeId) || left.observedAt.localeCompare(right.observedAt));
    return deepFreeze({ snapshots });
}

module.exports = Object.freeze({ projectWipes });
