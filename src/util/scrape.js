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
const BoundedTtlCache = require('./boundedTtlCache.js');

const REQUEST_TIMEOUT_MS = 5000;
const PROFILE_CACHE_MS = 60 * 60 * 1000;
const PROFILE_FAILURE_CACHE_MS = 30 * 1000;
const PROFILE_CACHE_MAX_ENTRIES = 1024;
const WARNING_CACHE_MAX_ENTRIES = 2048;
const profileNameCache = BoundedTtlCache.createBoundedTtlCache({
    maxEntries: PROFILE_CACHE_MAX_ENTRIES, defaultTtlMs: PROFILE_CACHE_MS
});
const profileIdentityCache = BoundedTtlCache.createBoundedTtlCache({
    maxEntries: PROFILE_CACHE_MAX_ENTRIES, defaultTtlMs: PROFILE_CACHE_MS
});
const warningCache = BoundedTtlCache.createBoundedTtlCache({
    maxEntries: WARNING_CACHE_MAX_ENTRIES, defaultTtlMs: PROFILE_CACHE_MS
});

function logWarningOnce(client, key, message) {
    const now = Date.now();
    if (warningCache.get(key, now)) return;
    warningCache.set(key, true, PROFILE_CACHE_MS, now);
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
        if (cached) return cached.name;

        const link = `${Constants.STEAM_PROFILES_URL}${id}?xml=1`;
        const response = await module.exports.scrape(link);

        if (response.status !== 200) {
            logWarningOnce(client, `name:${id}`, client.intlGet(null, 'failedToScrapeProfileName', { link }));
            profileNameCache.set(id, Object.freeze({ name: null }), PROFILE_FAILURE_CACHE_MS);
            return null;
        }

        const xml = typeof response.data === 'string' ? response.data : String(response.data || '');
        const match = /<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/i.exec(xml) ||
            /<steamID>([\s\S]*?)<\/steamID>/i.exec(xml);
        if (match && match[1].trim() !== '') {
            const name = Utils.decodeHtml(match[1].trim());
            profileNameCache.set(id, Object.freeze({ name }));
            return name;
        }

        logWarningOnce(client, `name:${id}`, client.intlGet(null, 'failedToScrapeProfileName', { link }));
        profileNameCache.set(id, Object.freeze({ name: null }), PROFILE_FAILURE_CACHE_MS);
        return null;
    },

    scrapeSteamProfileIdentity: async function (client, steamId) {
        const id = String(steamId);
        if (!/^\d{17}$/.test(id)) return null;
        const cached = profileIdentityCache.get(id);
        if (cached) return cached.identity;

        const aliasLink = `${Constants.STEAM_PROFILES_URL}${id}/ajaxaliases/`;
        const [currentName, aliasResponse] = await Promise.all([
            module.exports.scrapeSteamProfileName(client, id),
            module.exports.scrape(aliasLink)
        ]);
        if (!currentName) {
            profileIdentityCache.set(id, Object.freeze({ identity: null }), PROFILE_FAILURE_CACHE_MS);
            return null;
        }

        const rows = aliasResponse.status === 200 && Array.isArray(aliasResponse.data) ? aliasResponse.data : [];
        if (aliasResponse.status !== 200) {
            logWarningOnce(client, `aliases:${id}`,
                client.intlGet(null, 'failedToScrapeProfileName', { link: aliasLink }));
        }
        const aliases = [];
        const seen = new Set([currentName]);
        for (const row of rows) {
            const rawName = row && typeof row.newname === 'string' ? Utils.decodeHtml(row.newname) : '';
            const name = rawName.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
            if (!name || Array.from(name).length > 128 || seen.has(name)) continue;
            seen.add(name);
            aliases.push(Object.freeze({
                name,
                timeChanged: row && typeof row.timechanged === 'string' ? row.timechanged : null
            }));
        }
        const identity = Object.freeze({
            steamId: id,
            currentName,
            pastAliases: Object.freeze(aliases),
            aliasesComplete: aliasResponse.status === 200 && Array.isArray(aliasResponse.data)
        });
        profileIdentityCache.set(id, Object.freeze({ identity }),
            identity.aliasesComplete ? PROFILE_CACHE_MS : PROFILE_FAILURE_CACHE_MS);
        return identity;
    },

    getRuntimeCacheStatus: function () {
        return Object.freeze({
            profileNames: profileNameCache.size,
            profileIdentities: profileIdentityCache.size,
            warnings: warningCache.size,
            profileLimit: PROFILE_CACHE_MAX_ENTRIES,
            warningLimit: WARNING_CACHE_MAX_ENTRIES
        });
    },

    resetRuntimeCachesForTests: function () {
        profileNameCache.clear();
        profileIdentityCache.clear();
        warningCache.clear();
    },
}
