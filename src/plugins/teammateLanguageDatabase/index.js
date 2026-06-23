/*
    Independent teammate language CSV database plugin.

    Silently records observed teammate Steam IDs, nicknames, observation dates,
    and a non-overwriting two-character language/country hint.
*/

const Fs = require('fs');
const Path = require('path');

const DATA_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'teammate-language-database');
const CSV_HEADER = ['steamid', 'date', 'name', 'language'];
const UNKNOWN_LANGUAGE = 'XX';

function recordTeamInfo(rustplus, teamInfo) {
    if (!teamInfo || !Array.isArray(teamInfo.members)) return;

    for (const member of teamInfo.members) {
        recordPlayer(rustplus, {
            steamId: member.steamId,
            name: member.name
        });
    }
}

function recordTeamMessage(rustplus, teamMessage) {
    if (!teamMessage) return;

    recordPlayer(rustplus, {
        steamId: teamMessage.steamId,
        name: teamMessage.name,
        language: guessLanguage(teamMessage.message)
    });
}

function recordManual(rustplus, steamId, name) {
    return recordPlayer(rustplus, {
        steamId: steamId,
        name: name
    });
}

function getKnownPseudonyms(rustplus, steamId) {
    const normalizedSteamId = normalizeSteamId(steamId);
    if (!normalizedSteamId) return [];

    const csvPath = getCsvPath(rustplus);
    const seen = new Set();
    return readRows(csvPath)
        .filter(row => row.steamid === normalizedSteamId && row.name)
        .filter(row => {
            if (seen.has(row.name)) return false;
            seen.add(row.name);
            return true;
        })
        .map(row => ({
            name: row.name,
            date: row.date,
            language: row.language || UNKNOWN_LANGUAGE
        }));
}

function recordPlayer(rustplus, player) {
    const steamId = normalizeSteamId(player.steamId);
    const name = normalizeName(player.name);
    if (!steamId || !name) return;

    ensureDataDir();
    const csvPath = getCsvPath(rustplus);
    const rows = readRows(csvPath);
    const existingLanguage = getLanguageForSteamId(rows, steamId);
    const language = existingLanguage || normalizeLanguage(player.language) || UNKNOWN_LANGUAGE;
    const lastRow = getLastRowForSteamId(rows, steamId);

    if (lastRow && lastRow.name === name) {
        if (lastRow.language === UNKNOWN_LANGUAGE && language !== UNKNOWN_LANGUAGE) {
            lastRow.language = language;
            writeRows(csvPath, rows);
        }
        return lastRow;
    }

    rows.push({
        steamid: steamId,
        date: new Date().toISOString(),
        name: name,
        language: language
    });
    writeRows(csvPath, rows);
    return rows[rows.length - 1];
}

function getCsvPath(rustplus) {
    const guildId = rustplus && rustplus.guildId ? rustplus.guildId : 'unknown-guild';
    const serverId = rustplus && rustplus.serverId ? rustplus.serverId : 'unknown-server';
    return Path.join(DATA_DIR, `${sanitizeFilePart(guildId)}-${sanitizeFilePart(serverId)}.csv`);
}

function ensureDataDir() {
    if (!Fs.existsSync(DATA_DIR)) Fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readRows(csvPath) {
    if (!Fs.existsSync(csvPath)) return [];

    const content = Fs.readFileSync(csvPath, 'utf8').trim();
    if (!content) return [];

    return content.split(/\r?\n/).slice(1).filter(Boolean).map(line => {
        const values = parseCsvLine(line);
        return {
            steamid: values[0] || '',
            date: values[1] || '',
            name: values[2] || '',
            language: values[3] || UNKNOWN_LANGUAGE
        };
    });
}

function writeRows(csvPath, rows) {
    const lines = [CSV_HEADER.join(',')].concat(rows.map(row => [
        row.steamid,
        row.date,
        row.name,
        row.language
    ].map(csvEscape).join(',')));
    Fs.writeFileSync(csvPath, `${lines.join('\n')}\n`);
}

function getLanguageForSteamId(rows, steamId) {
    const row = rows.find(entry => entry.steamid === steamId && entry.language && entry.language !== UNKNOWN_LANGUAGE);
    return row ? row.language : null;
}

function getLastRowForSteamId(rows, steamId) {
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].steamid === steamId) return rows[i];
    }
    return null;
}

function guessLanguage(message) {
    if (!message) return null;
    if (/\p{Script=Han}/u.test(message)) return 'zh';
    if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(message)) return 'ja';
    if (/\p{Script=Hangul}/u.test(message)) return 'ko';
    if (/\p{Script=Cyrillic}/u.test(message)) return 'ru';
    if (/\p{Script=Arabic}/u.test(message)) return 'ar';
    if (/\p{Script=Thai}/u.test(message)) return 'th';
    if (/\p{Script=Greek}/u.test(message)) return 'el';
    if (/\p{Script=Hebrew}/u.test(message)) return 'he';
    return null;
}

function normalizeSteamId(steamId) {
    if (steamId === undefined || steamId === null) return null;
    const value = steamId.toString().trim();
    return value || null;
}

function normalizeName(name) {
    if (name === undefined || name === null) return null;
    const value = name.toString().trim();
    return value || null;
}

function normalizeLanguage(language) {
    if (!language) return null;
    const value = language.toString().trim();
    return /^[a-zA-Z]{2}$/.test(value) ? value.toLowerCase() : null;
}

function sanitizeFilePart(value) {
    return value.toString().replace(/[^a-zA-Z0-9_-]/g, '_');
}

function csvEscape(value) {
    const text = value === undefined || value === null ? '' : value.toString();
    if (!/[",\n\r]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
    const values = [];
    let current = '';
    let quoted = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quoted) {
            if (char === '"' && line[i + 1] === '"') {
                current += '"';
                i++;
            }
            else if (char === '"') quoted = false;
            else current += char;
        }
        else if (char === '"') quoted = true;
        else if (char === ',') {
            values.push(current);
            current = '';
        }
        else current += char;
    }

    values.push(current);
    return values;
}

module.exports = {
    recordTeamInfo,
    recordTeamMessage,
    recordManual,
    getKnownPseudonyms,
    guessLanguage
};
