const Assert = require('node:assert/strict');
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Memory = require('../src/plugins/playerIntelligence/ocrCorrectionMemory.js');
const Visual = require('../src/plugins/playerIntelligence/visualAliasLibrary.js');

function feature(fill, aspectRatio = 5) {
    const bits = Buffer.alloc(Visual.FEATURE_WIDTH * Visual.FEATURE_HEIGHT / 8, fill);
    return Object.freeze({
        width: Visual.FEATURE_WIDTH,
        height: Visual.FEATURE_HEIGHT,
        bits: bits.toString('base64'),
        aspectRatio,
        digest: Crypto.createHash('sha256').update(bits)
            .update(`:${aspectRatio.toFixed(3)}`, 'utf8').digest('hex')
    });
}

function cinfoItem(shape, confirmedName = null) {
    return Object.freeze({
        parsed: Object.freeze({
            kind: 'cinfo', tag: 'FBM', declaredCount: 2, complete: true,
            members: Object.freeze([
                Object.freeze({ name: '1 Marley 4', role: 'moderator' }),
                Object.freeze({ name: 'Swizzy', role: 'member' })
            ])
        }),
        visualSamples: Object.freeze([
            Object.freeze({ memberIndex: 0, observedText: '1 Marley 4', boundaryProof: true, feature: shape }),
            Object.freeze({ memberIndex: 1, observedText: 'Swizzy', boundaryProof: true, feature: feature(0x44, 3) })
        ]),
        ...(confirmedName ? { confirmedCorrectionNames: Object.freeze([confirmedName, 'Swizzy']) } : {})
    });
}

Test('confirmed visual corrections survive restart and correct only their proven member slot', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-ocr-correction-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'ocr-correction-memory.json');
    const shape = feature(0x33);

    Assert.deepEqual(await Memory.read(file), { schemaVersion: 1, templates: [] });
    Assert.deepEqual(await Memory.recordConfirmed(file, [cinfoItem(shape, '』 Marley 』')],
        '2026-10-02T12:00:00.000Z'), { added: 1, total: 1 });
    const persisted = JSON.parse(Fs.readFileSync(file, 'utf8'));
    Assert.equal(persisted.templates[0].correctedText, '』 Marley 』');
    Assert.equal('steamId' in persisted.templates[0], false);

    const [corrected] = await Memory.apply(file, [cinfoItem(shape)], []);
    Assert.equal(corrected.parsed.members[0].name, '』 Marley 』');
    Assert.equal(corrected.parsed.members[0].ocrObservedText, '1 Marley 4');
    Assert.equal(corrected.parsed.members[0].role, 'moderator');
    Assert.equal(corrected.parsed.members[1].name, 'Swizzy');
});

Test('conflicting labels for one exact visual shape fail closed', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-ocr-collision-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'ocr-correction-memory.json');
    const shape = feature(0x55);
    await Memory.recordConfirmed(file, [cinfoItem(shape, '』 Marley 』')], '2026-10-02T12:00:00.000Z');
    await Memory.recordConfirmed(file, [cinfoItem(shape, 'Different Player')], '2026-10-02T12:01:00.000Z');
    const [unchanged] = await Memory.apply(file, [cinfoItem(shape)], []);
    Assert.equal(unchanged.parsed.members[0].name, '1 Marley 4');
});

Test('legacy confirmed names repair separated edge glyphs but never rewrite attached or short names', () => {
    Assert.equal(Memory.confirmedNameHint('1 Marley 4', ['』 Marley 』']), '』 Marley 』');
    Assert.equal(Memory.confirmedNameHint('1Marley4', ['』 Marley 』']), null);
    Assert.equal(Memory.confirmedNameHint('1 Rw 4', ['』 Rw 』']), null);
    const [corrected] = Memory.applyConfirmedNameHints([cinfoItem(feature(0x66))], ['』 Marley 』']);
    Assert.equal(corrected.parsed.members[0].name, '』 Marley 』');
    Assert.equal(corrected.parsed.members[1].name, 'Swizzy');
});

Test('a corrupt correction memory is preserved and rejected', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-ocr-corrupt-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'ocr-correction-memory.json');
    Fs.writeFileSync(file, '{broken', 'utf8');
    await Assert.rejects(() => Memory.read(file), Memory.OcrCorrectionMemoryCorruptionError);
    Assert.equal(Fs.readFileSync(file, 'utf8'), '{broken');
});
