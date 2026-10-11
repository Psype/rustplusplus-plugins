// @ts-check
const Builder = require('@discordjs/builders');

const RuntimeTelemetry = require('../util/runtimeTelemetry.js');
const WORKER_STAGES = new Set([
    'idle', 'initializing', 'reading_state', 'reading_history', 'rebuilding', 'reconciling',
    'steam_profiles', 'online_players', 'warbandits', 'finalizing', 'sending_result',
    'committing', 'queued'
]);
const SAFE_WORKER_MESSAGE = /^(?:(?:Worker process (?:could not start|emitted an error|exited before commit|exceeded its deadline)|Queued worker inputs expired|Worker queue is full|Worker (?:plan|request) exceeded its size limit|Worker plan became stale before commit|Worker IPC delivery failed|Stable identity candidate input (?:exceeded its limit|was invalid))\.|Worker scan failed \([A-Z0-9_]{1,64}\)\.)(?: stderr: (?:final IPC result delivery failed|JavaScript heap out of memory|worker module not found|Node\.js assertion failure|uncaught (?:RangeError|ReferenceError|SyntaxError|TypeError)|fatal Node\.js runtime error)\.)?$/u;

/** @param {unknown} value */
function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** @param {unknown} value */
function workerStage(value) {
    return typeof value === 'string' && WORKER_STAGES.has(value) ? value : 'unknown';
}

/** @param {unknown} value */
function workerCode(value) {
    return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/u.test(value) ? value : null;
}

/** @param {unknown} value */
function workerMessage(value) {
    return typeof value === 'string' && value.length <= 180 && SAFE_WORKER_MESSAGE.test(value) ? value : null;
}

/** @param {unknown} value */
function workerDate(value) {
    return typeof value === 'string' && value.length <= 32 && !Number.isNaN(Date.parse(value)) ?
        new Date(value).toISOString() : null;
}

/** @param {any} snapshot */
function render(snapshot) {
    if (!snapshot) return 'Runtime telemetry is enabled but its first completed window is not available yet.';
    const process = snapshot.process;
    const loop = snapshot.eventLoop;
    const imports = snapshot.sources.imports;
    const ocr = snapshot.sources.ocr;
    const scans = snapshot.sources.scans;
    const translations = snapshot.sources.translations;
    const services = snapshot.sources.services || {
        active: 0, queued: 0, running: 0, restarts: 0, failures: 0, circuitOpen: 0
    };
    const loops = snapshot.sources.loops || { active: 0, running: 0, scheduled: 0, failures: 0 };
    const operations = snapshot.operations;
    const health = [];
    if (number(loop.p99Ms) >= 250) health.push('event-loop p99');
    if (number(loop.maxMs) >= 1000) health.push('event-loop max');
    if (number(process.heapLimitMiB) > 0 && number(process.heapUsedMiB) / number(process.heapLimitMiB) >= 0.75) {
        health.push('heap pressure');
    }
    if (number(snapshot.sourceFailures) > 0) health.push('metric source');
    if (number(snapshot.collectorFailures) > 0) health.push('metric collector');
    if (number(scans.workerConsecutiveFailures) > 0 || number(scans.automaticBackoffs) > 0 ||
        number(scans.workerProviderCircuitsOpen) > 0) {
        health.push('scan worker');
    }
    const operation = (/** @type {any} */ value) =>
        `${value.started} started, ${value.completed} completed (${value.success} ok, ${value.failure} failed, ` +
        `${value.timeout} timeout, ${value.skipped} skipped, ${value.dropped} dropped), ` +
        `p95 ${value.p95Ms} ms, max ${value.maxMs} ms`;
    const rebuild = (/** @type {any} */ value) =>
        `${number(value && value.completed)}/${number(value && value.p95Ms)}/${number(value && value.maxMs)}`;
    const lastWorkerCode = workerCode(scans.workerLastCode);
    const lastWorkerMessage = workerMessage(scans.workerLastMessage);
    const lastWorkerAt = workerDate(scans.workerLastAt);
    const scanWorkerDiagnostic = lastWorkerCode ?
        `Last scan worker failure: ${lastWorkerCode} at ${workerStage(scans.workerLastStage)}` +
            `${lastWorkerAt ? ` on ${lastWorkerAt}` : ''}${lastWorkerMessage ? ` - ${lastWorkerMessage}` : ''}` :
        'Last scan worker failure: none';
    return [
        `Runtime — last completed ${number(snapshot.windowMs / 1000).toFixed(1)} s window`,
        '',
        `Memory: RSS ${process.rssMiB} MiB | heap ${process.heapUsedMiB}/${process.heapTotalMiB} MiB ` +
            `(limit ${process.heapLimitMiB} MiB) | ` +
            `external ${process.externalMiB} MiB`,
        `CPU: ${process.cpuPct}% of one core | event-loop utilization ${loop.utilizationPct}%`,
        `Event loop: p95 ${loop.p95Ms} ms | p99 ${loop.p99Ms} ms | max ${loop.maxMs} ms`,
        `Work: imports ${imports.active} active, ${imports.previewsPending} previews | ` +
            `OCR ${ocr.active} active, ${ocr.queued} queued | scans ${scans.active} active, ` +
            `${scans.forcedRerunsQueued} queued, worker ${number(scans.workerActive)} active, ` +
            `${number(scans.workerQueued)} queued, ` +
            `${number(scans.workerCompleted)} completed, ${number(scans.workerFailures)} failed, ` +
            `${number(scans.workerStalePlans)} stale, ${number(scans.automaticBackoffs)} backoff, ` +
            `${number(scans.automaticBackoffSkips)} deferred | ` +
            `translations ${translations.active} active, ` +
            `${translations.queued} queued`,
        `Scan worker: stage ${workerStage(scans.workerStage)} | RSS ${number(scans.workerRssMiB)} MiB | ` +
            `heap ${number(scans.workerHeapUsedMiB)} MiB | ` +
            `${number(scans.workerConsecutiveFailures)} consecutive failures | provider RPC ` +
            `${number(scans.workerProviderInvocationsOutstanding)} pending, ` +
            `${number(scans.workerProviderCircuitsOpen)} circuits open`,
        scanWorkerDiagnostic,
        `Serial loops: ${loops.active} active, ${loops.running} running, ${loops.scheduled} scheduled, ` +
            `${loops.failures} failures`,
        `Isolated services: ${services.running} running, ${services.active} active, ${services.queued} queued, ` +
            `${services.restarts} restarts, ${services.failures} failures, circuit ${services.circuitOpen ? 'open' : 'closed'}`,
        `Translation: ${operation(operations.translation)}`,
        `OCR: run ${operation(operations.ocr_run)} | queue ${operation(operations.ocr_queue_wait)}`,
        `Imports: prepare ${operation(operations.import_prepare)} | decision ${operation(operations.import_decision)}`,
        `Scans: ${operation(operations.scan_cycle)}`,
        `PI rebuild completed/p95/max ms: total ${rebuild(operations.pi_rebuild_total)} | ` +
            `identities ${rebuild(operations.pi_rebuild_identities)} | ` +
            `metrics ${rebuild(operations.pi_rebuild_metrics)} | clans ${rebuild(operations.pi_rebuild_clans)} | ` +
            `presence ${rebuild(operations.pi_rebuild_presence)} | wipes ${rebuild(operations.pi_rebuild_wipes)} | ` +
            `journal append ${rebuild(operations.pi_history_append)}`,
        `Health: ${health.length === 0 ? 'healthy' : `degraded — ${health.join(', ')}`}`
    ].join('\n').slice(0, 1950);
}

module.exports = Object.freeze({
    name: 'runtime',

    getData() {
        return new Builder.SlashCommandBuilder()
            .setName('runtime')
            .setDescription('Show aggregate bot runtime health without player or message data.');
    },

    /** @param {any} client @param {any} interaction @param {{telemetry?:any}} [dependencies] */
    async execute(client, interaction, dependencies = {}) {
        await interaction.deferReply({ ephemeral: true });
        if (!client.isAdministrator(interaction)) {
            return client.interactionEditReply(interaction, {
                content: client.intlGet(interaction.guildId, 'missingPermission'),
                allowedMentions: { parse: [] }
            });
        }
        const telemetry = dependencies.telemetry || RuntimeTelemetry;
        const content = telemetry.isEnabled() ? render(telemetry.getLastSnapshot()) :
            'Runtime telemetry is disabled by configuration.';
        return client.interactionEditReply(interaction, { content, allowedMentions: { parse: [] } });
    },

    render
});
