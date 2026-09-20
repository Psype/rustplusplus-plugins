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
        generalSettings: { muteInGameBotMessages: false },
        team: { allOffline: false },
        sendCriticalInGameMessage: async text => calls.push(Object.freeze({ output: 'in-game', text }))
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
        deduplicate: false,
        sendDiscord: async () => {
            fixture.calls.push(Object.freeze({ output: 'discord' }));
            throw new Error('deterministic Discord failure');
        }
    });

    Assert.equal(handled, true);
    Assert.deepEqual(fixture.calls.map(call => call.output), ['in-game', 'discord']);
    Assert.equal(fixture.calls[0].text, 'Base under attack: wall.external.high.stone @ H14');
    const failureLog = fixture.logs.find(log => String(log[1]).includes('raid-alarm.discord'));
    Assert.ok(failureLog);
    Assert.equal(failureLog[2], 'warn');
});

Test('uMod Raid Alarm honors the in-game Smart Alarm output setting without a vanilla entity', async () => {
    const fixture = createContext({ notifyInGame: false });
    const handled = await RaidAlarm.handleFcmAlarm(fixture.context, {
        deduplicate: false,
        sendDiscord: async () => fixture.calls.push(Object.freeze({ output: 'discord' }))
    });

    Assert.equal(handled, true);
    Assert.deepEqual(fixture.calls.map(call => call.output), ['discord']);
});

Test('every SmartAlarm-channel notification is accepted despite a custom payload', () => {
    const fixture = createContext({ title: 'ALERTE RAID' });
    Assert.equal(RaidAlarm.matches(fixture.context), true);
    Assert.equal(RaidAlarm.matches({ ...fixture.context, message: 'unrelated alarm' }), true);
    Assert.equal(RaidAlarm.matches({ ...fixture.context, channelId: 'team' }), false);
});

Test('custom raid title variants are recognized and localized', () => {
    for (const title of ['Getting raided!', 'you are getting raided', 'YOU’RE GETTING RAIDED!']) {
        const fixture = createContext({ title, message: 'custom WarBandits payload' });
        Assert.equal(RaidAlarm.matches(fixture.context), true);
        Assert.deepEqual(RaidAlarm.getText(fixture.context.client, 'guild', title, fixture.context.message), {
            title: 'Base under attack',
            message: 'custom WarBandits payload'
        });
    }
});

Test('a stale all-offline projection cannot suppress a critical raid alert', async () => {
    const fixture = createContext();
    fixture.context.client.rustplusInstances.guild.team.allOffline = true;

    await RaidAlarm.handleFcmAlarm(fixture.context, {
        deduplicate: false,
        sendDiscord: async () => fixture.calls.push(Object.freeze({ output: 'discord' }))
    });

    Assert.deepEqual(fixture.calls.map(call => call.output), ['in-game', 'discord']);
    Assert.ok(fixture.logs.some(log => String(log[1]).includes('delivered for')));
});

Test('duplicate FCM delivery from multiple registered accounts emits one alert', async () => {
    const fixture = createContext({ message: 'duplicate wall destroyed at H14' });
    const adapters = {
        now: () => 1000,
        sendDiscord: async () => fixture.calls.push(Object.freeze({ output: 'discord' }))
    };

    await RaidAlarm.handleFcmAlarm(fixture.context, adapters);
    await RaidAlarm.handleFcmAlarm({ ...fixture.context, hoster: 'second-account' }, adapters);

    Assert.deepEqual(fixture.calls.map(call => call.output), ['in-game', 'discord']);
    Assert.ok(fixture.logs.some(log => String(log[1]).includes('raid-alarm.duplicate')));
});

Test('raidtest uses the same critical in-game route', async () => {
    const fixture = createContext();
    const response = await RaidAlarm.handleCommand({
        source: 'inGame',
        client: fixture.context.client,
        rustplus: fixture.context.client.rustplusInstances.guild,
        guildId: 'guild',
        command: '!raidtest',
        commandLowerCase: '!raidtest',
        prefix: '!'
    });

    Assert.equal(response.handled, true);
    Assert.equal(response.response, null);
    Assert.deepEqual(fixture.calls, [{ output: 'in-game', text: '[RAID TEST] Base under attack' }]);
});
