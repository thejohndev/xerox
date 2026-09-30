'use strict';

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, getContentType } = require('@whiskeysockets/baileys');
const EventEmitter = require('events');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');
const path = require('path');

const config = require('./config');
const state = require('./state');
const filesystem = require('./filesystem');
const logger = require('./logger');

const whatsappEvents = new EventEmitter();
let currentSocket = null;
let reconnectTimer = null;
let isManualStopped = false;

// Media message types that contain downloadable files
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'];

// Track the current operating date for rollover detection
let currentDate = config.getTodayDate();

// LID → phone number mapping (built from contact sync, persisted to disk)
const lidToPhone = new Map();
const LID_MAP_FILE = path.join(config.APP_DIR, 'lid-map.json');

/**
 * Load the LID→phone mapping from disk.
 */
function loadLidMap() {
  try {
    const data = require('fs').readFileSync(LID_MAP_FILE, 'utf8');
    const map = JSON.parse(data);
    for (const [lid, phone] of Object.entries(map)) {
      lidToPhone.set(lid, phone);
    }
    console.log(`[LID] Loaded ${lidToPhone.size} mappings from lid-map.json`);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

/**
 * Save the LID→phone mapping to disk.
 */
function saveLidMap() {
  try {
    const obj = Object.fromEntries(lidToPhone);
    require('fs').writeFileSync(LID_MAP_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error(`[LID] Could not save lid-map.json: ${err.message}`);
  }
}

/**
 * Process a contact object and extract LID→phone mappings.
 * @param {object} contact
 */
function processContact(contact) {
  if (!contact) return;
  const id = contact.id || '';
  const lid = contact.lid || '';

  // If we have both a phone JID and a LID, store the mapping
  if (lid && id && id.includes('@s.whatsapp.net') && !id.includes('@lid')) {
    const phone = id.replace(/@.*$/, '').replace(/:.*$/, '');
    const lidKey = lid.replace(/@.*$/, '').replace(/:.*$/, '');
    if (phone && lidKey && phone !== lidKey) {
      lidToPhone.set(lidKey, phone);
    }
  }
}

// Load saved mappings on module init
loadLidMap();

/**
 * Check if a JID is a LID (Linked Identity) JID.
 * @param {string} jid
 * @returns {boolean}
 */
function isLidJid(jid) {
  return jid && jid.includes('@lid');
}

/**
 * Extract the numeric part from a WhatsApp JID.
 * Strips @domain and :device suffixes.
 * @param {string} jid - e.g. "919876543210@s.whatsapp.net" or "919876543210:4@s.whatsapp.net"
 * @returns {string} e.g. "919876543210"
 */
function extractPhone(jid) {
  if (!jid) return '';
  // Remove @domain
  let phone = jid.replace(/@.*$/, '');
  // Remove :device_id suffix (linked devices)
  phone = phone.replace(/:.*$/, '');
  // Remove leading 91 country code (India)
  if (phone.startsWith('91') && phone.length > 10) {
    phone = phone.substring(2);
  }
  return phone;
}

/**
 * Resolve a JID to an actual phone number.
 * Checks msg.key.senderPn first (most reliable), then falls back
 * to LID mapping methods.
 *
 * @param {string} jid - the remoteJid from the message
 * @param {object} sock - the Baileys socket instance
 * @param {object} [msgKey] - the full msg.key object (contains senderPn)
 * @returns {Promise<string>} the phone number
 */
async function resolvePhone(jid, sock, msgKey) {
  if (!jid) return '';

  // Method 0: senderPn in message key (most reliable for LID messages)
  if (msgKey && msgKey.senderPn) {
    const phone = extractPhone(msgKey.senderPn);
    if (phone) {
      if (isLidJid(jid)) {
        const lid = jid.replace(/@.*$/, '').replace(/:.*$/, '');
        if (!lidToPhone.has(lid)) {
          lidToPhone.set(lid, phone);
          saveLidMap();
          console.log(`[LID] Mapped ${lid} → ${phone} (from senderPn)`);
        }
      }
      return phone;
    }
  }

  // Regular phone JID — extract directly
  if (!isLidJid(jid)) {
    return extractPhone(jid);
  }

  // LID JID — try to resolve
  const lid = jid.replace(/@.*$/, '').replace(/:.*$/, '');

  // Method 1: Check our local LID→phone map
  if (lidToPhone.has(lid)) {
    return lidToPhone.get(lid);
  }

  try {
    // Method 2: Baileys internal LID mapping
    if (sock.signalRepository && sock.signalRepository.lidMapping) {
      const pnJid = await sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pnJid) {
        const phone = extractPhone(pnJid);
        if (phone) {
          lidToPhone.set(lid, phone);
          saveLidMap();
          return phone;
        }
      }
    }
  } catch { /* silent */ }

  try {
    // Method 3: Store/contact lookup
    if (sock.store && sock.store.contacts) {
      for (const [contactJid, contact] of Object.entries(sock.store.contacts)) {
        if (contact.lid === jid || contactJid === jid) {
          const phone = extractPhone(contact.id || contactJid);
          if (phone && !isLidJid(phone + '@')) {
            lidToPhone.set(lid, phone);
            saveLidMap();
            return phone;
          }
        }
      }
    }
  } catch { /* silent */ }

  // Fallback: use LID number
  console.log(`[LID] Could not resolve ${lid}, using LID as identifier`);
  return lid;
}

/**
 * Check if a JID is a group chat.
 * @param {string} jid
 * @returns {boolean}
 */
function isGroupJid(jid) {
  return jid && jid.includes('@g.us');
}

/**
 * Get the filename from a media message.
 * @param {object} message - the message content object
 * @param {string} messageType - the message type key
 * @returns {string}
 */
function getMediaFilename(message, messageType) {
  const content = message[messageType];
  if (!content) return 'file';

  // documentMessage has a fileName field
  if (content.fileName) {
    return filesystem.sanitizeFilename(content.fileName);
  }

  // For images, videos, audio — generate a name from type + timestamp
  const ext = getMediaExtension(messageType, content.mimetype);
  const timestamp = Date.now();
  return `${messageType.replace('Message', '')}_${timestamp}${ext}`;
}

/**
 * Get file extension from mimetype or message type.
 * @param {string} messageType
 * @param {string} [mimetype]
 * @returns {string}
 */
function getMediaExtension(messageType, mimetype) {
  if (mimetype) {
    const mimeMap = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'audio/mpeg': '.mp3',
      'audio/ogg; codecs=opus': '.ogg',
      'audio/ogg': '.ogg',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.ms-powerpoint': '.ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'text/plain': '.txt',
    };
    if (mimeMap[mimetype]) return mimeMap[mimetype];
    // Try to extract from mimetype
    const parts = mimetype.split('/');
    if (parts.length === 2) return '.' + parts[1].split(';')[0];
  }

  const typeMap = {
    imageMessage: '.jpg',
    videoMessage: '.mp4',
    audioMessage: '.ogg',
    stickerMessage: '.webp',
    documentMessage: '.bin',
  };
  return typeMap[messageType] || '.bin';
}

/**
 * Handle an incoming text message (potential customer name).
 *
 * @param {string} phone
 * @param {string} text
 */
async function handleTextMessage(phone, text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  state.incrementCounter('whatsappMessagesReceived');

  const name = filesystem.sanitizeName(trimmed);
  const currentBatch = state.getBatch(phone);

  if (currentBatch === null) {
    // Phone has an unnamed folder — rename it
    await filesystem.renameUnnamedFolder(phone, name);
    state.setBatch(phone, name);

    await logger.logEvent('NAME_RECEIVED', { Phone: phone, Name: name });
    await logger.logEvent('FOLDER_RENAMED', {
      From: phone,
      To: filesystem.buildFolderName(phone, name),
    });

    // No totalBatches increment — the unnamed folder was already counted as a batch

    console.log(`[NAME] Renamed ${phone} → ${name} - ${phone}`);
  } else if (currentBatch === undefined) {
    // No batch at all — create a new named folder
    await filesystem.ensureCustomerFolder(phone, name);
    state.setBatch(phone, name);
    state.incrementCounter('totalBatches');

    await logger.logEvent('NAME_RECEIVED', { Phone: phone, Name: name });
    await logger.logEvent('FOLDER_CREATED', {
      Folder: filesystem.buildFolderName(phone, name),
    });

    console.log(`[NAME] Created folder: ${name} - ${phone}`);
  } else {
    // Has an existing named batch — is this a different name?
    if (name !== currentBatch) {
      // New batch for the same phone
      await filesystem.ensureCustomerFolder(phone, name);
      state.setBatch(phone, name);
      state.incrementCounter('totalBatches');

      await logger.logEvent('NAME_RECEIVED', { Phone: phone, Name: name });
      await logger.logEvent('NEW_FOLDER_CREATED', {
        Folder: filesystem.buildFolderName(phone, name),
      });

      console.log(`[NAME] New batch: ${name} - ${phone} (previous: ${currentBatch})`);
    } else {
      // Same name again — just acknowledge
      state.incrementCounter('whatsappMessagesReceived');
      console.log(`[NAME] Same name repeated: ${name} - ${phone}`);
    }
  }

  await logger.updateDashboard(state.getCounters());
}

/**
 * Handle an incoming media message (file download).
 *
 * @param {object} msg - the full Baileys message object
 * @param {string} phone
 * @param {string} messageType
 * @param {object} sock - the Baileys socket (for reupload)
 */
async function handleMediaMessage(msg, phone, messageType, sock) {
  state.incrementCounter('whatsappMessagesReceived');

  const filename = getMediaFilename(msg.message, messageType);
  let folderPath;

  const currentBatch = state.getBatch(phone);

  if (currentBatch === undefined) {
    // No batch — create unnamed folder with just phone number
    folderPath = await filesystem.ensureCustomerFolder(phone, null);
    state.setBatch(phone, null);
    state.incrementCounter('totalBatches');

    await logger.logEvent('FOLDER_CREATED', { Folder: phone });
    console.log(`[FILE] Created unnamed folder: ${phone}`);
  } else {
    // Has a batch (named or unnamed) — save to that folder
    folderPath = path.join(config.getTodayDir(), filesystem.buildFolderName(phone, currentBatch));
    await filesystem.ensureCustomerFolder(phone, currentBatch);
  }

  // Get unique file path (handle duplicates)
  const filePath = await filesystem.getUniqueFilePath(folderPath, filename);
  const savedFilename = path.basename(filePath);

  try {
    // Download media as a stream
    const stream = await downloadMediaMessage(
      msg,
      'stream',
      {},
      {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    // Save to file
    await pipeline(stream, createWriteStream(filePath));

    state.incrementCounter('totalFilesReceived');
    state.incrementCounter('whatsappFilesReceived');

    await logger.logEvent('FILE_RECEIVED', {
      Phone: phone,
      File: savedFilename,
      Type: messageType,
    });

    console.log(`[FILE] Saved: ${savedFilename} → ${path.relative(config.XEROX_ROOT, folderPath)}`);

    whatsappEvents.emit('file', {
      name: savedFilename,
      folder: path.basename(folderPath),
      time: config.getTimeStamp(),
      phone: phone,
    });
  } catch (err) {
    console.error(`[FILE ERROR] Failed to download ${filename}: ${err.message}`);
    await logger.logEvent('DOWNLOAD_FAILED', {
      Phone: phone,
      File: filename,
      Error: err.message,
    });
  }

  await logger.updateDashboard(state.getCounters());
}

/**
 * Process an incoming WhatsApp message.
 *
 * @param {object} msg - the full Baileys message object
 * @param {object} sock - the Baileys socket
 */
async function processMessage(msg, sock) {
  try {
    // Skip own messages
    if (msg.key.fromMe) return;

    // Skip group messages
    const jid = msg.key.remoteJid;
    if (!jid || isGroupJid(jid)) return;

    // Check for date rollover
    const rolled = await filesystem.checkDateRollover(currentDate);
    if (rolled) {
      currentDate = config.getTodayDate();
    }

    const phone = await resolvePhone(jid, sock, msg.key);
    if (!phone) return;

    // Determine message type
    if (!msg.message) return;
    const messageType = getContentType(msg.message);
    if (!messageType) return;

    if (MEDIA_TYPES.includes(messageType)) {
      await handleMediaMessage(msg, phone, messageType, sock);
    } else if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      // Text message
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (text.trim()) {
        await handleTextMessage(phone, text);
      }
    }
    // Ignore other message types (reactions, contacts, locations, etc.)
  } catch (err) {
    console.error(`[MESSAGE ERROR] ${err.message}`);
    await logger.logEvent('MESSAGE_ERROR', { Error: err.message });
  }
}

/**
 * Start the WhatsApp connection using Baileys.
 * Handles QR display, authentication, reconnection, and message reception.
 */
async function startWhatsApp() {
  if (currentSocket && !isManualStopped) {
    console.log('[WHATSAPP] Already running');
    return;
  }

  isManualStopped = false;
  whatsappEvents.emit('status', 'connecting');

  const { state: authState, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);

  const sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Xerox Shop', 'Chrome', '1.0.0'],
  });

  currentSocket = sock;

  // Connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n========================================');
      console.log('  Scan this QR code with WhatsApp:');
      console.log('========================================\n');
      qrcodeTerminal.generate(qr, { small: true });

      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
        whatsappEvents.emit('qr', qrDataUrl);
        whatsappEvents.emit('status', 'qr');
      } catch (err) {
        console.error('[QR ERROR]', err.message);
      }
    }

    if (connection === 'open') {
      console.log('\n[WHATSAPP] Connected successfully!\n');
      currentDate = config.getTodayDate();
      whatsappEvents.emit('qr', null);
      whatsappEvents.emit('status', 'connected');
      await logger.logEvent('WHATSAPP_CONNECTED');
    }

    if (connection === 'close') {
      currentSocket = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (isManualStopped) {
        console.log('[WHATSAPP] Stopped cleanly.');
        whatsappEvents.emit('status', 'stopped');
        return;
      }

      console.log(`[WHATSAPP] Disconnected. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      whatsappEvents.emit('status', shouldReconnect ? 'reconnecting' : 'disconnected');
      await logger.logEvent('WHATSAPP_DISCONNECTED', {
        StatusCode: statusCode || 'unknown',
        Reconnecting: shouldReconnect ? 'yes' : 'no',
      });

      if (shouldReconnect) {
        reconnectTimer = setTimeout(() => {
          if (!isManualStopped) {
            startWhatsApp();
          }
        }, 3000);
      } else {
        console.log('[WHATSAPP] Logged out. Please restart and scan QR code again.');
        whatsappEvents.emit('status', 'logged_out');
        await logger.logEvent('WHATSAPP_LOGGED_OUT');
      }
    }
  });

  // Save credentials whenever updated
  sock.ev.on('creds.update', saveCreds);

  // Incoming messages
  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return;
    for (const msg of event.messages) {
      await processMessage(msg, sock);
    }
  });

  // Build LID→phone mapping from contact sync
  sock.ev.on('contacts.upsert', (contacts) => {
    let newMappings = 0;
    for (const contact of contacts) {
      const before = lidToPhone.size;
      processContact(contact);
      if (lidToPhone.size > before) newMappings++;
    }
    if (newMappings > 0) {
      saveLidMap();
      console.log(`[LID] Added ${newMappings} new mappings from contacts.upsert (total: ${lidToPhone.size})`);
    }
  });

  sock.ev.on('contacts.update', (contacts) => {
    let newMappings = 0;
    for (const contact of contacts) {
      const before = lidToPhone.size;
      processContact(contact);
      if (lidToPhone.size > before) newMappings++;
    }
    if (newMappings > 0) {
      saveLidMap();
      console.log(`[LID] Added ${newMappings} new mappings from contacts.update (total: ${lidToPhone.size})`);
    }
  });

  // Also try to extract from messaging history sync
  sock.ev.on('messaging-history.set', ({ contacts }) => {
    if (!contacts || !contacts.length) return;
    let newMappings = 0;
    for (const contact of contacts) {
      const before = lidToPhone.size;
      processContact(contact);
      if (lidToPhone.size > before) newMappings++;
    }
    if (newMappings > 0) {
      saveLidMap();
      console.log(`[LID] Added ${newMappings} new mappings from history sync (total: ${lidToPhone.size})`);
    }
  });
}

/**
 * Stop WhatsApp connection cleanly.
 */
async function stopWhatsApp() {
  isManualStopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (currentSocket) {
    try {
      currentSocket.end(undefined);
    } catch (err) {
      // Ignore socket end error
    }
    currentSocket = null;
  }
  whatsappEvents.emit('qr', null);
  whatsappEvents.emit('status', 'stopped');
  await logger.logEvent('WHATSAPP_STOPPED');
  console.log('[WHATSAPP] Stopped by user');
}

/**
 * Check if WhatsApp socket is currently active.
 */
function isWhatsAppRunning() {
  return !!currentSocket && !isManualStopped;
}

module.exports = {
  startWhatsApp,
  stopWhatsApp,
  isWhatsAppRunning,
  whatsappEvents,
};
