/*
    Deep Sea event handler.

    This module intentionally owns all Deep Sea runtime state, command output, event-summary output,
    strings, and side inference so the base RustPlus/MapMarkers structures stay easy to update from upstream.
*/

const Constants = require('../util/constants.js');
const Timer = require('../util/timer.js');

const STATE_KEY = '__deepSeaState';
const OFF_MAP_VENDOR_CLUSTER_SIZE = 3;
const CASINO_BAR_SHOPKEEPER_REGEX = /casino\s+bar\s+shopkeeper/i;
const DEFAULT_SETTING = { discord: false, inGame: false, voice: false, image: 'cargoship_logo.png' };
const GRID_DIAMETER = 146.25;
const VANILLA_EVENT_WINDOWS = {
    cargo: { minMs: 2 * 60 * 60 * 1000, maxMs: 4 * 60 * 60 * 1000 },
    heli: { minMs: 2 * 60 * 60 * 1000, maxMs: 4 * 60 * 60 * 1000 },
    chinook: { minMs: 2 * 60 * 60 * 1000, maxMs: 4 * 60 * 60 * 1000 },
    small: { minMs: 30 * 60 * 1000, maxMs: 60 * 60 * 1000 },
    large: { minMs: 30 * 60 * 1000, maxMs: 60 * 60 * 1000 }
};

function getInitialState() {
    return {
        active: false,
        side: null,
        sideName: null,
        sideDetails: null,
        startedAt: null,
        lastSeenAt: null,
        lastEndedAt: null,
        endsAt: null,
        vendorIds: [],
        oilRigEvents: { small: {}, large: {} }
    };
}

function ensureState(rustplus) {
    if (!rustplus[STATE_KEY]) rustplus[STATE_KEY] = getInitialState();
    return rustplus[STATE_KEY];
}

function getVendingMachineType(rustplus) {
    return rustplus.mapMarkers ? rustplus.mapMarkers.types.VendingMachine : 3;
}

function isVendingMachineMarker(marker, vendingMachineType) {
    if (marker.type === vendingMachineType) return true;
    if (typeof marker.type !== 'string') return false;

    return marker.type.replace(/[\s_]/g, '').toLowerCase() === 'vendingmachine';
}

function isOffMap(marker, correctedMapSize) {
    return marker.x < 0 || marker.x > correctedMapSize || marker.y < 0 || marker.y > correctedMapSize;
}

function isCasinoBarShopkeeper(marker) {
    return typeof marker.name === 'string' && CASINO_BAR_SHOPKEEPER_REGEX.test(marker.name);
}

function buildBounds(referenceMarkers, source) {
    return referenceMarkers.reduce((bounds, marker) => {
        bounds.minX = Math.min(bounds.minX, marker.x);
        bounds.maxX = Math.max(bounds.maxX, marker.x);
        bounds.minY = Math.min(bounds.minY, marker.y);
        bounds.maxY = Math.max(bounds.maxY, marker.y);
        return bounds;
    }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, source: source });
}

function getReferenceBounds(rustplus, allMarkers, correctedMapSize, deepSeaVendorIds = []) {
    const deepSeaVendorIdSet = new Set(deepSeaVendorIds);
    const inMap = marker => !isOffMap(marker, correctedMapSize);

    if (rustplus.map && Array.isArray(rustplus.map.monuments)) {
        const monuments = rustplus.map.monuments.filter(inMap);
        if (monuments.length >= 2) return buildBounds(monuments, 'monuments');
    }

    const vendingMachineType = getVendingMachineType(rustplus);
    const vendors = (allMarkers || [])
        .filter(marker => !deepSeaVendorIdSet.has(marker.id))
        .filter(marker => isVendingMachineMarker(marker, vendingMachineType))
        .filter(inMap);
    if (vendors.length >= 2) return buildBounds(vendors, 'vendors');

    const markers = (allMarkers || [])
        .filter(marker => !deepSeaVendorIdSet.has(marker.id))
        .filter(inMap);
    if (markers.length >= 2) return buildBounds(markers, 'markers');

    return { minX: 0, maxX: correctedMapSize, minY: 0, maxY: correctedMapSize, source: 'mapSize' };
}

function getReferenceMidpoint(bounds, axis, fallback) {
    if (!bounds) return fallback;

    if (axis === 'x' && Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX)) {
        return (bounds.minX + bounds.maxX) / 2;
    }
    if (axis === 'y' && Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxY)) {
        return (bounds.minY + bounds.maxY) / 2;
    }

    return fallback;
}

function getDeepSeaSideDetails(markers, correctedMapSize, referenceBounds = null) {
    const center = markers.reduce((acc, marker) => {
        acc.x += marker.x;
        acc.y += marker.y;
        return acc;
    }, { x: 0, y: 0 });
    center.x /= markers.length;
    center.y /= markers.length;

    const mapMidpoint = correctedMapSize / 2;
    const referenceMidX = getReferenceMidpoint(referenceBounds, 'x', mapMidpoint);
    const referenceMidY = getReferenceMidpoint(referenceBounds, 'y', mapMidpoint);
    const xOutside = center.x < 0 || center.x > correctedMapSize;
    const yOutside = center.y < 0 || center.y > correctedMapSize;
    let side = null;
    let distance = 0;

    /*
        Rust+ Deep Sea marker coordinates use X as the vertical axis and Y as the horizontal axis.
        Therefore negative X is South, X past the map is North, negative Y is West, and Y past the
        map is East. Do not swap to normal map-grid X/Y when deciding the offshore side.
    */
    if (xOutside && !yOutside) {
        side = center.x < 0 ? 'south' : 'north';
        distance = center.x < 0 ? Math.abs(center.x) : center.x - correctedMapSize;
    }
    else if (yOutside && !xOutside) {
        side = center.y < 0 ? 'west' : 'east';
        distance = center.y < 0 ? Math.abs(center.y) : center.y - correctedMapSize;
    }
    else {
        const distances = [
            { side: 'south', distance: center.x < 0 ? Math.abs(center.x) : 0 },
            { side: 'north', distance: center.x > correctedMapSize ? center.x - correctedMapSize : 0 },
            { side: 'west', distance: center.y < 0 ? Math.abs(center.y) : 0 },
            { side: 'east', distance: center.y > correctedMapSize ? center.y - correctedMapSize : 0 }
        ];

        distances.sort((a, b) => b.distance - a.distance);
        side = distances[0].distance > 0 ? distances[0].side : null;
        distance = distances[0].distance;
    }

    return {
        side: side,
        center: center,
        distance: distance,
        correctedMapSize: correctedMapSize,
        mapMidpoint: mapMidpoint,
        referenceMidX: referenceMidX,
        referenceMidY: referenceMidY,
        referenceBounds: referenceBounds
    };
}

function getDeepSeaSide(markers, correctedMapSize, referenceBounds = null) {
    return getDeepSeaSideDetails(markers, correctedMapSize, referenceBounds).side;
}

function getSideName(side) {
    const sideNames = { west: 'West', east: 'East', north: 'North', south: 'South' };
    return sideNames[side] || 'Unknown';
}

function getNotificationSetting(rustplus, settingName, fallbackName) {
    return rustplus.notificationSettings[settingName] || rustplus.notificationSettings[fallbackName] || DEFAULT_SETTING;
}

function formatOpened() {
    return 'Deep Sea event is active.';
}

function formatClosed() {
    return 'Deep Sea just closed.';
}

function formatCommand(rustplus, isInfoChannel = false) {
    const state = ensureState(rustplus);

    if (state.active) {
        const secondsRemaining = Math.max(0, (state.endsAt - new Date()) / 1000);
        const time = Timer.secondsToFullScale(secondsRemaining, isInfoChannel ? 's' : '');
        if (isInfoChannel) return `Active | ${time}`;
        return `Deep Sea event is active for the next ${time}.`;
    }

    if (state.lastEndedAt === null) {
        return isInfoChannel ? 'Not active.' : 'Deep Sea info is unknown.';
    }

    const secondsSince = (new Date() - state.lastEndedAt) / 1000;
    if (isInfoChannel) return `${Timer.secondsToFullScale(secondsSince, 's')} since last`;

    const secondsUntilMin = (Constants.DEFAULT_DEEPSEA_COOLDOWN_MIN_MS / 1000) - secondsSince;
    const secondsUntilMax = (Constants.DEFAULT_DEEPSEA_COOLDOWN_MAX_MS / 1000) - secondsSince;
    const timeSince = Timer.secondsToFullScale(secondsSince);

    if (secondsUntilMax <= 0) {
        return `Deep Sea was last seen ${timeSince} ago. Next expected any time now.`;
    }
    if (secondsUntilMin <= 0) {
        return `Deep Sea was last seen ${timeSince} ago. Next expected any time within ${Timer.secondsToFullScale(secondsUntilMax)}.`;
    }

    return `Deep Sea was last seen ${timeSince} ago. Next expected in ${Timer.secondsToFullScale(secondsUntilMin)}-${Timer.secondsToFullScale(secondsUntilMax)}.`;
}


function numberToLetters(num) {
    const mod = num % 26;
    let pow = num / 26 | 0;
    const out = mod ? String.fromCharCode(64 + mod) : (pow--, 'Z');
    return pow ? numberToLetters(pow) + out : out;
}

function getGridLetter(x, mapSize) {
    let counter = 1;
    for (let startGrid = 0; startGrid < mapSize; startGrid += GRID_DIAMETER) {
        if (x >= startGrid && x <= (startGrid + GRID_DIAMETER)) return numberToLetters(counter);
        counter++;
    }

    return null;
}

function getGridNumber(y, mapSize) {
    let counter = 1;
    const numberOfGrids = Math.floor(mapSize / GRID_DIAMETER);
    for (let startGrid = 0; startGrid < mapSize; startGrid += GRID_DIAMETER) {
        if (y >= startGrid && y <= (startGrid + GRID_DIAMETER)) return numberOfGrids - counter;
        counter++;
    }

    return null;
}

function getGridPos(x, y, mapSize) {
    if (x < 0 || x > mapSize || y < 0 || y > mapSize) return null;

    const letter = getGridLetter(x, mapSize);
    const number = getGridNumber(y, mapSize);
    return letter && number !== null ? `${letter}${number}` : null;
}

function getCorrectedMapSize(rustplus) {
    if (!rustplus.info) return null;
    if (Number.isFinite(rustplus.info.correctedMapSize)) return rustplus.info.correctedMapSize;
    if (!Number.isFinite(rustplus.info.mapSize)) return null;

    const remainder = rustplus.info.mapSize % GRID_DIAMETER;
    const offset = GRID_DIAMETER - remainder;
    return remainder < 120 ? rustplus.info.mapSize - remainder : rustplus.info.mapSize + offset;
}

function getOilRigMonuments(rustplus, event) {
    const correctedMapSize = getCorrectedMapSize(rustplus);
    if (!rustplus.map || !Array.isArray(rustplus.map.monuments) || !correctedMapSize) return [];
    const token = event === 'large' ? 'large_oil_rig' : 'oil_rig_small';

    return rustplus.map.monuments
        .filter(monument => monument.token === token)
        .map(monument => {
            return {
                x: monument.x,
                y: monument.y,
                grid: getGridPos(monument.x, monument.y, correctedMapSize)
            };
        })
        .filter(monument => monument.grid);
}

function getEventDisplayName(event, oilRigMonument = null) {
    const eventNames = {
        cargo: 'Cargo', heli: 'Patrol Helicopter', chinook: 'Chinook 47', small: 'Small Oil Rig',
        large: 'Large Oil Rig', deepsea: 'Deep Sea'
    };

    if (oilRigMonument && (event === 'small' || event === 'large')) {
        return `${eventNames[event]} (${oilRigMonument.grid})`;
    }
    return eventNames[event] || event;
}

function getOilRigLocationField(rustplus, event) {
    if (!rustplus.mapMarkers) return null;
    return event === 'large' ? rustplus.mapMarkers.crateLargeOilRigLocation :
        rustplus.mapMarkers.crateSmallOilRigLocation;
}

function getOilRigLastTriggeredAt(rustplus, event) {
    if (!rustplus.mapMarkers) return null;
    return event === 'large' ? rustplus.mapMarkers.timeSinceLargeOilRigWasTriggered :
        rustplus.mapMarkers.timeSinceSmallOilRigWasTriggered;
}

function matchesOilRigLocation(location, grid) {
    if (!location || !grid) return false;
    return location.toString().toLowerCase().includes(grid.toString().toLowerCase());
}

function syncOilRigState(rustplus) {
    const state = ensureState(rustplus);

    ['small', 'large'].forEach(event => {
        const monuments = getOilRigMonuments(rustplus, event);
        const location = getOilRigLocationField(rustplus, event);
        const lastTriggeredAt = getOilRigLastTriggeredAt(rustplus, event);

        monuments.forEach(monument => {
            if (!state.oilRigEvents[event][monument.grid]) state.oilRigEvents[event][monument.grid] = {};
            const entry = state.oilRigEvents[event][monument.grid];

            if (lastTriggeredAt && (monuments.length === 1 || matchesOilRigLocation(location, monument.grid))) {
                entry.lastTriggeredAt = lastTriggeredAt;
            }
        });
    });
}

function getLastSeenAt(rustplus, event) {
    if (!rustplus.mapMarkers) return null;

    const lastSeen = {
        cargo: rustplus.mapMarkers.timeSinceCargoShipWasOut,
        heli: rustplus.mapMarkers.timeSincePatrolHelicopterWasOnMap,
        chinook: rustplus.mapMarkers.timeSinceCH47WasOut,
        small: getOilRigLastTriggeredAt(rustplus, 'small'),
        large: getOilRigLastTriggeredAt(rustplus, 'large')
    };

    return lastSeen[event] || null;
}

function getApproximateNextText(lastSeenAt, event) {
    const window = VANILLA_EVENT_WINDOWS[event];
    if (!lastSeenAt || !window) return null;

    const secondsSince = (new Date() - lastSeenAt) / 1000;
    const secondsUntilMin = (window.minMs / 1000) - secondsSince;
    const secondsUntilMax = (window.maxMs / 1000) - secondsSince;

    if (secondsUntilMax <= 0) return 'Vanilla next approx any time now.';
    if (secondsUntilMin <= 0) {
        return `Vanilla next approx any time within ${Timer.secondsToFullScale(secondsUntilMax)}.`;
    }

    return `Vanilla next approx in ${Timer.secondsToFullScale(secondsUntilMin)}-${Timer.secondsToFullScale(secondsUntilMax)}.`;
}

function appendApproximateNext(message, rustplus, event) {
    const approximateNext = getApproximateNextText(getLastSeenAt(rustplus, event), event);
    if (!approximateNext) return message;
    return `${message} ${approximateNext}`;
}

function getOilRigUnlockMs(rustplus) {
    if (rustplus.instance && rustplus.instance.server && rustplus.instance.server.oilRigLockedCrateUnlockTimeMs) {
        return rustplus.instance.server.oilRigLockedCrateUnlockTimeMs;
    }
    return Constants.DEFAULT_OIL_RIG_LOCKED_CRATE_UNLOCK_TIME_MS;
}

function getOilRigSummaryFromEntry(rustplus, event, monument, entry) {
    const name = getEventDisplayName(event, monument);
    if (!entry || !entry.lastTriggeredAt) return `${name}: event info is unknown.`;

    const secondsSince = (new Date() - entry.lastTriggeredAt) / 1000;
    const unlockSecondsLeft = (getOilRigUnlockMs(rustplus) / 1000) - secondsSince;
    let message;

    if (unlockSecondsLeft > 0) {
        message = `${Timer.secondsToFullScale(unlockSecondsLeft)} before Locked Crate unlocks.`;
    }
    else {
        message = `${Timer.secondsToFullScale(secondsSince)} since Heavy Scientists last got called.`;
    }

    const approximateNext = getApproximateNextText(entry.lastTriggeredAt, event);
    if (approximateNext) message = `${message} ${approximateNext}`;
    return `${name}: ${message}`;
}

function getOilRigEventSummaries(rustplus, event) {
    syncOilRigState(rustplus);

    const monuments = getOilRigMonuments(rustplus, event);
    if (monuments.length === 0) return [getEventSummary(rustplus, event)];

    const state = ensureState(rustplus);
    return monuments.map(monument => {
        const entry = state.oilRigEvents[event][monument.grid];
        return getOilRigSummaryFromEntry(rustplus, event, monument, entry);
    });
}

function getEventSummary(rustplus, event) {
    const getters = {
        cargo: () => rustplus.getCommandCargo(),
        heli: () => rustplus.getCommandHeli(),
        chinook: () => rustplus.getCommandChinook(),
        small: () => rustplus.getCommandSmall(),
        large: () => rustplus.getCommandLarge(),
        deepsea: () => formatCommand(rustplus)
    };

    const name = getEventDisplayName(event);
    const getter = getters[event];
    if (!getter) return `${name}: event info is unknown.`;

    const value = getter();
    let message = Array.isArray(value) ? value[0] : value;

    if (!message) return `${name}: event info is unknown.`;
    message = appendApproximateNext(message, rustplus, event);
    if (message.toLowerCase().startsWith(name.toLowerCase())) return message;
    return `${name}: ${message}`;
}

function getEventSummaries(rustplus, event) {
    if (event === 'small' || event === 'large') return getOilRigEventSummaries(rustplus, event);
    return [getEventSummary(rustplus, event)];
}

function patchCommands(rustplus, client) {
    if (!rustplus.__deepSeaCommandPatched) {
        rustplus.getCommandDeepsea = function (isInfoChannel = false) {
            return formatCommand(this, isInfoChannel);
        };
        rustplus.__deepSeaCommandPatched = true;
    }

    if (!rustplus.__deepSeaEventsPatched && typeof rustplus.getCommandEvents === 'function') {
        const originalGetCommandEvents = rustplus.getCommandEvents.bind(rustplus);
        rustplus.getCommandEvents = function (command) {
            const prefix = this.generalSettings.prefix;
            const commandEvents = `${prefix}events`;
            const commandEventsLocalized = `${prefix}${client ? client.intlGet(this.guildId, 'commandSyntaxEvents') : 'events'}`;
            let args = command.toLowerCase().startsWith(commandEventsLocalized) ?
                command.slice(commandEventsLocalized.length).trim() : command.slice(commandEvents.length).trim();
            const event = args.replace(/ .*/, '').toLowerCase();

            if (['small', 'large', 'deepsea'].includes(event)) return getEventSummaries(this, event);
            if (event === '') {
                return ['cargo', 'heli', 'chinook', 'small', 'large', 'deepsea']
                    .flatMap(e => getEventSummaries(this, e));
            }
            return originalGetCommandEvents(command);
        };
        rustplus.__deepSeaEventsPatched = true;
    }
}

function disableLegacyGenericRadiusDeepSea(rustplus) {
    if (!rustplus.mapMarkers || rustplus.mapMarkers.__deepSeaLegacyDisabled) return;
    rustplus.mapMarkers.isDeepseaMarker = function () { return false; };
    rustplus.mapMarkers.__deepSeaLegacyDisabled = true;
}

async function sendDeepSeaOpened(rustplus) {
    await rustplus.sendEvent(
        getNotificationSetting(rustplus, 'deepseaDetectedSetting', 'cargoShipDetectedSetting'),
        formatOpened(),
        'deepsea',
        Constants.COLOR_DEEPSEA_OPENED,
        rustplus.isFirstPoll,
        'cargoship_logo.png');
}

async function sendDeepSeaClosed(rustplus) {
    await rustplus.sendEvent(
        getNotificationSetting(rustplus, 'deepseaLeftSetting', 'cargoShipLeftSetting'),
        formatClosed(),
        'deepsea',
        Constants.COLOR_DEEPSEA_CLOSED,
        rustplus.isFirstPoll,
        'cargoship_logo.png');
}

function install(rustplus, client = null) {
    ensureState(rustplus);
    patchCommands(rustplus, client);
    disableLegacyGenericRadiusDeepSea(rustplus);
}

module.exports = {
    install: install,
    getDeepSeaSide: getDeepSeaSide,
    getDeepSeaSideDetails: getDeepSeaSideDetails,
    getReferenceBounds: getReferenceBounds,
    formatCommand: formatCommand,

    handler: async function (rustplus, client, mapMarkers) {
        if (!rustplus.info) return;

        install(rustplus, client);

        const state = ensureState(rustplus);
        const correctedMapSize = getCorrectedMapSize(rustplus);
        if (!correctedMapSize) return;
        const vendingMachineType = getVendingMachineType(rustplus);
        const offMapVendors = (mapMarkers.markers || [])
            .filter(marker => isVendingMachineMarker(marker, vendingMachineType))
            .filter(marker => isOffMap(marker, correctedMapSize));

        const casinoVendors = offMapVendors.filter(isCasinoBarShopkeeper);
        const deepSeaVendors = casinoVendors.length > 0 || offMapVendors.length >= OFF_MAP_VENDOR_CLUSTER_SIZE ?
            offMapVendors : [];
        const active = deepSeaVendors.length > 0;

        if (active) {
            const referenceBounds = getReferenceBounds(rustplus, mapMarkers.markers || [], correctedMapSize,
                deepSeaVendors.map(marker => marker.id));
            const sideDetails = getDeepSeaSideDetails(deepSeaVendors, correctedMapSize, referenceBounds);
            const side = sideDetails.side;
            const sideName = getSideName(side);
            const now = new Date();

            if (!state.active) {
                state.active = true;
                state.startedAt = now;
                state.endsAt = new Date(now.getTime() + Constants.DEFAULT_DEEPSEA_DURATION_MS);
                await sendDeepSeaOpened(rustplus);
            }

            state.side = side;
            state.sideName = sideName;
            state.sideDetails = sideDetails;
            state.lastSeenAt = now;
            state.vendorIds = deepSeaVendors.map(marker => marker.id);
        }
        else if (state.active) {
            state.active = false;
            state.lastEndedAt = new Date();
            state.vendorIds = [];
            await sendDeepSeaClosed(rustplus);
        }
    }
};
