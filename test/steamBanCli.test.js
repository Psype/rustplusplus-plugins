'use strict';

const Assert = require('node:assert/strict');
const Path = require('node:path');
const Test = require('node:test');

const Cli = require('../tools/steam-ban-scanner.js');

Test('Steam ban CLI accepts a forced bounded WarBandits run', () => {
    const values = Cli.parseArguments([
        'run', '--warbandits-server', 'eu5xnobps', '--warbandits-top', '500', '--days', '5',
        '--delay-ms', '20000', '--cache-hours', '72', '--force'
    ]);
    Assert.equal(values.command, 'run');
    Assert.equal(values.warBanditsServer, 'eu5xnobps');
    Assert.equal(values.warBanditsTop, 500);
    Assert.equal(values.days, 5);
    Assert.equal(values.delayMs, 20000);
    Assert.equal(values.cacheHours, 72);
    Assert.equal(values.force, true);
});

Test('Steam ban CLI rejects unknown options and incomplete values', () => {
    Assert.throws(() => Cli.parseArguments(['scan', '--unknown']), /Unknown option/u);
    Assert.throws(() => Cli.parseArguments(['scan', '--days']), /requires an integer/u);
});

Test('terminal output strips player-controlled control characters', () => {
    Assert.equal(Cli.terminalText('name\u001b[31m\nnext'), 'name [31m next');
});

Test('scanner output cannot be placed in the canonical intelligence directory', () => {
    const source = Path.resolve('data/player-intelligence');
    Assert.throws(() => Cli.assertSafeOutput(source, source), /outside data\/player-intelligence/u);
    Assert.throws(() => Cli.assertSafeOutput(source, Path.join(source, 'scanner')), /outside/u);
    Assert.doesNotThrow(() => Cli.assertSafeOutput(source, Path.resolve('data/steam-ban-scanner')));
});
