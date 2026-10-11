'use strict';

const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Test = require('node:test');

const root = Path.join(__dirname, '..');

Test('production starts native Node without retaining ts-node or the TypeScript compiler', () => {
    const packageJson = JSON.parse(Fs.readFileSync(Path.join(root, 'package.json'), 'utf8'));
    const bridge = Fs.readFileSync(Path.join(root, 'index.ts'), 'utf8');
    const entrypoint = Fs.readFileSync(Path.join(root, 'index.js'), 'utf8');

    Assert.equal(packageJson.main, 'index.js');
    Assert.equal(packageJson.scripts.start, 'node .');
    Assert.doesNotMatch(packageJson.scripts.start, /ts-node|typescript/u);
    Assert.match(bridge, /module\.exports = \{ client: null \}/u);
    Assert.match(entrypoint, /Application\.client = client/u);
    Assert.doesNotMatch(entrypoint, /:\s*(?:string|number|boolean|unknown|any)\b/u);
});
