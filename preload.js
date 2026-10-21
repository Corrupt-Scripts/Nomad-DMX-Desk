'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  api: (method, ...args) => ipcRenderer.invoke('api', method, args),
  onShow: (cb) => ipcRenderer.on('show', (_e, s) => cb(s)),
  artnetScan: () => ipcRenderer.invoke('discover:artnet'),
  wifiScan: () => ipcRenderer.invoke('discover:wifi'),
  wifiConnect: (ssid, password) => ipcRenderer.invoke('wifi:connect', ssid, password),
  wifiSettings: () => ipcRenderer.invoke('wifi:settings'),
  bleSelect: (id) => ipcRenderer.send('ble:select', id),
  onBleDevices: (cb) => ipcRenderer.on('ble:devices', (_e, list) => cb(list)),
  remoteInfo: () => ipcRenderer.invoke('remote:info'),
  remoteSet: (o) => ipcRenderer.invoke('remote:set', o),
  onLive: (cb) => ipcRenderer.on('live', (_e, l) => cb(l)),
});
