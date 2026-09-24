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

const Axios = require('axios');

const Constants = require('../util/constants.js');
const Utils = require('../util/utils.js');

const REQUEST_TIMEOUT_MS = 5000;
const PROFILE_CACHE_MS = 60 * 60 * 1000;
const profileNameCache = new Map();
const warningCache = new Map();

function logWarningOnce(client, key, message) {
    const now = Date.now();
    const previous = warningCache.get(key) || 0;
    if (now - previous < PROFILE_CACHE_MS) return;
    warningCache.set(key, now);
    client.log(client.intlGet(null, 'warningCap'), message, 'warn');
}

module.exports = {
    scrape: async function (url) {
        try {
            return await Axios.get(url, {
                timeout: REQUEST_TIMEOUT_MS,
                maxContentLength: 512 * 1024,
                headers: { 'User-Agent': 'rustplusplus/1.22 (+Steam profile metadata)' }
            });
        }
        catch (e) {
            return {};
        }
    },

    scrapeSteamProfilePicture: async function (client, steamId) {
        if (!/^\d{17}$/.test(String(steamId))) return null;
        return `${Constants.RUSTPLUS_AVATAR_URL}${steamId}`;
    },

    scrapeSteamProfileName: async function (client, steamId) {
        const id = String(steamId);
        if (!/^\d{17}$/.test(id)) return null;
        const cached = profileNameCache.get(id);
        if (cached && Date.now() - cached.cachedAt < PROFILE_CACHE_MS) return cached.name;

        const link = `${Constants.STEAM_PROFILES_URL}${id}?xml=1`;
        const response = await module.exports.scrape(link);

        if (response.status !== 200) {
            logWarningOnce(client, `name:${id}`, client.intlGet(null, 'failedToScrapeProfileName', { link }));
            profileNameCache.set(id, Object.freeze({ name: null, cachedAt: Date.now() }));
            return null;
        }

        const xml = typeof response.data === 'string' ? response.data : String(response.data || '');
        const match = /<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/i.exec(xml) ||
            /<steamID>([\s\S]*?)<\/steamID>/i.exec(xml);
        if (match && match[1].trim() !== '') {
            const name = Utils.decodeHtml(match[1].trim());
            profileNameCache.set(id, Object.freeze({ name, cachedAt: Date.now() }));
            return name;
        }

        logWarningOnce(client, `name:${id}`, client.intlGet(null, 'failedToScrapeProfileName', { link }));
        profileNameCache.set(id, Object.freeze({ name: null, cachedAt: Date.now() }));
        return null;
    },
}
