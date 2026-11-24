'use strict';

/*
 * ioBroker adapter for the Geberit AquaClean Bridge for ESP.
 *
 * Connects to the bridge over the ESPHome native API (locally, Noise-encrypted) and turns every entity the bridge
 * offers into an ioBroker state with a fixed, language-independent id, a proper role and names in the ioBroker
 * languages. What exists is decided by the bridge (feature discovery): only what the toilet has gets a state.
 */

const dns = require('node:dns').promises;
const utils = require('@iobroker/adapter-core');
const { Discovery } = require('@2colors/esphome-native-api');
const Bridge = require('./lib/bridge');
const table = require('./lib/entities.json');

const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const BRIDGE_LANG = { 'zh-cn': 'zh' };
const REC = new Map(table.entities.map(r => [r.key, r]));
const PROJECT = 'geberit.aquaclean';
const ACK_TIMEOUT = 8000; // a command the bridge did not carry out: show the real value again after this

const slug = s =>
    String(s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'entity';

class AquaCleanBridge extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'aquaclean-bridge' });
        this.bridge = null;
        this.byId = new Map(); // relative state id -> { rec, ent }
        this.fwLang = 'en'; // language of the bridge firmware (option texts it sends and accepts)
        this.uiLang = 'en'; // ioBroker system language (labels of number states)
        this.variant = new Map(); // bridge key -> option group currently in use (models with other option texts)
        this.pending = new Map(); // relative id -> timer of a command waiting for the bridge's confirmation
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ------------------------------------------------------------------------------------------- lifecycle

    async onReady() {
        await this.setState('info.connection', false, true);
        const sys = await this.getForeignObjectAsync('system.config');
        const lang = (sys && sys.common && sys.common.language) || 'en';
        this.uiLang = LANGS.includes(lang) ? lang : 'en';

        const { host, port, key } = this.config;
        if (!host) {
            this.log.warn('No bridge configured yet: enter its address and encryption key in the instance settings.');
            return;
        }
        if (key && !/^[A-Za-z0-9+/]{43}=$/.test(String(key).trim())) {
            this.log.error("The encryption key must be the 44-character base64 key from the bridge's /setup page.");
            return;
        }
        this.subscribeStates('*');
        const address = await this.resolve(String(host).trim());
        this.log.info(`Connecting to the bridge at ${address}:${port || 6053}`);
        const bridge = new Bridge({
            host: address,
            port: Number(port) || 6053,
            key: key ? String(key).trim() : '',
            match: table.match,
            clientInfo: `ioBroker ${this.namespace}`,
            log: (...a) => this.log.debug(a.join(' ')),
        });
        bridge.on('ready', () => this.onBridgeReady().catch(err => this.log.error(`setup failed: ${err.message}`)));
        bridge.on('unavailable', () => {
            this.log.info('Bridge disconnected; reconnecting…');
            this.setState('info.connection', false, true);
        });
        bridge.on('state', (ent, value) => this.onBridgeState(ent, value));
        bridge.on('event', (ent, type) => this.onBridgeEvent(ent, type));
        bridge.on('error', err => {
            const msg = err && err.message ? err.message : String(err);
            if (/handshake|decrypt|encryption|noise|key/i.test(msg)) {
                this.log.error(`Encryption failed: check the key (${msg})`);
            } else {
                this.log.debug(`bridge: ${msg}`);
            }
        });
        this.bridge = bridge;
        try {
            bridge.connect();
        } catch (err) {
            this.log.error(`Cannot connect: ${err.message}`);
        }
    }

    onUnload(callback) {
        try {
            for (const t of this.pending.values()) {
                this.clearTimeout(t);
            }
            this.pending.clear();
            if (this.bridge) {
                this.bridge.disconnect();
            }
            this.bridge = null;
        } finally {
            callback();
        }
    }

    /** A .local name that the system resolver doesn't know is looked up with mDNS. */
    async resolve(host) {
        if (!/\.local\.?$/i.test(host)) {
            return host;
        }
        try {
            return (await dns.lookup(host, { family: 4 })).address;
        } catch {
            const found = await Discovery({ timeout: 4 });
            const want = host.replace(/\.$/, '').toLowerCase();
            const hit = found.find(d => d.address && String(d.host || '').toLowerCase() === want);
            if (hit) {
                return hit.address;
            }
            this.log.warn(`${host} not found with mDNS; trying it as given.`);
            return host;
        }
    }

    // ------------------------------------------------------------------------------------------- objects

    async onBridgeReady() {
        const bridge = this.bridge;
        const info = bridge.deviceInfo || {};
        this.fwLang = this.detectFirmwareLanguage();
        const present = new Set();
        this.byId.clear();

        const devices = new Set();
        const channels = new Set();
        for (const ent of bridge.entities.values()) {
            let rec = ent.bridgeKey ? REC.get(ent.bridgeKey) : null;
            if (rec && rec.advanced && !this.config.advanced) {
                continue;
            }
            if (!rec) {
                rec = this.otherRecord(ent);
            }
            ent.iob = rec;
            this.byId.set(rec.id, { rec, ent });
            present.add(rec.id);
            devices.add(rec.device);
            if (rec.channel) {
                channels.add(`${rec.device}.${rec.channel}`);
            }
        }

        for (const dev of devices) {
            await this.extendObjectAsync(dev, {
                type: 'device',
                common: { name: this.multi(table.devices[dev]) },
                native: {},
            });
        }
        for (const ch of channels) {
            const [, name] = ch.split('.');
            await this.extendObjectAsync(ch, {
                type: 'channel',
                common: { name: this.multi(table.channels[name]) },
                native: {},
            });
        }
        for (const { rec, ent } of this.byId.values()) {
            await this.extendObjectAsync(rec.id, { type: 'state', common: this.commonOf(rec, ent), native: {} });
        }
        if (this.config.cleanup !== false) {
            await this.cleanup(present);
        }

        await this.setState('info.connection', true, true);
        await this.setState('info.firmware', `${info.projectName || ''} ${info.projectVersion || ''}`.trim(), true);
        await this.setState('info.esphome', info.esphomeVersion || '', true);
        const recognised = [...bridge.entities.values()].filter(e => e.bridgeKey).length;
        this.log.info(
            `Connected to ${info.friendlyName || info.name || 'the bridge'} (${info.projectVersion || '?'}, ` +
                `firmware language ${this.fwLang}): ${this.byId.size} states, ${recognised} recognised entities`,
        );
        if (info.projectName && info.projectName !== PROJECT) {
            this.log.warn(
                `This device runs ${info.projectName}, not the AquaClean Bridge: most states will be missing.`,
            );
        }
        bridge.subscribe();
    }

    /** Remove states of functions this toilet no longer offers (physical maintenance is kept: it comes and goes). */
    async cleanup(present) {
        const known = new Set(table.entities.map(r => r.id));
        const objs = await this.getAdapterObjectsAsync();
        const prefix = `${this.namespace}.`;
        for (const full of Object.keys(objs)) {
            const obj = objs[full];
            if (!obj || obj.type !== 'state') {
                continue;
            }
            const id = full.slice(prefix.length);
            if (id.startsWith('info.') || id.startsWith('maintenance.') || present.has(id)) {
                continue;
            }
            if (known.has(id) || id.startsWith('bridge.other.')) {
                this.log.debug(`removing ${id}: not offered by the bridge`);
                await this.delObjectAsync(id);
            }
        }
    }

    multi(names) {
        if (!names) {
            return '';
        }
        if (typeof names === 'string') {
            return names;
        }
        const out = {};
        for (const l of LANGS) {
            out[l] = names[l] || names.en;
        }
        return out;
    }

    /** State definition for an entity the adapter doesn't know (e.g. the restart button or the time zone). */
    otherRecord(ent) {
        const generic = {
            binary_sensor: ['indicator', 'boolean', true, false],
            sensor: ['value', 'number', true, false],
            text_sensor: ['text', 'string', true, false],
            switch: ['switch', 'boolean', true, true],
            light: ['switch.light', 'boolean', true, true],
            button: ['button', 'boolean', false, true],
            number: ['level', 'number', true, true],
            select: ['text', 'string', true, true],
            text: ['text', 'string', true, true],
            time: ['text', 'string', true, true],
            event: ['text', 'string', true, false],
        }[ent.platform];
        const base = slug(ent.cfg.objectId || ent.name);
        let id = `bridge.other.${base}`;
        for (let i = 2; this.byId.has(id); i++) {
            id = `bridge.other.${base}_${i}`;
        }
        return {
            key: null,
            id,
            device: 'bridge',
            channel: 'other',
            platform: ent.platform,
            role: generic[0],
            type: generic[1],
            read: generic[2],
            write: generic[3],
            name: ent.deviceName ? `${ent.deviceName} ${ent.name}` : ent.name,
            other: true,
        };
    }

    commonOf(rec, ent) {
        const c = {
            name: this.multi(rec.name),
            type: rec.type,
            role: rec.role,
            read: rec.read,
            write: rec.write,
        };
        const cfg = ent.cfg || {};
        const unit = rec.unit || cfg.unitOfMeasurement;
        if (unit) {
            c.unit = unit;
        }
        if (rec.platform === 'number') {
            c.min = Number.isFinite(cfg.minValue) ? cfg.minValue : rec.min;
            c.max = Number.isFinite(cfg.maxValue) ? cfg.maxValue : rec.max;
            c.step = cfg.step || 1;
        }
        if (rec.platform === 'button') {
            c.def = false;
        }
        if (rec.options) {
            c.states = this.statesOf(rec, ent);
            c.min = 0;
            c.max = Math.max(0, Object.keys(c.states).length - 1);
        } else if (rec.other && rec.platform === 'select') {
            c.states = Object.fromEntries((cfg.optionsList || []).map(o => [o, o]));
        }
        if (rec.platform === 'event') {
            c.states = table.events[this.uiLang] || table.events.en;
        }
        return c;
    }

    // ------------------------------------------------------------------------------------------- option texts

    detectFirmwareLanguage() {
        for (const ent of this.bridge.entities.values()) {
            const rec = ent.bridgeKey && REC.get(ent.bridgeKey);
            if (!rec || rec.platform !== 'select' || !rec.options) {
                continue;
            }
            const opts = ent.cfg.optionsList || [];
            for (const code of table.bridgeLanguages) {
                const list = table.options[rec.options[0]][code];
                if (list && list.length === opts.length && list.every((o, i) => o === opts[i])) {
                    return code;
                }
            }
        }
        return 'en';
    }

    uiList(group) {
        const lists = table.options[group];
        return lists[BRIDGE_LANG[this.uiLang] || this.uiLang] || lists.en;
    }

    /** Number -> label, in the ioBroker language. */
    statesOf(rec) {
        const group = this.variant.get(rec.key) || rec.options[0];
        const out = {};
        this.uiList(group).forEach((label, i) => {
            if (label !== '') {
                out[i] = label;
            }
        });
        return out;
    }

    /** Option text from the bridge -> index, also noting which option group (model variant) it came from. */
    indexOf(rec, text) {
        const order = [this.fwLang, ...table.bridgeLanguages.filter(c => c !== this.fwLang)];
        for (const group of rec.options) {
            for (const code of order) {
                const list = table.options[group][code];
                const i = list ? list.indexOf(text) : -1;
                if (i >= 0) {
                    return { i, group };
                }
            }
        }
        return null;
    }

    /** Index or text written in ioBroker -> the option text the bridge accepts. */
    optionText(rec, ent, val) {
        const group = this.variant.get(rec.key) || rec.options[0];
        const fw = table.options[group][this.fwLang] || [];
        const offered = ent.cfg.optionsList || fw;
        if (typeof val === 'number' || /^\d+$/.test(String(val))) {
            const i = Number(val);
            const text = group === rec.options[0] ? offered[i] : fw[i];
            if (text === undefined || text === '') {
                throw new Error(`no option ${i}`);
            }
            return text;
        }
        if (offered.includes(val)) {
            return val;
        }
        const hit = this.indexOf(rec, String(val));
        if (!hit) {
            throw new Error(`unknown option "${val}"`);
        }
        return this.optionText(rec, ent, hit.i);
    }

    // ------------------------------------------------------------------------------------------- bridge -> ioBroker

    toIoBroker(rec, ent, value) {
        if (value === null || value === undefined) {
            return null;
        }
        if (rec.secret) {
            return '';
        }
        if (rec.date === 's') {
            return Number(value) > 0 ? Math.round(Number(value) * 1000) : null;
        }
        if (rec.date === 'iso') {
            const t = Date.parse(value);
            return Number.isFinite(t) ? t : null;
        }
        if (rec.options) {
            const hit = this.indexOf(rec, String(value));
            if (!hit) {
                this.log.debug(`${rec.id}: unknown option "${value}"`);
                return null;
            }
            if ((this.variant.get(rec.key) || rec.options[0]) !== hit.group) {
                this.variant.set(rec.key, hit.group);
                this.extendObject(rec.id, { common: { states: this.statesOf(rec, ent) } });
            }
            return hit.i;
        }
        if (rec.type === 'number') {
            const n = Number(value);
            return Number.isFinite(n) ? n : null;
        }
        if (rec.type === 'boolean') {
            return !!value;
        }
        return String(value);
    }

    onBridgeState(ent, value) {
        const rec = ent.iob;
        if (!rec || !this.byId.has(rec.id) || rec.platform === 'button') {
            return;
        }
        const val = this.toIoBroker(rec, ent, value);
        const timer = this.pending.get(rec.id);
        if (timer) {
            this.clearTimeout(timer);
            this.pending.delete(rec.id);
        }
        this.setState(rec.id, { val, ack: true });
        const m = rec.key && /^profile_(\d)_user_name$/.exec(rec.key);
        if (m) {
            this.nameProfile(`profile_${m[1]}`, val);
        }
    }

    onBridgeEvent(ent, type) {
        const rec = ent.iob;
        if (!rec || !this.byId.has(rec.id)) {
            return;
        }
        this.setState(rec.id, { val: String(type), ack: true });
    }

    /** "User profile 2 (Anna)": the profile device shows its user. */
    nameProfile(dev, user) {
        const base = table.devices[dev];
        const name = {};
        for (const l of LANGS) {
            name[l] = user ? `${base[l] || base.en} (${user})` : base[l] || base.en;
        }
        this.extendObject(dev, { common: { name } });
    }

    // ------------------------------------------------------------------------------------------- ioBroker -> bridge

    async onStateChange(id, state) {
        if (!state || state.ack || !this.bridge) {
            return;
        }
        const rel = id.slice(this.namespace.length + 1);
        const hit = this.byId.get(rel);
        if (!hit) {
            return;
        }
        const { rec, ent } = hit;
        if (!rec.write) {
            return;
        }
        const val = state.val;
        try {
            switch (rec.platform) {
                case 'button':
                    if (val === false || val === 0 || val === null) {
                        return;
                    }
                    this.bridge.press(ent);
                    await this.setState(rel, false, true);
                    return;
                case 'switch':
                case 'light':
                    this.bridge.setSwitch(ent, val === true || val === 1 || val === 'true' || val === 'on');
                    break;
                case 'number':
                    this.bridge.setNumber(ent, val);
                    break;
                case 'select':
                    this.bridge.setSelect(ent, rec.options ? this.optionText(rec, ent, val) : val);
                    break;
                case 'text':
                    this.bridge.setText(ent, val === null ? '' : val);
                    if (rec.secret) {
                        await this.setState(rel, '', true);
                        return;
                    }
                    break;
                case 'time':
                    this.bridge.setTime(ent, val);
                    break;
                default:
                    return;
            }
            this.awaitConfirmation(rel, rec, ent);
        } catch (err) {
            this.log.warn(`${rel}: ${err.message}`);
            this.restore(rel, rec, ent);
        }
    }

    /**
     * The bridge confirms a carried-out command with a new state. Without one (e.g. refused: nobody seated) the
     * real value is shown again.
     */
    awaitConfirmation(rel, rec, ent) {
        const old = this.pending.get(rel);
        if (old) {
            this.clearTimeout(old);
        }
        this.pending.set(
            rel,
            this.setTimeout(() => {
                this.pending.delete(rel);
                this.log.info(`${rel}: the bridge did not carry out the command (see the bridge log for why)`);
                this.restore(rel, rec, ent);
            }, ACK_TIMEOUT),
        );
    }

    restore(rel, rec, ent) {
        if (ent.state !== undefined) {
            this.setState(rel, { val: this.toIoBroker(rec, ent, ent.state), ack: true });
        }
    }

    // ------------------------------------------------------------------------------------------- admin

    async onMessage(obj) {
        if (!obj || !obj.command) {
            return;
        }
        if (obj.command === 'discover') {
            let list = [];
            try {
                const found = await Discovery({ timeout: 4 });
                list = found
                    .filter(d => d.address && String(d.project_name || '').startsWith(PROJECT))
                    .map(d => ({
                        label: `${d.friendly_name || String(d.host || '').replace(/\.local$/, '')} (${d.address})`,
                        value: d.address,
                    }));
            } catch (err) {
                this.log.warn(`Search failed: ${err.message}`);
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, list, obj.callback);
            }
        }
    }
}

if (require.main !== module) {
    module.exports = options => new AquaCleanBridge(options);
} else {
    new AquaCleanBridge();
}
