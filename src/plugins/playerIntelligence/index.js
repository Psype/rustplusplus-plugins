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

/** @typedef {Readonly<{
 * identities:ReturnType<typeof projectIdentities>,
 * clans:ReturnType<typeof projectClans>,
 * presence:ReturnType<typeof projectPresence>,
 * metrics:ReturnType<typeof projectMetrics>,
 * wipes:ReturnType<typeof projectWipes>
 * }>} Projection */
/** @type {WeakMap<readonly Readonly<Record<string, any>>[], Projection>} */
const rebuildCache = new WeakMap();

/** @param {readonly Readonly<Record<string, any>>[]} events */
function effectiveEvents(events) {
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
    return Contracts.deepFreeze(canonical.filter(event => event.kind !== 'events_superseded' &&
        !superseded.has(event.eventId)));
}

/** @param {readonly Readonly<Record<string, any>>[]} events @returns {Projection} */
function rebuild(events) {
    if (Object.isFrozen(events) && rebuildCache.has(events)) {
        return /** @type {Projection} */ (rebuildCache.get(events));
    }
    const canonical = effectiveEvents(events);
    const identities = projectIdentities(canonical);
    const projection = Contracts.deepFreeze({
        identities,
        metrics: projectMetrics(canonical, identities),
        clans: projectClans(canonical, identities),
        presence: projectPresence(canonical, identities),
        wipes: projectWipes(canonical)
    });
    if (Object.isFrozen(events)) rebuildCache.set(events, projection);
    return projection;
}

module.exports = Object.freeze({
    ...Contracts,
    ...HistoryStore,
    ...IdentityConsolidator,
    effectiveEvents,
    rebuild
});
