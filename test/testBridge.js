'use strict';

const assert = require('assert');
const Bridge = require('../lib/bridge');
const FakeBridge = require('./lib/fake-bridge');
const table = require('../lib/entities.json');

const wait = ms => new Promise(r => setTimeout(r, ms));

describe('native API link (against a fake bridge)', function () {
    this.timeout(15000);
    let fake;
    let bridge;
    const states = new Map();

    before(async () => {
        fake = new FakeBridge();
        const port = await fake.listen();
        bridge = new Bridge({ host: '127.0.0.1', port, key: '', match: table.match });
        bridge.on('state', (ent, v) => states.set(ent.bridgeKey || ent.name, v));
        const ready = new Promise(r => bridge.once('ready', r));
        bridge.connect();
        await ready;
        bridge.subscribe();
        await wait(300);
    });

    after(async () => {
        bridge.disconnect();
        await fake.close();
    });

    it('recognises every entity by sub-device and Dutch name', () => {
        const keys = fake.entities.filter(e => e.bridgeKey).map(e => e.bridgeKey);
        for (const k of keys) {
            assert.ok(bridge.byBridgeKey.has(k), `${k} not recognised`);
        }
        // same name on two sub-devices
        assert.notStrictEqual(
            bridge.byBridgeKey.get('spray_intensity').deviceId,
            bridge.byBridgeKey.get('profile_1_spray_intensity').deviceId,
        );
        const other = [...bridge.entities.values()].filter(e => !e.bridgeKey).map(e => e.name);
        assert.deepStrictEqual(other, ['Restart']);
    });

    it('receives states of every kind', () => {
        assert.strictEqual(states.get('seated'), false);
        assert.strictEqual(states.get('spray_intensity'), 3);
        assert.strictEqual(states.get('light_window_1_start'), '22:00');
        assert.strictEqual(states.get('profile_2_user_name'), 'Anna');
        assert.strictEqual(states.get('orientation_light'), true);
    });

    it('sends commands to the right sub-device', async () => {
        bridge.setNumber(bridge.byBridgeKey.get('profile_1_spray_intensity'), 5);
        bridge.press(bridge.byBridgeKey.get('shower_toggle'));
        bridge.setTime(bridge.byBridgeKey.get('light_window_1_start'), '06:30');
        bridge.setSwitch(bridge.byBridgeKey.get('orientation_light'), false);
        await wait(300);
        const c = fake.commands;
        assert.deepStrictEqual(
            c.map(x => [x.type, x.bridgeKey]),
            [
                ['NumberCommandRequest', 'profile_1_spray_intensity'],
                ['ButtonCommandRequest', 'shower_toggle'],
                ['TimeCommandRequest', 'light_window_1_start'],
                ['LightCommandRequest', 'orientation_light'],
            ],
        );
        assert.strictEqual(c[0].deviceId, fake.byKey('profile_1_spray_intensity').deviceId);
        assert.strictEqual(states.get('profile_1_spray_intensity'), 5);
        assert.strictEqual(states.get('light_window_1_start'), '06:30');
    });

    it('refuses numbers outside the range the bridge reports', () => {
        assert.throws(() => bridge.setNumber(bridge.byBridgeKey.get('spray_intensity'), 9), /1–5/);
    });

    it('passes remote control events', async () => {
        const got = new Promise(r => bridge.once('event', (ent, t) => r([ent.bridgeKey, t])));
        fake.fireEvent('remote_button', 'shower_long');
        assert.deepStrictEqual(await got, ['remote_button', 'shower_long']);
    });
});
