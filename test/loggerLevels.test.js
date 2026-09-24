const Assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const Test = require('node:test');

const files = [
    '../src/handlers/pollingHandler.js',
    '../src/handlers/teamChatHandler.js',
    '../src/structures/RustPlus.js',
    '../src/util/eventDebugLogger.js'
];

Test('runtime warning paths use Winston warn instead of the unknown warning level', () => {
    for (const file of files) {
        const source = Fs.readFileSync(Path.join(__dirname, file), 'utf8');
        Assert.doesNotMatch(source, /,\s*['"]warning['"]\s*\)/, file);
    }
});
