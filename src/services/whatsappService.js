const EventEmitter = require('events');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MAX_ATTACHMENT_BYTES } = require('../lib/limits');
const applyWhatsAppRuntimePatch = require('./whatsappRuntimePatch');

const BRIDGE_MESSAGE_MARKER = '__waSignalBridgeGenerated';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGroupChat(chat) {
  const serializedId = chat?.id?._serialized || chat?.id || '';
  return chat?.isGroup === true
    || String(serializedId).endsWith('@g.us')
    || Boolean(chat?.groupMetadata);
}

function placeholderForMessageType(type) {
  const placeholders = {
    sticker: '🖼️ Sticker',
    location: '📍 Location',
    vcard: '👤 Contact',
    multi_vcard: '👥 Contacts'
  };

  if (placeholders[type]) return placeholders[type];
  if (String(type).startsWith('poll')) return '📊 Poll';
  if (String(type).includes('event')) return '📅 Event';
  return null;
}

function transcodeVoiceMessage(buffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-codec:a', 'libmp3lame',
      '-q:a', '4',
      '-f', 'mp3',
      'pipe:1'
    ]);
    const output = [];
    const errors = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => ffmpeg.kill('SIGKILL'), 30000);

    ffmpeg.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_ATTACHMENT_BYTES) {
        ffmpeg.kill('SIGKILL');
        if (!settled) {
          settled = true;
          reject(new Error('Converted voice message exceeds the attachment size limit'));
        }
        return;
      }
      output.push(chunk);
    });
    ffmpeg.stderr.on('data', (chunk) => {
      if (errors.reduce((total, item) => total + item.length, 0) < 64 * 1024) errors.push(chunk);
    });
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code === 0 && output.length > 0) {
        resolve(Buffer.concat(output));
        return;
      }

      reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `ffmpeg exited with code ${code}`));
    });
    ffmpeg.stdin.end(buffer);
  });
}

class WhatsAppService extends EventEmitter {
  constructor({ sessionDir, chromePath }) {
    super();
    this.sessionDir = sessionDir;
    this.chromePath = chromePath;
    this.client = null;
    this.startPromise = null;
    this.messageQueue = Promise.resolve();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.stopping = false;
    this.manualRestart = false;
    this.state = {
      provider: 'whatsapp',
      status: 'starting',
      qrCodeDataUrl: null,
      lastError: null,
      connectedAt: null,
      updatedAt: new Date().toISOString()
    };
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.initializeClient().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async initializeClient() {
    await this.removeStaleBrowserLocks();

    const conf = {
      authStrategy: new LocalAuth({ dataPath: this.sessionDir }),
      authTimeoutMs: 60000,
      qrMaxRetries: 5,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000,
      webVersionCache: {
        type: 'none'
      },
      puppeteer: {
        args: [
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--disable-gpu'
        ]
      }
    };

    if (this.chromePath) {
      conf.puppeteer.product = 'chrome';
      conf.puppeteer.executablePath = this.chromePath;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const client = new Client(conf);
      this.client = client;
      this.attachEvents(client);
      try {
        await client.initialize();
        return;
      } catch (error) {
        const isNavigationRace = error?.message?.includes('Execution context was destroyed')
          || error?.message?.includes('Runtime.callFunctionOn')
          || error?.message?.includes('auth timeout')
          || error === 'auth timeout';

        this.client = null;
        await client.destroy().catch(() => {});
        if (!isNavigationRace || attempt === 3) {
          this.updateState({ status: 'error', lastError: error.message || String(error) });
          throw error;
        }

        await sleep(2000);
        await this.removeStaleBrowserLocks();
      }
    }
  }

  async removeStaleBrowserLocks() {
    const profileDir = path.join(this.sessionDir, 'session');
    await Promise.all([
      'SingletonLock',
      'SingletonCookie',
      'SingletonSocket',
      'DevToolsActivePort'
    ].map((filename) => fs.rm(path.join(profileDir, filename), { force: true })));
  }

  attachEvents(client) {
    client.on('qr', async (qrText) => {
      if (client !== this.client) return;
      try {
        const qrCodeDataUrl = await qrcode.toDataURL(qrText);
        this.updateState({ status: 'awaiting_qr_scan', qrCodeDataUrl, lastError: null });
      } catch (error) {
        this.updateState({ status: 'error', lastError: error.message || String(error) });
      }
    });

    client.on('ready', () => {
      if (client !== this.client) return;
      this.applyRuntimePatches()
        .catch((error) => {
          console.warn('Failed to apply WhatsApp runtime patches:', error.message || error);
        })
        .finally(() => {
          this.reconnectAttempts = 0;
          this.updateState({
            status: 'ready',
            qrCodeDataUrl: null,
            connectedAt: new Date().toISOString(),
            lastError: null
          });
        });
    });

    client.on('authenticated', () => {
      if (client !== this.client) return;
      this.updateState({ status: 'authenticated', lastError: null });
    });

    client.on('auth_failure', (message) => {
      if (client !== this.client) return;
      this.updateState({ status: 'auth_failure', lastError: message || 'Authentication failed' });
      this.scheduleReconnect();
    });

    client.on('disconnected', (reason) => {
      if (client !== this.client) return;
      this.updateState({ status: 'disconnected', lastError: String(reason || 'Disconnected') });
      this.scheduleReconnect();
    });

    client.on('message_create', (message) => {
      if (client !== this.client) return;
      this.messageQueue = this.messageQueue
        .then(() => this.processIncomingMessage(client, message))
        .catch((error) => {
        this.emit('serviceError', {
          provider: 'whatsapp',
          message: 'Failed to normalize incoming WhatsApp message',
          error
        });
      });
    });
  }

  async processIncomingMessage(client, message) {
    if (client !== this.client || message.isStatus) return;
    if (message.fromMe && (
      message.rawData?.[BRIDGE_MESSAGE_MARKER] === true
      || message.rawData?.local === true
    )) return;

    const chat = await message.getChat();
    if (!isGroupChat(chat)) return;

    let contact = null;
    try {
      contact = await message.getContact();
    } catch (error) {
      this.emitNormalizationWarning('WhatsApp contact lookup failed; using the message author', error);
    }
    let replyToMessageId = null;
    if (message.hasQuotedMsg) {
      try {
        const quotedMessage = await message.getQuotedMessage();
        replyToMessageId = quotedMessage?.id?._serialized || null;
      } catch (_) {
        // WhatsApp may no longer have the quoted message in its local store.
      }
    }

    const isVoiceMessage = message.type === 'ptt';
    const typePlaceholder = placeholderForMessageType(message.type);
    const chatId = chat.id?._serialized || String(chat.id || '');
    const messageId = message.id?._serialized || null;
    const normalized = {
      provider: 'whatsapp',
      fingerprint: messageId || `wa:${chatId}:${message.timestamp}`,
      messageId,
      replyToMessageId,
      chatId,
      chatName: chat.name,
      senderId: message.author || contact?.id?._serialized || contact?.number || 'unknown',
      senderName: contact?.pushname || contact?.name || contact?.number || (message.fromMe ? 'You' : 'Unknown'),
      messageType: message.type,
      text: isVoiceMessage ? '🎙️ Voice message' : typePlaceholder || message.body || '',
      timestamp: message.timestamp ? new Date(message.timestamp * 1000).toISOString() : new Date().toISOString(),
      attachments: []
    };

    if (message.hasMedia && !typePlaceholder) {
      try {
        const media = await message.downloadMedia();
        if (media) {
          const originalBuffer = Buffer.from(media.data, 'base64');
          if (originalBuffer.length > MAX_ATTACHMENT_BYTES) {
            throw new Error(`WhatsApp attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
          }

          let buffer = originalBuffer;
          let filename = media.filename || 'attachment';
          let mimetype = media.mimetype || 'application/octet-stream';
          if (isVoiceMessage) {
            try {
              buffer = await transcodeVoiceMessage(originalBuffer);
              filename = 'voice-message.mp3';
              mimetype = 'audio/mpeg';
            } catch (error) {
              filename = 'voice-message.ogg';
              console.warn('Voice message conversion failed; forwarding original audio:', error.message || error);
            }
          }
          normalized.attachments.push({ buffer, filename, mimetype });
        }
      } catch (error) {
        this.emitNormalizationWarning('WhatsApp attachment could not be forwarded; preserving message text', error);
        if (!normalized.text.trim()) normalized.text = 'Attachment unavailable';
      }
    }

    this.emit('incomingMessage', normalized);
  }

  emitNormalizationWarning(message, error) {
    this.emit('serviceError', { provider: 'whatsapp', message, error });
  }

  updateState(next) {
    this.state = {
      ...this.state,
      ...next,
      updatedAt: new Date().toISOString()
    };
    this.emit('stateChanged', this.getState());
  }

  getState() {
    return { ...this.state };
  }

  scheduleReconnect() {
    if (this.stopping || this.manualRestart || this.reconnectTimer) return;

    const delay = Math.min(5000 * (2 ** this.reconnectAttempts), 60000);
    this.reconnectAttempts += 1;
    this.updateState({ status: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.restartClient().catch((error) => {
        this.updateState({ status: 'error', lastError: error.message || String(error) });
        this.scheduleReconnect();
      });
    }, delay);
  }

  async restartClient() {
    const client = this.client;
    this.client = null;
    await client?.destroy().catch(() => {});
    if (!this.stopping) await this.start();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    await client?.destroy().catch(() => {});
    await this.messageQueue.catch(() => {});
  }

  async logout() {
    const client = this.client;
    if (!client) {
      await this.start();
      return this.getState();
    }

    this.manualRestart = true;
    this.updateState({ status: 'disconnecting', qrCodeDataUrl: null, lastError: null });
    let logoutError = null;
    try {
      await client.logout();
    } catch (error) {
      logoutError = error;
    } finally {
      this.client = null;
      await client.destroy().catch(() => {});
    }

    this.updateState({ status: 'starting', connectedAt: null, lastError: null });
    this.manualRestart = false;
    try {
      await this.start();
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    }
    if (logoutError) throw logoutError;
    return this.getState();
  }

  async applyRuntimePatches() {
    if (this.client?.pupPage) await applyWhatsAppRuntimePatch(this.client.pupPage);
  }

  async listGroups() {
    if (!this.client) {
      return [];
    }

    await this.applyRuntimePatches();

    const normalizedGroups = await this.client.pupPage?.evaluate(async () => {
      const result = new Map();
      const chatStore = window.require('WAWebCollections').Chat;
      const chats = chatStore.getModelsArray();

      for (const chat of chats) {
        try {
          const model = await window.WWebJS.getChatModel(chat);
          const id = model?.id?._serialized || model?.id || '';
          const normalizedId = String(id || '');
          const isGroup = model?.isGroup || normalizedId.endsWith('@g.us') || Boolean(model?.groupMetadata);

          if (!isGroup || !normalizedId) {
            continue;
          }

          result.set(normalizedId, {
            id: normalizedId,
            name: model?.formattedTitle || model?.name || 'Unnamed Group',
            participantCount: Array.isArray(model?.groupMetadata?.participants)
              ? model.groupMetadata.participants.length
              : 0
          });
        } catch (_) {
          // Skip broken chat models instead of aborting the whole list.
        }
      }

      return [...result.values()].sort((left, right) => left.name.localeCompare(right.name));
    }).catch(() => []);

    if (normalizedGroups.length === 0) {
      const diagnostics = await this.client.pupPage?.evaluate(() => ({
        waCollectionChatEntries: window.require('WAWebCollections').Chat.getModelsArray().length,
        chatStoreEntries: typeof window.Store?.Chat?.getModelsArray === 'function'
          ? window.Store.Chat.getModelsArray().length
          : Array.isArray(window.Store?.Chat?.models)
            ? window.Store.Chat.models.length
            : 0,
        groupMetadataEntries: typeof window.Store?.GroupMetadata?.getModelsArray === 'function'
          ? window.Store.GroupMetadata.getModelsArray().length
          : Array.isArray(window.Store?.GroupMetadata?.models)
            ? window.Store.GroupMetadata.models.length
            : 0
      })).catch(() => null);

      console.warn('WhatsApp group discovery returned no groups', diagnostics || {});
    }

    return normalizedGroups;
  }

  async sendText(chatId, text, options = {}) {
    return this.client.sendMessage(chatId, text, {
      ...options,
      extra: {
        ...(options.extra || {}),
        [BRIDGE_MESSAGE_MARKER]: true
      }
    });
  }

  async markChatRead(chatId) {
    return this.client.sendSeen(chatId);
  }

  async sendMedia(chatId, buffer, filename, mimetype, caption, options = {}) {
    if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('WhatsApp attachment exceeds the size limit');
    const media = new MessageMedia(
      mimetype || 'application/octet-stream',
      buffer.toString('base64'),
      filename || 'attachment'
    );

    return this.client.sendMessage(chatId, media, {
      ...options,
      ...(caption ? { caption } : {}),
      extra: {
        ...(options.extra || {}),
        [BRIDGE_MESSAGE_MARKER]: true
      }
    });
  }
}

module.exports = WhatsAppService;
