// Astera tubes (Titan, Helios, Hyperion) over Bluetooth Low Energy: framing, colour, brightness and the
// tubes' built-in effects. Protocol notes come from the user's own Bluetooth logs of the Astera app.
// Pure logic with no Bluetooth calls, so it can be tested in Node. renderer/ble.js does the I/O.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASTERA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UUID = {
    service: '0a6c6c72-9ca6-ffaf-3440-b2dae8c86a65',
    write: '0a6c6c72-9ca6-ffaf-3440-b2dae8c86a66',
    notify: '0a6c6c72-9ca6-ffaf-3440-b2dae8c86a67',
    info: '0a6c6c72-9ca6-ffaf-3440-b2dae8c86a68',
  };
  const NAME_PREFIX = /^(TITAN|HELIOS|HYPERION|ASTERA)\b/i;

  function crc16(data) {
    let c = 0xFFFF;
    for (const x of data) {
      c ^= x;
      for (let i = 0; i < 8; i++) c = c & 1 ? (c >> 1) ^ 0xA001 : c >> 1;
    }
    return c;
  }

  // 0a LEN payload CRC(hi,lo); any 0a after the first byte is doubled.
  function frame(payload) {
    const p = Array.from(payload);
    const body = [p.length].concat(p);
    const c = crc16(body);
    const raw = body.concat([c >> 8, c & 0xFF]);
    const out = [0x0A];
    for (const x of raw) { out.push(x); if (x === 0x0A) out.push(0x0A); }
    return Uint8Array.from(out);
  }

  const ALL = [0x7E, 0xDF, 0x36, 0, 0, 0, 0, 0x7D, 0x63, 0x13];
  const toAll = (...cmd) => frame(ALL.concat(cmd.flat()));

  const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const colour = (r, g, b) => toAll(0x0C, clamp8(r), 0x0D, clamp8(g), 0x0E, clamp8(b));
  const dimmer = (d) => toAll(0x07, clamp8(d));
  const colourDimmer = (r, g, b, d) => toAll(0x0C, clamp8(r), 0x0D, clamp8(g), 0x0E, clamp8(b), 0x07, clamp8(d));

  const hex = (s) => s.trim().split(/\s+/).map((h) => parseInt(h, 16));
  const look = (time, body) => toAll(0xA2, 0x06, 0x16, time >> 8, time & 0xFF, body);
  const STATIC_BODY = hex('00 64 ff 00 00 00 ff 00 00 00 01 ff ff 01 ff ff c8 00 00 00');
  const staticLook = () => look(0x0014, STATIC_BODY);

  // Effect 1..8. time is the base cycle time; body is the 20-byte effect description.
  const EFFECTS = [
    { name: 'Wedding', time: 0x035c, body: hex('08 64 ff 00 00 00 ff 14 93 ff db a7 ff 02 ff ff c8 00 00 64') },
    { name: 'Slow Movements', time: 0x1bbc, body: hex('0d 64 ff 00 00 00 ff ff 00 ff a5 00 ff 01 00 ff 14 93 00 64') },
    { name: 'Rainbow', time: 0x02f8, body: hex('0f 64 ff 01 00 00 ff 01 00 00 02 ff ff 02 ff ff c8 00 00 64') },
    { name: 'Fire', time: 0x0168, body: hex('10 64 ff 00 00 00 ff 01 00 ff a5 00 ff 02 ff ff c8 00 00 64') },
    { name: 'Ice', time: 0x0168, body: hex('10 64 ff 00 00 00 00 02 ff ff ff ff 00 00 00 00 00 00 00 64') },
    { name: 'Garden', time: 0x0294, body: hex('04 64 ff 01 00 00 02 ff 00 ff ff ff 02 ff 00 00 02 ff 00 64') },
    { name: 'Blue Pulse', time: 0x0294, body: hex('04 64 ff 00 00 00 00 02 ff 00 00 00 00 02 ff 00 00 00 00 64') },
    { name: 'Colorful', time: 0x035c, body: hex('07 64 ff 00 00 00 ff a5 00 01 ff ff ff 14 93 ff ff 00 00 64') },
  ];

  // speed 0-100 (50 = the Astera app's own speed, 100 = 4x faster, 0 = 4x slower)
  function effectFrame(index, speed) {
    const e = EFFECTS[index - 1];
    if (!e) return null;
    const sp = Math.max(0, Math.min(100, speed == null ? 50 : speed));
    const t = Math.max(10, Math.min(0xFFFF, Math.round(e.time * Math.pow(2, (50 - sp) / 25))));
    return look(t, e.body);
  }

  const utf = (s) => Uint8Array.from(Array.from(s).map((c) => c.charCodeAt(0)));
  const poll = () => frame([0x7F]);
  const clockFrame = (unixSeconds) => {
    const t = Math.floor(unixSeconds) >>> 0;
    return frame([0x7F, 0x93, 0x27, 0x00, 0x01, 0xF5, 0x0F, 0, 0, 0, 0, (t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255]);
  };
  const handshake2 = () => frame([0x7F, 0x93, 0x27, 0x00, 0x02]);
  const connectLine = (pin) => `s2015=2147470331&sh1000=0&s2004=1&s2031=0&s63=${parseInt(pin, 10) || 0}&s130&s0=1&s2006=1&s1002\n`;

  // Reads frames out of the bridge's byte stream (frames can be split across notifications and
  // start-up text lines end in 0a too, so frames are found by checking the CRC).
  class Parser {
    constructor() { this.buf = []; this.text = ''; }
    push(bytes) {
      for (const b of bytes) this.buf.push(b);
      const frames = [];
      let i = 0;
      while (i < this.buf.length) {
        if (this.buf[i] !== 0x0A) { this.text += String.fromCharCode(this.buf[i]); i++; continue; }
        const r = this.tryFrame(i);
        if (r === 'wait') break;
        if (r) { frames.push(r.payload); i = r.end; } else { this.text += '\n'; i++; }
      }
      this.buf = this.buf.slice(i);
      if (this.text.length > 4000) this.text = this.text.slice(-2000);
      return frames;
    }
    tryFrame(start) {
      const un = []; // undoubled bytes after the leading 0a
      let j = start + 1;
      const next = () => {
        if (j >= this.buf.length) return null;
        let x = this.buf[j];
        if (x === 0x0A) { if (j + 1 >= this.buf.length) return null; if (this.buf[j + 1] !== 0x0A) return -1; j += 2; return 0x0A; }
        j++; return x;
      };
      const len = next(); if (len === null) return 'wait'; if (len < 0) return false;
      for (let k = 0; k < len + 2; k++) { const x = next(); if (x === null) return 'wait'; if (x < 0) return false; un.push(x); }
      const payload = un.slice(0, len);
      const c = crc16([len].concat(payload));
      if (un[len] === (c >> 8) && un[len + 1] === (c & 255)) return { payload, end: j };
      return false;
    }
  }

  // Turns what the desk wants (colour, dimmer, effect, speed) into the right frames at the right
  // times, following the rules in the notes: one look at a time, 1.5 s quiet after a look, leave an
  // effect with the static look, colour as hue at full value with brightness on the master dimmer.
  const LOOK_GAP = 1500;
  const MIN_GAP = 100;
  const TOL = 8;

  class Controller {
    constructor() {
      this.want = { r: 0, g: 0, b: 0, dim: 0, effect: 0, speed: 50 };
      this.cur = { effect: 0, speed: 50 };
      this.sent = null; this.lastLookAt = -1e9; this.lastSendAt = -1e9; this.force = true;
      this.speedAt = 0;
    }
    reset() { this.sent = null; this.cur = { effect: 0, speed: 50 }; this.lastLookAt = -1e9; this.force = true; }
    // r,g,b,dim 0..255 (desk output), effect 0..8 (0 = none), speed 0..100
    set(r, g, b, dim, effect, speed) {
      this.want = { r, g, b, dim, effect: Math.max(0, Math.min(EFFECTS.length, Math.round(effect || 0))), speed: Math.max(0, Math.min(100, Math.round(speed == null ? 50 : speed))) };
    }
    // colour wheel: scale RGB so the biggest channel is 255 and put the scale on the master dimmer
    levels() {
      const { r, g, b, dim } = this.want;
      const m = Math.max(r, g, b);
      if (m <= 0 || dim <= 0) return { off: true, r: this.sent ? this.sent.r : 255, g: this.sent ? this.sent.g : 255, b: this.sent ? this.sent.b : 255, d: 0 };
      return { off: false, r: clamp8(r * 255 / m), g: clamp8(g * 255 / m), b: clamp8(b * 255 / m), d: clamp8(dim * m / 255) };
    }
    // returns the frame to send now, or null
    next(now) {
      if (now - this.lastLookAt < LOOK_GAP) return null;
      const w = this.want;
      if (w.effect !== this.cur.effect || (w.effect > 0 && Math.abs(w.speed - this.cur.speed) >= 2 && now - this.speedAt >= LOOK_GAP)) {
        this.lastLookAt = now; this.lastSendAt = now; this.speedAt = now;
        const leaving = w.effect === 0;
        this.cur = { effect: w.effect, speed: w.speed };
        this.force = true; this.sent = leaving ? null : this.sent;
        return leaving ? staticLook() : effectFrame(w.effect, w.speed);
      }
      if (now - this.lastSendAt < MIN_GAP) return null;
      const l = this.levels();
      const s = this.sent;
      if (this.cur.effect > 0) {
        // during an effect only brightness goes out, never colour
        if (!this.force && s && Math.abs(s.d - l.d) < 3) return null;
        this.force = false; this.lastSendAt = now; this.sent = Object.assign({}, s || {}, { d: l.d });
        return dimmer(l.d);
      }
      if (l.off) {
        if (!this.force && s && s.d === 0) return null;
        this.force = false; this.lastSendAt = now; this.sent = { r: l.r, g: l.g, b: l.b, d: 0 };
        return dimmer(0);
      }
      const same = s && Math.abs(s.r - l.r) <= TOL && Math.abs(s.g - l.g) <= TOL && Math.abs(s.b - l.b) <= TOL && Math.abs(s.d - l.d) <= TOL;
      if (!this.force && same) return null;
      this.force = false; this.lastSendAt = now; this.sent = { r: l.r, g: l.g, b: l.b, d: l.d };
      return colourDimmer(l.r, l.g, l.b, l.d);
    }
  }

  return { UUID, NAME_PREFIX, EFFECTS, crc16, frame, toAll, colour, dimmer, colourDimmer, staticLook, effectFrame, utf, poll, clockFrame, handshake2, connectLine, Parser, Controller, LOOK_GAP };
});
