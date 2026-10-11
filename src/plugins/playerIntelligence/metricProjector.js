// @ts-check
/* Latest bounded player metrics. Metrics never imply presence. */

const { deepFreeze } = require('./contracts.js');

/** @param {readonly Readonly<Record<string, any>>[]} events @param {any} identities */
function projectMetrics(events, identities) {
    /** @type {Map<string, Readonly<Record<string, any>>>} */
    const latestEventByKey = new Map();
    for (const event of events) {
        if (event.kind !== 'player_metric_observed') continue;
        const resolved = identities.resolveSubject(event.subject);
        if (resolved.ambiguous) continue;
        const key = [resolved.personId, event.scope.serverKey, event.payload.provider,
            event.payload.metric].join('\u0000');
        const previous = latestEventByKey.get(key);
        if (previous && (previous.observedAt.localeCompare(event.observedAt) > 0 ||
            (previous.observedAt === event.observedAt && previous.recordedAt.localeCompare(event.recordedAt) > 0) ||
            (previous.observedAt === event.observedAt && previous.recordedAt === event.recordedAt &&
                previous.eventId.localeCompare(event.eventId) > 0))) continue;
        latestEventByKey.set(key, event);
    }

    const observations = [...latestEventByKey.entries()].map(([key, event]) => {
        const [personId] = key.split('\u0000', 1);
        return deepFreeze({
            personId,
            serverKey: event.scope.serverKey,
            provider: event.payload.provider,
            metric: event.payload.metric,
            value: event.payload.value,
            unit: event.payload.unit,
            observedAt: event.observedAt
        });
    }).sort((left, right) =>
        left.personId.localeCompare(right.personId) || left.serverKey.localeCompare(right.serverKey) ||
        left.provider.localeCompare(right.provider) || left.metric.localeCompare(right.metric));
    const frozenByKey = new Map(observations.map(value => [[value.personId, value.serverKey, value.provider,
        value.metric].join('\u0000'), value]));

    /** @param {any} subject @param {string} serverKey @param {string} provider @param {string} metric */
    function getLatest(subject, serverKey, provider, metric) {
        const resolved = identities.resolveSubject(subject);
        if (resolved.ambiguous) return null;
        return frozenByKey.get([resolved.personId, serverKey, provider, metric].join('\u0000')) || null;
    }

    return deepFreeze({ observations, getLatest });
}

module.exports = Object.freeze({ projectMetrics });
