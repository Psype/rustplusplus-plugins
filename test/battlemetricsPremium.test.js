const Assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');

const Battlemetrics = require('../src/plugins/battlemetrics');

const NOW = new Date('2026-09-10T12:00:00.000Z');

beforeEach(() => Battlemetrics.resetForTests());

test('BattleMetrics search is server-scoped, bounded and returns immutable candidates', async () => {
    let request;
    const httpClient = {
        get: async (url, options) => {
            request = { url, options };
            return {
                status: 200,
                data: {
                    data: [{
                        type: 'player',
                        id: '1001',
                        attributes: { name: 'Nirks' },
                        relationships: {
                            servers: { data: [{ id: '42', meta: { online: true, lastSeen: NOW.toISOString() } }] }
                        }
                    }]
                }
            };
        }
    };

    const result = await Battlemetrics.searchPlayers({ battlemetricsId: '42' }, 'Nirk', {
        token: 'private-token', httpClient, now: () => NOW
    });

    Assert.equal(result.available, true);
    Assert.deepEqual(result.candidates, [{
        playerId: '1001', name: 'Nirks', status: 'online',
        lastSeenAt: NOW.toISOString(), steamId: null
    }]);
    Assert.equal(Object.isFrozen(result), true);
    Assert.equal(Object.isFrozen(result.candidates[0]), true);
    Assert.equal(request.url, 'https://api.battlemetrics.com/players');
    Assert.equal(request.options.params['filter[servers]'], '42');
    Assert.equal(request.options.params['page[size]'], 10);
    Assert.equal(request.options.timeout, 5000);
    Assert.equal(request.options.maxRedirects, 0);
    Assert.equal(request.options.headers.Authorization, 'Bearer private-token');
});

test('BattleMetrics Premium parsers retain only current-server sessions and normalized co-players', async () => {
    const httpClient = {
        get: async url => {
            if (url.endsWith('/relationships/sessions')) {
                return {
                    status: 200,
                    data: {
                        data: [
                            {
                                type: 'session', id: 's1',
                                attributes: { start: '2026-09-10T10:00:00Z', stop: '2026-09-10T11:30:00Z' },
                                relationships: { player: { data: { id: '1001' } }, server: { data: { id: '42' } } }
                            },
                            {
                                type: 'session', id: 'elsewhere', attributes: { start: '2026-09-10T09:00:00Z' },
                                relationships: { player: { data: { id: '1001' } }, server: { data: { id: '99' } } }
                            },
                            {
                                type: 'session', id: '', attributes: { start: '2026-09-10T08:00:00Z' },
                                relationships: { player: { data: { id: '1001' } }, server: { data: { id: '42' } } }
                            }
                        ]
                    }
                };
            }
            return {
                status: 200,
                data: {
                    data: [{
                        type: 'coplay', id: 'cp1',
                        attributes: { timePlayed: 7200, count: 4 },
                        relationships: { player: { data: { id: '2001' } }, server: { data: { id: '42' } } }
                    }],
                    included: [{ type: 'player', id: '2001', attributes: { name: 'Enemy Ally' } }]
                }
            };
        }
    };
    const dependencies = { token: 'token', httpClient, now: () => NOW };

    const sessions = await Battlemetrics.getSessions('1001', '42', dependencies);
    const related = await Battlemetrics.getRelatedPlayers('1001', '42', dependencies);

    Assert.deepEqual(sessions.sessions, [{
        id: 's1', startAt: '2026-09-10T10:00:00.000Z', stopAt: '2026-09-10T11:30:00.000Z',
        durationSeconds: 5400
    }]);
    Assert.equal(Object.isFrozen(sessions.sessions), true);
    Assert.deepEqual(related.players, [{
        battlemetricsPlayerId: '2001', name: 'Enemy Ally', overlapSeconds: 7200, sessionCount: 4
    }]);
});

test('BattleMetrics 429 establishes a provider cooldown without a blind retry', async () => {
    let calls = 0;
    const httpClient = {
        get: async () => {
            calls += 1;
            const error = new Error('rate limit body must not escape');
            error.response = { status: 429, headers: { 'retry-after': '120' } };
            throw error;
        }
    };
    const dependencies = { token: 'token', httpClient, now: () => NOW };

    const first = await Battlemetrics.getServerPlayer('1001', '42', dependencies);
    const second = await Battlemetrics.getSessions('1001', '42', dependencies);

    Assert.equal(calls, 1);
    Assert.deepEqual(first, {
        available: false,
        reason: 'HTTP 429',
        status: 429,
        retryAt: '2026-09-10T12:02:00.000Z'
    });
    Assert.deepEqual(second, first);
    Assert.equal(JSON.stringify(first).includes('rate limit body'), false);
});

test('BattleMetrics server-player metadata is validated and normalized', async () => {
    const httpClient = {
        get: async () => ({
            status: 200,
            data: {
                data: {
                    type: 'playerServer', id: '1001',
                    attributes: {
                        name: 'Nirks', online: false, firstSeen: '2026-06-01T00:00:00Z',
                        lastSeen: '2026-09-09T22:00:00Z', timePlayed: 3633
                    }
                }
            }
        })
    };

    const result = await Battlemetrics.getServerPlayer('1001', '42', {
        token: 'token', httpClient, now: () => NOW
    });

    Assert.deepEqual(result.player, {
        battlemetricsPlayerId: '1001', battlemetricsServerId: '42', name: 'Nirks', online: false,
        firstSeenAt: '2026-06-01T00:00:00.000Z', lastSeenAt: '2026-09-09T22:00:00.000Z',
        timePlayedSeconds: 3633
    });
});
