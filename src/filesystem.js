'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const config = require('./config');
const state = require('./state');
const logger = require('./logger');

// Characters invalid in Windows file/folder names
const INVALID_CHARS = /[\\/:*?"<>|]/g;

/**
 * Sanitize a customer name for use as a folder name.
 * Removes invalid Windows path characters and prevents path traversal.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeName(name) {
  let safe = name.trim();
  // Remove invalid characters
  safe = safe.replace(INVALID_CHARS, '-');
  // Remove path traversal sequences
  safe = safe.replace(/\.\./g, '');
  // Collapse multiple dashes/spaces
  safe = safe.replace(/-{2,}/g, '-');
  safe = safe.replace(/\s{2,}/g, ' ');
  // Trim leading/trailing dashes and dots
  safe = safe.replace(/^[-.\s]+|[-.\s]+$/g, '');
  // Fallback if empty
  if (!safe) safe = 'unnamed';
  // Limit length to avoid path issues (Windows MAX_PATH)
  if (safe.length > 100) safe = safe.substring(0, 100).trim();
  return safe;
}

/**
 * Sanitize a filename for safe Windows storage.
 *
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFilename(filename) {
  let safe = filename.trim();
  // Remove invalid characters but keep dots and spaces
  safe = safe.replace(INVALID_CHARS, '-');
  // Remove path traversal
  safe = safe.replace(/\.\./g, '');
  // Trim leading/trailing dashes and dots (but keep the extension dot)
  const ext = path.extname(safe);
  let base = path.basename(safe, ext);
  base = base.replace(/^[-.\s]+|[-.\s]+$/g, '');
  if (!base) base = 'file';
  if (base.length > 100) base = base.substring(0, 100).trim();
  return base + ext;
}

/**
 * Build the folder name for a customer.
 *
 * @param {string} phone
 * @param {string|null} name - null for unnamed
 * @returns {string}
 */
function buildFolderName(phone, name) {
  if (name) {
    return `${sanitizeName(name)} - ${phone}`;
  }
  return phone;
}

/**
 * Ensure the root directory structure exists.
 * Creates C:\Xerox, Active, Archive, auth if missing.
 */
async function ensureRootStructure() {
  await fs.mkdir(config.XEROX_ROOT, { recursive: true });
  await fs.mkdir(config.ARCHIVE_DIR, { recursive: true });
  await fs.mkdir(config.AUTH_DIR, { recursive: true });
  console.log(`[INIT] Root structure ensured at ${config.XEROX_ROOT}`);
}

/**
 * Ensure today's date folder exists with log.txt and dashboard.txt.
 */
async function ensureTodayFolder() {
  const todayDir = config.getTodayDir();
  await fs.mkdir(todayDir, { recursive: true });

  // Create log.txt if missing
  const logPath = path.join(todayDir, 'log.txt');
  try {
    await fs.access(logPath);
  } catch {
    await fs.writeFile(logPath, '', 'utf8');
  }

  // Create dashboard.txt if missing
  await logger.initDashboard();

  console.log(`[INIT] Today's folder ready: ${todayDir}`);
}

/**
 * Ensure a customer folder exists inside today's directory.
 *
 * @param {string} phone
 * @param {string|null} name
 * @returns {string} the full path to the customer folder
 */
async function ensureCustomerFolder(phone, name) {
  const folderName = buildFolderName(phone, name);
  const folderPath = path.join(config.getTodayDir(), folderName);
  await fs.mkdir(folderPath, { recursive: true });
  return folderPath;
}

/**
 * Rename an unnamed phone-only folder to Name - Phone.
 *
 * @param {string} phone
 * @param {string} name
 * @returns {string} the new folder path
 */
async function renameUnnamedFolder(phone, name) {
  const todayDir = config.getTodayDir();
  const oldPath = path.join(todayDir, phone);
  const newFolderName = buildFolderName(phone, name);
  const newPath = path.join(todayDir, newFolderName);

  try {
    await fs.access(oldPath);
    await fs.rename(oldPath, newPath);
    console.log(`[RENAME] ${phone} → ${newFolderName}`);
    return newPath;
  } catch (err) {
    // If old folder doesn't exist, just create the new one
    console.error(`[RENAME] Could not rename ${phone}: ${err.message}. Creating new folder.`);
    await fs.mkdir(newPath, { recursive: true });
    return newPath;
  }
}

/**
 * Get a unique file path, adding (1), (2), etc. if the file already exists.
 *
 * @param {string} dir - directory path
 * @param {string} filename - desired filename
 * @returns {Promise<string>} full path to a unique file
 */
async function getUniqueFilePath(dir, filename) {
  const safeName = sanitizeFilename(filename);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);

  let candidate = path.join(dir, safeName);
  let counter = 0;

  while (true) {
    try {
      await fs.access(candidate);
      // File exists — try next number
      counter++;
      candidate = path.join(dir, `${base} (${counter})${ext}`);
    } catch {
      // File doesn't exist — this path is available
      return candidate;
    }
  }
}

/**
 * Archive previous days' folders from XEROX_ROOT to Archive.
 * Moves any date folder in XEROX_ROOT whose name doesn't match today's date.
 */
async function archivePreviousDays() {
  const todayDate = config.getTodayDate();

  try {
    const entries = await fs.readdir(config.XEROX_ROOT, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip today's folder
      if (entry.name === todayDate) continue;
      // Only process date-formatted folders (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

      const srcPath = path.join(config.XEROX_ROOT, entry.name);
      const destPath = path.join(config.ARCHIVE_DIR, entry.name);

      try {
        // Update dashboard archive status before moving
        const dashPath = path.join(srcPath, 'dashboard.txt');
        try {
          let dashContent = await fs.readFile(dashPath, 'utf8');
          dashContent = dashContent.replace(/ARCHIVE_STATUS=ACTIVE/, 'ARCHIVE_STATUS=ARCHIVED');
          await fs.writeFile(dashPath, dashContent, 'utf8');
        } catch {
          // Dashboard might not exist — that's fine
        }

        // Log the archive event in the old day's log
        const logPath = path.join(srcPath, 'log.txt');
        try {
          const time = config.getTimeStamp();
          await fs.appendFile(logPath, `[${time}] ARCHIVE_COMPLETED\nMoved to: Archive/${entry.name}\n\n`, 'utf8');
        } catch {
          // Log might not exist
        }

        await fs.rename(srcPath, destPath);
        console.log(`[ARCHIVE] Moved ${entry.name} to Archive`);

        // Log in today's log
        await logger.logEvent('ARCHIVE_COMPLETED', {
          Folder: entry.name,
          To: 'Archive',
        });
      } catch (err) {
        console.error(`[ARCHIVE ERROR] Could not move ${entry.name}: ${err.message}`);
        await logger.logEvent('ARCHIVE_FAILED', {
          Folder: entry.name,
          Error: err.message,
        });
      }
    }
  } catch (err) {
    // Active dir might not exist yet on first run
    console.log(`[ARCHIVE] No previous folders to archive (${err.message})`);
  }
}

/**
 * Scan today's folder and rebuild in-memory state from existing customer folders.
 * Called on startup for crash recovery.
 */
async function recoverState() {
  const todayDir = config.getTodayDir();

  // Try to restore counters from dashboard.txt
  const savedCounters = await logger.parseDashboard();
  if (savedCounters) {
    for (const [key, value] of Object.entries(savedCounters)) {
      state.setCounter(key, value);
    }
    console.log('[RECOVERY] Restored counters from dashboard.txt');
  }

  try {
    const entries = await fs.readdir(todayDir, { withFileTypes: true });
    let batchCount = 0;
    const phonesSeen = new Set();
    // Track creation times locally to determine which batch is latest per phone
    const phoneTimes = new Map();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const folderName = entry.name;

      // Parse folder name: either "Name - Phone" or just "Phone"
      const dashMatch = folderName.match(/^(.+)\s-\s(\d+)$/);

      let phone, name;
      if (dashMatch) {
        name = dashMatch[1];
        phone = dashMatch[2];
      } else if (/^\d+$/.test(folderName)) {
        // Unnamed folder — just phone number
        phone = folderName;
        name = null;
      } else {
        // Unknown folder format — skip
        continue;
      }

      phonesSeen.add(phone);
      batchCount++;

      // Get folder creation time to determine which is the latest batch
      const folderPath = path.join(todayDir, folderName);
      const stats = await fs.stat(folderPath);

      const prevTime = phoneTimes.get(phone) || 0;
      if (stats.birthtimeMs > prevTime) {
        state.setBatch(phone, name);
        phoneTimes.set(phone, stats.birthtimeMs);
      }
    }

    // Update counters based on actual folder scan
    state.setCounter('totalBatches', batchCount);
    state.setCounter('totalCustomers', phonesSeen.size);

    // Count files in customer folders if we don't have dashboard data
    if (!savedCounters || savedCounters.totalFilesReceived === 0) {
      let fileCount = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folderPath = path.join(todayDir, entry.name);
        try {
          const files = await fs.readdir(folderPath);
          fileCount += files.length;
        } catch {
          // Skip unreadable folders
        }
      }
      if (fileCount > 0) {
        state.setCounter('totalFilesReceived', fileCount);
        state.setCounter('whatsappFilesReceived', fileCount);
      }
    }

    console.log(`[RECOVERY] Rebuilt state: ${batchCount} batches, ${phonesSeen.size} customers`);
  } catch (err) {
    console.log(`[RECOVERY] No existing folders to recover (${err.message})`);
  }
}

/**
 * Check if the date has rolled over. If so, archive and create new day.
 * Returns true if a new day was created.
 *
 * @param {string} lastKnownDate - the date we were last operating under
 * @returns {Promise<boolean>}
 */
async function checkDateRollover(lastKnownDate) {
  const today = config.getTodayDate();
  if (today === lastKnownDate) return false;

  console.log(`[DATE ROLLOVER] ${lastKnownDate} → ${today}`);
  await archivePreviousDays();
  await ensureTodayFolder();
  state.resetState();

  await logger.logEvent('NEW_DAY_STARTED', { Date: today });

  return true;
}

/**
 * Read all customer files in today's folder to display in the UI.
 * @returns {Promise<Array<{name: string, folder: string, size: number, time: string}>>}
 */
async function getTodayFiles() {
  const todayDir = config.getTodayDir();
  const results = [];
  try {
    const entries = await fs.readdir(todayDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderName = entry.name;
      const folderPath = path.join(todayDir, folderName);
      try {
        const files = await fs.readdir(folderPath);
        for (const file of files) {
          const filePath = path.join(folderPath, file);
          const stats = await fs.stat(filePath);
          const time = stats.mtime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          results.push({
            name: file,
            folder: folderName,
            size: stats.size,
            time: time,
            mtimeMs: stats.mtimeMs,
          });
        }
      } catch (err) {}
    }
  } catch (err) {}

  // Sort newest first
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

/**
 * Read all customer batches and their files in today's folder.
 * Returns a tree structure: Batch (Name + Phone) -> Files
 * @returns {Promise<Array<{folderName: string, folderPath: string, customerName: string, phone: string, mtimeMs: number, files: Array<{name: string, fullPath: string, size: number, time: string, ext: string}>}>>}
 */
async function getTodayBatches() {
  const todayDir = config.getTodayDir();
  const batches = [];
  try {
    const entries = await fs.readdir(todayDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderName = entry.name;
      const folderPath = path.join(todayDir, folderName);

      // Parse folder name: "Name - Phone" or just "Phone"
      const dashMatch = folderName.match(/^(.+)\s-\s(\d+)$/);
      let customerName, phone;
      if (dashMatch) {
        customerName = dashMatch[1];
        phone = dashMatch[2];
      } else if (/^\d+$/.test(folderName)) {
        customerName = 'Unnamed';
        phone = folderName;
      } else {
        customerName = folderName;
        phone = '';
      }

      let folderStats = { mtimeMs: 0 };
      try {
        folderStats = await fs.stat(folderPath);
      } catch (e) {}

      const files = [];
      try {
        const fileNames = await fs.readdir(folderPath);
        for (const file of fileNames) {
          const filePath = path.join(folderPath, file);
          try {
            const stats = await fs.stat(filePath);
            if (stats.isFile()) {
              files.push({
                name: file,
                fullPath: filePath,
                size: stats.size,
                ext: path.extname(file).toLowerCase(),
                time: stats.mtime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                mtimeMs: stats.mtimeMs,
              });
            }
          } catch (e) {}
        }
      } catch (e) {}

      // Sort files newest first
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);

      batches.push({
        folderName,
        folderPath,
        customerName,
        phone,
        mtimeMs: folderStats.mtimeMs,
        files,
      });
    }
  } catch (err) {}

  // Sort batches newest first
  batches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return batches;
}

module.exports = {
  sanitizeName,
  sanitizeFilename,
  buildFolderName,
  ensureRootStructure,
  ensureTodayFolder,
  ensureCustomerFolder,
  renameUnnamedFolder,
  getUniqueFilePath,
  archivePreviousDays,
  recoverState,
  checkDateRollover,
  getTodayFiles,
  getTodayBatches,
};
