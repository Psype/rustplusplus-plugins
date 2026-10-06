const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const WarBandits = require('../src/plugins/warBandits');

function server(overrides = {}) {
    return {
        sid: 13,
        nextwipe: '2026-09-17T14:00:00.000Z',
        wipetime: 604800,
        lastwipe: '2026-09-10T14:00:00.000Z',
        serverip: 'eu5xnbp.warbandits.gg:28010',
        serverid: 12,
        joining: 2,
        queued: 3,
        connected: 100,
        max_pop: 200,
        grouplimit: 8,
        region: 'EU',
        multiplier: 5,
        ismain: true,
        isnobps: true,
        name: 'eu5xnobps',
        fullname: 'WarBandits EU 5X NoBPs',
        bmid: 42,
        ...overrides
    };
}

function catalog(servers = [server()]) {
    return servers;
}

function wipes(rows = [
    { ID: 8467, start_date: '2026-10-02T13:56:00.000Z', end_date: '2026-10-06T13:56:05.000Z' },
    { ID: 8398, start_date: '2026-10-01T13:56:00.000Z', end_date: '2026-10-02T13:56:13.000Z' }
]) {
    return rows;
}

function statsRow(overrides = {}) {
    return {
        player: {
            ID: 501,
            steam_64_ID: '76561198154738095',
            name: 'Psype',
            rank: 3,
            playtime: 600,
            ...(overrides.player || {})
        },
        stats: overrides.stats || [
            { ID: 1, name: 'kills', amount: 10 },
            { name: 'deaths', amount: 2 }
        ]
    };
}

function stats(rows = [statsRow()], utils = { total: 1 }) {
    return { code: 200, stats: rows, utils };
}

function harness(t, options = {}) {
    const dataDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-warbandits-'));
    t.after(() => Fs.rmSync(dataDirectory, { recursive: true, force: true }));
    let currentMs = Date.parse('2026-09-10T12:00:00.000Z');
    const calls = [];
    const sleeps = [];
    const httpClient = options.httpClient || {
        get: async (url, config) => {
            calls.push({ url, config });
            return { data: url.endsWith('/servers') ? catalog() : stats() };
        }
    };
    const provider = WarBandits.createProvider({
        dataDirectory,
        httpClient,
        requestGapMs: options.requestGapMs === undefined ? 0 : options.requestGapMs,
        catalogTtlMs: options.catalogTtlMs === undefined ? 3600000 : options.catalogTtlMs,
        statsTtlMs: options.statsTtlMs === undefined ? 300000 : options.statsTtlMs,
        cloudflareCooldownMs: options.cloudflareCooldownMs,
        now: () => new Date(currentMs),
        sleep: async milliseconds => {
            sleeps.push(milliseconds);
            currentMs += milliseconds;
        }
    });
    return {
        calls,
        dataDirectory,
        provider,
        setNow: value => { currentMs = new Date(value).getTime(); },
        advance: milliseconds => { currentMs += milliseconds; },
        sleeps
    };
}

Test('strict catalogue parsing and exact server selection prefer BattleMetrics ID then hostname', () => {
    const parsed = WarBandits.parseServerCatalog(catalog([
        server({ sid: 11, serverid: 11, name: 'first', bmid: 41, serverip: 'same.example:28010' }),
        server({ sid: 12, serverid: 12, name: 'second', bmid: 42, serverip: 'second.example:28010' })
    ]));

    Assert.equal(Object.isFrozen(parsed), true);
    Assert.equal(Object.isFrozen(parsed[0]), true);
    Assert.equal(WarBandits.selectServer(parsed, {
        battlemetricsId: '42', hostname: 'same.example'
    }).slug, 'second');
    Assert.equal(WarBandits.selectServer(parsed, { hostname: 'SAME.EXAMPLE:29000' }).slug, 'first');
    Assert.equal(WarBandits.selectServer(parsed, { hostname: 'same' }), null);
    Assert.throws(() => WarBandits.parseServerCatalog(catalog([server({ connected: 'many' })])),
        /connected/);
    Assert.throws(() => WarBandits.parseServerCatalog([{ sid: 1 }]),
        /incomplete/);
});

Test('wipe catalogue parsing preserves opaque numeric IDs and orders newest intervals first', () => {
    const parsed = WarBandits.parseWipeCatalog(wipes().slice().reverse());

    Assert.equal(Object.isFrozen(parsed), true);
    Assert.equal(Object.isFrozen(parsed[0]), true);
    Assert.deepEqual(parsed.map(wipe => wipe.id), [8467, 8398]);
    Assert.equal(parsed[0].startAt, '2026-10-02T13:56:00.000Z');
    Assert.throws(() => WarBandits.parseWipeCatalog(wipes([
        { ID: 8467, start_date: '2026-10-02T13:56:00.000Z', end_date: '2026-10-06T13:56:05.000Z' },
        { ID: '08467', start_date: '2026-09-25T13:56:00.000Z', end_date: '2026-10-02T13:56:05.000Z' }
    ])), /duplicated/);
    Assert.throws(() => WarBandits.parseWipeCatalog(wipes([
        { ID: Number.MAX_SAFE_INTEGER + 1, start_date: '2026-10-02T13:56:00.000Z',
            end_date: '2026-10-06T13:56:05.000Z' }
    ])), /invalid/);
});

Test('catalogue cache is atomic LF, coalesced and reusable from disk', async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let requests = 0;
    const test = harness(t, {
        httpClient: {
            get: async () => {
                requests += 1;
                await gate;
                return { data: catalog() };
            }
        }
    });

    const first = test.provider.ensureServerCatalog();
    const second = test.provider.ensureServerCatalog();
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    Assert.equal(requests, 1);
    Assert.strictEqual(firstResult, secondResult);

    const path = Path.join(test.dataDirectory, 'servers.json');
    const bytes = Fs.readFileSync(path, 'utf8');
    Assert.equal(bytes.endsWith('\n'), true);
    Assert.equal(bytes.includes('\r'), false);
    Assert.deepEqual(Fs.readdirSync(test.dataDirectory), ['servers.json']);

    let diskProviderRequests = 0;
    const diskProvider = WarBandits.createProvider({
        dataDirectory: test.dataDirectory,
        requestGapMs: 0,
        now: () => new Date('2026-09-10T12:00:01.000Z'),
        httpClient: { get: async () => { diskProviderRequests += 1; throw new Error('unexpected'); } }
    });
    const diskResult = await diskProvider.ensureServerCatalog();
    Assert.equal(diskResult.available, true);
    Assert.equal(diskResult.source, 'cache');
    Assert.equal(diskProviderRequests, 0);
});

Test('requests are serialized, gap-controlled and identical player lookups coalesce', async t => {
    const test = harness(t, { requestGapMs: 5000 });
    const scope = { battlemetricsId: '42' };

    const [first, second] = await Promise.all([
        test.provider.resolvePlayer(null, scope, 'Psype'),
        test.provider.resolvePlayer(null, scope, 'Psype')
    ]);

    Assert.equal(first.available, true);
    Assert.strictEqual(first, second);
    Assert.equal(test.calls.length, 2);
    Assert.equal(test.calls[0].url.endsWith('/servers'), true);
    Assert.equal(test.calls[1].url.endsWith('/stats/eu5xnobps'), true);
    Assert.deepEqual(test.sleeps, [5000]);
    Assert.equal(test.calls[1].config.timeout, 5000);
    Assert.equal(test.calls[1].config.params.player_name, 'Psype');
});

Test('player lookups isolate current, historical-ID and all-time caches', async t => {
    const test = harness(t);
    const scope = { battlemetricsId: '42' };

    const current = await test.provider.resolvePlayer(null, scope, 'Psype', { wipe: 0 });
    const allTime = await test.provider.resolvePlayer(null, scope, 'Psype');
    const currentCached = await test.provider.resolvePlayer(null, scope, 'Psype', { wipe: '0' });
    const historical = await test.provider.resolvePlayer(null, scope, 'Psype', { wipe: 8398 });

    Assert.equal(current.wipe, 0);
    Assert.equal(allTime.wipe, 'all-time');
    Assert.equal(historical.wipe, 8398);
    Assert.strictEqual(currentCached, current);
    Assert.deepEqual(test.calls.slice(1).map(call => call.config.params.wipe), [0, 'all-time', 8398]);
    Assert.equal((await test.provider.resolvePlayer(null, scope, 'Psype', { wipe: -1 })).reason,
        'invalid wipe');
});

Test('recent resolution tries current then the interval matching Established and stops before all-time', async t => {
    const test = harness(t, {
        httpClient: {
            get: async (url, config) => {
                test.calls.push({ url, config });
                if (url.endsWith('/servers')) return { data: catalog() };
                if (url.includes('/wipes/')) return { data: wipes([
                    { ID: 8500, start_date: '2026-10-06T13:56:05.000Z',
                        end_date: '2026-10-09T13:56:00.000Z' },
                    ...wipes()
                ]) };
                if (config.params.wipe === 8398) {
                    return { data: stats([statsRow({
                        player: { steam_64_ID: '76561198784468196', name: 'FUNTIK' }
                    })]) };
                }
                return { data: stats([], { total: 0 }) };
            }
        }
    });
    test.setNow('2026-10-06T16:00:00.000Z');

    const result = await test.provider.resolvePlayerRecent(null, { battlemetricsId: '42' }, 'FUNTIK', {
        observedAt: '2026-10-01T20:00:00.000Z'
    });

    Assert.equal(result.player.steamId, '76561198784468196');
    Assert.equal(result.wipe, 8398);
    Assert.deepEqual(result.searchedWipes, [0, 8398]);
    Assert.deepEqual(test.calls.filter(call => call.url.includes('/stats/'))
        .map(call => call.config.params.wipe), [0, 8398]);
});

Test('recent resolution leaves multiple all-time identities ambiguous for manual review', async t => {
    const test = harness(t, {
        httpClient: {
            get: async (url, config) => {
                test.calls.push({ url, config });
                if (url.endsWith('/servers')) return { data: catalog() };
                if (url.includes('/wipes/')) return { data: wipes([
                    { ID: 8500, start_date: '2026-10-06T13:56:05.000Z',
                        end_date: '2026-10-09T13:56:00.000Z' },
                    ...wipes()
                ]) };
                if (config.params.wipe !== 'all-time') return { data: stats([], { total: 0 }) };
                return { data: stats([
                    statsRow({ player: { steam_64_ID: '76561198784468196', name: 'FUNTIK' } }),
                    statsRow({ player: { ID: 502, steam_64_ID: '76561199137754751', name: 'funtik' } })
                ], { total: 2 }) };
            }
        }
    });
    test.setNow('2026-10-06T16:00:00.000Z');

    const result = await test.provider.resolvePlayerRecent(null, { battlemetricsId: '42' }, 'FUNTIK');

    Assert.equal(result.available, true);
    Assert.equal(result.ambiguous, true);
    Assert.equal(result.player, null);
    Assert.equal(result.candidates.length, 2);
    Assert.deepEqual(result.searchedWipes, [0, 8467, 'all-time']);
});

Test('current-wipe pages are bounded, deterministic and expose a resumable cursor', async t => {
    const rows = Array.from({ length: 100 }, (_, index) => statsRow({
        player: {
            ID: 1000 + index,
            steam_64_ID: `${76561198000000000n + BigInt(index)}`,
            name: `Player ${index}`,
            rank: index + 1
        }
    }));
    const test = harness(t, {
        httpClient: {
            get: async (url, config) => {
                test.calls.push({ url, config });
                return { data: url.endsWith('/servers') ? catalog() : stats(rows, { total: 150 }) };
            }
        }
    });

    const page = await test.provider.scanCurrentWipePage(null, { battlemetricsId: '42' }, 1);

    Assert.equal(page.available, true);
    Assert.equal(page.rows.length, 100);
    Assert.equal(page.complete, false);
    Assert.equal(page.nextPage, 2);
    Assert.deepEqual(test.calls[1].config.params, {
        limit: 100,
        wipe: 0,
        category_ID: 1,
        sort_direction: 'DESC',
        sort_key: 'playtime',
        page: 1
    });
    Assert.equal((await test.provider.scanCurrentWipePage(null, { battlemetricsId: '42' }, 0)).reason,
        'invalid page');
});

Test('stats parser merges Steam aliases and selection never picks an ambiguous name', () => {
    const sameSteamAlias = statsRow({ player: { name: '[WB] Psype' } });
    const parsedAliases = WarBandits.parseStatsPayload(stats([statsRow(), sameSteamAlias]));
    const aliasSelection = WarBandits.selectPlayer(parsedAliases.rows, '[WB] Psype');
    Assert.equal(aliasSelection.player.steamId, '76561198154738095');
    Assert.deepEqual(aliasSelection.player.aliases, ['Psype', '[WB] Psype']);

    const secondSteam = statsRow({
        player: { ID: 502, steam_64_ID: '76561199179453915', name: 'Psype' }
    });
    const parsedAmbiguous = WarBandits.parseStatsPayload(stats([statsRow(), secondSteam]));
    const ambiguous = WarBandits.selectPlayer(parsedAmbiguous.rows, 'Psype');
    Assert.equal(ambiguous.player, null);
    Assert.equal(ambiguous.ambiguous, true);
    Assert.equal(ambiguous.candidates.length, 2);
    Assert.equal(WarBandits.selectPlayer(parsedAmbiguous.rows, '76561199179453915')
        .player.warBanditsPlayerId, '502');
});

Test('429 persists Retry-After cooldown and performs no retry, including after restart', async t => {
    let requests = 0;
    const test = harness(t, {
        httpClient: {
            get: async () => {
                requests += 1;
                const error = new Error('rate limited');
                error.response = { status: 429, headers: { 'retry-after': '120' } };
                throw error;
            }
        }
    });

    const first = await test.provider.ensureServerCatalog();
    Assert.equal(first.available, false);
    Assert.equal(first.reason, 'cooldown');
    Assert.equal(requests, 1);
    const persisted = JSON.parse(Fs.readFileSync(Path.join(test.dataDirectory, 'servers.json'), 'utf8'));
    Assert.equal(persisted.cooldownUntil, '2026-09-10T12:02:00.000Z');

    let restartedRequests = 0;
    const restarted = WarBandits.createProvider({
        dataDirectory: test.dataDirectory,
        requestGapMs: 0,
        now: () => new Date('2026-09-10T12:01:00.000Z'),
        httpClient: { get: async () => { restartedRequests += 1; throw new Error('unexpected'); } }
    });
    const blocked = await restarted.ensureServerCatalog();
    Assert.equal(blocked.reason, 'cooldown');
    Assert.equal(restartedRequests, 0);
});

Test('a stats 429 blocks every other request key until Retry-After expires', async t => {
    let requests = 0;
    const test = harness(t, {
        httpClient: {
            get: async url => {
                requests += 1;
                if (url.endsWith('/servers')) return { data: catalog() };
                const error = new Error('rate limited');
                error.response = { status: 429, headers: { 'retry-after': '120' } };
                throw error;
            }
        }
    });

    const first = await test.provider.resolvePlayer(null, { battlemetricsId: '42' }, 'First');
    Assert.equal(first.reason, 'cooldown');
    Assert.equal(requests, 2);
    const second = await test.provider.resolvePlayer(null, { battlemetricsId: '42' }, 'Another key');
    Assert.equal(second.reason, 'cooldown');
    Assert.equal(requests, 2);
});

Test('HTTP 200 Cloudflare HTML creates a conservative persistent cooldown without retry', async t => {
    let requests = 0;
    const test = harness(t, {
        cloudflareCooldownMs: 60000,
        httpClient: {
            get: async () => {
                requests += 1;
                return {
                    status: 200,
                    headers: { server: 'cloudflare', 'cf-ray': 'test', 'content-type': 'text/html' },
                    data: '<!doctype html><title>challenge</title>'
                };
            }
        }
    });

    const result = await test.provider.ensureServerCatalog();
    Assert.equal(result.reason, 'cooldown');
    Assert.equal(requests, 1);
    const cache = JSON.parse(Fs.readFileSync(Path.join(test.dataDirectory, 'servers.json'), 'utf8'));
    Assert.equal(cache.cooldownUntil, '2026-09-10T12:01:00.000Z');
});

Test('ordinary JSON errors behind Cloudflare are not misclassified as a challenge', async t => {
    let requests = 0;
    const test = harness(t, {
        httpClient: {
            get: async () => {
                requests += 1;
                const error = new Error('upstream failure');
                error.response = {
                    status: 500,
                    headers: {
                        server: 'cloudflare',
                        'cf-ray': 'test',
                        'content-type': 'application/json'
                    },
                    data: { error: 'failed' }
                };
                throw error;
            }
        }
    });

    const result = await test.provider.ensureServerCatalog();

    Assert.equal(result.reason, 'request failed');
    Assert.equal(requests, 1);
    Assert.equal(Fs.existsSync(Path.join(test.dataDirectory, 'servers.json')), false);
});

Test('a truncated name result is cached as candidates but never accepted as unique proof', async t => {
    const test = harness(t, {
        httpClient: {
            get: async url => ({
                data: url.endsWith('/servers') ? catalog() : stats([statsRow()], { total: 2 })
            })
        }
    });

    const result = await test.provider.resolvePlayer(null, { battlemetricsId: '42' }, 'Psype');

    Assert.equal(result.available, true);
    Assert.equal(result.truncated, true);
    Assert.equal(result.ambiguous, true);
    Assert.equal(result.player, null);
    Assert.equal(result.candidates.length, 1);
});

Test('player resolution persists a baseline then activity deltas without inferring presence', async t => {
    let playtime = 600;
    let kills = 10;
    let statsRequests = 0;
    const test = harness(t, {
        catalogTtlMs: 3600000,
        statsTtlMs: 1000,
        httpClient: {
            get: async url => {
                if (url.endsWith('/servers')) return { data: catalog() };
                statsRequests += 1;
                return { data: stats([statsRow({
                    player: { playtime },
                    stats: [{ ID: 1, name: 'kills', amount: kills }]
                })]) };
            }
        }
    });
    const context = { guildId: 'guild', client: { battlemetricsInstances: {} } };
    const scope = { battlemetricsId: '42', serverIp: 'eu5xnbp.warbandits.gg' };

    const baseline = await test.provider.resolvePlayer(context, scope, 'Psype');
    Assert.equal(statsRequests, 1);
    Assert.equal(baseline.available, true);

    const sidecarPath = Path.join(test.dataDirectory, 'guild-eu5xnobps.json');
    const baselineText = Fs.readFileSync(sidecarPath, 'utf8');
    Assert.equal(baselineText.endsWith('\n'), true);
    Assert.equal(baselineText.includes('\r'), false);
    const baselineSidecar = JSON.parse(baselineText);
    Assert.equal(baselineSidecar.players.length, 1);
    Assert.equal(baselineSidecar.players[0].identity.steamId, '76561198154738095');
    Assert.equal(baselineSidecar.players[0].stats.playtime, 600);
    Assert.deepEqual(baselineSidecar.players[0].activity.deltas, []);
    Assert.equal(baselineSidecar.players[0].activity.lastActivityAt, null);
    Assert.equal(baselineSidecar.players[0].presence.source, 'battlemetrics');
    Assert.equal(baselineSidecar.players[0].presence.status, 'unknown');
    Assert.deepEqual(baselineSidecar.lastResolution.candidateSteamIds,
        ['76561198154738095']);

    playtime = 660;
    kills = 12;
    test.advance(1001);
    const [changed, coalesced] = await Promise.all([
        test.provider.resolvePlayer(context, scope, 'Psype'),
        test.provider.resolvePlayer(context, scope, 'Psype')
    ]);
    Assert.equal(statsRequests, 2);
    Assert.equal(changed.available, true);
    Assert.strictEqual(changed, coalesced);
    const changedSidecar = JSON.parse(Fs.readFileSync(sidecarPath, 'utf8'));
    Assert.deepEqual(changedSidecar.players[0].activity.deltas, [
        { key: 'playtime', amount: 60 },
        { key: 'stat:1', amount: 2 }
    ]);
    Assert.equal(changedSidecar.players[0].activity.lastActivityAt,
        '2026-09-10T12:00:01.001Z');
    Assert.equal(changedSidecar.players[0].presence.status, 'unknown');
    Assert.equal(changedSidecar.players[0].presence.lastKnownStatus, null);
});

Test('link is request-free and BattleMetrics alone can provide online status', async t => {
    const test = harness(t);
    const scope = { battlemetricsId: '42', serverIp: 'eu5xnbp.warbandits.gg' };
    const battlemetrics = {
        lastUpdateSuccessful: true,
        streamerMode: false,
        players: { 1001: { status: true, logoutDate: null } }
    };
    const context = {
        guildId: 'guild',
        client: { battlemetricsInstances: { 42: battlemetrics } }
    };
    await test.provider.resolvePlayer(context, scope, 'Psype');
    const callsBeforeLink = test.calls.length;

    const linked = test.provider.linkBattlemetricsPlayer(context, scope, {
        steamId: '76561198154738095', battlemetricsPlayerId: '1001', name: 'Psype'
    });
    Assert.equal(linked.available, true);
    Assert.equal(linked.identity.battlemetricsPlayerId, '1001');
    Assert.equal(linked.presence.source, 'battlemetrics');
    Assert.equal(linked.presence.status, 'online');
    Assert.equal(test.calls.length, callsBeforeLink);

    battlemetrics.lastUpdateSuccessful = false;
    battlemetrics.players[1001].status = false;
    test.advance(1000);
    const unreliable = test.provider.linkBattlemetricsPlayer(context, scope, {
        steamId: '76561198154738095', battlemetricsPlayerId: '1001', name: 'Psype'
    });
    Assert.equal(unreliable.available, true);
    Assert.equal(unreliable.presence.status, 'unknown');
    Assert.equal(unreliable.presence.lastKnownStatus, 'online');
    Assert.equal(test.calls.length, callsBeforeLink);

    const wrongIdentity = test.provider.linkBattlemetricsPlayer(context, scope, {
        steamId: '76561198154738095', battlemetricsPlayerId: '9999', name: 'Someone else'
    });
    Assert.equal(wrongIdentity.available, false);
    Assert.equal(wrongIdentity.reason, 'identity name mismatch');
    Assert.equal(test.calls.length, callsBeforeLink);

    const sidecar = JSON.parse(Fs.readFileSync(
        Path.join(test.dataDirectory, 'guild-eu5xnobps.json'), 'utf8'));
    Assert.equal(sidecar.players[0].identity.battlemetricsPlayerId, '1001');
    Assert.equal(sidecar.players[0].presence.status, 'unknown');
});

Test('public provider API has no periodic WarBandits hook', () => {
    const provider = WarBandits.createProvider({ enabled: false });
    Assert.equal('onBattlemetricsUpdated' in WarBandits, false);
    Assert.equal('onBattlemetricsUpdated' in provider, false);
    Assert.deepEqual(Object.keys(provider).sort(), [
        'ensureServerCatalog', 'getRecentWipes', 'linkBattlemetricsPlayer', 'resolvePlayer',
        'resolvePlayerRecent', 'scanCurrentWipePage'
    ]);
});
