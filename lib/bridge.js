'use strict';

/*
 * ESPHome native API link to the AquaClean bridge.
 *
 * Uses the transport (Noise encryption, framing, ping, reconnect) of @2colors/esphome-native-api, but does entity
 * listing, state handling and commands itself: the library's entity layer does not know event and time entities,
 * and it drops the sub-device id the bridge relies on (entities with the same name live on different
 * sub-devices, e.g. "Spray intensity" in the active session and in every user profile).
 */

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Connection } = require('@2colors/esphome-native-api');
const messages = require('@2colors/esphome-native-api/lib/utils/messages');

const { pb } = messages;

// The library only maps the message ids it knows; an unknown id (e.g. an event) closes the connection. Register
// every message of its own api.proto that the generated protobuf code has.
(function registerAllMessages() {
    const proto = fs.readFileSync(
        path.join(path.dirname(require.resolve('@2colors/esphome-native-api/lib/protoc/api_pb')), 'api.proto'),
        'utf8',
    );
    const rx = /message\s+(\w+)\s*\{[^}]*?option\s*\(id\)\s*=\s*(\d+)\s*;/g;
    let m;
    while ((m = rx.exec(proto)) !== null) {
        const [, type, id] = m;
        if (!pb[type] || messages.id_to_type[id]) {
            continue;
        }
        messages.id_to_type[id] = type;
        messages.type_to_id[type] = id;
        pb[type].type = type;
        pb[type].id = id;
    }
})();

const LIST_PREFIX = 'ListEntities';
const PLATFORMS = {
    BinarySensor: 'binary_sensor',
    Sensor: 'sensor',
    TextSensor: 'text_sensor',
    Switch: 'switch',
    Number: 'number',
    Select: 'select',
    Text: 'text',
    Button: 'button',
    Light: 'light',
    Time: 'time',
    Event: 'event',
};
const STATE_MESSAGES = {
    BinarySensorStateResponse: 'binary_sensor',
    SensorStateResponse: 'sensor',
    TextSensorStateResponse: 'text_sensor',
    SwitchStateResponse: 'switch',
    NumberStateResponse: 'number',
    SelectStateResponse: 'select',
    TextStateResponse: 'text',
    LightStateResponse: 'light',
    TimeStateResponse: 'time',
    EventResponse: 'event',
};

const pad = n => String(n).padStart(2, '0');

class Bridge extends EventEmitter {
    /**
     * @param {object} opts connection options
     * @param {string} opts.host host name or IP address of the bridge
     * @param {number} [opts.port] native API port
     * @param {string} [opts.key] base64 API encryption key
     * @param {object} opts.match name table from entities.json
     * @param {string} [opts.clientInfo] client name shown in the bridge log
     * @param {(...args: unknown[]) => void} [opts.log] debug logger
     */
    constructor({ host, port = 6053, key, match, clientInfo = 'ioBroker AquaClean Bridge', log = () => {} }) {
        super();
        this.host = host;
        this.port = port;
        this.key = key;
        this.match = match;
        this.clientInfo = clientInfo;
        this.log = log;
        this.entities = new Map(); // "<deviceId>:<key>" -> entity
        this.byBridgeKey = new Map(); // bridge entity key (e.g. "shower_active") -> entity
        this.deviceInfo = null;
        this.ready = false;
    }

    connect() {
        this.conn = new Connection({
            host: this.host,
            port: this.port,
            encryptionKey: this.key || '',
            clientInfo: this.clientInfo,
            reconnect: true,
            reconnectInterval: 15000,
        });
        this.conn.on('authorized', () =>
            this._onAuthorized().catch(err => {
                this.log('initialisation failed:', err.message);
                this.emit('error', err);
            }),
        );
        this.conn.on('unauthorized', () => this._setReady(false));
        this.conn.on('disconnected', () => this._setReady(false));
        this.conn.on('error', err => this.emit('error', err));
        this.conn.on('message', (type, msg) => this._onMessage(type, msg));
        this.conn.connect();
    }

    disconnect() {
        this._setReady(false);
        if (this.conn) {
            const conn = this.conn;
            this.conn = null;
            conn.reconnect = false;
            try {
                conn.disconnect();
            } catch {
                // already gone
            }
        }
    }

    _setReady(ready) {
        if (this.ready === ready) {
            return;
        }
        this.ready = ready;
        this.emit(ready ? 'ready' : 'unavailable');
    }

    async _onAuthorized() {
        this.deviceInfo = await this.conn.deviceInfoService();
        const devices = new Map((this.deviceInfo.devicesList || []).map(d => [d.deviceId, d.name]));
        const list = await this._listEntities();
        this.entities.clear();
        this.byBridgeKey.clear();
        for (const { platform, cfg } of list) {
            const deviceId = cfg.deviceId || 0;
            const devName = deviceId ? devices.get(deviceId) || '' : '';
            const bridgeKey =
                this.match[`${devName}\u0001${cfg.name}`] ||
                (deviceId ? null : this.match[`\u0001${cfg.name}`]) ||
                null;
            const ent = {
                platform,
                key: cfg.key,
                deviceId,
                deviceName: devName,
                name: cfg.name,
                cfg,
                bridgeKey,
                state: undefined,
            };
            this.entities.set(`${deviceId}:${cfg.key}`, ent);
            if (bridgeKey) {
                this.byBridgeKey.set(bridgeKey, ent);
            }
        }
        const unknown = [...this.entities.values()].filter(e => !e.bridgeKey).length;
        this.log(`${this.entities.size} entities, ${this.byBridgeKey.size} recognised, ${unknown} other`);
        this._setReady(true);
    }

    /** Start receiving states (call once the receiver is ready for them, after 'ready'). */
    subscribe() {
        if (this.ready && this.conn) {
            this.conn.subscribeStatesService();
        }
    }

    async _listEntities() {
        const out = [];
        const onMessage = (type, msg) => {
            if (!type.startsWith(LIST_PREFIX) || type === 'ListEntitiesDoneResponse') {
                return;
            }
            const platform = PLATFORMS[type.slice(LIST_PREFIX.length, -'Response'.length)];
            if (platform) {
                out.push({ platform, cfg: msg });
            }
        };
        this.conn.on('message', onMessage);
        try {
            await this.conn.sendMessageAwaitResponse(new pb.ListEntitiesRequest(), 'ListEntitiesDoneResponse', 20);
        } finally {
            this.conn.off('message', onMessage);
        }
        return out;
    }

    _onMessage(type, msg) {
        const platform = STATE_MESSAGES[type];
        if (!platform) {
            return;
        }
        const ent = this.entities.get(`${msg.deviceId || 0}:${msg.key}`);
        if (!ent) {
            return;
        }
        if (platform === 'event') {
            this.emit('event', ent, msg.eventType);
            return;
        }
        let value;
        if (msg.missingState) {
            value = null;
        } else if (platform === 'time') {
            value = `${pad(msg.hour)}:${pad(msg.minute)}`;
        } else {
            value = msg.state;
        }
        const prev = ent.state;
        ent.state = value;
        this.emit('state', ent, value, prev);
    }

    // ------------------------------------------------------------------------------------------- commands

    _check(ent) {
        if (!ent) {
            throw new Error('not available on this toilet');
        }
        if (!this.ready || !this.conn) {
            throw new Error('bridge not connected');
        }
    }

    _send(Msg, ent, set) {
        this._check(ent);
        const m = new Msg();
        m.setKey(ent.key);
        if (ent.deviceId && m.setDeviceId) {
            m.setDeviceId(ent.deviceId);
        }
        set(m);
        this.conn.sendCommandMessage(m);
    }

    press(ent) {
        this._send(pb.ButtonCommandRequest, ent, () => {});
    }

    setSwitch(ent, on) {
        if (ent && ent.platform === 'light') {
            this._send(pb.LightCommandRequest, ent, m => {
                m.setHasState(true);
                m.setState(!!on);
            });
        } else {
            this._send(pb.SwitchCommandRequest, ent, m => m.setState(!!on));
        }
    }

    setNumber(ent, value) {
        this._check(ent);
        const { minValue, maxValue } = ent.cfg;
        const v = Number(value);
        // the real range can be narrower than the documented one (e.g. 3 spray levels on some models)
        if (!Number.isFinite(v) || v < minValue || v > maxValue) {
            throw new Error(`${ent.name}: ${minValue}–${maxValue}`);
        }
        this._send(pb.NumberCommandRequest, ent, m => m.setState(v));
    }

    setSelect(ent, option) {
        this._check(ent);
        this._send(pb.SelectCommandRequest, ent, m => m.setState(String(option)));
    }

    setText(ent, text) {
        this._send(pb.TextCommandRequest, ent, m => m.setState(String(text)));
    }

    setTime(ent, hhmm) {
        this._check(ent);
        const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(hhmm).trim());
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
            throw new Error(`${ent.name}: HH:MM`);
        }
        this._send(pb.TimeCommandRequest, ent, msg => {
            msg.setHour(Number(m[1]));
            msg.setMinute(Number(m[2]));
            msg.setSecond(0);
        });
    }
}

module.exports = Bridge;
