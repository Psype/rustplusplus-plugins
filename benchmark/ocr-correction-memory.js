const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { performance } = require('node:perf_hooks');

const Memory = require('../src/plugins/playerIntelligence/ocrCorrectionMemory.js');
const Visual = require('../src/plugins/playerIntelligence/visualAliasLibrary.js');

function feature(seed, aspectRatio = 4) {
    const length = Visual.FEATURE_WIDTH * Visual.FEATURE_HEIGHT / 8;
    const bits = Buffer.alloc(length);
    let offset = 0;
    let round = 0;
    while (offset < bits.length) {
        const chunk = Crypto.createHash('sha256').update(`${seed}:${round}`, 'utf8').digest();
        chunk.copy(bits, offset);
        offset += chunk.length;
        round += 1;
    }
    const bounded = bits.subarray(0, length);
    return Object.freeze({
        width: Visual.FEATURE_WIDTH,
        height: Visual.FEATURE_HEIGHT,
        bits: bounded.toString('base64'),
        aspectRatio,
        digest: Crypto.createHash('sha256').update(bounded)
            .update(`:${aspectRatio.toFixed(3)}`, 'utf8').digest('hex')
    });
}

function template(index) {
    const observedText = `OCR Player ${index}`;
    const correctedText = `Player ${index}`;
    const shape = feature(index);
    return Object.freeze({
        templateId: Crypto.createHash('sha256').update(`${observedText}\0${correctedText}\0${
            shape.digest}`, 'utf8').digest('hex'),
        observedText,
        correctedText,
        confirmedAt: '2026-10-02T12:00:00.000Z',
        feature: shape
    });
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-ocr-correction-benchmark-'));
    const file = Path.join(directory, 'ocr-correction-memory.json');
    try {
        const templates = Array.from({ length: Memory.MAX_TEMPLATES }, (_, index) => template(index));
        Fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: Memory.SCHEMA_VERSION, templates })}\n`, 'utf8');
        const targets = [113, 337, 661, 985, 1309, 1999];
        const item = Object.freeze({
            parsed: Object.freeze({ kind: 'cinfo', declaredCount: targets.length, complete: true,
                members: Object.freeze(targets.map(index => Object.freeze({
                    name: `OCR Player ${index}`, role: 'member'
                }))) }),
            visualSamples: Object.freeze(targets.map((index, memberIndex) => Object.freeze({
                memberIndex, observedText: `OCR Player ${index}`, boundaryProof: true,
                feature: templates[index].feature
            })))
        });
        for (let warmup = 0; warmup < 3; warmup += 1) await Memory.apply(file, [item], []);
        const durations = [];
        for (let iteration = 0; iteration < 20; iteration += 1) {
            const started = performance.now();
            const [corrected] = await Memory.apply(file, [item], []);
            durations.push(performance.now() - started);
            if (corrected.parsed.members.some((member, index) => member.name !== `Player ${targets[index]}`)) {
                throw new Error('OCR correction benchmark recall failed.');
            }
        }
        process.stdout.write(`${JSON.stringify({ templates: templates.length, members: targets.length,
            medianMs: Number(median(durations).toFixed(3)), maxMs: Number(Math.max(...durations).toFixed(3)) })}\n`);
    }
    finally {
        Fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
