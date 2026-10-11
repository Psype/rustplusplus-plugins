'use strict';

const { performance } = require('node:perf_hooks');

const { projectIdentities } = require('../src/plugins/playerIntelligence/identityProjector.js');
const { projectMetrics } = require('../src/plugins/playerIntelligence/metricProjector.js');
const { projectPresence } = require('../src/plugins/playerIntelligence/presenceProjector.js');

const PLAYER_COUNT = Number.parseInt(process.env.RPP_BENCH_PLAYERS || '2700', 10);
const IDENTITY_OBSERVATIONS = Number.parseInt(process.env.RPP_BENCH_IDENTITIES || '6', 10);
const PRESENCE_TRANSITIONS = Number.parseInt(process.env.RPP_BENCH_PRESENCE || '12', 10);
const METRIC_OBSERVATIONS = Number.parseInt(process.env.RPP_BENCH_METRICS || '12', 10);
const BASE_TIME = Date.parse('2026-10-01T00:00:00.000Z');

function steamId(index) {
    return (76561197900000000n + BigInt(index)).toString();
}

function timestamp(sequence) {
    return new Date(BASE_TIME + sequence * 1000).toISOString();
}

function identityEvent(player, observation) {
    const time = timestamp(observation * PLAYER_COUNT + player);
    return Object.freeze({
        kind: 'identity_observed',
        eventId: `identity-${observation}-${player}`,
        observedAt: time,
        recordedAt: time,
        subject: Object.freeze({
            steamId: steamId(player),
            battlemetricsPlayerId: `${1000000 + player}`,
            exactName: `Player ${`${player}`.padStart(4, '0')} Alias ${observation % 3}`
        }),
        payload: Object.freeze({ caseFidelity: true }),
        provenance: Object.freeze({ source: 'warbandits' }),
        confidence: 'verified'
    });
}

function presenceEvent(player, transition) {
    return Object.freeze({
        kind: 'presence_observed',
        eventId: `presence-${transition}-${player}`,
        observedAt: timestamp(100000 + transition * PLAYER_COUNT + player),
        scope: Object.freeze({ serverKey: 'battlemetrics:benchmark' }),
        subject: Object.freeze({
            steamId: steamId(player), battlemetricsPlayerId: `${1000000 + player}`, exactName: null
        }),
        payload: Object.freeze({
            state: transition % 2 === 0 ? 'online' : 'offline',
            providerSessionId: `session-${Math.floor(transition / 2)}`,
            reason: null
        }),
        provenance: Object.freeze({ source: 'battlemetrics' })
    });
}

function metricEvent(player, observation) {
    const observedAt = timestamp(200000 + observation * PLAYER_COUNT + player);
    return Object.freeze({
        kind: 'player_metric_observed',
        eventId: `metric-${observation}-${player}`,
        observedAt,
        recordedAt: observedAt,
        scope: Object.freeze({ serverKey: 'battlemetrics:benchmark' }),
        subject: Object.freeze({
            steamId: steamId(player), battlemetricsPlayerId: `${1000000 + player}`, exactName: null
        }),
        payload: Object.freeze({ provider: 'warbandits', metric: 'playtime', value: observation, unit: 'hours' })
    });
}

function repeatedEvents(count, factory) {
    const values = [];
    for (let observation = 0; observation < count; observation += 1) {
        for (let player = 0; player < PLAYER_COUNT; player += 1) values.push(factory(player, observation));
    }
    // A rebuild cannot rely on append order: deliberately reverse alternating windows.
    for (let start = 0; start < values.length; start += PLAYER_COUNT * 2) {
        values.splice(start, Math.min(PLAYER_COUNT * 2, values.length - start),
            ...values.slice(start, start + PLAYER_COUNT * 2).reverse());
    }
    return Object.freeze(values);
}

function measure(action) {
    if (typeof global.gc === 'function') global.gc();
    const before = process.memoryUsage();
    const started = performance.now();
    const value = action();
    const elapsedMs = performance.now() - started;
    const after = process.memoryUsage();
    if (typeof global.gc === 'function') global.gc();
    const retained = process.memoryUsage();
    return {
        value,
        result: {
            elapsedMs: Number(elapsedMs.toFixed(3)),
            heapDeltaBytes: after.heapUsed - before.heapUsed,
            rssDeltaBytes: after.rss - before.rss,
            retainedHeapDeltaBytes: retained.heapUsed - before.heapUsed
        }
    };
}

const identityEvents = repeatedEvents(IDENTITY_OBSERVATIONS, identityEvent);
const presenceEvents = repeatedEvents(PRESENCE_TRANSITIONS, presenceEvent);
const metricEvents = repeatedEvents(METRIC_OBSERVATIONS, metricEvent);
const allEvents = Object.freeze([...identityEvents, ...presenceEvents, ...metricEvents]);

const identityRun = measure(() => projectIdentities(allEvents));
const metricRun = measure(() => projectMetrics(allEvents, identityRun.value));
const presenceRun = measure(() => projectPresence(allEvents, identityRun.value));

process.stdout.write(`${JSON.stringify({
    players: PLAYER_COUNT,
    eventCount: allEvents.length,
    identityEventCount: identityEvents.length,
    presenceEventCount: presenceEvents.length,
    metricEventCount: metricEvents.length,
    identities: { ...identityRun.result, persons: identityRun.value.persons.length },
    metrics: { ...metricRun.result, observations: metricRun.value.observations.length },
    presence: { ...presenceRun.result, providers: presenceRun.value.providers.length,
        transitions: presenceRun.value.providers.reduce((sum, provider) => sum + provider.transitions.length, 0) }
})}\n`);
