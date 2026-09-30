'use strict';

const fs = require('fs/promises');
const path = require('path');
const config = require('./config');

/**
 * Append a formatted event block to today's log.txt.
 *
 * @param {string} eventType - e.g. 'WHATSAPP_CONNECTED', 'FILE_RECEIVED'
 * @param {object} [details] - key-value pairs to log under the event
 */
async function logEvent(eventType, details = {}) {
  const todayDir = config.getTodayDir();
  const logPath = path.join(todayDir, 'log.txt');
  const time = config.getTimeStamp();

  let block = `[${time}] ${eventType}\n`;
  for (const [key, value] of Object.entries(details)) {
    block += `${key}: ${value}\n`;
  }
  block += '\n';

  try {
    await fs.appendFile(logPath, block, 'utf8');
  } catch (err) {
    // If the directory/file doesn't exist yet, log to console as fallback
    console.error(`[LOG ERROR] Could not write to log.txt: ${err.message}`);
    console.error(`  Event: ${eventType}`, details);
  }
}

/**
 * Write (overwrite) today's dashboard.txt with current counter values.
 *
 * @param {object} counters - from state.getCounters()
 */
async function updateDashboard(counters) {
  const todayDir = config.getTodayDir();
  const dashPath = path.join(todayDir, 'dashboard.txt');
  const todayDate = config.getTodayDate();
  const lastUpdated = config.getDateTimeStamp();

  const content = [
    `DATE=${todayDate}`,
    '',
    `TOTAL_BATCHES=${counters.totalBatches}`,
    `TOTAL_CUSTOMERS=${counters.totalCustomers}`,
    `TOTAL_FILES_RECEIVED=${counters.totalFilesReceived}`,
    '',
    `TOTAL_FILES_PRINTED=${counters.totalFilesPrinted}`,
    `TOTAL_PRINT_JOBS=${counters.totalPrintJobs}`,
    `TOTAL_PAGES_PRINTED=${counters.totalPagesPrinted}`,
    '',
    `TOTAL_AMOUNT=${counters.totalAmount}`,
    `CASH_AMOUNT=${counters.cashAmount}`,
    `UPI_AMOUNT=${counters.upiAmount}`,
    '',
    `WHATSAPP_MESSAGES_RECEIVED=${counters.whatsappMessagesReceived}`,
    `WHATSAPP_FILES_RECEIVED=${counters.whatsappFilesReceived}`,
    '',
    `ARCHIVE_STATUS=ACTIVE`,
    '',
    `LAST_UPDATED=${lastUpdated}`,
    '',
  ].join('\n');

  try {
    await fs.writeFile(dashPath, content, 'utf8');
  } catch (err) {
    console.error(`[DASHBOARD ERROR] Could not write dashboard.txt: ${err.message}`);
  }
}

/**
 * Initialize dashboard.txt with zero values if it doesn't already exist.
 */
async function initDashboard() {
  const todayDir = config.getTodayDir();
  const dashPath = path.join(todayDir, 'dashboard.txt');

  try {
    await fs.access(dashPath);
    // File already exists — don't overwrite
  } catch {
    // File doesn't exist — create with zeroes
    const defaultCounters = {
      totalBatches: 0,
      totalCustomers: 0,
      totalFilesReceived: 0,
      totalFilesPrinted: 0,
      totalPrintJobs: 0,
      totalPagesPrinted: 0,
      totalAmount: 0,
      cashAmount: 0,
      upiAmount: 0,
      whatsappMessagesReceived: 0,
      whatsappFilesReceived: 0,
    };
    await updateDashboard(defaultCounters);
  }
}

/**
 * Parse an existing dashboard.txt and return counters object.
 * Used during recovery to restore counter state.
 *
 * @returns {object|null} counters object or null if file doesn't exist
 */
async function parseDashboard() {
  const todayDir = config.getTodayDir();
  const dashPath = path.join(todayDir, 'dashboard.txt');

  try {
    const content = await fs.readFile(dashPath, 'utf8');
    const data = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('=')) continue;
      const eqIndex = trimmed.indexOf('=');
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      data[key] = value;
    }

    return {
      totalBatches: parseInt(data.TOTAL_BATCHES, 10) || 0,
      totalCustomers: parseInt(data.TOTAL_CUSTOMERS, 10) || 0,
      totalFilesReceived: parseInt(data.TOTAL_FILES_RECEIVED, 10) || 0,
      totalFilesPrinted: parseInt(data.TOTAL_FILES_PRINTED, 10) || 0,
      totalPrintJobs: parseInt(data.TOTAL_PRINT_JOBS, 10) || 0,
      totalPagesPrinted: parseInt(data.TOTAL_PAGES_PRINTED, 10) || 0,
      totalAmount: parseInt(data.TOTAL_AMOUNT, 10) || 0,
      cashAmount: parseInt(data.CASH_AMOUNT, 10) || 0,
      upiAmount: parseInt(data.UPI_AMOUNT, 10) || 0,
      whatsappMessagesReceived: parseInt(data.WHATSAPP_MESSAGES_RECEIVED, 10) || 0,
      whatsappFilesReceived: parseInt(data.WHATSAPP_FILES_RECEIVED, 10) || 0,
    };
  } catch {
    return null;
  }
}

module.exports = {
  logEvent,
  updateDashboard,
  initDashboard,
  parseDashboard,
};
