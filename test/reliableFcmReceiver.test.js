const Assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Test = require('node:test');

const ReliableFcmReceiver = require('../src/util/reliableFcmReceiver.js');
const FcmAlarmRouter = require('../src/util/fcmAlarmRouter.js');
const InGameChatHandler = require('../src/handlers/inGameChatHandler.js');
const {
    kMCSVersion,
    kHeartbeatPingTag,
    kHeartbeatAckTag,
    kLoginRequestTag,
    kLoginResponseTag,
    kIqStanzaTag,
    kDataMessageStanzaTag
} = require('@liamcottle/push-receiver/src/constants');

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.destroyed = false;
        this.writable = true;
        this.writes = [];
    }

    setKeepAlive() {}

    write(buffer) {
        this.writes.push(Buffer.from(buffer));
        return true;
    }

    destroy() {
        this.destroyed = true;
        this.writable = false;
    }
}

class FakeParser extends EventEmitter {
    destroy() {
        this.destroyed = true;
    }
}

class FakeScheduler {
    constructor() {
        this.time = 0;
        this.sequence = 0;
        this.tasks = new Map();
    }

    setTimeout(callback, delay) {
        return this._add(callback, delay, null);
    }

    clearTimeout(id) {
        this.tasks.delete(id);
    }

    setInterval(callback, delay) {
        return this._add(callback, delay, delay);
    }

    clearInterval(id) {
        this.tasks.delete(id);
    }

    advance(milliseconds) {
        const target = this.time + milliseconds;
        while (true) {
            const next = [...this.tasks.entries()]
                .filter(([, task]) => task.at <= target)
                .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
            if (!next) break;

            const [id, task] = next;
            this.time = task.at;
            if (task.interval === null) this.tasks.delete(id);
            else task.at += task.interval;
            task.callback();
        }
        this.time = target;
    }

    _add(callback, delay, interval) {
        const id = ++this.sequence;
        this.tasks.set(id, { callback, at: this.time + delay, interval });
        return id;
    }
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Timed out waiting for test state');
}

async function createConnectedReceiver(overrides = {}) {
    const sockets = [];
    const parsers = [];
    const receiver = new ReliableFcmReceiver('123456789', '987654321', [], {
        checkIn: async () => ({}),
        socketFactory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        parserFactory: () => {
            const parser = new FakeParser();
            parsers.push(parser);
            return parser;
        },
        endpoints: [{ host: 'mcs.test', port: 5228 }],
        ...overrides
    });

    const connecting = receiver.connect();
    await waitFor(() => sockets.length === 1);
    sockets[0].emit('secureConnect');
    Assert.equal(sockets[0].writes[0][0], kMCSVersion);
    Assert.equal(sockets[0].writes[0][1], kLoginRequestTag);
    parsers[0].emit('message', { tag: kLoginResponseTag, object: { id: 'test' } });
    await connecting;
    return { receiver, sockets, parsers };
}

Test('FCM receiver becomes ready only after an accepted MCS login', async () => {
    const sockets = [];
    const parsers = [];
    let readyCount = 0;
    const receiver = new ReliableFcmReceiver('123456789', '987654321', [], {
        checkIn: async () => ({}),
        socketFactory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        parserFactory: () => {
            const parser = new FakeParser();
            parsers.push(parser);
            return parser;
        },
        endpoints: [{ host: 'mcs.test', port: 5228 }]
    });
    receiver.on('connect', () => { readyCount += 1; });

    let settled = false;
    const connecting = receiver.connect().then(() => { settled = true; });
    await waitFor(() => sockets.length === 1);
    sockets[0].emit('secureConnect');
    await new Promise(resolve => setImmediate(resolve));
    Assert.equal(settled, false);
    Assert.equal(readyCount, 0);

    parsers[0].emit('message', { tag: kLoginResponseTag, object: { id: 'test' } });
    await connecting;
    Assert.equal(settled, true);
    Assert.equal(readyCount, 1);
    receiver.destroy();
});

Test('FCM receiver answers server heartbeats and acknowledges every data message', async () => {
    const { receiver, sockets, parsers } = await createConnectedReceiver();
    const received = [];
    receiver.on('ON_DATA_RECEIVED', message => received.push(message));

    parsers[0].emit('message', { tag: kHeartbeatPingTag, object: { status: '1' } });
    Assert.equal(sockets[0].writes.at(-1)[0], kHeartbeatAckTag);

    const notification = {
        persistentId: 'notification-1',
        from: 'sender',
        category: 'com.facepunch.rust.companion',
        appData: [{ key: 'channelId', value: 'alarm' }]
    };
    parsers[0].emit('message', { tag: kDataMessageStanzaTag, object: notification });
    Assert.equal(received.length, 1);
    Assert.equal(received[0], notification);
    Assert.equal(sockets[0].writes.at(-1)[0], kIqStanzaTag);

    parsers[0].emit('message', { tag: kDataMessageStanzaTag, object: notification });
    Assert.equal(received.length, 1, 'duplicate persistent IDs must not be delivered twice');
    Assert.equal(sockets[0].writes.at(-1)[0], kIqStanzaTag, 'duplicates still require a stream ACK');
    receiver.destroy();
});

Test('MCS alarm data reaches the acknowledged Rust team-chat boundary end to end', async () => {
    const { receiver, parsers } = await createConnectedReceiver();
    const sent = [];
    const serverId = '185.29.166.79-28083';
    const instance = {
        channelId: { activity: 'activity' },
        generalSettings: { smartAlarmNotifyInGame: true, muteInGameBotMessages: false },
        serverList: { [serverId]: {} }
    };
    const client = {
        getInstance: () => instance,
        intlGet: (_guildId, key, variables = {}) => {
            if (key === 'messageCap') return 'MESSAGE';
            if (key === 'baseIsUnderAttack') return 'Base under attack';
            if (key === 'raidAlarmDestroyedAt') {
                return `${variables.item} destroyed at ${variables.location}`;
            }
            return key;
        },
        log: () => {},
        rustplusInstances: {}
    };
    const rustplus = {
        guildId: 'guild',
        serverId,
        team: { allOffline: true },
        generalSettings: { commandDelay: '3600', trademark: 'SHOWING', muteInGameBotMessages: false },
        messagesSentByBot: [],
        updateBotMessages(message) { this.messagesSentByBot.unshift(message); },
        sendTeamMessageAsync: async message => {
            sent.push(message);
            return { success: {} };
        },
        log: () => {},
        sendCriticalInGameMessage(message) {
            return InGameChatHandler.sendCriticalMessage(this, client, message);
        }
    };
    client.rustplusInstances.guild = rustplus;
    receiver.on('ON_DATA_RECEIVED', data => {
        void FcmAlarmRouter.handle(client, { id: 'guild' }, 'steam', data, {
            raidAlarmAdapters: { deduplicate: false, sendDiscord: async () => {} }
        });
    });

    parsers[0].emit('message', {
        tag: kDataMessageStanzaTag,
        object: {
            persistentId: 'raid-1',
            from: 'sender',
            category: 'com.facepunch.rust.companion',
            appData: [
                { key: 'channelId', value: 'alarm' },
                { key: 'title', value: "You're getting raided!" },
                { key: 'message', value: 'Stone Wall destroyed at H14' },
                { key: 'body', value: JSON.stringify({
                    ip: '185.29.166.79', port: 28083, type: 'alarm'
                }) }
            ]
        }
    });
    await waitFor(() => sent.length === 1);

    Assert.deepEqual(sent, [
        '[BOT] :exclamation: :poggers: GETTING RAIDED: Stone Wall destroyed at H14  ' +
        ':oldmanlaugh: :exclamation:'
    ]);
    receiver.destroy();
});

Test('FCM receiver treats a missing heartbeat acknowledgement as a dead connection', async () => {
    const scheduler = new FakeScheduler();
    const { receiver, sockets, parsers } = await createConnectedReceiver({
        scheduler,
        heartbeatIntervalMs: 100,
        heartbeatAckTimeoutMs: 50,
        inactivityTimeoutMs: 1000,
        reconnectMaxDelayMs: 10
    });
    const disconnects = [];
    receiver.on('disconnect', error => disconnects.push(error));

    scheduler.advance(100);
    Assert.equal(sockets[0].writes.at(-1)[0], kHeartbeatPingTag);
    scheduler.advance(50);

    Assert.equal(disconnects.length, 1);
    Assert.match(disconnects[0].message, /heartbeat acknowledgement timed out/);
    Assert.equal(sockets[0].destroyed, true);

    let reconnected = false;
    receiver.once('connect', () => { reconnected = true; });
    scheduler.advance(10);
    await waitFor(() => sockets.length === 2);
    sockets[1].emit('secureConnect');
    parsers[1].emit('message', { tag: kLoginResponseTag, object: { id: 'reconnected' } });
    await waitFor(() => reconnected);
    Assert.equal(sockets[1].destroyed, false);
    receiver.destroy();
});

Test('FCM receiver rejects an explicit MCS authentication failure without fallback retries', async () => {
    const sockets = [];
    const parsers = [];
    const receiver = new ReliableFcmReceiver('123456789', '987654321', [], {
        checkIn: async () => ({}),
        socketFactory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        parserFactory: () => {
            const parser = new FakeParser();
            parsers.push(parser);
            return parser;
        }
    });

    const connecting = receiver.connect();
    await waitFor(() => sockets.length === 1);
    sockets[0].emit('secureConnect');
    parsers[0].emit('message', {
        tag: kLoginResponseTag,
        object: { error: { code: 401, message: 'authentication failed' } }
    });

    await Assert.rejects(connecting, /MCS login rejected: authentication failed/);
    Assert.equal(sockets.length, 1);
    receiver.destroy();
});
