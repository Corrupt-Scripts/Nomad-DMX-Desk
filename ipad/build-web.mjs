// Bundles the engine + shell for the iPad app and copies the shared screen (renderer/) into www/.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const www = path.join(here, 'www');
const renderer = path.join(here, '..', 'renderer');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src', 'shell.js')],
  outfile: path.join(www, 'shell.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari15'],
  alias: { dgram: path.join(here, 'src', 'dgram-shim.js'), crypto: path.join(here, 'src', 'crypto-shim.js') },
  inject: [path.join(here, 'src', 'buffer-inject.js')],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  minify: true,
  logLevel: 'warning',
});

for (const f of ['style.css', 'app.js', 'astera.js', 'ble.js']) fs.copyFileSync(path.join(renderer, f), path.join(www, f));
let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
if (!html.includes('<script src="remote-shim.js"></script>')) throw new Error('index.html changed: cannot swap the shim for the shell');
html = html.replace('<script src="remote-shim.js"></script>', '<script src="shell.js"></script>');
fs.writeFileSync(path.join(www, 'index.html'), html);
fs.copyFileSync(path.join(here, 'icon-1024.png'), path.join(www, 'icon.png'));
console.log('web bundle ready:', fs.statSync(path.join(www, 'shell.js')).size, 'bytes');
