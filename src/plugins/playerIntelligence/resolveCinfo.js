// @ts-check
const { resolveRoster } = require('./nameSimilarity.js');

/** @param {any} candidate */
function hasKnownIdentity(candidate) {
    return Boolean(candidate && (/^7656119\d{10}$/u.test(`${candidate.steamId || ''}`) ||
        /^\d{1,32}$/u.test(`${candidate.battlemetricsPlayerId || ''}`)));
}

/** @param {any} parsed @param {readonly any[]} candidates @param {any} options */
function resolveCinfo(parsed, candidates, options = {}) {
    if (!parsed || parsed.kind !== 'cinfo' || !Array.isArray(parsed.members)) {
        throw new TypeError('Parsed cinfo observation is required.');
    }
    const tagKey = `${parsed.tag || ''}`.normalize('NFKC').toLocaleLowerCase('en');
    const contextualCandidates = candidates.filter(hasKnownIdentity).map((/** @type {any} */ candidate) => ({
        ...candidate,
        contextPriority: Array.isArray(candidate.knownClanTags) &&
            candidate.knownClanTags.includes(tagKey)
    }));
    const matches = resolveRoster(parsed.members.map((/** @type {any} */ member) => member.name),
        contextualCandidates, {
            ...options,
            exactOnly: parsed.complete !== true || options.exactOnly === true
        });
    const enriched = parsed.members.map((/** @type {any} */ member, /** @type {number} */ index) => Object.freeze({
        index,
        name: member.name,
        role: member.role,
        resolution: matches[index]
    }));
    const declaredCount = Number.isSafeInteger(parsed.declaredCount) && parsed.declaredCount > 0 ?
        parsed.declaredCount : null;
    const resolved = enriched.filter((/** @type {any} */ member) => member.resolution.status === 'resolved')
        .sort((/** @type {any} */ left, /** @type {any} */ right) =>
            right.resolution.score - left.resolution.score || left.name.localeCompare(right.name));
    const acceptedResolved = declaredCount === null ? resolved : resolved.slice(0, declaredCount);
    const resolvedIndexes = new Set(acceptedResolved.map((/** @type {any} */ member) => member.index));
    const remaining = declaredCount === null ? 0 : Math.max(0, declaredCount - acceptedResolved.length);
    const unresolvedMembers = enriched.filter((/** @type {any} */ member) => !resolvedIndexes.has(member.index))
        .sort((/** @type {any} */ left, /** @type {any} */ right) =>
            right.resolution.score - left.resolution.score || left.name.localeCompare(right.name))
        .slice(0, remaining)
        .map((/** @type {any} */ member) => Object.freeze({
            observedText: member.name,
            role: member.role,
            candidates: member.resolution.alternatives
        }));
    const resolvedMembers = acceptedResolved.map((/** @type {any} */ member) => Object.freeze({
        observedText: member.name,
        memberIndex: member.index,
        name: member.resolution.candidate.caseFidelity === false &&
            member.resolution.candidate.visualScore !== 1 ? member.name : member.resolution.candidate.name,
        steamId: member.resolution.candidate.steamId,
        battlemetricsPlayerId: member.resolution.candidate.battlemetricsPlayerId,
        caseFidelity: member.resolution.candidate.caseFidelity !== false ||
            member.resolution.candidate.visualScore !== 1,
        role: member.role,
        score: member.resolution.score,
        margin: member.resolution.margin
    }));
    const structuralReady = Boolean(parsed.tag && declaredCount !== null && parsed.establishedAtUtc);
    const complete = structuralReady && parsed.complete && resolvedMembers.length === declaredCount &&
        unresolvedMembers.length === 0;
    const errors = [...parsed.errors];
    if (structuralReady && !complete) errors.push(
        `Partial roster: ${resolvedMembers.length}/${declaredCount} member identities resolved.`);
    return Object.freeze({
        ...parsed,
        members: Object.freeze(enriched),
        resolvedMembers: Object.freeze(resolvedMembers),
        unresolvedMembers: Object.freeze(unresolvedMembers),
        missingMemberCount: declaredCount === null ? 0 :
            Math.max(0, declaredCount - resolvedMembers.length - unresolvedMembers.length),
        importable: structuralReady,
        complete,
        errors: Object.freeze(errors)
    });
}

module.exports = Object.freeze({ resolveCinfo });
