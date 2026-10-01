// @ts-check
/* Isolated player-intelligence core. No plugin-manager, OCR or network integration. */

const Contracts = require('./contracts.js');
const HistoryStore = require('./historyStore.js');
const { projectIdentities } = require('./identityProjector.js');
const { projectClans } = require('./clanProjector.js');
const { projectPresence } = require('./presenceProjector.js');
const { projectWipes } = require('./wipeProjector.js');

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

/** @param {readonly Readonly<Record<string, any>>[]} events */
function rebuild(events) {
    const canonical = effectiveEvents(events);
    const identities = projectIdentities(canonical);
    return Contracts.deepFreeze({
        identities,
        clans: projectClans(canonical, identities),
        presence: projectPresence(canonical, identities),
        wipes: projectWipes(canonical)
    });
}

module.exports = Object.freeze({
    ...Contracts,
    ...HistoryStore,
    effectiveEvents,
    rebuild
});
