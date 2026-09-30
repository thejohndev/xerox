const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setLocation: (newPath) => ipcRenderer.invoke('set-location', newPath),
  startService: () => ipcRenderer.invoke('start-service'),
  stopService: () => ipcRenderer.invoke('stop-service'),
  getTodayFiles: () => ipcRenderer.invoke('get-today-files'),
  getTodayBatches: () => ipcRenderer.invoke('get-today-batches'),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, status) => callback(status));
  },
  onQrUpdate: (callback) => {
    ipcRenderer.on('qr-update', (_event, qrDataUrl) => callback(qrDataUrl));
  },
  onFileReceived: (callback) => {
    ipcRenderer.on('file-received', (_event, fileInfo) => callback(fileInfo));
  },
});