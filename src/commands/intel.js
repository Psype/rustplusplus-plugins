// @ts-check
const Builder = require('@discordjs/builders');

const Runtime = require('../plugins/playerIntelligence/runtime.js');
const Scrape = require('../util/scrape.js');

const PAGE_SIZE = 12;

/** @param {any} client @param {any} interaction */
function contextFor(client, interaction) {
    const instance = client.getInstance(interaction.guildId);
    const rustplus = client.rustplusInstances && client.rustplusInstances[interaction.guildId] || {
        serverId: instance && instance.activeServer,
        isOperational: false,
        generalSettings: { inGameCommandsEnabled: false },
        log: (/** @type {any[]} */ ...values) => client.log('PLAYER_INTELLIGENCE', values.join(' '), 'warn')
    };
    return Object.freeze({
        client,
        guildId: interaction.guildId,
        rustplus,
        playerIntelligenceDependencies: client.playerIntelligenceDependencies || {}
    });
}

/** @param {unknown} value @param {number} maximum */
function truncate(value, maximum) {
    const characters = Array.from(`${value || ''}`);
    return characters.length <= maximum ? characters.join('') : `${characters.slice(0, maximum - 3).join('')}...`;
}

/** @param {any} client @param {any} interaction @param {string} content */
function editReply(client, interaction, content) {
    return client.interactionEditReply(interaction, {
        content: truncate(content, 1950),
        allowedMentions: { parse: [] }
    });
}

/** @param {readonly any[]} values @param {number} requestedPage @param {(value:any,index:number)=>string} render
 * @param {string} title @param {string} empty */
function paginated(values, requestedPage, render, title, empty) {
    if (values.length === 0) return empty;
    const pages = Math.ceil(values.length / PAGE_SIZE);
    const page = Math.min(Math.max(1, requestedPage), pages);
    const offset = (page - 1) * PAGE_SIZE;
    const rows = values.slice(offset, offset + PAGE_SIZE).map((value, index) => render(value, offset + index));
    return `${title} - ${values.length} - page ${page}/${pages}\n${rows.join('\n')}`;
}

/** @param {unknown} reason */
function failure(reason) {
    const key = `${reason || 'unknown'}`;
    /** @type {Record<string,string>} */
    const messages = {
        'invalid-alias': 'Alias is invalid.',
        'invalid-steamid': 'SteamID64 is invalid.',
        'invalid-target-name': 'A verified display name is required.',
        'alias-not-found': 'That exact alias does not exist in the local intelligence history.',
        'alias-has-other-steamid': 'That alias is already verified against another SteamID; nothing changed.',
        'already-linked': 'That exact reconciliation is already active.',
        'link-not-found': 'No active reconciliation exists for that exact alias.',
        'invalid-target': 'Merge target is invalid.',
        'target-not-found': 'Merge target was not found among verified local identities.',
        'target-ambiguous': 'Merge target is ambiguous; use its SteamID64 instead.',
        'target-without-steamid': 'Merge target has no verified SteamID64 yet.'
    };
    return messages[key] || `Identity correction failed safely: ${key}.`;
}

/** @param {any} client @param {string} steamId */
async function steamProfileName(client, steamId) {
    const dependencies = client.playerIntelligenceAdminDependencies || {};
    const lookup = dependencies.steamProfileName ||
        ((/** @type {string} */ value) => Scrape.scrapeSteamProfileName(client, value));
    const value = await lookup(steamId);
    const name = `${value || ''}`.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
    return name && Array.from(name).length <= 128 ? name : null;
}

/** @param {any} client @param {any} interaction @param {any} context */
async function link(client, interaction, context) {
    const alias = `${interaction.options.getString('alias') || ''}`;
    const steamId = `${interaction.options.getString('steamid') || ''}`;
    if (!/^7656119\d{10}$/u.test(`${steamId || ''}`)) {
        return editReply(client, interaction, failure('invalid-steamid'));
    }
    const existing = /** @type {any} */ (await Runtime.resolveIdentityTarget(context, steamId));
    const fromSteam = await steamProfileName(client, steamId);
    const verifiedLocalName = existing.person && existing.person.names.some(
        (/** @type {any} */ value) => value.verified) ? existing.displayName : null;
    const targetName = fromSteam || verifiedLocalName;
    if (!targetName) {
        return editReply(client, interaction,
            'Steam profile name is unavailable and no Steam/API-verified local name exists. Nothing changed.');
    }
    const targetNameSource = fromSteam ? 'steam-profile' : 'verified-history';
    const result = /** @type {any} */ (await Runtime.linkIdentityAlias(context, {
        alias,
        targetSteamId: steamId,
        targetName,
        targetNameSource,
        actorId: interaction.user?.id || interaction.member?.user?.id || 'unknown'
    }));
    if (!result.changed) return editReply(client, interaction, failure(result.reason));
    const source = fromSteam ? 'current Steam profile' : 'verified local history';
    return editReply(client, interaction,
        `Reconciled ${JSON.stringify(result.alias)} -> Steam:${result.targetSteamId}.\n` +
        `Current display: ${JSON.stringify(result.targetName)} (${source}).\n` +
        `${result.affectedSnapshots} historical confirmed capture(s) reprojected. The source OCR spelling is ` +
        'preserved as correction evidence but excluded from verified alias history.');
}

/** @param {any} client @param {any} interaction @param {any} context */
async function merge(client, interaction, context) {
    const alias = `${interaction.options.getString('alias') || ''}`;
    const targetQuery = `${interaction.options.getString('target') || ''}`;
    const target = /** @type {any} */ (await Runtime.resolveIdentityTarget(context, targetQuery));
    if (!target.person) return editReply(client, interaction, failure(target.reason));
    const fromSteam = await steamProfileName(client, target.steamId);
    const verifiedNames = target.person.names.filter((/** @type {any} */ value) => value.verified)
        .sort((/** @type {any} */ left, /** @type {any} */ right) =>
            `${right.lastVerifiedAt || right.lastObservedAt}`.localeCompare(
                `${left.lastVerifiedAt || left.lastObservedAt}`));
    const targetName = fromSteam || target.requestedAlias || verifiedNames[0]?.name || null;
    if (!targetName) {
        return editReply(client, interaction,
            'Steam profile name is unavailable and the target has no Steam/API-verified alias. Nothing changed.');
    }
    const targetNameSource = fromSteam ? 'steam-profile' : 'verified-history';
    const result = /** @type {any} */ (await Runtime.linkIdentityAlias(context, {
        alias,
        targetSteamId: target.steamId,
        targetName,
        targetNameSource,
        actorId: interaction.user?.id || interaction.member?.user?.id || 'unknown'
    }));
    if (!result.changed) return editReply(client, interaction, failure(result.reason));
    const source = fromSteam ? 'current Steam profile' : 'verified local history';
    return editReply(client, interaction,
        `Merged pending alias ${JSON.stringify(result.alias)} into ${JSON.stringify(result.targetName)} ` +
        `(Steam:${result.targetSteamId}; display from ${source}).\n` +
        `${result.affectedSnapshots} historical confirmed capture(s) reprojected. Verified aliases: ${
            result.verifiedAliases.map((/** @type {string} */ name) => JSON.stringify(name)).join(', ')}.\n` +
        'The pending OCR spelling is not promoted into alias history.');
}

module.exports = Object.freeze({
    name: 'intel',

    getData() {
        return new Builder.SlashCommandBuilder()
            .setName('intel')
            .setDescription('Review and reconcile local player-intelligence identities.')
            .addSubcommand((/** @type {Builder.SlashCommandSubcommandBuilder} */ command) => command
                .setName('pending').setDescription('List aliases which still have no verified SteamID64.')
                .addIntegerOption((/** @type {Builder.SlashCommandIntegerOption} */ option) => option
                    .setName('page').setDescription('Result page, starting at 1.').setRequired(false)))
            .addSubcommand((/** @type {Builder.SlashCommandSubcommandBuilder} */ command) => command
                .setName('links').setDescription('List active reversible alias reconciliations.')
                .addIntegerOption((/** @type {Builder.SlashCommandIntegerOption} */ option) => option
                    .setName('page').setDescription('Result page, starting at 1.').setRequired(false)))
            .addSubcommand((/** @type {Builder.SlashCommandSubcommandBuilder} */ command) => command
                .setName('history').setDescription('List only verified aliases for one identity.')
                .addStringOption((/** @type {Builder.SlashCommandStringOption} */ option) => option
                    .setName('target').setDescription('Verified exact alias, SteamID64, or BattleMetrics ID.')
                    .setRequired(true))
                .addIntegerOption((/** @type {Builder.SlashCommandIntegerOption} */ option) => option
                    .setName('page').setDescription('Result page, starting at 1.').setRequired(false)))
            .addSubcommand((/** @type {Builder.SlashCommandSubcommandBuilder} */ command) => command
                .setName('link').setDescription('Attach one exact pending alias to a SteamID64.')
                .addStringOption((/** @type {Builder.SlashCommandStringOption} */ option) => option
                    .setName('alias').setDescription('Exact pending OCR alias.').setRequired(true))
                .addStringOption((/** @type {Builder.SlashCommandStringOption} */ option) => option
                    .setName('steamid').setDescription('Target SteamID64.').setRequired(true)))
            .addSubcommand((/** @type {Builder.SlashCommandSubcommandBuilder} */ command) => command
                .setName('merge').setDescription('Merge one exact pending alias into a verified identity.')
                .addStringOption((/** @type {Builder.SlashCommandStringOption} */ option) => option
                    .setName('alias').setDescription('Exact pending OCR alias.').setRequired(true))
                .addStringOption((/** @type {Builder.SlashCommandStringOption} */ option) => option
                    .setName('target').setDescription('Verified exact alias, SteamID64, or BattleMetrics ID.')
                    .setRequired(true)))
            .addSubcommand((/** @type {Builder.SlashCommandSubcommandBuilder} */ command) => command
                .setName('unlink').setDescription('Revoke an alias reconciliation without deleting history.')
                .addStringOption((/** @type {Builder.SlashCommandStringOption} */ option) => option
                    .setName('alias').setDescription('Exact reconciled alias.').setRequired(true)));
    },

    async execute(/** @type {any} */ client, /** @type {any} */ interaction) {
        await interaction.deferReply({ ephemeral: true });
        const verifyId = Math.floor(100000 + Math.random() * 900000);
        client.logInteraction(interaction, verifyId, 'slashCommand');
        if (!client.isAdministrator(interaction)) {
            const message = client.intlGet(interaction.guildId, 'missingPermission');
            return editReply(client, interaction, message);
        }
        const context = contextFor(client, interaction);
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'pending') {
            const values = await Runtime.listPendingAliases(context);
            const page = interaction.options.getInteger('page') || 1;
            const aliasCount = values.reduce((/** @type {number} */ total, /** @type {any} */ value) =>
                total + value.aliases.length, 0);
            return editReply(client, interaction, paginated(values, page, value => {
                const otherAliases = value.aliases.filter((/** @type {string} */ alias) => alias !== value.name);
                const shownAliases = otherAliases.slice(0, 2).map((/** @type {string} */ alias) =>
                    JSON.stringify(truncate(alias, 36)));
                const aliasText = shownAliases.length === 0 ? '' : ` - aliases: ${shownAliases.join(', ')}${
                    otherAliases.length > shownAliases.length ? `, +${otherAliases.length - shownAliases.length}` : ''}`;
                return `- ${JSON.stringify(truncate(value.name, 80))}${aliasText} - ${value.snapshotCount} capture(s) - ${
                    value.battlemetricsPlayerIds.length > 0 ? `BM:${value.battlemetricsPlayerIds.join(',')}` :
                        'name only'} - last ${value.lastObservedAt.slice(0, 10)}`;
            }, `Pending identities without SteamID64 (${aliasCount} aliases)`,
            'No known identity is currently waiting for a SteamID64.'));
        }
        if (subcommand === 'links') {
            const values = await Runtime.listIdentityLinks(context);
            const page = interaction.options.getInteger('page') || 1;
            return editReply(client, interaction, paginated(values, page, value =>
                `- ${JSON.stringify(truncate(value.exactName, 70))} -> ${
                    JSON.stringify(truncate(value.targetName || value.targetPersonId, 70))} (${value.targetPersonId})`,
            'Active identity reconciliations', 'No manual identity reconciliation is active.'));
        }
        if (subcommand === 'history') {
            const target = /** @type {any} */ (await Runtime.resolveIdentityTarget(
                context, `${interaction.options.getString('target') || ''}`));
            if (!target.person) return editReply(client, interaction, failure(target.reason));
            const values = target.person.names.filter((/** @type {any} */ alias) => alias.verified)
                .sort((/** @type {any} */ left, /** @type {any} */ right) =>
                    `${right.lastVerifiedAt || right.lastObservedAt}`.localeCompare(
                        `${left.lastVerifiedAt || left.lastObservedAt}`));
            const page = interaction.options.getInteger('page') || 1;
            return editReply(client, interaction, paginated(values, page, value =>
                `- ${JSON.stringify(truncate(value.name, 80))} - first ${value.firstObservedAt.slice(0, 10)} ` +
                    `- last ${(value.lastVerifiedAt || value.lastObservedAt).slice(0, 10)}`,
            `Verified alias history for ${target.displayName} (Steam:${target.steamId})`,
            'No verified alias exists for that identity.'));
        }
        if (subcommand === 'link') return link(client, interaction, context);
        if (subcommand === 'merge') return merge(client, interaction, context);
        if (subcommand === 'unlink') {
            const result = /** @type {any} */ (await Runtime.unlinkIdentityAlias(context, {
                alias: `${interaction.options.getString('alias') || ''}`,
                actorId: interaction.user?.id || interaction.member?.user?.id || 'unknown'
            }));
            return editReply(client, interaction, result.changed ?
                `Revoked ${result.revoked} reconciliation link(s) for ${JSON.stringify(result.alias)}. ` +
                    'Raw observations were preserved and the projection returned to its evidence-only state.' :
                failure(result.reason));
        }
        return editReply(client, interaction, 'Unsupported player-intelligence operation.');
    }
});
