const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const IntelCommand = require('../src/commands/intel.js');
const Core = require('../src/plugins/playerIntelligence');

const STEAM_ID = '76561198154738095';

Test('Discord intel link uses the current Steam persona and replies only ephemerally', async t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-player-intelligence-discord-'));
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const instance = {
        activeServer: 'server',
        serverList: { server: { battlemetricsId: '42', title: 'Test' } }
    };
    const replies = [];
    const client = {
        battlemetricsInstances: { 42: { server_rust_last_wipe: '2026-09-29T14:00:00.000Z' } },
        rustplusInstances: {},
        getInstance: () => instance,
        playerIntelligenceDependencies: {
            dataDirectory: directory,
            now: () => new Date('2026-10-01T10:00:00.000Z')
        },
        playerIntelligenceAdminDependencies: {
            steamProfileName: async steamId => {
                Assert.equal(steamId, STEAM_ID);
                return 'Ch1co';
            }
        },
        validatePermissions: async () => true,
        isAdministrator: () => true,
        logInteraction: () => {},
        interactionEditReply: async (_interaction, payload) => { replies.push(payload); },
        intlGet: (_guildId, key) => key,
        log: () => {}
    };
    const store = new Core.JsonlHistoryStore({ directory: Path.join(directory, 'guild', '42') });
    await store.append(Core.createEvent({
        schemaVersion: Core.SCHEMA_VERSION,
        kind: 'identity_observed',
        observedAt: '2026-10-01T09:00:00.000Z',
        recordedAt: '2026-10-01T09:00:00.000Z',
        scope: { guildId: 'guild', serverKey: 'battlemetrics:42',
            wipeId: 'wipe:2026-09-29T14:00:00.000Z' },
        subject: { steamId: null, battlemetricsPlayerId: null, exactName: 'ChiCo' },
        payload: { caseFidelity: true },
        provenance: { source: 'discord-cinfo', sourceEventId: 'pending-chico', collectorVersion: 'test-1' },
        confidence: 'verified', evidence: null
    }));
    const values = { alias: 'ChiCo', steamid: STEAM_ID };
    const interaction = {
        guildId: 'guild', user: { id: 'admin' },
        options: {
            getSubcommand: () => 'link',
            getString: name => values[name] ?? null,
            getInteger: () => null
        },
        deferReply: async options => { Assert.deepEqual(options, { ephemeral: true }); }
    };

    await IntelCommand.execute(client, interaction);

    Assert.equal(replies.length, 1);
    Assert.match(replies[0].content, /Current display: "Ch1co" \(current Steam profile\)/u);
    Assert.deepEqual(replies[0].allowedMentions, { parse: [] });
    const projection = Core.rebuild(await store.readAll());
    const person = projection.identities.findByIdentifier(STEAM_ID)[0];
    Assert.equal(projection.identities.displayName(person.personId), 'Ch1co');
    Assert.deepEqual(person.names.map(alias => [alias.name, alias.verified]), [
        ['ChiCo', false], ['Ch1co', true]
    ]);

    const historyValues = { target: STEAM_ID };
    await IntelCommand.execute(client, {
        guildId: 'guild', user: { id: 'admin' },
        options: {
            getSubcommand: () => 'history',
            getString: name => historyValues[name] ?? null,
            getInteger: () => null
        },
        deferReply: async options => { Assert.deepEqual(options, { ephemeral: true }); }
    });
    Assert.match(replies[1].content, /Verified alias history for Ch1co/u);
    Assert.match(replies[1].content, /"Ch1co"/u);
    Assert.doesNotMatch(replies[1].content, /ChiCo/u);
    Assert.deepEqual(IntelCommand.getData().toJSON().options.map(option => option.name),
        ['pending', 'links', 'history', 'link', 'merge', 'unlink']);
    const linkOptions = IntelCommand.getData().toJSON().options.find(option => option.name === 'link').options;
    Assert.deepEqual(linkOptions.map(option => option.name), ['alias', 'steamid']);
});
