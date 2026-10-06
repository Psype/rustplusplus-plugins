// @ts-check
const Layout = require('./ocrLayout.js');

const ROLE_VALUES = Object.freeze(['leader', 'moderator', 'member', 'unknown']);
const ESTABLISHED_ANCHOR = /estab[l1i][i1l]shed\s*:/iu;

/** @param {Record<string, unknown>[]} values */
function freezeArray(values) {
    return Object.freeze(values.map(value => Object.freeze(value)));
}

/** @param {unknown} value */
function normalized(value) {
    return Layout.cleanText(value).normalize('NFKC').toLocaleLowerCase('en');
}

/** @param {string} text @param {RegExp} expression */
function valueAfterAnchor(text, expression) {
    const match = expression.exec(text);
    return match ? Layout.cleanText(text.slice(match.index + match[0].length)) : null;
}

/** @param {unknown} value */
function establishedAnchorMatch(value) {
    return ESTABLISHED_ANCHOR.exec(`${value || ''}`);
}

/** @param {unknown} value */
function hasEstablishedAnchor(value) {
    return establishedAnchorMatch(value) !== null;
}

/** @param {unknown} value */
function hasEstablishedLabel(value) {
    return /^estab[l1i][i1l]shed:?$/iu.test(Layout.cleanText(value));
}

/** @param {string} value */
function parseEstablished(value) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const [, month, day, year, hour, minute, second] = match.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day || date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
    return date.toISOString();
}

/** @param {string} text @param {number|null} declaredCount */
function splitMembers(text, declaredCount) {
    const cleaned = Layout.cleanText(text).replace(/^\s*[:,]\s*/, '');
    if (!cleaned) return Object.freeze([]);
    if (declaredCount === 1) return Object.freeze([cleaned]);

    const commaParts = cleaned.split(/\s*,\s*/u).map(Layout.cleanText).filter(Boolean);
    if (commaParts.length === 0) return Object.freeze([]);
    const last = commaParts.pop();
    if (last === undefined) return Object.freeze([]);
    const finalParts = last.split(/\s+and\s+/iu).map(Layout.cleanText).filter(Boolean);
    return Object.freeze([...commaParts, ...finalParts]);
}

/** @param {unknown} roleHints */
function buildRoleMap(roleHints) {
    const roles = new Map();
    if (!Array.isArray(roleHints)) return roles;
    for (const rawHint of roleHints) {
        const hint = /** @type {{name?:unknown,role?:unknown}} */ (rawHint);
        if (!hint || typeof hint.name !== 'string' || typeof hint.role !== 'string' ||
            !ROLE_VALUES.includes(hint.role)) continue;
        const key = normalized(hint.name);
        if (!key || roles.has(key)) continue;
        roles.set(key, hint.role);
    }
    return roles;
}

/** @param {any} parsed @param {unknown} roleHints */
function applyRoleHints(parsed, roleHints) {
    if (!parsed || parsed.kind !== 'cinfo' || !Array.isArray(parsed.members)) {
        throw new TypeError('Parsed cinfo observation is required.');
    }
    const roleMap = buildRoleMap(roleHints);
    return Object.freeze({
        ...parsed,
        members: freezeArray(parsed.members.map((/** @type {any} */ member) => ({
            ...member,
            role: roleMap.get(normalized(member.name)) || member.role || 'member'
        })))
    });
}

/** @param {unknown} inputWords @returns {readonly (readonly import('./ocrLayout.js').OcrWord[])[]} */
function splitCinfoWordBlocks(inputWords) {
    const words = Layout.normalizeWords(inputWords);
    const lines = Layout.groupLines(words);
    const anchors = lines.map((line, index) => /clan\s*tag\s*:/iu.test(line.text) ? index : -1)
        .filter(index => index !== -1);
    if (anchors.length <= 1) return Object.freeze([words]);
    return Object.freeze(anchors.map((start, index) => {
        const end = index + 1 < anchors.length ? anchors[index + 1] : lines.length;
        return Object.freeze(lines.slice(start, end).flatMap(line => line.words));
    }));
}

/** @param {unknown} inputWords @param {{roleHints?:unknown}} options */
function parseCinfoWords(inputWords, options = {}) {
    const words = Layout.normalizeWords(inputWords);
    const lines = Layout.groupLines(words);
    const rawText = lines.map(line => line.text).join('\n');
    const tagIndex = lines.findIndex(line => /clan\s*tag\s*:/iu.test(line.text));
    const countIndex = lines.findIndex(line => /^.*?members\s*:\s*\d+/iu.test(line.text) &&
        !/clan\s+members\s*:/iu.test(line.text));
    const rosterIndex = lines.findIndex(line => /clan\s+members\s*:/iu.test(line.text));
    const establishedIndex = lines.findIndex((line, index) => index >= Math.max(0, rosterIndex) &&
        hasEstablishedAnchor(line.text));
    const errors = [];

    if (tagIndex === -1) errors.push('ClanTag anchor not found.');
    if (countIndex === -1) errors.push('Members count not found.');
    if (rosterIndex === -1) errors.push('Clan Members anchor not found.');
    if (establishedIndex === -1) errors.push('Established anchor not found.');

    const tag = tagIndex === -1 ? '' :
        valueAfterAnchor(lines[tagIndex].text, /clan\s*tag\s*:/iu) || '';
    if (tag.length < 1 || tag.length > 32) errors.push('ClanTag is empty or too long.');

    const countMatch = countIndex === -1 ? null : /members\s*:\s*(\d+)/iu.exec(lines[countIndex].text);
    const declaredCount = countMatch ? Number(countMatch[1]) : null;
    if (declaredCount === null || !Number.isSafeInteger(declaredCount) ||
        declaredCount < 1 || declaredCount > 1000) {
        errors.push('Members count is invalid.');
    }

    let rosterText = '';
    if (rosterIndex !== -1) {
        const firstLine = lines[rosterIndex].text;
        const rosterAnchor = /clan\s+members\s*:/iu.exec(firstLine);
        const firstBoundary = establishedAnchorMatch(firstLine);
        const rosterStart = rosterAnchor ? rosterAnchor.index + rosterAnchor[0].length : firstLine.length;
        const rosterEnd = firstBoundary && firstBoundary.index >= rosterStart ? firstBoundary.index : firstLine.length;
        rosterText = Layout.cleanText(firstLine.slice(rosterStart, rosterEnd));
        for (let index = rosterIndex + 1; index < lines.length; index += 1) {
            const boundary = establishedAnchorMatch(lines[index].text);
            const continuation = boundary ? lines[index].text.slice(0, boundary.index) : lines[index].text;
            rosterText = Layout.cleanText(`${rosterText} ${continuation}`);
            if (boundary) break;
        }
    }
    const memberNames = splitMembers(rosterText, declaredCount);
    const uniqueNames = new Set(memberNames.map(normalized));
    const complete = declaredCount !== null && memberNames.length === declaredCount &&
        uniqueNames.size === memberNames.length && !uniqueNames.has('');
    if (!complete) errors.push(`Roster count mismatch: expected ${declaredCount || '?'}, read ${memberNames.length}.`);

    const establishedRaw = establishedIndex === -1 ? '' :
        valueAfterAnchor(lines[establishedIndex].text, ESTABLISHED_ANCHOR) || '';
    const establishedAtUtc = parseEstablished(establishedRaw);
    if (!establishedAtUtc) errors.push('Established timestamp is invalid.');

    const roleMap = buildRoleMap(options.roleHints);
    const members = freezeArray(memberNames.map(name => ({
        name,
        role: roleMap.get(normalized(name)) || 'member'
    })));

    return Object.freeze({
        kind: 'cinfo',
        tag,
        declaredCount,
        members,
        complete,
        establishedRaw,
        establishedAtUtc,
        timezoneConfidence: establishedAtUtc ? 'probable' : 'unknown',
        rawText,
        errors: Object.freeze(errors)
    });
}

module.exports = Object.freeze({
    applyRoleHints,
    establishedAnchorMatch,
    hasEstablishedAnchor,
    hasEstablishedLabel,
    parseCinfoWords,
    parseEstablished,
    splitCinfoWordBlocks,
    splitMembers
});
