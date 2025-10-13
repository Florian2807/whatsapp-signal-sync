# WhatsApp-Signal Sync Bridge

A bridge service that synchronizes messages between WhatsApp and Signal groups, allowing seamless communication across both platforms.

## 🚀 Quick Start

This tool provides an automated setup script that handles the entire installation process.

### Prerequisites

- **Docker & Docker Compose** - For Signal API service
- **Node.js & npm** - For the bridge service
- **Linux/macOS** - Recommended environment

### Installation

1. **Clone the repository:**
```bash
git clone https://github.com/Florian2807/whatsapp-signal-sync.git
cd whatsapp-signal-sync
```

2. **Run the automated setup:**
```bash
chmod +x ./setup.sh
./setup.sh
```

The setup script will:
- ✅ Check all prerequisites
- ✅ Configure environment variables
- ✅ Install Node.js dependencies
- ✅ Start Docker services (Signal API)
- ✅ Guide you through Signal account setup
- ✅ Prepare group mapping configuration

3. **Follow the Signal setup:**
   - Choose between QR code linking (existing account) or SMS registration (new account)
   - For QR code: Scan with Signal app → Settings → Linked devices
   - For SMS: Enter captcha from https://signalcaptchas.org and verification code

4. **Start the bridge service:**
```bash
npm start
```

## 📱 Configuration

After setup, configure your group mappings:

1. **Get WhatsApp groups:**
```bash
curl http://localhost:3000/api/groups/whatsapp
```

2. **Get Signal groups:**
```bash
curl http://localhost:3000/api/groups/signal
```

3. **Edit group mappings:**
```bash
nano group-mappings.json
```

Example configuration:
```json
{
  "mappings": [
    {
      "whatsapp": "123456789@g.us",
      "signal": "group-id"
    }
  ]
}
```

4. **Restart the service:**
```bash
npm start
```

## 🔧 Service Management

- **Start service:** `npm start`
- **Stop service:** `Ctrl+C` or `pkill -f 'node src/index.js'`
- **Check status:** `curl http://localhost:3000/health`
- **Service management:** `./manage-service.sh [start|stop|restart|status]`

## 📋 API Endpoints

- **Health check:** `GET /health`
- **WhatsApp groups:** `GET /api/groups/whatsapp`
- **Signal groups:** `GET /api/groups/signal`
- **Service status:** `GET /api/status`

## 🛠️ Troubleshooting

### Common Issues

1. **Signal registration fails:** Re-run `./setup.sh` and try the other registration method
2. **WhatsApp not connecting:** Scan the QR code again when prompted
3. **Group IDs not found:** Ensure both WhatsApp and Signal are connected before fetching groups

### Port Configuration

Default ports can be changed in `.env`:
```bash
PORT=3000                           # Bridge service port
SIGNAL_API_URL=http://localhost:8080 # Signal API URL
```

## 🔐 Security

- Keep your `.env` file secure (contains Signal phone number)
- Group mappings are stored locally in `group-mappings.json`
- WhatsApp session data is stored in `.wwebjs_cache/`
- Signal data is stored in `signal-data/`

## 📚 Project Structure

```
├── src/                    # Bridge service source code
├── docker-compose.yml      # Signal API container
├── setup.sh               # Automated setup script
├── manage-service.sh      # Service management helper
├── group-mappings.json    # Group synchronization config
└── .env                   # Environment variables
```

## 📄 License

This project is licensed under the MIT License.

---

**Note:** This bridge runs locally and requires both WhatsApp Web and Signal accounts to be properly configured. Messages are synchronized in real-time between mapped groups.