/*
    Capability gate for commands whose only live input was Rust+ map markers.

    Facepunch stopped exposing event and vending-machine markers through the
    public Rust+ stream in the 2026-08-06 Power Trip update. Keep the historical
    handlers available for a future restoration, but never serve stale state.
*/

const DISABLED_COMMANDS = Object.freeze([
    Object.freeze({ syntaxKey: 'commandSyntaxCargo', fallback: 'cargo' }),
    Object.freeze({ syntaxKey: 'commandSyntaxChinook', fallback: 'chinook' }),
    Object.freeze({ syntaxKey: 'commandSyntaxDeepsea', fallback: 'deepsea' }),
    Object.freeze({ syntaxKey: 'commandSyntaxEvents', fallback: 'events' }),
    Object.freeze({ syntaxKey: 'commandSyntaxHeli', fallback: 'heli' }),
    Object.freeze({ syntaxKey: 'commandSyntaxHiddenVendingTime', fallback: 'hvt' }),
    Object.freeze({ syntaxKey: 'commandSyntaxHiddenVendors', fallback: 'hv' }),
    Object.freeze({ syntaxKey: 'commandSyntaxHiddenWaterVendors', fallback: 'hvw' }),
    Object.freeze({ syntaxKey: 'commandSyntaxLarge', fallback: 'large' }),
    Object.freeze({ syntaxKey: 'commandSyntaxMarket', fallback: 'market' }),
    Object.freeze({ syntaxKey: 'commandSyntaxSmall', fallback: 'small' }),
    Object.freeze({ syntaxKey: 'commandSyntaxTravelingVendor', fallback: 'vendor' })
]);

const DISABLED_SLASH_COMMANDS = Object.freeze(['market']);
const DISABLED_NOTIFICATION_SETTINGS = Object.freeze([
    'cargoShipDetectedSetting',
    'cargoShipLeftSetting',
    'cargoShipEgressSetting',
    'cargoShipDockingAtHarborSetting',
    'patrolHelicopterDetectedSetting',
    'patrolHelicopterLeftSetting',
    'patrolHelicopterDestroyedSetting',
    'lockedCrateOilRigUnlockedSetting',
    'heavyScientistCalledSetting',
    'chinook47DetectedSetting',
    'travelingVendorDetectedSetting',
    'travelingVendorHaltedSetting',
    'travelingVendorLeftSetting',
    'vendingMachineDetectedSetting',
    'deepseaDetectedSetting',
    'deepseaLeftSetting'
]);
const DISABLED_DISCORD_OPTIONS = Object.freeze([
    'customTimers',
    'eventInformation',
    'itemAvailableInVendingMachineNotifyInGame'
]);
const DISCORD_CAPABILITY_UI_VERSION = 1;

function commandMatches(context, definition) {
    const syntaxes = new Set([definition.fallback]);
    for (const locale of ['en', context.guildId]) {
        try {
            const syntax = context.client.intlGet(locale, definition.syntaxKey);
            if (typeof syntax === 'string' && syntax !== '') syntaxes.add(syntax);
        }
        catch (_error) {
            /* The English fallback still makes the capability gate fail closed. */
        }
    }

    for (const syntax of syntaxes) {
        const expected = `${context.prefix}${syntax}`.toLowerCase();
        if (context.commandLowerCase === expected || context.commandLowerCase.startsWith(`${expected} `)) {
            return true;
        }
    }
    return false;
}

function handleCommand(context) {
    if (!DISABLED_COMMANDS.some(definition => commandMatches(context, definition))) {
        return Object.freeze({ handled: false });
    }

    let unavailable = 'Unavailable';
    try {
        const localized = context.client.intlGet(context.guildId, 'unavailable');
        if (typeof localized === 'string' && localized !== '') unavailable = localized;
    }
    catch (_error) {
        /* Keep the command disabled even if localization is unavailable. */
    }

    return Object.freeze({
        handled: true,
        response: `Rust+ map API: ${unavailable}.`,
        logType: 'MapMarkerCapability'
    });
}

function isSlashCommandEnabled(commandName) {
    return !DISABLED_SLASH_COMMANDS.includes(`${commandName}`.toLowerCase());
}

function isNotificationSettingEnabled(settingName) {
    return !DISABLED_NOTIFICATION_SETTINGS.includes(`${settingName}`);
}

function isDiscordOptionEnabled(optionName) {
    return !DISABLED_DISCORD_OPTIONS.includes(`${optionName}`);
}

module.exports = Object.freeze({
    getDisabledCommandNames: () => Object.freeze(DISABLED_COMMANDS.map(command => command.fallback)),
    getDisabledDiscordOptionNames: () => DISABLED_DISCORD_OPTIONS,
    getDisabledNotificationSettingNames: () => DISABLED_NOTIFICATION_SETTINGS,
    getDisabledSyntaxKeys: () => Object.freeze(DISABLED_COMMANDS.map(command => command.syntaxKey)),
    getDiscordCapabilityUiVersion: () => DISCORD_CAPABILITY_UI_VERSION,
    handleCommand,
    isDiscordOptionEnabled,
    isNotificationSettingEnabled,
    isSlashCommandEnabled
});
