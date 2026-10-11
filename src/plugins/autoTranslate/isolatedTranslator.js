const Path = require('node:path');

const ProcessSupervisor = require('../../util/processSupervisor.js');

const supervisor = ProcessSupervisor.create({
    name: 'translation',
    modulePath: Path.join(__dirname, '..', '..', 'workers', 'translationWorker.js'),
    timeoutMs: 7000,
    maxQueue: 4,
    maxOldSpaceMiB: 128
});

function translate(text, options) {
    return supervisor.request('translate', { text, options });
}

module.exports = translate;
module.exports.getRuntimeStatus = supervisor.status;
module.exports.shutdown = supervisor.stop;
