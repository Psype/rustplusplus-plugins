const Assert = require('node:assert/strict');
const Test = require('node:test');

const LanguageDetector = require('../src/util/languageDetector.js');

Test('detects short English, French, and Chinese Rust chat', async () => {
    const samples = Object.freeze([
        Object.freeze(['now it should work again', 'en']),
        Object.freeze(['go base', 'en']),
        Object.freeze(['raid at base', 'en']),
        Object.freeze(['farm sulfur', 'en']),
        Object.freeze(['enemies behind the base', 'en']),
        Object.freeze(['cover me at oil rig', 'en']),
        Object.freeze(['depo the loot then roam', 'en']),
        Object.freeze(["Nirks is french, the whole team here is french + 2 other people that didn't came back", 'en']),
        Object.freeze(['maintenant ça devrait fonctionner', 'fr']),
        Object.freeze(['viens farm', 'fr']),
        Object.freeze(['on raid', 'fr']),
        Object.freeze(['besoin de bois', 'fr']),
        Object.freeze(['les ennemis arrivent derrière la base', 'fr']),
        Object.freeze(['couvre moi au cargo', 'fr']),
        Object.freeze(['dépose le loot puis on roam', 'fr']),
        Object.freeze(['现在应该可以用了', 'zh']),
        Object.freeze(['回基地', 'zh'])
    ]);

    for (const [message, expected] of samples) {
        Assert.equal(await LanguageDetector.detectLanguage(message), expected, message);
    }
});

Test('does not guess shared or non-linguistic gaming tokens', async () => {
    for (const message of ['base', 'raid', 'loot', 'gg', '123']) {
        Assert.equal(await LanguageDetector.detectLanguage(message), null, message);
    }
});
