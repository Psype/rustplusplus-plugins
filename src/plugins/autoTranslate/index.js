const Fs = require('fs');
const Path = require('path');
const Translate = require('translate');

const Languages = require('../../util/languages.js');
const LanguageDetector = require('../../util/languageDetector.js');

const CONFIG_DIR = Path.join(__dirname, '..', '..', '..', 'config');
const SETTINGS_PATH = Path.join(CONFIG_DIR, 'autotranslate-settings.json');
const LEGACY_SETTINGS_PATH = Path.join(__dirname, '..', '..', '..', 'data', 'autotranslate-settings.json');
const DEFAULT_SETTINGS = { enabled: false, targets: ['en'] };

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
    if (!['on', 'off'].includes(action)) return { error: 'usage' };
    if (action === 'off') return setSettings(rustplus, { enabled: false, targets: getSettings(rustplus).targets });

    const targetText = args.join(' ').trim() || 'en';
    const targets = targetText.split(',').map(resolveLanguage).filter(Boolean);
    if (targets.length === 0) return { error: 'language' };
    return setSettings(rustplus, { enabled: true, targets: [...new Set(targets)] });
}

async function translateMessage(rustplus, message) {
    const settings = getSettings(rustplus);
    if (!settings.enabled) return null;

    const source = LanguageDetector.detectLanguage(message.message);
    const target = chooseTarget(source, settings.targets);
    if (!target || target === source) return null;

    try {
        const translated = source ? await Translate(message.message, { from: source, to: target }) :
            await Translate(message.message, target);
        if (!translated || translated.trim() === message.message.trim()) return null;
        return { source, target, translated };
    }
    catch (e) {
        return null;
    }
}

function chooseTarget(source, targets) {
    if (!Array.isArray(targets) || targets.length === 0) return null;
    if (source && targets.includes(source) && targets.length > 1) return targets.find(target => target !== source);
    return targets[0];
}

function resolveLanguage(value) {
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
function normalizeSettings(settings) { return { ...DEFAULT_SETTINGS, ...(settings || {}) }; }

module.exports = { getSettings, parseCommand, translateMessage };
