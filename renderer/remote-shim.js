// When this page is opened in a normal browser (iPad Safari, phone) instead of inside the desktop app,
// there is no preload bridge. This stands in for it and talks to the desk over the network.
(() => {
  'use strict';
  if (window.desk) return;
  const showCbs = []; const liveCbs = [];
  async function post(method, args) {
    const r = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) });
    if (r.status === 401) { location.reload(); return { ok: false, message: 'Signed out' }; }
    return r.json();
  }
  const off = async () => ({ ok: false, message: 'Set this up on the computer running the desk.' });
  window.desk = {
    remote: true,
    api: (method, ...args) => post(method, args),
    onShow: (cb) => showCbs.push(cb),
    onLive: (cb) => liveCbs.push(cb),
    artnetScan: async () => [], wifiScan: off, wifiConnect: off, wifiSettings: async () => {}, bleSelect: () => {}, onBleDevices: () => {},
    remoteInfo: async () => null, remoteSet: off,
  };
  function connect() {
    const es = new EventSource('/events');
    es.addEventListener('show', (e) => showCbs.forEach((cb) => cb(JSON.parse(e.data))));
    es.addEventListener('live', (e) => liveCbs.forEach((cb) => cb(JSON.parse(e.data))));
    es.onerror = () => { es.close(); setTimeout(connect, 1500); };
  }
  connect();
})();
