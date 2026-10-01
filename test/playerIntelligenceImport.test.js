const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Core = require('../src/plugins/playerIntelligence');
const ImportWorkflow = require('../src/plugins/playerIntelligence/importWorkflow.js');

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

Test('inconsistent OCR never creates a pending import or journal', async t => {
    const value = createHarness(t);
    value.client.playerIntelligenceImportDependencies.recognize = async () => [
        word('ClanTag: BAD', 20), word('Members: 3', 45),
        word('Clan Members: Alice and Bob', 70),
        word('Established: 09/29/2026 14:58:27', 95)
    ];
    await ImportWorkflow.beginImport(value.client, value.command);
    Assert.match(value.edits[0].content, /Nothing was committed/);
    Assert.deepEqual(value.edits[0].components, []);
    const store = new Core.JsonlHistoryStore({
        directory: Path.join(value.directory, 'guild', '42')
    });
    Assert.equal((await store.readAll()).length, 0);
});

Test('dedicated import channel accepts only an approved helper webhook and still requires confirmation', async t => {
    const value = createHarness(t);
    const message = {
        guildId: 'guild', channelId: 'intel-imports', id: 'message-1', content: 'cinfo',
        webhookId: '12345678901234567', author: { id: 'webhook', bot: true },
        attachments: new Map([['image', { id: 'image' }]]),
        reply: async payload => value.replies.push(payload)
    };
    Assert.equal(await ImportWorkflow.handleMessage({ client: value.client, message }), true);
    Assert.equal(value.replies.length, 1);
    Assert.match(value.replies[0].content, /OCR \/cinfo/);
    const customId = value.replies[0].components[0].components[0].data.custom_id;
    const confirmation = {
        customId, guildId: 'guild', channelId: 'intel-imports', user: { id: 'reviewer' }
    };
    Assert.equal(await ImportWorkflow.handleButton({ client: value.client, interaction: confirmation }), true);
    Assert.match(value.updates.at(-1).content, /Import committed/);
    const store = new Core.JsonlHistoryStore({ directory: Path.join(value.directory, 'guild', '42') });
    Assert.equal((await store.readAll()).filter(event => event.kind === 'clan_snapshot').length, 1);

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

    const repeated = { ...message, id: 'message-multi-repeat' };
    Assert.equal(await ImportWorkflow.handleMessage({ client: value.client, message: repeated }), true);
    const repeatedCustomId = value.replies.at(-1).components[0].components[0].data.custom_id;
    Assert.equal(await ImportWorkflow.handleButton({
        client: value.client,
        interaction: { ...confirmation, customId: repeatedCustomId }
    }), true);
    Assert.match(value.updates.at(-1).content, /Every detected block was already imported/);
    Assert.equal((await store.readAll()).filter(event => event.kind === 'clan_snapshot').length, 2);
});
