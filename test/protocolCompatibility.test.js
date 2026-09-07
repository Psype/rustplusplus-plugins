const Assert = require('node:assert/strict');
const Path = require('node:path');
const Test = require('node:test');

async function loadProtocol() {
    const packagePath = require.resolve('@liamcottle/rustplus.js/package.json');
    const packageDirectory = Path.dirname(packagePath);
    const protobufPath = require.resolve('protobufjs', { paths: [packageDirectory] });
    const Protobuf = require(protobufPath);
    return Protobuf.load(Path.join(packageDirectory, 'rustplus.proto'));
}

Test('Rust+ protocol accepts omitted server fields used by current servers', async () => {
    const root = await loadProtocol();
    const AppMessage = root.lookupType('rustplus.AppMessage');
    const bytes = AppMessage.encode({
        response: {
            seq: 1,
            info: {
                name: 'fixture',
                mapSize: 4500,
                players: 1,
                maxPlayers: 100
            }
        }
    }).finish();

    const decoded = AppMessage.decode(bytes);
    Assert.equal(decoded.response.info.name, 'fixture');
    Assert.equal(decoded.response.info.queuedPlayers, 0);
});

Test('Rust+ protocol preserves marker types newer than its enum', async () => {
    const root = await loadProtocol();
    const AppMessage = root.lookupType('rustplus.AppMessage');
    const bytes = AppMessage.encode({
        response: {
            seq: 2,
            mapMarkers: {
                markers: [{ id: 42, type: 9, x: 100, y: 200 }]
            }
        }
    }).finish();

    const decoded = AppMessage.decode(bytes);
    Assert.equal(decoded.response.mapMarkers.markers[0].type, 9);
});
