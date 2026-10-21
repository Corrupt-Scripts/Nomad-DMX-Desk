'use strict';
// The iPad app has no Electron main process, so this runs the desk engine inside the page and gives the
// screen the same `window.desk` bridge that the desktop app's preload script does.
const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');
const { KeepAwake } = require('@capacitor-community/keep-awake');
const { Engine } = require('../../engine/engine');
const { ALLOWED } = require('../../engine/api');
const { artPollPacket, parseArtPollReply } = require('../../engine/artpoll');
const udp = require('./udp');
require('./ble-polyfill');

const engine = new Engine();
const showCbs = [];
const liveCbs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTOSAVE = 'autosave.nomaddmx';

// ------------------------------------------------------------------ storage
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    Filesystem.writeFile({ path: AUTOSAVE, data: JSON.stringify(engine.serialize()), directory: Directory.Data, encoding: Encoding.UTF8 }).catch(() => {});
  }, 1000);
}

let showTimer = null;
engine.onChange = () => {
  if (!showTimer) {
    showTimer = setTimeout(() => {
      showTimer = null;
      const snap = engine.getShow();
      showCbs.forEach((cb) => cb(snap));
    }, 20);
  }
  scheduleSave();
};

const ready = (async () => {
  try {
    const r = await Filesystem.readFile({ path: AUTOSAVE, directory: Directory.Data, encoding: Encoding.UTF8 });
    engine.load(JSON.parse(r.data));
  } catch (e) { engine.newShow(); }
  engine.start();
  setInterval(() => {
    if (!liveCbs.length) return;
    const l = { out: engine.lastFrame, status: engine.getStatus() };
    liveCbs.forEach((cb) => cb(l));
  }, 66);
  // DMX only flows while the app is on screen, so keep the iPad awake.
  try { await KeepAwake.keepAwake(); } catch (e) { /* not available */ }
  engine.changed();
})();

// ---------------------------------------------------------------- discovery
// Find Art-Net nodes without typing an IP: poll the broadcast address and, because iOS can hide broadcast
// traffic from apps without a special Apple entitlement, also poll every address on the local /24 directly.
const ipNum = (s) => s.split('.').reduce((a, o) => ((a << 8) | (parseInt(o, 10) & 255)) >>> 0, 0);
const numIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

async function artnetScan() {
  const nodes = new Map();
  const handle = await udp.addListener('udpMessage', (m) => {
    let buf;
    try { buf = Buffer.from(m.data, 'base64'); } catch (e) { return; }
    const n = parseArtPollReply(buf, { address: m.host });
    if (!n) return;
    const prev = nodes.get(n.ip);
    if (prev) n.outputs = Array.from(new Set(prev.outputs.concat(n.outputs))).sort((a, b) => a - b);
    nodes.set(n.ip, n);
  });
  try {
    try { await udp.listen({ port: engine.settings.artnetPort || 6454 }); } catch (e) { /* unicast replies still work */ }
    let ifaces = [];
    try { ifaces = (await udp.localInfo()).interfaces || []; } catch (e) { /* none */ }
    const targets = new Set(['255.255.255.255']);
    for (const i of ifaces) {
      const ip = ipNum(i.ip); const mask = ipNum(i.mask);
      targets.add(numIp(((ip & mask) | (~mask >>> 0)) >>> 0));
      // sweep the /24 around us (or the whole subnet when it is smaller than that)
      const m24 = (mask >>> 0) > 0xffffff00 ? mask : 0xffffff00;
      const base = (ip & m24) >>> 0; const count = (~m24 >>> 0) + 1;
      for (let k = 1; k < count - 1; k++) { const h = numIp((base + k) >>> 0); if (h !== i.ip) targets.add(h); }
    }
    const pkt = artPollPacket().toString('base64');
    const list = Array.from(targets);
    const port = engine.settings.artnetPort || 6454;
    const blast = async () => {
      for (let i = 0; i < list.length; i += 120) {
        await udp.sendBatch({ packets: list.slice(i, i + 120).map((h) => ({ host: h, port, data: pkt })) }).catch(() => {});
        await sleep(20);
      }
    };
    await blast();
    await sleep(700);
    await blast();
    await sleep(1500);
  } finally {
    try { await handle.remove(); } catch (e) { /* ignore */ }
    try { await udp.stopListen(); } catch (e) { /* ignore */ }
  }
  return Array.from(nodes.values()).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

// -------------------------------------------------------------------- bridge
const noWifi = async () => ({ ok: false, message: 'Pick a Wi-Fi network in the iPad Settings app (Wi-Fi). iPadOS does not let apps scan or join networks.' });

window.desk = {
  native: true,
  api: async (method, ...args) => {
    await ready;
    if (!ALLOWED.has(method)) throw new Error(`Unknown method ${method}`);
    if (method === 'getShow') return engine.getShow();
    if (method === 'getLibrary') return engine.getLibrary();
    if (method === 'execute') return engine.execute(...args);
    try { return { ok: true, result: engine[method](...args) }; } catch (e) { return { ok: false, message: e.message }; }
  },
  onShow: (cb) => showCbs.push(cb),
  onLive: (cb) => liveCbs.push(cb),
  artnetScan,
  wifiScan: noWifi, wifiConnect: noWifi, wifiSettings: async () => {},
  bleSelect: () => {}, onBleDevices: () => {},
  remoteInfo: async () => null, remoteSet: noWifi,
};

window.__nomadEngine = engine; // handy for debugging and tests
