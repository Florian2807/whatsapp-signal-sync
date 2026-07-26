const assert = require('node:assert/strict');
const test = require('node:test');
const WhatsAppService = require('../src/services/whatsappService');
const SignalService = require('../src/services/signalService');

function whatsappMessage(overrides = {}) {
  return {
    fromMe: true,
    isStatus: false,
    rawData: { local: false },
    id: { _serialized: 'message-1' },
    author: 'account',
    type: 'chat',
    body: 'Sent from another device',
    timestamp: 1000,
    hasQuotedMsg: false,
    hasMedia: false,
    async getChat() {
      return { id: { _serialized: 'group@g.us' }, name: 'Group', isGroup: true };
    },
    async getContact() {
      return { pushname: 'Account', id: { _serialized: 'account' } };
    },
    ...overrides
  };
}

test('accepts synced WhatsApp account messages and ignores bridge-local sends', async () => {
  const service = new WhatsAppService({ sessionDir: '/tmp/session', chromePath: '/usr/bin/chromium' });
  const client = {};
  service.client = client;
  const incoming = [];
  service.on('incomingMessage', (event) => incoming.push(event));

  await service.processIncomingMessage(client, whatsappMessage());
  await service.processIncomingMessage(client, whatsappMessage({
    id: { _serialized: 'message-2' },
    rawData: { local: true }
  }));

  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].text, 'Sent from another device');
});

test('preserves WhatsApp text when media normalization fails', async () => {
  const service = new WhatsAppService({ sessionDir: '/tmp/session', chromePath: '/usr/bin/chromium' });
  const client = {};
  service.client = client;
  const incoming = [];
  service.on('incomingMessage', (event) => incoming.push(event));
  service.on('serviceError', () => {});

  await service.processIncomingMessage(client, whatsappMessage({
    fromMe: false,
    body: 'Caption survives',
    hasMedia: true,
    async downloadMedia() { throw new Error('download unavailable'); }
  }));

  assert.equal(incoming[0].text, 'Caption survives');
  assert.deepEqual(incoming[0].attachments, []);
});

test('marks WhatsApp bridge sends without discarding send options', async () => {
  const service = new WhatsAppService({ sessionDir: '/tmp/session', chromePath: '/usr/bin/chromium' });
  let options;
  service.client = {
    async sendMessage(groupId, text, sentOptions) {
      options = sentOptions;
      return { groupId, text };
    }
  };

  await service.sendText('group@g.us', 'Reply', { quotedMessageId: 'quoted', extra: { existing: true } });
  assert.equal(options.quotedMessageId, 'quoted');
  assert.equal(options.extra.existing, true);
  assert.equal(options.extra.__waSignalBridgeGenerated, true);
});

test('accepts Signal sent transcripts but rejects bridge self-deliveries', async () => {
  const service = new SignalService({
    baseUrl: 'http://signal.test',
    number: '+1000',
    deviceName: 'test',
    pollIntervalMs: 1000,
    qrRefreshMs: 1000
  });
  const sent = await service.normalizeIncomingEvent({
    account: '+1000',
    envelope: {
      syncMessage: {
        sentMessage: {
          timestamp: 1234,
          message: 'Sent elsewhere',
          groupInfo: { groupId: 'signal-group', groupName: 'Signal Group' }
        }
      }
    }
  });
  const selfDelivery = await service.normalizeIncomingEvent({
    envelope: {
      sourceNumber: '+1000',
      dataMessage: {
        timestamp: 1235,
        message: 'Bridge echo',
        groupInfo: { groupId: 'signal-group' }
      }
    }
  });

  assert.equal(sent.text, 'Sent elsewhere');
  assert.equal(sent.senderId, '+1000');
  assert.equal(selfDelivery, null);
});

test('Signal sends disable notifications back to the bridge account', async () => {
  const service = new SignalService({
    baseUrl: 'http://signal.test',
    number: '+1000',
    deviceName: 'test',
    pollIntervalMs: 1000,
    qrRefreshMs: 1000
  });
  let payload;
  service.api.post = async (path, body) => {
    payload = body;
    return { data: { timestamp: 1234 } };
  };

  await service.sendGroupText('group', 'message');
  assert.equal(payload.notify_self, false);
});
