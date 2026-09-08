const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Test = require('node:test');

const Database = require('../src/plugins/teammateLanguageDatabase/index.js');

const rustplus = Object.freeze({ guildId: 'test-language-list', serverId: 'test-server' });
const dataDir = Path.join(__dirname, '..', 'data', 'teammate-language-database');
const csvPath = Path.join(dataDir, 'test-language-list-test-server.csv');

Test.beforeEach(() => {
    if (Fs.existsSync(csvPath)) Fs.unlinkSync(csvPath);
});

Test.after(() => {
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
