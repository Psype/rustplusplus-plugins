const Assert = require('node:assert/strict');
const Test = require('node:test');

let notFoundNotifications = 0;
let alarmUpdates = 0;
const discordMessagesPath = require.resolve('../src/discordTools/discordMessages.js');
require.cache[discordMessagesPath] = {
    exports: {
        sendSmartAlarmNotFoundMessage: async () => { notFoundNotifications += 1; },
        sendSmartAlarmMessage: async () => { alarmUpdates += 1; }
    }
};
const SmartAlarmHandler = require('../src/handlers/smartAlarmHandler.js');

Test('an unreachable entity is reported once while silent probes continue', async () => {
    notFoundNotifications = 0;
    alarmUpdates = 0;
    const validationOptions = [];
    const serverId = '127.0.0.1-28082';
    const instance = {
        serverList: {
            [serverId]: {
                alarms: {
                    42: { name: 'Old alarm', reachable: true }
                }
            }
        }
    };
    const client = {
        getInstance: () => instance,
        setInstance: () => undefined
    };
    const rustplus = {
        guildId: 'guild',
        serverId,
        smartAlarmIntervalCounter: 29,
        getEntityInfoAsync: async () => ({ error: 'not_found' }),
        isResponseValid: async (_response, options) => {
            validationOptions.push(Object.freeze({ ...options }));
            return false;
        }
    };

    await SmartAlarmHandler.handler(rustplus, client);
    rustplus.smartAlarmIntervalCounter = 29;
    await SmartAlarmHandler.handler(rustplus, client);

    Assert.deepEqual(validationOptions, [{
        logError: true,
        context: 'Smart Alarm Old alarm (42)'
    }, {
        logError: false,
        context: 'Smart Alarm Old alarm (42)'
    }]);
    Assert.equal(notFoundNotifications, 1);
    Assert.equal(alarmUpdates, 1);
});
