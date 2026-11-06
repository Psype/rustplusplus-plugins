'use strict';

const Assert = require('node:assert/strict');
const Test = require('node:test');

const SteamCommunity = require('../src/util/steamCommunityBan.js');

const STEAM_A = '76561198357380276';

function profile(contents) {
    return `<!doctype html><html><head><title>Steam Community :: Test</title></head>` +
        `<body class="profile_page"><div class="profile_header">${contents}</div></body></html>`;
}

Test('public Steam profile parser projects game bans, age and persona without a key', () => {
    const parsed = SteamCommunity.parseProfileHtml(profile([
        '<span class="actual_persona_name">H&#39; &amp; friend</span>',
        '<div class="profile_ban_status">',
        '<div class="profile_ban">1 game ban on record</div>',
        '<div class="profile_ban">0 days since last ban</div>',
        '</div>'
    ].join('')), STEAM_A);

    Assert.deepEqual(parsed, {
        steamId: STEAM_A,
        profileUrl: `https://steamcommunity.com/profiles/${STEAM_A}/`,
        steamName: "H' & friend",
        numberOfGameBans: 1,
        numberOfVacBans: 0,
        vacBanned: false,
        daysSinceLastBan: 0,
        source: 'steam-community-public-profile'
    });
});

Test('a valid public profile without a ban component is a clean projected result', () => {
    const parsed = SteamCommunity.parseProfileHtml(profile(
        '<span class="actual_persona_name">Clean</span>'), STEAM_A);
    Assert.equal(parsed.numberOfGameBans, 0);
    Assert.equal(parsed.numberOfVacBans, 0);
    Assert.equal(parsed.daysSinceLastBan, null);
    Assert.throws(() => SteamCommunity.parseProfileHtml(`<html>${'challenge'.repeat(20)}</html>`, STEAM_A), /markers/u);
});

Test('keyless Steam Community client uses one bounded English public profile request', async () => {
    const calls = [];
    const client = SteamCommunity.createClient({
        httpClient: { get: async (url, config) => {
            calls.push({ url, config });
            return { status: 200, data: profile([
                '<span class="actual_persona_name">Public</span>',
                '<div class="profile_ban_status"><div>2 VAC bans on record</div>',
                '<div>1 game ban on record</div><div>4 days since last ban</div></div>'
            ].join('')) };
        } }
    });
    const result = await client.getPlayerBan(STEAM_A);

    Assert.equal(result.numberOfGameBans, 1);
    Assert.equal(result.numberOfVacBans, 2);
    Assert.equal(calls.length, 1);
    Assert.equal(calls[0].url, `https://steamcommunity.com/profiles/${STEAM_A}/`);
    Assert.deepEqual(calls[0].config.params, { l: 'english' });
    Assert.equal(calls[0].config.maxRedirects, 0);
    Assert.equal('key' in calls[0].config.params, false);
});

Test('client follows one same-origin numeric-to-vanity redirect and rejects every external redirect', async () => {
    const calls = [];
    const client = SteamCommunity.createClient({
        httpClient: { get: async (url, config) => {
            calls.push({ url, config });
            if (calls.length === 1) {
                const error = new Error('redirect');
                error.response = { status: 302,
                    headers: { location: 'https://steamcommunity.com/id/handcamonmyyt/?l=english' } };
                throw error;
            }
            return { status: 200, data: profile('<span class="actual_persona_name">Vanity</span>') };
        } }
    });
    const result = await client.getPlayerBan(STEAM_A);
    Assert.equal(result.steamName, 'Vanity');
    Assert.equal(calls.length, 2);
    Assert.equal(calls[1].url, 'https://steamcommunity.com/id/handcamonmyyt/?l=english');
    Assert.equal(calls[1].config.maxRedirects, 0);
    Assert.equal(calls[1].config.params, undefined);

    const unsafe = SteamCommunity.createClient({ httpClient: { get: async () => {
        const error = new Error('redirect');
        error.response = { status: 302, headers: { location: 'https://example.com/id/stolen/' } };
        throw error;
    } } });
    await Assert.rejects(() => unsafe.getPlayerBan(STEAM_A), /unsafe profile redirect/u);
});
