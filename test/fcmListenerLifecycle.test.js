const Assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Test = require('node:test');

const FcmListenerLifecycle = require('../src/util/fcmListenerLifecycle.js');

class Receiver extends EventEmitter {
    constructor(connectImpl) {
        super();
        this.connectImpl = connectImpl;
        this.destroyed = false;
    }

    connect() {
        return this.connectImpl();
    }

    destroy() {
        this.destroyed = true;
    }
}

Test('FCM lifecycle exposes connected and reconnecting states', async () => {
    const logs = [];
    const receiver = new Receiver(async () => undefined);
    const client = { log: (...args) => logs.push(args) };
    const identity = { source: 'FCM Host', guildId: 'guild', steamId: 'steam' };

    const state = FcmListenerLifecycle.attach(receiver, client, identity);
    await FcmListenerLifecycle.connect(receiver, client, identity);
    receiver.emit('connect');
    Assert.equal(state.status, 'connected');
    FcmListenerLifecycle.markNotification(receiver, client, identity, {
        appData: [
            { key: 'channelId', value: 'alarm' },
            { key: 'title', value: 'Getting raided!' },
            { key: 'message', value: 'wall destroyed at H14' }
        ]
    });
    Assert.equal(state.notificationCount, 1);
    Assert.equal(state.alarmCount, 1);
    Assert.equal(state.lastChannelId, 'alarm');
    Assert.ok(state.lastNotificationAt);
    Assert.ok(state.lastAlarmAt);
    Assert.deepEqual(state.recentAlarms.map(alarm => [alarm.title, alarm.message]), [
        ['Getting raided!', 'wall destroyed at H14']
    ]);
    receiver.emit('disconnect');
    Assert.equal(state.status, 'reconnecting');
    Assert.ok(logs.some(entry => String(entry[1]).includes('MCS login accepted')));
    Assert.ok(logs.some(entry => String(entry[1]).includes('Facepunch push delivery verified')));
    Assert.ok(logs.some(entry => String(entry[1]).includes('receiver reconnect scheduled')));
});

Test('FCM lifecycle accepts object appData and only announces delivery proof once', () => {
    const logs = [];
    const receiver = new Receiver(async () => undefined);
    const client = { log: (...args) => logs.push(args) };
    const identity = { source: 'FCM Host', guildId: 'guild', steamId: 'steam' };
    const state = FcmListenerLifecycle.attach(receiver, client, identity);

    FcmListenerLifecycle.markNotification(receiver, client, identity, {
        appData: { channelId: 'PAIRING', body: { type: 'server' } }
    });
    FcmListenerLifecycle.markNotification(receiver, client, identity, {
        appData: { channelId: 'pairing', body: { type: 'entity' } }
    });
    FcmListenerLifecycle.markNotification(receiver, client, identity, {
        appData: { channelId: 'alarm' }
    });

    Assert.equal(state.notificationCount, 3);
    Assert.equal(state.lastChannelId, 'alarm');
    Assert.equal(state.serverPairingCount, 1);
    Assert.ok(state.lastServerPairingAt);
    Assert.equal(state.alarmCount, 1);
    Assert.equal(logs.filter(entry => String(entry[1]).includes('push delivery verified')).length, 1);
});

Test('FCM initial connection failure is visible and destroys the dead receiver', async () => {
    const logs = [];
    const receiver = new Receiver(async () => { throw new Error('check-in failed'); });
    const client = { log: (...args) => logs.push(args) };
    const identity = { source: 'FCM LITE', guildId: 'guild', steamId: 'steam' };
    const state = FcmListenerLifecycle.attach(receiver, client, identity);

    await Assert.rejects(FcmListenerLifecycle.connect(receiver, client, identity), /check-in failed/);

    Assert.equal(state.status, 'failed');
    Assert.equal(receiver.destroyed, true);
    Assert.ok(logs.some(entry => String(entry[1]).includes('initial connection failed')));
});
