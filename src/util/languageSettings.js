const Fs = require('fs');
const Path = require('path');

const Config = require('../../config');
const InstanceUtils = require('./instanceUtils.js');

const LANGUAGE_DIR = Path.join(__dirname, '..', 'languages');
const CONFIG_PATH = Path.join(__dirname, '..', '..', 'config', 'index.js');

function normalizeLanguage(language) {
    return (language || '').trim().toLowerCase();
}

function getSupportedLanguages() {
    return Fs.readdirSync(LANGUAGE_DIR)
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''))
        .sort();
}

function isSupportedLanguage(language) {
    return getSupportedLanguages().includes(language);
}

function updateConfigLanguage(language) {
    Config.general.language = language;

    const config = Fs.readFileSync(CONFIG_PATH, 'utf8');
    const nextConfig = config.replace(
        /(language:\s*process\.env\.RPP_LANGUAGE\s*\|\|\s*)['"][^'"]+['"]/, `$1'${language}'`);

    if (nextConfig === config) return false;
    Fs.writeFileSync(CONFIG_PATH, nextConfig);
    return true;
}

function setLanguage(client, guildId, language) {
    language = normalizeLanguage(language);
    if (!isSupportedLanguage(language)) return false;

    let instance = client.getInstance(guildId) || InstanceUtils.readInstanceFile(guildId);
    instance.generalSettings.language = language;
    client.setInstance(guildId, instance);

    const rustplus = client.rustplusInstances[guildId];
    if (rustplus) rustplus.generalSettings.language = language;

    updateConfigLanguage(language);
    client.loadBotIntl();
    client.loadGuildIntl(guildId);

    return true;
}

module.exports = {
    getSupportedLanguages: getSupportedLanguages,
    isSupportedLanguage: function (language) {
        return isSupportedLanguage(normalizeLanguage(language));
    },
    normalizeLanguage: normalizeLanguage,
    setLanguage: setLanguage,
    updateConfigLanguage: updateConfigLanguage
};
