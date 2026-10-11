const Assert = require('node:assert/strict');
const Test = require('node:test');

const PlayerScanIpc = require('../src/workers/playerScanIpc.js');

function targetHarness() {
    const messages = [];
    const target = {
        connected: true,
        exitCode: 0,
        stderr: { write: () => undefined },
        send: (message, callback) => {
            messages.push(message);
            callback(null);
            return true;
        },
        disconnect: () => { target.connected = false; }
    };
    return { messages, target };
}

Test('bounded JSON sizing matches JSON.stringify for valid scan-plan data', () => {
    const value = {
        text: 'ASCII \" slash \\ accents é emoji 🕷 control\n',
        values: [null, true, false, 0, -12.5, Number.NaN],
        nested: { value: 'ok' }
    };
    const expected = Buffer.byteLength(JSON.stringify(value));
    Assert.equal(PlayerScanIpc.boundedJsonByteLength(value, expected), expected);
    Assert.throws(() => PlayerScanIpc.boundedJsonByteLength(value, expected - 1), /byte limit/u);
});

Test('oversized or unsafe worker plans become a small PLAN_TOO_LARGE failure', () => {
    const oversized = targetHarness();
    const sparseEvents = new Array(Math.floor(PlayerScanIpc.MAX_PLAN_BYTES / 2) + 1);
    PlayerScanIpc.sendPlan(oversized.target, { events: sparseEvents });
    Assert.deepEqual(oversized.messages, [{ v: 1, type: 'failure', code: 'PLAN_TOO_LARGE',
        message: 'Player scan worker plan exceeded its limit.' }]);
    Assert.equal(Object.hasOwn(oversized.messages[0], 'plan'), false);

    let getterReads = 0;
    const unsafePlan = {};
    Object.defineProperty(unsafePlan, 'events', { enumerable: true, get: () => {
        getterReads += 1;
        return [];
    } });
    const unsafe = targetHarness();
    PlayerScanIpc.sendPlan(unsafe.target, unsafePlan);
    Assert.equal(getterReads, 0);
    Assert.equal(unsafe.messages[0].type, 'failure');
    Assert.equal(unsafe.messages[0].code, 'PLAN_TOO_LARGE');
});

Test('bounded worker plans retain the normal final result envelope', () => {
    const value = targetHarness();
    const plan = { protocolVersion: 3, events: [], state: null };
    PlayerScanIpc.sendPlan(value.target, plan);
    Assert.deepEqual(value.messages, [{ v: 1, type: 'result', plan }]);
});
