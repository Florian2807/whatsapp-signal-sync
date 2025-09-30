const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

module.exports = async function createWhatsAppClient({ sessionDir }) {
  // Einfache Konfiguration basierend auf dem funktionierenden Skript
  const conf = {
    authStrategy: new LocalAuth({ dataPath: sessionDir }),
  };
  
  // Chrome Pfad aus Umgebungsvariable setzen falls vorhanden
  if (process.env.chrome_path) {
    conf.puppeteer = {
      product: 'chrome',
      executablePath: process.env.chrome_path,
    };
  }

  const client = new Client(conf);

  // QR Code anzeigen - genau wie im funktionierenden Skript
  client.on('qr', qr => {
    console.log('QR Code empfangen, bitte mit WhatsApp scannen:');
    qrcode.generate(qr, { small: true });
  });

  // Verbindungsstatus Events - genau wie im funktionierenden Skript
  client.on('ready', () => {
    console.log('WhatsApp Client ist bereit!');
    console.log('📱 Nachrichtenempfang aktiviert - warte auf Nachrichten...');
  });

  client.on('authenticated', () => {
    console.log('WhatsApp authentifiziert');
  });

  client.on('auth_failure', msg => {
    console.error('WhatsApp Authentifizierung fehlgeschlagen:', msg);
  });

  client.on('disconnected', reason => {
    console.log('WhatsApp Client getrennt:', reason);
  });

  
  // Client initialisieren - einfach und direkt
  console.log('🔌 Initialisiere WhatsApp Client...')
  await client.initialize();

  client.sendMediaBuffer = async (to, buffer, filename, mimetype) => {
    try {
      const media = new MessageMedia(
        mimetype || 'application/octet-stream',
        buffer.toString('base64'),
        filename || 'file'
      )
      const id = to.includes('@') ? to : `${to}@c.us`
      console.log(`📤 Sende Medien an ${id}`)
      const result = await client.sendMessage(id, media)
      console.log('✅ Medien erfolgreich gesendet')
      return result
    } catch (error) {
      console.error('❌ Fehler beim Senden der Medien:', error.message)
      throw error
    }
  }

  return client
}