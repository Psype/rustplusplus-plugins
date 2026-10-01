// @ts-check
const PackageMetadata = require('../../package.json');

const version = `${PackageMetadata.version || ''}`;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('package.json contains an invalid application version.');
}

module.exports = Object.freeze({
    operationalMessage: `RUSTPLUS v${version} OPERATIONAL.`,
    version
});
