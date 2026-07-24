const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  getUpdaterState: () => ipcRenderer.invoke('updater:get-state'),
  installUpdateNow: () => ipcRenderer.invoke('updater:install-now'),
  openMacDownload: () => ipcRenderer.invoke('updater:open-mac-download'),
  onUpdaterChecking: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:checking', listener);
    return () => ipcRenderer.removeListener('updater:checking', listener);
  },
  onUpdaterBlocked: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:blocked', listener);
    return () => ipcRenderer.removeListener('updater:blocked', listener);
  },
  onUpdaterAvailable: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:available', listener);
    return () => ipcRenderer.removeListener('updater:available', listener);
  },
  onUpdaterDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:download-progress', listener);
    return () => ipcRenderer.removeListener('updater:download-progress', listener);
  },
  onUpdaterReady: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:ready', listener);
    return () => ipcRenderer.removeListener('updater:ready', listener);
  },
  onUpdaterError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:error', listener);
    return () => ipcRenderer.removeListener('updater:error', listener);
  },
  onUpdaterNotAvailable: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:not-available', listener);
    return () => ipcRenderer.removeListener('updater:not-available', listener);
  },
});
