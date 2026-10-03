// @ts-check
/* Latest bounded player metrics. Metrics never imply presence. */

const { deepFreeze } = require('./contracts.js');

/** @param {readonly Readonly<Record<string, any>>[]} events @param {any} identities */
function projectMetrics(events, identities) {
    const latestByKey = new Map();
    const ordered = events.filter(event => event.kind === 'player_metric_observed').slice()
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
            left.recordedAt.localeCompare(right.recordedAt) || left.eventId.localeCompare(right.eventId));

    for (const event of ordered) {
        const resolved = identities.resolveSubject(event.subject);
        if (resolved.ambiguous) continue;
        const key = [resolved.personId, event.scope.serverKey, event.payload.provider,
            event.payload.metric].join('\u0000');
        latestByKey.set(key, {
            personId: resolved.personId,
            serverKey: event.scope.serverKey,
            provider: event.payload.provider,
            metric: event.payload.metric,
            value: event.payload.value,
            unit: event.payload.unit,
            observedAt: event.observedAt
        });
    }

    const observations = [...latestByKey.values()].map(deepFreeze).sort((left, right) =>
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
