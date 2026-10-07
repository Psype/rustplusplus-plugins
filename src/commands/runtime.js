// @ts-check
const Builder = require('@discordjs/builders');

const RuntimeTelemetry = require('../util/runtimeTelemetry.js');

/** @param {unknown} value */
function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
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
    const operations = snapshot.operations;
    const health = [];
    if (number(loop.p99Ms) >= 250) health.push('event-loop p99');
    if (number(loop.maxMs) >= 1000) health.push('event-loop max');
    if (number(process.heapLimitMiB) > 0 && number(process.heapUsedMiB) / number(process.heapLimitMiB) >= 0.75) {
        health.push('heap pressure');
    }
    if (number(snapshot.sourceFailures) > 0) health.push('metric source');
    if (number(snapshot.collectorFailures) > 0) health.push('metric collector');
    const operation = (/** @type {any} */ value) =>
        `${value.started} started, ${value.completed} completed (${value.success} ok, ${value.failure} failed, ` +
        `${value.timeout} timeout, ${value.skipped} skipped, ${value.dropped} dropped), ` +
        `p95 ${value.p95Ms} ms, max ${value.maxMs} ms`;
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
            `${scans.forcedRerunsQueued} queued | translations ${translations.active} active`,
        `Translation: ${operation(operations.translation)}`,
        `OCR: run ${operation(operations.ocr_run)} | queue ${operation(operations.ocr_queue_wait)}`,
        `Imports: prepare ${operation(operations.import_prepare)} | decision ${operation(operations.import_decision)}`,
        `Scans: ${operation(operations.scan_cycle)}`,
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
