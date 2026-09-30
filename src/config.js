'use strict';

const path = require('path');

let APP_DIR = path.join(__dirname, '..');
if (__dirname.includes('app.asar')) {
  APP_DIR = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}

require('dotenv').config({ path: path.join(APP_DIR, '.env') });

let xeroxRoot = process.env.XEROX_ROOT || 'C:\\Xerox';

const AUTH_DIR = path.join(APP_DIR, 'auth');

function getXeroxRoot() {
  return xeroxRoot;
}

function setXeroxRoot(newPath) {
  if (newPath && typeof newPath === 'string') {
    xeroxRoot = newPath.trim();
    try {
      const fs = require('fs');
      fs.writeFileSync(path.join(APP_DIR, '.env'), `XEROX_ROOT=${xeroxRoot}\n`, 'utf8');
    } catch (err) {
      console.error('[CONFIG] Could not update .env:', err.message);
    }
  }
  return xeroxRoot;
}

function getArchiveDir() {
  return path.join(xeroxRoot, 'Archive');
}

/**
 * Get today's date string in YYYY-MM-DD format using local time.
 * @returns {string}
 */
function getTodayDate() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Get the full path to today's folder (directly under XEROX_ROOT).
 * @returns {string}
 */
function getTodayDir() {
  return path.join(xeroxRoot, getTodayDate());
}

/**
 * Get current local time formatted as HH:MM:SS.
 * @returns {string}
 */
function getTimeStamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Get current local datetime formatted as YYYY-MM-DD HH:MM:SS.
 * @returns {string}
 */
function getDateTimeStamp() {
  return `${getTodayDate()} ${getTimeStamp()}`;
}

module.exports = {
  APP_DIR,
  AUTH_DIR,
  getXeroxRoot,
  setXeroxRoot,
  getArchiveDir,
  getTodayDate,
  getTodayDir,
  getTimeStamp,
  getDateTimeStamp,
};

Object.defineProperty(module.exports, 'XEROX_ROOT', {
  get: () => xeroxRoot,
  enumerable: true,
  configurable: true,
});

Object.defineProperty(module.exports, 'ARCHIVE_DIR', {
  get: () => path.join(xeroxRoot, 'Archive'),
  enumerable: true,
  configurable: true,
});
