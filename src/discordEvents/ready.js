/*
    Copyright (C) 2022 Alexander Emanuelsson (alexemanuelol)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

    https://github.com/alexemanuelol/rustplusplus

*/

const Discord = require('discord.js');
const Path = require('path');

const BattlemetricsHandler = require('../handlers/battlemetricsHandler.js');
const Config = require('../../config');
const SyncRustplusDiscordState = require('../util/SyncRustplusDiscordState.js');
const SerialLoop = require('../util/serialLoop.js');

module.exports = {
    name: 'ready',
    once: true,
    async execute(client) {
        for (const guild of client.guilds.cache) {
            try {
                if (!client.getInstance(guild[0])) require('../util/CreateInstanceFile')(client, guild[1]);
                require('../util/CreateCredentialsFile')(client, guild[1]);
                client.fcmListenersLite[guild[0]] ??= new Object();
                client.loadGuildIntl(guild[0]);
            }
            catch (error) {
                client.log('GUILD STARTUP', `Guild ${guild[0]} local setup failed safely: ${error}`, 'error');
            }
        }
        client.log(client.intlGet(null, 'infoCap'), client.intlGet(null, 'loggedInAs', {
            name: client.user.tag
        }));

        try {
            await client.user.setUsername(Config.discord.username);
        }
        catch (e) {
            client.log(client.intlGet(null, 'warningCap'), client.intlGet(null, 'ignoreSetUsername'));
        }

        try {
            await client.user.setAvatar(Path.join(__dirname, '..', 'resources/images/rustplusplus_logo.png'));
        }
        catch (e) {
            client.log(client.intlGet(null, 'warningCap'), client.intlGet(null, 'ignoreSetAvatar'));
        }

        client.user.setPresence({
            activities: [{ name: '/help', type: Discord.ActivityType.Listening }],
            status: 'online'
        });

        client.uptimeBot = new Date();

        for (let guildArray of client.guilds.cache) {
            const guild = guildArray[1];
            try {
                try {
                    await guild.members.me.setNickname(Config.discord.username);
                }
                catch (e) {
                    client.log(client.intlGet(null, 'warningCap'), client.intlGet(null, 'ignoreSetNickname'));
                }
                await client.syncCredentialsWithUsers(guild);
                await client.setupGuild(guild);

                const rustplus = client.rustplusInstances[guild.id];
                if (rustplus && rustplus.isOperational) {
                    await SyncRustplusDiscordState.synchronize(client, rustplus);
                }
            }
            catch (error) {
                client.log('GUILD STARTUP', `Guild ${guild.id} setup failed safely: ${error}`, 'error');
            }
        }

        if (Config.battlemetrics.token !== '') {
            try {
                await client.updateBattlemetricsInstances();
                await BattlemetricsHandler.handler(client, true);
            }
            catch (error) {
                client.log('BATTLEMETRICS', `Initial cycle failed safely: ${error}`, 'warn');
            }
            if (client.battlemetricsLoop && typeof client.battlemetricsLoop.stop === 'function') {
                client.battlemetricsLoop.stop();
            }
            client.battlemetricsLoop = SerialLoop.create({
                name: 'battlemetrics',
                intervalMs: 60000,
                task: () => BattlemetricsHandler.handler(client, false),
                onError: error => client.log('BATTLEMETRICS',
                    `Polling cycle failed safely: ${error.message}`, 'warn')
            });
            client.battlemetricsLoop.start(false);
            client.battlemetricsIntervalId = client.battlemetricsLoop;
        }

        client.createRustplusInstancesFromConfig();
    },
};
