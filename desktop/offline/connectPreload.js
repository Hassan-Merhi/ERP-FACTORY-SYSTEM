const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('offlinePc', {
  connect: (username, password) => ipcRenderer.invoke('offline-pc:connect', { username, password }),
});
