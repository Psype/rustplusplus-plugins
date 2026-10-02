const Assert = require('node:assert/strict');
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Jimp = require('jimp');

const Core = require('../src/plugins/playerIntelligence');
const CinfoPanelRefinement = require('../src/plugins/playerIntelligence/cinfoPanelRefinement.js');
const ImportWorkflow = require('../src/plugins/playerIntelligence/importWorkflow.js');
const OcrCorrectionMemory = require('../src/plugins/playerIntelligence/ocrCorrectionMemory.js');
const { parseCinfoWords } = require('../src/plugins/playerIntelligence/parseCinfo.js');
const VisualAliasLibrary = require('../src/plugins/playerIntelligence/visualAliasLibrary.js');

function word(text, y) {
    return { text, x: 20, y, width: Math.max(10, text.length * 7), height: 16, confidence: 95 };
}

function createHarness(t) {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-player-intelligence-import-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const edits = [];
    const updates = [];
    const replies = [];
    const instance = {
        activeServer: 'server', role: null, blacklist: { discordIds: [] },
        channelId: { commands: 'commands', intelImports: 'intel-imports' },
        serverList: { server: { battlemetricsId: '42' } }
    };
    const rustplus = {
        serverId: 'server', info: { wipeTime: 1790690400 },
        generalSettings: {}, log: () => {}
    };
    const words = [
        word('ClanTag: zeub', 20), word('Members: 3', 45),
        word('Clan Members: Nirks, Psype and tom.le.geek.2', 70),
        word('Established: 09/29/2026 14:58:27', 95)
    ];
    const client = {
        rustplusInstances: { guild: rustplus },
        getInstance: () => instance,
        validatePermissions: async () => true,
        interactionEditReply: async (_interaction, payload) => edits.push(payload),
        interactionUpdate: async (_interaction, payload) => updates.push(payload),
        interactionReply: async (_interaction, payload) => updates.push(payload),
        playerIntelligenceDependencies: {
            dataDirectory: directory,
            now: () => new Date('2026-10-01T12:00:00.000Z')
        },
        playerIntelligenceImportDependencies: {
            downloadImage: async () => ({ imageBase64: 'AA==', sha256: 'a'.repeat(64) }),
            recognize: async () => words,
            identityCandidates: async () => [
                { name: 'Nirks', steamId: '76561197900000001', battlemetricsPlayerId: null },
                { name: 'Psype', steamId: '76561197975819827', battlemetricsPlayerId: '101' },
                { name: 'tom.le.geek.2', steamId: '76561197900000002', battlemetricsPlayerId: null }
            ],
            enableExternalCorroboration: false,
            allowedWebhookIds: ['12345678901234567'],
            warBanditsProvider: { resolvePlayer: async () => ({ available: false }) }
        },
        log: () => {}
    };
    const command = {
        guildId: 'guild', channelId: 'commands', id: 'interaction-1', user: { id: 'requester' },
        options: {
            getSubcommand: () => 'cinfo',
            getAttachment: () => ({ id: 'image' })
        },
        deferReply: async () => {}
    };
    return { client, command, directory, edits, updates, replies };
}

Test('Discord import decisions remain valid for thirty minutes', () => {
    Assert.equal(ImportWorkflow.TTL_MS, 30 * 60 * 1000);
});

Test('Discord import previews first, binds confirmation to requester, then commits once', async t => {
    const value = createHarness(t);
    await ImportWorkflow.beginImport(value.client, value.command);
    Assert.equal(value.edits.length, 1);
    Assert.match(value.edits[0].content, /OCR \/cinfo — zeub — 3\/3/);
    const customId = value.edits[0].components[0].components[0].data.custom_id;
    Assert.match(customId, /^PIImportConfirm:/);

    const wrongUser = {
        customId, guildId: 'guild', channelId: 'commands', user: { id: 'other' }
    };
    Assert.equal(await ImportWorkflow.handleButton({ client: value.client, interaction: wrongUser }), true);
    Assert.match(value.updates.at(-1).content, /Only the requester/);
    const store = new Core.JsonlHistoryStore({
        directory: Path.join(value.directory, 'guild', '42')
    });
    Assert.equal((await store.readAll()).length, 0);

    const confirmation = {
        customId, guildId: 'guild', channelId: 'commands', user: { id: 'requester' }
    };
    Assert.equal(await ImportWorkflow.handleButton({ client: value.client, interaction: confirmation }), true);
    Assert.match(value.updates.at(-1).content, /Import committed \(1 block, 4 events\)/);
    const events = await store.readAll();
    Assert.equal(events.length, 4);
    Assert.equal(events.filter(event => event.kind === 'clan_snapshot').length, 1);
    Assert.equal(events.find(event => event.kind === 'clan_snapshot').payload.members
        .every(member => member.role === 'unknown'), true);

    Assert.equal(await ImportWorkflow.handleButton({ client: value.client, interaction: confirmation }), true);
    Assert.match(value.updates.at(-1).content, /expired or already handled/);
    Assert.equal((await store.readAll()).length, 4);
});

Test('cinfo ignores an optional capture label and binds only from Established', async t => {
    const value = createHarness(t);
    const command = {
        ...value.command,
        options: {
            getSubcommand: () => 'cinfo',
            getAttachment: () => ({ id: 'image' }),
            getString: name => name === 'captured_at' ? '2026-09-29 21:15' : null
        }
    };
    await ImportWorkflow.beginImport(value.client, command);
    Assert.match(value.edits[0].content,
        /Wipe inferred from Established: 2026-09-29T14:00:00\.000Z \| capture time not used/);
    const customId = value.edits[0].components[0].components[0].data.custom_id;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { customId, guildId: 'guild', channelId: 'commands', user: { id: 'requester' } }
    }), true);
    const store = new Core.JsonlHistoryStore({ directory: Path.join(value.directory, 'guild', '42') });
    const events = await store.readAll();
    Assert.equal(events.length, 4);
    Assert.equal(events.every(event => event.observedAt === '2026-09-29T14:58:27.000Z'), true);
    Assert.equal(events.every(event => event.scope.wipeId === 'wipe:2026-09-29T14:00:00.000Z'), true);
});

Test('a capture label earlier than Established cannot override Established inference', async t => {
    const value = createHarness(t);
    await ImportWorkflow.beginImport(value.client, {
        ...value.command,
        options: {
            getSubcommand: () => 'cinfo',
            getAttachment: () => ({ id: 'image' }),
            getString: () => '2026-09-29 14:30'
        }
    });
    Assert.match(value.edits[0].content,
        /Wipe inferred from Established: 2026-09-29T14:00:00\.000Z \| capture time not used/);
    const store = new Core.JsonlHistoryStore({ directory: Path.join(value.directory, 'guild', '42') });
    Assert.equal((await store.readAll()).length, 0);
});

Test('each cinfo block independently derives its wipe from its own Established value', async t => {
    const value = createHarness(t);
    value.client.playerIntelligenceImportDependencies.recognize = async () => [
        word('ClanTag: 667', 20), word('Members: 1', 45),
        word('Clan Members: Nirks', 70), word('Established: 09/04/2026 13:58:58', 95),
        word('ClanTag: 69', 160), word('Members: 1', 185),
        word('Clan Members: Psype', 210), word('Established: 09/06/2026 17:50:16', 235)
    ];
    await ImportWorkflow.beginImport(value.client, value.command);
    Assert.match(value.edits[0].content,
        /Wipes inferred independently from Established: 667=2026-09-01T14:00:00\.000Z; 69=2026-09-04T14:00:00\.000Z/);
    const customId = value.edits[0].components[0].components[0].data.custom_id;
    await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { customId, guildId: 'guild', channelId: 'commands', user: { id: 'requester' } }
    });
    const events = await new Core.JsonlHistoryStore({ directory: Path.join(value.directory, 'guild', '42') })
        .readAll();
    const snapshots = events.filter(event => event.kind === 'clan_snapshot')
        .sort((left, right) => left.payload.tag.localeCompare(right.payload.tag));
    Assert.deepEqual(snapshots.map(event => [event.payload.tag, event.scope.wipeId, event.observedAt]), [
        ['667', 'wipe:2026-09-01T14:00:00.000Z', '2026-09-04T13:58:58.000Z'],
        ['69', 'wipe:2026-09-04T14:00:00.000Z', '2026-09-06T17:50:16.000Z']
    ]);
});

Test('OCR compares one text-mask pass with raw semantics and feeds persistent aliases as user words', async t => {
    const value = createHarness(t);
    const calls = [];
    value.client.playerIntelligenceImportDependencies.preprocessImage = async () => ({
        imageBase64: 'masked', scale: 2
    });
    value.client.playerIntelligenceImportDependencies.downloadImage = async () => ({
        imageBase64: 'raw', sha256: 'd'.repeat(64)
    });
    value.client.playerIntelligenceImportDependencies.recognize = async (image, options) => {
        calls.push({ image, options });
        return image === 'masked' ? [
            word('ClanTag: zeub', 40), word('Members: 3', 90),
            word('Clan Members: Nirks, Psype and tom.le.geek.2', 140),
            word('Established: 09/29/2026 14:58:27', 190)
        ] : [
            word('ClanTag: wrong', 20), word('Members: 3', 45),
            word('Clan Members: noise', 70), word('Established: 09/29/2026 14:58:27', 95)
        ];
    };
    await ImportWorkflow.beginImport(value.client, value.command);
    Assert.match(value.edits[0].content, /OCR \/cinfo.+zeub.+3\/3/);
    Assert.deepEqual(calls.map(call => call.image), ['masked', 'raw']);
    Assert.equal(calls.every(call => call.options.userWords.includes('Nirks') &&
        call.options.userWords.includes('tom.le.geek.2')), true);
});

Test('F7 always adds one dedicated muted-neutral pass and reports cross-pass ID agreement', async t => {
    const value = createHarness(t);
    const calls = [];
    value.client.playerIntelligenceImportDependencies.downloadImage = async () => ({
        imageBase64: 'raw-f7', sha256: 'e'.repeat(64)
    });
    value.client.playerIntelligenceImportDependencies.preprocessImage = async () => ({
        imageBase64: 'normal-mask', scale: 2
    });
    value.client.playerIntelligenceImportDependencies.preprocessF7Image = async () => ({
        imageBase64: 'muted-mask', scale: 2
    });
    value.client.playerIntelligenceImportDependencies.extractVisualSamples = async () => [[]];
    value.client.playerIntelligenceImportDependencies.identityCandidates = async () => [];
    value.client.playerIntelligenceImportDependencies.steamProfileName = async () => 'Rw';
    value.client.playerIntelligenceImportDependencies.recognize = async image => {
        calls.push(image);
        return image === 'muted-mask' ? [
            { ...word('FIND PLAYER', 20), x: 20 },
            { ...word('RW', 200), x: 100 },
            { ...word('76561197976022895', 244), x: 100, width: 300 }
        ] : [{ ...word('FIND PLAYER', 20), x: 20 }];
    };
    await ImportWorkflow.beginImport(value.client, {
        ...value.command,
        options: { getSubcommand: () => 'f7', getAttachment: () => ({ id: 'f7' }) }
    });
    Assert.deepEqual(calls, ['normal-mask', 'raw-f7', 'muted-mask']);
    Assert.match(value.edits[0].content, /OCR F7 — 1 pair \(1 verified, 0 OCR-consensus/);
    Assert.match(value.edits[0].content, /76561197976022895 — Rw/);
});

Test('F7 retains a Steam-unavailable pair only when two independent exact-ID passes agree', async t => {
    const value = createHarness(t);
    const steamId = '76561198843692446';
    value.client.playerIntelligenceImportDependencies.downloadImage = async () => ({
        imageBase64: 'raw-f7-consensus', sha256: '1'.repeat(64)
    });
    value.client.playerIntelligenceImportDependencies.preprocessImage = async () => ({
        imageBase64: 'normal-f7-consensus', scale: 1
    });
    value.client.playerIntelligenceImportDependencies.preprocessF7Image = async () => ({
        imageBase64: 'muted-f7-consensus', scale: 1
    });
    value.client.playerIntelligenceImportDependencies.extractVisualSamples = async () => [[]];
    value.client.playerIntelligenceImportDependencies.identityCandidates = async () => [];
    value.client.playerIntelligenceImportDependencies.steamProfileName = async () => null;
    value.client.playerIntelligenceImportDependencies.recognize = async image => image === 'raw-f7-consensus' ?
        [{ ...word('FIND PLAYER', 20), x: 20 }] : [
            { ...word('FIND PLAYER', 20), x: 20 },
            { ...word('零^X^LAZY2ERO', 200), x: 100 },
            { ...word(steamId, 244), x: 100, width: 300, confidence: 88 }
        ];

    await ImportWorkflow.beginImport(value.client, {
        ...value.command,
        options: { getSubcommand: () => 'f7', getAttachment: () => ({ id: 'f7-consensus' }) }
    });

    Assert.match(value.edits[0].content, /1 pair \(0 verified, 1 OCR-consensus/);
    Assert.match(value.edits[0].content, /76561198843692446 — 零\^X\^LAZY2ERO \[OCR-consensus\]/);
});

Test('cinfo selection takes the safest panel independently from each OCR variant', () => {
    const block = (tag, members, establishedAtUtc, marker) => Object.freeze({
        words: Object.freeze([{ text: marker }]),
        parsed: Object.freeze({
            tag,
            declaredCount: 3,
            members: Object.freeze(Array.from({ length: members }, (_, index) => ({ name: `${marker}${index}` }))),
            complete: members === 3,
            establishedAtUtc,
            errors: Object.freeze(establishedAtUtc ? [] : ['Established timestamp is invalid.'])
        })
    });
    const selected = ImportWorkflow.selectRecognizedResult([
        { label: 'text-mask', quality: 1, result: { kind: 'cinfo', blocks: [
            block('A', 3, null, 'mask-a'), block('B', 3, '2026-10-01T12:00:00.000Z', 'mask-b')
        ] } },
        { label: 'raw', quality: 2, result: { kind: 'cinfo', blocks: [
            block('A', 3, '2026-10-01T12:00:00.000Z', 'raw-a'), block('B', 1, null, 'raw-b')
        ] } }
    ]);
    Assert.equal(selected.blocks[0].words[0].text, 'raw-a');
    Assert.equal(selected.blocks[1].words[0].text, 'mask-b');
    Assert.equal(Object.isFrozen(selected.blocks), true);
});

Test('incomplete cinfo panels receive one bounded semantic crop OCR pass', async () => {
    const image = await new Promise((resolve, reject) => new Jimp(480, 180, 0x5d514cff,
        (error, value) => error ? reject(error) : resolve(value)));
    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const originalWords = [
        word('ClanTag: TEST', 20), word('Members: 3', 45),
        word('Clan Members: Alice', 70), word('Established: broken', 95)
    ];
    const original = Object.freeze({ words: originalWords, parsed: parseCinfoWords(originalWords) });
    const calls = [];
    const result = await CinfoPanelRefinement.refineCinfoPanels(buffer.toString('base64'), [original],
        async (_image, options) => {
            calls.push(options);
            return [
                word('ClanTag: TEST', 10), word('Members: 3', 35),
                word('Clan Members: Alice, Bob and Charly', 60),
                word('Established: 09/29/2026 14:58:27', 85)
            ];
        }, { userWords: ['Alice', 'Bob', 'Charly'], timeoutMs: 45000 }, {
            preprocessPanelImage: async () => ({ imageBase64: 'panel-mask', scale: 1 })
        });
    Assert.equal(calls.length, 1);
    Assert.equal(calls[0].psm, 6);
    Assert.equal(calls[0].timeoutMs, 30000);
    Assert.equal(result.blocks[0].parsed.complete, true);
    Assert.equal(result.blocks[0].parsed.establishedAtUtc, '2026-09-29T14:58:27.000Z');
    Assert.deepEqual(result.blocks[0].parsed.members.map(member => member.name), ['Alice', 'Bob', 'Charly']);
    Assert.equal(result.warning, null);
});

Test('an incomplete cinfo roster receives one dedicated roster-field read', async () => {
    const image = await new Promise((resolve, reject) => new Jimp(620, 190, 0x5d514cff,
        (error, value) => error ? reject(error) : resolve(value)));
    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const originalWords = [
        word('ClanTag: GenX', 20), word('Members: 8', 45),
        word('Clan Members: Sumdumsit, Tingtong, GingerMinx,', 70),
        word('GrimReaper, n444. spirit_monger19, Egon and JawJax', 95),
        word('Established: 09/29/2026 14:01:10', 120)
    ];
    const original = Object.freeze({ words: originalWords, parsed: parseCinfoWords(originalWords) });
    const calls = [];
    const result = await CinfoPanelRefinement.refineCinfoPanels(buffer.toString('base64'), [original],
        async (input, options) => {
            calls.push({ input, options });
            if (input === 'roster-mask') return [
                word('Clan Members: Sumdumsit, Tingtong, GingerMinx,', 10),
                word('GrimReaper, n444shj, spirit_monger19, Egon and JawJax', 35)
            ];
            return originalWords;
        }, { timeoutMs: 45000 }, {
            preprocessPanelImage: async () => ({ imageBase64: 'panel-mask', scale: 1 }),
            preprocessRosterImage: async () => ({ imageBase64: 'roster-mask', scale: 1 })
        });
    Assert.deepEqual(calls.map(call => call.input), ['panel-mask', 'roster-mask']);
    Assert.equal(calls.every(call => call.options.psm === 6 && call.options.timeoutMs === 30000), true);
    Assert.equal(result.blocks[0].parsed.complete, true);
    Assert.deepEqual(result.blocks[0].parsed.members.map(member => member.name), [
        'Sumdumsit', 'Tingtong', 'GingerMinx', 'GrimReaper', 'n444shj',
        'spirit_monger19', 'Egon', 'JawJax'
    ]);
});

Test('invalid cinfo dates receive a constrained numeric field read', async () => {
    const image = await new Promise((resolve, reject) => new Jimp(480, 180, 0x5d514cff,
        (error, value) => error ? reject(error) : resolve(value)));
    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const originalWords = [
        word('ClanTag: TEST', 20), word('Members: 1', 45),
        word('Clan Members: Alice', 70), word('Established: 09/29/2 b2 6 14:58:27 t', 95)
    ];
    const original = Object.freeze({ words: originalWords, parsed: parseCinfoWords(originalWords) });
    const calls = [];
    const result = await CinfoPanelRefinement.refineCinfoPanels(buffer.toString('base64'), [original],
        async (_image, options) => {
            calls.push(options);
            return options.psm === 7 ? [word('09/29/2026 14:58:27', 5)] : originalWords;
        }, { timeoutMs: 45000 }, {
            preprocessPanelImage: async () => ({ imageBase64: 'panel-mask', scale: 1 }),
            preprocessDateImage: async () => ({ imageBase64: 'date-mask', scale: 1 })
        });
    Assert.deepEqual(calls.map(call => call.psm), [6, 7]);
    Assert.equal(calls[1].characterWhitelist, '0123456789/: ');
    Assert.deepEqual(calls[1].userWords, []);
    Assert.equal(result.blocks[0].parsed.establishedRaw, '09/29/2026 14:58:27');
    Assert.equal(result.blocks[0].parsed.establishedAtUtc, '2026-09-29T14:58:27.000Z');
    Assert.equal(result.warning, null);
});

Test('missing cinfo anchors recover tag, count and date from isolated neighboring rows', async () => {
    const image = await new Promise((resolve, reject) => new Jimp(620, 170, 0x5d514cff,
        (error, value) => error ? reject(error) : resolve(value)));
    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const originalWords = [
        word('ClanTag: Mernbe genx', 15),
        word('Clan Members: n444shj, Jameskdw1704, spirit_monger19,', 65),
        word('Tingtong, Sumdumsit and GingerMinx', 90),
        word('Establ shed: 10/01/2026 19:33:49', 115)
    ];
    const original = Object.freeze({ words: originalWords, parsed: parseCinfoWords(originalWords) });
    const calls = [];
    const result = await CinfoPanelRefinement.refineCinfoPanels(buffer.toString('base64'), [original],
        async (input, options) => {
            calls.push({ input, options });
            if (input === 'tag-mask') return [word('genx', 5)];
            if (input === 'count-mask') return [word('6', 5)];
            if (input === 'date-mask') return [word('10/01/2026 19:33:49', 5)];
            throw new Error(`Unexpected OCR input ${input}`);
        }, { timeoutMs: 45000 }, {
            preprocessTagImage: async () => ({ imageBase64: 'tag-mask', scale: 1 }),
            preprocessCountImage: async () => ({ imageBase64: 'count-mask', scale: 1 }),
            preprocessDateImage: async () => ({ imageBase64: 'date-mask', scale: 1 })
        });
    Assert.deepEqual(calls.map(call => call.input), ['tag-mask', 'count-mask', 'date-mask']);
    Assert.equal(calls.every(call => call.options.psm === 7 && call.options.timeoutMs === 20000), true);
    Assert.equal(calls[1].options.characterWhitelist, '0123456789');
    Assert.equal(calls[2].options.characterWhitelist, '0123456789/: ');
    Assert.equal(result.blocks[0].parsed.tag, 'genx');
    Assert.equal(result.blocks[0].parsed.declaredCount, 6);
    Assert.equal(result.blocks[0].parsed.establishedRaw, '10/01/2026 19:33:49');
    Assert.deepEqual(result.blocks[0].parsed.members.map(member => member.name), [
        'n444shj', 'Jameskdw1704', 'spirit_monger19', 'Tingtong', 'Sumdumsit', 'GingerMinx'
    ]);
    Assert.equal(result.blocks[0].parsed.complete, true);
    Assert.equal(result.warning, null);
});

Test('cinfo preview keeps every OCR name visible when the declared count is unread', () => {
    const preview = ImportWorkflow.previewText({
        kind: 'cinfo', tag: 'genx', declaredCount: null, establishedRaw: '',
        members: ['n444shj', 'Jameskdw1704', 'spirit_monger19', 'Tingtong', 'Sumdumsit', 'GingerMinx']
            .map(name => ({ name, role: 'member' })),
        resolvedMembers: ['n444shj', 'Jameskdw1704', 'spirit_monger19']
            .map((name, memberIndex) => ({ name, role: 'member', memberIndex })),
        unresolvedMembers: [], missingMemberCount: 0,
        errors: ['Members count not found.']
    });
    Assert.match(preview, /OCR roster: n444shj, Jameskdw1704, spirit_monger19, Tingtong, Sumdumsit, GingerMinx/);
    Assert.match(preview, /Linked identities: n444shj, Jameskdw1704, spirit_monger19/);
    Assert.match(preview, /Pending identities: 3/);
});

Test('cinfo roster punctuation is reread in comma-delimited member image rows', async () => {
    const image = await new Promise((resolve, reject) => new Jimp(440, 150, 0x5d514cff,
        (error, value) => error ? reject(error) : resolve(value)));
    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const positioned = (text, x, y, width = Math.max(8, text.length * 7)) =>
        ({ text, x, y, width, height: 16, confidence: 95 });
    const words = [
        positioned('ClanTag:', 10, 20, 55), positioned('FBM', 70, 20, 28),
        positioned('Members:', 10, 40, 55), positioned('6', 70, 40, 8),
        positioned('Clan', 10, 60, 30), positioned('Members:', 45, 60, 60),
        positioned('Rw,', 115, 60, 25), positioned('Elliott,', 150, 60, 50),
        positioned('』', 205, 60, 10), positioned('Marley', 220, 60, 45),
        positioned('』', 270, 60, 10), positioned(',', 285, 60, 8),
        positioned('Swizzy,', 300, 60, 48), positioned('Jeffrey', 355, 60, 48),
        positioned('Kirkstein', 10, 80, 55), positioned('The', 70, 80, 25),
        positioned('3rd', 100, 80, 25), positioned('and', 130, 80, 28),
        positioned('U', 165, 80, 10), positioned('Got', 180, 80, 24),
        positioned('Kirkified', 210, 80, 58),
        positioned('Established:', 10, 100, 80), positioned('09/29/2026', 95, 100, 80),
        positioned('14:00:08', 180, 100, 58)
    ];
    const originalNames = ['Rw', 'Elliott', '1 Marley 4', 'Swizzy',
        'Jeffrey Kirkstein The 3rd', 'U Got Kirkified'];
    const original = Object.freeze({
        words: Object.freeze(words),
        parsed: Object.freeze({
            kind: 'cinfo', tag: 'FBM', declaredCount: 6, complete: true,
            establishedAtUtc: '2026-09-29T14:00:08.000Z', errors: Object.freeze([]),
            members: Object.freeze(originalNames.map(name => Object.freeze({ name, role: 'member' })))
        })
    });
    const isolatedNames = ['Rw', 'Elliott', '1 Marley 4', 'Swizzy',
        'Jeffrey Kirkstein The 3rd', 'U Got Kirkified'];
    const refinedNames = ['Rw', 'Elliott', '』 Marley 』', 'Swizzy',
        'Jeffrey Kirkstein The 3rd', 'U Got Kirkified'];
    let calls = 0;
    const result = await CinfoPanelRefinement.refineCinfoPanels(buffer.toString('base64'), [original],
        async (_image, options) => {
            calls += 1;
            Assert.equal(options.psm, 6);
            return isolatedNames.map((text, index) => positioned(text, 10, index * 128 + 32));
        }, { timeoutMs: 45000, confirmedUserWords: ['』 Marley 』'] });
    Assert.equal(calls, 1);
    Assert.deepEqual(result.blocks[0].parsed.members.map(member => member.name), refinedNames);
    Assert.equal(result.blocks[0].memberBoxes.length, 6);
    Assert.equal(result.blocks[0].memberBoxes[2]
        .some(box => box.x <= 205 && box.x + box.width >= 280), true);
    Assert.equal(result.blocks[0].memberBoxes[3].every(box => box.x >= 289), true);
    Assert.equal(result.warning, null);
});

Test('isolated cinfo roster read cannot alter or exchange member letters', async () => {
    const image = await new Promise((resolve, reject) => new Jimp(240, 100, 0x5d514cff,
        (error, value) => error ? reject(error) : resolve(value)));
    const positioned = (text, x, y) => ({ text, x, y, width: Math.max(8, text.length * 7),
        height: 16, confidence: 95 });
    const words = [
        positioned('ClanTag:', 10, 10), positioned('FBM', 90, 10),
        positioned('Members:', 10, 30), positioned('2', 90, 30),
        positioned('Clan', 10, 50), positioned('Members:', 45, 50),
        positioned('Marley,', 115, 50), positioned('Swizzy', 175, 50),
        positioned('Established:', 10, 70), positioned('09/29/2026', 100, 70)
    ];
    const original = Object.freeze({ words: Object.freeze(words), parsed: Object.freeze({
        kind: 'cinfo', tag: 'FBM', declaredCount: 2, complete: true,
        establishedAtUtc: '2026-09-29T14:00:08.000Z', errors: Object.freeze([]),
        members: Object.freeze(['Marley', 'Swizzy'].map(name => Object.freeze({ name, role: 'member' })))
    }) });
    const result = await CinfoPanelRefinement.refineRosterMembers(image, original,
        async () => [positioned('Swizzy', 10, 10), positioned('Marley', 10, 90)],
        { timeoutMs: 30000 }, {}, Jimp);
    Assert.equal(result, original);
});

Test('isolated cinfo roster sheet rejects oversized derived geometry before allocation', async () => {
    await Assert.rejects(() => CinfoPanelRefinement.createIsolatedRosterSheet({},
        [[{ x: 0, y: 0, width: 3000, height: 1000 }]], Jimp), /pixel limit/);
});

Test('confirmed resolved shapes persist in the server data directory, not in source code', async t => {
    const value = createHarness(t);
    value.client.playerIntelligenceImportDependencies.disableOcrPreprocessing = true;
    const bits = Buffer.alloc(VisualAliasLibrary.FEATURE_WIDTH * VisualAliasLibrary.FEATURE_HEIGHT / 8, 0x55);
    const aspectRatio = 2;
    const feature = Object.freeze({
        width: VisualAliasLibrary.FEATURE_WIDTH,
        height: VisualAliasLibrary.FEATURE_HEIGHT,
        bits: bits.toString('base64'),
        aspectRatio,
        digest: Crypto.createHash('sha256').update(bits).update(`:${aspectRatio.toFixed(3)}`, 'utf8').digest('hex')
    });
    value.client.playerIntelligenceImportDependencies.extractCinfoVisualSamples = async () => [[{
        memberIndex: 0, observedText: 'Nirks', boundaryProof: true, feature
    }]];
    await ImportWorkflow.beginImport(value.client, value.command);
    const customId = value.edits[0].components[0].components[0].data.custom_id;
    await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { customId, guildId: 'guild', channelId: 'commands', user: { id: 'requester' } }
    });
    const libraryFile = Path.join(value.directory, 'guild', '42', 'visual-alias-library.json');
    const document = await VisualAliasLibrary.read(libraryFile);
    Assert.equal(document.samples.length, 1);
    Assert.equal(document.samples[0].name, 'Nirks');
    Assert.equal(document.samples[0].steamId, '76561197900000001');
});

Test('exact F7 visual evidence resolves only its cinfo slot and prefers the known canonical alias', async t => {
    const value = createHarness(t);
    const steamId = '76561197900000021';
    value.client.playerIntelligenceImportDependencies.disableOcrPreprocessing = true;
    value.client.playerIntelligenceImportDependencies.recognize = async () => [
        word('ClanTag: TEST', 20), word('Members: 1', 45),
        word('Clan Members: N01SY OCR', 70), word('Established: 09/29/2026 14:58:27', 95)
    ];
    value.client.playerIntelligenceImportDependencies.identityCandidates = async () => [{
        name: 'Canonical Name', steamId, battlemetricsPlayerId: null, caseFidelity: true
    }];
    value.client.playerIntelligenceImportDependencies.visualCandidatesForItems = async () => [[{
        name: 'CANONICAL NAME', steamId, battlemetricsPlayerId: null, caseFidelity: false,
        corroborated: true, contextPriority: true, targetMemberIndex: 0, visualScore: 1
    }]];
    await ImportWorkflow.beginImport(value.client, value.command);
    Assert.match(value.edits[0].content, /1\/1 linked/);
    Assert.match(value.edits[0].content, /Members: Canonical Name/);
    Assert.doesNotMatch(value.edits[0].content, /Members: N01SY OCR/);
});

Test('incomplete cinfo roster is committed only as a partial snapshot', async t => {
    const value = createHarness(t);
    value.client.playerIntelligenceImportDependencies.recognize = async () => [
        word('ClanTag: BAD', 20), word('Members: 3', 45),
        word('Clan Members: Alice and Bob', 70),
        word('Established: 09/29/2026 14:58:27', 95)
    ];
    await ImportWorkflow.beginImport(value.client, value.command);
    Assert.match(value.edits[0].content, /0\/3 linked/);
    Assert.match(value.edits[0].content, /Pending identities: 3/);
    const customId = value.edits[0].components[0].components[0].data.custom_id;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { customId, guildId: 'guild', channelId: 'commands', user: { id: 'requester' } }
    }), true);
    const store = new Core.JsonlHistoryStore({
        directory: Path.join(value.directory, 'guild', '42')
    });
    const events = await store.readAll();
    Assert.equal(events.length, 1);
    const snapshot = events[0];
    Assert.equal(snapshot.kind, 'clan_snapshot');
    Assert.equal(snapshot.payload.complete, false);
    Assert.equal(snapshot.payload.members.length, 0);
    Assert.equal(snapshot.payload.unresolvedMembers.length, 2);
});

Test('manual cinfo correction validates tag, date and roster before confirmation', async t => {
    Assert.throws(() => ImportWorkflow.parseCorrectedRoster('Alice\nBob', 3), /exactly 3/);
    Assert.throws(() => ImportWorkflow.parseCorrectedRoster('Alice\nAlice', 2), /unique/);
    Assert.throws(() => ImportWorkflow.parseCorrectedCinfo('GenX\nbad date\nAlice', 1), /Established/);
    const value = createHarness(t);
    value.client.playerIntelligenceImportDependencies.recognize = async () => [
        word('ClanTag: GenX', 20), word('Members: 8', 45),
        word('Clan Members: Sumdumsit, Tingtong, GingerMinx,', 70),
        word('GrimReaper, n444. spirit_monger19, Egon and JawJax', 95),
        word('Established: 09/29/2026 14:01:10', 120)
    ];
    await ImportWorkflow.beginImport(value.client, value.command);
    Assert.match(value.edits[0].content, /7\/8 names read/);
    const editId = value.edits[0].components[1].components[0].data.custom_id;
    Assert.match(editId, /^PIImportEdit:/u);
    let modal;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: {
            customId: editId, guildId: 'guild', channelId: 'commands', user: { id: 'requester' },
            showModal: async value => { modal = value; }
        }
    }), true);
    Assert.match(modal.data.custom_id, /^PIImportEditModal:/u);
    Assert.match(modal.toJSON().components[0].components[0].value,
        /^GenX\n09\/29\/2026 14:01:10\nSumdumsit/u);
    let modalDeferred = false;
    value.client.playerIntelligenceImportDependencies.identityCandidates = async () => {
        Assert.equal(modalDeferred, true);
        return [];
    };
    const corrected = [
        'Sumdumsit', 'Tingtong', 'GingerMinx', 'GrimReaper', 'n444shj',
        'spirit_monger19', 'Egon', 'JawJax'
    ];
    Assert.equal(await ImportWorkflow.handleModal({
        client: value.client,
        interaction: {
            customId: modal.data.custom_id,
            guildId: 'guild', channelId: 'commands', user: { id: 'requester' },
            deferUpdate: async () => { modalDeferred = true; },
            fields: { getTextInputValue: () => ['genx', '09/25/2026 14:02:10', ...corrected].join('\n') }
        }
    }), true);
    Assert.equal(modalDeferred, true);
    const correctedPreview = value.edits.at(-1);
    Assert.match(correctedPreview.content, /8\/8 names read/);
    Assert.match(correctedPreview.content, /Corrected \/cinfo.*genx/u);
    Assert.match(correctedPreview.content, /Established: 09\/25\/2026 14:02:10/u);
    Assert.match(correctedPreview.content, /Wipe inferred from Established: 2026-09-25T14:00:00\.000Z/u);
    Assert.match(correctedPreview.content, /Corrected roster:.*n444shj, spirit_monger19/u);
    const libraryFile = Path.join(value.directory, 'guild', '42', 'visual-alias-library.json');
    Assert.deepEqual(await VisualAliasLibrary.confirmedUserWords(libraryFile), []);

    const confirmId = correctedPreview.components[0].components[0].data.custom_id;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { customId: confirmId, guildId: 'guild', channelId: 'commands', user: { id: 'requester' } }
    }), true);
    const learned = await VisualAliasLibrary.confirmedUserWords(libraryFile);
    Assert.equal(learned.includes('n444shj'), true);
    Assert.equal(learned.includes('spirit_monger19'), true);
    const store = new Core.JsonlHistoryStore({ directory: Path.join(value.directory, 'guild', '42') });
    const snapshot = (await store.readAll()).find(event => event.kind === 'clan_snapshot');
    Assert.equal(snapshot.payload.tag, 'genx');
    Assert.equal(snapshot.payload.establishedAt, '2026-09-25T14:02:10.000Z');
    Assert.equal(snapshot.scope.wipeId, 'wipe:2026-09-25T14:00:00.000Z');
    Assert.equal(snapshot.payload.declaredMemberCount, 8);
    Assert.equal(snapshot.payload.unresolvedMembers.some(member => member.observedText === 'n444shj'), true);
    let futureUserWords = [];
    value.client.playerIntelligenceImportDependencies.disableOcrPreprocessing = true;
    value.client.playerIntelligenceImportDependencies.recognize = async (_image, options) => {
        futureUserWords = options.userWords;
        return [
            word('ClanTag: GenX', 20), word('Members: 8', 45),
            word('Clan Members: Sumdumsit, Tingtong, GingerMinx,', 70),
            word('GrimReaper, n444shj, spirit_monger19, Egon and JawJax', 95),
            word('Established: 09/29/2026 14:01:10', 120)
        ];
    };
    await ImportWorkflow.beginImport(value.client, { ...value.command, id: 'interaction-2' });
    Assert.equal(futureUserWords.includes('n444shj'), true);
});

Test('manual cinfo spelling correction preserves the color-derived role at the same roster slot', () => {
    const parsed = {
        kind: 'cinfo', declaredCount: 2, complete: true, errors: [],
        members: [{ name: '1 Marley 4', role: 'moderator' }, { name: 'Swizzy', role: 'member' }]
    };
    const corrected = ImportWorkflow.applyCorrectedRoster(parsed, ['』 Marley 』', 'Swizzy']);
    Assert.deepEqual(corrected.members.map(member => [member.name, member.role]), [
        ['』 Marley 』', 'moderator'], ['Swizzy', 'member']
    ]);
});

Test('only Confirm persists a manual image-to-name correction in the restart-safe sidecar', async t => {
    const value = createHarness(t);
    const bits = Buffer.alloc(VisualAliasLibrary.FEATURE_WIDTH * VisualAliasLibrary.FEATURE_HEIGHT / 8, 0x2a);
    const aspectRatio = 4;
    const feature = Object.freeze({
        width: VisualAliasLibrary.FEATURE_WIDTH,
        height: VisualAliasLibrary.FEATURE_HEIGHT,
        bits: bits.toString('base64'),
        aspectRatio,
        digest: Crypto.createHash('sha256').update(bits)
            .update(`:${aspectRatio.toFixed(3)}`, 'utf8').digest('hex')
    });
    value.client.playerIntelligenceImportDependencies.extractCinfoVisualSamples = async () => [[{
        memberIndex: 0, observedText: 'Nirks', boundaryProof: true, feature
    }]];
    await ImportWorkflow.beginImport(value.client, value.command);
    const editId = value.edits[0].components[1].components[0].data.custom_id;
    let modal;
    await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { customId: editId, guildId: 'guild', channelId: 'commands',
            user: { id: 'requester' }, showModal: async value => { modal = value; } }
    });
    await ImportWorkflow.handleModal({
        client: value.client,
        interaction: {
            customId: modal.data.custom_id, guildId: 'guild', channelId: 'commands',
            user: { id: 'requester' }, deferUpdate: async () => {},
            fields: { getTextInputValue: () =>
                'zeub\n09/29/2026 14:58:27\nNírks\nPsype\ntom.le.geek.2' }
        }
    });
    const file = Path.join(value.directory, 'guild', '42', 'ocr-correction-memory.json');
    Assert.equal((await OcrCorrectionMemory.read(file)).templates.length, 0);
    const confirmId = value.edits.at(-1).components[0].components[0].data.custom_id;
    await ImportWorkflow.handleButton({ client: value.client, interaction: {
        customId: confirmId, guildId: 'guild', channelId: 'commands', user: { id: 'requester' }
    } });
    const templates = (await OcrCorrectionMemory.read(file)).templates;
    Assert.equal(templates.length, 1);
    Assert.equal(templates[0].observedText, 'Nirks');
    Assert.equal(templates[0].correctedText, 'Nírks');
});

Test('cinfo preview separates OCR-read names from linked identities in roster order', () => {
    const preview = ImportWorkflow.previewText({
        kind: 'cinfo', tag: 'xD', declaredCount: 5,
        members: [
            { name: 'd.ve', role: 'member' },
            { name: 'Nova', role: 'member' },
            { name: 'Cockornut Tree', role: 'member' },
            { name: 'Mr Tutel', role: 'member' },
            { name: 'RangerMS', role: 'member' }
        ],
        resolvedMembers: [
            { memberIndex: 2, name: 'Cockornut Tree', role: 'member' },
            { memberIndex: 1, name: 'Nova', role: 'member' }
        ],
        unresolvedMembers: [
            { observedText: 'd.ve' }, { observedText: 'Mr Tutel' }, { observedText: 'RangerMS' }
        ],
        missingMemberCount: 0,
        establishedRaw: '09/30/2026 16:02:50',
        errors: ['Partial roster: 2/5 member identities resolved.']
    });
    Assert.match(preview, /5\/5 names read · 2\/5 linked/);
    Assert.match(preview, /OCR roster: d\.ve, Nova, Cockornut Tree, Mr Tutel, RangerMS/);
    Assert.match(preview, /Linked identities: Nova, Cockornut Tree/);
});

Test('short-name collision resolves only after bounded SteamID corroboration', async t => {
    const value = createHarness(t);
    const firstSteamId = '76561197900000011';
    const secondSteamId = '76561197900000012';
    value.client.playerIntelligenceImportDependencies.recognize = async () => [
        word('ClanTag: TEST', 20), word('Members: 1', 45),
        word('Clan Members: RW', 70), word('Established: 09/29/2026 14:58:27', 95)
    ];
    value.client.playerIntelligenceImportDependencies.identityCandidates = async () => [
        { name: 'RW', steamId: firstSteamId, battlemetricsPlayerId: null, caseFidelity: false },
        { name: 'RW', steamId: secondSteamId, battlemetricsPlayerId: null, caseFidelity: false }
    ];
    value.client.playerIntelligenceImportDependencies.enableExternalCorroboration = true;
    const providerQueries = [];
    value.client.playerIntelligenceImportDependencies.warBanditsProvider = {
        resolvePlayer: async (_context, _scope, query) => {
            providerQueries.push(query);
            if (!/^7656119\d{10}$/u.test(query)) return { available: false };
            const matching = query === firstSteamId;
            return {
                available: true, ambiguous: false,
                player: { steamId: query, name: matching ? 'RW' : 'SOMEONE', aliases: [] }
            };
        }
    };
    const steamQueries = [];
    value.client.playerIntelligenceImportDependencies.steamProfileName = async steamId => {
        steamQueries.push(steamId);
        return steamId === firstSteamId ? 'RW' : 'SOMEONE';
    };

    await ImportWorkflow.beginImport(value.client, value.command);
    Assert.match(value.edits[0].content, /1\/1 linked/);
    Assert.equal(providerQueries.length <= 3, true);
    Assert.equal(providerQueries.includes(firstSteamId), true);
    Assert.equal(providerQueries.includes(secondSteamId), true);
    Assert.deepEqual(steamQueries.sort(), [firstSteamId, secondSteamId]);
    const customId = value.edits[0].components[0].components[0].data.custom_id;
    await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { customId, guildId: 'guild', channelId: 'commands', user: { id: 'requester' } }
    });
    const store = new Core.JsonlHistoryStore({ directory: Path.join(value.directory, 'guild', '42') });
    const snapshot = (await store.readAll()).find(event => event.kind === 'clan_snapshot');
    Assert.equal(snapshot.payload.members[0].steamId, firstSteamId);
});

Test('dedicated import channel accepts only an approved helper webhook and still requires confirmation', async t => {
    const value = createHarness(t);
    value.client.playerIntelligenceDependencies.now = () => new Date('2026-10-02T20:00:00.000Z');
    value.client.rustplusInstances.guild.info.wipeTime = Date.parse('2026-10-02T14:00:00.000Z') / 1000;
    const message = {
        guildId: 'guild', channelId: 'intel-imports', id: 'message-1', content: 'cinfo',
        webhookId: '12345678901234567', author: { id: 'webhook', bot: true },
        attachments: new Map([['image', { id: 'image' }]]),
        reply: async payload => value.replies.push(payload)
    };
    Assert.equal(await ImportWorkflow.handleMessage({ client: value.client, message }), true);
    Assert.equal(value.replies.length, 1);
    Assert.match(value.replies[0].content,
        /Wipe inferred from Established: 2026-09-29T14:00:00\.000Z \| capture time not used/);
    Assert.match(value.replies[0].content, /OCR \/cinfo/);
    const customId = value.replies[0].components[0].components[0].data.custom_id;
    const confirmation = {
        customId, guildId: 'guild', channelId: 'intel-imports', user: { id: 'reviewer' }
    };
    Assert.equal(await ImportWorkflow.handleButton({ client: value.client, interaction: confirmation }), true);
    Assert.match(value.updates.at(-1).content, /Import committed/);
    const store = new Core.JsonlHistoryStore({ directory: Path.join(value.directory, 'guild', '42') });
    const snapshots = (await store.readAll()).filter(event => event.kind === 'clan_snapshot');
    Assert.equal(snapshots.length, 1);
    Assert.equal(snapshots[0].observedAt, '2026-09-29T14:58:27.000Z');
    Assert.equal(snapshots[0].scope.wipeId, 'wipe:2026-09-29T14:00:00.000Z');

    let downloaded = false;
    value.client.playerIntelligenceImportDependencies.downloadImage = async () => {
        downloaded = true;
        throw new Error('must not run');
    };
    Assert.equal(await ImportWorkflow.handleMessage({
        client: value.client,
        message: { ...message, id: 'message-2', webhookId: '99999999999999999' }
    }), true);
    Assert.equal(downloaded, false);
});

Test('dedicated channel auto-detects multiple attachments and multiple cinfo panels as one confirmed batch', async t => {
    const value = createHarness(t);
    const cinfoWords = [
        word('ClanTag: zeub', 20), word('Members: 3', 45),
        word('Clan Members: Nirks, Psype and tom.le.geek.2', 70),
        word('Established: 09/29/2026 14:58:27', 95),
        word('ClanTag: xD', 180), word('Members: 2', 205),
        word('Clan Members: Nova and RangerMS', 230),
        word('Established: 09/30/2026 16:02:50', 255)
    ];
    const f7Words = [
        { ...word('FIND PLAYER', 10), x: 20 },
        { ...word('RW', 100), x: 100 },
        { ...word('76561197976022895', 122), x: 100, width: 150 }
    ];
    value.client.playerIntelligenceImportDependencies.downloadImage = async attachment => ({
        imageBase64: attachment.id,
        sha256: (attachment.id === 'multi' ? 'b' : 'c').repeat(64)
    });
    value.client.playerIntelligenceImportDependencies.recognize = async image =>
        image === 'multi' ? cinfoWords : f7Words;
    value.client.playerIntelligenceImportDependencies.steamProfileName = async steamId =>
        steamId === '76561197976022895' ? 'Rw' : null;
    const message = {
        guildId: 'guild', channelId: 'intel-imports', id: 'message-multi', content: '', webhookId: null,
        author: { id: 'requester', bot: false },
        member: { permissions: { has: () => false }, roles: { cache: new Map() } },
        attachments: new Map([
            ['multi', { id: 'multi' }],
            ['f7', { id: 'f7' }]
        ]),
        reply: async payload => value.replies.push(payload)
    };
    Assert.equal(await ImportWorkflow.handleMessage({ client: value.client, message }), true);
    Assert.match(value.replies[0].content, /Detected 3 import blocks/);
    Assert.match(value.replies[0].content, /OCR \/cinfo — zeub/);
    Assert.match(value.replies[0].content, /OCR \/cinfo — xD/);
    Assert.match(value.replies[0].content, /OCR F7/);
    const customId = value.replies[0].components[0].components[0].data.custom_id;
    const confirmation = {
        customId, guildId: 'guild', channelId: 'intel-imports', user: { id: 'requester' }
    };
    Assert.equal(await ImportWorkflow.handleButton({ client: value.client, interaction: confirmation }), true);
    Assert.match(value.updates.at(-1).content, /3 blocks/);
    const store = new Core.JsonlHistoryStore({ directory: Path.join(value.directory, 'guild', '42') });
    Assert.equal((await store.readAll()).filter(event => event.kind === 'clan_snapshot').length, 2);

    const correctedCinfoWords = cinfoWords.map(entry => entry.text.startsWith('Clan Members: Nirks, Psype') ?
        { ...entry, text: 'Clan Members: Nirks, CompletelyDifferent and tom.le.geek.2' } : entry);
    value.client.playerIntelligenceImportDependencies.recognize = async image =>
        image === 'multi' ? correctedCinfoWords : f7Words;
    const repeated = { ...message, id: 'message-multi-repeat' };
    Assert.equal(await ImportWorkflow.handleMessage({ client: value.client, message: repeated }), true);
    const repeatedCustomId = value.replies.at(-1).components[0].components[0].data.custom_id;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { ...confirmation, customId: repeatedCustomId }
    }), true);
    const replacement = value.updates.at(-1);
    Assert.match(replacement.content, /Duplicate evidence detected/);
    Assert.match(replacement.content, /Previous \/cinfo — zeub/);
    Assert.match(replacement.content, /Proposed replacement/);
    Assert.equal((await store.readAll()).filter(event => event.kind === 'clan_snapshot').length, 2);
    const replaceId = replacement.components[0].components[0].data.custom_id;
    const keepId = replacement.components[0].components[1].data.custom_id;
    Assert.match(replaceId, /^PIImportReplace:/u);
    Assert.match(keepId, /^PIImportKeep:/u);
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { ...confirmation, customId: replaceId }
    }), true);
    Assert.match(value.updates.at(-1).content, /Import replaced \(3 previous blocks/);
    const events = await store.readAll();
    Assert.equal(events.filter(event => event.kind === 'clan_snapshot').length, 4,
        'append-only journal retains superseded evidence for crash-safe recovery');
    Assert.equal(events.filter(event => event.kind === 'events_superseded').length, 3);
    const projection = Core.rebuild(events);
    Assert.equal(projection.clans.snapshots.length, 2);
    Assert.equal(projection.clans.tags.every(tag => tag.snapshotCount === 1), true);
    const zeub = projection.clans.snapshots.find(snapshot => snapshot.tag === 'zeub');
    Assert.equal(zeub.unresolvedMembers.some(member => member.observedText === 'CompletelyDifferent'), true);
    Assert.equal(Core.effectiveEvents(events).some(event =>
        event.kind === 'identity_observed' && event.subject.exactName === 'Psype'), false);

    const correctedAgain = correctedCinfoWords.map(entry => entry.text.includes('CompletelyDifferent') ?
        { ...entry, text: entry.text.replace('CompletelyDifferent', 'FinalName') } : entry);
    value.client.playerIntelligenceImportDependencies.recognize = async image =>
        image === 'multi' ? correctedAgain : f7Words;
    Assert.equal(await ImportWorkflow.handleMessage({
        client: value.client,
        message: { ...message, id: 'message-multi-third' }
    }), true);
    const thirdConfirmId = value.replies.at(-1).components[0].components[0].data.custom_id;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { ...confirmation, customId: thirdConfirmId }
    }), true);
    const thirdPreview = value.updates.at(-1);
    Assert.match(thirdPreview.content, /Previous \/cinfo — zeub[\s\S]*CompletelyDifferent/u);
    const thirdReplaceId = thirdPreview.components[0].components[0].data.custom_id;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { ...confirmation, customId: thirdReplaceId }
    }), true);
    const finalEvents = await store.readAll();
    const finalProjection = Core.rebuild(finalEvents);
    Assert.equal(finalProjection.clans.snapshots.length, 2);
    Assert.equal(finalProjection.clans.tags.every(tag => tag.snapshotCount === 1), true);
    const finalZeub = finalProjection.clans.snapshots.find(snapshot => snapshot.tag === 'zeub');
    Assert.equal(finalZeub.unresolvedMembers.some(member => member.observedText === 'FinalName'), true);
    Assert.equal(finalZeub.unresolvedMembers.some(member => member.observedText === 'CompletelyDifferent'), false);

    const staleReplacementIds = [];
    for (const id of ['message-stale-a', 'message-stale-b']) {
        Assert.equal(await ImportWorkflow.handleMessage({
            client: value.client,
            message: { ...message, id }
        }), true);
        const confirmId = value.replies.at(-1).components[0].components[0].data.custom_id;
        Assert.equal(await ImportWorkflow.handleButton({
            client: value.client,
            interaction: { ...confirmation, customId: confirmId }
        }), true);
        staleReplacementIds.push(value.updates.at(-1).components[0].components[0].data.custom_id);
    }
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { ...confirmation, customId: staleReplacementIds[0] }
    }), true);
    const afterFreshReplacement = await store.readAll();
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { ...confirmation, customId: staleReplacementIds[1] }
    }), true);
    Assert.match(value.updates.at(-1).content, /Existing import changed after preview/);
    Assert.equal((await store.readAll()).length, afterFreshReplacement.length);

    Assert.equal(await ImportWorkflow.handleMessage({
        client: value.client,
        message: { ...message, id: 'message-multi-keep' }
    }), true);
    const keepConfirmId = value.replies.at(-1).components[0].components[0].data.custom_id;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { ...confirmation, customId: keepConfirmId }
    }), true);
    const keepPreview = value.updates.at(-1);
    const keepExistingId = keepPreview.components[0].components[1].data.custom_id;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { ...confirmation, customId: keepExistingId }
    }), true);
    Assert.match(value.updates.at(-1).content, /Existing import kept/);
    Assert.equal((await store.readAll()).length, afterFreshReplacement.length);
});
