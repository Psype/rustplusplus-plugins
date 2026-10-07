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

Test('Steam identity lookup returns the current persona separately from verified past aliases', async () => {
    const original = Scrape.scrape;
    const calls = [];
    Scrape.scrape = async url => {
        calls.push(url);
        if (url.endsWith('?xml=1')) {
            return { status: 200, data: '<profile><steamID><![CDATA[FUNTIK]]></steamID></profile>' };
        }
        return { status: 200, data: [
            { newname: '+=import&amp;**', timechanged: '6 Oct, 2026 @ 1:00pm' },
            { newname: 'gus', timechanged: '5 Oct, 2026 @ 1:00pm' },
            { newname: 'FUNTIK', timechanged: '4 Oct, 2026 @ 1:00pm' },
            { newname: 'gus', timechanged: '3 Oct, 2026 @ 1:00pm' }
        ] };
    };
    try {
        Assert.deepEqual(await Scrape.scrapeSteamProfileIdentity(client([]), '76561199237622445'), {
            steamId: '76561199237622445',
            currentName: 'FUNTIK',
            pastAliases: [
                { name: '+=import&**', timeChanged: '6 Oct, 2026 @ 1:00pm' },
                { name: 'gus', timeChanged: '5 Oct, 2026 @ 1:00pm' }
            ],
            aliasesComplete: true
        });
        Assert.deepEqual(calls.sort(), [
            `${Constants.STEAM_PROFILES_URL}76561199237622445?xml=1`,
            `${Constants.STEAM_PROFILES_URL}76561199237622445/ajaxaliases/`
        ].sort());
    }
    finally {
        Scrape.scrape = original;
    }
});

Test('Steam profile caches evict old derived entries at their fixed limits', async () => {
    const original = Scrape.scrape;
    Scrape.resetRuntimeCachesForTests();
    Scrape.scrape = async () => ({ status: 200, data: '<profile><steamID>bounded</steamID></profile>' });
    try {
        for (let index = 0; index < 1025; index += 1) {
            const steamId = (76561198000000000n + BigInt(index)).toString();
            Assert.equal(await Scrape.scrapeSteamProfileName(client([]), steamId), 'bounded');
        }
        const status = Scrape.getRuntimeCacheStatus();
        Assert.deepEqual(status, {
            profileNames: 1024,
            profileIdentities: 0,
            warnings: 0,
            profileLimit: 1024,
            warningLimit: 2048
        });
    }
    finally {
        Scrape.resetRuntimeCachesForTests();
        Scrape.scrape = original;
    }
});
