'use strict';
// Gives the page a Web-Bluetooth-shaped navigator.bluetooth on iPad (WKWebView has none),
// built on the native Bluetooth LE plugin. renderer/ble.js then works unchanged.
const { BleClient } = require('@capacitor-community/bluetooth-le');

const lower = (u) => String(u).toLowerCase();
const notFound = (msg) => Object.assign(new Error(msg || 'Not found'), { name: 'NotFoundError' });
const dv = (v) => new DataView(v.buffer, v.byteOffset, v.byteLength);

class Characteristic {
  constructor(deviceId, svc, c) {
    this.deviceId = deviceId; this.svc = svc; this.uuid = lower(c.uuid);
    const p = c.properties || {};
    this.properties = { read: !!p.read, write: !!p.write, writeWithoutResponse: !!p.writeWithoutResponse, notify: !!p.notify, indicate: !!p.indicate };
  }
  async writeValueWithResponse(v) { await BleClient.write(this.deviceId, this.svc, this.uuid, dv(Uint8Array.from(v))); }
  async writeValue(v) { await this.writeValueWithResponse(v); }
  async writeValueWithoutResponse(v) { await BleClient.writeWithoutResponse(this.deviceId, this.svc, this.uuid, dv(Uint8Array.from(v))); }
}

class Service {
  constructor(deviceId, s) { this.deviceId = deviceId; this.uuid = lower(s.uuid); this.chars = (s.characteristics || []).map((c) => new Characteristic(deviceId, this.uuid, c)); }
  async getCharacteristics() { return this.chars; }
  async getCharacteristic(uuid) { const c = this.chars.find((x) => x.uuid === lower(uuid)); if (!c) throw notFound('No such characteristic'); return c; }
}

class Gatt {
  constructor(device) { this.device = device; this.connected = false; this.services = []; }
  async connect() {
    await BleClient.connect(this.device.id, () => { this.connected = false; this.device.emit('gattserverdisconnected'); });
    this.connected = true;
    const list = await BleClient.getServices(this.device.id);
    this.services = list.map((s) => new Service(this.device.id, s));
    return this;
  }
  disconnect() { this.connected = false; BleClient.disconnect(this.device.id).catch(() => {}); }
  async getPrimaryServices() { return this.services; }
  async getPrimaryService(uuid) { const s = this.services.find((x) => x.uuid === lower(uuid)); if (!s) throw notFound('No such service'); return s; }
}

class Device {
  constructor(d) { this.id = d.deviceId; this.name = d.name || ''; this.gatt = new Gatt(this); this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ type })); }
}

let initialised = false;
const bluetooth = {
  async requestDevice(opts) {
    if (!initialised) { await BleClient.initialize({ androidNeverForLocation: true }); initialised = true; }
    let d;
    try {
      d = await BleClient.requestDevice({ optionalServices: ((opts && opts.optionalServices) || []).map(lower) });
    } catch (e) {
      if (/cancel|dismiss|no device|not found/i.test((e && e.message) || '')) throw notFound(e.message);
      throw e;
    }
    return new Device(d);
  },
};

try {
  Object.defineProperty(navigator, 'bluetooth', { value: bluetooth, configurable: true });
} catch (e) { /* leave as is */ }

module.exports = { bluetooth };
