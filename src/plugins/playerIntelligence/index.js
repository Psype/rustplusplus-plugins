// @ts-check
/* Isolated player-intelligence core. No plugin-manager, OCR or network integration. */

const Contracts = require('./contracts.js');
const HistoryStore = require('./historyStore.js');
const { projectIdentities } = require('./identityProjector.js');
const { projectClans } = require('./clanProjector.js');
const { projectPresence } = require('./presenceProjector.js');
const { projectWipes } = require('./wipeProjector.js');

/** @param {readonly Readonly<Record<string, any>>[]} events */
function rebuild(events) {
    const canonical = events.map(event => Contracts.createEvent(event));
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
    rebuild
});
