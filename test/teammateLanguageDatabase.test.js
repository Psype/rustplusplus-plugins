const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Test = require('node:test');

const Database = require('../src/plugins/teammateLanguageDatabase/index.js');

const rustplus = Object.freeze({ guildId: 'test-language-list', serverId: 'test-server' });
const dataDir = Path.join(__dirname, '..', 'data', 'teammate-language-database');
const csvPath = Path.join(dataDir, 'test-language-list-test-server.csv');

Test.beforeEach(() => {
    Database.resetRuntimeCachesForTests();
    if (Fs.existsSync(csvPath)) Fs.unlinkSync(csvPath);
});

Test.after(() => {
    Database.resetRuntimeCachesForTests();
    if (Fs.existsSync(csvPath)) Fs.unlinkSync(csvPath);
});

function writeRows(rows) {
    if (!Fs.existsSync(dataDir)) Fs.mkdirSync(dataDir, { recursive: true });
    Fs.writeFileSync(csvPath, `steamid,date,name,language\n${rows.join('\n')}\n`);
}

Test('loads semicolon-separated languages only from the most recently dated SteamID row', () => {
    writeRows([
        '76561199179453915,2026-07-08T13:25:09.214Z,嚴肅繃住,zh;en',
        '76561199179453915,2026-07-05T05:15:42.530Z,这就是我的宿命,zh',
        '76561199179453915,2026-07-07T13:52:49.886Z,嚴肅綁住,zh'
    ]);

    const languages = Database.getKnownLanguages(rustplus, '76561199179453915');
    const pseudonyms = Database.getKnownPseudonyms(rustplus, '76561199179453915');

    Assert.deepEqual(languages, ['zh', 'en']);
    Assert.equal(Object.isFrozen(languages), true);
    Assert.equal(pseudonyms.every(entry => entry.language === 'zh;en'), true);
    Assert.equal(Fs.readFileSync(csvPath, 'utf8').trim().split('\n')[1].split(',').length, 4);
});

Test('automatic observations preserve the languages from the latest row', async () => {
    writeRows([
        '76561198000000002,2026-07-08T13:25:09.214Z,Current Name,fr',
        '76561198000000002,2026-07-05T05:15:42.530Z,Old Name,zh'
    ]);

    await Database.recordTeamMessage(rustplus, {
        steamId: '76561198000000002', name: 'Current Name', message: 'go base'
    });
    Assert.deepEqual(Database.getKnownLanguages(rustplus, '76561198000000002'), ['fr']);

    const rows = Fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);
    Assert.equal(rows.at(-1).endsWith(',fr'), true);
});

Test('tracker identities migrate the CSV and log BattleMetrics/name changes without erasing languages', () => {
    writeRows([
        '76561198000000003,2026-09-20T10:00:00.000Z,First Name,fr;en'
    ]);

    Database.recordIdentity(rustplus, {
        steamId: '76561198000000003',
        battlemetricsPlayerId: '1001',
        name: 'First Name',
        observedAt: '2026-09-21T10:00:00.000Z'
    });
    Database.recordIdentity(rustplus, {
        steamId: '76561198000000003',
        battlemetricsPlayerId: '1001',
        name: 'First Name',
        observedAt: '2026-09-21T11:00:00.000Z'
    });
    Database.recordIdentity(rustplus, {
        steamId: '76561198000000003',
        battlemetricsPlayerId: '1001',
        name: 'Renamed Player',
        observedAt: '2026-09-22T10:00:00.000Z'
    });
    Database.recordIdentity(rustplus, {
        steamId: '76561198000000003',
        battlemetricsPlayerId: '1001',
        name: 'First Name',
        observedAt: '2026-09-23T10:00:00.000Z'
    });

    const lines = Fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    Assert.equal(lines[0], 'steamid,battlemetrics_id,date,name,language');
    const rows = lines.slice(1);
    Assert.equal(rows.length, 4, 'an unchanged consecutive identity must not duplicate a row');
    Assert.equal(rows[1],
        '76561198000000003,1001,2026-09-21T10:00:00.000Z,First Name,fr;en');
    Assert.equal(rows[2],
        '76561198000000003,1001,2026-09-22T10:00:00.000Z,Renamed Player,fr;en');
    Assert.equal(rows[3],
        '76561198000000003,1001,2026-09-23T10:00:00.000Z,First Name,fr;en');
    Assert.deepEqual(Database.getKnownLanguages(rustplus, '76561198000000003'), ['fr', 'en']);
});

Test('tracker-only identities may keep an empty language column', () => {
    Database.recordIdentity(rustplus, {
        steamId: '76561198000000004',
        battlemetricsPlayerId: '1002',
        name: 'Tracked Enemy',
        observedAt: '2026-09-24T10:00:00.000Z'
    });

    const lines = Fs.readFileSync(csvPath, 'utf8').trimEnd().split('\n');
    Assert.equal(lines[0], 'steamid,battlemetrics_id,date,name,language');
    Assert.equal(lines[1],
        '76561198000000004,1002,2026-09-24T10:00:00.000Z,Tracked Enemy,');
    Assert.deepEqual(Database.getKnownLanguages(rustplus, '76561198000000004'), []);
});

Test('unchanged CSV reads reuse one bounded parsed view', () => {
    writeRows([
        '76561198000000005,2026-09-24T10:00:00.000Z,Cached Player,en'
    ]);
    const originalOpenSync = Fs.openSync;
    let reads = 0;
    Fs.openSync = function (...args) {
        if (Path.resolve(args[0].toString()) === Path.resolve(csvPath) && args[1] === 'r') reads += 1;
        return originalOpenSync.apply(this, args);
    };
    try {
        Assert.deepEqual(Database.getKnownLanguages(rustplus, '76561198000000005'), ['en']);
        Assert.deepEqual(Database.getKnownLanguages(rustplus, '76561198000000005'), ['en']);
        Assert.equal(Database.getKnownPseudonyms(rustplus, '76561198000000005')[0].name, 'Cached Player');
    }
    finally {
        Fs.openSync = originalOpenSync;
    }

    Assert.equal(reads, 1);
    const status = Database.getRuntimeCacheStatus();
    Assert.equal(status.rows, 1);
    Assert.equal(status.rowLimit, 16);
    Assert.equal(status.retainedRows, 1);
    Assert.equal(status.retainedRowLimit, Database.ROW_CACHE_MAX_ROWS);
    Assert.equal(status.bytes > 0 && status.bytes <= status.byteLimit, true);
});

Test('an external CSV modification invalidates the parsed view by file signature', () => {
    writeRows([
        '76561198000000006,2026-09-24T10:00:00.000Z,Old Name,fr'
    ]);
    Assert.deepEqual(Database.getKnownLanguages(rustplus, '76561198000000006'), ['fr']);

    const previous = Fs.statSync(csvPath);
    writeRows([
        '76561198000000006,2026-09-24T10:00:00.000Z,New Name,de'
    ]);
    const forcedMtime = new Date(previous.mtimeMs + 2000);
    Fs.utimesSync(csvPath, forcedMtime, forcedMtime);

    Assert.deepEqual(Database.getKnownLanguages(rustplus, '76561198000000006'), ['de']);
    Assert.deepEqual(Database.getKnownPseudonyms(rustplus, '76561198000000006')
        .map(entry => entry.name), ['New Name']);
});

Test('a local CSV write invalidates the prior parsed view immediately', () => {
    writeRows([
        '76561198000000007,2026-09-24T10:00:00.000Z,First Name,en'
    ]);
    const originalOpenSync = Fs.openSync;
    let reads = 0;
    Fs.openSync = function (...args) {
        if (Path.resolve(args[0].toString()) === Path.resolve(csvPath) && args[1] === 'r') reads += 1;
        return originalOpenSync.apply(this, args);
    };
    try {
        Assert.deepEqual(Database.getKnownLanguages(rustplus, '76561198000000007'), ['en']);
        Database.recordIdentity(rustplus, {
            steamId: '76561198000000007',
            battlemetricsPlayerId: '1007',
            name: 'Second Name',
            observedAt: '2026-09-25T10:00:00.000Z'
        });
        Assert.deepEqual(Database.getKnownPseudonyms(rustplus, '76561198000000007')
            .map(entry => entry.name), ['First Name', 'Second Name']);
    }
    finally {
        Fs.openSync = originalOpenSync;
    }

    Assert.equal(reads, 2, 'the first read after a local write must reload the durable CSV');
});

Test('identity projection can request only the most recently appended valid rows', () => {
    writeRows([
        '76561198000000001,2026-09-21T10:00:00.000Z,Oldest,en',
        'invalid,not-a-date,Ignored,en',
        '76561198000000002,2026-09-22T10:00:00.000Z,Middle,fr',
        '76561198000000003,2026-09-23T10:00:00.000Z,Newest,de'
    ]);

    let incomplete = 0;
    const rows = Database.getIdentityRows(rustplus, {
        limit: 2,
        onWarning: () => { incomplete += 1; }
    });
    Assert.deepEqual(rows.map(row => row.name), ['Newest', 'Middle']);
    Assert.equal(incomplete, 1);
    Assert.equal(Object.isFrozen(rows), true);
});

Test('an oversized CSV is rejected before opening and optional lookups degrade without changing it', () => {
    if (!Fs.existsSync(dataDir)) Fs.mkdirSync(dataDir, { recursive: true });
    Fs.writeFileSync(csvPath, '');
    Fs.truncateSync(csvPath, Database.CSV_FILE_MAX_BYTES + 1);
    const originalOpenSync = Fs.openSync;
    let opens = 0;
    const warnings = [];
    const completenessSignals = [];
    const loggingRustplus = { ...rustplus, log: (...values) => warnings.push(values) };
    Fs.openSync = function (...args) {
        if (Path.resolve(args[0].toString()) === Path.resolve(csvPath)) opens += 1;
        return originalOpenSync.apply(this, args);
    };
    try {
        Assert.deepEqual(Database.getIdentityRows(loggingRustplus, {
            limit: 1, onWarning: message => completenessSignals.push(message)
        }), []);
        Assert.deepEqual(Database.getIdentityRows(loggingRustplus, {
            limit: 1, onWarning: message => completenessSignals.push(message)
        }), []);
        Assert.deepEqual(Database.getKnownLanguages(loggingRustplus, '76561198000000001'), []);
        Assert.equal(Database.recordIdentity(loggingRustplus, {
            steamId: '76561198000000001', name: 'Must Not Replace Durable Data',
            observedAt: '2026-10-11T12:00:00.000Z'
        }), undefined);
    }
    finally {
        Fs.openSync = originalOpenSync;
    }
    Assert.equal(opens, 0);
    Assert.equal(completenessSignals.length, 2,
        'each optional read must signal incompleteness even while fallback logs are deduplicated');
    Assert.equal(warnings.length, 1, 'the same bounded failure should warn once per TTL');
    Assert.match(warnings[0][1], /IDENTITY_CSV_TOO_LARGE/u);
    Assert.equal(Fs.statSync(csvPath).size, Database.CSV_FILE_MAX_BYTES + 1);
});

Test('excessive physical rows are rejected before parsing and remain untouched', () => {
    if (!Fs.existsSync(dataDir)) Fs.mkdirSync(dataDir, { recursive: true });
    const contents = `steamid,date,name,language\n${'x\n'.repeat(Database.CSV_FILE_MAX_ROWS + 1)}`;
    Fs.writeFileSync(csvPath, contents);

    Assert.deepEqual(Database.getIdentityRows(rustplus, { limit: 1 }), []);
    Assert.deepEqual(Database.getKnownPseudonyms(rustplus, '76561198000000001'), []);
    Assert.equal(Fs.readFileSync(csvPath, 'utf8'), contents);
});

Test('optional identity callers degrade and signal every generic I/O failure without writing', () => {
    const originalStatSync = Fs.statSync;
    const completenessSignals = [];
    const warnings = [];
    const loggingRustplus = { ...rustplus, log: (...values) => warnings.push(values) };
    Fs.statSync = function (...args) {
        if (Path.resolve(args[0].toString()) === Path.resolve(csvPath)) {
            throw Object.assign(new Error('simulated identity CSV I/O failure'), { code: 'EIO' });
        }
        return originalStatSync.apply(this, args);
    };
    try {
        Assert.deepEqual(Database.getIdentityRows(loggingRustplus, {
            limit: 1, onWarning: message => completenessSignals.push(message)
        }), []);
        Assert.deepEqual(Database.getIdentityRows(loggingRustplus, {
            limit: 1, onWarning: message => completenessSignals.push(message)
        }), []);
        Assert.deepEqual(Database.getKnownPseudonyms(loggingRustplus, '76561198000000001'), []);
        Assert.equal(Database.recordIdentity(loggingRustplus, {
            steamId: '76561198000000001', name: 'Must Not Be Written'
        }), undefined);
    }
    finally {
        Fs.statSync = originalStatSync;
    }

    Assert.equal(completenessSignals.length, 2);
    Assert.equal(warnings.length, 1);
    Assert.match(warnings[0][1], /EIO/u);
    Assert.equal(Fs.existsSync(csvPath), false);
});
