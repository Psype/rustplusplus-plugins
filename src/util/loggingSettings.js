const Fs = require('fs');
const Path = require('path');

const CONFIG_DIR = Path.join(process.cwd(), 'config');
const SETTINGS_PATH = Path.join(CONFIG_DIR, 'logging-settings.json');
const LEGACY_SETTINGS_PATH = Path.join(process.cwd(), 'logs', 'logging-settings.json');

let enabled = true;
let loaded = false;

function load() {
    if (loaded) return;
    loaded = true;
    try {
        migrateLegacySettings();
        if (!Fs.existsSync(SETTINGS_PATH)) return;
        const settings = JSON.parse(Fs.readFileSync(SETTINGS_PATH, 'utf8'));
        if (typeof settings.enabled === 'boolean') enabled = settings.enabled;
    }
    catch (_e) {
        enabled = true;
    }
}

function save() {
    Fs.mkdirSync(CONFIG_DIR, { recursive: true });
    Fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ enabled: enabled }, null, 2));
}

function migrateLegacySettings() {
    if (Fs.existsSync(SETTINGS_PATH) || !Fs.existsSync(LEGACY_SETTINGS_PATH)) return;

    Fs.mkdirSync(CONFIG_DIR, { recursive: true });
    Fs.copyFileSync(LEGACY_SETTINGS_PATH, SETTINGS_PATH);
}

module.exports = {
    isEnabled: function () {
        load();
        return enabled;
    },

    setEnabled: function (value) {
        loaded = true;
        enabled = value;
        save();
        return enabled;
    }
};
