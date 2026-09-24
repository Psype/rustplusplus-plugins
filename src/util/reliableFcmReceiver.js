/*
 * Reliable MCS transport for the legacy Rust+ GCM credentials.
 *
 * The public push-receiver package still provides credential check-in and the
 * wire parser, but its client considers a raw socket connection ready and does
 * not implement the MCS heartbeat/acknowledgement lifecycle. Keep this adapter
 * isolated so the application-facing ON_DATA_RECEIVED contract stays stable.
 */

const EventEmitter = require('events');
const { createRequire } = require('module');
const Path = require('path');
const Tls = require('tls');

const pushReceiverRequire = createRequire(require.resolve('@liamcottle/push-receiver/package.json'));
const { load } = pushReceiverRequire('protobufjs');

const Parser = require('@liamcottle/push-receiver/src/parser');
const { checkIn } = require('@liamcottle/push-receiver/src/gcm');
const {
    kMCSVersion,
    kHeartbeatPingTag,
    kHeartbeatAckTag,
    kLoginRequestTag,
    kLoginResponseTag,
    kCloseTag,
    kIqStanzaTag,
    kDataMessageStanzaTag,
    kStreamErrorStanzaTag
} = require('@liamcottle/push-receiver/src/constants');

const MCS_PROTO_PATH = Path.join(
    Path.dirname(require.resolve('@liamcottle/push-receiver/src/client')),
    'mcs.proto'
);
const DEFAULT_ENDPOINTS = Object.freeze([
    Object.freeze({ host: 'mtalk.google.com', port: 5228 }),
    Object.freeze({ host: 'mtalk.google.com', port: 443 })
]);
const STREAM_ACK_EXTENSION_ID = 13;
const IQ_SET = 1;
const MAX_PERSISTENT_IDS = 100;

let protocolPromise = null;

function getProtocol() {
    if (!protocolPromise) protocolPromise = load(MCS_PROTO_PATH);
    return protocolPromise;
}

function unref(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
}

function messageFor(error) {
    return error instanceof Error ? error.message : String(error);
}

function isFatalCredentialError(error) {
    const status = error && error.response && error.response.status;
    if ([400, 401, 403].includes(status)) return true;
    return /tokeninvalid|authentication|auth token|login rejected|unauthori[sz]ed|forbidden/i.test(messageFor(error));
}

class ReliableFcmReceiver extends EventEmitter {
    constructor(androidId, securityToken, persistentIds = [], dependencies = {}) {
        super();
        if (!/^\d+$/.test(String(androidId))) throw new TypeError('androidId must be a decimal identifier');
        if (!String(securityToken || '').trim()) throw new TypeError('securityToken is required');

        this._androidId = String(androidId);
        this._securityToken = String(securityToken);
        this._persistentIds = Array.isArray(persistentIds) ? [...persistentIds] : [];
        this._checkIn = dependencies.checkIn || checkIn;
        this._socketFactory = dependencies.socketFactory || (options => Tls.connect(options));
        this._parserFactory = dependencies.parserFactory || (socket => new Parser(socket));
        this._scheduler = dependencies.scheduler || {
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval
        };
        this._endpoints = dependencies.endpoints || DEFAULT_ENDPOINTS;
        this._heartbeatIntervalMs = dependencies.heartbeatIntervalMs || 5 * 60 * 1000;
        this._heartbeatAckTimeoutMs = dependencies.heartbeatAckTimeoutMs || 90 * 1000;
        this._inactivityTimeoutMs = dependencies.inactivityTimeoutMs || 12 * 60 * 1000;
        this._loginTimeoutMs = dependencies.loginTimeoutMs || 20 * 1000;
        this._checkInTimeoutMs = dependencies.checkInTimeoutMs || 15 * 1000;
        this._reconnectMaxDelayMs = dependencies.reconnectMaxDelayMs || 30 * 1000;

        this._protocol = null;
        this._socket = null;
        this._parser = null;
        this._connectPromise = null;
        this._sessionResolve = null;
        this._sessionReject = null;
        this._ready = false;
        this._stopped = false;
        this._retryCount = 0;
        this._lastStreamIdReceived = 0;
        this._heartbeatTimer = null;
        this._heartbeatAckTimer = null;
        this._inactivityTimer = null;
        this._loginTimer = null;
        this._reconnectTimer = null;

        this._onMessage = this._onMessage.bind(this);
        this._onParserError = this._onParserError.bind(this);
        this._onSocketClose = this._onSocketClose.bind(this);
        this._onSocketError = this._onSocketError.bind(this);
    }

    async connect() {
        if (this._ready) return;
        if (this._connectPromise) return this._connectPromise;
        this._stopped = false;
        this._connectPromise = this._establish().finally(() => {
            this._connectPromise = null;
        });
        return this._connectPromise;
    }

    destroy() {
        this._stopped = true;
        this._clearTimer('_reconnectTimer', 'clearTimeout');
        const pendingReject = this._sessionReject;
        this._sessionResolve = null;
        this._sessionReject = null;
        this._teardownSession();
        if (pendingReject) pendingReject(new Error('FCM receiver destroyed'));
    }

    async _establish() {
        this._protocol = await getProtocol();
        await Parser.init();
        await this._withTimeout(
            Promise.resolve(this._checkIn(this._androidId, this._securityToken)),
            this._checkInTimeoutMs,
            'GCM check-in timed out'
        );

        let lastError = null;
        for (const endpoint of this._endpoints) {
            if (this._stopped) throw new Error('FCM receiver stopped');
            try {
                await this._openSession(endpoint);
                return;
            }
            catch (error) {
                lastError = error;
                if (error.fatal || isFatalCredentialError(error)) throw error;
            }
        }
        throw lastError || new Error('No MCS endpoint is available');
    }

    _openSession(endpoint) {
        this._teardownSession();
        this._lastStreamIdReceived = 0;

        return new Promise((resolve, reject) => {
            this._sessionResolve = resolve;
            this._sessionReject = reject;

            let socket;
            try {
                socket = this._socketFactory({
                    host: endpoint.host,
                    port: endpoint.port,
                    servername: endpoint.host
                });
                this._socket = socket;
                socket.setKeepAlive?.(true, 60 * 1000);
                socket.once('secureConnect', () => {
                    try {
                        this._sendRaw(this._loginBuffer());
                    }
                    catch (error) {
                        this._failSession(error);
                    }
                });
                socket.once('close', this._onSocketClose);
                socket.once('error', this._onSocketError);

                this._parser = this._parserFactory(socket);
                this._parser.on('message', this._onMessage);
                this._parser.on('error', this._onParserError);
                this._loginTimer = unref(this._scheduler.setTimeout(
                    () => this._failSession(new Error('MCS login timed out')),
                    this._loginTimeoutMs
                ));
            }
            catch (error) {
                this._failSession(error);
            }
        });
    }

    _loginBuffer() {
        const type = this._protocol.lookupType('mcs_proto.LoginRequest');
        const request = {
            adaptiveHeartbeat: false,
            authService: 2,
            authToken: this._securityToken,
            id: 'chrome-63.0.3234.0',
            domain: 'mcs.android.com',
            deviceId: `android-${BigInt(this._androidId).toString(16)}`,
            networkType: 1,
            resource: this._androidId,
            user: this._androidId,
            useRmq2: true,
            setting: [{ name: 'new_vc', value: '1' }],
            clientEvent: [],
            receivedPersistentId: this._persistentIds
        };
        const validationError = type.verify(request);
        if (validationError) throw new Error(`Invalid MCS login request: ${validationError}`);
        return Buffer.concat([
            Buffer.from([kMCSVersion, kLoginRequestTag]),
            Buffer.from(type.encodeDelimited(type.create(request)).finish())
        ]);
    }

    _onMessage({ tag, object }) {
        this._lastStreamIdReceived += 1;
        this._resetInactivityTimer();

        try {
            switch (tag) {
                case kLoginResponseTag:
                    this._handleLoginResponse(object);
                    break;
                case kHeartbeatPingTag:
                    this._sendMessage(kHeartbeatAckTag, 'mcs_proto.HeartbeatAck', {
                        lastStreamIdReceived: this._lastStreamIdReceived,
                        status: object.status === undefined ? undefined : Number(object.status)
                    });
                    break;
                case kHeartbeatAckTag:
                    this._clearTimer('_heartbeatAckTimer', 'clearTimeout');
                    break;
                case kDataMessageStanzaTag:
                    try {
                        this._handleDataMessage(object);
                    }
                    finally {
                        this._sendStreamAck();
                    }
                    break;
                case kCloseTag:
                    this._failSession(new Error('MCS server requested close'));
                    break;
                case kStreamErrorStanzaTag:
                    this._failSession(new Error(`MCS stream error: ${object.text || object.type || 'unknown'}`));
                    break;
                default:
                    break;
            }
        }
        catch (error) {
            this._failSession(error);
        }
    }

    _handleLoginResponse(response) {
        if (response.error) {
            const detail = response.error.message || response.error.type || response.error.code || 'unknown';
            const error = new Error(`MCS login rejected: ${detail}`);
            error.fatal = true;
            this._failSession(error);
            return;
        }

        this._clearTimer('_loginTimer', 'clearTimeout');
        this._ready = true;
        this._retryCount = 0;
        this._startHeartbeat();
        this._resetInactivityTimer();

        const resolve = this._sessionResolve;
        this._sessionResolve = null;
        this._sessionReject = null;
        if (resolve) resolve();
        this.emit('connect');
    }

    _handleDataMessage(object) {
        const persistentId = object.persistentId;
        if (persistentId && this._persistentIds.includes(persistentId)) return;

        if (persistentId) {
            this._persistentIds.push(persistentId);
            if (this._persistentIds.length > MAX_PERSISTENT_IDS) this._persistentIds.shift();
        }
        this.emit('ON_DATA_RECEIVED', object);
    }

    _sendHeartbeat() {
        if (!this._ready) return;
        try {
            this._sendMessage(kHeartbeatPingTag, 'mcs_proto.HeartbeatPing', {
                lastStreamIdReceived: this._lastStreamIdReceived
            });
            this._clearTimer('_heartbeatAckTimer', 'clearTimeout');
            this._heartbeatAckTimer = unref(this._scheduler.setTimeout(
                () => this._failSession(new Error('MCS heartbeat acknowledgement timed out')),
                this._heartbeatAckTimeoutMs
            ));
        }
        catch (error) {
            this._failSession(error);
        }
    }

    _sendStreamAck() {
        if (!this._ready) return;
        this._sendMessage(kIqStanzaTag, 'mcs_proto.IqStanza', {
            type: IQ_SET,
            id: '',
            extension: { id: STREAM_ACK_EXTENSION_ID, data: Buffer.alloc(0) },
            lastStreamIdReceived: this._lastStreamIdReceived,
            status: 0
        });
    }

    _sendMessage(tag, typeName, payload) {
        const type = this._protocol.lookupType(typeName);
        const cleanPayload = Object.fromEntries(
            Object.entries(payload).filter(([, value]) => value !== undefined)
        );
        const validationError = type.verify(cleanPayload);
        if (validationError) throw new Error(`Invalid ${typeName}: ${validationError}`);
        this._sendRaw(Buffer.concat([
            Buffer.from([tag]),
            Buffer.from(type.encodeDelimited(type.create(cleanPayload)).finish())
        ]));
    }

    _sendRaw(buffer) {
        if (!this._socket || this._socket.destroyed || this._socket.writable === false) {
            throw new Error('MCS socket is not writable');
        }
        this._socket.write(buffer);
    }

    _startHeartbeat() {
        this._clearTimer('_heartbeatTimer', 'clearInterval');
        this._heartbeatTimer = unref(this._scheduler.setInterval(
            () => this._sendHeartbeat(),
            this._heartbeatIntervalMs
        ));
    }

    _resetInactivityTimer() {
        this._clearTimer('_inactivityTimer', 'clearTimeout');
        this._inactivityTimer = unref(this._scheduler.setTimeout(
            () => this._failSession(new Error('MCS connection inactive beyond watchdog limit')),
            this._inactivityTimeoutMs
        ));
    }

    _onSocketClose() {
        this._failSession(new Error('MCS socket closed'));
    }

    _onSocketError(error) {
        this._failSession(error);
    }

    _onParserError(error) {
        this._failSession(error);
    }

    _failSession(error) {
        const wasReady = this._ready;
        const reject = this._sessionReject;
        this._sessionResolve = null;
        this._sessionReject = null;
        this._teardownSession();

        if (reject) {
            reject(error);
            return;
        }
        if (!wasReady || this._stopped) return;

        const fatal = error.fatal || isFatalCredentialError(error);
        this.emit('transport-error', error);
        this.emit('disconnect', error, { willReconnect: !fatal });
        if (fatal) {
            this._stopped = true;
            this.emit('fatal', error);
            return;
        }
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this._stopped || this._reconnectTimer) return;
        const delay = Math.min(1000 * (2 ** Math.min(this._retryCount, 5)), this._reconnectMaxDelayMs);
        this._retryCount += 1;
        this._reconnectTimer = unref(this._scheduler.setTimeout(async () => {
            this._reconnectTimer = null;
            try {
                await this.connect();
            }
            catch (error) {
                this.emit('transport-error', error);
                if (isFatalCredentialError(error)) {
                    this._stopped = true;
                    this.emit('fatal', error);
                    return;
                }
                this._scheduleReconnect();
            }
        }, delay));
    }

    _teardownSession() {
        this._ready = false;
        this._clearTimer('_loginTimer', 'clearTimeout');
        this._clearTimer('_heartbeatTimer', 'clearInterval');
        this._clearTimer('_heartbeatAckTimer', 'clearTimeout');
        this._clearTimer('_inactivityTimer', 'clearTimeout');

        if (this._parser) {
            this._parser.removeListener('message', this._onMessage);
            this._parser.removeListener('error', this._onParserError);
            this._parser.destroy?.();
            this._parser = null;
        }
        if (this._socket) {
            this._socket.removeListener('close', this._onSocketClose);
            this._socket.removeListener('error', this._onSocketError);
            this._socket.destroy();
            this._socket = null;
        }
    }

    _clearTimer(field, method) {
        if (!this[field]) return;
        this._scheduler[method](this[field]);
        this[field] = null;
    }

    _withTimeout(promise, timeoutMs, timeoutMessage) {
        return new Promise((resolve, reject) => {
            const timer = unref(this._scheduler.setTimeout(
                () => reject(new Error(timeoutMessage)),
                timeoutMs
            ));
            promise.then(
                value => {
                    this._scheduler.clearTimeout(timer);
                    resolve(value);
                },
                error => {
                    this._scheduler.clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }
}

module.exports = ReliableFcmReceiver;
