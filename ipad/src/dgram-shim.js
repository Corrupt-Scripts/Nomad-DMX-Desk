'use strict';
// A stand-in for Node's dgram that hands packets to the native UDP plugin.
// Packets queued in the same moment (one per universe per frame) go over the bridge as one batch.
const udp = require('./udp');

let queue = [];
let scheduled = false;
let inFlight = false;

function flush() {
  scheduled = false;
  if (inFlight) { if (queue.length > 256) queue = queue.slice(-128); schedule(); return; }
  const batch = queue; queue = [];
  if (!batch.length) return;
  inFlight = true;
  Promise.resolve(udp.sendBatch({ packets: batch.map((b) => ({ host: b.host, port: b.port, data: b.data })) }))
    .then(() => batch.forEach((b) => b.cb && b.cb()),
      (e) => batch.forEach((b) => b.cb && b.cb(new Error((e && e.message) || String(e)))))
    .then(() => { inFlight = false; });
}
function schedule() { if (!scheduled) { scheduled = true; setTimeout(flush, 0); } }

function createSocket() {
  const handlers = {};
  const sock = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return sock; },
    once(ev, fn) { return sock.on(ev, fn); },
    removeAllListeners() { for (const k of Object.keys(handlers)) delete handlers[k]; return sock; },
    bind(port, addr, cb) { const f = typeof addr === 'function' ? addr : cb; if (f) setTimeout(f, 0); return sock; },
    setBroadcast() {}, setMulticastTTL() {}, setMulticastInterface() {},
    send(buf, port, host, cb) {
      queue.push({ host, port, data: Buffer.from(buf).toString('base64'), cb });
      schedule();
    },
    close() {},
  };
  return sock;
}

module.exports = { createSocket };
