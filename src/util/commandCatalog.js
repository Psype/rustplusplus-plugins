/*
    Runtime command catalog parsed from docs/full_list_features.md.
*/

const Fs = require('fs');
const Path = require('path');

const COMMAND_DOC_PATH = Path.join(__dirname, '..', '..', 'docs', 'full_list_features.md');

function getCommands() {
    const section = getInGameCommandsSection();
    const commands = section.split(/\r?\n/)
        .map(line => /^- \*\*(.+?)\*\* - (.+)$/.exec(line.trim()))
        .filter(Boolean)
        .flatMap(match => expandCommandEntry(match[1], match[2]));
    const names = commands.map(command => command.name);
    if (new Set(names).size !== names.length) {
        throw new Error('Command documentation contains duplicate command names.');
    }
    return Object.freeze(commands);
}

function getCommandNames() {
    return Object.freeze(getCommands().map(command => command.name));
}

function getCommand(commandName) {
    if (!commandName) return null;

    const normalized = normalizeCommandName(commandName);
    const commands = getCommands();
    return commands.find(command => command.name === normalized) ||
        commands.find(command => command.aliases.includes(normalized)) || null;
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
    return aliases.map(name => Object.freeze({
        name: name,
        aliases: Object.freeze(aliases.filter(alias => alias !== name)),
        usage: getUsage(name, details.usages),
        description: details.description
    }));
}

function getUsage(name, documentedUsages) {
    return documentedUsages.find(usage => normalizeCommandName(usage) === name) ||
        documentedUsages[0] || `!${name}`;
}

function parseDescription(description) {
    const value = description.trim();
    const separator = value.indexOf(' - ');
    if (separator === -1) return { usages: [], description: value };
    const synopsis = value.slice(0, separator);
    const usages = [...synopsis.matchAll(/`([^`]+)`/g)].map(match => match[1].trim());
    if (usages.length === 0) return { usages: [], description: value };

    return {
        usages,
        description: value.slice(separator + 3).trim().replace(/`([^`]+)`/g, '$1')
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

module.exports = Object.freeze({
    getCommand,
    getCommandNames,
    getCommands
});
