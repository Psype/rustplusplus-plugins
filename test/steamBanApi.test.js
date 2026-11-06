'use strict';

const Assert = require('node:assert/strict');
const Test = require('node:test');

const SteamBanApi = require('../src/util/steamBanApi.js');

const STEAM_A = '76561198357380276';
const STEAM_B = '76561198154738095';

Test('Steam ban responses are bounded and projected without unknown provider fields', () => {
    const projected = SteamBanApi.projectBanResponse({ players: [{
        SteamId: STEAM_A,
        CommunityBanned: false,
        VACBanned: false,
        NumberOfVACBans: 0,
        DaysSinceLastBan: 0,
        NumberOfGameBans: 1,
        EconomyBan: 'none',
        unexpected: 'ignored',
        bans: [{ AppIdMin: 252490, AppIdMax: 252490, BanStartTime: 1793910000,
            BanType: 2, BanProviderId: 0 }]
    }] }, [STEAM_A]);

    Assert.deepEqual(Object.keys(projected[0]), [
        'steamId', 'communityBanned', 'vacBanned', 'numberOfVacBans', 'daysSinceLastBan',
        'numberOfGameBans', 'economyBan', 'detailedBans'
    ]);
    Assert.equal(projected[0].numberOfGameBans, 1);
    Assert.equal(projected[0].detailedBans[0].appIdMin, 252490);
    Assert.throws(() => SteamBanApi.projectBanResponse({ players: [] }, [STEAM_A]), /omitted/u);
    Assert.throws(() => SteamBanApi.projectBanResponse({ players: [{
        SteamId: STEAM_B,
        CommunityBanned: false,
        VACBanned: false,
        NumberOfVACBans: 0,
        DaysSinceLastBan: 0,
        NumberOfGameBans: 0,
        EconomyBan: 'none'
    }] }, [STEAM_A]), /unexpected/u);
});

Test('Steam client batches bans and requests Rust playtime only through bounded endpoints', async () => {
    const calls = [];
    const httpClient = {
        get: async (url, config) => {
            calls.push({ url, config });
            if (url.includes('GetPlayerBans')) return { status: 200, data: { players: [{
                SteamId: STEAM_A,
                CommunityBanned: false,
                VACBanned: false,
                NumberOfVACBans: 0,
                DaysSinceLastBan: 0,
                NumberOfGameBans: 1,
                EconomyBan: 'none'
            }] } };
            if (url.includes('GetPlayerSummaries')) return { status: 200, data: { response: { players: [{
                steamid: STEAM_A,
                personaname: "H'",
                profileurl: `https://steamcommunity.com/profiles/${STEAM_A}/`,
                communityvisibilitystate: 1
            }] } } };
            return { status: 200, data: { response: { games: [{
                appid: SteamBanApi.RUST_APP_ID,
                playtime_forever: 12345
            }] } } };
        }
    };
    const client = SteamBanApi.createClient({ apiKey: 'secret', httpClient });
    Assert.equal((await client.getPlayerBans([STEAM_A]))[0].daysSinceLastBan, 0);
    Assert.equal((await client.getPlayerSummaries([STEAM_A]))[0].personaName, "H'");
    Assert.equal(await client.getRustPlaytimeMinutes(STEAM_A), 12345);
    Assert.equal(calls[0].config.params.key, 'secret');
    Assert.equal(calls[2].config.params['appids_filter[0]'], SteamBanApi.RUST_APP_ID);
    Assert.equal(calls.every(call => call.config.maxRedirects === 0), true);
});

Test('private owned-games responses produce unknown Rust playtime instead of failure', () => {
    Assert.equal(SteamBanApi.projectRustPlaytime({ response: {} }), null);
    Assert.equal(SteamBanApi.projectRustPlaytime({ response: { games: [] } }), null);
});
