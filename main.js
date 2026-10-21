'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine/engine');
const discovery = require('./engine/discovery');
const { createRemote } = require('./engine/remote');
const crypto = require('crypto');

const engine = new Engine();
let win = null;
let showTimer = null;
let saveTimer = null;
let filePath = null; // current show file, if any
let bleCallback = null; // pending Bluetooth chooser callback

let remote = null;
const remoteCfgPath = () => path.join(app.getPath('userData'), 'remote.json');
let remoteCfg = { enabled: false, pin: '', port: 8090 };
const loadRemoteCfg = () => {
  try { Object.assign(remoteCfg, JSON.parse(fs.readFileSync(remoteCfgPath(), 'utf8'))); } catch (e) { /* defaults */ }
  if (!/^\d{6}$/.test(String(remoteCfg.pin))) remoteCfg.pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  remoteCfg.port = Math.min(65535, Math.max(1024, parseInt(remoteCfg.port, 10) || 8090));
};
const saveRemoteCfg = () => { try { fs.writeFileSync(remoteCfgPath(), JSON.stringify(remoteCfg)); } catch (e) { /* ignore */ } };
const autosavePath = () => path.join(app.getPath('userData'), 'autosave.nomaddmx');

const { ALLOWED } = require('./engine/api');

remote = createRemote({ engine, allowed: ALLOWED, rendererDir: path.join(__dirname, 'renderer') });

function sendShow() {
  showTimer = null;
  const snap = engine.getShow();
  remote.sendShow(snap);
  if (win && !win.isDestroyed()) win.webContents.send('show', snap);
  if (win && !win.isDestroyed()) win.setTitle(`${engine.showName} – Nomad DMX Desk`);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(autosavePath(), JSON.stringify(engine.serialize())); } catch (e) { /* ignore */ }
  }, 1000);
}

engine.onChange = () => {
  if (!showTimer) showTimer = setTimeout(sendShow, 20); // coalesce bursts
  scheduleSave();
};

ipcMain.handle('api', (_e, method, args) => {
  if (!ALLOWED.has(method)) throw new Error(`Unknown method ${method}`);
  if (method === 'execute') return engine.execute(...args);
  if (method === 'getShow') return engine.getShow();
  if (method === 'getLibrary') return engine.getLibrary();
  try {
    return { ok: true, result: engine[method](...(args || [])) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

// ---- discovery: find nodes / Wi-Fi / Bluetooth devices so nobody types IP addresses
ipcMain.handle('discover:artnet', () => discovery.artnetScan({ port: engine.settings.artnetPort }));
ipcMain.handle('discover:wifi', () => discovery.wifiScan());
ipcMain.handle('wifi:connect', (_e, ssid, password) => discovery.wifiConnect(ssid, password || ''));
ipcMain.handle('wifi:settings', () => {
  const url = process.platform === 'win32' ? 'ms-settings:network-wifi' : process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.wifi-settings-extension' : null;
  if (url) shell.openExternal(url);
});
ipcMain.handle('remote:info', () => Object.assign(remote.info(), { enabled: remoteCfg.enabled, pin: remoteCfg.pin, port: remoteCfg.port }));
ipcMain.handle('remote:set', async (_e, o) => {
  o = o || {};
  if (o.newPin) remoteCfg.pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  if (o.port != null) remoteCfg.port = Math.min(65535, Math.max(1024, parseInt(o.port, 10) || 8090));
  if (o.enabled != null) remoteCfg.enabled = !!o.enabled;
  saveRemoteCfg();
  if (remoteCfg.enabled) { const r = await remote.start({ pin: remoteCfg.pin, port: remoteCfg.port }); if (!r.ok) { remoteCfg.enabled = false; saveRemoteCfg(); } return r; }
  remote.stop();
  return { ok: true };
});
ipcMain.on('ble:select', (_e, id) => {
  if (!bleCallback) return;
  const cb = bleCallback;
  bleCallback = null;
  cb(typeof id === 'string' ? id : '');
});

async function openShow() {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Nomad DMX show', extensions: ['nomaddmx', 'json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return;
  try {
    engine.load(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
    filePath = r.filePaths[0];
    engine.showName = path.basename(filePath).replace(/\.(nomaddmx|json)$/i, '');
    engine.changed();
  } catch (e) {
    dialog.showErrorBox('Could not open show', e.message);
  }
}

async function saveShowAs() {
  const r = await dialog.showSaveDialog(win, { defaultPath: `${engine.showName}.nomaddmx`, filters: [{ name: 'Nomad DMX show', extensions: ['nomaddmx'] }] });
  if (r.canceled || !r.filePath) return;
  filePath = r.filePath;
  engine.showName = path.basename(filePath).replace(/\.nomaddmx$/i, '');
  writeShow();
  engine.changed();
}

function writeShow() {
  try { fs.writeFileSync(filePath, JSON.stringify(engine.serialize(), null, 2)); } catch (e) { dialog.showErrorBox('Could not save', e.message); }
}

function saveShow() { if (filePath) writeShow(); else saveShowAs(); }

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New show', accelerator: 'CmdOrCtrl+N', click: () => { if (dialog.showMessageBoxSync(win, { type: 'question', buttons: ['New show', 'Cancel'], defaultId: 1, message: 'Start a new show?', detail: 'Unsaved changes in the current show will be lost.' }) === 0) { engine.newShow(); filePath = null; engine.changed(); } } },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: openShow },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: saveShow },
        { label: 'Save as…', accelerator: 'CmdOrCtrl+Shift+S', click: saveShowAs },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 980, minHeight: 640, backgroundColor: '#0e0b14', title: 'Nomad DMX Desk',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', sendShow);
  // Web Bluetooth: the page asks for a device, we hand the live device list to the UI and wait for the user's pick.
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    bleCallback = callback;
    if (win && !win.isDestroyed()) win.webContents.send('ble:devices', devices.map((d) => ({ id: d.deviceId, name: d.deviceName || '' })));
  });
  win.on('closed', () => { win = null; });
}

let liveTimer = null;
app.whenReady().then(() => {
  try {
    if (fs.existsSync(autosavePath())) engine.load(JSON.parse(fs.readFileSync(autosavePath(), 'utf8')));
  } catch (e) { engine.newShow(); }
  buildMenu();
  createWindow();
  engine.start();
  // Push live levels to the UI at ~15 Hz (independent of the DMX rate)
  loadRemoteCfg();
  if (remoteCfg.enabled) remote.start({ pin: remoteCfg.pin, port: remoteCfg.port }).then((r) => { if (!r.ok) { remoteCfg.enabled = false; } });
  liveTimer = setInterval(() => {
    const status = engine.getStatus();
    if (win && !win.isDestroyed()) win.webContents.send('live', { out: engine.lastFrame, status });
    if (remote.clients) remote.sendLive({ out: engine.lastFrame.map((u) => Array.from(u)), status });
  }, 66);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => {
  clearInterval(liveTimer);
  remote.stop();
  try { fs.writeFileSync(autosavePath(), JSON.stringify(engine.serialize())); } catch (e) { /* ignore */ }
  engine.shutdown();
  app.quit();
});
