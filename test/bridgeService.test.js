const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AppDatabase = require('../src/lib/database');
const BridgeService = require('../src/services/bridgeService');

async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-signal-bridge-'));
  const database = await AppDatabase.create(path.join(directory, 'app.db'));
  database.initialize();
  const whatsapp = {
    reads: 0,
    sent: [],
    async markChatRead() { this.reads += 1; },
    async sendText(groupId, text, options) {
      this.sent.push({ groupId, text, options });
      return { id: { _serialized: `wa-sent-${this.sent.length}` } };
    },
    async sendMedia(groupId, buffer, filename, mimetype, caption, options) {
      this.sent.push({ groupId, filename, caption, options });
      return { id: { _serialized: `wa-sent-${this.sent.length}` } };
    }
  };
  const signal = {
    sent: [],
    failures: new Set(),
    getAccountId: () => '+bridge',
    async sendGroupText(groupId, text, quote) {
      this.sent.push({ groupId, text, quote, type: 'text' });
      if (this.failures.delete(groupId)) throw new Error('temporary failure');
      return { timestamp: String(1000 + this.sent.length) };
    },
    async sendGroupAttachment(groupId, buffer, filename, mimetype, caption, quote) {
      const part = { groupId, filename, caption, quote, type: 'attachment' };
      this.sent.push(part);
      if (this.failures.delete(filename)) throw new Error('temporary failure');
      return { timestamp: String(1000 + this.sent.length) };
    }
  };

  try {
    await run({ database, whatsapp, signal, bridge: new BridgeService({ database, whatsappService: whatsapp, signalService: signal }) });
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createMapping(database, suffix) {
  return database.createMapping({
    name: `Mapping ${suffix}`,
    whatsappGroupId: 'wa-group',
    whatsappGroupName: 'WA',
    signalGroupId: `signal-${suffix}`,
    signalGroupInternalId: `internal-${suffix}`,
    signalGroupName: `Signal ${suffix}`,
    syncWhatsappToSignal: true,
    syncSignalToWhatsapp: true,
    syncMedia: true,
    prependSender: true,
    active: true
  });
}

function whatsappEvent(overrides = {}) {
  return {
    provider: 'whatsapp',
    fingerprint: 'wa-message-1',
    messageId: 'wa-message-1',
    replyToMessageId: null,
    chatId: 'wa-group',
    chatName: 'WA',
    senderName: 'Alice',
    text: 'Hello',
    attachments: [],
    ...overrides
  };
}

test('isolates mapping failures and retries only unfinished deliveries', async () => {
  await fixture(async ({ database, whatsapp, signal, bridge }) => {
    const first = createMapping(database, 'one');
    const second = createMapping(database, 'two');
    signal.failures.add(first.signalGroupId);

    await assert.rejects(() => bridge.handleWhatsappMessage(whatsappEvent()));
    assert.equal(signal.sent.length, 2);
    assert.equal(database.isDeliveryComplete('wa-message-1', first.id, 'whatsapp_to_signal', 'text'), false);
    assert.equal(database.isDeliveryComplete('wa-message-1', second.id, 'whatsapp_to_signal', 'text'), true);

    await bridge.handleWhatsappMessage(whatsappEvent());
    assert.equal(signal.sent.length, 3);
    assert.equal(signal.sent.at(-1).groupId, first.signalGroupId);
    assert.equal(database.isDeliveryComplete('wa-message-1', first.id, 'whatsapp_to_signal', 'text'), true);
    assert.equal(whatsapp.reads, 2);
  });
});

test('retries only the failed attachment', async () => {
  await fixture(async ({ database, signal, bridge }) => {
    createMapping(database, 'media');
    signal.failures.add('two.jpg');
    const event = whatsappEvent({
      attachments: [
        { buffer: Buffer.from('one'), filename: 'one.jpg', mimetype: 'image/jpeg' },
        { buffer: Buffer.from('two'), filename: 'two.jpg', mimetype: 'image/jpeg' }
      ]
    });

    await assert.rejects(() => bridge.handleWhatsappMessage(event));
    await bridge.handleWhatsappMessage(event);
    assert.deepEqual(signal.sent.map((entry) => entry.filename), ['one.jpg', 'two.jpg', 'two.jpg']);
  });
});

test('translates a Signal quote back to the mirrored WhatsApp message', async () => {
  await fixture(async ({ database, whatsapp, bridge }) => {
    const created = createMapping(database, 'reply');
    database.saveReplyLink({
      mappingId: created.id,
      whatsappMessageId: 'wa-original',
      signalMessageTimestamp: '9001',
      signalAuthor: '+sender',
      signalMessageText: 'Original'
    });

    await bridge.handleSignalMessage({
      provider: 'signal',
      fingerprint: 'signal-reply',
      messageId: '9002',
      replyToMessageId: '9001',
      chatId: created.signalGroupInternalId,
      chatName: 'Signal',
      senderId: '+sender',
      senderName: 'Bob',
      text: 'Reply',
      attachments: []
    });

    assert.equal(whatsapp.sent[0].options.quotedMessageId, 'wa-original');
  });
});

test('keeps failed events in the durable retry queue', async () => {
  await fixture(async ({ database, signal, bridge }) => {
    const created = createMapping(database, 'queued');
    signal.failures.add(created.signalGroupId);
    await bridge.start();
    bridge.enqueue(whatsappEvent({ fingerprint: 'queued-message', messageId: 'queued-message' }));
    await bridge.drain();
    assert.equal(database.countPendingMessages(), 1);

    database.run('UPDATE pending_messages SET next_attempt_at = ?', [new Date(0).toISOString()]);
    await bridge.drain();
    assert.equal(database.countPendingMessages(), 0);
    await bridge.stop();
  });
});

test('stops retrying after the configured attempt limit', async () => {
  await fixture(async ({ database, signal }) => {
    const created = createMapping(database, 'terminal');
    signal.sendGroupText = async () => { throw new Error('permanent failure'); };
    const bridge = new BridgeService({
      database,
      whatsappService: { markChatRead: async () => {} },
      signalService: signal,
      queuePolicy: { maxAttempts: 1 }
    });

    await bridge.start();
    bridge.enqueue(whatsappEvent({ fingerprint: 'terminal-message', messageId: 'terminal-message' }));
    await bridge.drain();

    assert.equal(database.countPendingMessages(), 0);
    assert.equal(database.listDeadLetters()[0].reason, 'attempts_exhausted');
    assert.equal(database.listActivity(10).some((entry) => entry.eventType === 'bridge.dead_lettered'), true);
    await bridge.stop();
  });
});
