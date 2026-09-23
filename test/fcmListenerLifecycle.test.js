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
    receiver.emit('disconnect');
    Assert.equal(state.status, 'reconnecting');
    Assert.ok(logs.some(entry => String(entry[1]).includes('MCS login accepted')));
    Assert.ok(logs.some(entry => String(entry[1]).includes('receiver reconnect scheduled')));
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
