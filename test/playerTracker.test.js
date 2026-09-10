const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const PlayerTracker = require('../src/plugins/playerTracker');
const PluginManager = require('../src/plugins/pluginManager.js');

const FIXED_NOW = new Date('2026-09-09T12:00:00.000Z');

function createHarness(t, players = {}) {
    const dataDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-player-tracker-'));
    t.after(() => Fs.rmSync(dataDirectory, { recursive: true, force: true }));

    let instance = {
        activeServer: '127.0.0.1-28082',
        generalSettings: { language: 'en' },
        serverList: {
            '127.0.0.1-28082': {
                battlemetricsId: '42',
                title: 'Test server',
                img: 'https://example.invalid/server.jpg'
            }
        },
        trackers: {}
    };
    const logs = [];
    const battlemetrics = {
        lastUpdateSuccessful: true,
        streamerMode: false,
        players
    };
    const client = {
        battlemetricsInstances: { 42: battlemetrics },
        findAvailableTrackerId: () => 7,
        getInstance: () => instance,
        intlGet: (_guildId, key) => key,
        setInstance: (_guildId, value) => { instance = value; }
    };
    const rustplus = {
        guildId: 'guild',
        serverId: '127.0.0.1-28082',
        isOperational: true,
        generalSettings: { prefix: '!', inGameCommandsEnabled: true },
        log: (...values) => logs.push(values)
    };
    const dependencies = {
        dataDirectory,
        token: 'token',
        now: () => new Date(FIXED_NOW),
        warBanditsProvider: null
    };

    return {
        battlemetrics,
        client,
        dependencies,
        getInstance: () => instance,
        getSave: () => JSON.parse(Fs.readFileSync(Path.join(dataDirectory, 'guild-42.json'), 'utf8')),
        logs,
        rustplus
    };
}

function command(harness, text, source = 'inGame', message = {}) {
    return {
        source,
        client: harness.client,
        rustplus: harness.rustplus,
        guildId: 'guild',
        message,
        command: text,
        commandLowerCase: text.toLocaleLowerCase('en'),
        prefix: '!',
        playerTrackerDependencies: harness.dependencies
    };
}

function onlinePlayer(id, name) {
    return { id, name, status: true, logoutDate: null };
}

function steamProfile(steamId = '76561198154738095') {
    return {
        data: {
            included: [{
                type: 'identifier',
                attributes: { type: 'steamID', identifier: steamId }
            }]
        }
    };
}

Test('track resolves a current-server partial name and persists redacted stable identities', async t => {
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    let calls = 0;
    harness.dependencies.httpClient = {
        get: async url => {
            calls += 1;
            if (url.endsWith('/players')) {
                return {
                    data: {
                        data: [{
                            id: '1001',
                            attributes: { name: 'Nirks' },
                            relationships: { servers: { data: [{ id: '42', meta: { online: true } }] } }
                        }]
                    }
                };
            }
            Assert.equal(url.endsWith('/players/1001'), true);
            return steamProfile();
        }
    };

    const response = await PluginManager.handleCommand(command(harness, '!track nir'));

    Assert.equal(response.handled, true);
    Assert.match(response.response, /Tracking: Nirks \| BM:1001 \| Steam:76561198154738095 \| online/);
    Assert.equal(calls, 2);
    const tracker = harness.getInstance().trackers[7];
    Assert.equal(tracker.managedBy, 'player-tracker');
    Assert.equal(tracker.inGame, true);
    Assert.deepEqual(tracker.players, [{
        name: 'Nirks', steamId: '76561198154738095', playerId: '1001', playerIdLocked: true
    }]);
    const save = harness.getSave();
    Assert.equal(save.players[0].battlemetricsPlayerId, '1001');
    Assert.equal(save.players[0].steamId, '76561198154738095');
    Assert.equal(save.players[0].status, 'online');
    Assert.equal(save.players[0].lastSeenAt, FIXED_NOW.toISOString());
    Assert.equal(JSON.stringify(save).includes('playerToken'), false);
});

Test('ambiguous partial names require an explicit numbered selection', async t => {
    const harness = createHarness(t, {
        1001: onlinePlayer('1001', 'Nirks'),
        1002: onlinePlayer('1002', 'NirksTwo')
    });
    harness.dependencies.httpClient = {
        get: async url => url.endsWith('/players/1002') ?
            steamProfile('76561198154738096') : steamProfile('76561198154738095')
    };

    const ambiguous = await PlayerTracker.handleCommand(command(harness, '!track nirk'));
    Assert.equal(ambiguous.response,
        'Choose: 1) Nirks (BM:1001, online) | 2) NirksTwo (BM:1002, online) | Reply: !track #<number> or !track nirk <number>');
    Assert.deepEqual(harness.getInstance().trackers, {});

    const selected = await PlayerTracker.handleCommand(command(harness, '!track nirk 2'));
    Assert.match(selected.response, /^Tracking: NirksTwo /);
    Assert.equal(harness.getInstance().trackers[7].players[0].playerId, '1002');

    const exact = await PlayerTracker.handleCommand(command(harness, '!track Nirks'));
    Assert.match(exact.response, /^Tracking: Nirks /);
    Assert.equal(harness.getInstance().trackers[7].players.length, 2);
});

Test('numbered selections are scoped to the requester and expire after five minutes', async t => {
    const harness = createHarness(t, {
        1001: onlinePlayer('1001', 'Nirks'),
        1002: onlinePlayer('1002', 'NirksTwo')
    });
    let now = new Date(FIXED_NOW);
    harness.dependencies.now = () => now;
    harness.dependencies.httpClient = { get: async () => steamProfile() };
    const firstPlayer = { broadcast: { teamMessage: { message: { steamId: '76561198000000001' } } } };
    const secondPlayer = { broadcast: { teamMessage: { message: { steamId: '76561198000000002' } } } };

    await PlayerTracker.handleCommand(command(harness, '!track nirk', 'inGame', firstPlayer));
    const foreignSelection = await PlayerTracker.handleCommand(
        command(harness, '!track nirk 2', 'inGame', secondPlayer));
    Assert.match(foreignSelection.response, /nothing was saved/);
    Assert.deepEqual(harness.getInstance().trackers, {});

    now = new Date(FIXED_NOW.getTime() + (5 * 60 * 1000) + 1);
    const expired = await PlayerTracker.handleCommand(command(harness, '!track nirk 2', 'inGame', firstPlayer));
    Assert.equal(expired.response, 'Selection expired; run !track nirk again.');
    Assert.deepEqual(harness.getInstance().trackers, {});
});

Test('a numeric nickname remains a normal query without a pending selection', async t => {
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Enemy 2') });
    harness.dependencies.httpClient = { get: async () => steamProfile() };

    const response = await PlayerTracker.handleCommand(command(harness, '!track Enemy 2'));

    Assert.match(response.response, /^Tracking: Enemy 2 /);
});

Test('the hash shorthand selects from the requester pending list', async t => {
    const harness = createHarness(t, {
        1001: onlinePlayer('1001', 'Nirks'),
        1002: onlinePlayer('1002', 'NirksTwo')
    });
    harness.dependencies.httpClient = { get: async () => steamProfile() };

    await PlayerTracker.handleCommand(command(harness, '!track nirk'));
    const response = await PlayerTracker.handleCommand(command(harness, '!track #1'));

    Assert.match(response.response, /^Tracking: Nirks /);
    Assert.equal(harness.getInstance().trackers[7].players[0].playerId, '1001');
});

Test('SteamID64 resolves a public Steam name and proves the BattleMetrics identity', async t => {
    const steamId = '76561198154738095';
    const harness = createHarness(t, { 1001: onlinePlayer('1001', '[TEAM] Nirks') });
    harness.dependencies.steamHttpClient = {
        get: async (url, options) => {
            Assert.equal(url, `https://steamcommunity.com/profiles/${steamId}?xml=1`);
            Assert.equal(options.timeout, 5000);
            return { data: '<profile><steamID><![CDATA[Nirks]]></steamID></profile>' };
        }
    };
    harness.dependencies.httpClient = { get: async () => steamProfile(steamId) };

    const response = await PlayerTracker.handleCommand(command(harness, `!track ${steamId}`));

    Assert.match(response.response, /Tracking: \[TEAM\] Nirks \| BM:1001 \| Steam:76561198154738095/);
    Assert.equal(harness.getInstance().trackers[7].players[0].steamId, steamId);
    Assert.equal(harness.getSave().players[0].steamId, steamId);
});

Test('SteamID64 uses WarBandits identity before the generic Steam profile and links BattleMetrics', async t => {
    const steamId = '76561198154738095';
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    let steamProfileCalls = 0;
    const links = [];
    harness.dependencies.steamHttpClient = {
        get: async () => {
            steamProfileCalls += 1;
            throw new Error('Steam profile lookup should not be called');
        }
    };
    harness.dependencies.httpClient = { get: async () => steamProfile(steamId) };
    harness.dependencies.warBanditsProvider = {
        resolvePlayer: async (_context, scope, query) => {
            Assert.equal(scope.battlemetricsId, '42');
            Assert.equal(query, steamId);
            return {
                available: true,
                player: {
                    steamId,
                    warBanditsPlayerId: '501',
                    name: 'Nirks'
                }
            };
        },
        linkBattlemetricsPlayer: async (_context, _scope, player) => links.push(player)
    };

    const response = await PlayerTracker.handleCommand(command(harness, `!track ${steamId}`));

    Assert.match(response.response, /Tracking: Nirks \| BM:1001 \| Steam:76561198154738095/);
    Assert.equal(steamProfileCalls, 0);
    Assert.deepEqual(links, [{
        steamId,
        battlemetricsPlayerId: '1001',
        name: 'Nirks'
    }]);
});

Test('name tracking accepts WarBandits SteamID enrichment when BattleMetrics omits it', async t => {
    const steamId = '76561198154738095';
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    harness.dependencies.httpClient = {
        get: async () => {
            const error = new Error('identifier unavailable');
            error.response = { status: 404 };
            throw error;
        }
    };
    harness.dependencies.warBanditsProvider = {
        resolvePlayer: async () => ({
            available: true,
            player: { steamId, warBanditsPlayerId: '501', name: 'Nirks' }
        }),
        linkBattlemetricsPlayer: async () => undefined
    };

    const response = await PlayerTracker.handleCommand(command(harness, '!track Nirks'));

    Assert.match(response.response, /Steam:76561198154738095/);
    Assert.equal(harness.getInstance().trackers[7].players[0].steamId, steamId);
    Assert.equal(harness.getSave().players[0].steamId, steamId);
});

Test('conflicting BattleMetrics and WarBandits SteamIDs reject tracker mutation', async t => {
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    harness.dependencies.httpClient = {
        get: async () => steamProfile('76561198154738095')
    };
    harness.dependencies.warBanditsProvider = {
        resolvePlayer: async () => ({
            available: true,
            player: {
                steamId: '76561199179453915',
                warBanditsPlayerId: '501',
                name: 'Nirks'
            }
        })
    };

    const response = await PlayerTracker.handleCommand(command(harness, '!track Nirks'));

    Assert.equal(response.response,
        'WarBandits identity does not match the resolved BattleMetrics player; nothing was saved.');
    Assert.deepEqual(harness.getInstance().trackers, {});
});

Test('WarBandits cache-link failure cannot undo an authoritative tracker commit', async t => {
    const steamId = '76561198154738095';
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    harness.dependencies.httpClient = { get: async () => steamProfile(steamId) };
    harness.dependencies.warBanditsProvider = {
        resolvePlayer: async () => ({
            available: true,
            player: { steamId, warBanditsPlayerId: '501', name: 'Nirks' }
        }),
        linkBattlemetricsPlayer: async () => { throw new Error('cache unavailable'); }
    };

    const response = await PlayerTracker.handleCommand(command(harness, '!track Nirks'));

    Assert.match(response.response, /^Tracking: Nirks /);
    Assert.equal(harness.getInstance().trackers[7].players[0].playerId, '1001');
    Assert.equal(harness.getSave().players[0].battlemetricsPlayerId, '1001');
    Assert.match(harness.logs.at(-1)[1], /WarBandits cache link unavailable/);
});

Test('SteamID64 rejects a conflicting BattleMetrics Steam identifier', async t => {
    const steamId = '76561198154738095';
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    harness.dependencies.steamHttpClient = {
        get: async () => ({ data: '<profile><steamID><![CDATA[Nirks]]></steamID></profile>' })
    };
    harness.dependencies.httpClient = {
        get: async () => steamProfile('76561198000000001')
    };

    const response = await PlayerTracker.handleCommand(command(harness, `!track ${steamId}`));

    Assert.equal(response.response,
        'SteamID does not match the resolved BattleMetrics player; nothing was saved.');
    Assert.deepEqual(harness.getInstance().trackers, {});
});

Test('SteamID64 rejects an unproven loose current-server name match', async t => {
    const steamId = '76561198154738095';
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks123') });
    harness.dependencies.steamHttpClient = {
        get: async () => ({ data: '<profile><steamID><![CDATA[Nirks]]></steamID></profile>' })
    };
    harness.dependencies.httpClient = {
        get: async url => {
            const error = new Error(url.endsWith('/players') ? 'forbidden' : 'not found');
            error.response = { status: url.endsWith('/players') ? 403 : 404 };
            throw error;
        }
    };

    const response = await PlayerTracker.handleCommand(command(harness, `!track ${steamId}`));

    Assert.equal(response.response,
        'Steam name resolved as Nirks, but no exact current-server match was proven; nothing was saved.');
    Assert.deepEqual(harness.getInstance().trackers, {});
});

Test('remote search is current-server scoped and SteamID remains nullable', async t => {
    const harness = createHarness(t);
    harness.dependencies.httpClient = {
        get: async url => {
            if (url.endsWith('/players')) {
                return {
                    data: {
                        data: [
                            {
                                id: '2001',
                                attributes: { name: 'Offline Enemy' },
                                relationships: {
                                    servers: { data: [{ id: '42', meta: { online: false, lastSeen: '2026-09-09T10:00:00Z' } }] }
                                }
                            },
                            {
                                id: '9999',
                                attributes: { name: 'Offline Enemy Elsewhere' },
                                relationships: { servers: { data: [{ id: '99', meta: { online: true } }] } }
                            }
                        ]
                    }
                };
            }
            const error = new Error('private profile');
            error.response = { status: 404 };
            throw error;
        }
    };

    const response = await PlayerTracker.handleCommand(command(harness, '!track Offline Enemy'));

    Assert.match(response.response, /BM:2001 \| Steam:unavailable \| offline/);
    Assert.equal(harness.getSave().players[0].steamId, null);
    Assert.equal(harness.getSave().players[0].lastSeenAt, '2026-09-09T10:00:00.000Z');
});

Test('a truncated remote result set is explicit about hidden matches before selection', async t => {
    const harness = createHarness(t);
    harness.dependencies.httpClient = {
        get: async () => ({
            data: {
                data: [{
                    id: '2001',
                    attributes: { name: 'Enemy One' },
                    relationships: { servers: { data: [{ id: '42', meta: { online: false } }] } }
                }],
                links: { next: 'https://api.battlemetrics.com/players?page=2' },
                meta: { pagination: { total: 11 } }
            }
        })
    };

    const response = await PlayerTracker.handleCommand(command(harness, '!track Enemy'));

    Assert.match(response.response, /^Choose: 1\) Enemy One/);
    Assert.match(response.response, /more matches exist/);
    Assert.deepEqual(harness.getInstance().trackers, {});
});

Test('BattleMetrics failure is not converted to offline and performs no mutation', async t => {
    const harness = createHarness(t);
    harness.battlemetrics.lastUpdateSuccessful = false;
    harness.dependencies.httpClient = {
        get: async () => {
            const error = new Error('rate limited');
            error.response = { status: 429 };
            throw error;
        }
    };

    const response = await PlayerTracker.handleCommand(command(harness, '!track Enemy'));

    Assert.match(response.response, /search unavailable \(HTTP 429\); nothing was saved/);
    Assert.deepEqual(harness.getInstance().trackers, {});
    Assert.equal(harness.logs.at(-1)[2], 'warn');
});

Test('track is idempotent under concurrency', async t => {
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    harness.dependencies.httpClient = {
        get: async () => {
            await new Promise(resolve => setImmediate(resolve));
            return steamProfile();
        }
    };

    const responses = await Promise.all([
        PlayerTracker.handleCommand(command(harness, '!track Nirks')),
        PlayerTracker.handleCommand(command(harness, '!track Nirks'))
    ]);

    Assert.equal(harness.getInstance().trackers[7].players.length, 1);
    Assert.equal(responses.filter(response => response.response.startsWith('Tracking:')).length, 1);
    Assert.equal(responses.filter(response => response.response.startsWith('Already tracked:')).length, 1);
});

Test('poll sync, tracklist and untrack preserve last seen without deleting the native tracker', async t => {
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    harness.dependencies.httpClient = { get: async () => steamProfile() };
    harness.dependencies.now = () => new Date('2026-09-09T11:40:00.000Z');
    await PlayerTracker.handleCommand(command(harness, '!track Nirks'));

    harness.dependencies.now = () => new Date(FIXED_NOW);
    harness.battlemetrics.players[1001].name = 'Nirks Renamed';
    harness.battlemetrics.players[1001].status = false;
    harness.battlemetrics.players[1001].logoutDate = '2026-09-09T11:50:00.000Z';
    await PluginManager.onBattlemetricsUpdated({
        client: harness.client,
        guildId: 'guild',
        rustplus: harness.rustplus,
        playerTrackerDependencies: harness.dependencies
    });

    const list = await PlayerTracker.handleCommand(command(harness, '!tracklist'));
    Assert.equal(list.response, 'Tracked (1): Nirks Renamed: last 10m');
    Assert.equal(harness.getSave().players[0].status, 'offline');
    Assert.equal(harness.getSave().players[0].lastSeenAt, '2026-09-09T11:50:00.000Z');
    Assert.equal(harness.getInstance().trackers[7].players[0].name, 'Nirks Renamed');

    const removed = await PlayerTracker.handleCommand(command(harness, '!untrack 1001'));
    Assert.match(removed.response, /^Stopped tracking: Nirks Renamed/);
    Assert.deepEqual(harness.getInstance().trackers[7].players, []);
    Assert.deepEqual(harness.getSave().players, []);
});

Test('tracklist is bounded to one Rust-safe message and reports omitted entries', async t => {
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    harness.dependencies.httpClient = { get: async () => steamProfile() };
    await PlayerTracker.handleCommand(command(harness, '!track Nirks'));
    const tracker = harness.getInstance().trackers[7];
    for (let index = 2; index <= 12; index += 1) {
        const playerId = `${1000 + index}`;
        const name = `Enemy-${index}-with-a-long-name`;
        tracker.players.push({ name, steamId: null, playerId, playerIdLocked: true });
        harness.battlemetrics.players[playerId] = onlinePlayer(playerId, name);
    }

    const list = await PlayerTracker.handleCommand(command(harness, '!tracklist'));

    Assert.equal(list.response.length <= 122, true);
    Assert.match(list.response, /\| \+\d+$/);
});

Test('Premium tracker commands persist server details, sessions and related players without changing presence', async t => {
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    harness.dependencies.httpClient = { get: async () => steamProfile() };
    await PlayerTracker.handleCommand(command(harness, '!track Nirks'));
    harness.dependencies.battlemetricsProvider = {
        getServerPlayer: async () => ({
            available: true,
            reason: null,
            player: {
                firstSeenAt: '2026-06-01T00:00:00.000Z',
                lastSeenAt: '2026-09-09T22:00:00.000Z',
                timePlayedSeconds: 90061
            }
        }),
        getSessions: async () => ({
            available: true,
            reason: null,
            truncated: false,
            sessions: [{
                id: 's1',
                startAt: '2026-09-10T10:00:00.000Z',
                stopAt: '2026-09-10T11:00:00.000Z',
                durationSeconds: 3600
            }]
        }),
        getRelatedPlayers: async () => ({
            available: true,
            reason: null,
            truncated: false,
            players: [{
                battlemetricsPlayerId: '2001',
                name: 'Enemy Ally',
                overlapSeconds: 7200,
                sessionCount: 4
            }]
        })
    };

    const info = await PlayerTracker.handleCommand(command(harness, '!trackinfo Nirk'));
    const history = await PlayerTracker.handleCommand(command(harness, '!trackhistory 1001'));
    const related = await PlayerTracker.handleCommand(command(harness, '!trackrelated 76561198154738095'));

    Assert.match(info.response, /^Nirks: online \| played 1d1h/);
    Assert.match(history.response, /^Sessions Nirks: 09-10 10:00Z-09-10 11:00Z \(1h0m\)/);
    Assert.equal(related.response, 'Related Nirks: Enemy Ally 2h0m');
    const save = harness.getSave();
    Assert.equal(save.schemaVersion, 2);
    Assert.equal(save.players[0].status, 'online');
    Assert.equal(save.players[0].battlemetrics.server.timePlayedSeconds, 90061);
    Assert.equal(save.players[0].battlemetrics.sessions.items[0].id, 's1');
    Assert.equal(save.players[0].battlemetrics.related.players[0].battlemetricsPlayerId, '2001');
});

Test('Premium API failure leaves the last tracker projection intact', async t => {
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    harness.dependencies.httpClient = { get: async () => steamProfile() };
    await PlayerTracker.handleCommand(command(harness, '!track Nirks'));
    const before = harness.getSave();
    harness.dependencies.battlemetricsProvider = {
        getSessions: async () => ({ available: false, reason: 'subscription or permission denied' })
    };

    const response = await PlayerTracker.handleCommand(command(harness, '!trackhistory Nirks'));

    Assert.equal(response.response,
        'BattleMetrics sessions unavailable (subscription or permission denied); tracker unchanged.');
    Assert.deepEqual(harness.getSave(), before);
});

Test('a corrupt readable save is preserved and blocks a new tracker commit', async t => {
    const harness = createHarness(t, { 1001: onlinePlayer('1001', 'Nirks') });
    const path = Path.join(harness.dependencies.dataDirectory, 'guild-42.json');
    Fs.writeFileSync(path, '{broken\n', 'utf8');
    harness.dependencies.httpClient = { get: async () => steamProfile() };

    const response = await PlayerTracker.handleCommand(command(harness, '!track Nirks'));

    Assert.match(response.response, /failed safely; nothing was changed/);
    Assert.equal(Fs.readFileSync(path, 'utf8'), '{broken\n');
    Assert.deepEqual(harness.getInstance().trackers, {});
});

Test('Steam identifier parsing rejects malformed identifiers', () => {
    Assert.equal(PlayerTracker.parseSteamId(steamProfile().data), '76561198154738095');
    Assert.equal(PlayerTracker.parseSteamId({
        included: [{ type: 'identifier', attributes: { type: 'steamID', identifier: '123' } }]
    }), null);
});
