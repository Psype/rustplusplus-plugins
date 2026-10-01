const Assert = require('node:assert/strict');
const Test = require('node:test');

const PackageMetadata = require('../package.json');
const ApplicationVersion = require('../src/util/applicationVersion.js');

Test('operational announcement uses the canonical package version', () => {
    Assert.equal(ApplicationVersion.version, PackageMetadata.version);
    Assert.equal(ApplicationVersion.operationalMessage,
        `RUSTPLUS v${PackageMetadata.version} OPERATIONAL.`);
    Assert.equal(Object.isFrozen(ApplicationVersion), true);
});
