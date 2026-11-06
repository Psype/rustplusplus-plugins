'use strict';

const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Leaderboard = require('../src/util/warBanditsLeaderboard.js');

function row(index) {
    return {
        player: {
            ID: 1000 + index,
            steam_64_ID: `${76561198000000000n + BigInt(index)}`,
            name: `Player ${index}`,
            rank: index + 1,
            playtime: 500 - index
        },
        stats: [{ ID: 1, name: 'kills', amount: 1000 - index }]
    };
}

Test('WarBandits top export fetches only the bounded all-time rank pages slowly', async () => {
    const calls = [];
    const sleeps = [];
    const httpClient = {
        get: async (url, config) => {
            calls.push({ url, config });
            const offset = (config.params.page - 1) * 25;
            return { data: { code: 200, stats: Array.from({ length: 25 }, (_, index) => row(offset + index)),
                utils: { total: 100000 } } };
        }
    };
    const result = await Leaderboard.fetchLeaderboard({
        server: 'eu5xnobps',
        top: 60,
        delayMs: 5000,
        httpClient,
        sleep: async milliseconds => { sleeps.push(milliseconds); },
        now: () => new Date('2026-11-06T00:00:00.000Z')
    });

    Assert.equal(calls.length, 3);
    Assert.deepEqual(sleeps, [5000, 5000]);
    Assert.deepEqual(calls[0].config.params, {
        limit: 25,
        wipe: 'all-time',
        category_ID: 1,
        sort_direction: 'DESC',
        sort_key: 'kills',
        page: 1
    });
    Assert.equal(result.rows.length, 60);
    Assert.equal(result.rows[0].warBanditsRank, 1);
    Assert.equal(result.rows[59].warBanditsRank, 60);
    Assert.equal(result.rows[0].observationCount, 1);
});

Test('extending a cached top fetches only the newly required leaderboard pages', async t => {
    const cacheDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-wb-rank-cache-'));
    t.after(() => Fs.rmSync(cacheDirectory, { recursive: true, force: true }));
    const calls = [];
    const httpClient = {
        get: async (url, config) => {
            calls.push(config.params.page);
            const offset = (config.params.page - 1) * 25;
            return { data: { code: 200, stats: Array.from({ length: 25 }, (_, index) => row(offset + index)),
                utils: { total: 100000 } } };
        }
    };
    const common = {
        server: 'eu5xnobps',
        delayMs: 1000,
        cacheDirectory,
        cacheMaxAgeMs: 24 * 60 * 60 * 1000,
        httpClient,
        sleep: async () => undefined,
        now: () => new Date('2026-11-06T00:00:00.000Z')
    };
    const first = await Leaderboard.fetchLeaderboard({ ...common, top: 50 });
    const secondPages = [];
    const second = await Leaderboard.fetchLeaderboard({ ...common, top: 75,
        onPage: value => secondPages.push([value.page, value.cached]) });

    Assert.equal(first.rows.length, 50);
    Assert.equal(second.rows.length, 75);
    Assert.deepEqual(calls, [1, 2, 3]);
    Assert.deepEqual(secondPages, [[1, true], [2, true], [3, false]]);

    const forcedPages = [];
    await Leaderboard.fetchLeaderboard({ ...common, top: 50, force: true,
        onPage: value => forcedPages.push([value.page, value.cached]) });
    Assert.deepEqual(calls, [1, 2, 3, 1, 2]);
    Assert.deepEqual(forcedPages, [[1, false], [2, false]]);
});

Test('WarBandits 429 honors Retry-After and retries only the unfinished page', async () => {
    let currentMs = Date.parse('2026-11-06T00:00:00.000Z');
    let calls = 0;
    const sleeps = [];
    const retries = [];
    const result = await Leaderboard.fetchLeaderboard({
        server: 'eu5xnobps',
        top: 1,
        delayMs: 5000,
        httpClient: {
            get: async () => {
                calls += 1;
                if (calls === 1) {
                    const error = new Error('rate limited');
                    error.response = { status: 429, headers: { 'retry-after': '2' } };
                    throw error;
                }
                return { data: { code: 200, stats: Array.from({ length: 25 }, (_, index) => row(index)),
                    utils: { total: 100000 } } };
            }
        },
        sleep: async milliseconds => { sleeps.push(milliseconds); currentMs += milliseconds; },
        now: () => new Date(currentMs),
        onRetry: value => retries.push(value)
    });

    Assert.equal(result.rows.length, 1);
    Assert.equal(calls, 2);
    Assert.deepEqual(sleeps, [2000, 3000]);
    Assert.deepEqual(retries, [{ page: 1, attempt: 1, delayMs: 2000, status: 429 }]);
});
