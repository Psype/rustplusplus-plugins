const Assert = require('node:assert/strict');
const Test = require('node:test');

const RaidAlarm = require('../src/plugins/raidAlarm');

function createContext({ notifyInGame = true, title = RaidAlarm.DEFAULT_TITLE,
    message = 'wall.external.high.stone destroyed at H14' } = {}) {
    const calls = [];
    const logs = [];
    const serverId = '127.0.0.1-28082';
    const instance = {
        channelId: { activity: 'activity' },
        generalSettings: { smartAlarmNotifyInGame: notifyInGame },
        serverList: { [serverId]: {} }
    };
    const rustplus = {
        serverId,
        sendInGameMessage: async text => calls.push(Object.freeze({ output: 'in-game', text }))
    };
    const client = {
        getInstance: () => instance,
        intlGet: (_guildId, key, variables = {}) => {
            if (key === 'baseIsUnderAttack') return 'Base under attack';
            if (key === 'raidAlarmDestroyedAt') return `${variables.item} @ ${variables.location}`;
            if (key === 'infoCap') return 'INFO';
            return key;
        },
        log: (...args) => logs.push(Object.freeze(args)),
        rustplusInstances: { guild: rustplus }
    };

    return {
        calls,
        context: {
            client,
            guild: { id: 'guild' },
            channelId: 'alarm',
            title,
            message,
            body: { ip: '127.0.0.1', port: 28082, img: '' }
        },
        logs
    };
}

Test('uMod Raid Alarm queues in-game before an isolated Discord failure', async () => {
    const fixture = createContext();
    const handled = await RaidAlarm.handleFcmAlarm(fixture.context, {
        sendDiscord: async () => {
            fixture.calls.push(Object.freeze({ output: 'discord' }));
            throw new Error('deterministic Discord failure');
        }
    });

    Assert.equal(handled, true);
    Assert.deepEqual(fixture.calls.map(call => call.output), ['in-game', 'discord']);
    Assert.equal(fixture.calls[0].text, 'Base under attack: wall.external.high.stone @ H14');
    Assert.equal(fixture.logs.some(log => String(log[1]).includes('raid-alarm.discord')), true);
});

Test('uMod Raid Alarm honors the in-game Smart Alarm output setting without a vanilla entity', async () => {
    const fixture = createContext({ notifyInGame: false });
    const handled = await RaidAlarm.handleFcmAlarm(fixture.context, {
        sendDiscord: async () => fixture.calls.push(Object.freeze({ output: 'discord' }))
    });

    Assert.equal(handled, true);
    Assert.deepEqual(fixture.calls.map(call => call.output), ['discord']);
});

Test('uMod Raid Alarm recognizes its canonical body when the title is customized', () => {
    const fixture = createContext({ title: 'ALERTE RAID' });
    Assert.equal(RaidAlarm.matches(fixture.context), true);
    Assert.equal(RaidAlarm.matches({ ...fixture.context, message: 'unrelated alarm' }), false);
});
