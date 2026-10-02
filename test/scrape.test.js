const Assert = require('node:assert/strict');
const Test = require('node:test');

const Constants = require('../src/util/constants.js');
const Scrape = require('../src/util/scrape.js');

function client(logs) {
    return {
        intlGet: (_guildId, key, variables = {}) => `${key}:${variables.link || ''}`,
        log: (...args) => logs.push(args)
    };
}

Test('Steam avatar uses the Rust Companion redirect without scraping profile HTML', async () => {
    const original = Scrape.scrape;
    Scrape.scrape = async () => { throw new Error('must not be called'); };
    try {
        Assert.equal(await Scrape.scrapeSteamProfilePicture(client([]), '76561198154738095'),
            `${Constants.RUSTPLUS_AVATAR_URL}76561198154738095`);
        Assert.equal(await Scrape.scrapeSteamProfilePicture(client([]), 'invalid'), null);
    }
    finally {
        Scrape.scrape = original;
    }
});

Test('Steam name lookup uses the bounded XML endpoint and decodes the persona name', async () => {
    const original = Scrape.scrape;
    const calls = [];
    Scrape.scrape = async url => {
        calls.push(url);
        return { status: 200, data: '<profile><steamID><![CDATA[Tom &amp; Jerry]]></steamID></profile>' };
    };
    try {
        Assert.equal(await Scrape.scrapeSteamProfileName(client([]), '76561199237622442'), 'Tom & Jerry');
        Assert.deepEqual(calls, [`${Constants.STEAM_PROFILES_URL}76561199237622442?xml=1`]);
    }
    finally {
        Scrape.scrape = original;
    }
});

Test('external Steam name failure degrades to one warning instead of repeated errors', async () => {
    const original = Scrape.scrape;
    const logs = [];
    let calls = 0;
    Scrape.scrape = async () => {
        calls += 1;
        return { status: 429 };
    };
    try {
        Assert.equal(await Scrape.scrapeSteamProfileName(client(logs), '76561199237622443'), null);
        Assert.equal(await Scrape.scrapeSteamProfileName(client(logs), '76561199237622443'), null);
        Assert.equal(logs.length, 1);
        Assert.equal(logs[0][2], 'warn');
        Assert.equal(calls, 1);
    }
    finally {
        Scrape.scrape = original;
    }
});

Test('a transient Steam profile failure expires after thirty seconds without an automatic retry', async () => {
    const originalScrape = Scrape.scrape;
    const originalNow = Date.now;
    const logs = [];
    let calls = 0;
    let now = 1_800_000_000_000;
    Date.now = () => now;
    Scrape.scrape = async () => {
        calls += 1;
        return { status: 503 };
    };
    try {
        Assert.equal(await Scrape.scrapeSteamProfileName(client(logs), '76561199237622444'), null);
        Assert.equal(await Scrape.scrapeSteamProfileName(client(logs), '76561199237622444'), null);
        Assert.equal(calls, 1);
        now += 30_001;
        Assert.equal(await Scrape.scrapeSteamProfileName(client(logs), '76561199237622444'), null);
        Assert.equal(calls, 2);
        Assert.equal(logs.length, 1);
    }
    finally {
        Date.now = originalNow;
        Scrape.scrape = originalScrape;
    }
});
