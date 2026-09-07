/* Custom commands added by this fork, isolated from upstream command handlers. */

const AutoTranslate = require('../autoTranslate');
const CommandCatalog = require('../../util/commandCatalog.js');
const DeepSea = require('../deepSea');
const HiddenVendors = require('../hiddenVendors');
const LoggingSettings = require('../../util/loggingSettings.js');
const TeammateLanguageDatabase = require('../teammateLanguageDatabase');

function result(response, logType = 'Plugin') {
    return Object.freeze({ handled: true, response, logType });
}

function matches(context, syntaxKey, mode = 'optional') {
    const syntaxes = [
        context.client.intlGet('en', syntaxKey),
        context.client.intlGet(context.guildId, syntaxKey)
    ];

    return syntaxes.some(syntax => {
        const expected = `${context.prefix}${syntax}`.toLowerCase();
        if (mode === 'exact') return context.commandLowerCase === expected;
        if (mode === 'args') return context.commandLowerCase.startsWith(`${expected} `);
        return context.commandLowerCase === expected || context.commandLowerCase.startsWith(`${expected} `);
    });
}

async function handleCommand(context) {
    if (matches(context, 'commandSyntaxDeepsea', 'exact')) {
        DeepSea.install(context.rustplus, context.client);
        return result(DeepSea.formatCommand(context.rustplus));
    }
    if (matches(context, 'commandSyntaxHiddenVendors')) {
        return result(HiddenVendors.getCommandHiddenVendors(context.rustplus, context.client));
    }
    if (matches(context, 'commandSyntaxHiddenWaterVendors')) {
        return result(HiddenVendors.getCommandHiddenWaterVendors(context.rustplus, context.client));
    }
    if (matches(context, 'commandSyntaxHiddenVendingTime')) {
        return result(HiddenVendors.getCommandHiddenVendingTime(context.rustplus, context.client));
    }
    if (matches(context, 'commandSyntaxLanguage')) {
        return result(getCommandLanguage(context));
    }
    if (matches(context, 'commandSyntaxRecord')) {
        return result(getCommandRecord(context));
    }
    if (matches(context, 'commandSyntaxWho')) {
        return result(getCommandWho(context));
    }
    if (matches(context, 'commandSyntaxLogs')) {
        return result(getCommandLogs(context));
    }
    if (matches(context, 'commandSyntaxCommands')) {
        return result(getCommandCommands(context));
    }
    if (matches(context, 'commandSyntaxAutoTranslate', 'args')) {
        return result(getCommandAutoTranslate(context));
    }

    return Object.freeze({ handled: false });
}

function getCommandLogs(context) {
    const action = getArgs(context.command)[1] || 'status';
    const enabledActions = [
        context.client.intlGet('en', 'commandSyntaxOn'),
        context.client.intlGet(context.guildId, 'commandSyntaxOn'),
        'enable', 'enabled'
    ];
    const disabledActions = [
        context.client.intlGet('en', 'commandSyntaxOff'),
        context.client.intlGet(context.guildId, 'commandSyntaxOff'),
        'disable', 'disabled'
    ];

    if (enabledActions.includes(action)) {
        LoggingSettings.setEnabled(true);
        return context.client.intlGet(context.guildId, 'logsEnabled');
    }
    if (disabledActions.includes(action)) {
        LoggingSettings.setEnabled(false);
        return context.client.intlGet(context.guildId, 'logsDisabled');
    }
    return context.client.intlGet(context.guildId,
        LoggingSettings.isEnabled() ? 'logsCurrentlyEnabled' : 'logsCurrentlyDisabled');
}

function getCommandLanguage(context) {
    const LanguageSettings = require('../../util/languageSettings.js');
    const language = LanguageSettings.normalizeLanguage(getArgs(context.command)[1] || '');
    if (language === '') {
        const instance = context.client.getInstance(context.guildId);
        return context.client.intlGet(context.guildId, 'languageCurrentlySet', {
            language: instance.generalSettings.language,
            languages: LanguageSettings.getSupportedLanguages().join(', ')
        });
    }
    if (!LanguageSettings.isSupportedLanguage(language)) {
        return context.client.intlGet(context.guildId, 'languageNotSupportedWithList', {
            language,
            languages: LanguageSettings.getSupportedLanguages().join(', ')
        });
    }
    LanguageSettings.setLanguage(context.client, context.guildId, language);
    return context.client.intlGet(context.guildId, 'setBotLanguageConfigUpdated', { language });
}

function getCommandRecord(context) {
    const parsed = parseRecordCommand(context.command);
    if (!parsed) return context.client.intlGet(context.guildId, 'recordUsage');
    TeammateLanguageDatabase.recordManual(context.rustplus, parsed.steamId, parsed.name);
    return context.client.intlGet(context.guildId, 'recordSaved', {
        steamid: parsed.steamId,
        name: parsed.name
    });
}

function getCommandWho(context) {
    const steamId = getArgs(context.command)[1];
    if (!steamId) return context.client.intlGet(context.guildId, 'whoUsage');
    const pseudonyms = TeammateLanguageDatabase.getKnownPseudonyms(context.rustplus, steamId);
    if (pseudonyms.length === 0) {
        return context.client.intlGet(context.guildId, 'whoNoPseudonyms', { steamid: steamId });
    }
    return context.client.intlGet(context.guildId, 'whoPseudonyms', {
        steamid: steamId,
        names: pseudonyms.map(entry => `${entry.name} (${entry.date}) [${entry.language}]`).join(', ')
    });
}

function getCommandCommands(context) {
    const commandName = getArgs(context.command)[1];
    if (!commandName) {
        return context.client.intlGet(context.guildId, 'commandsList', {
            commands: CommandCatalog.getCommandNames().join(', ')
        });
    }
    const commandDetails = CommandCatalog.getCommand(commandName);
    if (!commandDetails) {
        return context.client.intlGet(context.guildId, 'commandsUnknown', { command: commandName });
    }
    return context.client.intlGet(context.guildId, 'commandsUsage', {
        command: commandDetails.name,
        usage: commandDetails.usage,
        description: commandDetails.description
    });
}

function getCommandAutoTranslate(context) {
    const parsed = AutoTranslate.parseCommand(context.rustplus, context.command);
    if (parsed.error === 'usage') return context.client.intlGet(context.guildId, 'autotranslateUsage');
    if (parsed.error === 'language') return context.client.intlGet(context.guildId, 'autotranslateLanguageNotFound');
    if (parsed.enabled) {
        return context.client.intlGet(context.guildId, 'autotranslateEnabled', {
            languages: parsed.targets.join(',')
        });
    }
    return context.client.intlGet(context.guildId, 'autotranslateDisabled');
}

function getArgs(command) {
    return command.trim().split(/\s+/).map(value => value.toLowerCase());
}

function parseRecordCommand(command) {
    const match = /^\S+\s+(\S+)\s+([\s\S]+)$/.exec(command.trim());
    if (!match) return null;
    const steamId = match[1].trim();
    const name = match[2].trim();
    return steamId && name ? Object.freeze({ steamId, name }) : null;
}

module.exports = Object.freeze({ handleCommand });
