'use strict';

/**
 * In-memory state for the application.
 * Rebuilt from disk on startup — no database needed.
 */

// Map: phoneNumber (string) → current batch name (string | null)
// null means the phone has an unnamed folder (just the phone number)
const currentBatch = new Map();

// Track unique phone numbers seen today
const knownPhones = new Set();

// Dashboard counters
const counters = {
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

/**
 * Set the current batch name for a phone number.
 * @param {string} phone
 * @param {string|null} name - null for unnamed folder
 */
function setBatch(phone, name) {
  currentBatch.set(phone, name);
  if (!knownPhones.has(phone)) {
    knownPhones.add(phone);
    counters.totalCustomers++;
  }
}

/**
 * Get the current batch name for a phone number.
 * @param {string} phone
 * @returns {string|null|undefined} name, null (unnamed), or undefined (no batch)
 */
function getBatch(phone) {
  return currentBatch.get(phone);
}

/**
 * Check if a phone has any batch (named or unnamed).
 * @param {string} phone
 * @returns {boolean}
 */
function hasBatch(phone) {
  return currentBatch.has(phone);
}

/**
 * Increment a counter by a given amount.
 * @param {string} key - one of the counter keys
 * @param {number} [amount=1]
 */
function incrementCounter(key, amount = 1) {
  if (key in counters) {
    counters[key] += amount;
  }
}

/**
 * Get a shallow copy of the current counters.
 * @returns {object}
 */
function getCounters() {
  return { ...counters };
}

/**
 * Reset all state for a new day.
 */
function resetState() {
  currentBatch.clear();
  knownPhones.clear();
  for (const key of Object.keys(counters)) {
    counters[key] = 0;
  }
}

/**
 * Set a counter to a specific value (used during recovery).
 * @param {string} key
 * @param {number} value
 */
function setCounter(key, value) {
  if (key in counters) {
    counters[key] = value;
  }
}

module.exports = {
  setBatch,
  getBatch,
  hasBatch,
  incrementCounter,
  getCounters,
  resetState,
  setCounter,
};
