# WhatsApp Signal Sync

Docker Compose-hosted bridge for synchronizing mapped WhatsApp and Signal groups through a secured admin dashboard.

## Features

- bidirectional text and media forwarding
- WhatsApp voice-message conversion to Signal-compatible MP3
- reply preservation between WhatsApp and Signal
- configurable message direction, sender labels, media, and mapping state
- QR pairing, group discovery, activity history, and provider controls
- authenticated dashboard with session, origin, CSRF, and login-rate protection

WhatsApp integration uses the unofficial `whatsapp-web.js` client. Signal integration uses `signal-cli-rest-api` as a linked device.

## Run

Docker and Docker Compose are the only host requirements.

1. Create the deployment configuration:

```bash
cp .env.example .env
```

2. Set `ADMIN_PASSWORD`, `SESSION_SECRET`, and `SIGNAL_NUMBER` in `.env`.

Generate secure credentials with:

```bash
openssl rand -base64 24
openssl rand -hex 48
```

3. Start the stack:

```bash
docker compose up -d --build
```

4. Open the configured `APP_ORIGIN`, sign in, pair both providers, and create mappings.

Useful commands:

```bash
docker compose logs -f app signal-api
docker compose restart
docker compose down
```

## Configuration

`.env` is the single source for deployment settings. Keep `HOST_PORT` and the port in `APP_ORIGIN` synchronized.

The dashboard binds to host loopback only. For remote access, place it behind an HTTPS reverse proxy, set `APP_ORIGIN` to the exact public origin, and set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.

The application refuses to start with missing configuration, a weak admin password, or an invalid session secret.

## Persistent Data

Docker Compose stores all runtime state under `data/`:

- `data/app/`: database and dashboard sessions
- `data/whatsapp/`: WhatsApp browser authentication
- `data/signal/`: Signal linked-device identity

Back up the complete `data/` directory. Deleting `data/whatsapp/` or `data/signal/` requires pairing the corresponding provider again.

The Signal REST API is available only inside the Compose network. The dashboard is published on `127.0.0.1` at `HOST_PORT`.
