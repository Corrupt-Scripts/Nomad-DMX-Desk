// Loads the built iPad web bundle in a fake browser with a stand-in for the native UDP plugin,
// then checks the whole path: screen -> engine -> Art-Net packets, plus node discovery.
import { JSDOM, VirtualConsole } from 'jsdom';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
execFileSync('node', [path.join(here, 'build-web.mjs')], { stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sent = [];
let polled = new Set();
const listeners = [];
const replyFor = (ip) => {
  const b = Buffer.alloc(239);
  b.write('Art-Net\0', 0, 'ascii'); b.writeUInt16LE(0x2100, 8);
  ip.split('.').forEach((o, i) => { b[10 + i] = +o; });
  b.write('Test Node', 26, 'ascii'); b.write('Test Node long name', 44, 'ascii');
  b.writeUInt16BE(1, 172); b[174] = 0x80; b[190] = 0;
  return b;
};
const udp = {
  async sendBatch({ packets }) {
    for (const p of packets) {
      const buf = Buffer.from(p.data, 'base64');
      if (buf.readUInt16LE(8) === 0x2000) {
        polled.add(p.host);
        if (p.host === '192.168.1.50') setTimeout(() => listeners.forEach((fn) => fn({ data: replyFor('192.168.1.50').toString('base64'), host: '192.168.1.50', port: 6454 })), 30);
      } else sent.push({ ...p, buf });
    }
    return { sent: packets.length };
  },
  async listen() {}, async stopListen() {},
  async localInfo() { return { interfaces: [{ name: 'en0', ip: '192.168.1.20', mask: '255.255.255.0' }] }; },
  async addListener(ev, fn) { listeners.push(fn); return { remove: async () => { listeners.splice(listeners.indexOf(fn), 1); } }; },
};

const server = http.createServer((req, res) => {
  const f = path.join(here, 'www', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(path.join(here, 'www')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  return res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const dom = await JSDOM.fromURL(`http://127.0.0.1:${server.address().port}/`, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: new VirtualConsole().sendTo(console),
  beforeParse(w) { w.__nomadUdp = udp; w.crypto || (w.crypto = { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } }); },
});
const w = dom.window;
const errors = [];
w.addEventListener('error', (e) => errors.push(e.message));
await sleep(1500);

assert.ok(w.desk && w.desk.native, 'window.desk is the native shell');
const lib = await w.desk.api('getLibrary');
assert.ok(lib.effects.length >= 100 && lib.profiles.length >= 1000);
let r = await w.desk.api('addFixtures', { profileId: 'b-drgb', count: 3, universe: 1, address: 1 });
assert.ok(r.ok, JSON.stringify(r));
await w.desk.api('execute', 'fix 1');
await w.desk.api('execute', '@ 100');
await sleep(500);
assert.ok(sent.length > 3, `expected Art-Net packets, got ${sent.length}`);
const last = sent[sent.length - 1];
assert.strictEqual(last.host, '255.255.255.255'); assert.strictEqual(last.port, 6454);
assert.strictEqual(last.buf.length, 530);
assert.strictEqual(last.buf.toString('ascii', 0, 7), 'Art-Net'); assert.strictEqual(last.buf.readUInt16LE(8), 0x5000);
assert.strictEqual(last.buf[18], 255, 'dimmer of fixture 1 at full');
// the screen drew something
assert.ok(w.document.querySelectorAll('.tile').length === 3, 'desk shows 3 fixture tiles');
// effects go out too
await w.desk.api('execute', 'fix 1 thru 3');
await w.desk.api('addEffect', { type: 'campfire', rate: 1 });
await sleep(400);
const vals = new Set(sent.slice(-12).map((p) => p.buf[18]));
assert.ok(vals.size > 1, 'effect changes the output over time');
// settings: destination
await w.desk.api('updateSettings', { artnetDest: '192.168.1.77', artnetFirst: 1 });
await sleep(300);
const l2 = sent[sent.length - 1];
assert.strictEqual(l2.host, '192.168.1.77'); assert.strictEqual(l2.buf.readUInt16LE(14), 1, 'universe offset applied');
// discovery
const nodes = await w.desk.artnetScan();
assert.ok(polled.has('192.168.1.50') && polled.has('192.168.1.255') && polled.has('255.255.255.255'), 'polled broadcast and unicast addresses');
assert.strictEqual(nodes.length, 1); assert.strictEqual(nodes[0].ip, '192.168.1.50'); assert.strictEqual(JSON.stringify(nodes[0].outputs), '[0]');
// output tab
[...w.document.querySelectorAll('#tabs button')].find((b) => b.textContent === 'Output').click();
await sleep(300);
assert.ok(/pauses apps in the background/.test(w.document.querySelector('#view').textContent), 'iPad note on Output tab');
assert.ok(!/Wi-Fi networks/i.test(w.document.querySelector('#view').textContent), 'no Wi-Fi scan card on iPad');
assert.strictEqual(errors.length, 0, 'no page errors: ' + errors.join('; '));
console.log('ipad bundle OK:', sent.length, 'packets,', nodes.length, 'node found');
w.close();
server.close();
process.exit(0);
