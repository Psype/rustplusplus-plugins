// @ts-check
const Layout = require('./ocrLayout.js');

const STEAM_ID = /^7656119\d{10}$/;
const UI_TEXT = /^(find|player|who|do|you|want|to|report|search|by|name|feedback|cancel)$/iu;

/** @typedef {Readonly<{text:string,x:number,y:number,width:number,height:number,center:number}>} Box */
/** @typedef {Readonly<{steamId:string,name:string|null,ambiguous:boolean,alternatives:readonly string[]}>} RawEntry */

/** @param {unknown} value */
function normalized(value) {
    return Layout.cleanText(value).normalize('NFKC').toLocaleLowerCase('en');
}

/** @param {ReturnType<typeof Layout.groupLines>} lines @param {number} typicalHeight */
function digitCandidates(lines, typicalHeight) {
    /** @type {Box[]} */
    const candidates = [];
    /** @type {Box[]} */
    const partial = [];
    for (const line of lines) {
        const numeric = line.words.filter(word => /^\d+$/u.test(word.text));
        for (const cluster of Layout.clusterWordsByGap(numeric, typicalHeight * 0.5)) {
            const text = cluster.map(word => word.text).join('');
            const x = Math.min(...cluster.map(word => word.x));
            const right = Math.max(...cluster.map(word => word.x + word.width));
            const y = Math.min(...cluster.map(word => word.y));
            const bottom = Math.max(...cluster.map(word => word.y + word.height));
            const item = Object.freeze({ text, x, y, width: right - x, height: bottom - y,
                center: (y + bottom) / 2 });
            if (STEAM_ID.test(text)) candidates.push(item);
            else if (/^7656\d{8,16}$/u.test(text)) partial.push(item);
        }
    }
    return Object.freeze({ candidates: Object.freeze(candidates), partial: Object.freeze(partial) });
}

/** @param {ReturnType<typeof Layout.groupLines>} lines @param {number} typicalHeight */
function nameClusters(lines, typicalHeight) {
    /** @type {Box[]} */
    const result = [];
    for (const line of lines) {
        const words = line.words.filter(word => !UI_TEXT.test(normalized(word.text)) &&
            !STEAM_ID.test(word.text));
        for (const cluster of Layout.clusterWordsByGap(words, typicalHeight)) {
            const text = Layout.cleanText(cluster.map(word => word.text).join(' '));
            if (!text || /^7656\d{8,16}$/u.test(text.replace(/\s+/g, ''))) continue;
            const x = Math.min(...cluster.map(word => word.x));
            const right = Math.max(...cluster.map(word => word.x + word.width));
            const y = Math.min(...cluster.map(word => word.y));
            const bottom = Math.max(...cluster.map(word => word.y + word.height));
            result.push(Object.freeze({ text, x, y, width: right - x, height: bottom - y,
                center: (y + bottom) / 2 }));
        }
    }
    return Object.freeze(result);
}

/** @param {Box} id @param {readonly Box[]} names @param {number} typicalHeight */
function selectName(id, names, typicalHeight) {
    const candidates = names.map(name => {
        const vertical = id.center - name.center;
        const horizontal = Math.abs(name.x - id.x);
        return Object.freeze({
            name,
            vertical,
            horizontal,
            score: vertical / typicalHeight + horizontal / typicalHeight
        });
    }).filter(candidate => candidate.vertical >= typicalHeight * 0.25 &&
        candidate.vertical <= typicalHeight * 3 && candidate.horizontal <= typicalHeight * 4)
        .sort((left, right) => left.score - right.score || left.name.x - right.name.x);
    if (candidates.length === 0) return Object.freeze({ name: null, ambiguous: false, alternatives: [] });
    if (candidates.length > 1 && candidates[1].score - candidates[0].score <= 0.35) {
        return Object.freeze({
            name: null,
            ambiguous: true,
            alternatives: Object.freeze(candidates.slice(0, 3).map(candidate => candidate.name.text))
        });
    }
    return Object.freeze({
        name: candidates[0].name.text,
        ambiguous: false,
        alternatives: Object.freeze([])
    });
}

/** @param {readonly RawEntry[]} entries */
function mergeEntries(entries) {
    /** @type {Map<string, RawEntry[]>} */
    const grouped = new Map();
    for (const entry of entries) {
        const current = grouped.get(entry.steamId) || [];
        current.push(entry);
        grouped.set(entry.steamId, current);
    }
    const merged = [];
    for (const [steamId, observations] of grouped) {
        const names = [...new Map(observations.filter(item => item.name)
            .map(item => [normalized(item.name), item.name])).values()];
        const alternatives = [...new Set(observations.flatMap(item => item.alternatives || []))];
        const ambiguous = observations.some(item => item.ambiguous) || names.length > 1;
        merged.push(Object.freeze({
            steamId,
            name: ambiguous || names.length === 0 ? null : names[0],
            caseFidelity: false,
            ambiguous,
            alternatives: Object.freeze(ambiguous ? [...new Set([...names, ...alternatives])] : [])
        }));
    }
    return Object.freeze(merged.sort((left, right) => left.steamId.localeCompare(right.steamId)));
}

/** @param {unknown} inputWords @param {{requireAnchor?:boolean}} options */
function parseF7Words(inputWords, options = {}) {
    const words = Layout.normalizeWords(inputWords);
    const lines = Layout.groupLines(words);
    const rawText = lines.map(line => line.text).join('\n');
    const typicalHeight = Math.max(1, Layout.median(words.map(word => word.height)));
    const normalizedText = normalized(rawText);
    const hasAnchor = normalizedText.includes('find player');
    const errors = [];
    if (options.requireAnchor !== false && !hasAnchor) errors.push('Find Player anchor not found.');

    const ids = digitCandidates(lines, typicalHeight);
    const names = nameClusters(lines, typicalHeight);
    const entries = mergeEntries(ids.candidates.map(id => {
        const selection = selectName(id, names, typicalHeight);
        return Object.freeze({ steamId: id.text, ...selection });
    }));
    if (entries.length === 0) errors.push('No complete SteamID64 found.');
    if (ids.partial.length > 0) errors.push(`${ids.partial.length} partial SteamID candidate(s) rejected.`);
    if (entries.some(entry => entry.ambiguous)) errors.push('At least one name association is ambiguous.');

    return Object.freeze({
        kind: 'f7',
        entries,
        rejectedPartialIds: Object.freeze(ids.partial.map(item => item.text)),
        complete: entries.length > 0 && !entries.some(entry => entry.ambiguous),
        rawText,
        errors: Object.freeze(errors)
    });
}

module.exports = Object.freeze({ parseF7Words });
