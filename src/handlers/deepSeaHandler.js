/*
    Deep Sea event handler.

    Deep Sea currently appears in Rust+ as a temporary cluster of vending-machine markers far outside the map.
    We detect either the known Casino Bar Shopkeeper marker name or a cluster of off-map vendors, then treat the
    cluster appearance/disappearance as the Deep Sea open/close state change.
*/

const Constants = require('../util/constants.js');

const OFF_MAP_VENDOR_CLUSTER_SIZE = 3;
const CASINO_BAR_SHOPKEEPER_REGEX = /casino\s+bar\s+shopkeeper/i;

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

function getDeepSeaSide(markers, correctedMapSize) {
    const center = markers.reduce((acc, marker) => {
        acc.x += marker.x;
        acc.y += marker.y;
        return acc;
    }, { x: 0, y: 0 });
    center.x /= markers.length;
    center.y /= markers.length;

    /*
        Deep Sea vendor markers are emitted in a rotated/offshore coordinate space compared to normal
        Rust+ map markers. A live south-side cluster was observed with x around -4100 and y inside the
        playable map range, so use x for the north/south edge and y for the west/east edge here.
    */
    const distances = [
        { side: 'south', distance: center.x < 0 ? Math.abs(center.x) : 0 },
        { side: 'north', distance: center.x > correctedMapSize ? center.x - correctedMapSize : 0 },
        { side: 'west', distance: center.y < 0 ? Math.abs(center.y) : 0 },
        { side: 'east', distance: center.y > correctedMapSize ? center.y - correctedMapSize : 0 }
    ];

    distances.sort((a, b) => b.distance - a.distance);
    return distances[0].distance > 0 ? distances[0].side : null;
}

function getSideName(client, guildId, side) {
    const sideNames = {
        west: client.intlGet(guildId, 'deepseaSideWest'),
        east: client.intlGet(guildId, 'deepseaSideEast'),
        north: client.intlGet(guildId, 'deepseaSideNorth'),
        south: client.intlGet(guildId, 'deepseaSideSouth')
    };

    return sideNames[side] || client.intlGet(guildId, 'unknown');
}

async function sendDeepSeaOpened(rustplus, client, sideName) {
    await rustplus.sendEvent(
        rustplus.notificationSettings.deepseaDetectedSetting || rustplus.notificationSettings.cargoShipDetectedSetting,
        client.intlGet(rustplus.guildId, 'deepseaOpenedAt', { side: sideName }),
        'deepsea',
        Constants.COLOR_DEEPSEA_OPENED,
        rustplus.isFirstPoll,
        'cargoship_logo.png');
}

async function sendDeepSeaClosed(rustplus, client) {
    await rustplus.sendEvent(
        rustplus.notificationSettings.deepseaLeftSetting || rustplus.notificationSettings.cargoShipLeftSetting,
        client.intlGet(rustplus.guildId, 'deepseaClosed'),
        'deepsea',
        Constants.COLOR_DEEPSEA_CLOSED,
        rustplus.isFirstPoll,
        'cargoship_logo.png');
}

module.exports = {
    handler: async function (rustplus, client, mapMarkers) {
        if (!rustplus.info || !rustplus.deepSea) return;

        const correctedMapSize = rustplus.info.correctedMapSize;
        const vendingMachineType = getVendingMachineType(rustplus);
        const offMapVendors = (mapMarkers.markers || [])
            .filter(marker => isVendingMachineMarker(marker, vendingMachineType))
            .filter(marker => isOffMap(marker, correctedMapSize));

        const casinoVendors = offMapVendors.filter(isCasinoBarShopkeeper);
        const deepSeaVendors = casinoVendors.length > 0 || offMapVendors.length >= OFF_MAP_VENDOR_CLUSTER_SIZE ?
            offMapVendors : [];
        const active = deepSeaVendors.length > 0;

        if (active) {
            const side = getDeepSeaSide(deepSeaVendors, correctedMapSize);
            const sideName = getSideName(client, rustplus.guildId, side);
            const now = new Date();

            if (!rustplus.deepSea.active) {
                rustplus.deepSea.active = true;
                rustplus.deepSea.startedAt = now;
                rustplus.deepSea.side = side;
                rustplus.deepSea.sideName = sideName;
                rustplus.deepSea.endsAt = new Date(now.getTime() + Constants.DEFAULT_DEEPSEA_DURATION_MS);
                await sendDeepSeaOpened(rustplus, client, sideName);
            }
            else if (rustplus.deepSea.side !== side) {
                rustplus.deepSea.side = side;
                rustplus.deepSea.sideName = sideName;
            }

            rustplus.deepSea.lastSeenAt = now;
            rustplus.deepSea.vendorIds = deepSeaVendors.map(marker => marker.id);
        }
        else if (rustplus.deepSea.active) {
            rustplus.deepSea.active = false;
            rustplus.deepSea.lastEndedAt = new Date();
            rustplus.deepSea.vendorIds = [];
            await sendDeepSeaClosed(rustplus, client);
        }
    }
};
