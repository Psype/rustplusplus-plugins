// @ts-check
/* Durable append-only JSONL store. Projections are rebuilt exclusively from this journal. */

const Fs = require('node:fs');
const Path = require('node:path');

const Contracts = require('./contracts.js');

const sharedDirectories = new Map();

class HistoryCorruptionError extends Error {
    /** @param {string} file @param {number} line @param {unknown} cause */
    constructor(file, line, cause) {
        super(`Player-intelligence history is corrupt at ${file}:${line}; the journal was preserved.`);
        this.name = 'HistoryCorruptionError';
        this.file = file;
        this.line = line;
        this.cause = cause;
    }
}

/** @param {string} directory */
function getSharedState(directory) {
    const key = Path.resolve(directory);
    if (!sharedDirectories.has(key)) {
        sharedDirectories.set(key, {
            queue: Promise.resolve(), knownEventIds: null, cachedEvents: null, diskSignature: null
        });
    }
    return sharedDirectories.get(key);
}

/** @param {string} directory */
async function shardNames(directory) {
    try {
        return (await Fs.promises.readdir(directory))
            .filter(name => /^\d{4}-\d{2}\.jsonl$/u.test(name)).sort();
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
        throw error;
    }
}

/** @param {string} directory @param {readonly string[]} names */
async function diskSignature(directory, names) {
    const values = [];
    for (const name of names) {
        const stat = await Fs.promises.stat(Path.join(directory, name));
        values.push(`${name}:${stat.size}:${stat.mtimeMs}`);
    }
    return values.join('|');
}

/** @param {string} directory @param {readonly string[]|null} [names] */
async function readAllUnlocked(directory, names = null) {
    const files = names || await shardNames(directory);
    const events = [];
    for (const file of files) {
        const path = Path.join(directory, file);
        const content = await Fs.promises.readFile(path, 'utf8');
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
            if (lines[index] === '') continue;
            try {
                events.push(Contracts.createEvent(JSON.parse(lines[index])));
            }
            catch (error) {
                throw new HistoryCorruptionError(path, index + 1, error);
            }
        }
    }
    return events;
}

/** @param {any} shared @param {string} directory */
async function loadCachedEvents(shared, directory) {
    const names = await shardNames(directory);
    const signature = await diskSignature(directory, names);
    if (shared.cachedEvents !== null && shared.diskSignature === signature) return shared.cachedEvents;
    const events = Object.freeze(await readAllUnlocked(directory, names));
    const verifiedNames = await shardNames(directory);
    const verifiedSignature = await diskSignature(directory, verifiedNames);
    if (signature !== verifiedSignature) {
        throw new Error('Player-intelligence history changed while it was being read.');
    }
    shared.cachedEvents = events;
    shared.diskSignature = signature;
    shared.knownEventIds = new Set(events.map(item => item.eventId));
    return events;
}

/** @param {readonly Readonly<Record<string, any>>[]} existing
 * @param {readonly Readonly<Record<string, any>>[]} additions */
function mergeInShardOrder(existing, additions) {
    const shards = new Map();
    for (const event of [...existing, ...additions]) {
        const shard = `${event.recordedAt.slice(0, 7)}.jsonl`;
        const values = shards.get(shard) || [];
        values.push(event);
        shards.set(shard, values);
    }
    return Object.freeze([...shards.keys()].sort().flatMap(shard => shards.get(shard)));
}

class JsonlHistoryStore {
    /** @param {{directory: string}} options */
    constructor(options) {
        if (!options || typeof options.directory !== 'string' || options.directory.trim() === '') {
            throw new TypeError('JsonlHistoryStore requires a directory.');
        }
        this.directory = Path.resolve(options.directory);
        this.shared = getSharedState(this.directory);
        Object.freeze(this);
    }

    /**
     * Appends one event exactly once. All appends to the same directory are serialized in-process.
     * The acknowledgement happens only after fsync.
     * @param {unknown} input
     * @returns {Promise<Readonly<{appended: boolean, event: Readonly<Record<string, any>>}>>}
     */
    append(input) {
        return this.appendMany([input]).then(results => results[0]);
    }

    /**
     * Appends a batch with one fsync per monthly shard. Duplicate events remain acknowledged but are not rewritten.
     * @param {readonly unknown[]} inputs
     * @returns {Promise<readonly Readonly<{appended: boolean, event: Readonly<Record<string, any>>}>[]>}
     */
    appendMany(inputs) {
        if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 5000) {
            throw new TypeError('Player-intelligence append batch must contain between 1 and 5000 events.');
        }
        const events = inputs.map(input => Contracts.createEvent(input));
        const operation = this.shared.queue.then(async () => {
            let existing;
            try {
                existing = await loadCachedEvents(this.shared, this.directory);
            }
            catch (error) {
                this.shared.knownEventIds = null;
                this.shared.cachedEvents = null;
                this.shared.diskSignature = null;
                throw error;
            }
            const batchIds = new Set();
            /** @type {Readonly<Record<string, any>>[]} */
            const additions = [];
            const results = events.map(event => {
                const appended = !this.shared.knownEventIds.has(event.eventId) && !batchIds.has(event.eventId);
                batchIds.add(event.eventId);
                if (appended) additions.push(event);
                return { appended, event };
            });
            if (additions.length === 0) {
                return Object.freeze(results.map(result => Object.freeze(result)));
            }

            await Fs.promises.mkdir(this.directory, { recursive: true });
            /** @type {Map<string, Readonly<Record<string, any>>[]>} */
            const shards = new Map();
            for (const event of additions) {
                const shard = `${event.recordedAt.slice(0, 7)}.jsonl`;
                const values = shards.get(shard) || [];
                values.push(event);
                shards.set(shard, values);
            }
            try {
                for (const [shard, shardEvents] of shards) {
                    const handle = await Fs.promises.open(Path.join(this.directory, shard), 'a');
                    try {
                        const buffer = Buffer.from(`${shardEvents.map(event => JSON.stringify(event)).join('\n')}\n`,
                            'utf8');
                        let offset = 0;
                        while (offset < buffer.length) {
                            const result = await handle.write(buffer, offset, buffer.length - offset, null);
                            if (result.bytesWritten <= 0) {
                                throw new Error('Unable to append player-intelligence events.');
                            }
                            offset += result.bytesWritten;
                        }
                        await handle.sync();
                    }
                    finally {
                        await handle.close();
                    }
                }
            }
            catch (error) {
                this.shared.knownEventIds = null;
                this.shared.cachedEvents = null;
                this.shared.diskSignature = null;
                throw error;
            }
            additions.forEach(event => this.shared.knownEventIds.add(event.eventId));
            this.shared.cachedEvents = mergeInShardOrder(existing, additions);
            try {
                const names = await shardNames(this.directory);
                this.shared.diskSignature = await diskSignature(this.directory, names);
            }
            catch {
                this.shared.cachedEvents = null;
                this.shared.diskSignature = null;
            }
            return Object.freeze(results.map(result => Object.freeze(result)));
        });
        this.shared.queue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    /** @returns {Promise<readonly Readonly<Record<string, any>>[]>} */
    readAll() {
        const operation = this.shared.queue.then(async () => {
            try {
                return await loadCachedEvents(this.shared, this.directory);
            }
            catch (error) {
                this.shared.knownEventIds = null;
                this.shared.cachedEvents = null;
                this.shared.diskSignature = null;
                throw error;
            }
        });
        this.shared.queue = operation.then(() => undefined, () => undefined);
        return operation;
    }
}

module.exports = Object.freeze({ HistoryCorruptionError, JsonlHistoryStore });
