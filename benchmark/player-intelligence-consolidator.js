'use strict';

const { performance } = require('node:perf_hooks');

const Core = require('../src/plugins/playerIntelligence');
const LinearOracle = require('../test/fixtures/identityConsolidatorLinear.js');

const PERSON_COUNT = 2500;
const ALIASES_PER_PERSON = 3;
const PREPARED_OBSERVATIONS = 2500;
const COMPATIBILITY_OBSERVATIONS = 100;
const LINEAR_OBSERVATIONS = 100;

function steamId(index) {
    return `${76561197900000000n + BigInt(index)}`;
}

function buildCandidates() {
    const candidates = [];
    for (let person = 0; person < PERSON_COUNT; person += 1) {
        for (let alias = 0; alias < ALIASES_PER_PERSON; alias += 1) {
            candidates.push({
                personId: `steam:${steamId(person)}`,
                steamId: steamId(person),
                battlemetricsPlayerId: `${1000000 + person}`,
                name: alias === 0 ? `Player ${person}` : `Player ${person} Alias ${alias}`,
                preferredName: `Player ${person}`,
                nameTrusted: true,
                caseFidelity: true
            });
        }
    }
    return Object.freeze(candidates);
}

function observation(index) {
    const person = index % PERSON_COUNT;
    if (index % 3 === 0) return { steamId: steamId(person) };
    if (index % 3 === 1) return { battlemetricsPlayerId: `${1000000 + person}` };
    return { name: `Player ${person} Alias 2` };
}

function checksum(result) {
    return `${result.identity.steamId || ''}:${result.identity.battlemetricsPlayerId || ''}:` +
        `${result.identity.name || ''}:${result.status}`;
}

function run() {
    const candidates = buildCandidates();
    if (typeof global.gc === 'function') global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const prepareStarted = performance.now();
    const consolidate = Core.prepareIdentityConsolidator(candidates);
    const prepareMs = performance.now() - prepareStarted;
    if (typeof global.gc === 'function') global.gc();
    const preparedHeapBytes = process.memoryUsage().heapUsed - heapBefore;

    let preparedChecksum = '';
    const preparedStarted = performance.now();
    for (let index = 0; index < PREPARED_OBSERVATIONS; index += 1) {
        const result = consolidate(observation(index));
        if (index < Math.max(COMPATIBILITY_OBSERVATIONS, LINEAR_OBSERVATIONS)) {
            preparedChecksum += checksum(result);
        }
    }
    const preparedMs = performance.now() - preparedStarted;

    let linearChecksum = '';
    const linearStarted = performance.now();
    for (let index = 0; index < LINEAR_OBSERVATIONS; index += 1) {
        linearChecksum += checksum(LinearOracle.consolidateCandidates(candidates, observation(index)));
    }
    const linearMs = performance.now() - linearStarted;

    let compatibilityChecksum = '';
    const compatibilityStarted = performance.now();
    for (let index = 0; index < COMPATIBILITY_OBSERVATIONS; index += 1) {
        compatibilityChecksum += checksum(Core.consolidateCandidates(candidates, observation(index)));
    }
    const compatibilityMs = performance.now() - compatibilityStarted;
    if (preparedChecksum !== compatibilityChecksum || preparedChecksum !== linearChecksum) {
        throw new Error('Prepared, linear and compatibility consolidation checksums differ.');
    }

    const preparedMeanMs = preparedMs / PREPARED_OBSERVATIONS;
    const linearMeanMs = linearMs / LINEAR_OBSERVATIONS;
    const compatibilityMeanMs = compatibilityMs / COMPATIBILITY_OBSERVATIONS;
    process.stdout.write(`${JSON.stringify({
        persons: PERSON_COUNT,
        candidateRows: candidates.length,
        preparedObservations: PREPARED_OBSERVATIONS,
        linearObservations: LINEAR_OBSERVATIONS,
        compatibilityObservations: COMPATIBILITY_OBSERVATIONS,
        prepareMs: Number(prepareMs.toFixed(3)),
        preparedMeanMs: Number(preparedMeanMs.toFixed(4)),
        linearMeanMs: Number(linearMeanMs.toFixed(4)),
        compatibilityReindexMeanMs: Number(compatibilityMeanMs.toFixed(4)),
        preparedVsLinearSpeedup: Number((linearMeanMs / preparedMeanMs).toFixed(1)),
        preparedVsCompatibilitySpeedup: Number((compatibilityMeanMs / preparedMeanMs).toFixed(1)),
        preparedHeapBytes,
        gcAvailable: typeof global.gc === 'function'
    })}\n`);
}

run();
