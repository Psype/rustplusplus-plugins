/* Local language detector tuned for short Rust team-chat messages. */

const SCRIPT_RULES = [
    { regex: /\p{Script=Han}/u, language: 'zh' },
    { regex: /\p{Script=Hiragana}|\p{Script=Katakana}/u, language: 'ja' },
    { regex: /\p{Script=Hangul}/u, language: 'ko' },
    { regex: /\p{Script=Cyrillic}/u, language: 'ru' },
    { regex: /\p{Script=Arabic}/u, language: 'ar' },
    { regex: /\p{Script=Thai}/u, language: 'th' },
    { regex: /\p{Script=Greek}/u, language: 'el' },
    { regex: /\p{Script=Hebrew}/u, language: 'he' },
    { regex: /\p{Script=Devanagari}/u, language: 'hi' }
];

const DETECTOR_LANGUAGES = Object.freeze(['en', 'fr', 'zh']);
const STRONG_WORDS = Object.freeze({
    en: new Set([
        'again', 'back', 'behind', 'bring', 'came', 'come', 'coming', 'cover', 'did', "didn't", 'enemy',
        'enemies', 'give', 'go', 'going', 'help', 'need', 'now', 'people', 'please', 'should', 'stay', 'take',
        'team', 'translate', 'translated', 'translation', 'translator', 'wait', 'where', 'whole', 'work', 'works',
        'yes', 'wood', 'stone', 'sulfur', 'cloth', 'scrap'
    ]),
    fr: new Set([
        'aide', 'attends', 'besoin', 'bois', 'ça', "c'est", 'cest', 'couvre', 'derrière', 'devrait',
        'droite', 'ennemi', 'ennemis', 'équipe', 'ferraille', 'fonctionne', 'fonctionner', 'gauche', 'ici',
        'maintenant', 'non', 'où', 'oui', 'pierre', 'personne', 'personnes', 'ramène', 'reste', 'soufre',
        'tissu', 'toute', 'traducteur', 'traduction', 'traduire', 'traduit', 'viens', 'venez'
    ])
});
const COMMON_WORDS = Object.freeze({
    en: new Set([
        'a', 'am', 'an', 'and', 'are', 'at', 'can', "can't", 'cant', 'do', "don't", 'dont', 'for', 'from',
        'get', 'got', 'have', 'he', 'here', 'his', 'i', "i'm", 'im', 'in', 'is', 'it', "it's", 'its', 'me',
        'my', 'no', 'not', 'of', 'other', 'our', 'out', 'she', 'that', 'the', 'their', 'them', 'there', 'they',
        'this', 'to', 'under', 'up', 'us', 'we', 'what', 'who', 'with', 'without', 'you', 'your'
    ]),
    fr: new Set([
        'à', 'ai', 'avec', 'dans', 'de', 'des', 'du', 'elle', 'en', 'es', 'est', 'et', 'fait', 'faut', 'il',
        "j'ai", 'je', 'la', 'là', 'le', 'les', 'moi', 'mon', 'ne', 'nous', 'on', 'pas', 'pour', 'sans', 'se',
        'suis', 'sur', "t'es", 'tes', 'toi', 'tu', 'un', 'une', 'va', 'vous', 'votre'
    ])
});
const GAMING_PHRASES = Object.freeze([
    Object.freeze({
        regex: /\b(?:raid|enemy|enemies|heli|cargo)\s+(?:at|near)\s+(?:the\s+)?(?:base|rig|grid)\b/u,
        language: 'en'
    }),
    Object.freeze({
        regex: /\b(?:on|je|tu|nous|vous)\s+(?:raid|farm|roam|depo|camp|push)\b/u,
        language: 'fr'
    })
]);

let detectorPromise;

function detectLanguage(text) {
    const normalized = normalizeText(text);
    if (!normalized) return null;

    for (const rule of SCRIPT_RULES) {
        if (rule.regex.test(normalized)) return rule.language;
    }

    const lexicalLanguage = detectLexicalLanguage(normalized.toLocaleLowerCase('en'));
    if (lexicalLanguage) return lexicalLanguage;

    return getDetector().then(detector => {
        const result = detector.detect(normalized);
        if (DETECTOR_LANGUAGES.includes(result.language)) return result.language;
        return looksLikeLatinText(normalized) ? 'en' : null;
    });
}

function detectLexicalLanguage(text) {
    for (const phrase of GAMING_PHRASES) {
        if (phrase.regex.test(text)) return phrase.language;
    }

    const words = text.match(/\p{L}+(?:['’]\p{L}+)*/gu) || [];
    if (words.length === 0) return null;

    const scores = { en: 0, fr: 0 };
    const strongScores = { en: 0, fr: 0 };
    for (const language of ['en', 'fr']) {
        for (const word of words) {
            const normalizedWord = word.replaceAll('’', "'");
            if (STRONG_WORDS[language].has(normalizedWord)) {
                scores[language] += 2;
                strongScores[language]++;
            }
            else if (COMMON_WORDS[language].has(normalizedWord)) scores[language]++;
        }
    }

    if (scores.en === scores.fr) return null;
    const language = scores.en > scores.fr ? 'en' : 'fr';
    const otherLanguage = language === 'en' ? 'fr' : 'en';
    if (strongScores[language] > 0 && scores[language] > scores[otherLanguage]) return language;
    if (scores[language] - scores[otherLanguage] >= 2) return language;
    return null;
}

function getDetector() {
    if (!detectorPromise) {
        detectorPromise = import('eld/extrasmall').then(({ eld }) => {
            eld.setLanguageSubset([...DETECTOR_LANGUAGES]);
            return eld;
        }).catch(error => {
            detectorPromise = undefined;
            throw error;
        });
    }
    return detectorPromise;
}

function normalizeText(text) {
    if (text === undefined || text === null) return '';
    return text.toString()
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/<@!?\d+>|<#[0-9]+>|<@&[0-9]+>/g, ' ')
        .replace(/[0-9_.,!?;:()[\]{}<>/\\|@#$%^&*+=~`"-]+/g, ' ')
        .trim();
}

function looksLikeLatinText(text) {
    const letters = text.match(/\p{L}/gu) || [];
    return letters.length > 0 && letters.every(letter => /\p{Script=Latin}/u.test(letter));
}

module.exports = { detectLanguage };
