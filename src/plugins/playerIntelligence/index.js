// @ts-check
/* Isolated player-intelligence core. No plugin-manager, OCR or network integration. */

const Contracts = require('./contracts.js');
const HistoryStore = require('./historyStore.js');
const { projectIdentities } = require('./identityProjector.js');
const { projectMetrics } = require('./metricProjector.js');
const { projectClans } = require('./clanProjector.js');
const { projectPresence } = require('./presenceProjector.js');
const { projectWipes } = require('./wipeProjector.js');
const IdentityConsolidator = require('./identityConsolidator.js');
const RuntimeTelemetry = require('../../util/runtimeTelemetry.js');

/** @typedef {Readonly<{
 * identities:ReturnType<typeof projectIdentities>,
 * clans:ReturnType<typeof projectClans>,
 * presence:ReturnType<typeof projectPresence>,
 * metrics:ReturnType<typeof projectMetrics>,
 * wipes:ReturnType<typeof projectWipes>
 * }>} Projection */
/** @type {WeakMap<readonly Readonly<Record<string, any>>[], Projection>} */
const rebuildCache = new WeakMap();
/** @type {WeakMap<readonly Readonly<Record<string, any>>[], readonly Readonly<Record<string, any>>[]>} */
const effectiveEventsCache = new WeakMap();

/**
 * Keep projection timings on a fixed, private-data-free dimension set. Bypassing spans while telemetry is disabled
 * also keeps this isolated core allocation-free in the normal test and library paths.
 * @template T
 * @param {'pi_rebuild_identities'|'pi_rebuild_metrics'|'pi_rebuild_clans'|'pi_rebuild_presence'|
 * 'pi_rebuild_wipes'|'pi_rebuild_total'} operation
 * @param {()=>T} action
 * @returns {T}
 */
function measured(operation, action) {
    if (!RuntimeTelemetry.isEnabled()) return action();
    const span = RuntimeTelemetry.startSpan(operation);
    try {
        const value = action();
        span.finish('success');
        return value;
    }
    catch (error) {
        span.finish('failure');
        throw error;
    }
}

/**
 * @template T
 * @param {'pi_rebuild_total'} operation
 * @param {()=>Promise<T>} action
 * @returns {Promise<T>}
 */
async function measuredAsync(operation, action) {
    if (!RuntimeTelemetry.isEnabled()) return action();
    const span = RuntimeTelemetry.startSpan(operation);
    try {
        const value = await action();
        span.finish('success');
        return value;
    }
    catch (error) {
        span.finish('failure');
        throw error;
    }
}

/** @returns {Promise<void>} */
function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

/** @param {readonly Readonly<Record<string, any>>[]} events */
function effectiveEvents(events) {
    if (Object.isFrozen(events) && effectiveEventsCache.has(events)) {
        return /** @type {readonly Readonly<Record<string, any>>[]} */ (effectiveEventsCache.get(events));
    }
    const canonical = events.map(event => Contracts.createEvent(event));
    const byId = new Map(canonical.map(event => [event.eventId, event]));
    const superseded = new Set();
    for (const marker of canonical.filter(event => event.kind === 'events_superseded')) {
        for (const eventId of marker.payload.eventIds) {
            const target = byId.get(eventId);
            if (!target) throw new TypeError(`Supersession references unknown event ${eventId}.`);
            if (target.kind === 'events_superseded') {
                throw new TypeError('Supersession markers cannot supersede another marker.');
            }
            if (target.scope.guildId !== marker.scope.guildId || target.scope.serverKey !== marker.scope.serverKey ||
                target.scope.wipeId !== marker.scope.wipeId) {
                throw new TypeError('Supersession target is outside the marker scope.');
            }
            superseded.add(eventId);
        }
    }
    const effective = Contracts.deepFreeze(canonical.filter(event => event.kind !== 'events_superseded' &&
        !superseded.has(event.eventId)));
    if (Object.isFrozen(events) && canonical.every((event, index) => event === events[index])) {
        effectiveEventsCache.set(events, effective);
    }
    return effective;
}

/** @param {readonly Readonly<Record<string, any>>[]} events @returns {Projection} */
function rebuild(events) {
    if (Object.isFrozen(events) && rebuildCache.has(events)) {
        return /** @type {Projection} */ (rebuildCache.get(events));
    }
    return measured('pi_rebuild_total', () => {
        const canonical = effectiveEvents(events);
        const identities = measured('pi_rebuild_identities', () => projectIdentities(canonical));
        const projection = Contracts.deepFreeze({
            identities,
            metrics: measured('pi_rebuild_metrics', () => projectMetrics(canonical, identities)),
            clans: measured('pi_rebuild_clans', () => projectClans(canonical, identities)),
            presence: measured('pi_rebuild_presence', () => projectPresence(canonical, identities)),
            wipes: measured('pi_rebuild_wipes', () => projectWipes(canonical))
        });
        if (Object.isFrozen(events)) rebuildCache.set(events, projection);
        return projection;
    });
}

/**
 * Cooperative variant for main-process callers. Each projector remains synchronous, but Discord/network work can run
 * between the fixed projection stages. A worker is still preferable if telemetry shows one individual stage blocking.
 * @param {readonly Readonly<Record<string, any>>[]} events
 * @param {{yieldControl?:()=>void|Promise<void>}} [options]
 * @returns {Promise<Projection>}
 */
async function rebuildAsync(events, options = {}) {
    if (Object.isFrozen(events) && rebuildCache.has(events)) {
        return /** @type {Projection} */ (rebuildCache.get(events));
    }
    const yieldControl = options.yieldControl || yieldToEventLoop;
    if (typeof yieldControl !== 'function') throw new TypeError('Rebuild yieldControl must be a function.');
    return measuredAsync('pi_rebuild_total', async () => {
        const canonical = effectiveEvents(events);
        await yieldControl();
        const identities = measured('pi_rebuild_identities', () => projectIdentities(canonical));
        await yieldControl();
        const metrics = measured('pi_rebuild_metrics', () => projectMetrics(canonical, identities));
        await yieldControl();
        const clans = measured('pi_rebuild_clans', () => projectClans(canonical, identities));
        await yieldControl();
        const presence = measured('pi_rebuild_presence', () => projectPresence(canonical, identities));
        await yieldControl();
        const wipes = measured('pi_rebuild_wipes', () => projectWipes(canonical));
        await yieldControl();
        const projection = Contracts.deepFreeze({ identities, metrics, clans, presence, wipes });
        if (Object.isFrozen(events)) rebuildCache.set(events, projection);
        return projection;
    });
}

module.exports = Object.freeze({
    ...Contracts,
    ...HistoryStore,
    ...IdentityConsolidator,
    effectiveEvents,
    rebuild,
    rebuildAsync
});
