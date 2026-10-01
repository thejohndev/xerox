'use strict';

const config = require('./src/config');
const filesystem = require('./src/filesystem');
const logger = require('./src/logger');
const state = require('./src/state');
const { startWhatsApp } = require('./src/whatsapp');

/**
 * Main entry point for the Xerox WhatsApp File Management System.
 *
 * Startup sequence:
 * 1. Ensure root directory structure (C:\Xerox\Active, Archive, auth)
 * 2. Archive any previous day folders that are still in Active
 * 3. Create today's date folder with log.txt and dashboard.txt
 * 4. Recover in-memory state from existing folders (crash recovery)
 * 5. Connect to WhatsApp via Baileys
 */
async function main() {
  console.log('========================================');
  console.log('  Xerox WhatsApp File Manager v1.0');
  console.log('========================================');
  console.log(`Root:  ${config.XEROX_ROOT}`);
  console.log(`Date:  ${config.getTodayDate()}`);
  console.log('');

  try {
    // Step 1: Ensure root structure
    await filesystem.ensureRootStructure();

    // Step 2: Create today's folder
    await filesystem.ensureTodayFolder();

    // Step 3: Archive previous days
    await filesystem.archivePreviousDays();

    // Step 4: Recover state from existing folders
    await filesystem.recoverState();

    // Log startup
    await logger.logEvent('APPLICATION_STARTED', {
      Version: '1.0',
      Date: config.getTodayDate(),
    });

    const counters = state.getCounters();
    console.log(`[INIT] Recovered: ${counters.totalBatches} batches, ${counters.totalCustomers} customers, ${counters.totalFilesReceived} files`);
    console.log('');

    // Step 5: Start WhatsApp
    console.log('[WHATSAPP] Connecting...');
    await startWhatsApp();

  } catch (err) {
    console.error(`[FATAL] Startup failed: ${err.message}`);
    console.error(err.stack);

    try {
      await logger.logEvent('APPLICATION_ERROR', {
        Error: err.message,
        Stack: err.stack,
      });
    } catch {
      // Can't log — just exit
    }

    process.exit(1);
  }
}

// Handle uncaught errors gracefully
process.on('uncaughtException', async (err) => {
  console.error(`[UNCAUGHT] ${err.message}`);
  try {
    await logger.logEvent('UNCAUGHT_EXCEPTION', { Error: err.message });
  } catch {
    // Best effort
  }
});

process.on('unhandledRejection', async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[UNHANDLED REJECTION] ${msg}`);
  try {
    await logger.logEvent('UNHANDLED_REJECTION', { Error: msg });
  } catch {
    // Best effort
  }
});

// Start the application
main();
