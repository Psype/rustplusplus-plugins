const Crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const Visual = require('../src/plugins/playerIntelligence/visualAliasLibrary.js');

function feature(seed, aspectRatio = 0.55) {
    const bits = Buffer.alloc(Visual.FEATURE_WIDTH * Visual.FEATURE_HEIGHT / 8);
    for (let index = 0; index < bits.length; index += 1) {
        bits[index] = (seed * 37 + index * 17 + (index >>> 2)) & 0xff;
    }
    return Object.freeze({
        width: Visual.FEATURE_WIDTH,
        height: Visual.FEATURE_HEIGHT,
        bits: bits.toString('base64'),
        aspectRatio,
        digest: Crypto.createHash('sha256').update(bits)
            .update(`:${aspectRatio.toFixed(3)}`, 'utf8').digest('hex')
    });
}

function aliasName(index) {
    let value = index;
    let output = '';
    for (let position = 0; position < 8; position += 1) {
        output = String.fromCharCode(65 + value % 26) + output;
        value = Math.floor(value / 26);
    }
    return output;
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

const alphabet = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
const glyphSamples = Object.freeze(alphabet.flatMap((grapheme, index) => Array.from({ length: 4 }, (_, variant) => ({
    grapheme,
    feature: feature(index + 1 + variant * 101),
    observedAt: '2026-10-01T12:00:00.000Z',
    sampleId: `${index}-${variant}`
}))));
const samples = Object.freeze(Array.from({ length: 2000 }, (_, index) => ({
    name: aliasName(index),
    steamId: `7656119${`${7900000000 + index}`.padStart(10, '0')}`,
    battlemetricsPlayerId: null,
    caseFidelity: true,
    observedAt: '2026-10-01T12:00:00.000Z',
    sampleId: `${index}`.padStart(64, '0'),
    feature: feature(index + 5000, 4)
})));
const target = samples[1337].name;
const query = Object.freeze([...target].map(grapheme => Object.freeze({
    feature: glyphSamples.find(sample => sample.grapheme === grapheme).feature
})));

for (let warmup = 0; warmup < 5; warmup += 1) Visual.matchGlyphSequence(query, samples, glyphSamples);
const durations = [];
let matches = [];
for (let iteration = 0; iteration < 25; iteration += 1) {
    const started = performance.now();
    matches = Visual.matchGlyphSequence(query, samples, glyphSamples);
    durations.push(performance.now() - started);
}
if (!matches.some(match => match.sample.name === target)) throw new Error('Glyph benchmark target was not recalled.');
process.stdout.write(`${JSON.stringify({
    aliases: samples.length,
    glyphSamples: glyphSamples.length,
    graphemesPerQuery: query.length,
    medianMs: Number(median(durations).toFixed(3)),
    recalled: matches.length
})}\n`);
