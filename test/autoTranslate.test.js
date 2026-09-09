const Assert = require('node:assert/strict');
const Test = require('node:test');

const AutoTranslate = require('../src/plugins/autoTranslate/index.js');

const rustplus = Object.freeze({ guildId: 'guild', serverId: 'server' });

Test('translates English and Chinese when each matches the player language', async () => {
    const calls = [];
    const translator = async (text, options) => {
        calls.push(Object.freeze({ text, ...options }));
        return `${options.from}->${options.to}:${text}`;
    };
    const settings = Object.freeze({ enabled: true, targets: Object.freeze(['en', 'zh']) });

    const english = await AutoTranslate.translateMessage(rustplus, {
        steamId: 'english-player',
        message: 'now it should work again'
    }, { settings, knownLanguage: 'en', translator });
    const chinese = await AutoTranslate.translateMessage(rustplus, {
        steamId: 'chinese-player',
        message: '现在应该可以用了'
    }, { settings, knownLanguage: 'zh', translator });

    Assert.deepEqual(english, {
        source: 'en', target: 'zh', translated: 'en->zh:now it should work again'
    });
    Assert.deepEqual(chinese, {
        source: 'zh', target: 'en', translated: 'zh->en:现在应该可以用了'
    });
    Assert.equal(Object.isFrozen(english), true);
    Assert.deepEqual(calls.map(({ from, to }) => [from, to]), [['en', 'zh'], ['zh', 'en']]);
});

Test('translates any declared player language to the other configured language', async () => {
    const result = await AutoTranslate.translateMessage(rustplus, {
        steamId: 'multilingual-player',
        message: 'the bot should be fixed'
    }, {
        settings: { enabled: true, targets: ['en', 'zh'] },
        knownLanguages: ['fr', 'en'],
        translator: async (text, { from, to }) => `${from}->${to}:${text}`
    });

    Assert.deepEqual(result, {
        source: 'en', target: 'zh', translated: 'en->zh:the bot should be fixed'
    });
});

Test('does not translate a declared language outside the configured pair', async () => {
    const result = await AutoTranslate.translateMessage(rustplus, {
        steamId: 'multilingual-player',
        message: 'maintenant ça devrait fonctionner'
    }, {
        settings: { enabled: true, targets: ['en', 'zh'] },
        knownLanguages: ['fr', 'en'],
        translator: async () => { throw new Error('translator must not run'); }
    });

    Assert.equal(result, null);
});

Test('does not translate a player speaking outside their registered language', async () => {
    const result = await AutoTranslate.translateMessage(rustplus, {
        steamId: 'chinese-player',
        message: 'now it should work again'
    }, {
        settings: { enabled: true, targets: ['en', 'zh'] },
        knownLanguage: 'zh',
        translator: async () => { throw new Error('translator must not run'); }
    });

    Assert.equal(result, null);
});

Test('supports the future French and Chinese target pair', async () => {
    const result = await AutoTranslate.translateMessage(rustplus, {
        steamId: 'french-player',
        message: 'viens à la base'
    }, {
        settings: { enabled: true, targets: ['fr', 'zh'] },
        knownLanguage: 'fr',
        translator: async (text, { from, to }) => `${from}->${to}:${text}`
    });

    Assert.deepEqual(result, {
        source: 'fr', target: 'zh', translated: 'fr->zh:viens à la base'
    });
});

Test('translates a short French translation test to Chinese', async () => {
    const result = await AutoTranslate.translateMessage(rustplus, {
        steamId: 'french-player',
        message: 'test de traduction'
    }, {
        settings: { enabled: true, targets: ['fr', 'zh'] },
        knownLanguages: ['fr'],
        translator: async (text, { from, to }) => `${from}->${to}:${text}`
    });

    Assert.deepEqual(result, {
        source: 'fr', target: 'zh', translated: 'fr->zh:test de traduction'
    });
});

Test('uses the English fallback for ambiguous Latin gaming text', async () => {
    const result = await AutoTranslate.translateMessage(rustplus, {
        steamId: 'english-player',
        message: 'loot'
    }, {
        settings: { enabled: true, targets: ['en', 'zh'] },
        knownLanguages: ['en'],
        translator: async (text, { from, to }) => `${from}->${to}:${text}`
    });

    Assert.deepEqual(result, {
        source: 'en', target: 'zh', translated: 'en->zh:loot'
    });
});

Test('routes the reported French and Chinese chat messages through the active pair', async () => {
    const samples = [
        ['caisse verrouillée à la gare de triage', ['en', 'fr'], 'fr', 'zh'],
        ['le plan est que la tour serve à réapparaitre, et avoir des kits disponibles pour aller se battre',
            ['en', 'fr'], 'fr', 'zh'],
        ['la tour au-dessus servira à respawn et aller se battre, sous le rocher sera le bunker pour stocker seulement',
            ['en', 'fr'], 'fr', 'zh'],
        ['nirks 我们在去战斗', ['zh'], 'zh', 'fr']
    ];

    for (const [message, knownLanguages, source, target] of samples) {
        const result = await AutoTranslate.translateMessage(rustplus, { steamId: 'player', message }, {
            settings: { enabled: true, targets: ['fr', 'zh'] },
            knownLanguages,
            translator: async text => `translated:${text}`
        });
        Assert.equal(result.source, source, message);
        Assert.equal(result.target, target, message);
    }
});

Test('does not swallow translator failures', async () => {
    const logs = [];
    const loggingRustplus = Object.freeze({
        guildId: 'guild',
        serverId: 'server',
        log: (...values) => logs.push(Object.freeze(values))
    });
    const failure = new Error('translator offline');
    failure.failures = Object.freeze([
        Object.freeze({ provider: 'google-web', reason: 'HTTP 429' }),
        Object.freeze({ provider: 'deeplx', reason: 'ETIMEDOUT' })
    ]);
    await Assert.rejects(() => AutoTranslate.translateMessage(loggingRustplus, {
        steamId: 'english-player',
        message: 'now it should work again'
    }, {
        settings: { enabled: true, targets: ['en', 'zh'] },
        knownLanguage: 'en',
        translator: async () => { throw failure; }
    }), /translator offline/);
    Assert.equal(logs.some(log => log.join(' ').includes('provider=google-web reason=HTTP 429')), true);
    Assert.equal(logs.some(log => log.join(' ').includes('provider=deeplx reason=ETIMEDOUT')), true);
    Assert.equal(logs.every(log => log[2] === 'warn'), true);
});

Test('ignores bot translations and messages without letters', async () => {
    const translator = async () => { throw new Error('translator must not run'); };
    const settings = { enabled: true, targets: ['en', 'zh'] };

    Assert.equal(await AutoTranslate.translateMessage(rustplus, {
        message: '[→zh] 现在应该可以用了'
    }, { settings, knownLanguage: 'zh', translator }), null);
    Assert.equal(await AutoTranslate.translateMessage(rustplus, {
        message: '123'
    }, { settings, knownLanguage: 'en', translator }), null);
});
