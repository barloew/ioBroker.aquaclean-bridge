'use strict';

const path = require('path');
const assert = require('assert');
const { tests } = require('@iobroker/testing');
const FakeBridge = require('./lib/fake-bridge');
const table = require('../lib/entities.json');

const wait = ms => new Promise(r => setTimeout(r, ms));

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('against a fake bridge', getHarness => {
            let harness;
            let fake;
            const NS = 'aquaclean-bridge.0';
            const get = async id => harness.states.getStateAsync(`${NS}.${id}`);
            const set = async (id, val) => harness.states.setStateAsync(`${NS}.${id}`, { val, ack: false });

            before(async function () {
                this.timeout(60000);
                fake = new FakeBridge();
                const port = await fake.listen();
                harness = getHarness();
                await harness.changeAdapterConfig('aquaclean-bridge', {
                    native: { host: '127.0.0.1', port, key: '', advanced: false, cleanup: true },
                });
                await harness.startAdapterAndWait();
                for (let i = 0; i < 40; i++) {
                    const s = await get('info.connection');
                    if (s && s.val) {
                        break;
                    }
                    await wait(250);
                }
                await wait(1500);
            });

            after(async () => {
                await fake.close();
            });

            it('connects and reports the bridge', async () => {
                assert.strictEqual((await get('info.connection')).val, true);
                assert.strictEqual((await get('info.firmware')).val, 'geberit.aquaclean 1.36.0');
            });

            it('creates states with fixed ids, roles and names in every ioBroker language', async () => {
                const obj = await harness.objects.getObjectAsync(`${NS}.profile_1.settings.spray_intensity`);
                assert.ok(obj, 'state missing');
                assert.strictEqual(obj.common.role, 'level');
                assert.strictEqual(obj.common.min, 1);
                assert.strictEqual(obj.common.max, 5);
                assert.strictEqual(obj.common.name.de, table.entities.find(r => r.key === 'profile_1_spray_intensity').name.de);
                const dev = await harness.objects.getObjectAsync(`${NS}.profile_1`);
                assert.strictEqual(dev.type, 'device');
                const btn = await harness.objects.getObjectAsync(`${NS}.session.shower_toggle`);
                assert.strictEqual(btn.common.role, 'button');
                assert.strictEqual(btn.common.read, false);
                const other = await harness.objects.getObjectAsync(`${NS}.bridge.other.restart`);
                assert.ok(other, 'unknown entities go to bridge.other');
            });

            it('converts states from the bridge', async () => {
                assert.strictEqual((await get('session.spray_intensity')).val, 3);
                assert.strictEqual((await get('toilet.days_until_descaling')).val, 42);
                assert.strictEqual((await get('toilet.last_descaling')).val, 1767225600 * 1000);
                assert.strictEqual((await get('toilet.info.connection_uptime')).val, Date.parse('2026-11-24T10:00:00+01:00'));
                assert.strictEqual((await get('toilet.settings.light_color')).val, 2);
                assert.strictEqual((await get('toilet.settings.light_window_1_start')).val, '22:00');
                assert.strictEqual((await get('bridge.bridge_health')).val, 0);
                assert.strictEqual((await get('toilet.info.model')).val, 'AquaClean Sela');
                assert.strictEqual((await get('toilet.orientation_light')).val, true);
            });

            it('follows a model with other option texts (light sensor)', async () => {
                assert.strictEqual((await get('toilet.settings.light_activation')).val, 3);
                const obj = await harness.objects.getObjectAsync(`${NS}.toilet.settings.light_activation`);
                assert.strictEqual(obj.common.states[3], table.options.light_activation_approach.en[3]);
            });

            it('names the profile device after its user', async () => {
                const dev = await harness.objects.getObjectAsync(`${NS}.profile_2`);
                assert.ok(String(dev.common.name.en).endsWith('(Anna)'), JSON.stringify(dev.common.name));
            });

            it('sends commands and acknowledges with the bridge state', async () => {
                fake.commands.length = 0;
                await set('profile_1.settings.spray_intensity', 4);
                await set('toilet.settings.light_color', 5);
                await set('toilet.settings.light_window_1_start', '07:15');
                await set('profile_4.settings.lady_oscillating_spray', true);
                await set('session.shower_toggle', true);
                await wait(1500);
                const cmds = fake.commands.map(c => [c.bridgeKey, c.value]);
                assert.deepStrictEqual(cmds, [
                    ['profile_1_spray_intensity', 4],
                    ['light_color', table.options.light_color.nl[5]],
                    ['light_window_1_start', [7, 15]],
                    ['profile_4_lady_oscillating_spray', true],
                    ['shower_toggle', undefined],
                ]);
                const s = await get('profile_1.settings.spray_intensity');
                assert.strictEqual(s.val, 4);
                assert.strictEqual(s.ack, true);
                assert.strictEqual((await get('toilet.settings.light_color')).val, 5);
                const b = await get('session.shower_toggle');
                assert.strictEqual(b.val, false);
                assert.strictEqual(b.ack, true);
            });

            it('accepts an option label in another language', async () => {
                fake.commands.length = 0;
                await set('toilet.settings.light_color', table.options.light_color.de[1]);
                await wait(800);
                assert.deepStrictEqual(fake.commands.map(c => c.value), [table.options.light_color.nl[1]]);
                assert.strictEqual((await get('toilet.settings.light_color')).val, 1);
            });

            it('writes the variant text back for a model with other option texts', async () => {
                fake.commands.length = 0;
                await set('toilet.settings.light_activation', 2);
                await wait(800);
                assert.deepStrictEqual(fake.commands.map(c => c.value), [table.options.light_activation_approach.nl[2]]);
            });

            it('never keeps a written IRK', async () => {
                await set('profile_1.settings.user_irk_set', '00112233445566778899aabbccddeeff');
                await wait(800);
                assert.strictEqual((await get('profile_1.settings.user_irk_set')).val, '');
            });

            it('passes remote control button presses', async () => {
                fake.fireEvent('remote_button', 'shower_long');
                await wait(500);
                const s = await get('session.remote_button');
                assert.strictEqual(s.val, 'shower_long');
                assert.strictEqual(s.ack, true);
            });

            it('shows the real value again when the bridge refuses a command', async function () {
                this.timeout(15000);
                fake.refuse.add('spray_intensity');
                await set('session.spray_intensity', 5);
                await wait(9500);
                const s = await get('session.spray_intensity');
                assert.strictEqual(s.val, 3);
                assert.strictEqual(s.ack, true);
            });
        });
    },
});
