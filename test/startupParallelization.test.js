const Assert = require('node:assert/strict');
const Test = require('node:test');

const indexPath = require.resolve('../index.ts');
require.cache[indexPath] = { exports: { client: {} } };

const DiscordBot = require('../src/structures/DiscordBot.js');
const SyncRustplusDiscordState = require('../src/util/SyncRustplusDiscordState.js');

Test('Rust+ bootstrap does not wait for Discord login', () => {
    const calls = [];
    const discordLogin = new Promise(() => {});
    const client = {
        loadLocalInstancesFromConfig: () => calls.push('load-local'),
        createRustplusInstancesFromConfig: () => calls.push('start-rustplus'),
        startLocalFcmListenersFromConfig: () => calls.push('start-fcm'),
        login: () => {
            calls.push('login-discord');
            return discordLogin;
        },
        intlGet: () => '',
        log: () => undefined
    };

    DiscordBot.prototype.build.call(client);

    Assert.deepEqual(calls, ['load-local', 'start-rustplus', 'start-fcm', 'login-discord']);
});

Test('configured Rust+ startup is idempotent when Discord becomes ready', () => {
    const calls = [];
    const server = Object.freeze({
        serverIp: '127.0.0.1', appPort: 28082, steamId: '76561198000000000', playerToken: 42
    });
    const client = {
        instances: {
            guild: { activeServer: 'server', serverList: { server } }
        },
        rustplusInstances: {},
        createRustplusInstance(guildId, ...args) {
            calls.push([guildId, ...args]);
            this.rustplusInstances[guildId] = { isDeleted: false };
        }
    };

    DiscordBot.prototype.createRustplusInstancesFromConfig.call(client);
    DiscordBot.prototype.createRustplusInstancesFromConfig.call(client);

    Assert.equal(calls.length, 1);
    Assert.deepEqual(calls[0], ['guild', '127.0.0.1', 28082, '76561198000000000', 42]);
});

Test('saved FCM listeners start once without waiting for Discord', async () => {
    const calls = [];
    const client = {
        fcmListeners: { guild: { active: true } },
        fcmListenersLite: { guild: { '76561198000000001': { active: true } } },
        log: (...args) => calls.push(['log', ...args])
    };
    const adapters = {
        readCredentials: () => ({
            hoster: '76561198000000000',
            '76561198000000000': {},
            '76561198000000001': {},
            '76561198000000002': {}
        }),
        startHost: async () => calls.push('host'),
        startLite: async (_client, _guild, steamId) => calls.push(steamId)
    };

    await DiscordBot.prototype.startFcmListenersForGuild.call(client, { id: 'guild' }, adapters);

    Assert.deepEqual(calls, ['76561198000000002']);
});

Test('one failed FCM listener does not cancel the other saved listeners', async () => {
    const calls = [];
    const client = {
        fcmListeners: {},
        fcmListenersLite: {},
        log: (...args) => calls.push(['log', ...args])
    };
    const adapters = {
        readCredentials: () => ({ hoster: 'host', host: {}, lite: {} }),
        startHost: async () => { throw new Error('host unavailable'); },
        startLite: async () => calls.push('lite')
    };

    await DiscordBot.prototype.startFcmListenersForGuild.call(client, { id: 'guild' }, adapters);

    Assert.equal(calls[0], 'lite');
    Assert.match(String(calls[1][2]), /Host listener failed/);
});

Test('Discord projection is retained while offline and flushed once ready', async () => {
    const calls = [];
    let ready = false;
    const client = { isReady: () => ready };
    const rustplus = {
        guildId: 'guild',
        serverId: 'server',
        map: { writeMap: async () => calls.push('render-map') },
        isNewConnection: true,
        pendingDiscordSync: null,
        log: (...args) => calls.push(['log', ...args])
    };
    const adapters = {
        discordMessages: {
            sendServerWipeDetectedMessage: async () => calls.push('wipe'),
            sendInformationMapMessage: async () => calls.push('map'),
            sendServerChangeStateMessage: async () => calls.push('reconnected'),
            sendServerMessage: async () => calls.push('server')
        },
        setupSwitches: async () => calls.push('switches'),
        setupSwitchGroups: async () => calls.push('groups'),
        setupAlarms: async () => calls.push('alarms'),
        setupStorageMonitors: async () => calls.push('storage')
    };

    const deferred = await SyncRustplusDiscordState.synchronize(
        client, rustplus, { mapChanged: true, reconnected: true }, adapters);
    Assert.equal(deferred, false);
    Assert.deepEqual(calls, []);

    ready = true;
    const flushed = await SyncRustplusDiscordState.synchronize(client, rustplus, {}, adapters);

    Assert.equal(flushed, true);
    Assert.deepEqual(calls, [
        'render-map', 'wipe', 'map', 'reconnected', 'server', 'switches', 'groups', 'alarms', 'storage'
    ]);
    Assert.equal(rustplus.pendingDiscordSync, null);
    Assert.equal(rustplus.isNewConnection, false);
});
