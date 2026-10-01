const Fs = require('fs');
const Path = require('path');

const DEFAULT_IN_GAME_MESSAGE_TEMPLATE =
    ':exclamation: :poggers: GETTING RAIDED: {message}  :oldmanlaugh: :exclamation:';
const DEFAULT_FILE_PATH = Path.join(process.cwd(), 'config', 'raid-alarm.json');
const MAX_TEMPLATE_LENGTH = 512;
const PLACEHOLDERS = Object.freeze(['title', 'message', 'item', 'location']);
const PLACEHOLDER_PATTERN = /\{(title|message|item|location)\}/g;

function validateTemplate(value) {
    if (typeof value !== 'string') throw new TypeError('inGameMessageTemplate must be a string');
    const template = value.trim();
    if (template === '') throw new TypeError('inGameMessageTemplate must not be empty');
    if ([...template].length > MAX_TEMPLATE_LENGTH) {
        throw new RangeError(`inGameMessageTemplate exceeds ${MAX_TEMPLATE_LENGTH} characters`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(template)) {
        throw new TypeError('inGameMessageTemplate must be a single printable line');
    }

    const placeholders = [...template.matchAll(PLACEHOLDER_PATTERN)].map(match => match[1]);
    if (placeholders.length === 0) {
        throw new TypeError(`inGameMessageTemplate must contain one of: ${PLACEHOLDERS.join(', ')}`);
    }
    if (template.replace(PLACEHOLDER_PATTERN, '').includes('{') ||
        template.replace(PLACEHOLDER_PATTERN, '').includes('}')) {
        throw new TypeError(`inGameMessageTemplate contains an unknown placeholder; allowed: ${PLACEHOLDERS.join(', ')}`);
    }
    return template;
}

function load(options = {}) {
    const filePath = options.filePath || DEFAULT_FILE_PATH;
    const readFileSync = options.readFileSync || Fs.readFileSync;
    try {
        const document = JSON.parse(readFileSync(filePath, 'utf8'));
        if (!document || typeof document !== 'object' || Array.isArray(document)) {
            throw new TypeError('configuration root must be an object');
        }
        return Object.freeze({
            template: validateTemplate(document.inGameMessageTemplate),
            source: filePath,
            warning: null
        });
    }
    catch (error) {
        return Object.freeze({
            template: DEFAULT_IN_GAME_MESSAGE_TEMPLATE,
            source: 'built-in default',
            warning: error instanceof Error ? error.message : String(error)
        });
    }
}

function cleanValue(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function render(template, values) {
    const validTemplate = validateTemplate(template);
    const cleanValues = Object.freeze(Object.fromEntries(
        PLACEHOLDERS.map(placeholder => [placeholder, cleanValue(values && values[placeholder])])
    ));
    for (const placeholder of ['item', 'location']) {
        if (validTemplate.includes(`{${placeholder}}`) && cleanValues[placeholder] === '') {
            throw new TypeError(`placeholder {${placeholder}} is unavailable for this alert`);
        }
    }
    const output = validTemplate.replace(PLACEHOLDER_PATTERN, (_match, placeholder) => cleanValues[placeholder]);
    if (output.trim() === '') throw new TypeError('rendered in-game raid alert is empty');
    return output;
}

module.exports = Object.freeze({
    DEFAULT_FILE_PATH,
    DEFAULT_IN_GAME_MESSAGE_TEMPLATE,
    MAX_TEMPLATE_LENGTH,
    PLACEHOLDERS,
    load,
    render,
    validateTemplate
});
