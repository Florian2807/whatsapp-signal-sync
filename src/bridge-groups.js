const multer = require('multer');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');

// Configure multer for handling multipart/form-data
const upload = multer();

// Load group mappings
function loadGroupMappings() {
  try {
    const configPath = process.env.GROUP_CONFIG_FILE || './group-mappings.json';
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.groupMappings || {};
    }
    
    return {};
  } catch (error) {
    console.error('Error loading group mappings:', error);
    return {};
  }
}

module.exports = function setupBridge({ app, wa, signal }) {
  console.log('Setting up WhatsApp <-> Signal GROUP bridge...');
  
  const groupMappings = loadGroupMappings();
  console.log('Loaded group mappings:', Object.keys(groupMappings).length, 'groups');
  
  // --- WhatsApp -> Signal (group message listener) ---
  wa.on('message', async (msg) => {
    try {
      // Skip own messages and status updates
      if (msg.fromMe || msg.isStatus) return;

      const chat = await msg.getChat();
      const contact = await msg.getContact();
      
      // Only process group messages that are mapped
      if (!chat.isGroup) {
        console.log('Skipping non-group message from:', contact.pushname || contact.number);
        return;
      }
      
      const waGroupId = chat.id._serialized;
      const signalGroupMapping = groupMappings[waGroupId];
      
      if (!signalGroupMapping) {
        console.log(`No Signal mapping found for WhatsApp group: ${chat.name} (${waGroupId})`);
        return;
      }

      const signalGroupId = signalGroupMapping.signalGroupId;
      const senderName = contact.pushname || contact.name || contact.number || 'Unknown';
      
      console.log(`Forwarding from WA group "${chat.name}" to Signal group "${signalGroupId}"`);
      console.log(`Message from ${senderName}: ${msg.body}`);

      const messagePrefix = process.env.MESSAGE_PREFIX || '🟢';
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

  // --- Signal -> WhatsApp (webhook endpoint for groups) ---
  app.post('/signal/webhook', upload.none(), async (req, res) => {
    try {
      const event = req.body || {};
      
      // Extract Signal group message data
      let from = event.source || (event.envelope && event.envelope.source) || event.from || null;
      let text = event.message || 
                 (event.envelope && event.envelope.dataMessage && event.envelope.dataMessage.message) || 
                 null;
      let groupId = event.groupId || 
                   (event.envelope && event.envelope.dataMessage && event.envelope.dataMessage.groupInfo && event.envelope.dataMessage.groupInfo.groupId) ||
                   null;
      
      const attachments = event.attachments || 
                         (event.envelope && event.envelope.dataMessage && event.envelope.dataMessage.attachments) || 
                         null;

      if (!from) {
        console.warn('Signal webhook: could not find source in payload', Object.keys(req.body));
        return res.status(400).send('no source');
      }

      // Find WhatsApp group that maps to this Signal group
      const waGroupId = Object.keys(groupMappings).find(key => 
        groupMappings[key].signalGroupId === groupId
      );

      if (!waGroupId) {
        console.warn(`No WhatsApp group mapping found for Signal group: ${groupId}`);
        return res.status(404).send('no mapping found');
      }

      console.log(`Forwarding from Signal group "${groupId}" to WhatsApp group "${waGroupId}"`);

      const messagePrefix = process.env.MESSAGE_PREFIX || '[SIG]';
      const header = `${messagePrefix} ${from}: `;
      
      // Send text message if exists
      if (text) {
        await wa.sendMessage(waGroupId, header + text);
      }

      // Handle attachments
      if (attachments && Array.isArray(attachments)) {
        for (const attachment of attachments) {
          try {
            if (attachment.data) {
              const buf = Buffer.from(attachment.data, 'base64');
              const media = new MessageMedia(
                attachment.mimetype || 'application/octet-stream',
                buf.toString('base64'),
                attachment.filename || 'file'
              );
              await wa.sendMessage(waGroupId, media);
            } else if (attachment.url) {
              console.warn('URL attachments not yet implemented:', attachment.url);
              await wa.sendMessage(waGroupId, header + `[Attachment: ${attachment.url}]`);
            }
          } catch (attachmentErr) {
            console.error('Error forwarding attachment Signal->WA:', attachmentErr);
          }
        }
      }

      console.log('Successfully forwarded Signal group message to WhatsApp');
      res.json({ ok: true });
    } catch (err) {
      console.error('Error processing signal group webhook:', err);
      res.status(500).json({ error: (err.message || String(err)) });
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
      const { whatsappGroupId, signalGroupId, name, description } = req.body;
      
      if (!whatsappGroupId || !signalGroupId) {
        return res.status(400).json({ error: 'whatsappGroupId and signalGroupId are required' });
      }

      groupMappings[whatsappGroupId] = {
        signalGroupId,
        name: name || 'Unnamed Group',
        description: description || 'No description'
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
