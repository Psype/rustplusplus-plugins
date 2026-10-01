// @ts-check
const Builder = require('@discordjs/builders');

const ImportWorkflow = require('../plugins/playerIntelligence/importWorkflow.js');

/** @param {string} name @param {string} description */
function imageSubcommand(name, description) {
    return (/** @type {Builder.SlashCommandSubcommandBuilder} */ subcommand) =>
        subcommand.setName(name).setDescription(description)
        .addAttachmentOption((/** @type {Builder.SlashCommandAttachmentOption} */ option) => option.setName('image')
            .setDescription('Original PNG, JPEG, or WebP screenshot.').setRequired(true));
}

module.exports = Object.freeze({
    name: 'intelimport',

    getData() {
        return new Builder.SlashCommandBuilder()
            .setName('intelimport')
            .setDescription('Preview and confirm a player-intelligence screenshot import.')
            .addSubcommand(imageSubcommand('cinfo', 'Import a WarBandits /cinfo screenshot.'))
            .addSubcommand(imageSubcommand('f7', 'Import a Rust F7 recent-player screenshot.'));
    },

    execute: (/** @type {any} */ client, /** @type {any} */ interaction) =>
        ImportWorkflow.beginImport(client, interaction)
});
