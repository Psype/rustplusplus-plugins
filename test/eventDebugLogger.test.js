const Assert = require('assert');
const Fs = require('fs');
const Os = require('os');
const Path = require('path');
const Test = require('node:test');

const EventDebugLogger = require('../src/util/eventDebugLogger.js');

Test('raw FCM capture writes the untouched decoded envelope as LF JSONL', t => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'rpp-fcm-log-'));
    const path = Path.join(directory, 'fcm.jsonl');
    t.after(() => Fs.rmSync(directory, { recursive: true, force: true }));
    const logs = [];
    const payload = {
        persistentId: 'persistent-1',
        appData: [
            { key: 'channelId', value: 'alarm' },
            { key: 'body', value: '{"type":"alarm","ip":"127.0.0.1","port":28082}' }
        ],
        rawBytes: Buffer.from([0, 10, 255]),
        sent: 42n
    };

    const written = EventDebugLogger.logFcmPayload(
        { log: (...args) => logs.push(args) },
        { source: 'FCM Host', guildId: 'guild', steamId: '76561190000000000' },
        payload,
        {
            path,
            isEnabled: () => true,
            now: () => new Date('2026-09-24T12:34:56.000Z')
        }
    );

    Assert.equal(written, true);
    const raw = Fs.readFileSync(path, 'utf8');
    Assert.equal(raw.endsWith('\n'), true);
    Assert.equal(raw.includes('\r'), false);
    const record = JSON.parse(raw.trimEnd());
    Assert.equal(record.timestamp, '2026-09-24T12:34:56.000Z');
    Assert.equal(record.source, 'FCM Host');
    Assert.equal(record.payload.persistentId, payload.persistentId);
    Assert.deepEqual(record.payload.appData, payload.appData);
    Assert.deepEqual(record.payload.rawBytes, { type: 'Buffer', data: [0, 10, 255] });
    Assert.equal(record.payload.sent, '42');
    Assert.deepEqual(logs, []);
});

Test('disabled or failed raw FCM capture cannot interrupt notification delivery', () => {
    const logs = [];
    const client = { log: (...args) => logs.push(args) };
    const identity = { source: 'FCM LITE', guildId: 'guild', steamId: 'steam' };
    const filesystem = {
        mkdirSync: () => undefined,
        appendFileSync: () => { throw new Error('disk full'); }
    };

    Assert.equal(EventDebugLogger.logFcmPayload(client, identity, {}, {
        isEnabled: () => false,
        filesystem
    }), false);
    Assert.deepEqual(logs, []);

    Assert.equal(EventDebugLogger.logFcmPayload(client, identity, {}, {
        isEnabled: () => true,
        filesystem
    }), false);
    Assert.equal(logs.length, 1);
    Assert.equal(logs[0][0], 'DEBUG');
    Assert.equal(logs[0][2], 'warn');
});
