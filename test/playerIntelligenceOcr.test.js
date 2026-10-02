const Assert = require('node:assert/strict');
const Test = require('node:test');

const { parseCinfoWords, splitCinfoWordBlocks } = require('../src/plugins/playerIntelligence/parseCinfo.js');
const { parseF7Words } = require('../src/plugins/playerIntelligence/parseF7.js');
const { detectImportKind } = require('../src/plugins/playerIntelligence/detectImportKind.js');
const ImageAttachment = require('../src/plugins/playerIntelligence/imageAttachment.js');
const TesseractOcr = require('../src/plugins/playerIntelligence/tesseractOcr.js');
const CinfoRoles = require('../src/plugins/playerIntelligence/cinfoRoles.js');
const F7IdentityValidation = require('../src/plugins/playerIntelligence/f7IdentityValidation.js');

function word(text, x, y, width = Math.max(8, text.length * 7), height = 14) {
    return { text, x, y, width, height, confidence: 95 };
}

Test('cinfo OCR parser handles supplied wrapped rosters and Unicode without pixel templates', () => {
    const fixtures = [
        ['zeub', 3, 'Nirks, Psype and tom.le.geek.2', '09/29/2026 14:58:27',
            ['Nirks', 'Psype', 'tom.le.geek.2']],
        ['FBM', 6, 'Rw, Elliot, ♫ Marley ♫, Swizzy, Jeffrey\nKirkstein The 3rd and U Got Kirkified',
            '09/29/2026 14:00:08', ['Rw', 'Elliot', '♫ Marley ♫', 'Swizzy',
                'Jeffrey Kirkstein The 3rd', 'U Got Kirkified']],
        ['xD', 5, 'd.ve, Nova, Cockonut Tree, Mr Tutel and RangerMS', '09/30/2026 16:02:50',
            ['d.ve', 'Nova', 'Cockonut Tree', 'Mr Tutel', 'RangerMS']],
        ['XIV', 7, 'TEA, !Po, +=import&**, VitMoc767,\nFaryasRL, UwUIKOTAR and BelaRusツ',
            '09/29/2026 14:03:32', ['TEA', '!Po', '+=import&**', 'VitMoc767',
                'FaryasRL', 'UwUIKOTAR', 'BelaRusツ']]
    ];

    for (const [tag, count, roster, established, expected] of fixtures) {
        const rosterLines = roster.split('\n');
        const words = [
            word(`ClanTag: ${tag}`, 31, 25, 170, 18),
            word(`Members: ${count}`, 31, 51, 140, 18),
            word(`Clan Members: ${rosterLines[0]}`, 31, 77, 640, 18),
            ...rosterLines.slice(1).map((line, index) => word(line, 31, 103 + index * 26, 640, 18)),
            word(`Established: ${established}`, 31, 103 + (rosterLines.length - 1) * 26, 330, 18)
        ];
        const result = parseCinfoWords(words);
        Assert.equal(result.tag, tag);
        Assert.equal(result.complete, true, result.errors.join(' '));
        Assert.deepEqual(result.members.map(member => member.name), expected);
        Assert.equal(result.establishedRaw, established);
        Assert.match(result.establishedAtUtc, /^2026-/);
        Assert.equal(Object.isFrozen(result), true);
        Assert.equal(Object.isFrozen(result.members), true);
    }
});

Test('cinfo OCR parser blocks an inconsistent declared roster', () => {
    const result = parseCinfoWords([
        word('ClanTag: BAD', 10, 10),
        word('Members: 3', 10, 30),
        word('Clan Members: Alice and Bob', 10, 50),
        word('Established: 09/29/2026 14:00:08', 10, 70)
    ]);
    Assert.equal(result.complete, false);
    Assert.match(result.errors.join(' '), /Roster count mismatch/);
});

Test('cinfo OCR parser splits repeated semantic panels without fixed coordinates', () => {
    const words = [];
    const fixtures = [
        ['zeub', 3, 'Nirks, Psype and tom.le.geek.2', '09/29/2026 14:58:27'],
        ['xD', 5, 'd.ve, Nova, Cockonut Tree, Mr Tutel and RangerMS', '09/30/2026 16:02:50'],
        ['FBM', 3, 'Rw, Elliot and Swizzy', '09/29/2026 14:00:08']
    ];
    fixtures.forEach(([tag, count, roster, established], index) => {
        const y = 20 + index * 140;
        words.push(word(`ClanTag: ${tag}`, 20, y), word(`Members: ${count}`, 20, y + 25),
            word(`Clan Members: ${roster}`, 20, y + 50), word(`Established: ${established}`, 20, y + 75));
    });
    const blocks = splitCinfoWordBlocks(words);
    Assert.equal(blocks.length, 3);
    Assert.deepEqual(blocks.map(block => parseCinfoWords(block).tag), ['zeub', 'xD', 'FBM']);
    Assert.equal(blocks.every(block => parseCinfoWords(block).complete), true);
    Assert.equal(detectImportKind(words), 'cinfo');
});

Test('F7 OCR parser associates relative rows, retains complete ID-only rows and rejects partial IDs', () => {
    const result = parseF7Words([
        word('FIND', 30, 10), word('PLAYER', 72, 10),
        word('RW', 100, 100), word('TOM.LE.GEEK.2', 420, 100),
        word('76561197976022895', 100, 122, 150),
        word('76561199194234434', 420, 122, 150),
        word('76561198148020077', 740, 122, 150),
        word('CLIPPED', 100, 205), word('7656119796121162', 100, 227, 145)
    ]);

    Assert.equal(result.complete, true, result.errors.join(' '));
    Assert.deepEqual(result.entries.map(entry => [entry.steamId, entry.name]), [
        ['76561197976022895', 'RW'],
        ['76561198148020077', null],
        ['76561199194234434', 'TOM.LE.GEEK.2']
    ]);
    Assert.deepEqual(result.rejectedPartialIds, ['7656119796121162']);
    Assert.equal(result.entries.every(entry => entry.caseFidelity === false), true);
});

Test('F7 SteamID OCR repairs at most two common glyph substitutions and validates account range', () => {
    const result = parseF7Words([
        word('FIND PLAYER', 10, 10), word('RW', 100, 100),
        word('76561197976O22895', 100, 122, 150)
    ]);
    Assert.equal(result.complete, true, result.errors.join(' '));
    Assert.equal(result.entries[0].steamId, '76561197976022895');
    Assert.equal(result.entries[0].idOcrCorrected, true);
    Assert.equal(F7IdentityValidation.normalizeSteamIdOcr('7656119OOOOOOOOOO'), null);
    Assert.equal(F7IdentityValidation.isValidSteamId64('76561197900000001'), false);
});

Test('F7 names tolerate OCR case/glyph errors only when the same SteamID profile corroborates them', async () => {
    const items = [{ parsed: {
        kind: 'f7', complete: true, rejectedPartialIds: [], errors: [], entries: [
            { steamId: '76561198052859299', name: 'SUMDUMS1T', ambiguous: false },
            { steamId: '76561197976022895', name: null, ambiguous: false },
            { steamId: '76561199194234434', name: 'WRONG PERSON', ambiguous: false }
        ]
    } }];
    const profiles = new Map([
        ['76561198052859299', 'Sumdumsit'],
        ['76561197976022895', 'Rw'],
        ['76561199194234434', 'tom.le.geek.2']
    ]);
    const [verified] = await F7IdentityValidation.verify(items, [], async id => profiles.get(id));
    Assert.deepEqual(verified.parsed.entries.map(entry => [entry.steamId, entry.name]), [
        ['76561198052859299', 'Sumdumsit'],
        ['76561197976022895', 'Rw']
    ]);
    Assert.equal(verified.parsed.entries[0].verificationScore >= 0.72, true);
    Assert.equal(verified.parsed.rejectedIdentityRows.length, 1);
    Assert.match(verified.parsed.errors.at(-1), /does not match Steam/);
});

Test('F7 OCR parser never chooses between conflicting names for one SteamID', () => {
    const steamId = '76561197976022895';
    const result = parseF7Words([
        word('FIND PLAYER', 10, 10),
        word('RW', 100, 100), word(steamId, 100, 122, 150),
        word('SOMEONE ELSE', 100, 300), word(steamId, 100, 322, 150)
    ]);
    Assert.equal(result.complete, false);
    Assert.equal(result.entries.length, 1);
    Assert.equal(result.entries[0].name, null);
    Assert.equal(result.entries[0].ambiguous, true);
    Assert.deepEqual(result.entries[0].alternatives, ['RW', 'SOMEONE ELSE']);
});

Test('import type detection uses OCR semantics and rejects mixed images', () => {
    const f7 = [word('FIND PLAYER', 10, 10), word('RW', 10, 40),
        word('76561197976022895', 10, 62, 150)];
    Assert.equal(detectImportKind(f7), 'f7');
    Assert.throws(() => detectImportKind([
        ...f7,
        word('ClanTag: zeub', 10, 100), word('Clan Members: Psype', 10, 122),
        word('Established: 09/29/2026 14:58:27', 10, 144)
    ]), /both cinfo and F7/);
});

Test('Discord image boundary validates origin, signature, size and decoded dimensions', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const attachment = {
        url: 'https://cdn.discordapp.com/attachments/1/2/f7.png?signature=test',
        contentType: 'image/png',
        size: png.length + 17
    };
    const fakeResponse = {
        ok: true,
        status: 200,
        headers: { get: name => name === 'content-length' ? `${png.length}` : null },
        body: null,
        arrayBuffer: async () => png
    };
    const result = await ImageAttachment.downloadImage(attachment, {
        fetchImpl: async () => fakeResponse,
        JimpImpl: { read: async () => ({ bitmap: { width: 1260, height: 820 } }) }
    });
    Assert.equal(result.mime, 'image/png');
    Assert.equal(result.width, 1260);
    Assert.equal(result.imageBase64, png.toString('base64'));
    Assert.equal(Object.isFrozen(result), true);
    Assert.equal(ImageAttachment.validateMetadata({ ...attachment, contentType: null }).contentType, 'image/png');

    const discordMismatch = ImageAttachment.validateMetadata({ ...attachment, contentType: 'image/webp' });
    Assert.deepEqual(discordMismatch.acceptedContentTypes, ['image/png', 'image/webp']);
    Assert.equal(Object.isFrozen(discordMismatch.acceptedContentTypes), true);
    Assert.equal((await ImageAttachment.downloadImage({ ...attachment, contentType: 'image/webp' }, {
        fetchImpl: async () => fakeResponse,
        JimpImpl: { read: async () => ({ bitmap: { width: 1260, height: 820 } }) }
    })).mime, 'image/png');

    Assert.throws(() => ImageAttachment.validateMetadata({
        ...attachment, url: 'https://example.invalid/f7.png'
    }), /Discord CDN/);
    Assert.throws(() => ImageAttachment.validateMetadata({
        ...attachment, size: ImageAttachment.MAX_BYTES + 1
    }), /Image size/);
    await Assert.rejects(() => ImageAttachment.downloadImage({ ...attachment, size: 1 }, {
        maxBytes: png.length - 1,
        fetchImpl: async () => fakeResponse,
        JimpImpl: { read: async () => ({ bitmap: { width: 1, height: 1 } }) }
    }), /size limit/);
    await Assert.rejects(() => ImageAttachment.downloadImage(attachment, {
        fetchImpl: async () => ({ ...fakeResponse, arrayBuffer: async () => Buffer.from('not png') }),
        JimpImpl: { read: async () => ({ bitmap: { width: 1, height: 1 } }) }
    }), /length does not match|signature/);
});

Test('Discord image boundary accepts a structurally valid bounded WebP', async () => {
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.writeUInt32LE(22, 4);
    webp.write('WEBP', 8, 'ascii');
    webp.write('VP8X', 12, 'ascii');
    webp.writeUIntLE(1279, 24, 3);
    webp.writeUIntLE(719, 27, 3);
    const attachment = {
        url: 'https://cdn.discordapp.com/attachments/1/2/cinfo.png',
        contentType: 'image/webp',
        size: webp.length
    };
    const result = await ImageAttachment.downloadImage(attachment, {
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => `${webp.length}` },
            body: null,
            arrayBuffer: async () => webp
        }),
        JimpImpl: { read: async () => { throw new Error('WebP must use bounded header parsing.'); } }
    });
    Assert.equal(result.mime, 'image/webp');
    Assert.equal(result.width, 1280);
    Assert.equal(result.height, 720);
});

Test('Tesseract TSV parser returns only validated word boxes', () => {
    const tsv = [
        'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
        '5\t1\t1\t1\t1\t1\t42\t70\t130\t18\t94.5\t76561197976022895',
        '4\t1\t1\t1\t1\t0\t0\t0\t0\t0\t-1\t',
        '5\t1\t1\t1\t2\t1\t42\t90\t50\t18\t-1\tignored'
    ].join('\n');
    Assert.deepEqual(TesseractOcr.parseTsv(tsv), [Object.freeze({
        text: '76561197976022895', x: 42, y: 70, width: 130, height: 18, confidence: 94.5
    })]);
});

Test('cinfo roles use text-relative boxes and relative colors, never fixed screen coordinates', () => {
    const box = [{ x: 300, y: 200, width: 8, height: 8 }];
    const image = { bitmap: { width: 1000, height: 800 }, getPixelColor: () => 1 };
    Assert.equal(CinfoRoles.colorVotes(image, box, {
        intToRGBA: () => ({ r: 235, g: 200, b: 55, a: 255 })
    }), 'leader');
    Assert.equal(CinfoRoles.colorVotes(image, box, {
        intToRGBA: () => ({ r: 30, g: 145, b: 230, a: 255 })
    }), 'moderator');
    Assert.equal(CinfoRoles.colorVotes(image, box, {
        intToRGBA: () => ({ r: 226, g: 211, b: 180, a: 255 })
    }), 'member');
});

Test('pale beige cinfo text and its brown anti-aliasing never become a leader vote', () => {
    const colors = Object.freeze([
        Object.freeze({ r: 226, g: 211, b: 180, a: 255 }),
        Object.freeze({ r: 190, g: 166, b: 130, a: 255 }),
        Object.freeze({ r: 125, g: 72, b: 52, a: 255 }),
        Object.freeze({ r: 65, g: 43, b: 36, a: 255 })
    ]);
    const image = {
        bitmap: { width: 20, height: 20 },
        getPixelColor: (x, y) => (x + y) % colors.length
    };
    Assert.equal(CinfoRoles.colorVotes(image, [{ x: 2, y: 2, width: 12, height: 8 }], {
        intToRGBA: index => colors[index]
    }), 'member');
});

Test('cinfo role colors are separated by hue and saturation', () => {
    Assert.equal(CinfoRoles.roleColor({ r: 226, g: 211, b: 180, a: 255 }), 'member');
    Assert.equal(CinfoRoles.roleColor({ r: 235, g: 200, b: 55, a: 255 }), 'leader');
    Assert.equal(CinfoRoles.roleColor({ r: 30, g: 145, b: 230, a: 255 }), 'moderator');
    Assert.equal(CinfoRoles.roleColor({ r: 125, g: 72, b: 52, a: 255 }), null);
});

Test('cinfo role classification stays unknown when only the world background is visible', () => {
    const image = { bitmap: { width: 20, height: 20 }, getPixelColor: () => 1 };
    Assert.equal(CinfoRoles.colorVotes(image, [{ x: 2, y: 2, width: 12, height: 8 }], {
        intToRGBA: () => ({ r: 125, g: 72, b: 52, a: 255 })
    }), 'unknown');
});

Test('cinfo member boxes stay ordered and never shift Marley glyphs onto Swizzy', () => {
    const words = [
        { text: 'Rw,', x: 10, y: 10, width: 20, height: 10, confidence: 95 },
        { text: 'Elliott,', x: 35, y: 10, width: 35, height: 10, confidence: 95 },
        { text: 'Marley', x: 75, y: 10, width: 40, height: 10, confidence: 95 },
        { text: 'J,', x: 120, y: 10, width: 8, height: 10, confidence: 95 },
        { text: 'Swizzy,', x: 135, y: 10, width: 40, height: 10, confidence: 95 }
    ];
    const assignments = CinfoRoles.findMemberBoxAssignments(words,
        ['Rw', 'Elliott', 'Marley J', 'Swizzy']);
    Assert.equal(assignments.length, 4);
    Assert.deepEqual(assignments[2].map(word => word.text), ['Marley', 'J,']);
    Assert.deepEqual(assignments[3].map(word => word.text), ['Swizzy,']);
    Assert.equal(assignments[2].at(-1).x < assignments[3][0].x, true);
});

Test('cinfo member box partition fails closed on ambiguous repeated names', () => {
    const words = [
        { text: 'Joe,', x: 10, y: 10, width: 20, height: 10, confidence: 95 },
        { text: 'Joe', x: 40, y: 10, width: 20, height: 10, confidence: 95 }
    ];
    Assert.deepEqual(CinfoRoles.findMemberBoxAssignments(words, ['Joe']), []);
});
