const Assert = require('node:assert/strict');
const Test = require('node:test');

const BoundedTtlCache = require('../src/util/boundedTtlCache.js');

Test('bounded TTL cache expires entries and evicts the least recently used key', () => {
    let now = 1000;
    const cache = BoundedTtlCache.createBoundedTtlCache({
        maxEntries: 2,
        defaultTtlMs: 100,
        now: () => now
    });
    cache.set('first', Object.freeze({ value: 1 }));
    cache.set('second', Object.freeze({ value: 2 }));
    Assert.equal(cache.get('first').value, 1);
    cache.set('third', Object.freeze({ value: 3 }));
    Assert.equal(cache.get('second'), undefined);
    Assert.equal(cache.get('first').value, 1);
    Assert.equal(cache.get('third').value, 3);
    Assert.equal(cache.size, 2);

    now += 101;
    Assert.equal(cache.get('first'), undefined);
    Assert.equal(cache.prune(), 1);
    Assert.equal(cache.size, 0);
});

Test('bounded TTL cache does not refresh expiry on access and accepts an explicit provider clock', () => {
    const cache = BoundedTtlCache.createBoundedTtlCache({
        maxEntries: 1,
        defaultTtlMs: 1000,
        now: () => 0
    });
    cache.set('key', 'value', 25, 100);
    Assert.equal(cache.get('key', 124), 'value');
    Assert.equal(cache.get('key', 125), undefined);
    Assert.equal(cache.size, 0);
});

Test('bounded TTL cache rejects unbounded configuration and invalid clocks', () => {
    Assert.throws(() => BoundedTtlCache.createBoundedTtlCache({ maxEntries: 0, defaultTtlMs: 1 }),
        /maxEntries/);
    Assert.throws(() => BoundedTtlCache.createBoundedTtlCache({ maxEntries: 1, defaultTtlMs: 0 }),
        /defaultTtlMs/);
    const cache = BoundedTtlCache.createBoundedTtlCache({
        maxEntries: 1,
        defaultTtlMs: 1,
        now: () => Number.NaN
    });
    Assert.throws(() => cache.set('key', 'value'), /clock/);
});
