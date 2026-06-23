/*
    Runtime command catalog parsed from docs/full_list_features.md.
*/

const Fs = require('fs');
const Path = require('path');

const COMMAND_DOC_PATH = Path.join(__dirname, '..', '..', 'docs', 'full_list_features.md');

function getCommands() {
    const section = getInGameCommandsSection();
    return section.split(/\r?\n/)
        .map(line => /^- \*\*(.+?)\*\* - (.+)$/.exec(line.trim()))
        .filter(Boolean)
        .flatMap(match => expandCommandEntry(match[1], match[2]));
}

function getCommandNames() {
    return getCommands().map(command => command.name);
}

function getCommand(commandName) {
    if (!commandName) return null;

    const normalized = normalizeCommandName(commandName);
    return getCommands().find(command => command.name === normalized || command.aliases.includes(normalized)) || null;
}

function getInGameCommandsSection() {
    if (!Fs.existsSync(COMMAND_DOC_PATH)) return '';

    const content = Fs.readFileSync(COMMAND_DOC_PATH, 'utf8');
    const match = /## In-Game and Discord Commands\s+([\s\S]*?)(?:\n## |$)/.exec(content);
    return match ? match[1] : '';
}

function expandCommandEntry(rawCommand, description) {
    const aliases = rawCommand.split('/').map(part => normalizeCommandName(part)).filter(Boolean);
    const details = parseDescription(description);
    return aliases.map(name => ({
        name: name,
        aliases: aliases.filter(alias => alias !== name),
        usage: getUsage(rawCommand, name, details.usage),
        description: details.description
    }));
}

function getUsage(rawCommand, name, documentedUsage) {
    if (documentedUsage && normalizeCommandName(documentedUsage) === name) return documentedUsage;

    const optionalSyntax = /\[(.+?)\]/.exec(rawCommand);
    if (optionalSyntax && normalizeCommandName(rawCommand) === name) return `!${rawCommand}`;
    return `!${name}`;
}

function parseDescription(description) {
    const match = /^`(.+?)`\s+-\s+(.+)$/.exec(description.trim());
    if (!match) return { usage: null, description: description.trim() };

    return {
        usage: match[1].trim(),
        description: match[2].trim()
    };
}

function normalizeCommandName(commandName) {
    return commandName.toString()
        .trim()
        .toLowerCase()
        .replace(/^!/, '')
        .replace(/\s.*$/, '')
        .replace(/\[.*$/, '');
}

module.exports = {
    getCommand,
    getCommandNames,
    getCommands
};
