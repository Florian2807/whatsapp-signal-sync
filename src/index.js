require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const createWhatsAppClient = require('./waClient');
const createSignalClient = require('./signalClient');
const setupBridge = require('./bridge-groups'); // Using groups bridge

const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || path.resolve(__dirname, '..', 'sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

async function main() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  console.log(`🚀 Starting WhatsApp-Signal GROUP Bridge...`);
  console.log(`📱 WhatsApp Client: Real`);
  console.log(`📁 Session Directory: ${SESSION_DIR}`);

  const wa = await createWhatsAppClient({ sessionDir: SESSION_DIR });
  const signal = createSignalClient({ 
    baseUrl: process.env.SIGNAL_API_URL, 
    number: process.env.SIGNAL_NUMBER 
  });

  // Setup bridge endpoints and logic
  setupBridge({ app, wa, signal });

  app.get('/', (req, res) => {
    res.json({
      service: 'wa-signal-group-bridge',
      status: 'running',
      mode: 'production',
      endpoints: [
        'GET /health - Service health',
        'GET /groups/whatsapp - List WhatsApp groups',
        'GET /groups/signal - List Signal groups', 
        'GET /groups/mappings - Show group mappings',
        'POST /groups/mappings - Add group mapping',
        'POST /send/whatsapp/group - Send to WhatsApp group',
        'POST /send/signal/group - Send to Signal group',
        'POST /signal/webhook - Signal webhook'
      ]
    });
  });

  app.listen(PORT, () => {
    console.log(`🌐 Server listening on http://localhost:${PORT}`);
    console.log(`📋 Visit http://localhost:${PORT} for API documentation`);
    console.log(`🔍 Health check: http://localhost:${PORT}/health`);
    console.log(`📱 WhatsApp groups: http://localhost:${PORT}/groups/whatsapp`);
    console.log(`💬 Signal groups: http://localhost:${PORT}/groups/signal`);
    console.log(`🔗 Group mappings: http://localhost:${PORT}/groups/mappings`);
  });
}

main().catch(err => { 
  console.error('❌ Error starting application:', err); 
  process.exit(1); 
});