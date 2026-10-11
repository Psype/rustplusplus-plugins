// @ts-check
/* Durable append-only JSONL store. Projections are rebuilt exclusively from this journal. */

const Fs = require('node:fs');
const Path = require('node:path');
const Crypto = require('node:crypto');

const Contracts = require('./contracts.js');
const RuntimeTelemetry = require('../../util/runtimeTelemetry.js');

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
            queue: Promise.resolve(), knownEventIds: null, cachedEvents: null, diskSignature: null, revision: null
        });
    }
    return sharedDirectories.get(key);
}

/** @param {readonly Readonly<Record<string, any>>[]} events */
function historyRevision(events) {
    const hash = Crypto.createHash('sha256');
    hash.update(`${events.length}:`, 'utf8');
    for (const event of events) {
        const encoded = JSON.stringify(event);
        hash.update(`${Buffer.byteLength(encoded)}:`, 'utf8').update(encoded, 'utf8');
    }
    return `pi-revision:${hash.digest('hex')}`;
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
        let start = 0;
        let line = 0;
        while (start < content.length) {
            const newline = content.indexOf('\n', start);
            const end = newline === -1 ? content.length : newline;
            line += 1;
            const value = content.slice(start, end);
            start = newline === -1 ? content.length : newline + 1;
            if (value === '') continue;
            try {
                events.push(Contracts.createEvent(JSON.parse(value)));
            }
            catch (error) {
                throw new HistoryCorruptionError(path, line, error);
            }
        }
    }
    return events;
}

/** @param {any} shared @param {string} directory */
async function loadCachedEvents(shared, directory) {
    const names = await shardNames(directory);
    const signature = await diskSignature(directory, names);
    if (shared.cachedEvents !== null && shared.diskSignature === signature) {
        if (shared.revision === null) shared.revision = historyRevision(shared.cachedEvents);
        return shared.cachedEvents;
    }
    const events = Object.freeze(await readAllUnlocked(directory, names));
    const verifiedNames = await shardNames(directory);
    const verifiedSignature = await diskSignature(directory, verifiedNames);
    if (signature !== verifiedSignature) {
        throw new Error('Player-intelligence history changed while it was being read.');
    }
    shared.cachedEvents = events;
    shared.diskSignature = signature;
    shared.knownEventIds = new Set(events.map(item => item.eventId));
    shared.revision = historyRevision(events);
    return events;
}

/** @param {readonly Readonly<Record<string, any>>[]} existing
 * @param {readonly Readonly<Record<string, any>>[]} additions */
function mergeInShardOrder(existing, additions) {
    const additionsByShard = new Map();
    for (const event of additions) {
        const shard = `${event.recordedAt.slice(0, 7)}.jsonl`;
        const values = additionsByShard.get(shard) || [];
        values.push(event);
        additionsByShard.set(shard, values);
    }
    const additionShards = [...additionsByShard.keys()].sort();
    const merged = [];
    let existingIndex = 0;
    let additionIndex = 0;
    while (existingIndex < existing.length) {
        const existingShard = `${existing[existingIndex].recordedAt.slice(0, 7)}.jsonl`;
        while (additionIndex < additionShards.length && additionShards[additionIndex] < existingShard) {
            merged.push(...additionsByShard.get(additionShards[additionIndex]));
            additionIndex += 1;
        }
        while (existingIndex < existing.length &&
            `${existing[existingIndex].recordedAt.slice(0, 7)}.jsonl` === existingShard) {
            merged.push(existing[existingIndex]);
            existingIndex += 1;
        }
        if (additionShards[additionIndex] === existingShard) {
            merged.push(...additionsByShard.get(existingShard));
            additionIndex += 1;
        }
    }
    while (additionIndex < additionShards.length) {
        merged.push(...additionsByShard.get(additionShards[additionIndex]));
        additionIndex += 1;
    }
    return Object.freeze(merged);
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
        return this.appendManyIfRevision(inputs, null).then(commit => commit.results);
    }

    /**
     * Atomically compares the current journal revision and appends inside the same in-process writer queue.
     * An empty batch is allowed so a read-only plan can guard its checkpoint write against a stale snapshot.
     * Optional callbacks execute while the writer queue is held, allowing a caller to guard and commit
     * an adjacent checkpoint without another in-process journal append interleaving.
     * @param {readonly unknown[]} inputs @param {string|null} expectedRevision
     * @param {{beforeAppend?:(events:readonly Readonly<Record<string,any>>[],revision:string)=>Promise<void>|void,
     * afterAppend?:()=>Promise<void>|void}} [transaction]
     * @returns {Promise<Readonly<{committed:boolean,revision:string,
     * results:readonly Readonly<{appended:boolean,event:Readonly<Record<string,any>>}>[]}>>}
     */
    appendManyIfRevision(inputs, expectedRevision, transaction = {}) {
        if (!Array.isArray(inputs) || inputs.length > 5000) {
            throw new TypeError('Player-intelligence append batch must contain at most 5000 events.');
        }
        if (expectedRevision !== null && !/^pi-revision:[a-f0-9]{64}$/u.test(expectedRevision)) {
            throw new TypeError('Player-intelligence expected revision is invalid.');
        }
        if (!transaction || typeof transaction !== 'object' ||
            (transaction.beforeAppend !== undefined && typeof transaction.beforeAppend !== 'function') ||
            (transaction.afterAppend !== undefined && typeof transaction.afterAppend !== 'function')) {
            throw new TypeError('Player-intelligence append transaction is invalid.');
        }
        if (inputs.length === 0 && expectedRevision === null && !transaction.beforeAppend &&
            !transaction.afterAppend) {
            throw new TypeError('An empty player-intelligence append requires a guarded transaction.');
        }
        const events = inputs.map(input => Contracts.createEvent(input));
        const span = RuntimeTelemetry.startSpan('pi_history_append');
        const operation = this.shared.queue.then(async () => {
            let existing;
            try {
                existing = await loadCachedEvents(this.shared, this.directory);
            }
            catch (error) {
                this.shared.knownEventIds = null;
                this.shared.cachedEvents = null;
                this.shared.diskSignature = null;
                this.shared.revision = null;
                throw error;
            }
            const currentRevision = this.shared.revision || historyRevision(existing);
            this.shared.revision = currentRevision;
            if (expectedRevision !== null && currentRevision !== expectedRevision) {
                return Object.freeze({ committed: false, revision: currentRevision, results: Object.freeze([]) });
            }
            if (transaction.beforeAppend) await transaction.beforeAppend(existing, currentRevision);
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
                if (transaction.afterAppend) await transaction.afterAppend();
                return Object.freeze({ committed: true, revision: currentRevision,
                    results: Object.freeze(results.map(result => Object.freeze(result))) });
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
                this.shared.revision = null;
                throw error;
            }
            additions.forEach(event => this.shared.knownEventIds.add(event.eventId));
            this.shared.cachedEvents = mergeInShardOrder(existing, additions);
            const committedRevision = historyRevision(this.shared.cachedEvents);
            this.shared.revision = committedRevision;
            try {
                const names = await shardNames(this.directory);
                this.shared.diskSignature = await diskSignature(this.directory, names);
            }
            catch {
                this.shared.cachedEvents = null;
                this.shared.diskSignature = null;
                this.shared.revision = null;
            }
            if (transaction.afterAppend) await transaction.afterAppend();
            return Object.freeze({ committed: true, revision: committedRevision,
                results: Object.freeze(results.map(result => Object.freeze(result))) });
        });
        this.shared.queue = operation.then(() => undefined, () => undefined);
        return operation.then((/** @type {any} */ result) => {
            span.finish('success');
            return result;
        }, (/** @type {unknown} */ error) => {
            span.finish('failure');
            throw error;
        });
    }

    /** @returns {Promise<Readonly<{events:readonly Readonly<Record<string,any>>[],revision:string}>>} */
    readSnapshot() {
        const operation = this.shared.queue.then(async () => {
            try {
                const events = await loadCachedEvents(this.shared, this.directory);
                const revision = this.shared.revision || historyRevision(events);
                this.shared.revision = revision;
                return Object.freeze({ events, revision });
            }
            catch (error) {
                this.shared.knownEventIds = null;
                this.shared.cachedEvents = null;
                this.shared.diskSignature = null;
                this.shared.revision = null;
                throw error;
            }
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
                this.shared.revision = null;
                throw error;
            }
        });
        this.shared.queue = operation.then(() => undefined, () => undefined);
        return operation;
    }
}

module.exports = Object.freeze({ HistoryCorruptionError, JsonlHistoryStore });
