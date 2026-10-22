// Bluetooth LE output using Web Bluetooth. The device chooser is drawn by the app (main process
// forwards the live list of nearby devices), so nothing has to be typed.
// Transports (same as the Nomad DMX web app): generic BLE-UART style adapters and City Theatrical DMXcat.
window.BLE = (() => {
  'use strict';

  const DMXCAT_SVC = 'c171c100-8000-0010-8000-00805f9bc171';
  const DMXCAT_CTL_SVC = 'c171b007-8000-0010-8000-00805f9bc171';
  const KNOWN_SERVICES = [
    '4e4d4458-0001-4b2e-9c3a-626f756c6472', // Boulders DMX-RX (ESP32 box)
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
    '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 / CC2541
    '0000ffe5-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip / ISSC
    '0000fefb-0000-1000-8000-00805f9b34fb', // Telit
    '569a1101-b87f-490c-92cb-11ba5ea5167c', // Laird
    '2456e1b9-26e2-8f83-e744-f34f01e9d701', // u-blox
    '00035b03-58e6-07dd-021a-08123a000300', // Microchip MLDP
  ];
  const ASTERA_SVC = '0a6c6c72-9ca6-ffaf-3440-b2dae8c86a65'; // Astera tubes (see astera.js)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dcu = (s) => `c171${s}-8000-0010-8000-00805f9bc171`;

  const B = {
    supported: typeof navigator !== 'undefined' && !!navigator.bluetooth,
    device: null, server: null, chr: null, ch: {},
    mode: 'none', connected: false, ready: false, busy: false,
    scanning: false, devices: [],
    status: 'Not connected', name: '',
    onChange: () => {},
    last: new Int16Array(512).fill(-1), lastSent: null, lastSentAt: 0,
    cfg: {}, ast: null,

    async scan() {
      if (!this.supported) { this.status = 'Bluetooth is not available on this computer'; this.onChange(); return; }
      if (this.scanning) return;
      this.scanning = true; this.devices = []; this.status = 'Searching…'; this.onChange();
      try {
        const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [DMXCAT_SVC, DMXCAT_CTL_SVC, ASTERA_SVC, ...KNOWN_SERVICES] });
        this.scanning = false; this.onChange();
        await this.open(dev);
      } catch (e) {
        this.scanning = false;
        this.connected = false; this.ready = false;
        this.status = e && e.name === 'NotFoundError' ? 'Not connected' : `Bluetooth: ${(e && e.message) || e}`;
      }
      this.onChange();
    },
    choose(id) { window.desk.bleSelect(id); },
    cancel() { window.desk.bleSelect(''); },
    setDevices(list) { this.devices = list; this.onChange(); },

    async open(device) {
      this.device = device; this.name = device.name || 'Bluetooth device';
      if (!device._nomadListener) { device._nomadListener = true; device.addEventListener('gattserverdisconnected', () => this.onDisconnected()); }
      this.status = 'Connecting…'; this.onChange();
      this.server = await device.gatt.connect();
      await this.discover();
    },
    onDisconnected() { this.stopAstera(); this.connected = false; this.ready = false; this.status = 'Disconnected'; this.onChange(); },
    disconnect() {
      this.stopAstera();
      try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
      this.connected = false; this.ready = false; this.mode = 'none'; this.status = 'Not connected'; this.onChange();
    },

    async discover() {
      let svcs = [];
      try { svcs = await this.server.getPrimaryServices(); } catch (e) { /* none present */ }
      const ast = window.ASTERA && (svcs.find((s) => s.uuid === ASTERA_SVC) || await this.findService(ASTERA_SVC));
      if (ast) { await this.startAstera(ast); return; }
      const cat = svcs.find((s) => s.uuid === DMXCAT_SVC) || await this.findService(DMXCAT_SVC);
      if (cat) { await this.startDmxcat(cat); return; }
      for (const id of KNOWN_SERVICES) {
        try {
          const svc = await this.findService(id); if (!svc) continue;
          const c = await this.pickWritable(svc); if (!c) continue;
          this.chr = c; this.mode = 'generic'; this.connected = true; this.ready = true; this.status = 'Connected'; return;
        } catch (e) { /* try the next one */ }
      }
      this.connected = true; this.ready = false;
      this.status = `Connected to ${this.name}, but it is not a supported DMX device. Pick a different one.`;
    },
    async pickWritable(svc) {
      const cs = await svc.getCharacteristics();
      return cs.find((c) => c.properties.writeWithoutResponse) || cs.find((c) => c.properties.write) || null;
    },
    async findService(uuid) {
      for (let i = 0; i < 3; i++) {
        try { return await this.server.getPrimaryService(uuid); } catch (e) {
          if (e && e.name === 'NotFoundError') return null;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      return null;
    },

    // City Theatrical DMXcat (protocol taken from the Nomad DMX web app)
    async startDmxcat(svc) {
      this.mode = 'dmxcat'; this.ready = false; this.status = 'Device found – starting…'; this.onChange();
      this.ch = {};
      for (const k of ['c101', 'c102', 'c105', 'c107', 'c10b']) this.ch[k] = await svc.getCharacteristic(dcu(k));
      await this.ack('c105', [0x02]); await this.ack('c10b', [0x01, 0x00]); await this.ack('c105', [0x01]);
      await this.fullFrame(new Uint8Array(512));
      await this.ack('c107', [0xC0, 0, 0x39, 0, 0x30, 0, 0xFC, 0x08, 0, 0, 0xFF, 0xFF, 0x6E, 0, 0, 0]);
      this.ready = true; this.connected = true; this.status = 'Connected';
    },
    async ack(k, bytes) {
      const c = this.ch[k]; const v = Uint8Array.from(bytes);
      if (c.writeValueWithResponse) await c.writeValueWithResponse(v); else await c.writeValue(v);
    },
    async noResp(k, bytes) {
      const c = this.ch[k]; const v = Uint8Array.from(bytes);
      if (c.writeValueWithoutResponse) await c.writeValueWithoutResponse(v); else await c.writeValue(v);
    },
    async fullFrame(data) {
      await this.ack('c101', [0, 0, 2, 0, 2]);
      for (let off = 0; off < 512; off += 20) await this.noResp('c102', data.subarray(off, Math.min(off + 20, 512)));
      await this.ack('c101', [0, 0, 0, 0, 2]);
      for (let i = 0; i < 512; i++) this.last[i] = data[i];
    },
    async sendDmxcat(data) {
      const changed = [];
      for (let i = 0; i < 512; i++) if (data[i] !== this.last[i]) changed.push(i);
      if (!changed.length) return;
      if (changed.length > 6 || changed[changed.length - 1] > 255) { await this.fullFrame(data); return; }
      for (const i of changed) {
        await this.ack('c101', [i, 0, 0, 0, 2]);
        await this.noResp('c102', [data[i]]);
        this.last[i] = data[i];
      }
    },

    async sendGeneric(data, format) {
      const now = Date.now();
      if (this.lastSent && this.lastSent.every((v, i) => v === data[i]) && now - this.lastSentAt < 1000) return;
      this.lastSent = Uint8Array.from(data); this.lastSentAt = now;
      const w = async (b) => {
        if (this.chr.properties.writeWithoutResponse && this.chr.writeValueWithoutResponse) await this.chr.writeValueWithoutResponse(b);
        else if (this.chr.writeValueWithResponse) await this.chr.writeValueWithResponse(b); else await this.chr.writeValue(b);
      };
      if (format === 'PLAIN') {
        const all = new Uint8Array(513); all.set(data, 1);
        for (let off = 0; off < all.length; off += 20) await w(all.subarray(off, Math.min(off + 20, all.length)));
      } else {
        const chunk = 18;
        for (let off = 0; off < 512; off += chunk) {
          const n = Math.min(chunk, 512 - off); const pkt = new Uint8Array(n + 2);
          pkt[0] = off >> 8; pkt[1] = off & 0xFF; pkt.set(data.subarray(off, off + n), 2); await w(pkt);
        }
      }
    },


    // Astera tubes: colour, brightness and built-in effects for every tube on the radio PIN, through
    // the one tube/AsteraBox we are connected to. Read the protocol notes in astera.js.
    async startAstera(svc) {
      const A = window.ASTERA;
      this.mode = 'astera'; this.ready = false; this.connected = true; this.status = 'Astera found – setting up…'; this.onChange();
      const wr = await svc.getCharacteristic(A.UUID.write);
      const nf = await svc.getCharacteristic(A.UUID.notify);
      let inf = null; try { inf = await svc.getCharacteristic(A.UUID.info); } catch (e) { /* optional */ }
      const st = { wr, nf, parser: new A.Parser(), ctl: new A.Controller(), battery: null, fw: '', rxAt: 0, timers: [], chain: Promise.resolve(), dead: false };
      this.ast = st;
      nf.addEventListener('characteristicvaluechanged', (e) => this.asteraRx(st, e.target.value));
      await nf.startNotifications();
      if (inf) { try { await inf.readValue(); } catch (e) { /* not needed */ } }
      // Reading the notify characteristic makes the tube ask for pairing; the OS then shows its pairing pop-up.
      this.status = 'Pairing… accept the request on screen if one appears'; this.onChange();
      for (let i = 0; i < 4; i++) { try { await nf.readValue(); break; } catch (e) { await sleep(2000); if (st.dead) return; } }
      const raw = (bytes) => this.asteraWrite(st, bytes);
      await raw(Uint8Array.of(0x0A)); await sleep(500);
      await raw(A.utf('s0=0\n')); await sleep(300);
      await raw(A.utf(A.connectLine(this.cfg.asteraPin))); await sleep(1000);
      await raw(A.clockFrame(Date.now() / 1000)); await sleep(1000);
      await raw(A.handshake2());
      await raw(A.staticLook()); await sleep(A.LOOK_GAP);
      if (st.dead) return;
      st.ctl.reset(); st.ctl.lastLookAt = Date.now();
      st.timers.push(setInterval(() => { const f = st.ctl.next(Date.now()); if (f) this.asteraWrite(st, f); }, 50));
      st.timers.push(setInterval(() => this.asteraWrite(st, A.poll()), 1000));
      st.timers.push(setTimeout(() => {
        if (!st.rxAt && !st.dead) { this.status = 'Connected, but the tube is not answering. If you pressed "Unbond Bluetooth" on it, Forget it in your Bluetooth settings and connect again.'; this.onChange(); }
      }, 8000));
      this.ready = true; this.status = 'Connected'; this.onChange();
    },
    asteraWrite(st, bytes) {
      st.chain = st.chain.then(async () => {
        if (st.dead) return;
        const c = st.wr; const v = Uint8Array.from(bytes);
        if (c.writeValueWithoutResponse) await c.writeValueWithoutResponse(v); else await c.writeValue(v);
      }).catch((e) => { this.status = `Send error: ${(e && e.message) || e}`; this.onChange(); });
      return st.chain;
    },
    asteraRx(st, dv) {
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      let changed = !st.rxAt;
      st.rxAt = Date.now();
      for (const p of st.parser.push(bytes)) if (p[0] === 0x7F && p.length > 4 && p[4] <= 100 && p[4] !== st.battery) { st.battery = p[4]; changed = true; }
      const m = /<sh1002>([^<]*)<\/sh1002>/.exec(st.parser.text);
      if (m && m[1] !== st.fw) { st.fw = m[1]; changed = true; }
      if (changed) this.onChange();
    },
    stopAstera() {
      const st = this.ast; if (!st) return;
      st.dead = true; st.timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); this.ast = null;
    },
    // Reads the "Astera tube (Bluetooth)" fixture from the desk output: dimmer, R, G, B, effect, speed.
    sendAstera(data) {
      const st = this.ast; if (!st || st.dead) return;
      const a = Math.max(1, Math.min(507, parseInt(this.cfg.asteraAddress, 10) || 1)) - 1;
      const ev = data[a + 4]; const sv = data[a + 5];
      const effect = ev < 10 ? 0 : Math.min(8, 1 + Math.floor((ev - 10) / 30));
      const speed = sv === 0 ? 50 : Math.round((sv - 1) * 100 / 254);
      st.ctl.set(data[a + 1], data[a + 2], data[a + 3], data[a], effect, speed);
    },

    // Called with each new frame; never overlaps itself (BLE writes are async).
    send(data, format) {
      if (!data || !this.connected || !this.ready) return;
      if (this.mode === 'astera') { this.sendAstera(data); return; }
      if (this.busy) return;
      this.busy = true;
      const p = this.mode === 'dmxcat' ? this.sendDmxcat(data) : this.sendGeneric(data, format);
      p.catch((e) => { this.status = `Send error: ${(e && e.message) || e}`; this.onChange(); }).finally(() => { this.busy = false; });
    },
  };

  if (window.desk && window.desk.onBleDevices) window.desk.onBleDevices((list) => B.setDevices(list));
  return B;
})();
