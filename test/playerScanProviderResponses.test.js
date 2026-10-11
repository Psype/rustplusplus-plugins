const Assert = require('node:assert/strict');
const Test = require('node:test');

const Responses = require('../src/workers/playerScanProviderResponses.js');

const STEAM_A = '76561197975819827';
const STEAM_B = '76561198036538266';
const OBSERVED_AT = '2026-10-11T14:00:00.000Z';

function throwingUnknown(object, key = 'privatePayload') {
    let reads = 0;
    Object.defineProperty(object, key, { enumerable: true, get: () => {
        reads += 1;
        throw new Error('unknown getter must not run');
    } });
    return () => reads;
}

function wbPlayer(overrides = {}) {
    return {
        steamId: STEAM_A,
        name: 'Alice',
        aliases: ['Alice', 'Alice old'],
        playtime: 42,
        rank: 1,
        stats: [{ name: 'kills', amount: 99 }],
        ...overrides
    };
}

function wbPage(overrides = {}) {
    return {
        available: true,
        reason: null,
        page: 3,
        pageSize: 100,
        nextPage: null,
        complete: true,
        observedAt: OBSERVED_AT,
        rows: [wbPlayer()],
        utils: { total: 201 },
        ...overrides
    };
}

Test('Steam projection copies only own data and accepts exactly 256 aliases', () => {
    const aliases = Array.from({ length: Responses.MAX_ALIASES }, (_unused, index) => ({
        name: `Alias ${index}`,
        timeChanged: index === 0 ? null : `entry ${index}`,
        unused: 'discarded'
    }));
    const raw = {
        steamId: STEAM_A,
        currentName: 'Alice',
        pastAliases: aliases,
        aliasesComplete: true,
        profileHtml: '<secret>'
    };
    const unknownReads = throwingUnknown(raw);
    const aliasUnknownReads = throwingUnknown(aliases[0]);

    const projected = Responses.project('steam', 'profileIdentity', STEAM_A, raw);

    Assert.equal(unknownReads(), 0);
    Assert.equal(aliasUnknownReads(), 0);
    Assert.equal(projected.pastAliases.length, 256);
    Assert.deepEqual(projected.pastAliases[0], { name: 'Alias 0', timeChanged: null });
    Assert.deepEqual(Object.keys(projected), ['steamId', 'currentName', 'pastAliases', 'aliasesComplete']);
    Assert.equal(JSON.parse(JSON.stringify(projected)).profileHtml, undefined);
});

Test('Steam projection rejects alias overflow, mismatches, sparse arrays and known accessors', () => {
    const base = {
        steamId: STEAM_A,
        currentName: 'Alice',
        pastAliases: Array.from({ length: Responses.MAX_ALIASES + 1 }, (_unused, index) => ({
            name: `Alias ${index}`, timeChanged: null
        })),
        aliasesComplete: true
    };
    Assert.throws(() => Responses.project('steam', 'profileIdentity', STEAM_A, base), error =>
        error.code === 'PROVIDER_RESPONSE_TOO_LARGE' && !error.message.includes('Alias 0'));
    Assert.throws(() => Responses.project('steam', 'profileIdentity', STEAM_B,
        { ...base, pastAliases: [] }), error => error.code === 'PROVIDER_RESPONSE_INVALID');
    Assert.throws(() => Responses.project('steam', 'profileIdentity', STEAM_A,
        { ...base, pastAliases: new Array(1) }), error => error.code === 'PROVIDER_RESPONSE_INVALID');

    let reads = 0;
    const accessor = { ...base, pastAliases: [] };
    Object.defineProperty(accessor, 'currentName', { enumerable: true, get: () => {
        reads += 1;
        return 'Alice';
    } });
    Assert.throws(() => Responses.project('steam', 'profileIdentity', STEAM_A, accessor), error =>
        error.code === 'PROVIDER_RESPONSE_INVALID');
    Assert.equal(reads, 0);
});

Test('BattleMetrics projection is strict and failure responses retain only retry metadata', () => {
    const success = { available: true, reason: null, steamId: STEAM_A, status: 200, token: 'discarded' };
    const successUnknownReads = throwingUnknown(success);
    Assert.deepEqual(Responses.project('battlemetrics', 'resolveSteamId', '1192585926', success), {
        available: true, reason: null, steamId: STEAM_A
    });
    Assert.equal(successUnknownReads(), 0);

    const failure = {
        available: false,
        reason: 'rate limited',
        status: 429,
        retryAt: '2026-10-11T14:05:00.000Z',
        cooldownUntil: null,
        steamId: STEAM_A
    };
    const failureUnknownReads = throwingUnknown(failure);
    Assert.deepEqual(Responses.project('battlemetrics', 'resolveSteamId', '1192585926', failure), {
        available: false,
        reason: 'rate limited',
        retryAt: '2026-10-11T14:05:00.000Z',
        cooldownUntil: null
    });
    Assert.equal(failureUnknownReads(), 0);

    Assert.throws(() => Responses.project('battlemetrics', 'resolveSteamId', '1192585926', {
        available: true, reason: null, steamId: 'not-steam'
    }), error => error.code === 'PROVIDER_RESPONSE_INVALID');
    Assert.throws(() => Responses.project('battlemetrics', 'resolveSteamId', '1192585926', {
        available: false, reason: 'retry', retryAt: 'tomorrow'
    }), error => error.code === 'PROVIDER_RESPONSE_INVALID');
});

Test('WarBandits lookup strips candidates and statistics without reading their getters', () => {
    const player = wbPlayer();
    const playerUnknownReads = throwingUnknown(player);
    const raw = {
        available: true,
        reason: null,
        player,
        candidates: [wbPlayer({ steamId: STEAM_B, name: 'Other' })],
        ambiguous: false,
        truncated: false,
        observedAt: OBSERVED_AT,
        query: 'Alice',
        server: { slug: 'secret' }
    };
    const candidatesReads = throwingUnknown(raw, 'candidates');

    Assert.deepEqual(Responses.project('warbandits', 'resolvePlayerRecent', 'Alice', raw), {
        available: true,
        reason: null,
        player: { steamId: STEAM_A, name: 'Alice', aliases: ['Alice', 'Alice old'], playtime: 42 },
        ambiguous: false,
        truncated: false,
        observedAt: OBSERVED_AT
    });
    Assert.equal(candidatesReads(), 0);
    Assert.equal(playerUnknownReads(), 0);
});

Test('WarBandits lookup rejects alias overflow and inconsistent or malformed results', () => {
    const aliases = Array.from({ length: Responses.MAX_ALIASES }, (_unused, index) => `Alias ${index}`);
    const accepted = Responses.project('warbandits', 'resolvePlayer', 'Alice', {
        available: true,
        reason: null,
        player: wbPlayer({ aliases }),
        ambiguous: false,
        truncated: false,
        observedAt: OBSERVED_AT
    });
    Assert.equal(accepted.player.aliases.length, 256);

    Assert.throws(() => Responses.project('warbandits', 'resolvePlayer', 'Alice', {
        available: true, reason: null,
        player: wbPlayer({ aliases: [...aliases, 'overflow'] }),
        ambiguous: false, truncated: false, observedAt: OBSERVED_AT
    }), error => error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
    Assert.throws(() => Responses.project('warbandits', 'resolvePlayer', 'Alice', {
        available: true, reason: null, player: wbPlayer(),
        ambiguous: true, truncated: false, observedAt: OBSERVED_AT
    }), error => error.code === 'PROVIDER_RESPONSE_INVALID');
    Assert.throws(() => Responses.project('warbandits', 'resolvePlayer', 'Alice', {
        available: true, reason: null, player: null,
        ambiguous: false, truncated: true, observedAt: OBSERVED_AT
    }), error => error.code === 'PROVIDER_RESPONSE_INVALID');
    Assert.throws(() => Responses.project('warbandits', 'resolvePlayer', 'Alice', {
        available: true, reason: null, player: null,
        ambiguous: false, truncated: false, observedAt: 'invalid-date'
    }), error => error.code === 'PROVIDER_RESPONSE_INVALID');
});

Test('WarBandits page projection validates row bounds and resumable cursor semantics', () => {
    const raw = wbPage();
    const utilsReads = throwingUnknown(raw, 'utils');
    const projected = Responses.project('warbandits', 'scanCurrentWipePage', 3, raw);
    Assert.deepEqual(projected, {
        available: true,
        reason: null,
        page: 3,
        pageSize: 100,
        nextPage: null,
        complete: true,
        observedAt: OBSERVED_AT,
        rows: [{ steamId: STEAM_A, name: 'Alice', playtime: 42 }]
    });
    Assert.equal(utilsReads(), 0);

    const fullRows = Array.from({ length: 100 }, (_unused, index) => wbPlayer({
        steamId: `${76561198000000000n + BigInt(index)}`,
        name: `Player ${index}`
    }));
    Assert.equal(Responses.project('warbandits', 'scanCurrentWipePage', 3, wbPage({
        complete: false, nextPage: 4, rows: fullRows
    })).rows.length, 100);
    Assert.throws(() => Responses.project('warbandits', 'scanCurrentWipePage', 3, wbPage({
        rows: [...fullRows, wbPlayer()]
    })), error => error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
    Assert.throws(() => Responses.project('warbandits', 'scanCurrentWipePage', 3,
        wbPage({ complete: false, nextPage: 5, rows: fullRows })),
    error => error.code === 'PROVIDER_RESPONSE_INVALID');
    Assert.throws(() => Responses.project('warbandits', 'scanCurrentWipePage', 2, raw),
        error => error.code === 'PROVIDER_RESPONSE_INVALID');
    Assert.throws(() => Responses.project('warbandits', 'scanCurrentWipePage', 3,
        wbPage({ rows: [wbPlayer({ playtime: Number.NaN })] })),
    error => error.code === 'PROVIDER_RESPONSE_INVALID');
});

Test('WarBandits failure and unsupported tuples fail closed without leaking extra data', () => {
    const failure = {
        available: false,
        reason: 'cooldown',
        cooldownUntil: '2026-10-11T14:15:00.000Z',
        rows: [wbPlayer()],
        server: { token: 'secret' }
    };
    const rowsReads = throwingUnknown(failure, 'rows');
    Assert.deepEqual(Responses.project('warbandits', 'scanCurrentWipePage', 3, failure), {
        available: false,
        reason: 'cooldown',
        cooldownUntil: '2026-10-11T14:15:00.000Z'
    });
    Assert.equal(rowsReads(), 0);

    Assert.throws(() => Responses.project('warbandits', 'unknown', 'Alice', {}), error =>
        error.code === 'PROVIDER_RESPONSE_INVALID' && !error.message.includes('Alice'));
    Assert.throws(() => Responses.project('warbandits', 'resolvePlayer', ' Alice ', {}), error =>
        error.code === 'PROVIDER_RESPONSE_INVALID');
});
