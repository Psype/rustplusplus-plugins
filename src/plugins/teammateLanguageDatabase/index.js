/*
    Independent teammate language CSV database plugin.

    Silently records observed teammate Steam IDs, nicknames, observation dates,
    and a non-overwriting two-character language/country hint.
*/

const Fs = require('fs');
const Path = require('path');
const LanguageDetector = require('../../util/languageDetector.js');

const DATA_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'teammate-language-database');
const CSV_HEADER = ['steamid', 'date', 'name', 'language'];
const UNKNOWN_LANGUAGE = 'XX';
const LANGUAGE_SEPARATOR = ';';

function recordTeamInfo(rustplus, teamInfo) {
    if (!teamInfo || !Array.isArray(teamInfo.members)) return;

    for (const member of teamInfo.members) {
        recordPlayer(rustplus, {
            steamId: member.steamId,
            name: member.name
        });
    }
}

async function recordTeamMessage(rustplus, teamMessage) {
    if (!teamMessage) return;

    recordPlayer(rustplus, {
        steamId: teamMessage.steamId,
        name: teamMessage.name,
        language: await LanguageDetector.detectLanguage(teamMessage.message)
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
    const rows = readRows(csvPath);
    const language = serializeLanguages(getLanguagesForSteamId(rows, normalizedSteamId));
    const seen = new Set();
    return rows
        .filter(row => row.steamid === normalizedSteamId && row.name)
        .filter(row => {
            if (seen.has(row.name)) return false;
            seen.add(row.name);
            return true;
        })
        .map(row => ({
            name: row.name,
            date: row.date,
            language: language
        }));
}

function getKnownLanguage(rustplus, steamId) {
    return getKnownLanguages(rustplus, steamId)[0] || null;
}

function getKnownLanguages(rustplus, steamId) {
    const normalizedSteamId = normalizeSteamId(steamId);
    if (!normalizedSteamId) return Object.freeze([]);

    const csvPath = getCsvPath(rustplus);
    const rows = readRows(csvPath);

    return getLanguagesForSteamId(rows, normalizedSteamId);
}

function recordPlayer(rustplus, player) {
    const steamId = normalizeSteamId(player.steamId);
    const name = normalizeName(player.name);
    if (!steamId || !name) return;

    ensureDataDir();
    const csvPath = getCsvPath(rustplus);
    const rows = readRows(csvPath);
    const existingLanguages = getLanguagesForSteamId(rows, steamId);
    const candidateLanguages = normalizeLanguages(player.language);
    const languages = existingLanguages.length === 0 ? candidateLanguages : existingLanguages;
    const language = serializeLanguages(languages);
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
            language: serializeLanguages(normalizeLanguages(values[3]))
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

function getLanguagesForSteamId(rows, steamId) {
    const row = getLatestRowForSteamId(rows, steamId);
    return row ? normalizeLanguages(row.language) : Object.freeze([]);
}

function getLatestRowForSteamId(rows, steamId) {
    let latestRow = null;
    let latestTimestamp = Number.NEGATIVE_INFINITY;
    let hasValidTimestamp = false;

    for (const row of rows) {
        if (row.steamid !== steamId) continue;
        const timestamp = Date.parse(row.date);
        if (!Number.isFinite(timestamp)) {
            if (!hasValidTimestamp) latestRow = row;
            continue;
        }
        if (!hasValidTimestamp || timestamp >= latestTimestamp) {
            latestRow = row;
            latestTimestamp = timestamp;
            hasValidTimestamp = true;
        }
    }
    return latestRow;
}

function getLastRowForSteamId(rows, steamId) {
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].steamid === steamId) return rows[i];
    }
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

function normalizeLanguages(languages) {
    const values = Array.isArray(languages) ? languages :
        (languages === undefined || languages === null ? [] : languages.toString().split(LANGUAGE_SEPARATOR));
    const normalized = values.map(normalizeLanguage).filter(language => language && language !== 'xx');
    return Object.freeze([...new Set(normalized)]);
}

function serializeLanguages(languages) {
    return languages.length > 0 ? languages.join(LANGUAGE_SEPARATOR) : UNKNOWN_LANGUAGE;
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
    getKnownLanguage,
    getKnownLanguages
};
