'use strict';
// Finding things so nobody has to type an IP address:
//   * Art-Net nodes on the current network (ArtPoll / ArtPollReply)
//   * nearby Wi-Fi networks, and joining one (Windows: netsh, macOS: networksetup)
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { artPollPacket, parseArtPollReply } = require('./artpoll');

// --------------------------------------------------------------------- Art-Net
function broadcastTargets() {
  const out = new Set(['255.255.255.255']);
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o | (~mask[i] & 0xff))).join('.'));
    }
  }
  return Array.from(out);
}

// Polls the network and collects replies for timeoutMs.
function artnetScan(opts) {
  const o = Object.assign({ timeoutMs: 1800, port: 6454, listenPort: null, targets: null }, opts);
  if (o.listenPort == null) o.listenPort = o.port;
  return new Promise((resolve) => {
    const nodes = new Map();
    let sock;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { sock.close(); } catch (e) { /* ignore */ }
      resolve(Array.from(nodes.values()).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })));
    };
    const onMessage = (msg, rinfo) => {
      const n = parseArtPollReply(msg, rinfo);
      if (!n) return;
      const prev = nodes.get(n.ip);
      if (prev) { n.outputs = Array.from(new Set(prev.outputs.concat(n.outputs))).sort((a, b) => a - b); }
      nodes.set(n.ip, n);
    };
    const poll = () => {
      const pkt = artPollPacket();
      for (const t of o.targets || broadcastTargets()) sock.send(pkt, o.port, t, () => {});
    };
    const make = (bindPort, cb) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.once('error', (e) => { try { s.close(); } catch (x) { /* ignore */ } cb(e); });
      s.bind(bindPort, () => { s.removeAllListeners('error'); s.on('error', () => {}); cb(null, s); });
    };
    // Replies are normally broadcast to port 6454, so listen there; fall back to any port (unicast replies).
    make(o.listenPort, (e, s) => {
      if (e) return make(0, (e2, s2) => { if (e2) return resolve([]); start(s2); });
      return start(s);
    });
    function start(s) {
      sock = s;
      sock.on('message', onMessage);
      try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
      poll();
      setTimeout(poll, 500);
      setTimeout(finish, o.timeoutMs);
    }
  });
}

// ----------------------------------------------------------------------- Wi-Fi
const run = (cmd, args, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeout || 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) { err.stderr = stderr; err.stdout = stdout; reject(err); } else resolve(stdout);
  });
});

function parseNetsh(text) {
  const nets = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    let m = line.match(/^SSID\s+\d+\s*:\s*(.*)$/);
    if (m) { cur = { ssid: m[1].trim(), security: 'open', signal: 0 }; nets.push(cur); continue; }
    if (!cur) continue;
    m = line.match(/^\s*Authentication\s*:\s*(.+)$/);
    if (m) { cur.security = /open/i.test(m[1]) ? 'open' : 'secured'; cur.auth = m[1].trim(); continue; }
    m = line.match(/^\s*Signal\s*:\s*(\d+)\s*%/);
    if (m) cur.signal = Math.max(cur.signal, parseInt(m[1], 10));
  }
  return nets.filter((n) => n.ssid);
}

function parseMacProfiler(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const ifaces = (data.SPAirPortDataType && data.SPAirPortDataType[0] && data.SPAirPortDataType[0].spairport_airport_interfaces) || [];
  const nets = [];
  let redacted = false;
  const add = (n, current) => {
    const name = n._name || '';
    if (!name || /redacted/i.test(name)) { redacted = true; return; }
    const sec = String(n.spairport_security_mode || '');
    const m = String(n.spairport_signal_noise || '').match(/(-?\d+)\s*dBm/);
    const dbm = m ? parseInt(m[1], 10) : null;
    nets.push({
      ssid: name,
      security: !sec || /none/i.test(sec) ? 'open' : 'secured',
      auth: sec.replace(/spairport_security_mode_/, ''),
      signal: dbm == null ? 0 : Math.max(0, Math.min(100, 2 * (dbm + 100))),
      current: !!current,
    });
  };
  for (const i of ifaces) {
    if (i.spairport_current_network_information) add(i.spairport_current_network_information, true);
    (i.spairport_airport_other_local_wireless_networks || []).forEach((n) => add(n, false));
  }
  const seen = new Set();
  return { networks: nets.filter((n) => (seen.has(n.ssid) ? false : seen.add(n.ssid))), redacted };
}

async function wifiScan() {
  if (process.platform === 'win32') {
    try {
      const out = await run('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], 20000);
      return { ok: true, networks: parseNetsh(out).sort((a, b) => b.signal - a.signal) };
    } catch (e) {
      const msg = `${e.stdout || ''}${e.stderr || ''}${e.message}`;
      return { ok: false, message: /location/i.test(msg) ? 'Windows needs Location turned on to list Wi-Fi networks (Settings → Privacy & security → Location).' : 'Could not scan Wi-Fi. Is there a Wi-Fi adapter and is it switched on?' };
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = await run('system_profiler', ['SPAirPortDataType', '-json'], 30000);
      const r = parseMacProfiler(out);
      r.networks.sort((a, b) => b.signal - a.signal);
      return { ok: true, networks: r.networks, note: r.redacted ? 'macOS is hiding some network names. Use Wi-Fi settings to join those.' : '' };
    } catch (e) {
      return { ok: false, message: 'Could not scan Wi-Fi on this Mac. Use the Wi-Fi menu in the menu bar instead.' };
    }
  }
  return { ok: false, message: 'Wi-Fi scanning is supported on Windows and macOS.' };
}

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function winProfile(ssid, password) {
  const sec = password
    ? `<authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xml(password)}</keyMaterial></sharedKey>`
    : '<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>';
  return `<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${xml(ssid)}</name><SSIDConfig><SSID><name>${xml(ssid)}</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>auto</connectionMode><MSM><security>${sec}</security></MSM></WLANProfile>`;
}

async function wifiConnect(ssid, password) {
  if (!ssid || typeof ssid !== 'string' || ssid.length > 32) return { ok: false, message: 'Bad network name' };
  if (password && (typeof password !== 'string' || password.length < 8 || password.length > 63)) return { ok: false, message: 'A Wi-Fi password is 8–63 characters' };
  if (process.platform === 'win32') {
    const file = path.join(os.tmpdir(), `nomad-wifi-${process.pid}-${Date.now()}.xml`);
    try {
      fs.writeFileSync(file, winProfile(ssid, password || ''), { mode: 0o600 });
      await run('netsh', ['wlan', 'add', 'profile', `filename=${file}`], 15000);
      await run('netsh', ['wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`], 15000);
      return { ok: true, message: `Connecting to ${ssid}…` };
    } catch (e) {
      return { ok: false, message: `Could not join ${ssid}. ${String(e.stdout || e.message).trim().split('\n')[0]}` };
    } finally {
      try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }
  }
  if (process.platform === 'darwin') {
    try {
      const ports = await run('networksetup', ['-listallhardwareports'], 10000);
      const m = ports.match(/Hardware Port:\s*(?:Wi-Fi|AirPort)\s*\nDevice:\s*(\w+)/i);
      if (!m) return { ok: false, message: 'No Wi-Fi adapter found' };
      const out = await run('networksetup', ['-setairportnetwork', m[1], ssid].concat(password ? [password] : []), 30000);
      if (/error|failed|could not/i.test(out)) return { ok: false, message: out.trim().split('\n')[0] };
      return { ok: true, message: `Joined ${ssid}` };
    } catch (e) {
      return { ok: false, message: `Could not join ${ssid}` };
    }
  }
  return { ok: false, message: 'Joining Wi-Fi is supported on Windows and macOS.' };
}

module.exports = { artnetScan, artPollPacket, parseArtPollReply, parseNetsh, parseMacProfiler, wifiScan, wifiConnect, winProfile, broadcastTargets };
