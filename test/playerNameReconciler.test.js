const Assert = require('node:assert/strict');
const Test = require('node:test');

const Reconciler = require('../src/util/playerNameReconciler.js');

function options(mode, priority = () => 0) {
    return {
        mode,
        getAliases: target => target.aliases,
        getIdentifiers: target => target.ids,
        getPriority: priority,
        getKey: target => target.id
    };
}

Test('first mode returns the closest partial alias without an ambiguity prompt', () => {
    const targets = [
        { id: '1', aliases: ['Cockornut Tree'], ids: ['101'] },
        { id: '2', aliases: ['A distant treeline player'], ids: ['102'] },
        { id: '3', aliases: ['Stone'], ids: ['103'] }
    ];

    const result = Reconciler.reconcile('tree', targets, options(Reconciler.MODE_FIRST));

    Assert.strictEqual(result.target, targets[0]);
    Assert.equal(result.ambiguous, false);
    Assert.deepEqual(result.candidates.map(target => target.id), ['1', '2']);
    Assert.equal(result.matches[0].alias, 'Cockornut Tree');
});

Test('several fragments must occur in the same alias and improve local reconciliation', () => {
    const targets = [
        { id: 'peng', aliases: ['KOH PENG 🕷'], ids: [] },
        { id: 'koh', aliases: ['KOH Warrior'], ids: [] },
        { id: 'other', aliases: ['Jumping Penguin'], ids: [] }
    ];

    const result = Reconciler.reconcile(['KOH', 'PENG'], targets, options(Reconciler.MODE_FIRST));

    Assert.strictEqual(result.target, targets[0]);
    Assert.deepEqual(result.fragments, ['KOH', 'PENG']);
    Assert.deepEqual(result.candidates, [targets[0]]);
});

Test('precise mode returns every equally ranked candidate instead of choosing one', () => {
    const targets = [
        { id: '1', aliases: ['Nirks'], ids: ['1001'] },
        { id: '2', aliases: ['NirksTwo'], ids: ['1002'] }
    ];

    const result = Reconciler.reconcile('nirk', targets, options(Reconciler.MODE_PRECISE));

    Assert.equal(result.target, null);
    Assert.equal(result.ambiguous, true);
    Assert.deepEqual(result.candidates, targets);
});

Test('priority precedes name quality and identifiers remain exact', () => {
    const targets = [
        { id: 'offline', aliases: ['Kirkstein'], ids: ['9001'], status: 'offline' },
        { id: 'online', aliases: ['Jeffrey Kirkstein The 3rd'], ids: ['9002'], status: 'online' }
    ];
    const precise = options(Reconciler.MODE_PRECISE, target => target.status === 'online' ? 1 : 0);

    Assert.strictEqual(Reconciler.reconcile('kirkstein', targets, precise).target, targets[1]);
    Assert.strictEqual(Reconciler.reconcile('9001', targets, precise).target, targets[0]);
});

Test('canonical punctuation and accents match without weakening substring requirements', () => {
    const targets = [
        { id: '1', aliases: ['KÓH-PENG 🕷'], ids: [] },
        { id: '2', aliases: ['Unrelated'], ids: [] }
    ];

    Assert.strictEqual(Reconciler.reconcile('koh peng', targets,
        options(Reconciler.MODE_FIRST)).target, targets[0]);
    Assert.equal(Reconciler.reconcile('missing', targets,
        options(Reconciler.MODE_FIRST)).target, null);
});
