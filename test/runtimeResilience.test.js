const Assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Path = require('node:path');
const Test = require('node:test');

const AsyncEventBoundary = require('../src/util/asyncEventBoundary.js');
const ProcessSupervisor = require('../src/util/processSupervisor.js');
const SerialLoop = require('../src/util/serialLoop.js');

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.connected = true;
        this.sent = [];
        this.killed = false;
    }

    send(message, callback) {
        this.sent.push(message);
        if (callback) callback(null);
    }

    kill() {
        this.killed = true;
        this.connected = false;
        this.emit('exit', 1, null);
    }
}

Test('async event boundary observes rejections and sanitizes diagnostics', async () => {
    const reports = [];
    const result = await AsyncEventBoundary.run('discord.test', async () => {
        throw new Error('private\nerror');
    }, (label, error) => reports.push({ label, error }));

    Assert.equal(result, undefined);
    Assert.deepEqual(reports, [{ label: 'discord.test', error: 'Error: private error' }]);
});

Test('serial loop never overlaps work and resumes after a rejected cycle', async t => {
    SerialLoop.resetForTests();
    t.after(() => SerialLoop.resetForTests());
    const scheduled = [];
    const failures = [];
    let release;
    let calls = 0;
    const loop = SerialLoop.create({
        name: 'test-loop',
        intervalMs: 10,
        setTimeoutImpl: callback => {
            const timer = { callback, cleared: false, unref() {} };
            scheduled.push(timer);
            return timer;
        },
        clearTimeoutImpl: timer => { timer.cleared = true; },
        task: () => {
            calls += 1;
            if (calls === 1) return new Promise(resolve => { release = resolve; });
            throw new Error('cycle failed');
        },
        onError: error => failures.push(error.message)
    });

    Assert.equal(loop.start(true), true);
    scheduled.shift().callback();
    Assert.equal(loop.status().running, true);
    Assert.equal(loop.runNow(), false);
    Assert.equal(calls, 1);
    release();
    await flush();
    Assert.equal(loop.status().running, false);
    Assert.equal(scheduled.length, 1);
    scheduled.shift().callback();
    await flush();
    Assert.deepEqual(failures, ['cycle failed']);
    Assert.equal(loop.status().failures, 1);
    Assert.equal(loop.stop(), true);
});

Test('process supervisor serializes requests and contains a worker crash', async t => {
    const children = [];
    const supervisor = ProcessSupervisor.create({
        name: 'test-service',
        modulePath: 'worker.js',
        timeoutMs: 1000,
        maxQueue: 1,
        forkImpl: () => {
            const child = new FakeChild();
            children.push(child);
            return child;
        }
    });
    t.after(() => supervisor.stop());

    const first = supervisor.request('work', { value: 1 });
    const second = supervisor.request('work', { value: 2 });
    await Assert.rejects(() => supervisor.request('work', { value: 3 }), error => error.code === 'QUEUE_FULL');
    Assert.equal(children[0].sent.length, 1);
    children[0].emit('message', { v: 1, type: 'response', id: 1, ok: true, result: 'one' });
    Assert.equal(await first, 'one');
    await flush();
    Assert.equal(children[0].sent.length, 2);
    children[0].emit('exit', 1, null);
    await Assert.rejects(() => second, error => error.code === 'SERVICE_EXITED');

    const third = supervisor.request('work', { value: 4 });
    Assert.equal(children.length, 2);
    children[1].emit('message', { v: 1, type: 'response', id: 3, ok: true, result: 'four' });
    Assert.equal(await third, 'four');
    Assert.equal(supervisor.status().restarts, 1);
    Assert.equal(supervisor.status().completed, 2);
});

Test('Discord client error is logged without terminating the process', async () => {
    const event = require('../src/discordEvents/error.js');
    const logs = [];
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error('process.exit must not be called'); };
    try {
        await event.execute({
            intlGet: (_guildId, key) => key,
            log: (...values) => logs.push(values)
        }, new Error('gateway unavailable'));
    }
    finally {
        process.exit = originalExit;
    }
    Assert.equal(exitCalled, false);
    Assert.equal(logs.length, 1);
});

Test('real isolated worker crash and timeout stay inside the supervisor', async t => {
    const supervisor = ProcessSupervisor.create({
        name: 'fixture-service',
        modulePath: Path.join(__dirname, 'fixtures', 'isolatedServiceWorker.js'),
        timeoutMs: 2000,
        maxQueue: 1,
        maxOldSpaceMiB: 32
    });
    t.after(() => supervisor.stop());

    Assert.deepEqual(await supervisor.request('echo', { safe: true }), { safe: true });
    await Assert.rejects(() => supervisor.request('crash', {}), error => error.code === 'SERVICE_EXITED');
    await Assert.rejects(() => supervisor.request('hang', {}), error => error.code === 'SERVICE_TIMEOUT');
    Assert.equal(supervisor.status().restarts >= 2, true);
});
