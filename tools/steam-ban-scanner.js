// @ts-check
'use strict';

require('dotenv').config({ quiet: true });

const Path = require('node:path');

const SteamBanApi = require('../src/util/steamBanApi.js');
const SteamBanExport = require('../src/util/steamBanExport.js');
const SteamBanScan = require('../src/util/steamBanScan.js');
const WarBanditsLeaderboard = require('../src/util/warBanditsLeaderboard.js');

const ROOT = Path.join(__dirname, '..');
const DEFAULT_DATA_ROOT = Path.join(ROOT, 'data', 'player-intelligence');
const DEFAULT_OUTPUT = Path.join(ROOT, 'data', 'steam-ban-scanner');

function usage() {
    return [
        'Usage:',
        '  npm run steam-bans -- export [options]',
        '  npm run steam-bans -- scan [options]',
        '  npm run steam-bans -- run [options]',
        '',
        'Options:',
        '  --days N              Recent-ban threshold (default: 5).',
        '  --delay-ms N          Minimum delay between Steam calls (default: 15000).',
        '  --batch-size N        SteamIDs per ban call, 1-100 (default: 25).',
        '  --max-ids N           Scan only the N highest-priority IDs; 0 means all (default: 0).',
        '  --min-wipes N         Require at least N distinct server/wipe scopes (default: 0).',
        '  --min-observations N  Require at least N local observations (default: 1).',
        '  --warbandits-server S Export only the all-time top for this server slug (example: eu5xnobps).',
        '  --warbandits-top N     Number of ranked players, 1-10000 (default: 300).',
        '  --warbandits-delay-ms N  Delay between leaderboard pages (default: 5000).',
        '  --cache-hours N        Reuse Steam and WarBandits results for N hours (default: 24; 0 disables).',
        '  --data-root PATH      Player-intelligence root (default: data/player-intelligence).',
        '  --output PATH         Scanner output directory (default: data/steam-ban-scanner).',
        '  --restart             Start a new immutable scan run when options/snapshot changed.',
        '  --force               Always start a fresh run and ignore every prior scan result.',
        '',
        'Environment:',
        '  RPP_STEAM_WEB_API_KEY is required for scan/run and is never written to output.'
    ].join('\n');
}

/** @param {unknown} value */
function terminalText(value) {
    return `${value ?? ''}`.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** @param {string} dataRoot @param {string} outputDirectory */
function assertSafeOutput(dataRoot, outputDirectory) {
    const source = Path.resolve(dataRoot);
    const output = Path.resolve(outputDirectory);
    const relative = Path.relative(source, output);
    if (relative === '' || (!relative.startsWith(`..${Path.sep}`) && relative !== '..' &&
        !Path.isAbsolute(relative))) {
        throw new Error('Scanner output must stay outside data/player-intelligence.');
    }
}

/** @param {string[]} argv */
function parseArguments(argv) {
    const command = argv[0] || '';
    if (!['export', 'scan', 'run'].includes(command)) throw new Error(usage());
    /** @type {any} */
    const values = {
        command,
        days: 5,
        delayMs: 15_000,
        batchSize: 25,
        maxIds: 0,
        minWipes: 0,
        minObservations: 1,
        warBanditsServer: null,
        warBanditsTop: 300,
        warBanditsDelayMs: 5000,
        cacheHours: 24,
        dataRoot: DEFAULT_DATA_ROOT,
        outputDirectory: DEFAULT_OUTPUT,
        restart: false,
        force: false
    };
    const numeric = new Map([
        ['--days', 'days'], ['--delay-ms', 'delayMs'], ['--batch-size', 'batchSize'],
        ['--max-ids', 'maxIds'], ['--min-wipes', 'minWipes'], ['--min-observations', 'minObservations'],
        ['--warbandits-top', 'warBanditsTop'], ['--warbandits-delay-ms', 'warBanditsDelayMs'],
        ['--cache-hours', 'cacheHours']
    ]);
    for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--restart') {
            values.restart = true;
            continue;
        }
        if (argument === '--force') {
            values.force = true;
            continue;
        }
        if (argument === '--data-root' || argument === '--output') {
            const next = argv[++index];
            if (!next) throw new Error(`${argument} requires a path.\n\n${usage()}`);
            if (argument === '--data-root') values.dataRoot = Path.resolve(next);
            else values.outputDirectory = Path.resolve(next);
            continue;
        }
        if (argument === '--warbandits-server') {
            const next = argv[++index];
            if (!next) throw new Error(`${argument} requires a server slug.\n\n${usage()}`);
            values.warBanditsServer = next;
            continue;
        }
        const key = numeric.get(argument);
        if (key) {
            const next = argv[++index];
            if (next === undefined || !/^-?\d+$/u.test(next)) {
                throw new Error(`${argument} requires an integer.\n\n${usage()}`);
            }
            values[key] = Number(next);
            continue;
        }
        throw new Error(`Unknown option: ${argument}\n\n${usage()}`);
    }
    return Object.freeze(values);
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    assertSafeOutput(options.dataRoot, options.outputDirectory);
    let stop = false;
    const stopHandler = () => {
        stop = true;
        process.stdout.write('Stop requested; finishing the current batch and preserving progress.\n');
    };
    process.once('SIGINT', stopHandler);
    process.once('SIGTERM', stopHandler);
    try {
        if (options.command === 'export' || options.command === 'run') {
            let exported;
            if (options.warBanditsServer) {
                const leaderboard = await WarBanditsLeaderboard.fetchLeaderboard({
                    server: options.warBanditsServer,
                    top: options.warBanditsTop,
                    delayMs: options.warBanditsDelayMs,
                    cacheDirectory: Path.join(options.outputDirectory, 'warbandits-cache'),
                    cacheMaxAgeMs: options.cacheHours * 60 * 60 * 1000,
                    force: options.force,
                    onPage: (/** @type {any} */ value) => process.stdout.write(
                        `WarBandits leaderboard page ${value.page}/${value.pages}: ${value.rows} row(s) ` +
                        `[${value.cached ? 'cache' : 'live'}].\n`),
                    onRetry: (/** @type {any} */ value) => process.stdout.write(
                        `WarBandits page ${value.page}: HTTP ${value.status ?? 'error'}, retry ${value.attempt} ` +
                        `in ${value.delayMs}ms.\n`)
                });
                exported = await SteamBanExport.writeIdentitySnapshot(leaderboard.rows, {
                    outputDirectory: options.outputDirectory,
                    source: 'warbandits-all-time-leaderboard',
                    sourceRoot: `https://warbandits.gg/en/leaderboards/${leaderboard.server}`
                });
            }
            else {
                exported = await SteamBanExport.exportIdentities({
                    dataRoot: options.dataRoot,
                    outputDirectory: options.outputDirectory,
                    onDatabase: (/** @type {any} */ value) => process.stdout.write(
                        `Exporting database ${value.index}/${value.total}: ${value.directory}\n`)
                });
            }
            process.stdout.write(`Exported ${exported.rows.length} prioritized SteamID64 values to ` +
                `${options.outputDirectory}.\n`);
        }
        if (options.command === 'scan' || options.command === 'run') {
            const client = SteamBanApi.createClient();
            const result = await SteamBanScan.scan({
                ...options,
                client,
                stopRequested: () => stop,
                onMatch: (/** @type {any} */ value) => process.stdout.write([
                    'MATCH',
                    `Steam:${value.steamId}`,
                    `name:${terminalText(value.steamName || value.localDisplayName || 'unknown')}`,
                    `last-ban:${value.daysSinceLastBan}d`,
                    `game-bans:${value.numberOfGameBans}`,
                    `VAC-bans:${value.numberOfVacBans}`,
                    `Steam-Rust:${value.steamRustHours ?? 'unknown'}h`,
                    `WB:${value.warBanditsHoursMax ?? 'unknown'}h`,
                    value.profileUrl
                ].join(' | ') + '\n'),
                onProgress: (/** @type {any} */ value) => process.stdout.write(
                    `Steam bans: ${value.checked}/${value.total} checked; ${value.matches} recent candidate(s).\n`),
                onRetry: (/** @type {any} */ value) => process.stdout.write(
                    `Steam ${value.operation}: HTTP ${value.status ?? 'error'}, retry ${value.attempt} ` +
                    `in ${value.delayMs}ms.\n`)
            });
            process.stdout.write(`${result.completed ? 'Scan complete' : 'Scan paused'}: ${result.checked}/` +
                `${result.total}; ${result.matches} candidate(s).\nCSV: ${result.reportCsv}\nJSONL: ${result.reportJsonl}\n`);
        }
    }
    finally {
        process.removeListener('SIGINT', stopHandler);
        process.removeListener('SIGTERM', stopHandler);
    }
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
        process.exitCode = 1;
    });
}

module.exports = Object.freeze({
    DEFAULT_DATA_ROOT,
    DEFAULT_OUTPUT,
    assertSafeOutput,
    parseArguments,
    terminalText,
    usage
});
