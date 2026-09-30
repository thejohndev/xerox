const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');

const config = require('./src/config');
const filesystem = require('./src/filesystem');
const logger = require('./src/logger');
const state = require('./src/state');
const whatsapp = require('./src/whatsapp');

let mainWindow = null;

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
    await filesystem.archivePreviousDays();
    await filesystem.ensureTodayFolder();
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

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  try {
    await whatsapp.stopWhatsApp();
  } catch (e) {}
  if (process.platform !== 'darwin') {
    app.quit();
  }
});