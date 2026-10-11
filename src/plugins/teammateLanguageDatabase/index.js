/*
    Independent player identity and teammate-language CSV database plugin.

    Silently records observed player Steam IDs, BattleMetrics IDs, nicknames,
    observation dates, and a non-overwriting two-character language hint.
*/

const Fs = require('fs');
const Path = require('path');
const Crypto = require('node:crypto');
const LanguageDetector = require('../../util/languageDetector.js');
const BoundedTtlCache = require('../../util/boundedTtlCache.js');

const DATA_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'teammate-language-database');
const CSV_HEADER = ['steamid', 'battlemetrics_id', 'date', 'name', 'language'];
const LEGACY_CSV_HEADER = ['steamid', 'date', 'name', 'language'];
const UNKNOWN_LANGUAGE = 'XX';
const LANGUAGE_SEPARATOR = ';';
const ROW_CACHE_MAX_ENTRIES = 16;
const ROW_CACHE_TTL_MS = 10 * 60 * 1000;
// Identity history is durable, but its rebuildable in-memory view must remain finite. Oversized files are never
// truncated or rewritten: reads/writes fail before parsing or modifying their contents.
const CSV_FILE_MAX_BYTES = 8 * 1024 * 1024;
const CSV_FILE_MAX_ROWS = 10000;
const ROW_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const ROW_CACHE_MAX_ROWS = 40000;
const IDENTITY_ROWS_MAX_LIMIT = 10000;
const READ_CHUNK_BYTES = 64 * 1024;
const LIMIT_WARNING_MAX_ENTRIES = 64;
const LIMIT_WARNING_TTL_MS = 60 * 60 * 1000;
const EMPTY_ROWS = Object.freeze([]);
/** @type {Map<string,{signature:string,rows:readonly any[],bytes:number,rowCount:number,expiresAt:number}>} */
const rowCache = new Map();
let retainedCacheBytes = 0;
let retainedCacheRows = 0;
const limitWarningTimes = BoundedTtlCache.createBoundedTtlCache({
    maxEntries: LIMIT_WARNING_MAX_ENTRIES, defaultTtlMs: LIMIT_WARNING_TTL_MS
});

class IdentityCsvLimitError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'IdentityCsvLimitError';
        this.code = code;
    }
}

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

function recordIdentity(rustplus, identity) {
    if (!identity || typeof identity !== 'object') return;
    return recordPlayer(rustplus, {
        steamId: identity.steamId,
        name: identity.name,
        observedAt: identity.observedAt,
        battlemetricsId: identity.battlemetricsPlayerId,
        allowBlankLanguage: true
    });
}

function getKnownPseudonyms(rustplus, steamId) {
    const normalizedSteamId = normalizeSteamId(steamId);
    if (!normalizedSteamId) return [];

    const csvPath = getCsvPath(rustplus);
    const rows = readRowsOptional(csvPath, rustplus);
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
    const rows = readRowsOptional(csvPath, rustplus);

    return getLanguagesForSteamId(rows, normalizedSteamId);
}

function getIdentityRows(rustplus, options = {}) {
    const suppliedLimit = options && options.limit;
    const recentLimit = suppliedLimit === undefined ? null : Number(suppliedLimit);
    if (recentLimit !== null && (!Number.isSafeInteger(recentLimit) || recentLimit < 1 ||
        recentLimit > IDENTITY_ROWS_MAX_LIMIT)) {
        throw new TypeError(`Identity row limit must be between 1 and ${IDENTITY_ROWS_MAX_LIMIT}.`);
    }
    const rows = readRowsOptional(getCsvPath(rustplus), rustplus, options.onWarning);
    const identities = [];
    let invalidRows = 0;
    const start = recentLimit === null ? 0 : rows.length - 1;
    const end = recentLimit === null ? rows.length : -1;
    const step = recentLimit === null ? 1 : -1;
    for (let index = start; index !== end; index += step) {
        const row = rows[index];
        const steamId = normalizeSteamId(row.steamid);
        const battlemetricsPlayerId = normalizeStoredBattlemetricsId(row.battlemetrics_id);
        const name = normalizeName(row.name);
        const observedAt = new Date(row.date);
        if (!steamId || !name || Number.isNaN(observedAt.getTime())) {
            invalidRows += 1;
            continue;
        }
        if (recentLimit === null || identities.length < recentLimit) {
            identities.push(Object.freeze({
                steamId,
                battlemetricsPlayerId: battlemetricsPlayerId || null,
                name,
                observedAt: observedAt.toISOString()
            }));
        }
    }
    if (invalidRows > 0 && typeof options.onWarning === 'function') {
        try { options.onWarning('Player identity CSV contained rows that could not be projected completely.'); }
        catch (_error) { /* Completeness callbacks are diagnostic-only. */ }
    }
    return Object.freeze(identities);
}

function recordPlayer(rustplus, player) {
    const steamId = normalizeSteamId(player.steamId);
    const name = normalizeName(player.name);
    if (!steamId || !name) return;

    const csvPath = getCsvPath(rustplus);
    let rows;
    try {
        ensureDataDir();
        rows = readRows(csvPath);
    }
    catch (error) {
        reportCsvLimit(csvPath, rustplus, error);
        return;
    }
    const existingLanguages = getLanguagesForSteamId(rows, steamId);
    const candidateLanguages = normalizeLanguages(player.language);
    const languages = existingLanguages.length === 0 ? candidateLanguages : existingLanguages;
    const language = languages.length > 0 ? languages.join(LANGUAGE_SEPARATOR) :
        (player.allowBlankLanguage ? '' : UNKNOWN_LANGUAGE);
    const candidateBattlemetricsId = validateBattlemetricsId(player.battlemetricsId);
    const existingBattlemetricsId = getBattlemetricsIdForSteamId(rows, steamId);
    const battlemetricsId = candidateBattlemetricsId || existingBattlemetricsId || '';
    const lastRow = getLastRowForSteamId(rows, steamId);

    if (lastRow && lastRow.name === name &&
        (!candidateBattlemetricsId || lastRow.battlemetrics_id === battlemetricsId)) {
        const replacement = { ...lastRow };
        let changed = false;
        if (normalizeLanguages(lastRow.language).length === 0 && languages.length > 0) {
            replacement.language = language;
            changed = true;
        }
        if (!lastRow.battlemetrics_id && battlemetricsId) {
            replacement.battlemetrics_id = battlemetricsId;
            changed = true;
        }
        if (changed) {
            const updatedRows = rows.slice();
            updatedRows[updatedRows.lastIndexOf(lastRow)] = replacement;
            try { writeRows(csvPath, updatedRows); }
            catch (error) {
                reportCsvLimit(csvPath, rustplus, error);
                return;
            }
        }
        return changed ? replacement : lastRow;
    }

    const added = {
        steamid: steamId,
        battlemetrics_id: battlemetricsId,
        date: normalizeObservedAt(player.observedAt),
        name: name,
        language: language
    };
    try { writeRows(csvPath, rows.concat(added)); }
    catch (error) {
        reportCsvLimit(csvPath, rustplus, error);
        return;
    }
    return added;
}

function getCsvPath(rustplus) {
    const guildId = rustplus && rustplus.guildId ? rustplus.guildId : 'unknown-guild';
    const serverId = rustplus && rustplus.serverId ? rustplus.serverId : 'unknown-server';
    return Path.join(DATA_DIR, `${sanitizeFilePart(guildId)}-${sanitizeFilePart(serverId)}.csv`);
}

function ensureDataDir() {
    if (!Fs.existsSync(DATA_DIR)) Fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileMetadata(csvPath) {
    const stat = Fs.statSync(csvPath, { bigint: true });
    if (!stat.isFile()) throw new Error(`Player identity CSV path is not a file: ${csvPath}`);
    if (stat.size > BigInt(CSV_FILE_MAX_BYTES)) {
        throw new IdentityCsvLimitError('IDENTITY_CSV_TOO_LARGE',
            `Player identity CSV exceeds the ${CSV_FILE_MAX_BYTES}-byte safety limit; file left unchanged.`);
    }
    return Object.freeze({
        signature: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
        bytes: Number(stat.size)
    });
}

function freezeRows(rows) {
    return Object.freeze(rows.map(row => Object.freeze(row)));
}

function parseRows(content) {
    const trimmed = content.trim();
    if (!trimmed) return EMPTY_ROWS;

    const lines = trimmed.split(/\r?\n/);
    if (lines.length - 1 > CSV_FILE_MAX_ROWS) {
        throw new IdentityCsvLimitError('IDENTITY_CSV_TOO_MANY_ROWS',
            `Player identity CSV exceeds the ${CSV_FILE_MAX_ROWS}-row safety limit; file left unchanged.`);
    }
    const header = parseCsvLine(lines[0]).map(value => value.trim().toLowerCase());
    const currentSchema = header.join(',') === CSV_HEADER.join(',');
    const legacySchema = header.join(',') === LEGACY_CSV_HEADER.join(',');
    if (!currentSchema && !legacySchema) {
        throw new Error(`Unsupported player identity CSV header: ${lines[0]}`);
    }

    return freezeRows(lines.slice(1).filter(Boolean).map(line => {
        const values = parseCsvLine(line);
        return {
            steamid: values[0] || '',
            battlemetrics_id: currentSchema ? normalizeStoredBattlemetricsId(values[1]) : '',
            date: values[currentSchema ? 2 : 1] || '',
            name: values[currentSchema ? 3 : 2] || '',
            language: normalizeStoredLanguage(values[currentSchema ? 4 : 3])
        };
    }));
}

/** @param {string} key */
function deleteCachedRows(key) {
    const cached = rowCache.get(key);
    if (!cached) return false;
    rowCache.delete(key);
    retainedCacheBytes = Math.max(0, retainedCacheBytes - cached.bytes);
    retainedCacheRows = Math.max(0, retainedCacheRows - cached.rowCount);
    return true;
}

/** @param {number} now */
function pruneRowCache(now) {
    for (const [key, cached] of rowCache) {
        if (cached.expiresAt > now) continue;
        deleteCachedRows(key);
    }
}

/** @param {string} key */
function cachedRows(key) {
    const now = Date.now();
    pruneRowCache(now);
    const cached = rowCache.get(key);
    if (!cached) return null;
    rowCache.delete(key);
    rowCache.set(key, cached);
    return cached;
}

/** @param {string} key @param {string} signature @param {readonly any[]} rows @param {number} bytes */
function cacheRows(key, signature, rows, bytes) {
    const rowCount = rows.length;
    const now = Date.now();
    pruneRowCache(now);
    deleteCachedRows(key);
    while (rowCache.size >= ROW_CACHE_MAX_ENTRIES || retainedCacheBytes + bytes > ROW_CACHE_MAX_BYTES ||
        retainedCacheRows + rowCount > ROW_CACHE_MAX_ROWS) {
        const oldest = rowCache.keys().next();
        if (oldest.done) break;
        deleteCachedRows(oldest.value);
    }
    // Per-file admission guarantees this in normal operation; retain the guard so changed constants cannot make
    // an entry exceed a global budget. The parsed result remains usable for this call without being cached.
    if (bytes > ROW_CACHE_MAX_BYTES || rowCount > ROW_CACHE_MAX_ROWS) return;
    rowCache.set(key, Object.freeze({
        signature, rows, bytes, rowCount, expiresAt: now + ROW_CACHE_TTL_MS
    }));
    retainedCacheBytes += bytes;
    retainedCacheRows += rowCount;
}

/**
 * Read through a fixed-size descriptor buffer after stat admission. A concurrent grow can therefore never make
 * this process allocate more than CSV_FILE_MAX_BYTES, and row count is rejected before UTF-8 decoding/parsing.
 * @param {string} csvPath @param {{signature:string,bytes:number}} expected
 */
function readBoundedCsv(csvPath, expected) {
    const descriptor = Fs.openSync(csvPath, 'r');
    let buffer;
    try {
        const opened = fileMetadataFromDescriptor(descriptor);
        if (opened.signature !== expected.signature) {
            throw new Error('Player identity CSV changed while it was being opened.');
        }
        buffer = Buffer.allocUnsafe(opened.bytes);
        let offset = 0;
        let lineFeeds = 0;
        while (offset < buffer.length) {
            const length = Math.min(READ_CHUNK_BYTES, buffer.length - offset);
            const read = Fs.readSync(descriptor, buffer, offset, length, offset);
            if (read <= 0) throw new Error('Player identity CSV changed while it was being read.');
            for (let index = offset; index < offset + read; index += 1) {
                if (buffer[index] === 0x0a) lineFeeds += 1;
            }
            if (lineFeeds > CSV_FILE_MAX_ROWS + 1) {
                throw new IdentityCsvLimitError('IDENTITY_CSV_TOO_MANY_ROWS',
                    `Player identity CSV exceeds the ${CSV_FILE_MAX_ROWS}-row safety limit; file left unchanged.`);
            }
            offset += read;
        }
        const physicalLines = lineFeeds + (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a ? 1 : 0);
        if (physicalLines > CSV_FILE_MAX_ROWS + 1) {
            throw new IdentityCsvLimitError('IDENTITY_CSV_TOO_MANY_ROWS',
                `Player identity CSV exceeds the ${CSV_FILE_MAX_ROWS}-row safety limit; file left unchanged.`);
        }
        if (fileMetadataFromDescriptor(descriptor).signature !== expected.signature) {
            throw new Error('Player identity CSV changed while it was being read.');
        }
    }
    finally {
        Fs.closeSync(descriptor);
    }
    if (fileMetadata(csvPath).signature !== expected.signature) {
        throw new Error('Player identity CSV changed while it was being read.');
    }
    return buffer.toString('utf8');
}

/** @param {number} descriptor */
function fileMetadataFromDescriptor(descriptor) {
    const stat = Fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) throw new Error('Player identity CSV descriptor is not a file.');
    if (stat.size > BigInt(CSV_FILE_MAX_BYTES)) {
        throw new IdentityCsvLimitError('IDENTITY_CSV_TOO_LARGE',
            `Player identity CSV exceeds the ${CSV_FILE_MAX_BYTES}-byte safety limit; file left unchanged.`);
    }
    return Object.freeze({
        signature: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
        bytes: Number(stat.size)
    });
}

function readRows(csvPath) {
    const key = Path.resolve(csvPath);
    let metadata;
    try {
        metadata = fileMetadata(csvPath);
    }
    catch (error) {
        if (error && error.code === 'ENOENT') {
            deleteCachedRows(key);
            return EMPTY_ROWS;
        }
        throw error;
    }

    const cached = cachedRows(key);
    if (cached && cached.signature === metadata.signature) return cached.rows;
    deleteCachedRows(key);

    const rows = parseRows(readBoundedCsv(csvPath, metadata));
    cacheRows(key, metadata.signature, rows, metadata.bytes);
    return rows;
}

function reportCsvLimit(csvPath, rustplus, error, onWarning) {
    const code = error && typeof error.code === 'string' ? error.code : 'IDENTITY_CSV_LIMIT';
    const fingerprint = Crypto.createHash('sha256').update(`${Path.resolve(csvPath)}\0${code}`).digest('hex');
    const message = `Player identity CSV was ignored safely (${code}); durable data was left unchanged.`;
    // The callback is also a completeness signal: callers must see it on every failed read even while the
    // user-facing fallback log remains rate-limited.
    if (typeof onWarning === 'function') {
        try { onWarning(message); }
        catch (_error) { /* Optional diagnostics must not turn a bounded read failure into a bot failure. */ }
        return;
    }
    if (limitWarningTimes.has(fingerprint)) return;
    limitWarningTimes.set(fingerprint, true);
    try {
        if (rustplus && typeof rustplus.log === 'function') {
            rustplus.log('TEAMMATE_LANGUAGE_DATABASE', message, 'warn');
        }
    }
    catch (_error) { /* Optional diagnostics must never turn a bounded read failure into a bot failure. */ }
}

function readRowsOptional(csvPath, rustplus, onWarning) {
    try { return readRows(csvPath); }
    catch (error) {
        reportCsvLimit(csvPath, rustplus, error, onWarning);
        return EMPTY_ROWS;
    }
}

function writeRows(csvPath, rows) {
    if (rows.length > CSV_FILE_MAX_ROWS) {
        throw new IdentityCsvLimitError('IDENTITY_CSV_TOO_MANY_ROWS',
            `Player identity CSV exceeds the ${CSV_FILE_MAX_ROWS}-row safety limit; file left unchanged.`);
    }
    const lines = [CSV_HEADER.join(',')].concat(rows.map(row => [
        row.steamid,
        row.battlemetrics_id || '',
        row.date,
        row.name,
        row.language
    ].map(csvEscape).join(',')));
    const contents = `${lines.join('\n')}\n`;
    if (Buffer.byteLength(contents) > CSV_FILE_MAX_BYTES) {
        throw new IdentityCsvLimitError('IDENTITY_CSV_TOO_LARGE',
            `Player identity CSV exceeds the ${CSV_FILE_MAX_BYTES}-byte safety limit; file left unchanged.`);
    }
    const key = Path.resolve(csvPath);
    deleteCachedRows(key);
    try {
        Fs.writeFileSync(csvPath, contents);
    }
    finally {
        // Never let a failed or externally raced write leave an old parsed view reusable.
        deleteCachedRows(key);
    }
}

function getRuntimeCacheStatus() {
    pruneRowCache(Date.now());
    return Object.freeze({
        rows: rowCache.size,
        rowLimit: ROW_CACHE_MAX_ENTRIES,
        retainedRows: retainedCacheRows,
        retainedRowLimit: ROW_CACHE_MAX_ROWS,
        bytes: retainedCacheBytes,
        byteLimit: ROW_CACHE_MAX_BYTES
    });
}

function resetRuntimeCachesForTests() {
    rowCache.clear();
    limitWarningTimes.clear();
    retainedCacheBytes = 0;
    retainedCacheRows = 0;
}

function getLanguagesForSteamId(rows, steamId) {
    const row = getLatestRowForSteamId(rows, steamId);
    return row ? normalizeLanguages(row.language) : Object.freeze([]);
}

function getBattlemetricsIdForSteamId(rows, steamId) {
    const rowsWithBattlemetricsId = rows.filter(row =>
        row.steamid === steamId && row.battlemetrics_id);
    const row = getLatestRowForSteamId(rowsWithBattlemetricsId, steamId);
    return row ? row.battlemetrics_id : null;
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

function normalizeObservedAt(value) {
    if (value === undefined || value === null) return new Date().toISOString();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Identity observation date is invalid.');
    return date.toISOString();
}

function validateBattlemetricsId(value) {
    if (value === undefined || value === null || `${value}`.trim() === '') return null;
    const normalized = `${value}`.trim();
    if (!/^\d+$/.test(normalized)) throw new TypeError('BattleMetrics player ID must contain digits only.');
    return normalized;
}

function normalizeStoredBattlemetricsId(value) {
    return validateBattlemetricsId(value) || '';
}

function normalizeStoredLanguage(value) {
    if (value === undefined || value === null || `${value}`.trim() === '') return '';
    return serializeLanguages(normalizeLanguages(value));
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
    CSV_FILE_MAX_BYTES,
    CSV_FILE_MAX_ROWS,
    IDENTITY_ROWS_MAX_LIMIT,
    IdentityCsvLimitError,
    ROW_CACHE_MAX_BYTES,
    ROW_CACHE_MAX_ROWS,
    recordTeamInfo,
    recordTeamMessage,
    recordManual,
    recordIdentity,
    getKnownPseudonyms,
    getKnownLanguage,
    getKnownLanguages,
    getIdentityRows,
    getRuntimeCacheStatus,
    resetRuntimeCachesForTests
};
