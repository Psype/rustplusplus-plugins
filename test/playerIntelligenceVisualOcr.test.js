const Assert = require('node:assert/strict');
const Crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');
const { PassThrough } = require('node:stream');

const Jimp = require('jimp');

const Preprocess = require('../src/plugins/playerIntelligence/ocrImagePreprocess.js');
const TesseractOcr = require('../src/plugins/playerIntelligence/tesseractOcr.js');
const Visual = require('../src/plugins/playerIntelligence/visualAliasLibrary.js');

function newImage(width, height, color) {
    return new Promise((resolve, reject) => new Jimp(width, height, color,
        (error, image) => error ? reject(error) : resolve(image)));
}

function feature(fill, aspectRatio = 2) {
    const bits = Buffer.alloc(Visual.FEATURE_WIDTH * Visual.FEATURE_HEIGHT / 8, fill);
    return Object.freeze({
        width: Visual.FEATURE_WIDTH,
        height: Visual.FEATURE_HEIGHT,
        bits: bits.toString('base64'),
        aspectRatio,
        digest: Crypto.createHash('sha256').update(bits).update(`:${aspectRatio.toFixed(3)}`, 'utf8').digest('hex')
    });
}

Test('Rust UI preprocessing isolates every observed text color and rejects the brown world background', async () => {
    Assert.equal(Preprocess.isRustUiTextPixel(224, 224, 216), true);
    Assert.equal(Preprocess.isRustUiTextPixel(225, 168, 48), true);
    Assert.equal(Preprocess.isRustUiTextPixel(98, 191, 54), true);
    Assert.equal(Preprocess.isRustUiTextPixel(47, 166, 226), true);
    Assert.equal(Preprocess.isRustUiTextPixel(135, 61, 36), false);
    Assert.equal(Preprocess.isRustUiTextPixel(125, 125, 125), false);
    Assert.equal(Preprocess.isRustF7TextPixel(125, 125, 125), true);

    const image = await newImage(20, 10, 0x873d24ff);
    for (let x = 2; x < 18; x += 1) image.setPixelColor(0xffffffff, x, 5);
    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const result = await Preprocess.createTextMask(buffer.toString('base64'), {
        scale: 2, minForegroundRatio: 0.001
    });
    Assert.equal(result.width, 40);
    Assert.equal(result.height, 20);
    Assert.equal(result.scale, 2);
    Assert.equal(result.foregroundRatio, 0.08);
    Assert.equal(Object.isFrozen(result), true);
});

Test('Tesseract user dictionary is bounded, Unicode-preserving and word-based', () => {
    Assert.deepEqual(TesseractOcr.normalizeUserWords([
        '  Jeffrey  Kirkstein The 3rd ', 'Jeffrey', '\u0637\u0644\u0627\u0644', 'A\u0000B'
    ]), ['Jeffrey', 'Kirkstein', 'The', '3rd', '\u0637\u0644\u0627\u0644', 'A', 'B']);
    Assert.throws(() => TesseractOcr.normalizeUserWords(['valid', 3]), /contain strings/);
});

Test('Tesseract receives the generated user-word file and removes it after recognition', async () => {
    let temporaryFile = '';
    let contents = '';
    const spawnImpl = (_executable, args) => {
        const index = args.indexOf('--user-words');
        Assert.notEqual(index, -1);
        Assert.equal(args.includes('tessedit_char_whitelist=0123456789/: '), true);
        temporaryFile = args[index + 1];
        contents = Fs.readFileSync(temporaryFile, 'utf8');
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => {};
        child.stdin.once('finish', () => {
            child.stdout.write([
                'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
                '5\t1\t1\t1\t1\t1\t1\t2\t3\t4\t95\tNirks'
            ].join('\n'));
            child.emit('close', 0);
        });
        return child;
    };
    const words = await TesseractOcr.recognize(Buffer.from('image').toString('base64'), {
        spawnImpl, userWords: ['Nirks', 'Jeffrey Kirkstein'], characterWhitelist: '0123456789/: '
    });
    Assert.equal(words[0].text, 'Nirks');
    Assert.equal(contents, 'Nirks\nJeffrey\nKirkstein\n');
    Assert.equal(Fs.existsSync(temporaryFile), false);
    Assert.equal(Fs.existsSync(Path.dirname(temporaryFile)), false);
});

Test('visual aliases persist outside code and exact collisions remain explicit candidates', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-alias-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    const sharedFeature = feature(0x55);
    const first = {
        visualSamples: [{ memberIndex: 0, observedText: 'RW', boundaryProof: true, feature: sharedFeature }],
        parsed: { kind: 'cinfo', resolvedMembers: [{
            memberIndex: 0, name: 'RW', steamId: '76561197900000001', battlemetricsPlayerId: null
        }] }
    };
    const second = {
        visualSamples: [{ memberIndex: 0, observedText: 'RW', boundaryProof: true, feature: sharedFeature }],
        parsed: { kind: 'cinfo', resolvedMembers: [{
            memberIndex: 0, name: 'RW', steamId: '76561197900000002', battlemetricsPlayerId: null
        }] }
    };
    Assert.deepEqual(await Visual.recordResolved(file, [first], '2026-10-01T12:00:00.000Z'),
        { added: 1, total: 1 });
    Assert.deepEqual(await Visual.recordResolved(file, [second], '2026-10-01T12:01:00.000Z'),
        { added: 1, total: 2 });
    Assert.equal((await Visual.read(file)).samples.length, 2);

    const matches = await Visual.candidatesForItems(file, [{
        visualSamples: [{ memberIndex: 3, boundaryProof: true, feature: sharedFeature }]
    }]);
    Assert.equal(matches[0].length, 2);
    Assert.equal(matches[0].every(candidate => candidate.corroborated && candidate.visualScore === 1 &&
        candidate.targetMemberIndex === 3), true);
    Assert.deepEqual(matches[0].map(candidate => candidate.steamId).sort(),
        ['76561197900000001', '76561197900000002']);
});

Test('F7 name shapes seed the persistent library with their exact SteamID and non-canonical case', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-f7-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    const image = await newImage(180, 60, 0x5d514cff);
    for (let y = 5; y < 18; y += 1) {
        for (let x = 10; x < 42; x += 1) {
            if ((x + y) % 3 !== 0) image.setPixelColor(0xffffffff, x, y);
        }
    }
    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const blocks = [{
        words: [
            { text: 'RW', x: 10, y: 5, width: 32, height: 13, confidence: 95 },
            { text: '76561197976022895', x: 10, y: 25, width: 130, height: 12, confidence: 95 }
        ],
        parsed: { kind: 'f7', entries: [{
            name: 'RW', steamId: '76561197976022895', ambiguous: false
        }] }
    }];
    const extracted = await Visual.extractVisualSamples(buffer.toString('base64'), blocks);
    Assert.equal(extracted[0].length, 1);
    await Visual.recordResolved(file, [{ ...blocks[0], visualSamples: extracted[0] }],
        '2026-10-01T12:00:00.000Z');
    const sample = (await Visual.read(file)).samples[0];
    Assert.equal(sample.name, 'RW');
    Assert.equal(sample.steamId, '76561197976022895');
    Assert.equal(sample.caseFidelity, false);
});

Test('rejecting an F7 row never shifts a later visual sample onto the wrong SteamID', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-f7-index-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    const firstShape = feature(0x21);
    const secondShape = feature(0x42);
    await Visual.recordResolved(file, [{
        parsed: { kind: 'f7', entries: [{
            name: 'Second', steamId: '76561198052859299', ambiguous: false, visualMemberIndex: 1
        }] },
        visualSamples: [
            { memberIndex: 0, observedText: 'Rejected', boundaryProof: true, feature: firstShape },
            { memberIndex: 1, observedText: 'SECOND', boundaryProof: true, feature: secondShape }
        ]
    }], '2026-10-02T12:00:00.000Z');
    const samples = (await Visual.read(file)).samples;
    Assert.equal(samples.length, 1);
    Assert.equal(samples[0].steamId, '76561198052859299');
    Assert.equal(samples[0].feature.digest, secondShape.digest);
});

Test('an exact-ID Steam recovery learns the canonical visual alias, never the bad OCR text', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-f7-steam-recovery-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    await Visual.recordResolved(file, [{
        parsed: { kind: 'f7', entries: [{
            name: 'Kasane Teto', steamId: '76561198875390964', ambiguous: false,
            visualMemberIndex: 0, profileNameRecovered: true, ocrObservedName: 'of a'
        }] },
        visualSamples: [{ memberIndex: 0, observedText: 'of a', boundaryProof: true, feature: feature(0x63) }]
    }], '2026-10-02T13:49:00.000Z');

    const samples = (await Visual.read(file)).samples;
    Assert.equal(samples.length, 1);
    Assert.equal(samples[0].name, 'Kasane Teto');
    Assert.equal(samples[0].steamId, '76561198875390964');
    Assert.equal(samples.some(sample => sample.name === 'of a'), false);
});

Test('an OCR-consensus-only F7 pair never trains authoritative visual identity evidence', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-f7-consensus-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    await Visual.recordResolved(file, [{
        parsed: { kind: 'f7', entries: [{
            name: '零^X^LAZY2ERO', steamId: '76561198843692446', ambiguous: false,
            visualMemberIndex: 0, identityConfidence: 'probable', ocrConsensusOnly: true
        }] },
        visualSamples: [{ memberIndex: 0, observedText: '零^X^LAZY2ERO',
            boundaryProof: true, feature: feature(0x64) }]
    }], '2026-10-02T14:13:00.000Z');

    Assert.equal((await Visual.read(file)).samples.length, 0);
});

Test('partial cinfo rosters cannot emit or persist position-based visual samples', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-partial-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    const image = await newImage(2, 2, 0xffffffff);
    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const block = {
        words: [],
        parsed: {
            kind: 'cinfo', complete: false, declaredCount: 6,
            members: [{ name: 'Marley' }, { name: 'Swizzy' }],
            resolvedMembers: [{
                memberIndex: 1, name: 'Swizzy', steamId: '76561197900000031',
                battlemetricsPlayerId: null
            }]
        }
    };
    Assert.deepEqual(await Visual.extractVisualSamples(buffer.toString('base64'), [block]), [[]]);
    Assert.deepEqual(await Visual.recordResolved(file, [{
        ...block,
        visualSamples: [{ memberIndex: 1, observedText: 'Swizzy', feature: feature(0x55) }]
    }], '2026-10-01T12:00:00.000Z'), { added: 0, total: 0 });
    Assert.equal((await Visual.read(file)).samples.length, 0);
});

Test('corrupt visual library is preserved and rejected instead of silently reset', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-alias-corrupt-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    Fs.writeFileSync(file, '{broken', 'utf8');
    await Assert.rejects(() => Visual.read(file), error =>
        error instanceof Visual.VisualAliasLibraryCorruptionError);
    Assert.equal(Fs.readFileSync(file, 'utf8'), '{broken');
});

Test('approximate visual similarity retrieves but never marks an identity corroborated', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-alias-approx-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    const known = feature(0x55);
    await Visual.recordResolved(file, [{
        visualSamples: [{ memberIndex: 0, observedText: 'Player', boundaryProof: true, feature: known }],
        parsed: { kind: 'cinfo', resolvedMembers: [{
            memberIndex: 0, name: 'Player', steamId: '76561197900000003', battlemetricsPlayerId: null
        }] }
    }], '2026-10-01T12:00:00.000Z');
    const changed = feature(0x54);
    const result = await Visual.candidatesForItems(file, [{
        visualSamples: [{ memberIndex: 0, boundaryProof: true, feature: changed }]
    }]);
    Assert.equal(result[0].length, 1);
    Assert.equal(result[0][0].corroborated, false);
    Assert.equal(result[0][0].contextPriority, true);
});

Test('resolved cinfo learns persistent grapheme shapes and recalls an alias from them', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-glyph-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    const glyphA = feature(0x0f, 0.5);
    const glyphB = feature(0xf0, 0.55);
    await Visual.recordResolved(file, [{
        visualSamples: [{
            memberIndex: 0,
            observedText: 'AB',
            boundaryProof: true,
            feature: feature(0x55),
            glyphs: [{ grapheme: 'A', feature: glyphA }, { grapheme: 'B', feature: glyphB }]
        }],
        parsed: { kind: 'cinfo', resolvedMembers: [{
            memberIndex: 0, name: 'AB', steamId: '76561197900000004', battlemetricsPlayerId: null
        }] }
    }], '2026-10-01T12:00:00.000Z');

    const document = await Visual.read(file);
    Assert.equal(document.schemaVersion, 4);
    Assert.deepEqual(document.glyphSamples.map(sample => sample.grapheme), ['A', 'B']);
    const result = await Visual.candidatesForItems(file, [{
        visualSamples: [{
            memberIndex: 7,
            boundaryProof: true,
            feature: feature(0xaa),
            glyphs: [{ feature: glyphA }, { feature: glyphB }]
        }]
    }]);
    Assert.equal(result[0][0].name, 'AB');
    Assert.equal(result[0][0].targetMemberIndex, 7);
    Assert.equal(result[0][0].corroborated, false);
    Assert.equal(result[0][0].visualScore, 0.999999);
});

Test('visual journal refuses every cinfo shape whose OCR spelling differs from the resolved alias', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-glyph-refuse-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    await Visual.recordResolved(file, [{
        visualSamples: [{
            memberIndex: 0,
            observedText: 'A8',
            boundaryProof: true,
            feature: feature(0x55),
            glyphs: [
                { grapheme: 'A', feature: feature(0x0f, 0.5) },
                { grapheme: '8', feature: feature(0xf0, 0.55) }
            ]
        }],
        parsed: { kind: 'cinfo', resolvedMembers: [{
            memberIndex: 0, name: 'AB', steamId: '76561197900000005', battlemetricsPlayerId: null
        }] }
    }], '2026-10-01T12:00:00.000Z');
    const document = await Visual.read(file);
    Assert.equal(document.samples.length, 0);
    Assert.equal(document.glyphSamples.length, 0);
});

Test('word boxes yield glyphs only when foreground runs match Unicode graphemes', async () => {
    const image = await newImage(20, 12, 0x5d514cff);
    for (let y = 2; y < 10; y += 1) {
        for (let x = 2; x < 5; x += 1) image.setPixelColor(0xffffffff, x, y);
        for (let x = 8; x < 12; x += 1) image.setPixelColor(0xffffffff, x, y);
    }
    const glyphs = Visual.glyphFeaturesFromBoxes(image,
        [{ text: 'AB', x: 1, y: 1, width: 12, height: 10 }], 'AB');
    Assert.deepEqual(glyphs.map(glyph => glyph.grapheme), ['A', 'B']);
    Assert.equal(glyphs.every(glyph => Visual.validateFeature(glyph.feature)), true);
    Assert.deepEqual(Visual.glyphFeaturesFromBoxes(image,
        [{ text: '玩家', x: 1, y: 1, width: 12, height: 10 }], '玩家')
        .map(glyph => glyph.grapheme), ['玩', '家']);
    Assert.deepEqual(Visual.glyphFeaturesFromBoxes(image,
        [{ text: 'ABC', x: 1, y: 1, width: 12, height: 10 }], 'ABC'), []);
});

Test('pre-boundary visual journals are invalidated in memory without trusting shifted samples', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-visual-schema-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const file = Path.join(directory, 'visual-alias-library.json');
    await Visual.recordResolved(file, [{
        visualSamples: [{
            memberIndex: 0, observedText: 'RW', boundaryProof: true, feature: feature(0x55)
        }],
        parsed: { kind: 'cinfo', resolvedMembers: [{
            memberIndex: 0, name: 'RW', steamId: '76561197900000006', battlemetricsPlayerId: null
        }] }
    }], '2026-10-01T12:00:00.000Z');
    const legacy = JSON.parse(Fs.readFileSync(file, 'utf8'));
    legacy.schemaVersion = 3;
    delete legacy.confirmedUserWords;
    Fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`, 'utf8');
    const trustedSchemaThree = await Visual.read(file);
    Assert.equal(trustedSchemaThree.samples.length, 1);

    legacy.schemaVersion = 2;
    Fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`, 'utf8');

    const migrated = await Visual.read(file);
    Assert.equal(migrated.schemaVersion, 4);
    Assert.equal(migrated.samples.length, 0);
    Assert.deepEqual(migrated.glyphSamples, []);
});
