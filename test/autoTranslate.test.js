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

Test('does not swallow translator failures', async () => {
    await Assert.rejects(() => AutoTranslate.translateMessage(rustplus, {
        steamId: 'english-player',
        message: 'now it should work again'
    }, {
        settings: { enabled: true, targets: ['en', 'zh'] },
        knownLanguage: 'en',
        translator: async () => { throw new Error('translator offline'); }
    }), /translator offline/);
});

Test('ignores bot translations and ambiguous gaming-only messages', async () => {
    const translator = async () => { throw new Error('translator must not run'); };
    const settings = { enabled: true, targets: ['en', 'zh'] };

    Assert.equal(await AutoTranslate.translateMessage(rustplus, {
        message: '[→zh] 现在应该可以用了'
    }, { settings, knownLanguage: 'zh', translator }), null);
    Assert.equal(await AutoTranslate.translateMessage(rustplus, {
        message: 'raid'
    }, { settings, knownLanguage: 'en', translator }), null);
});
