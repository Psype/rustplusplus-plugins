const Assert = require('node:assert/strict');
const Test = require('node:test');

const F7Rows = require('../src/plugins/playerIntelligence/f7RowRefinement.js');

class FakeJimp {
    constructor(width, height, _color, callback) {
        this.bitmap = { width, height };
        if (callback) callback(null, this);
    }

    static async read() {
        return new FakeJimp(500, 300, 0xffffffff);
    }

    static intToRGBA() {
        return { r: 130, g: 130, b: 130, a: 255 };
    }

    getPixelColor() {
        return 0x828282ff;
    }

    setPixelColor() {}

    resize(width, height) {
        this.bitmap = { width, height };
        return this;
    }

    async getBufferAsync() {
        return Buffer.from('f7-id-sheet');
    }
}

FakeJimp.MIME_PNG = 'image/png';
FakeJimp.RESIZE_NEAREST_NEIGHBOR = 'nearest';

function word(text, y, confidence = 95) {
    return { text, x: 12, y, width: 180, height: 12, confidence };
}

Test('isolated F7 SteamID rows replace a bad full read and recover a partial row in one OCR call', async () => {
    const calls = [];
    const block = {
        words: [],
        parsed: {
            kind: 'f7', complete: true, rawText: '', errors: ['1 partial SteamID candidate(s) rejected.'],
            rejectedPartialIds: ['7656119884369244'],
            entries: [{
                steamId: '76561198675390964', name: 'KASANE TETO', ambiguous: false,
                alternatives: [], idOcrCorrected: false, idOcrConfidence: 91, idOcrPasses: 1,
                idBox: { x: 100, y: 20, width: 130, height: 10 }, nameBox: null
            }],
            refinementRows: [{
                partialIndex: 0, partialText: '7656119884369244', name: '零^X^LAZY2ERO',
                ambiguous: false, alternatives: [], idOcrConfidence: 70,
                idBox: { x: 100, y: 60, width: 125, height: 10 }, nameBox: null
            }]
        }
    };
    const refined = await F7Rows.refineF7Rows('c291cmNl', block, async (_image, options) => {
        calls.push(options);
        return [word('76561198875390964', 10, 96), word('76561198843692446', 102, 94)];
    }, { timeoutMs: 5000, userWords: ['ignored'] }, { JimpImpl: FakeJimp });

    Assert.equal(calls.length, 1);
    Assert.equal(calls[0].characterWhitelist, '0123456789');
    Assert.deepEqual(refined.parsed.entries.map(entry => [entry.steamId, entry.name]), [
        ['76561198875390964', 'KASANE TETO'],
        ['76561198843692446', '零^X^LAZY2ERO']
    ]);
    Assert.equal(refined.parsed.entries[0].idOcrPasses, 1);
    Assert.equal(refined.parsed.entries.every(entry => entry.idRowRefined), true);
    Assert.deepEqual(refined.parsed.rejectedPartialIds, []);
    Assert.equal(refined.parsed.idRowsRefined, 2);
});

Test('isolated F7 row mapping is positional and rejects invalid or shifted numeric reads', () => {
    const result = F7Rows.readSheetIds([
        word('76561198875390964', 10),
        word('1234', 102),
        word('76561198843692446', 400)
    ], { scale: 4, rowHeight: 23 }, 2);

    Assert.equal(result[0].steamId, '76561198875390964');
    Assert.equal(result[1], null);
});
