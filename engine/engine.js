'use strict';
const dgram = require('dgram');
const { artnetPacket, sacnPacket, sacnMulticastAddr } = require('./protocols');
const { parseCommand } = require('./command');
const { TYPES, EMITTERS, NON_INTENSITY, BUILTIN_PROFILES } = require('./profiles');

const MAX_UNIVERSES = 16;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const keyOf = (universe, ch) => (universe - 1) * 512 + (ch - 1); // ch 1-512

function defaultSettings() {
  return {
    protocol: 'artnet',       // artnet | sacn | both
    artnetDest: '255.255.255.255',
    artnetFirst: 0,           // Art-Net universe number that desk universe 1 sends to (0 = standard)
    sacnUnicast: '',          // empty = multicast
    sacnPriority: 100,
    bindIp: '',               // optional: network interface address to send from
    universes: 1,
    fps: 30,
    bleFormat: 'OFFSET',      // Bluetooth packet format: OFFSET (2-byte offset + 18 data) or PLAIN
    bleUniverse: 1,           // which desk universe goes out over Bluetooth
    artnetPort: 6454,
    sacnPort: 5568,
  };
}

class Engine {
  constructor() {
    this.onChange = () => {};
    this.sock = null;
    this.timer = null;
    this.t0 = Date.now();
    this.stats = { packets: 0, lastError: '' };
    this.seq = new Uint8Array(MAX_UNIVERSES + 1);
    this.lastFrame = [new Uint8Array(512)];
    this.newShow();
  }

  // ---------------------------------------------------------------- show state
  newShow() {
    this.showName = 'Untitled show';
    this.settings = defaultSettings();
    this.profiles = [];     // user profiles (built-ins are added on read)
    this.patch = [];
    this.cues = [];
    this.effects = [];
    this.gm = 1;
    this.blackout = false;
    this.programmer = new Map();
    this.playback = { levels: new Map(), current: -1, fade: null };
    this.selection = { mode: 'fix', ids: [], universe: 1, channels: [] };
    this.currentUniverse = 1;
    this.nextId = 1;
    this.rebuildMask();
    this.resetSocket();
  }

  serialize() {
    return {
      format: 'nomad-dmx-desk', version: 1,
      name: this.showName,
      settings: this.settings, profiles: this.profiles, patch: this.patch,
      cues: this.cues, effects: this.effects, gm: this.gm, nextId: this.nextId,
    };
  }

  load(obj) {
    if (!obj || obj.format !== 'nomad-dmx-desk') throw new Error('Not a Nomad DMX Desk show file');
    this.newShow();
    this.showName = String(obj.name || 'Untitled show');
    this.settings = Object.assign(defaultSettings(), obj.settings || {});
    this.settings.universes = clamp(parseInt(this.settings.universes, 10) || 1, 1, MAX_UNIVERSES);
    this.profiles = Array.isArray(obj.profiles) ? obj.profiles : [];
    this.patch = Array.isArray(obj.patch) ? obj.patch : [];
    this.cues = Array.isArray(obj.cues) ? obj.cues : [];
    this.effects = Array.isArray(obj.effects) ? obj.effects : [];
    this.gm = typeof obj.gm === 'number' ? clamp(obj.gm, 0, 1) : 1;
    this.nextId = obj.nextId || 1000;
    this.rebuildMask();
    this.resetSocket();
    this.changed();
  }

  changed() { this.onChange(); }
  id(prefix) { return `${prefix}${this.nextId++}`; }

  allProfiles() { return BUILTIN_PROFILES.concat(this.profiles); }
  profile(id) { return this.allProfiles().find((p) => p.id === id); }
  fixture(id) { return this.patch.find((f) => f.id === id); }

  // Channel keys occupied by a fixture, with the type of each.
  fixtureChannels(f) {
    const p = this.profile(f.profileId);
    if (!p) return [];
    const out = [];
    p.channels.forEach((c, i) => {
      const ch = f.address + i;
      if (ch >= 1 && ch <= 512 && f.universe >= 1 && f.universe <= MAX_UNIVERSES) {
        out.push({ key: keyOf(f.universe, ch), type: c.type, name: c.name });
      }
    });
    return out;
  }

  rebuildMask() {
    this.nonIntensity = new Uint8Array(MAX_UNIVERSES * 512);
    for (const f of this.patch) {
      for (const c of this.fixtureChannels(f)) {
        if (NON_INTENSITY.includes(c.type)) this.nonIntensity[c.key] = 1;
      }
    }
  }

  conflicts() {
    const seen = new Map();
    const bad = new Set();
    for (const f of this.patch) {
      for (const c of this.fixtureChannels(f)) {
        if (seen.has(c.key)) { bad.add(f.id); bad.add(seen.get(c.key)); } else seen.set(c.key, f.id);
      }
    }
    return Array.from(bad);
  }

  // ------------------------------------------------------------------- patch
  saveProfile(p) {
    if (!p || !p.name || !Array.isArray(p.channels) || !p.channels.length) throw new Error('A profile needs a name and at least one channel');
    if (p.channels.length > 512) throw new Error('Too many channels');
    const channels = p.channels.map((c, i) => ({
      name: String(c.name || `Ch ${i + 1}`).slice(0, 40),
      type: TYPES.includes(c.type) ? c.type : 'other',
    }));
    const existing = p.id && this.profiles.find((x) => x.id === p.id);
    if (existing) { existing.name = String(p.name).slice(0, 60); existing.channels = channels; }
    else this.profiles.push({ id: this.id('p'), name: String(p.name).slice(0, 60), channels });
    this.rebuildMask();
    this.changed();
  }

  deleteProfile(id) {
    if (this.patch.some((f) => f.profileId === id)) throw new Error('That profile is used by patched fixtures');
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.changed();
  }

  addFixtures(o) {
    const p = this.profile(o.profileId);
    if (!p) throw new Error('Choose a fixture profile');
    const count = clamp(parseInt(o.count, 10) || 1, 1, 256);
    let universe = clamp(parseInt(o.universe, 10) || 1, 1, MAX_UNIVERSES);
    let address = clamp(parseInt(o.address, 10) || 1, 1, 512);
    const foot = p.channels.length;
    let num = parseInt(o.startNum, 10);
    if (!(num >= 1)) num = this.patch.reduce((m, f) => Math.max(m, f.num), 0) + 1;
    const base = String(o.name || p.name).slice(0, 40);
    for (let i = 0; i < count; i++) {
      if (address + foot - 1 > 512) { universe++; address = 1; }
      if (universe > MAX_UNIVERSES) throw new Error('Ran out of universes');
      this.patch.push({ id: this.id('f'), num: num + i, name: count > 1 ? `${base} ${i + 1}` : base, profileId: p.id, universe, address });
      address += foot;
    }
    if (universe > this.settings.universes) this.settings.universes = universe;
    this.rebuildMask();
    this.changed();
  }

  updateFixture(id, patch) {
    const f = this.fixture(id);
    if (!f) return;
    if (patch.name != null) f.name = String(patch.name).slice(0, 40);
    if (patch.num != null && parseInt(patch.num, 10) >= 1) f.num = parseInt(patch.num, 10);
    if (patch.universe != null) f.universe = clamp(parseInt(patch.universe, 10) || 1, 1, MAX_UNIVERSES);
    if (patch.address != null) f.address = clamp(parseInt(patch.address, 10) || 1, 1, 512);
    if (f.universe > this.settings.universes) this.settings.universes = f.universe;
    this.rebuildMask();
    this.changed();
  }

  removeFixture(id) {
    this.patch = this.patch.filter((f) => f.id !== id);
    this.effects.forEach((e) => { e.fixtureIds = e.fixtureIds.filter((x) => x !== id); });
    this.selection.ids = this.selection.ids.filter((x) => x !== id);
    this.rebuildMask();
    this.changed();
  }

  // --------------------------------------------------------------- selection
  setUniverse(n) {
    this.currentUniverse = clamp(parseInt(n, 10) || 1, 1, this.settings.universes);
    this.changed();
  }

  setSelection(sel) {
    if (sel && sel.mode === 'ch') {
      this.selection = { mode: 'ch', ids: [], universe: clamp(parseInt(sel.universe, 10) || 1, 1, MAX_UNIVERSES), channels: Array.from(new Set((sel.channels || []).map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 512))).sort((a, b) => a - b) };
    } else {
      const ids = (sel && sel.ids) || [];
      this.selection = { mode: 'fix', ids: ids.filter((id) => this.fixture(id)), universe: this.currentUniverse, channels: [] };
    }
    this.changed();
  }

  selectedFixtures() {
    return this.selection.mode === 'fix' ? this.selection.ids.map((id) => this.fixture(id)).filter(Boolean) : [];
  }

  selectedKeys() {
    return this.selection.mode === 'ch' ? this.selection.channels.map((c) => keyOf(this.selection.universe, c)) : [];
  }

  // -------------------------------------------------------------- programmer
  setLevel(pct) {
    const v = Math.round((clamp(pct, 0, 100) * 255) / 100);
    if (this.selection.mode === 'ch') {
      for (const k of this.selectedKeys()) this.programmer.set(k, v);
    } else {
      for (const f of this.selectedFixtures()) this.setIntensity(f, v);
    }
    this.changed();
  }

  setIntensity(f, v) {
    const chans = this.fixtureChannels(f);
    const dim = chans.filter((c) => c.type === 'dimmer');
    if (dim.length) { dim.forEach((c) => this.programmer.set(c.key, v)); return; }
    const em = chans.filter((c) => EMITTERS.includes(c.type));
    if (!em.length) return;
    const cur = em.map((c) => (this.programmer.has(c.key) ? this.programmer.get(c.key) : this.baseValue(c.key)));
    const max = Math.max(...cur);
    if (max > 0) em.forEach((c, i) => this.programmer.set(c.key, Math.round((cur[i] / max) * v)));
    else em.forEach((c) => this.programmer.set(c.key, v));
  }

  baseValue(key) { return this.playback.levels.get(key) || 0; }

  setColour(r, g, b) {
    const rgb = { red: clamp(r, 0, 255), green: clamp(g, 0, 255), blue: clamp(b, 0, 255) };
    for (const f of this.selectedFixtures()) {
      const chans = this.fixtureChannels(f);
      let any = false;
      for (const c of chans) if (rgb[c.type] != null) { this.programmer.set(c.key, Math.round(rgb[c.type])); any = true; }
      if (!any) continue;
      const dim = chans.filter((c) => c.type === 'dimmer');
      for (const c of dim) if (!this.programmer.has(c.key) && !this.baseValue(c.key)) this.programmer.set(c.key, 255);
    }
    this.changed();
  }

  setParam(type, value) {
    const v = Math.round(clamp(value, 0, 255));
    for (const f of this.selectedFixtures()) {
      for (const c of this.fixtureChannels(f)) if (c.type === type) this.programmer.set(c.key, v);
    }
    this.changed();
  }

  setChannel(universe, ch, value) {
    const k = keyOf(universe, ch);
    if (value == null) this.programmer.delete(k); else this.programmer.set(k, Math.round(clamp(value, 0, 255)));
    this.changed();
  }

  clearProgrammer() { this.programmer.clear(); this.changed(); }
  clearAll() { this.programmer.clear(); this.selection = { mode: this.selection.mode, ids: [], universe: this.currentUniverse, channels: [] }; this.changed(); }

  setMaster(pct) { this.gm = clamp(pct, 0, 100) / 100; this.changed(); }
  setBlackout(on) { this.blackout = on == null ? !this.blackout : !!on; this.changed(); }

  // ------------------------------------------------------------------- cues
  sortedCues() { return this.cues.slice().sort((a, b) => a.number - b.number); }

  recordCue(number, fade, label) {
    if (!(number >= 0)) throw new Error('Cue number required');
    const values = {};
    for (const [k, v] of this.playback.levels) if (v > 0) values[k] = Math.round(v);
    for (const [k, v] of this.programmer) { if (v > 0) values[k] = v; else delete values[k]; }
    let cue = this.cues.find((c) => c.number === number);
    if (cue) { cue.values = values; if (fade != null) cue.fade = fade; if (label) cue.label = label; }
    else {
      cue = { id: this.id('c'), number, label: label || `Cue ${number}`, fade: fade != null ? fade : 2, values };
      this.cues.push(cue);
    }
    this.cues = this.sortedCues();
    this.programmer.clear();
    this.playback.levels = new Map(Object.entries(values).map(([k, v]) => [Number(k), v]));
    this.playback.fade = null;
    this.playback.current = this.cues.findIndex((c) => c.id === cue.id);
    this.changed();
    return cue;
  }

  updateCue(id, patch) {
    const c = this.cues.find((x) => x.id === id);
    if (!c) return;
    if (patch.label != null) c.label = String(patch.label).slice(0, 60);
    if (patch.fade != null) c.fade = clamp(parseFloat(patch.fade) || 0, 0, 600);
    if (patch.number != null && parseFloat(patch.number) >= 0 && !this.cues.some((x) => x !== c && x.number === parseFloat(patch.number))) {
      const cur = this.cues[this.playback.current];
      c.number = parseFloat(patch.number);
      this.cues = this.sortedCues();
      this.playback.current = cur ? this.cues.indexOf(cur) : -1;
    }
    this.changed();
  }

  deleteCue(id) {
    const cur = this.cues[this.playback.current];
    this.cues = this.cues.filter((c) => c.id !== id);
    this.playback.current = cur && this.cues.includes(cur) ? this.cues.indexOf(cur) : -1;
    this.changed();
  }

  goIndex(i) {
    const cue = this.cues[i];
    if (!cue) return false;
    const to = new Map(Object.entries(cue.values).map(([k, v]) => [Number(k), v]));
    const from = new Map(this.playback.levels);
    const keys = new Set([...from.keys(), ...to.keys()]);
    this.playback.fade = { from, to, keys, start: Date.now(), dur: Math.max(0, cue.fade || 0) };
    this.playback.current = i;
    this.tickFade(Date.now());
    this.changed();
    return true;
  }

  go() {
    if (!this.cues.length) return;
    this.goIndex(Math.min(this.cues.length - 1, this.playback.current + 1));
  }
  back() { if (this.playback.current > 0) this.goIndex(this.playback.current - 1); }
  goto(number) {
    const i = this.cues.findIndex((c) => c.number === number);
    if (i < 0) throw new Error(`No cue ${number}`);
    this.goIndex(i);
  }
  stop() { this.playback.fade = null; this.changed(); }
  release() { this.playback.levels.clear(); this.playback.fade = null; this.playback.current = -1; this.changed(); }

  tickFade(now) {
    const fd = this.playback.fade;
    if (!fd) return;
    const p = fd.dur <= 0 ? 1 : Math.min(1, (now - fd.start) / 1000 / fd.dur);
    for (const k of fd.keys) {
      const a = fd.from.get(k) || 0;
      const b = fd.to.get(k) || 0;
      const v = a + (b - a) * p;
      if (v > 0.001) this.playback.levels.set(k, v); else this.playback.levels.delete(k);
    }
    if (p >= 1) this.playback.fade = null;
  }

  // ----------------------------------------------------------------- effects
  addEffect(o) {
    const ids = o && o.fixtureIds && o.fixtureIds.length ? o.fixtureIds : this.selection.ids;
    if (!ids.length) throw new Error('Select some fixtures first');
    this.effects.push({
      id: this.id('e'), type: (o && o.type) || 'sine', fixtureIds: ids.slice(), rate: (o && o.rate) || 1,
      depth: o && o.depth != null ? o.depth : 1, spread: o && o.spread != null ? o.spread : 1, on: true,
    });
    this.changed();
  }
  updateEffect(id, patch) {
    const e = this.effects.find((x) => x.id === id);
    if (!e) return;
    if (patch.type != null && ['sine', 'chase', 'pulse', 'strobe', 'rainbow'].includes(patch.type)) e.type = patch.type;
    if (patch.rate != null) e.rate = clamp(parseFloat(patch.rate) || 0.1, 0.05, 25);
    if (patch.depth != null) e.depth = clamp(parseFloat(patch.depth), 0, 1);
    if (patch.spread != null) e.spread = clamp(parseFloat(patch.spread), 0, 1);
    if (patch.on != null) e.on = !!patch.on;
    if (patch.useSelection) e.fixtureIds = this.selection.ids.slice();
    this.changed();
  }
  removeEffect(id) { this.effects = this.effects.filter((e) => e.id !== id); this.changed(); }

  applyEffects(frame, t) {
    for (const e of this.effects) {
      if (!e.on) continue;
      const fx = e.fixtureIds.map((id) => this.fixture(id)).filter(Boolean);
      const n = fx.length;
      fx.forEach((f, i) => {
        const chans = this.fixtureChannels(f);
        const x = t * e.rate + (n > 1 ? (i / n) * e.spread : 0);
        const frac = x - Math.floor(x);
        let amount;
        switch (e.type) {
          case 'sine': amount = 0.5 - 0.5 * Math.cos(2 * Math.PI * x); break;
          case 'pulse': amount = frac < 0.5 ? 1 : 0; break;
          case 'strobe': amount = frac < 0.1 ? 1 : 0; break;
          case 'chase': { const pos = (t * e.rate) % 1; amount = Math.floor(pos * n) === i ? 1 : 0; break; }
          default: amount = 1;
        }
        amount = 1 - e.depth * (1 - amount);
        if (e.type === 'rainbow') {
          const [r, g, b] = hsv(frac, 1, 1);
          for (const c of chans) {
            if (c.type === 'red') frame[c.key] = r * 255;
            else if (c.type === 'green') frame[c.key] = g * 255;
            else if (c.type === 'blue') frame[c.key] = b * 255;
            else if (c.type === 'dimmer' && frame[c.key] < 1) frame[c.key] = 255;
          }
          return;
        }
        const dim = chans.filter((c) => c.type === 'dimmer');
        const targets = dim.length ? dim : chans.filter((c) => EMITTERS.includes(c.type));
        const anyLit = targets.some((c) => frame[c.key] > 0);
        for (const c of targets) frame[c.key] = (anyLit ? frame[c.key] : 255) * amount;
      });
    }
  }

  // ------------------------------------------------------------------ output
  computeFrame(now) {
    const U = this.settings.universes;
    const n = U * 512;
    const frame = new Float32Array(MAX_UNIVERSES * 512);
    this.tickFade(now);
    for (const [k, v] of this.playback.levels) if (k < n) frame[k] = v;
    for (const [k, v] of this.programmer) if (k < n) frame[k] = v;
    this.applyEffects(frame, (now - this.t0) / 1000);
    const scale = this.blackout ? 0 : this.gm;
    const out = [];
    for (let u = 0; u < U; u++) {
      const buf = new Uint8Array(512);
      for (let c = 0; c < 512; c++) {
        const k = u * 512 + c;
        let v = frame[k];
        if (!this.nonIntensity[k]) v *= scale;
        buf[c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
      out.push(buf);
    }
    this.lastFrame = out;
    return out;
  }

  resetSocket() {
    if (this.sock) { try { this.sock.close(); } catch (e) { /* ignore */ } this.sock = null; }
  }

  ensureSocket() {
    if (this.sock) return this.sock;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => { this.stats.lastError = e.message; this.resetSocket(); });
    const bind = this.settings.bindIp || undefined;
    s.bind(0, bind, () => {
      try {
        s.setBroadcast(true);
        s.setMulticastTTL(8);
        if (this.settings.bindIp) s.setMulticastInterface(this.settings.bindIp);
      } catch (e) { this.stats.lastError = e.message; }
    });
    this.sock = s;
    return s;
  }

  sendFrame(frame) {
    const s = this.settings;
    let sock;
    try { sock = this.ensureSocket(); } catch (e) { this.stats.lastError = e.message; return; }
    const done = (err) => { if (err) this.stats.lastError = err.message; else { this.stats.packets++; this.stats.lastError = ''; } };
    frame.forEach((data, i) => {
      const u = i + 1;
      this.seq[u] = (this.seq[u] % 255) + 1;
      if (s.protocol === 'artnet' || s.protocol === 'both') {
        const pkt = artnetPacket(u - 1 + (parseInt(s.artnetFirst, 10) || 0), this.seq[u], data);
        try { sock.send(pkt, s.artnetPort, s.artnetDest || '255.255.255.255', done); } catch (e) { this.stats.lastError = e.message; }
      }
      if (s.protocol === 'sacn' || s.protocol === 'both') {
        const pkt = sacnPacket(u, this.seq[u], data, s.sacnPriority, this.showName);
        const dest = s.sacnUnicast || sacnMulticastAddr(u);
        try { sock.send(pkt, s.sacnPort, dest, done); } catch (e) { this.stats.lastError = e.message; }
      }
    });
  }

  start(onFrame) {
    this.stop_();
    this._onFrame = onFrame;
    const period = Math.round(1000 / clamp(this.settings.fps, 1, 44));
    this.timer = setInterval(() => {
      const frame = this.computeFrame(Date.now());
      this.sendFrame(frame);
      if (onFrame) onFrame(frame);
    }, period);
  }
  stop_() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  shutdown() { this.stop_(); this.resetSocket(); }

  updateSettings(patch) {
    const s = this.settings;
    if (patch.protocol && ['artnet', 'sacn', 'both'].includes(patch.protocol)) s.protocol = patch.protocol;
    if (patch.artnetDest != null) s.artnetDest = String(patch.artnetDest).trim() || '255.255.255.255';
    if (patch.artnetFirst != null) s.artnetFirst = clamp(parseInt(patch.artnetFirst, 10) || 0, 0, 32000);
    if (patch.bleFormat != null && ['OFFSET', 'PLAIN'].includes(patch.bleFormat)) s.bleFormat = patch.bleFormat;
    if (patch.bleUniverse != null) s.bleUniverse = clamp(parseInt(patch.bleUniverse, 10) || 1, 1, MAX_UNIVERSES);
    if (patch.sacnUnicast != null) s.sacnUnicast = String(patch.sacnUnicast).trim();
    if (patch.sacnPriority != null) s.sacnPriority = clamp(parseInt(patch.sacnPriority, 10) || 100, 0, 200);
    if (patch.bindIp != null) s.bindIp = String(patch.bindIp).trim();
    if (patch.universes != null) {
      s.universes = clamp(parseInt(patch.universes, 10) || 1, 1, MAX_UNIVERSES);
      if (this.currentUniverse > s.universes) this.currentUniverse = s.universes;
    }
    if (patch.fps != null) { s.fps = clamp(parseInt(patch.fps, 10) || 30, 1, 44); if (this.timer && this._onFrame) this.start(this._onFrame); }
    this.resetSocket();
    this.changed();
  }

  // ----------------------------------------------------------------- commands
  execute(text) {
    try { return this.run(parseCommand(text)); } catch (e) { return { ok: false, message: e.message }; }
  }

  run(a) {
    const ok = (message) => ({ ok: true, message });
    switch (a.type) {
      case 'select': {
        const sel = new Set();
        if (a.mode === 'fix') {
          for (const op of a.ops) {
            for (const f of this.patch) {
              if (f.num >= op.from && f.num <= op.to) { if (op.op === 'add') sel.add(f.id); else sel.delete(f.id); }
            }
          }
          if (!sel.size) throw new Error('No matching fixtures');
          this.selection = { mode: 'fix', ids: this.patch.filter((f) => sel.has(f.id)).map((f) => f.id), universe: this.currentUniverse, channels: [] };
        } else {
          const universe = a.universe != null ? a.universe : this.currentUniverse;
          if (universe < 1 || universe > this.settings.universes) throw new Error(`Universe ${universe} is not enabled (Output tab)`);
          for (const op of a.ops) {
            if (op.from < 1 || op.to > 512) throw new Error('Channels are 1-512');
            for (let c = op.from; c <= op.to; c++) { if (op.op === 'add') sel.add(c); else sel.delete(c); }
          }
          this.currentUniverse = universe;
          this.selection = { mode: 'ch', ids: [], universe, channels: Array.from(sel).sort((x, y) => x - y) };
        }
        if (a.level != null) this.setLevel(a.level);
        this.changed();
        return ok(a.level != null ? `Set ${a.level}%` : 'Selected');
      }
      case 'level':
        if (this.selection.mode === 'ch' ? !this.selection.channels.length : !this.selection.ids.length) throw new Error('Nothing selected');
        this.setLevel(a.level); return ok(`Set ${a.level}%`);
      case 'colour':
        if (!this.selectedFixtures().length) throw new Error('Select fixtures first (fix 1 thru 4)');
        this.setColour(...a.rgb); return ok('Colour set');
      case 'universe': {
        if (a.n < 1 || a.n > this.settings.universes) throw new Error(`Universe ${a.n} is not enabled (Output tab)`);
        this.setUniverse(a.n); return ok(`Universe ${a.n}`);
      }
      case 'clear': this.clearAll(); return ok('Cleared');
      case 'release': this.release(); return ok('Playback released');
      case 'blackout': this.setBlackout(a.on); return ok(this.blackout ? 'Blackout ON' : 'Blackout off');
      case 'master': this.setMaster(a.level); return ok(`Master ${a.level}%`);
      case 'go': if (!this.cues.length) throw new Error('No cues recorded'); this.go(); return ok(`Cue ${this.cues[this.playback.current].number}`);
      case 'back': this.back(); return ok(this.playback.current >= 0 ? `Cue ${this.cues[this.playback.current].number}` : 'At start');
      case 'stop': this.stop(); return ok('Fade stopped');
      case 'goto': this.goto(a.number); return ok(`Cue ${a.number}`);
      case 'record': {
        const cue = this.recordCue(a.number, a.fade, a.label);
        return ok(`Recorded cue ${cue.number}`);
      }
      case 'deleteCue': {
        const c = this.cues.find((x) => x.number === a.number);
        if (!c) throw new Error(`No cue ${a.number}`);
        this.deleteCue(c.id); return ok(`Deleted cue ${a.number}`);
      }
      default: throw new Error('Unsupported command');
    }
  }

  // ------------------------------------------------------------------ snapshot
  getShow() {
    return {
      name: this.showName,
      settings: this.settings,
      profiles: this.allProfiles(),
      types: TYPES,
      patch: this.patch,
      conflicts: this.conflicts(),
      cues: this.cues,
      currentCue: this.playback.current,
      effects: this.effects,
      gm: Math.round(this.gm * 100),
      blackout: this.blackout,
      selection: this.selection,
      currentUniverse: this.currentUniverse,
    };
  }

  getStatus() {
    return {
      packets: this.stats.packets, lastError: this.stats.lastError,
      current: this.playback.current, fading: !!this.playback.fade,
      programmer: Array.from(this.programmer.keys()),
    };
  }
}

function hsv(h, s, v) {
  const i = Math.floor(h * 6); const f = h * 6 - i;
  const p = v * (1 - s); const q = v * (1 - f * s); const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p]; case 1: return [q, v, p]; case 2: return [p, v, t];
    case 3: return [p, q, v]; case 4: return [t, p, v]; default: return [v, p, q];
  }
}

module.exports = { Engine, keyOf, MAX_UNIVERSES };
