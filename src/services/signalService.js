const EventEmitter = require('events');
const axios = require('axios');
const WebSocket = require('ws');
const { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } = require('../lib/limits');

function toWebSocketUrl(httpUrl, pathname) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = pathname;
  url.search = '';
  return url.toString();
}

function signalAttachmentToDataUrl(buffer, mimetype, filename) {
  const safeFilename = filename ? `;filename=${encodeURIComponent(filename)}` : '';
  return `data:${mimetype || 'application/octet-stream'}${safeFilename};base64,${buffer.toString('base64')}`;
}

class SignalService extends EventEmitter {
  constructor({ baseUrl, number, deviceName, pollIntervalMs, qrRefreshMs }) {
    super();
    if (!baseUrl) {
      throw new Error('Signal API URL is required');
    }

    if (!number) {
      throw new Error('SIGNAL_NUMBER not set');
    }

    this.baseUrl = baseUrl;
    this.number = number;
    this.deviceName = deviceName;
    this.pollIntervalMs = pollIntervalMs;
    this.qrRefreshMs = qrRefreshMs;
    this.api = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      maxContentLength: MAX_ATTACHMENT_BYTES
    });
    this.mode = null;
    this.receiver = null;
    this.statusTimer = null;
    this.requestQueue = Promise.resolve();
    this.receiveInFlight = null;
    this.messageQueue = Promise.resolve();
    this.stopping = false;
    this.state = {
      provider: 'signal',
      status: 'starting',
      qrCodeDataUrl: null,
      qrCodeGeneratedAt: null,
      lastError: null,
      connectedAt: null,
      updatedAt: new Date().toISOString()
    };
  }

  async start() {
    this.stopping = false;
    await this.refreshStatus({ throwOnError: false });
    this.scheduleStatusRefresh();
  }

  scheduleStatusRefresh() {
    clearTimeout(this.statusTimer);
    if (this.stopping) return;

    this.statusTimer = setTimeout(async () => {
      try {
        await this.refreshStatus();
      } catch (error) {
        this.updateState({ status: 'error', lastError: error.message || String(error) });
      } finally {
        this.scheduleStatusRefresh();
      }
    }, this.pollIntervalMs);
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.disconnectReceiver();
    await Promise.allSettled([this.messageQueue, this.receiveInFlight].filter(Boolean));
  }

  async refreshStatus({ forceQrRefresh = false, throwOnError = true } = {}) {
    try {
      const aboutResponse = await this.enqueueRequest(() => this.api.get('/v1/about'));
      this.mode = aboutResponse.data?.mode || this.mode;

      const accountsResponse = await this.enqueueRequest(() => this.api.get('/v1/accounts'));
      const accounts = Array.isArray(accountsResponse.data) ? accountsResponse.data : [];
      const linked = accounts.includes(this.number);

      if (!linked) {
        const qrExpired = this.state.qrCodeGeneratedAt
          ? (Date.now() - new Date(this.state.qrCodeGeneratedAt).getTime()) >= this.qrRefreshMs
          : true;
        const shouldRefreshQr = forceQrRefresh || !this.state.qrCodeDataUrl || qrExpired;
        const qrCodeDataUrl = shouldRefreshQr
          ? await this.fetchQrCode()
          : this.state.qrCodeDataUrl;

        this.disconnectReceiver();
        this.updateState({
          status: 'awaiting_qr_scan',
          qrCodeDataUrl,
          qrCodeGeneratedAt: shouldRefreshQr ? new Date().toISOString() : this.state.qrCodeGeneratedAt,
          lastError: null
        });
        return this.getState();
      }

      this.updateState({
        status: 'ready',
        qrCodeDataUrl: null,
        qrCodeGeneratedAt: null,
        connectedAt: this.state.connectedAt || new Date().toISOString(),
        lastError: null
      });

      if (!this.receiver || this.receiver.readyState === WebSocket.CLOSED) {
        if (this.mode && this.mode.startsWith('json-rpc')) {
          this.connectReceiver();
        } else {
          this.disconnectReceiver();
          await this.pollReceiveOnce();
        }
      }

      return this.getState();
    } catch (error) {
      this.disconnectReceiver();
      this.updateState({ status: 'error', lastError: error.message || String(error) });
      if (throwOnError) {
        throw error;
      }

      return this.getState();
    }
  }

  async forceQrRefresh() {
    return this.refreshStatus({ forceQrRefresh: true, throwOnError: true });
  }

  async logout() {
    this.disconnectReceiver();
    this.updateState({ status: 'disconnecting', qrCodeDataUrl: null, lastError: null });

    await this.enqueueRequest(() => this.api.post(`/v1/unregister/${encodeURIComponent(this.number)}`, {
      delete_account: false,
      delete_local_data: true
    }));

    this.updateState({ connectedAt: null });
    return this.refreshStatus({ forceQrRefresh: true, throwOnError: true });
  }

  getState() {
    return { ...this.state, mode: this.mode };
  }

  enqueueRequest(fn) {
    const run = this.requestQueue.then(fn, fn);
    this.requestQueue = run.catch(() => {});
    return run;
  }

  updateState(next) {
    const previous = this.state;
    const candidate = {
      ...this.state,
      ...next,
      updatedAt: new Date().toISOString()
    };

    const changed = previous.status !== candidate.status
      || previous.qrCodeDataUrl !== candidate.qrCodeDataUrl
      || previous.qrCodeGeneratedAt !== candidate.qrCodeGeneratedAt
      || previous.lastError !== candidate.lastError
      || previous.connectedAt !== candidate.connectedAt;

    this.state = candidate;

    if (changed) {
      this.emit('stateChanged', this.getState());
    }
  }

  async fetchQrCode() {
    const response = await this.enqueueRequest(() => this.api.get('/v1/qrcodelink', {
      params: { device_name: this.deviceName },
      responseType: 'arraybuffer'
    }));

    const contentType = response.headers['content-type'] || 'image/png';
    if (!contentType.startsWith('image/')) {
      const message = Buffer.from(response.data).toString('utf8');
      throw new Error(`Signal QR request failed: ${message}`);
    }

    const buffer = Buffer.from(response.data);
    return signalAttachmentToDataUrl(buffer, contentType);
  }

  connectReceiver() {
    if (this.receiver && (this.receiver.readyState === WebSocket.OPEN || this.receiver.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = toWebSocketUrl(this.baseUrl, `/v1/receive/${encodeURIComponent(this.number)}`);
    const receiver = new WebSocket(wsUrl);
    this.receiver = receiver;

    receiver.on('open', () => {
      if (receiver !== this.receiver) return;
      this.updateState({ status: 'ready', lastError: null });
    });

    receiver.on('message', (raw) => {
      if (receiver !== this.receiver) return;
      this.messageQueue = this.messageQueue
        .then(async () => {
          const payload = JSON.parse(raw.toString());
          const event = payload.params || payload;
          const normalized = await this.normalizeIncomingEvent(event);
          if (normalized) this.emit('incomingMessage', normalized);
        })
        .catch((error) => this.emit('serviceError', {
          provider: 'signal',
          message: 'Failed to process Signal receive event',
          error
        }));
    });

    receiver.on('close', () => {
      if (receiver !== this.receiver) return;
      this.receiver = null;
      if (this.state.status === 'ready') {
        this.updateState({ status: 'reconnecting' });
      }
    });

    receiver.on('error', (error) => {
      if (receiver !== this.receiver) return;
      this.updateState({ status: 'error', lastError: error.message || String(error) });
    });
  }

  disconnectReceiver() {
    if (!this.receiver) {
      return;
    }

    const receiver = this.receiver;
    this.receiver = null;
    try {
      receiver.close();
    } catch (_) {
      // ignore close errors
    }
  }

  async pollReceiveOnce() {
    if (this.receiveInFlight) {
      return this.receiveInFlight;
    }

    this.receiveInFlight = (async () => {
      const response = await this.enqueueRequest(() => this.api.get(`/v1/receive/${encodeURIComponent(this.number)}`, {
        timeout: 10000
      }));

      const events = Array.isArray(response.data)
        ? response.data
        : Array.isArray(response.data?.messages)
          ? response.data.messages
          : response.data
            ? [response.data]
            : [];

      for (const rawEvent of events) {
        const event = rawEvent?.params || rawEvent;
        const normalized = await this.normalizeIncomingEvent(event);
        if (normalized) {
          this.emit('incomingMessage', normalized);
        }
      }
    })().finally(() => {
      this.receiveInFlight = null;
    });

    return this.receiveInFlight;
  }

  async normalizeIncomingEvent(event) {
    event = event?.params?.result || event?.params || event?.result || event;
    const envelope = event?.envelope;
    if (!envelope) {
      return null;
    }

    const sentMessage = envelope.syncMessage?.sentMessage;
    const message = envelope.dataMessage || sentMessage;
    if (!message?.groupInfo?.groupId) {
      return null;
    }

    const accountOriginated = Boolean(sentMessage);
    const senderId = accountOriginated
      ? event.account || this.number
      : envelope.sourceNumber || envelope.source || envelope.sourceUuid || 'unknown';
    if (!accountOriginated && senderId === this.number) {
      return null;
    }

    const attachments = [];
    let attachmentBytes = 0;
    let attachmentFailed = false;
    for (const attachment of (message.attachments || []).slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      try {
        const response = await this.enqueueRequest(() => this.api.get(`/v1/attachments/${encodeURIComponent(attachment.id)}`, {
          responseType: 'arraybuffer'
        }));
        const buffer = Buffer.from(response.data);
        if (attachmentBytes > MAX_ATTACHMENT_BYTES - buffer.length) {
          throw new Error('Signal message attachments exceed the aggregate size limit');
        }
        attachmentBytes += buffer.length;
        attachments.push({
          buffer,
          filename: attachment.filename || attachment.id,
          mimetype: attachment.contentType || response.headers['content-type'] || 'application/octet-stream'
        });
      } catch (error) {
        attachmentFailed = true;
        this.emit('serviceError', {
          provider: 'signal',
          message: 'Signal attachment could not be forwarded; preserving message text',
          error
        });
      }
    }
    if ((message.attachments || []).length > MAX_ATTACHMENTS_PER_MESSAGE) attachmentFailed = true;

    const messageTimestamp = message.timestamp ?? envelope.timestamp ?? Date.now();
    const text = message.message || (attachmentFailed && attachments.length === 0 ? 'Attachment unavailable' : '');

    return {
      provider: 'signal',
      fingerprint: `signal:${message.groupInfo.groupId}:${senderId}:${messageTimestamp}`,
      messageId: String(messageTimestamp),
      replyToMessageId: message.quote?.id == null ? null : String(message.quote.id),
      chatId: message.groupInfo.groupId,
      chatName: message.groupInfo.groupName || 'Signal Group',
      senderId,
      senderName: envelope.sourceName || senderId,
      text,
      timestamp: new Date(messageTimestamp).toISOString(),
      attachments
    };
  }

  async listGroups() {
    const response = await this.enqueueRequest(() => this.api.get(`/v1/groups/${encodeURIComponent(this.number)}`));
    const groups = Array.isArray(response.data) ? response.data : [];
    return groups.map((group) => ({
      id: group.id,
      internalId: group.internal_id,
      name: group.name || group.id,
      description: group.description || '',
      memberCount: Array.isArray(group.members) ? group.members.length : 0
    })).sort((left, right) => left.name.localeCompare(right.name));
  }

  getAccountId() {
    return this.number;
  }

  addQuoteToPayload(payload, quote) {
    const timestamp = Number(quote?.timestamp);
    if (!Number.isSafeInteger(timestamp) || !quote?.author) {
      return payload;
    }

    return {
      ...payload,
      quote_timestamp: timestamp,
      quote_author: quote.author,
      quote_message: quote.message || ''
    };
  }

  async sendGroupText(groupId, text, quote) {
    const payload = {
      message: text,
      number: this.number,
      recipients: [groupId],
      text_mode: 'normal',
      notify_self: false
    };
    const response = await this.enqueueRequest(() => this.api.post('/v2/send', this.addQuoteToPayload(payload, quote)));
    return response.data;
  }

  async sendGroupAttachment(groupId, buffer, filename, mimetype, caption, quote) {
    if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('Signal attachment exceeds the size limit');
    const payload = {
      message: caption || filename || 'Attachment',
      number: this.number,
      recipients: [groupId],
      base64_attachments: [signalAttachmentToDataUrl(buffer, mimetype, filename)],
      text_mode: 'normal',
      notify_self: false
    };
    const response = await this.enqueueRequest(() => this.api.post('/v2/send', this.addQuoteToPayload(payload, quote)));
    return response.data;
  }
}

module.exports = SignalService;
