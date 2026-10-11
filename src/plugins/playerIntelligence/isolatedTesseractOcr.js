const Path = require('node:path');

const ProcessSupervisor = require('../../util/processSupervisor.js');

const supervisor = ProcessSupervisor.create({
    name: 'tesseract-ocr',
    modulePath: Path.join(__dirname, '..', '..', 'workers', 'tesseractWorker.js'),
    timeoutMs: 60 * 1000,
    maxQueue: 2,
    maxOldSpaceMiB: 384,
    maxRequestBytes: 16 * 1024 * 1024,
    maxResponseBytes: 4 * 1024 * 1024
});

function recognize(imageBase64, options = {}) {
    return supervisor.request('recognize', { imageBase64, options });
}

module.exports = Object.freeze({
    getRuntimeStatus: supervisor.status,
    recognize,
    shutdown: supervisor.stop
});
