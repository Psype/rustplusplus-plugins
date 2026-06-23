const Fs = require('fs');
const Path = require('path');

const LOG_DIR = Path.join(process.cwd(), 'logs');
const SETTINGS_PATH = Path.join(LOG_DIR, 'logging-settings.json');

let enabled = true;
let loaded = false;

function load() {
    if (loaded) return;
    loaded = true;
    try {
        if (!Fs.existsSync(SETTINGS_PATH)) return;
        const settings = JSON.parse(Fs.readFileSync(SETTINGS_PATH, 'utf8'));
        if (typeof settings.enabled === 'boolean') enabled = settings.enabled;
    }
    catch (_e) {
        enabled = true;
    }
}

function save() {
    Fs.mkdirSync(LOG_DIR, { recursive: true });
    Fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ enabled: enabled }, null, 2));
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
