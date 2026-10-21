'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  api: (method, ...args) => ipcRenderer.invoke('api', method, args),
  onShow: (cb) => ipcRenderer.on('show', (_e, s) => cb(s)),
  onLive: (cb) => ipcRenderer.on('live', (_e, l) => cb(l)),
});
