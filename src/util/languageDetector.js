/* Generic, silent language detector for short Rust team-chat messages. */

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

const ENGLISH_WORDS = new Set([
    'a', 'about', 'all', 'am', 'an', 'and', 'are', 'at', 'back', 'base', 'be', 'been', 'but', 'by', 'can',
    'come', 'do', 'dont', "don't", 'down', 'for', 'from', 'go', 'going', 'good', 'got', 'have', 'he', 'here',
    'i', "i'm", 'im', 'in', 'is', 'it', 'its', "it's", 'left', 'loot', 'me', 'my', 'need', 'no', 'not', 'of',
    'on', 'one', 'our', 'out', 'raid', 'right', 'see', 'the', 'there', 'they', 'this', 'to', 'up', 'us', 'we',
    'what', 'where', 'who', 'with', 'yes', 'you', 'your'
]);

function detectLanguage(text) {
    const normalized = normalizeText(text);
    if (!normalized) return null;

    for (const rule of SCRIPT_RULES) {
        if (rule.regex.test(normalized)) return rule.language;
    }

    const words = normalized.toLowerCase().match(/[a-z']+/g) || [];
    if (words.length === 0) return null;

    const englishMatches = words.filter(word => ENGLISH_WORDS.has(word)).length;
    if (englishMatches >= 2 || (words.length <= 3 && englishMatches >= 1)) return 'en';

    return null;
}

function normalizeText(text) {
    if (text === undefined || text === null) return '';
    return text.toString()
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/<@!?\d+>|<#[0-9]+>|<@&[0-9]+>/g, ' ')
        .replace(/[0-9_.,!?;:()[\]{}<>/\\|@#$%^&*+=~`"-]+/g, ' ')
        .trim();
}

module.exports = { detectLanguage };
