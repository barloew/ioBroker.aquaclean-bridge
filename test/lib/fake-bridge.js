'use strict';

/*
 * A small ESPHome native API server (plaintext) that imitates the bridge's API surface: Dutch firmware names,
 * sub-devices, and one entity of every kind the adapter handles. Not the bridge firmware: it only answers the
 * listing, sends states and records the commands it receives, echoing them as new states like the bridge does.
 */

const net = require('net');
require('../../lib/bridge'); // registers every api.proto message with the library (event, time, …)
const { pb } = require('@2colors/esphome-native-api/lib/utils/messages');
const table = require('../../lib/entities.json');

const LANG = 'nl';
const REC = new Map(table.entities.map(r => [r.key, r]));
const DEVICES = ['toilet', 'session', 'maintenance', 'profile_1', 'profile_2', 'profile_3', 'profile_4', 'profile_5', 'profile_6'];
const DEVICE_ID = Object.fromEntries(DEVICES.map((d, i) => [d, 1000 + i]));
const opts = key => table.options[key][LANG];

function varint(n) {
    const out = [];
    while (n > 0x7f) {
        out.push((n & 0x7f) | 0x80);
        n >>>= 7;
    }
    out.push(n);
    return out;
}

// [bridge key, platform, extra list fields, initial state]
const ENTITIES = [
    ['connected', 'BinarySensor', {}, true],
    ['seated', 'BinarySensor', {}, false],
    ['toilet_problem', 'BinarySensor', {}, false],
    ['shower_toggle', 'Button', {}, undefined],
    ['spray_intensity', 'Number', { minValue: 1, maxValue: 5, step: 1 }, 3],
    ['profile_1_spray_intensity', 'Number', { minValue: 1, maxValue: 5, step: 1 }, 2],
    ['light_color', 'Select', { optionsList: opts('light_color') }, opts('light_color')[2]],
    // a model with a light sensor: the bridge sends the texts of the other option list
    ['light_activation', 'Select', { optionsList: opts('light_activation') }, opts('light_activation_approach')[3]],
    ['profile_1_welcome_light', 'Select', { optionsList: opts('welcome_light') }, opts('welcome_light')[1]],
    ['profile_2_user_name', 'Text', {}, 'Anna'],
    ['profile_1_user_irk_set', 'Text', {}, ''],
    ['light_window_1_start', 'Time', {}, [22, 0]],
    ['profile_4_lady_oscillating_spray', 'Switch', {}, false],
    ['days_until_descaling', 'Sensor', { unitOfMeasurement: 'd' }, 42],
    ['last_descaling', 'Sensor', {}, 1767225600],
    ['model', 'TextSensor', {}, 'AquaClean Sela'],
    ['connection_uptime', 'TextSensor', {}, '2026-11-24T10:00:00+01:00'],
    ['bridge_health', 'TextSensor', {}, opts('bridge_health')[0]],
    ['remote_button', 'Event', { eventTypesList: ['shower', 'shower_long'] }, undefined],
    ['orientation_light', 'Light', {}, true],
    [null, 'Button', { name: 'Restart' }, undefined], // a YAML entity the adapter doesn't know
];

class FakeBridge {
    constructor() {
        this.commands = [];
        this.sockets = new Set();
        this.refuse = new Set(); // keys whose commands are "refused" (no state echo)
        this.server = net.createServer(sock => this._onConnection(sock));
        this.entities = ENTITIES.map(([bridgeKey, platform, extra, state], i) => {
            const rec = bridgeKey ? REC.get(bridgeKey) : null;
            const device = rec && rec.device !== 'bridge' ? rec.device : null;
            return {
                bridgeKey,
                platform,
                key: 100 + i,
                deviceId: device ? DEVICE_ID[device] : 0,
                name: extra.name || rec.name[LANG],
                extra,
                state,
            };
        });
    }

    listen(port = 0) {
        return new Promise(resolve => this.server.listen(port, '127.0.0.1', () => resolve(this.server.address().port)));
    }

    close() {
        for (const s of this.sockets) {
            s.destroy();
        }
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    byKey(bridgeKey) {
        return this.entities.find(e => e.bridgeKey === bridgeKey);
    }

    _send(sock, msg) {
        const body = Buffer.from(msg.serializeBinary());
        sock.write(Buffer.from([0, ...varint(body.length), ...varint(Number(msg.constructor.id)), ...body]));
    }

    _onConnection(sock) {
        this.sockets.add(sock);
        sock.on('close', () => this.sockets.delete(sock));
        sock.on('error', () => {});
        let buf = Buffer.alloc(0);
        sock.on('data', data => {
            buf = Buffer.concat([buf, data]);
            for (;;) {
                let off = 1;
                const read = () => {
                    let n = 0;
                    let shift = 0;
                    for (;;) {
                        if (off >= buf.length) {
                            return null;
                        }
                        const b = buf[off++];
                        n |= (b & 0x7f) << shift;
                        if (!(b & 0x80)) {
                            return n;
                        }
                        shift += 7;
                    }
                };
                if (buf.length < 3) {
                    return;
                }
                const len = read();
                const id = read();
                if (len === null || id === null || off + len > buf.length) {
                    return;
                }
                const type = require('@2colors/esphome-native-api/lib/utils/messages').id_to_type[id];
                const msg = pb[type].deserializeBinary(buf.subarray(off, off + len));
                buf = buf.subarray(off + len);
                this._onMessage(sock, type, msg);
            }
        });
    }

    _stateMessage(e) {
        if (e.state === undefined || e.platform === 'Button' || e.platform === 'Event') {
            return null;
        }
        const Cls = pb[`${e.platform}StateResponse`];
        const m = new Cls();
        m.setKey(e.key);
        if (e.deviceId && m.setDeviceId) {
            m.setDeviceId(e.deviceId);
        }
        if (e.platform === 'Time') {
            m.setHour(e.state[0]);
            m.setMinute(e.state[1]);
            m.setSecond(0);
        } else {
            m.setState(e.state);
        }
        return m;
    }

    sendState(e) {
        const m = this._stateMessage(e);
        if (m) {
            for (const s of this.sockets) {
                this._send(s, m);
            }
        }
    }

    fireEvent(bridgeKey, type) {
        const e = this.byKey(bridgeKey);
        const m = new pb.EventResponse();
        m.setKey(e.key);
        m.setDeviceId(e.deviceId);
        m.setEventType(type);
        for (const s of this.sockets) {
            this._send(s, m);
        }
    }

    _onMessage(sock, type, msg) {
        switch (type) {
            case 'HelloRequest': {
                const r = new pb.HelloResponse();
                r.setApiVersionMajor(1);
                r.setApiVersionMinor(13);
                r.setServerInfo('fake aquaclean');
                r.setName('aquaclean-test');
                this._send(sock, r);
                return;
            }
            case 'DeviceInfoRequest': {
                const r = new pb.DeviceInfoResponse();
                r.setName('aquaclean-test');
                r.setFriendlyName('AquaClean Test');
                r.setEsphomeVersion('2026.11.0');
                r.setProjectName('geberit.aquaclean');
                r.setProjectVersion('1.36.0');
                r.setDevicesList(
                    DEVICES.map(d => {
                        const di = new pb.DeviceInfo();
                        di.setDeviceId(DEVICE_ID[d]);
                        di.setName(table.devices[d][LANG]);
                        return di;
                    }),
                );
                this._send(sock, r);
                return;
            }
            case 'ListEntitiesRequest':
                for (const e of this.entities) {
                    const m = new pb[`ListEntities${e.platform}Response`]();
                    m.setKey(e.key);
                    m.setName(e.name);
                    if (e.deviceId) {
                        m.setDeviceId(e.deviceId);
                    }
                    for (const [k, v] of Object.entries(e.extra)) {
                        const setter = `set${k[0].toUpperCase()}${k.slice(1)}`;
                        if (k !== 'name' && m[setter]) {
                            m[setter](v);
                        }
                    }
                    this._send(sock, m);
                }
                this._send(sock, new pb.ListEntitiesDoneResponse());
                return;
            case 'SubscribeStatesRequest':
                for (const e of this.entities) {
                    const m = this._stateMessage(e);
                    if (m) {
                        this._send(sock, m);
                    }
                }
                return;
            case 'PingRequest':
                this._send(sock, new pb.PingResponse());
                return;
            case 'DisconnectRequest':
                this._send(sock, new pb.DisconnectResponse());
                sock.end();
                return;
            default:
                break;
        }
        if (!type.endsWith('CommandRequest')) {
            return;
        }
        const e = this.entities.find(x => x.key === msg.getKey());
        const cmd = { type, bridgeKey: e && e.bridgeKey, name: e && e.name, deviceId: msg.getDeviceId ? msg.getDeviceId() : 0 };
        if (type === 'TimeCommandRequest') {
            cmd.value = [msg.getHour(), msg.getMinute()];
        } else if (msg.getState) {
            cmd.value = msg.getState();
        }
        this.commands.push(cmd);
        if (!e || type === 'ButtonCommandRequest' || this.refuse.has(e.bridgeKey)) {
            return;
        }
        e.state = cmd.value;
        if (e.extra && e.extra.name === undefined && e.bridgeKey && e.bridgeKey.endsWith('irk_set')) {
            e.state = '';
        }
        this.sendState(e);
    }
}

module.exports = FakeBridge;
