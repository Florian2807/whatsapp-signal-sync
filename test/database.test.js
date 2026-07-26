const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AppDatabase = require('../src/lib/database');

async function withDatabase(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-signal-db-'));
  const database = await AppDatabase.create(path.join(directory, 'app.db'));
  database.initialize();
  try {
    await run(database);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function mapping(overrides = {}) {
  return {
    name: 'Test mapping',
    whatsappGroupId: 'wa-group',
    whatsappGroupName: 'WhatsApp group',
    signalGroupId: 'signal-recipient',
    signalGroupInternalId: 'signal-internal',
    signalGroupName: 'Signal group',
    syncWhatsappToSignal: true,
    syncSignalToWhatsapp: true,
    syncMedia: true,
    prependSender: true,
    active: true,
    ...overrides
  };
}

test('persists mappings and delivery state across reopen', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-signal-db-'));
  const databasePath = path.join(directory, 'app.db');
  let database = await AppDatabase.create(databasePath);
  database.initialize();
  const created = database.createMapping(mapping());
  database.markDeliveryComplete('message-1', created.id, 'whatsapp_to_signal', 'text');
  database.close();

  database = await AppDatabase.create(databasePath);
  database.initialize();
  assert.equal(database.listMappings().length, 1);
  assert.equal(database.isDeliveryComplete('message-1', created.id, 'whatsapp_to_signal', 'text'), true);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('deleting a mapping removes reply and delivery state transactionally', async () => {
  await withDatabase(async (database) => {
    const created = database.createMapping(mapping());
    database.saveReplyLink({
      mappingId: created.id,
      whatsappMessageId: 'wa-message',
      signalMessageTimestamp: '123',
      signalAuthor: '+123',
      signalMessageText: 'message'
    });
    database.markDeliveryComplete('message-1', created.id, 'whatsapp_to_signal', 'text');

    database.deleteMapping(created.id);
    assert.equal(database.getReplyLink(created.id, 'wa-message'), null);
    assert.equal(database.isDeliveryComplete('message-1', created.id, 'whatsapp_to_signal', 'text'), false);
  });
});

test('persists pending messages with binary attachments', async () => {
  await withDatabase(async (database) => {
    database.enqueuePendingMessage({
      provider: 'whatsapp',
      fingerprint: 'pending-1',
      chatId: 'group',
      text: 'message',
      attachments: [{ buffer: Buffer.from('binary'), filename: 'file.bin', mimetype: 'application/octet-stream' }]
    });

    const [pending] = database.listPendingMessages();
    assert.equal(pending.event.fingerprint, 'pending-1');
    assert.deepEqual(pending.event.attachments[0].buffer, Buffer.from('binary'));
    database.deletePendingMessage('pending-1');
    assert.equal(database.countPendingMessages(), 0);
  });
});

test('bounds the durable queue by serialized byte size', async () => {
  await withDatabase(async (database) => {
    const first = {
      provider: 'whatsapp',
      fingerprint: 'bounded-1',
      chatId: 'group',
      text: 'message',
      attachments: []
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(first), 'utf8');

    assert.equal(database.enqueuePendingMessage(first, serializedBytes).status, 'enqueued');
    const rejected = database.enqueuePendingMessage({ ...first, fingerprint: 'bounded-2' }, serializedBytes);
    assert.equal(rejected.status, 'queue_full');
    assert.equal(database.countPendingMessages(), 1);
  });
});

test('moves exhausted and expired messages to metadata-only dead letters', async () => {
  await withDatabase(async (database) => {
    const event = {
      provider: 'signal',
      fingerprint: 'exhausted',
      chatId: 'group',
      text: 'private message',
      attachments: [{ buffer: Buffer.from('private attachment'), filename: 'private.bin' }]
    };
    database.enqueuePendingMessage(event);

    const result = database.recordPendingFailure(event.fingerprint, 0, 'permanent failure', 1);
    assert.equal(result.status, 'dead_letter');
    assert.equal(database.countPendingMessages(), 0);
    const [deadLetter] = database.listDeadLetters();
    assert.equal(deadLetter.reason, 'attempts_exhausted');
    assert.equal(Object.hasOwn(deadLetter, 'event'), false);

    database.enqueuePendingMessage({ ...event, fingerprint: 'expired' });
    database.run('UPDATE pending_messages SET created_at = ? WHERE fingerprint = ?', [new Date(0).toISOString(), 'expired']);
    const [expired] = database.deadLetterExpiredPending(1000);
    assert.equal(expired.reason, 'max_age_exceeded');
    assert.equal(database.countPendingMessages(), 0);
  });
});
