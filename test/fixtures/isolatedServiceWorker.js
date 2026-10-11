process.on('message', message => {
    if (!message || message.type !== 'request') return;
    if (message.method === 'crash') {
        process.exit(9);
        return;
    }
    if (message.method === 'hang') return;
    if (typeof process.send === 'function') {
        process.send({ v: 1, type: 'response', id: message.id, ok: true, result: message.payload });
    }
});
