const Fs = require('fs');
const Path = require('path');

const Languages = require('../../util/languages.js');
const LanguageDetector = require('../../util/languageDetector.js');
const TeammateLanguageDatabase = require('../teammateLanguageDatabase/index.js');
const GoogleTranslator = require('./googleTranslator.js');

const CONFIG_DIR = Path.join(__dirname, '..', '..', '..', 'config');
const SETTINGS_PATH = Path.join(CONFIG_DIR, 'autotranslate-settings.json');
const LEGACY_SETTINGS_PATH = Path.join(__dirname, '..', '..', '..', 'data', 'autotranslate-settings.json');
const DEFAULT_SETTINGS = Object.freeze({ enabled: false, targets: Object.freeze(['en']) });

function getSettings(rustplus) {
    const all = readAll();
    return normalizeSettings(all[getKey(rustplus)]);
}

function setSettings(rustplus, settings) {
    const all = readAll();
    all[getKey(rustplus)] = normalizeSettings(settings);
    writeAll(all);
    return all[getKey(rustplus)];
}

function parseCommand(rustplus, command) {
    const args = command.trim().split(/\s+/).slice(1);
    const action = (args.shift() || '').toLowerCase();
    if (!['on', 'off'].includes(action)) return Object.freeze({ error: 'usage' });
    if (action === 'off') return setSettings(rustplus, { enabled: false, targets: getSettings(rustplus).targets });

    const targetText = args.join(' ').trim() || 'en';
    const targets = targetText.split(',').map(resolveLanguage).filter(Boolean);
    if (targets.length === 0) return Object.freeze({ error: 'language' });
    return setSettings(rustplus, { enabled: true, targets });
}

async function translateMessage(rustplus, message, dependencies = {}) {
    if (!message || typeof message.message !== 'string') return null;
    if (isBotOrTranslationMessage(message.message)) return null;

    const settings = dependencies.settings ? normalizeSettings(dependencies.settings) : getSettings(rustplus);
    if (!settings.enabled) return null;

    const source = await LanguageDetector.detectLanguage(message.message);
    if (!source) {
        logDecision(rustplus, message, 'SKIPPED', 'language-undetected', settings.targets);
        return null;
    }
    const knownLanguages = getKnownLanguages(rustplus, message.steamId, dependencies);
    if (!knownLanguages.includes(source)) {
        logDecision(rustplus, message, 'SKIPPED', 'source-not-declared', settings.targets, source, knownLanguages);
        return null;
    }
    const target = chooseTarget(source, settings.targets);
    if (!target || target === source) {
        logDecision(rustplus, message, 'SKIPPED', 'source-not-in-active-pair',
            settings.targets, source, knownLanguages);
        return null;
    }

    const translator = dependencies.translator || GoogleTranslator;
    if (typeof translator !== 'function') throw new TypeError('Translator must be a function.');

    const translated = await translator(message.message, { from: source, to: target });
    if (typeof translated !== 'string' || !translated.trim() || translated.trim() === message.message.trim()) {
        logDecision(rustplus, message, 'SKIPPED', 'empty-or-unchanged-translation',
            settings.targets, source, knownLanguages, target);
        return null;
    }
    logDecision(rustplus, message, 'TRANSLATED', 'ok', settings.targets, source, knownLanguages, target);
    return Object.freeze({ source, target, translated });
}

function logDecision(rustplus, message, decision, reason, targets, source = '-', knownLanguages = [], target = '-') {
    if (!rustplus || typeof rustplus.log !== 'function') return;
    const steamId = message && message.steamId !== undefined && message.steamId !== null ?
        message.steamId.toString() : 'unknown';
    rustplus.log('AUTOTRANSLATE',
        `${decision} steamId=${steamId} source=${source} player=${knownLanguages.join(';') || '-'} ` +
        `targets=${targets.join(';') || '-'} target=${target} reason=${reason}`);
}

function isBotOrTranslationMessage(message) {
    if (typeof message !== 'string') return false;
    const normalized = message.trimStart();
    return normalized.startsWith('[BOT]') || /^\[(?:→|â†’)[a-z]{2,3}\]\s*/i.test(normalized);
}

function chooseTarget(source, targets) {
    if (!Array.isArray(targets) || targets.length === 0) return null;
    if (source && targets.includes(source) && targets.length > 1) return targets.find(target => target !== source);
    if (targets.length === 1 && targets[0] !== source) return targets[0];
    return null;
}

function getKnownLanguages(rustplus, steamId, dependencies) {
    let values;
    if (Object.prototype.hasOwnProperty.call(dependencies, 'knownLanguages')) values = dependencies.knownLanguages;
    else if (Object.prototype.hasOwnProperty.call(dependencies, 'knownLanguage')) values = dependencies.knownLanguage;
    else return TeammateLanguageDatabase.getKnownLanguages(rustplus, steamId);

    const languages = Array.isArray(values) ? values :
        (values === undefined || values === null ? [] : values.toString().split(';'));
    return Object.freeze([...new Set(languages
        .map(language => language === undefined || language === null ? '' : language.toString().trim().toLowerCase())
        .filter(language => /^[a-z]{2}$/.test(language) && language !== 'xx'))]);
}

function resolveLanguage(value) {
    if (value === undefined || value === null) return null;
    const normalized = value.toString().trim().toLowerCase();
    if (/^[a-z]{2,3}$/.test(normalized)) return normalized;
    return Languages[normalized] || null;
}

function readAll() {
    migrateLegacySettings();
    if (!Fs.existsSync(SETTINGS_PATH)) return {};
    try { return JSON.parse(Fs.readFileSync(SETTINGS_PATH, 'utf8')); }
    catch (e) { return {}; }
}

function writeAll(settings) {
    if (!Fs.existsSync(CONFIG_DIR)) Fs.mkdirSync(CONFIG_DIR, { recursive: true });
    Fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 4)}\n`);
}

function migrateLegacySettings() {
    if (Fs.existsSync(SETTINGS_PATH) || !Fs.existsSync(LEGACY_SETTINGS_PATH)) return;

    Fs.mkdirSync(CONFIG_DIR, { recursive: true });
    Fs.copyFileSync(LEGACY_SETTINGS_PATH, SETTINGS_PATH);
}

function getKey(rustplus) { return `${rustplus.guildId}:${rustplus.serverId}`; }
function normalizeSettings(settings) {
    const input = settings && typeof settings === 'object' ? settings : {};
    const targets = Array.isArray(input.targets) ? input.targets
        .map(resolveLanguage)
        .filter(Boolean) : DEFAULT_SETTINGS.targets;
    return Object.freeze({
        enabled: input.enabled === true,
        targets: Object.freeze(targets.length > 0 ? [...new Set(targets)] : [...DEFAULT_SETTINGS.targets])
    });
}

module.exports = { getSettings, parseCommand, translateMessage };
