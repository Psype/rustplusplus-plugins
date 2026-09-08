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

const DiscordMessages = require('../discordTools/discordMessages.js');
const PluginManager = require('../plugins/pluginManager.js');

module.exports = async function (rustplus, client, message, translationDependencies = {}) {
    const originalRelay = Promise.resolve()
        .then(() => DiscordMessages.sendTeamChatMessage(rustplus.guildId, message))
        .catch(error => rustplus.log('AUTOTRANSLATE', `Discord source relay: ${error}`, 'warning'));

    const translation = await PluginManager.translateTeamMessage({
        rustplus, client, message, translationDependencies
    });
    if (translation) {
        const translatedMessage = `[→${translation.target}] ${translation.translated}`;
        await rustplus.sendInGameMessage(translatedMessage);
        await originalRelay;
        await Promise.resolve().then(() => DiscordMessages.sendTeamChatMessage(rustplus.guildId, {
            ...message,
            message: translatedMessage
        })).catch(error => rustplus.log('AUTOTRANSLATE', `Discord translation relay: ${error}`, 'warning'));
        return;
    }

    await originalRelay;
}
