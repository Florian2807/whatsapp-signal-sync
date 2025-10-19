const express = require('express');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(process.env.GROUP_CONFIG_FILE || './group-mappings.json', 'utf8'));

// Load group mappings
function loadGroupMappings() {
  try {
    if (config && config.groupMappings) {
      return config.groupMappings || {};
    }

    return {};
  } catch (error) {
    console.error('Error loading group mappings:', error);
    return {};
  }
}

module.exports = function setupBridge({ app, wa, signal }) {
  const groupMappings = loadGroupMappings();
  console.log('Loaded group mappings:', Object.keys(groupMappings).length, 'groups');

  wa.on('message', async (msg) => {
    try {
      if (msg.fromMe || msg.isStatus) return;

      const chat = await msg.getChat();
      const contact = await msg.getContact();

      const waGroupId = chat.id._serialized;
      const signalGroupMapping = groupMappings[waGroupId];

      if (!signalGroupMapping) {
        return;
      }

      const signalGroupId = signalGroupMapping.signalGroupId;
      const senderName = contact.pushname || contact.name || contact.number || 'Unknown';

      console.log(`Forwarding Message: ${signalGroupId.name}`);
      console.log(`Message from ${senderName}: ${msg.body}`);

      const messagePrefix = config.settings.MESSAGE_PREFIX || '🟢';
      const header = `${messagePrefix} ${senderName}:\n `;

      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            const buffer = Buffer.from(media.data, 'base64');
            await signal.sendGroupAttachment(signalGroupId, buffer, media.filename || 'file', media.mimetype);

            // Send caption if exists
            if (msg.body) {
              await signal.sendGroupText(signalGroupId, header + msg.body);
            }
          }
        } catch (mediaErr) {
          console.error('Error forwarding group media WA->Signal:', mediaErr);
          await signal.sendGroupText(signalGroupId, header + '[Media could not be forwarded]');
        }
      } else if (msg.body) {
        await signal.sendGroupText(signalGroupId, header + msg.body);
      }

      await chat.sendSeen();

      console.log(`Successfully forwarded message from WA group "${chat.name}" to Signal`);
    } catch (err) {
      console.error('Error forwarding WA group message to Signal:', err.message || err);
    }
  });

  // Group management endpoints
  app.get('/groups/whatsapp', async (req, res) => {
    try {
      const chats = await wa.getChats();
      const groups = chats.filter(chat => chat.isGroup).map(group => ({
        id: group.id._serialized,
        name: group.name,
        participants: group.participants.length,
        mapped: !!groupMappings[group.id._serialized]
      }));
      res.json({ groups });
    } catch (err) {
      console.error('Error fetching WhatsApp groups:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/groups/signal', async (req, res) => {
    try {
      const groups = await signal.getGroups();
      res.json({ groups });
    } catch (err) {
      console.error('Error fetching Signal groups:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/groups/mappings', (req, res) => {
    res.json({
      mappings: groupMappings,
      count: Object.keys(groupMappings).length
    });
  });

  app.post('/groups/mappings', express.json(), (req, res) => {
    try {
      const { whatsappGroupId, signalGroupId, name } = req.body;

      if (!whatsappGroupId || !signalGroupId) {
        return res.status(400).json({ error: 'whatsappGroupId and signalGroupId are required' });
      }

      groupMappings[whatsappGroupId] = {
        signalGroupId,
        name: name || 'Unnamed Group',
      };

      // Save to config file
      const configPath = process.env.GROUP_CONFIG_FILE || './group-mappings.json';
      const config = {
        groupMappings,
        settings: {
          enableGroupSync: true,
          forwardUserNames: true,
          messagePrefix: process.env.MESSAGE_PREFIX || '[WA]',
          enableMediaSync: true,
          logGroupMessages: true
        }
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      res.json({
        success: true,
        message: 'Group mapping added successfully',
        mapping: groupMappings[whatsappGroupId]
      });
    } catch (err) {
      console.error('Error adding group mapping:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Manual send endpoints for testing groups
  app.post('/send/whatsapp/group', express.json(), async (req, res) => {
    try {
      const { groupId, text } = req.body;
      if (!groupId || !text) {
        return res.status(400).json({ error: 'groupId and text are required' });
      }

      await wa.sendMessage(groupId, text);
      res.json({ success: true, message: 'Message sent to WhatsApp group' });
    } catch (err) {
      console.error('Error sending to WhatsApp group:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/send/signal/group', express.json(), async (req, res) => {
    try {
      const { groupId, text } = req.body;
      if (!groupId || !text) {
        return res.status(400).json({ error: 'groupId and text are required' });
      }

      await signal.sendGroupText(groupId, text);
      res.json({ success: true, message: 'Message sent to Signal group' });
    } catch (err) {
      console.error('Error sending to Signal group:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      waReady: wa.info ? true : false,
      signalBase: signal.baseUrl,
      groupMappings: Object.keys(groupMappings).length,
      timestamp: new Date().toISOString()
    });
  });

  console.log('GROUP Bridge setup completed');
  console.log(`Monitoring ${Object.keys(groupMappings).length} WhatsApp <-> Signal group pairs`);
};
