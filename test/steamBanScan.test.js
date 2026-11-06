'use strict';

const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Test = require('node:test');

const Exporter = require('../src/util/steamBanExport.js');
const Scanner = require('../src/util/steamBanScan.js');

const STEAM_A = '76561198357380276';
const STEAM_B = '76561198154738095';
const STEAM_C = '76561199059717330';

function identity(steamId, rank) {
    return Object.freeze({
        priorityRank: rank,
        steamId,
        profileUrl: `https://steamcommunity.com/profiles/${steamId}/`,
        localDisplayName: steamId === STEAM_A ? "H' local" : steamId === STEAM_B ? 'Other' : 'Third',
        currentSteamName: null,
        verifiedAliases: Object.freeze([steamId === STEAM_A ? "H' local" :
            steamId === STEAM_B ? 'Other' : 'Third']),
        battlemetricsPlayerIds: Object.freeze([]),
        serverKeys: Object.freeze(['warbandits:eu5xnobps']),
        serverCount: 1,
        wipeCount: rank === 1 ? 3 : 1,
        observationCount: rank === 1 ? 8 : 1,
        identityObservationCount: rank === 1 ? 8 : 1,
        confirmedClanSnapshotCount: 0,
        firstObservedAt: '2026-01-01T00:00:00.000Z',
        lastObservedAt: '2026-11-06T00:00:00.000Z',
        warBanditsHoursMax: rank === 1 ? 250.5 : 1,
        warBanditsByServer: Object.freeze([{ serverKey: 'eu5xnobps', hours: rank === 1 ? 250.5 : 1,
            observedAt: '2026-11-06T00:00:00.000Z' }]),
        warBanditsRank: rank,
        warBanditsPlayerId: `${rank}`
    });
}

Test('slow keyless scanner resumes by SteamID and scans one public profile at a time', async t => {
    const output = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-ban-scan-'));
    t.after(() => Fs.rmSync(output, { recursive: true, force: true }));
    await Exporter.writeIdentitySnapshot([identity(STEAM_A, 1), identity(STEAM_B, 2)], {
        outputDirectory: output,
        source: 'test',
        sourceRoot: 'test',
        now: () => new Date('2026-11-06T00:00:00.000Z')
    });
    const calls = { profiles: 0 };
    const client = {
        getPlayerBan: async id => {
            calls.profiles += 1;
            return {
                steamId: id,
                profileUrl: `https://steamcommunity.com/profiles/${id}/`,
                steamName: id === STEAM_A ? "H'" : null,
                vacBanned: false,
                numberOfVacBans: 0,
                daysSinceLastBan: id === STEAM_A ? 0 : null,
                numberOfGameBans: id === STEAM_A ? 1 : 0,
                source: 'steam-community-public-profile'
            };
        }
    };
    const options = {
        outputDirectory: output,
        client,
        days: 5,
        delayMs: 1000,
        restart: true,
        sleep: async () => undefined,
        nowMs: () => 0,
        now: () => new Date('2026-11-06T12:00:00.000Z'),
        onMatch: value => matches.push(value.steamId)
    };
    const matches = [];
    const first = await Scanner.scan(options);
    Assert.equal(first.completed, true);
    Assert.equal(first.matches, 1);
    Assert.deepEqual(calls, { profiles: 2 });
    Assert.deepEqual(matches, [STEAM_A]);
    const report = Fs.readFileSync(first.reportCsv, 'utf8');
    Assert.match(report, new RegExp(STEAM_A, 'u'));
    Assert.match(report, /250\.5/u);
    Assert.match(report, /steam-community-public-profile/u);

    const resumed = await Scanner.scan({ ...options, restart: false, delayMs: 2000 });
    Assert.equal(resumed.matches, 1);
    Assert.deepEqual(calls, { profiles: 2 });
    Assert.deepEqual(matches, [STEAM_A]);

    await Exporter.writeIdentitySnapshot([
        identity(STEAM_A, 1), identity(STEAM_B, 2), identity(STEAM_C, 3)
    ], {
        outputDirectory: output,
        source: 'extended-test',
        sourceRoot: 'test',
        now: () => new Date('2026-11-06T00:00:01.000Z')
    });
    const extended = await Scanner.scan({ ...options, restart: false });
    Assert.equal(extended.total, 3);
    Assert.equal(extended.checked, 3);
    Assert.equal(extended.matches, 1);
    Assert.deepEqual(calls, { profiles: 3 });
    Assert.deepEqual(matches, [STEAM_A]);

    const forced = await Scanner.scan({ ...options, restart: false, force: true });
    Assert.equal(forced.matches, 1);
    Assert.notEqual(forced.runId, extended.runId);
    Assert.deepEqual(calls, { profiles: 6 });
    Assert.deepEqual(matches, [STEAM_A, STEAM_A]);
});

Test('report labels displayed Steam recency instead of claiming an exact game-ban date', () => {
    const rows = [identity(STEAM_A, 1)];
    const results = new Map([[STEAM_A, {
        steamId: STEAM_A,
        checkedAt: '2026-11-06T12:00:00.000Z',
        daysSinceLastBan: 4,
        numberOfGameBans: 1,
        numberOfVacBans: 1,
        vacBanned: true,
        steamName: null,
        profileUrl: rows[0].profileUrl,
        source: 'steam-community-public-profile'
    }]]);
    const match = Scanner.buildMatches(rows, results, 5)[0];
    Assert.equal(match.approximateLastBanDate, '2026-11-02');
    Assert.match(match.recencyBasis, /public Steam profile/u);
    Assert.equal(Scanner.buildMatches(rows, new Map([[STEAM_A, {
        ...results.get(STEAM_A), daysSinceLastBan: 5
    }]]), 5).length, 0);
});

Test('Steam 429 retries honor Retry-After and expose only bounded retry metadata', async () => {
    const sleeps = [];
    const retries = [];
    let calls = 0;
    const result = await Scanner.withRetries(async () => {
        calls += 1;
        if (calls === 1) {
            throw new (require('../src/util/steamCommunityBan.js').SteamCommunityError)(
                'Steam Community returned HTTP 429.',
                429, 2000);
        }
        return 'ok';
    }, {
        attempts: 5,
        sleep: async milliseconds => sleeps.push(milliseconds),
        onRetry: value => retries.push(value)
    });

    Assert.equal(result, 'ok');
    Assert.equal(calls, 2);
    Assert.deepEqual(sleeps, [2000]);
    Assert.deepEqual(retries, [{ attempt: 1, delayMs: 2000, status: 429 }]);
});
