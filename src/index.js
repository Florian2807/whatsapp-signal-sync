const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const FileStoreFactory = require('session-file-store');

const config = require('./config');
const AppDatabase = require('./lib/database');
const { hashPassword, verifyPassword } = require('./lib/passwords');
const { createLoginLimiter, requireAuth, requireSameOrigin } = require('./lib/auth');
const createApiRouter = require('./routes/api');
const WhatsAppService = require('./services/whatsappService');
const SignalService = require('./services/signalService');
const BridgeService = require('./services/bridgeService');

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.chmodSync(dirPath, 0o700);
}

function validateSecurityConfig() {
  const weakPasswords = new Set(['admin', 'password', 'change-me-now', 'changeme', '123456']);
  if (!config.auth.password || config.auth.password.length < 14 || weakPasswords.has(config.auth.password.toLowerCase())) {
    throw new Error('ADMIN_PASSWORD must be at least 14 characters and must not be a common placeholder');
  }

  if (!config.auth.sessionSecret || config.auth.sessionSecret.length < 48 || config.auth.sessionSecret.startsWith('change-')) {
    throw new Error('SESSION_SECRET must be a random value of at least 48 characters');
  }

  if (!config.app.origin) {
    throw new Error('APP_ORIGIN is required for same-origin request protection');
  }

  const origin = new URL(config.app.origin);
  if (!['http:', 'https:'].includes(origin.protocol)) {
    throw new Error('APP_ORIGIN must use http or https');
  }

  if (origin.protocol === 'https:' && !config.auth.secureCookies) {
    throw new Error('COOKIE_SECURE must be true when APP_ORIGIN uses https');
  }
}

async function syncAdmin(database) {
  const existing = database.getUserByUsername(config.auth.username);
  if (!existing || !(await verifyPassword(config.auth.password, existing.password_hash))) {
    const passwordHash = await hashPassword(config.auth.password);
    database.upsertUser(config.auth.username, passwordHash);
  }

  database.deleteUsersExcept(config.auth.username);
}

function logProviderState(database, provider, state) {
  database.addActivity({
    level: state.status === 'error' ? 'error' : 'info',
    eventType: 'provider.state_changed',
    provider,
    sourceId: null,
    targetId: null,
    message: `${provider === 'whatsapp' ? 'WhatsApp' : 'Signal'} status changed to ${state.status}`,
    details: { lastError: state.lastError }
  });
}

async function main() {
  validateSecurityConfig();
  ensureDirectory(config.sessionDir);
  ensureDirectory(config.dataDir);
  ensureDirectory(config.sessionStoreDir);

  const database = await AppDatabase.create(config.databasePath);
  database.initialize();
  await syncAdmin(database);
  const maintenanceTimer = setInterval(() => database.cleanup(), 6 * 60 * 60 * 1000);
  maintenanceTimer.unref();

  const app = express();
  const FileStore = FileStoreFactory(session);
  const sessionSecret = config.auth.sessionSecret;

  if (config.auth.trustProxy) {
    app.set('trust proxy', 1);
  }

  app.use(helmet({
    strictTransportSecurity: config.auth.secureCookies ? {
      maxAge: 31536000,
      includeSubDomains: true
    } : false,
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:'],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'upgrade-insecure-requests': null
      }
    }
  }));
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use(session({
    name: 'wa_signal_session',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new FileStore({ path: config.sessionStoreDir, logFn: () => {} }),
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.auth.secureCookies,
      path: '/',
      priority: 'high',
      maxAge: 1000 * 60 * 60 * 12
    }
  }));

  const whatsappService = new WhatsAppService({
    sessionDir: config.sessionDir,
    chromePath: config.chromePath
  });
  const signalService = new SignalService({
    baseUrl: config.signal.baseUrl,
    number: config.signal.number,
    deviceName: config.signal.deviceName,
    pollIntervalMs: config.app.pollIntervalMs,
    qrRefreshMs: config.app.signalQrRefreshMs
  });
  const bridgeService = new BridgeService({
    database,
    whatsappService,
    signalService,
    queuePolicy: config.app.bridgeQueue
  });
  bridgeService.attach();

  whatsappService.on('stateChanged', (state) => logProviderState(database, 'whatsapp', state));
  signalService.on('stateChanged', (state) => logProviderState(database, 'signal', state));

  await Promise.all([
    whatsappService.start(),
    signalService.start()
  ]);
  await bridgeService.start();

  app.get('/health', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      status: 'ok'
    });
  });

  app.use('/api', requireSameOrigin(config.app.origin), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, createApiRouter({
    database,
    whatsappService,
    signalService,
    loginLimiter: createLoginLimiter({ maxAttempts: 5 }),
    cookieSecure: config.auth.secureCookies
  }));

  app.get(['/login', '/login.html'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.session.user) {
      res.redirect(303, '/');
      return;
    }
    res.sendFile(path.join(config.publicDir, 'login.html'));
  });
  app.get('/login.js', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(config.publicDir, 'login.js'));
  });
  app.get('/styles.css', (req, res) => {
    res.sendFile(path.join(config.publicDir, 'styles.css'));
  });

  app.use((req, res, next) => {
    if (req.session.user) {
      res.set('Cache-Control', 'no-store');
      next();
      return;
    }

    if (req.method === 'GET' && req.accepts('html')) {
      res.redirect(303, '/login');
      return;
    }

    res.status(401).json({ error: 'Authentication required' });
  });
  app.use(express.static(config.publicDir, { index: false, dotfiles: 'deny' }));
  app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  const server = app.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    clearInterval(maintenanceTimer);
    const serverClosed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();
    const drain = (async () => {
      await bridgeService.stop();
      await Promise.allSettled([whatsappService.stop(), signalService.stop()]);
      await serverClosed;
    })();
    const graceful = await Promise.race([
      drain.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 8000))
    ]);
    if (!graceful) {
      console.warn('Graceful shutdown timed out; closing active HTTP connections');
      server.closeAllConnections?.();
      return;
    }
    database.close();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
  process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
}

main().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
