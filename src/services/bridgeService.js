function formatForwardedText(providerLabel, senderName, text, prependSender) {
  const cleanText = (text || '').trim();
  if (!prependSender) return cleanText;

  const prefix = `[${providerLabel}] ${senderName}`;
  return cleanText ? `${prefix}\n${cleanText}` : prefix;
}

class BridgeService {
  constructor({ database, whatsappService, signalService, queuePolicy = {} }) {
    this.database = database;
    this.whatsappService = whatsappService;
    this.signalService = signalService;
    this.retryTimer = null;
    this.drainPromise = null;
    this.stopping = true;
    this.queuePolicy = {
      maxAttempts: queuePolicy.maxAttempts || 10,
      maxAgeMs: queuePolicy.maxAgeMs || 24 * 60 * 60 * 1000,
      maxBytes: queuePolicy.maxBytes || 256 * 1024 * 1024,
      deadLetterMaxAgeMs: queuePolicy.deadLetterMaxAgeMs || 7 * 24 * 60 * 60 * 1000
    };
  }

  attach() {
    this.whatsappService.on('incomingMessage', (event) => this.enqueue(event));
    this.signalService.on('incomingMessage', (event) => this.enqueue(event));
    this.whatsappService.on('serviceError', (error) => this.logProviderError(error));
    this.signalService.on('serviceError', (error) => this.logProviderError(error));
  }

  async start() {
    this.stopping = false;
    this.retryTimer = setInterval(() => this.drain().catch((error) => {
      console.error('Bridge retry queue failed:', error);
    }), 5000);
    this.retryTimer.unref();
    await this.drain();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.retryTimer);
    this.retryTimer = null;
    await this.drainPromise?.catch(() => {});
  }

  enqueue(event) {
    try {
      const result = this.database.enqueuePendingMessage(event, this.queuePolicy.maxBytes);
      if (result.status === 'queue_full') {
        this.log('error', 'bridge.queue_rejected', event.provider, event.chatId, null, 'Message rejected because the durable queue is full', {
          fingerprint: event.fingerprint,
          eventBytes: result.eventBytes,
          queueBytes: result.queueBytes,
          maxBytes: this.queuePolicy.maxBytes
        });
        return;
      }
      if (result.status === 'duplicate') return;
      this.drain().catch((error) => this.logUnexpectedFailure(event.provider, event, error));
    } catch (error) {
      this.logUnexpectedFailure(event.provider, event, error);
    }
  }

  async drain() {
    if (this.stopping) return;
    if (this.drainPromise) return this.drainPromise;

    this.drainPromise = this.drainPendingMessages().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  async drainPendingMessages() {
    this.database.cleanupDeadLetters(this.queuePolicy.deadLetterMaxAgeMs);
    for (const result of this.database.deadLetterExpiredPending(this.queuePolicy.maxAgeMs)) {
      this.logDeadLetter(result);
    }

    for (const pending of this.database.listPendingMessages()) {
      if (this.stopping) return;
      try {
        if (pending.event.provider === 'whatsapp') {
          await this.handleWhatsappMessage(pending.event);
        } else {
          await this.handleSignalMessage(pending.event);
        }
        this.database.deletePendingMessage(pending.event.fingerprint);
      } catch (error) {
        const result = this.database.recordPendingFailure(
          pending.event.fingerprint,
          pending.attempts,
          error.message || error,
          this.queuePolicy.maxAttempts
        );
        if (result.status === 'dead_letter') this.logDeadLetter(result);
      }
    }
  }

  async handleWhatsappMessage(event) {
    const mappings = this.database.getMappingsByWhatsappGroupId(event.chatId);
    let delivered = false;
    const failures = [];

    for (const mapping of mappings) {
      try {
        delivered = (await this.forwardWhatsappMapping(event, mapping)) || delivered;
      } catch (error) {
        this.logMappingFailure('whatsapp', event, mapping, error);
        failures.push(error);
      }
    }

    if (delivered) {
      try {
        await this.whatsappService.markChatRead(event.chatId);
      } catch (error) {
        this.log('warning', 'bridge.read_receipt_failed', 'whatsapp', event.chatId, null, 'Message was forwarded but could not be marked as read', {
          fingerprint: event.fingerprint,
          error: error.message || String(error)
        });
      }
    }

    if (failures.length > 0) throw new AggregateError(failures, 'One or more WhatsApp mappings failed');
  }

  async forwardWhatsappMapping(event, mapping) {
    const direction = 'whatsapp_to_signal';
    const caption = formatForwardedText('WhatsApp', event.senderName, event.text, mapping.prependSender);
    const quote = this.resolveSignalQuote(mapping, event.replyToMessageId);
    const parts = this.buildParts(event, mapping.syncMedia);
    let deliveredParts = 0;

    for (const part of parts) {
      if (this.database.isDeliveryComplete(event.fingerprint, mapping.id, direction, part.key)) continue;

      let response;
      if (part.attachment) {
        response = await this.signalService.sendGroupAttachment(
          mapping.signalGroupId,
          part.attachment.buffer,
          part.attachment.filename,
          part.attachment.mimetype,
          part.index === 0 ? caption : undefined,
          quote
        );
      } else {
        response = await this.signalService.sendGroupText(mapping.signalGroupId, caption, quote);
      }

      if (response?.timestamp && !this.database.getReplyLink(mapping.id, event.messageId)) {
        this.database.saveReplyLink({
          mappingId: mapping.id,
          whatsappMessageId: event.messageId,
          signalMessageTimestamp: String(response.timestamp),
          signalAuthor: this.signalService.getAccountId(),
          signalMessageText: caption
        });
      }
      this.database.markDeliveryComplete(event.fingerprint, mapping.id, direction, part.key);
      deliveredParts += 1;
    }

    if (deliveredParts > 0) {
      this.logForwarded('whatsapp', event, mapping, mapping.signalGroupId, deliveredParts);
    }
    return deliveredParts > 0;
  }

  async handleSignalMessage(event) {
    const mappings = this.database.getMappingsBySignalInternalId(event.chatId);
    const failures = [];

    for (const mapping of mappings) {
      try {
        await this.forwardSignalMapping(event, mapping);
      } catch (error) {
        this.logMappingFailure('signal', event, mapping, error);
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'One or more Signal mappings failed');
  }

  async forwardSignalMapping(event, mapping) {
    const direction = 'signal_to_whatsapp';
    const caption = formatForwardedText('Signal', event.senderName, event.text, mapping.prependSender);
    const replyLink = event.replyToMessageId
      ? this.database.getReplyLinkBySignalMessage(mapping.id, event.replyToMessageId)
      : null;
    const sendOptions = replyLink ? { quotedMessageId: replyLink.whatsappMessageId } : undefined;
    const parts = this.buildParts(event, mapping.syncMedia);
    let deliveredParts = 0;

    for (const part of parts) {
      if (this.database.isDeliveryComplete(event.fingerprint, mapping.id, direction, part.key)) continue;

      const whatsappMessage = part.attachment
        ? await this.whatsappService.sendMedia(
          mapping.whatsappGroupId,
          part.attachment.buffer,
          part.attachment.filename,
          part.attachment.mimetype,
          part.index === 0 ? caption || undefined : undefined,
          sendOptions
        )
        : await this.whatsappService.sendText(mapping.whatsappGroupId, caption, sendOptions);

      this.saveReplyLink(mapping, whatsappMessage, event);
      this.database.markDeliveryComplete(event.fingerprint, mapping.id, direction, part.key);
      deliveredParts += 1;
    }

    if (deliveredParts > 0) {
      this.logForwarded('signal', event, mapping, mapping.whatsappGroupId, deliveredParts);
    }
    return deliveredParts > 0;
  }

  buildParts(event, syncMedia) {
    if (syncMedia && event.attachments.length > 0) {
      return event.attachments.map((attachment, index) => ({ key: `attachment:${index}`, attachment, index }));
    }
    return event.text?.trim() ? [{ key: 'text', attachment: null }] : [];
  }

  resolveSignalQuote(mapping, whatsappMessageId) {
    if (!whatsappMessageId) return undefined;
    const link = this.database.getReplyLink(mapping.id, whatsappMessageId);
    return link ? {
      timestamp: link.signalMessageTimestamp,
      author: link.signalAuthor,
      message: link.signalMessageText
    } : undefined;
  }

  saveReplyLink(mapping, whatsappMessage, signalEvent) {
    this.database.saveReplyLink({
      mappingId: mapping.id,
      whatsappMessageId: whatsappMessage?.id?._serialized,
      signalMessageTimestamp: signalEvent.messageId,
      signalAuthor: signalEvent.senderId,
      signalMessageText: signalEvent.text
    });
  }

  logForwarded(provider, event, mapping, targetId, deliveredParts) {
    const target = provider === 'whatsapp' ? 'Signal' : 'WhatsApp';
    this.log('info', 'bridge.forwarded', provider, event.chatId, targetId, `Forwarded message to ${target} via mapping "${mapping.name}"`, {
      mappingId: mapping.id,
      chatName: event.chatName,
      deliveredParts
    });
  }

  logMappingFailure(provider, event, mapping, error) {
    this.log('error', 'bridge.forward_failed', provider, event.chatId, null, `Forwarding failed for mapping "${mapping.name}"`, {
      mappingId: mapping.id,
      fingerprint: event.fingerprint,
      error: error.message || String(error)
    });
  }

  logUnexpectedFailure(provider, event, error) {
    this.log('error', 'bridge.processing_failed', provider, event.chatId, null, error.message || 'Message processing failed', {
      fingerprint: event.fingerprint
    });
  }

  logProviderError(error) {
    this.log('error', 'provider.error', error.provider, null, null, error.message, {
      error: error.error?.message || String(error.error || '')
    });
  }

  logDeadLetter(result) {
    if (result.status !== 'dead_letter') return;
    this.log('error', 'bridge.dead_lettered', result.provider, null, null, 'Message stopped retrying and was moved to the dead-letter list', {
      fingerprint: result.fingerprint,
      attempts: result.attempts,
      reason: result.reason
    });
  }

  log(level, eventType, provider, sourceId, targetId, message, details) {
    this.database.addActivity({ level, eventType, provider, sourceId, targetId, message, details });
  }
}

module.exports = BridgeService;
