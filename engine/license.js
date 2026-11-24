'use strict';
// Licence keys. Two kinds:
//  - Polar keys (sold from the website): activated on this device and re-checked online about daily.
//  - Admin keys (made by the owner with tools/make-admin-key.js): signed with a private key, checked offline.
// Without a valid key the desk runs in free mode (limits in license-config.js).
const nacl = require('tweetnacl');
const cfg = require('./license-config');

const ADMIN_RE = /^BBOX-ADMIN-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const b64 = (s) => Uint8Array.from(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

function verifyAdmin(token) {
  const m = ADMIN_RE.exec(String(token || '').trim());
  if (!m) return null;
  try {
    const ok = nacl.sign.detached.verify(Uint8Array.from(Buffer.from(m[1], 'utf8')), b64(m[2]), b64(cfg.ADMIN_PUBLIC_KEY));
    if (!ok) return null;
    const p = JSON.parse(Buffer.from(b64(m[1])).toString('utf8'));
    return p && p.t === 'admin' ? p : null;
  } catch (e) { return null; }
}

const hint = (k) => (k ? `••••${String(k).replace(/[^A-Za-z0-9]/g, '').slice(-4)}` : '');

class License {
  // storage: { read(): Promise<string|null>, write(text): Promise }   fetch: like window.fetch
  constructor({ storage, fetch, deviceLabel, now, polar } = {}) {
    this.storage = storage || { read: async () => null, write: async () => {} };
    this.fetch = fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.deviceLabel = deviceLabel || 'device';
    this.now = now || (() => Date.now());
    this.polar = Object.assign({}, cfg.POLAR, polar || {});
    this.state = {};
    this.message = '';
    this.busy = false;
    this.onChange = () => {};
  }

  async load() {
    try { const t = await this.storage.read(); this.state = t ? JSON.parse(t) : {}; } catch (e) { this.state = {}; }
    if (this.state.kind === 'admin' && !verifyAdmin(this.state.key)) this.state = {};
    this.onChange();
  }
  async save() { try { await this.storage.write(JSON.stringify(this.state)); } catch (e) { /* best effort */ } }

  isLicensed() {
    const s = this.state;
    if (s.kind === 'admin') return !!verifyAdmin(s.key);
    if (s.kind === 'polar') return !!(s.activationId && s.valid !== false && s.lastValidated && this.now() - s.lastValidated < cfg.GRACE_DAYS * 86400000);
    return false;
  }

  status() {
    const s = this.state;
    const licensed = this.isLicensed();
    return {
      state: this.busy ? 'checking' : licensed ? 'licensed' : 'free',
      kind: s.kind || null,
      name: s.name || '',
      keyHint: s.kind === 'admin' ? 'admin' : hint(s.key),
      lastValidated: s.lastValidated || 0,
      message: this.message,
      limits: licensed ? null : cfg.FREE_LIMITS,
      setup: !!this.polar.organizationId,
    };
  }

  changed() { this.onChange(); }

  async post(path, body) {
    if (!this.fetch) throw new Error('No network available');
    const res = await this.fetch(`${this.polar.api}/v1/customer-portal/license-keys/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    return { status: res.status, ok: res.ok, data };
  }

  async activate(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) { this.message = 'Enter your licence key'; this.changed(); return this.status(); }
    if (ADMIN_RE.test(key)) {
      const p = verifyAdmin(key);
      if (!p) { this.message = 'That admin key is not valid'; this.changed(); return this.status(); }
      this.state = { kind: 'admin', key, name: p.n || 'Admin', lastValidated: this.now() };
      this.message = 'Admin key accepted';
      await this.save(); this.changed(); return this.status();
    }
    if (!this.polar.organizationId) { this.message = 'Licence keys cannot be checked yet because this build is not linked to the shop.'; this.changed(); return this.status(); }
    this.busy = true; this.message = ''; this.changed();
    try {
      const r = await this.post('activate', { key, organization_id: this.polar.organizationId, label: this.deviceLabel });
      if (r.ok && r.data && r.data.id) {
        const st = r.data.license_key && r.data.license_key.status;
        if (st && st !== 'granted') this.message = 'This key is no longer active';
        else {
          this.state = { kind: 'polar', key, activationId: r.data.id, lastValidated: this.now(), valid: true, name: '' };
          this.message = 'Licence activated on this device';
          await this.save();
        }
      } else if (r.status === 404) this.message = 'That key was not found. Check it and try again.';
      else if (r.status === 403 || r.status === 422) this.message = 'This key is already used on the maximum number of devices. Sign out on another device first.';
      else this.message = `The licence server said no (${r.status}). Try again in a moment.`;
    } catch (e) { this.message = 'Could not reach the licence server. Check your internet connection.'; }
    this.busy = false; this.changed(); return this.status();
  }

  // Called on launch and every few hours: only talks to Polar when the last good check is a week old.
  async refreshIfDue() {
    const s = this.state;
    if (s.kind === 'polar' && (!s.lastValidated || this.now() - s.lastValidated >= cfg.CHECK_DAYS * 86400000 || s.valid === false)) return this.refresh();
    return this.status();
  }

  // Re-check a Polar key now. A network failure changes nothing; the key keeps working for the grace period.
  async refresh() {
    const s = this.state;
    if (s.kind !== 'polar' || !s.activationId || !this.polar.organizationId) return this.status();
    try {
      const r = await this.post('validate', { key: s.key, organization_id: this.polar.organizationId, activation_id: s.activationId });
      if (r.ok && r.data) {
        const exp = r.data.expires_at ? Date.parse(r.data.expires_at) : 0;
        const good = r.data.status === 'granted' && (!exp || exp > this.now());
        this.state.valid = good; if (good) this.state.lastValidated = this.now();
        this.message = good ? '' : 'This licence is no longer active';
        await this.save(); this.changed();
      } else if (r.status === 404 || r.status === 403) {
        this.state.valid = false; this.message = 'This licence is no longer active on this device'; await this.save(); this.changed();
      }
    } catch (e) { /* offline: keep going until the grace period ends */ }
    return this.status();
  }

  async deactivate() {
    const s = this.state;
    if (s.kind === 'polar' && s.activationId && this.polar.organizationId) {
      try { await this.post('deactivate', { key: s.key, organization_id: this.polar.organizationId, activation_id: s.activationId }); } catch (e) { /* best effort */ }
    }
    this.state = {}; this.message = 'Signed out'; await this.save(); this.changed(); return this.status();
  }
}

module.exports = { License, verifyAdmin };
