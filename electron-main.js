const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');

const config = require('./src/config');
const filesystem = require('./src/filesystem');
const logger = require('./src/logger');
const state = require('./src/state');
const whatsapp = require('./src/whatsapp');

let mainWindow = null;
let printWindow = null;
let printBatchData = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 720,
    minWidth: 750,
    minHeight: 550,
    title: 'Xerox WhatsApp File Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Forward WhatsApp events to Renderer UI
whatsapp.whatsappEvents.on('status', (status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', status);
  }
});

whatsapp.whatsappEvents.on('qr', (dataUrl) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('qr-update', dataUrl);
  }
});

whatsapp.whatsappEvents.on('file', (fileInfo) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('file-received', fileInfo);
  }
});

// IPC: Select Folder
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: config.getXeroxRoot(),
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  const selected = result.filePaths[0];
  config.setXeroxRoot(selected);
  return selected;
});

// IPC: Get Current Config & State
ipcMain.handle('get-config', async () => {
  return {
    xeroxRoot: config.getXeroxRoot(),
    todayDir: config.getTodayDir(),
    isRunning: whatsapp.isWhatsAppRunning(),
  };
});

// IPC: Set Location Manually
ipcMain.handle('set-location', async (event, newPath) => {
  if (newPath) {
    config.setXeroxRoot(newPath);
  }
  return config.getXeroxRoot();
});

// IPC: Start WhatsApp
ipcMain.handle('start-service', async () => {
  try {
    await filesystem.ensureRootStructure();
    await filesystem.ensureTodayFolder();
    await filesystem.archivePreviousDays();
    await filesystem.recoverState();

    await logger.logEvent('APPLICATION_STARTED', {
      Mode: 'Electron UI',
      Date: config.getTodayDate(),
    });

    await whatsapp.startWhatsApp();
    return { success: true };
  } catch (err) {
    console.error('[ELECTRON] Start error:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Stop WhatsApp
ipcMain.handle('stop-service', async () => {
  try {
    await whatsapp.stopWhatsApp();
    return { success: true };
  } catch (err) {
    console.error('[ELECTRON] Stop error:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Reset WhatsApp Session (Logout & Fresh QR Scan)
ipcMain.handle('reset-service', async () => {
  try {
    await whatsapp.resetSession();
    return { success: true };
  } catch (err) {
    console.error('[ELECTRON] Reset error:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Get Today's Files
ipcMain.handle('get-today-files', async () => {
  try {
    const files = await filesystem.getTodayFiles();
    return files;
  } catch (err) {
    return [];
  }
});

// IPC: Get Today's Batches (Tree Structure: Customer -> Files)
ipcMain.handle('get-today-batches', async () => {
  try {
    const batches = await filesystem.getTodayBatches();
    return batches;
  } catch (err) {
    console.error('[ELECTRON] Error fetching batches:', err);
    return [];
  }
});

// IPC: Open a specific file with Windows default application
ipcMain.handle('open-file', async (event, filePath) => {
  if (filePath) {
    const errorMsg = await shell.openPath(filePath);
    if (errorMsg) {
      console.error('[ELECTRON] Failed to open file:', errorMsg);
      return { success: false, error: errorMsg };
    }
    return { success: true };
  }
  return { success: false, error: 'No file path provided' };
});

// IPC: Open Folder in Explorer
ipcMain.handle('open-folder', async (event, folderPath) => {
  const dir = folderPath || config.getTodayDir();
  try {
    const fs = require('fs/promises');
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {}
  await shell.openPath(dir);
  return true;
});

// ═══════════════════════════════════════════════════
// PRINT FEATURE
// ═══════════════════════════════════════════════════

// IPC: Open Print Preview Window
ipcMain.handle('open-print-window', async (event, batchData) => {
  printBatchData = batchData;

  if (printWindow && !printWindow.isDestroyed()) {
    printWindow.focus();
    printWindow.webContents.send('print-batch-updated');
    return { success: true };
  }

  printWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: `Print - ${batchData.customerName || 'Customer'} - ${batchData.phone || ''}`,
    autoHideMenuBar: true,
    parent: mainWindow,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'print-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  printWindow.loadFile(path.join(__dirname, 'print.html'));

  printWindow.on('closed', () => {
    printWindow = null;
    printBatchData = null;
  });

  return { success: true };
});

// IPC: Get batch data for print window
ipcMain.handle('print-get-batch-data', async () => {
  return printBatchData;
});

// IPC: Read file as base64 for rendering in print preview
ipcMain.handle('print-read-file-base64', async (event, filePath) => {
  try {
    const fs = require('fs/promises');
    const ext = path.extname(filePath).toLowerCase();
    const data = await fs.readFile(filePath);
    const base64 = data.toString('base64');

    let mime = 'application/octet-stream';
    if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
    else if (ext === '.png') mime = 'image/png';
    else if (ext === '.webp') mime = 'image/webp';
    else if (ext === '.gif') mime = 'image/gif';
    else if (ext === '.bmp') mime = 'image/bmp';
    else if (ext === '.pdf') mime = 'application/pdf';

    return { success: true, dataUrl: `data:${mime};base64,${base64}`, mime, ext };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: Trigger native print from print window
ipcMain.handle('print-trigger-print', async (event, options) => {
  if (!printWindow || printWindow.isDestroyed()) {
    return { success: false, error: 'Print window not found' };
  }

  const paperSizesMicrons = {
    'A4': { width: 210000, height: 297000 },
    'Legal': { width: 215900, height: 355600 },
    'Letter': { width: 215900, height: 279400 },
    'A3': { width: 297000, height: 420000 },
    'A5': { width: 148000, height: 210000 },
  };

  const selectedSize = options?.paperSize || 'A4';
  const paperSizeValue = paperSizesMicrons[selectedSize] || selectedSize;

  return new Promise((resolve) => {
    printWindow.webContents.print(
      {
        silent: false,
        printBackground: true,
        landscape: options?.landscape || false,
        paperSize: paperSizeValue,
        margins: { marginType: 'none' },
      },
      (success, failureReason) => {
        resolve({
          success,
          error: success ? null : failureReason,
        });
      }
    );
  });
});

// IPC: Close print window
ipcMain.handle('print-close-window', async () => {
  if (printWindow && !printWindow.isDestroyed()) {
    printWindow.close();
  }
  return true;
});

// IPC: Open and Print PDF file
ipcMain.handle('print-pdf', async (event, pdfInfo) => {
  const filePath = typeof pdfInfo === 'string' ? pdfInfo : pdfInfo?.filePath;
  if (!filePath) {
    return { success: false, error: 'No PDF file path provided' };
  }

  const fileName = path.basename(filePath);
  const fileUrl = require('url').pathToFileURL(filePath).href;

  const pdfWindow = new BrowserWindow({
    width: 1050,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    title: `Print PDF - ${fileName}`,
    autoHideMenuBar: true,
    parent: mainWindow,
    modal: false,
    webPreferences: {
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  pdfWindow.loadURL(fileUrl);
  return { success: true };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  try {
    await whatsapp.stopWhatsApp();
  } catch (e) {}
  if (process.platform !== 'darwin') {
    app.quit();
  }
});