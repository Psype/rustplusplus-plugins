/*
    Hidden vending-machine tracker plugin.

    Records every vending machine marker seen through Rust+ map polling for the current
    guild/server/map signature. Vendors stay in the database after they stop broadcasting,
    allowing !hv to show previously seen vendors that are not present in the latest marker poll.
*/

const Fs = require('fs');
const Path = require('path');

const DeepSeaHandler = require('../../handlers/deepSeaHandler.js');

const DATA_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'hidden-vendors');
const MAX_COMMAND_RESULTS = 10;
const WATER_SUSPECT_MAX_SEEN_POLLS = 2;
/* Observed in docs/rust_event_rpp_bot.json Deep Sea Rust+ marker snapshots. */
const KNOWN_DEEP_SEA_VENDOR_NAMES = new Set([
    'attire shop',
    'bandit weapons shop',
    'main food shop',
    'farming shop',
    'weapons shop',
    'boat vendor',
    'fish exchange',
    'fishing shop',
    'medical shop',
    'casino bar shopkeeper',
    'shop keeper'
]);

function recordVendors(rustplus, mapMarkers) {
    if (!rustplus || !mapMarkers) return;

    const now = new Date().toISOString();
    const markers = mapMarkers.markers || [];
    const deepSeaVendorKeys = getDeepSeaVendorKeys(rustplus, markers);
    const currentVendors = getVendingMachines(rustplus, markers, deepSeaVendorKeys);
    const currentKeys = new Set(currentVendors.map(getVendorKey));
    const database = readDatabase(rustplus);

    pruneDeepSeaVendors(rustplus, database, deepSeaVendorKeys);

    database.guildId = rustplus.guildId;
    database.serverId = rustplus.serverId;
    database.mapSignature = getMapSignature(rustplus);
    database.updatedAt = now;

    for (const vendor of Object.values(database.vendors)) {
        vendor.broadcasting = currentKeys.has(vendor.key);
        if (!vendor.broadcasting && !vendor.hiddenSince) vendor.hiddenSince = now;
    }

    for (const marker of currentVendors) {
        const key = getVendorKey(marker);
        const existing = database.vendors[key];
        const normalized = normalizeVendor(rustplus, marker, key, now, existing);
        database.vendors[key] = normalized;
    }

    writeDatabase(rustplus, database);
}

function getCommandHiddenVendors(rustplus, client) {
    return getCommandGroupedHiddenVendors(rustplus, client, false);
}

function getCommandHiddenWaterVendors(rustplus, client) {
    return getCommandGroupedHiddenVendors(rustplus, client, true);
}

function getCommandHiddenVendingTime(rustplus, client) {
    const guildId = rustplus.guildId;
    const database = readPrunedDatabase(rustplus);
    const hidden = Object.values(database.vendors)
        .filter(vendor => !vendor.broadcasting)
        .filter(vendor => Number.isFinite(vendor.seenPolls));

    if (hidden.length === 0) return client.intlGet(guildId, 'hiddenVendingTimeNone');

    const groups = groupVendorsByLocationAndSeenPolls(hidden).slice(0, MAX_COMMAND_RESULTS);
    const visibleCount = groups.reduce((sum, group) => sum + group.count, 0);
    const more = Math.max(0, hidden.length - visibleCount);
    const suffix = more > 0 ? ` ${client.intlGet(guildId, 'hiddenVendorsMore', { count: more })}` : '';
    const vendors = groups.map(group => client.intlGet(guildId, 'hiddenVendingTimeEntry', {
        count: group.count,
        location: group.location,
        polls: group.seenPolls
    })).join('; ');

    return client.intlGet(guildId, 'hiddenVendingTimeList', {
        count: hidden.length,
        vendors: vendors,
        more: suffix
    });
}

function getCommandGroupedHiddenVendors(rustplus, client, waterSuspectsOnly) {
    const guildId = rustplus.guildId;
    const database = readPrunedDatabase(rustplus);
    const hidden = Object.values(database.vendors)
        .filter(vendor => !vendor.broadcasting)
        .filter(vendor => !waterSuspectsOnly || isWaterSuspect(vendor));

    if (hidden.length === 0) {
        return client.intlGet(guildId, waterSuspectsOnly ? 'hiddenWaterVendorsNone' : 'hiddenVendorsNone');
    }

    const groups = groupVendorsByLocation(hidden).slice(0, MAX_COMMAND_RESULTS);
    const hiddenCount = hidden.length;
    const visibleCount = groups.reduce((sum, group) => sum + group.count, 0);
    const more = Math.max(0, hiddenCount - visibleCount);
    const suffix = more > 0 ? ` ${client.intlGet(guildId, 'hiddenVendorsMore', { count: more })}` : '';
    const vendors = groups.map(group => client.intlGet(guildId, 'hiddenVendorGridEntry', {
        count: group.count,
        location: group.location
    })).join('; ');

    return client.intlGet(guildId, waterSuspectsOnly ? 'hiddenWaterVendorsList' : 'hiddenVendorsList', {
        count: hiddenCount,
        vendors: vendors,
        more: suffix
    });
}

function groupVendorsByLocation(vendors) {
    const groups = new Map();

    for (const vendor of vendors) {
        const location = getVendorLocation(vendor);
        if (!groups.has(location)) groups.set(location, { location: location, count: 0, lastSeenAt: null });
        const group = groups.get(location);
        group.count += 1;
        if (!group.lastSeenAt || (vendor.lastSeenAt || '').localeCompare(group.lastSeenAt) > 0) {
            group.lastSeenAt = vendor.lastSeenAt;
        }
    }

    return Array.from(groups.values()).sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return (b.lastSeenAt || '').localeCompare(a.lastSeenAt || '');
    });
}

function groupVendorsByLocationAndSeenPolls(vendors) {
    const groups = new Map();

    for (const vendor of vendors) {
        const location = getVendorLocation(vendor);
        const seenPolls = vendor.seenPolls;
        const key = `${seenPolls}:${location}`;
        if (!groups.has(key)) {
            groups.set(key, { location: location, seenPolls: seenPolls, count: 0, lastSeenAt: null });
        }
        const group = groups.get(key);
        group.count += 1;
        if (!group.lastSeenAt || (vendor.lastSeenAt || '').localeCompare(group.lastSeenAt) > 0) {
            group.lastSeenAt = vendor.lastSeenAt;
        }
    }

    return Array.from(groups.values()).sort((a, b) => {
        if (a.seenPolls !== b.seenPolls) return a.seenPolls - b.seenPolls;
        if (b.count !== a.count) return b.count - a.count;
        return (b.lastSeenAt || '').localeCompare(a.lastSeenAt || '');
    });
}

function isWaterSuspect(vendor) {
    if (!Number.isFinite(vendor.seenPolls)) return false;
    return vendor.seenPolls <= WATER_SUSPECT_MAX_SEEN_POLLS;
}

function getVendingMachines(rustplus, markers, deepSeaVendorKeys = null) {
    const vendingMachineType = rustplus.mapMarkers ? rustplus.mapMarkers.types.VendingMachine : 3;
    const excludedKeys = deepSeaVendorKeys || getDeepSeaVendorKeys(rustplus, markers);
    return (markers || [])
        .filter(marker => isVendingMachineMarker(marker, vendingMachineType))
        .filter(marker => !excludedKeys.has(getVendorKey(marker)))
        .filter(marker => !isKnownDeepSeaVendor(rustplus, marker));
}

function readPrunedDatabase(rustplus) {
    const database = readDatabase(rustplus);
    if (pruneDeepSeaVendors(rustplus, database, new Set())) writeDatabase(rustplus, database);
    return database;
}

function pruneDeepSeaVendors(rustplus, database, deepSeaVendorKeys) {
    let changed = false;

    for (const key of deepSeaVendorKeys) {
        if (database.vendors.hasOwnProperty(key)) {
            delete database.vendors[key];
            changed = true;
        }
    }

    for (const [key, vendor] of Object.entries(database.vendors)) {
        if (isKnownDeepSeaVendor(rustplus, vendor)) {
            delete database.vendors[key];
            changed = true;
        }
    }

    return changed;
}

function isKnownDeepSeaVendor(rustplus, vendor) {
    if (!vendor || !isOffMapVendor(rustplus, vendor)) return false;
    const name = normalizeText(vendor.name);
    if (!name) return false;
    return KNOWN_DEEP_SEA_VENDOR_NAMES.has(name.toLowerCase());
}

function isOffMapVendor(rustplus, vendor) {
    if (!Number.isFinite(vendor.x) || !Number.isFinite(vendor.y)) return false;

    const mapSize = getCorrectedMapSize(rustplus);
    if (!Number.isFinite(mapSize) || mapSize <= 0) return vendor.x < 0 || vendor.y < 0;
    return vendor.x < 0 || vendor.y < 0 || vendor.x > mapSize || vendor.y > mapSize;
}

function getCorrectedMapSize(rustplus) {
    if (!rustplus || !rustplus.info) return null;
    if (Number.isFinite(rustplus.info.correctedMapSize)) return rustplus.info.correctedMapSize;
    return Number.isFinite(rustplus.info.mapSize) ? rustplus.info.mapSize : null;
}

function getDeepSeaVendorKeys(rustplus, markers) {
    if (!DeepSeaHandler || typeof DeepSeaHandler.getDeepSeaVendors !== 'function') return new Set();

    try {
        return new Set(DeepSeaHandler.getDeepSeaVendors(rustplus, { markers: markers }).map(getVendorKey));
    }
    catch (_e) {
        return new Set();
    }
}

function isVendingMachineMarker(marker, vendingMachineType) {
    if (!marker) return false;
    if (marker.type === vendingMachineType) return true;
    if (typeof marker.type !== 'string') return false;

    return marker.type.replace(/[\s_]/g, '').toLowerCase() === 'vendingmachine';
}

function normalizeVendor(rustplus, marker, key, now, existing = null) {
    const mapSize = rustplus.info ? (rustplus.info.correctedMapSize || rustplus.info.mapSize) : null;
    const location = mapSize ? getGridLocation(marker.x, marker.y, mapSize) : null;
    const seenPolls = existing && Number.isFinite(existing.seenPolls) ? existing.seenPolls + 1 : 1;

    return {
        key: key,
        id: marker.id !== undefined && marker.id !== null ? marker.id.toString() : (existing ? existing.id : null),
        name: normalizeText(marker.name) || (existing ? existing.name : null),
        x: marker.x,
        y: marker.y,
        location: location || (existing ? existing.location : null),
        firstSeenAt: existing && existing.firstSeenAt ? existing.firstSeenAt : now,
        lastSeenAt: now,
        hiddenSince: null,
        broadcasting: true,
        seenPolls: seenPolls
    };
}

function getGridLocation(x, y, mapSize) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(mapSize) || mapSize <= 0) return null;
    if (x < 0 || y < 0 || x > mapSize || y > mapSize) {
        return `(${Math.round(x)}, ${Math.round(y)})`;
    }

    const gridDiameter = 146.25;
    const columnNumber = Math.floor(x / gridDiameter) + 1;
    const numberOfRows = Math.floor(mapSize / gridDiameter);
    const rowNumber = numberOfRows - (Math.floor(y / gridDiameter) + 1);
    return `${numberToLetters(columnNumber)}${rowNumber}`;
}

function numberToLetters(num) {
    const mod = num % 26;
    let pow = num / 26 | 0;
    const out = mod ? String.fromCharCode(64 + mod) : (pow--, 'Z');
    return pow ? numberToLetters(pow) + out : out;
}

function getVendorLocation(vendor) {
    return vendor.location || `${Math.round(vendor.x)},${Math.round(vendor.y)}`;
}

function readDatabase(rustplus) {
    const path = getDatabasePath(rustplus);
    if (!Fs.existsSync(path)) return getEmptyDatabase(rustplus);

    try {
        const parsed = JSON.parse(Fs.readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !parsed.vendors) return getEmptyDatabase(rustplus);
        return parsed;
    }
    catch (_e) {
        return getEmptyDatabase(rustplus);
    }
}

function writeDatabase(rustplus, database) {
    ensureDataDir();
    Fs.writeFileSync(getDatabasePath(rustplus), `${JSON.stringify(database, null, 2)}\n`);
}

function getEmptyDatabase(rustplus) {
    return {
        guildId: rustplus.guildId,
        serverId: rustplus.serverId,
        mapSignature: getMapSignature(rustplus),
        createdAt: new Date().toISOString(),
        updatedAt: null,
        vendors: {}
    };
}

function getDatabasePath(rustplus) {
    ensureDataDir();
    return Path.join(DATA_DIR, `${sanitizeFilePart(rustplus.guildId)}-${sanitizeFilePart(rustplus.serverId)}-${sanitizeFilePart(getMapSignature(rustplus))}.json`);
}

function getMapSignature(rustplus) {
    const info = rustplus && rustplus.info ? rustplus.info : {};
    return [
        info.seed || 'unknown-seed',
        info.mapSize || 'unknown-size',
        info.wipeTime || 'unknown-wipe'
    ].join('-');
}

function getVendorKey(marker) {
    if (marker.id !== undefined && marker.id !== null) return `id:${marker.id}`;
    return `xy:${roundCoordinate(marker.x)}:${roundCoordinate(marker.y)}`;
}

function roundCoordinate(value) {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : 'unknown';
}

function normalizeText(value) {
    if (value === undefined || value === null) return null;
    const text = value.toString().trim();
    return text || null;
}

function sanitizeFilePart(value) {
    return value.toString().replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function ensureDataDir() {
    if (!Fs.existsSync(DATA_DIR)) Fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = {
    recordVendors,
    getCommandHiddenVendors,
    getCommandHiddenWaterVendors,
    getCommandHiddenVendingTime
};
