'use strict';
// Lets an iPad, phone or any browser on the same Wi-Fi drive the desk. The computer keeps doing the DMX output;
// the browser just shows the same screen and sends the same commands. Protected by a PIN.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
// Things a remote screen may not do: change where the DMX goes, or touch the computer.
const REMOTE_BLOCKED = new Set(['updateSettings', 'swapProtocols']);

const loginPage = (msg) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nomad DMX Desk</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e0b14;color:#e9e4f5;font:16px system-ui,sans-serif}
form{background:#17131f;border:1px solid #2d2640;border-radius:12px;padding:24px;width:min(320px,90vw);display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:14px;letter-spacing:.12em}h1 span{color:#a78bfa}input{font:inherit;font-size:22px;letter-spacing:.3em;text-align:center;padding:10px;border-radius:8px;border:1px solid #2d2640;background:#120f19;color:inherit}
button{font:inherit;padding:10px;border-radius:8px;border:0;background:#8b5cf6;color:#fff;font-weight:600}p{margin:0;color:#f87171;font-size:13px;min-height:16px}</style></head>
<body><form method="post" action="/login"><h1>NOMAD <span>DMX DESK</span></h1><input name="pin" inputmode="numeric" autocomplete="off" placeholder="PIN" autofocus><p>${msg || ''}</p><button>Connect</button></form></body></html>`;

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const a of ifs[name] || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function createRemote({ engine, allowed, rendererDir }) {
  let server = null;
  let pin = '';
  let port = 0;
  const tokens = new Set();
  const streams = new Set();
  let lastFail = 0;

  const cookieOf = (req) => { const m = /(?:^|;\s*)nd=([a-f0-9]+)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
  const authed = (req) => tokens.has(cookieOf(req));

  function body(req, limit) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'POST' && url.pathname === '/login') {
        const form = new URLSearchParams(await body(req, 2000));
        const wait = Math.max(0, 1000 - (Date.now() - lastFail));
        if (wait) await new Promise((r) => setTimeout(r, wait)); // slow down guessing
        if (pin && safeEqual(form.get('pin') || '', pin)) {
          const t = crypto.randomBytes(24).toString('hex');
          tokens.add(t);
          res.writeHead(303, { 'Set-Cookie': `nd=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`, Location: '/' });
          return res.end();
        }
        lastFail = Date.now();
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage('Wrong PIN'));
      }
      if (!authed(req)) {
        res.writeHead(url.pathname === '/' ? 200 : 401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage(''));
      }
      if (req.method === 'POST' && url.pathname === '/api') {
        const msg = JSON.parse(await body(req, 2 * 1024 * 1024));
        const method = msg && msg.method; const args = Array.isArray(msg && msg.args) ? msg.args : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!allowed.has(method) || REMOTE_BLOCKED.has(method)) return res.end(JSON.stringify({ ok: false, message: 'Not allowed from a remote screen' }));
        let out;
        if (method === 'getShow') out = engine.getShow();
        else if (method === 'getLibrary') out = engine.getLibrary();
        else if (method === 'execute') out = engine.execute(...args);
        else { try { out = { ok: true, result: engine[method](...args) }; } catch (e) { out = { ok: false, message: e.message }; } }
        return res.end(JSON.stringify(out === undefined ? null : out));
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: show\ndata: ${JSON.stringify(engine.getShow())}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return undefined;
      }
      if (req.method === 'GET') {
        let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        const file = path.normalize(path.join(rendererDir, rel));
        if (!file.startsWith(rendererDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(file));
      }
      res.writeHead(405); return res.end();
    } catch (e) {
      try { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: e.message })); } catch (x) { /* ignore */ }
      return undefined;
    }
  }

  const send = (event, data) => {
    if (!streams.size) return;
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) { try { s.write(chunk); } catch (e) { streams.delete(s); } }
  };

  return {
    get running() { return !!server; },
    info() { return { running: !!server, port, pin, addresses: lanAddresses(), clients: streams.size }; },
    start(opts) {
      return new Promise((resolve) => {
        this.stop();
        pin = String(opts.pin);
        port = opts.port;
        tokens.clear();
        const s = http.createServer((req, res) => { handle(req, res); });
        s.once('error', (e) => { server = null; resolve({ ok: false, message: e.code === 'EADDRINUSE' ? `Port ${port} is already in use` : e.message }); });
        s.listen(port, '0.0.0.0', () => { server = s; resolve({ ok: true }); });
      });
    },
    stop() {
      for (const s of streams) { try { s.end(); } catch (e) { /* ignore */ } }
      streams.clear();
      if (server) { try { server.close(); } catch (e) { /* ignore */ } server = null; }
    },
    sendShow: (show) => send('show', show),
    sendLive: (live) => send('live', live),
    get clients() { return streams.size; },
  };
}

module.exports = { createRemote, lanAddresses };
