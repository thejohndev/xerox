const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printAPI', {
  // Get the batch data (files list) passed to this window
  getBatchData: () => ipcRenderer.invoke('print-get-batch-data'),

  // Read an image file as base64 data URL
  readFileBase64: (filePath) => ipcRenderer.invoke('print-read-file-base64', filePath),

  // Trigger native Electron print dialog
  triggerPrint: (options) => ipcRenderer.invoke('print-trigger-print', options),

  // Close this print window
  closeWindow: () => ipcRenderer.invoke('print-close-window'),

  // Open and print a PDF file
  printPdf: (pdfInfo) => ipcRenderer.invoke('print-pdf', pdfInfo),
});
