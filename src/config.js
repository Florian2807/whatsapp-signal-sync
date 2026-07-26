const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function boolean(name) {
  const value = required(name);
  if (!['true', 'false'].includes(value)) {
    throw new Error(`${name} must be true or false`);
  }
  return value === 'true';
}

module.exports = {
  port: 3000,
  sessionDir: path.join(ROOT_DIR, 'sessions'),
  publicDir: path.join(ROOT_DIR, 'public'),
  dataDir: DATA_DIR,
  databasePath: path.join(DATA_DIR, 'app.db'),
  sessionStoreDir: path.join(DATA_DIR, 'web-sessions'),
  chromePath: required('CHROME_PATH'),
  signal: {
    baseUrl: 'http://signal-api:8080',
    number: required('SIGNAL_NUMBER'),
    deviceName: required('SIGNAL_DEVICE_NAME')
  },
  auth: {
    username: required('ADMIN_USERNAME'),
    password: required('ADMIN_PASSWORD'),
    sessionSecret: required('SESSION_SECRET'),
    secureCookies: boolean('COOKIE_SECURE'),
    trustProxy: boolean('TRUST_PROXY')
  },
  app: {
    origin: required('APP_ORIGIN'),
    pollIntervalMs: positiveInteger('SIGNAL_STATUS_POLL_MS'),
    signalQrRefreshMs: positiveInteger('SIGNAL_QR_REFRESH_MS'),
    bridgeQueue: {
      maxAttempts: optionalPositiveInteger('BRIDGE_RETRY_MAX_ATTEMPTS', 10),
      maxAgeMs: optionalPositiveInteger('BRIDGE_PENDING_MAX_AGE_MS', 24 * 60 * 60 * 1000),
      maxBytes: optionalPositiveInteger('BRIDGE_QUEUE_MAX_BYTES', 256 * 1024 * 1024),
      deadLetterMaxAgeMs: optionalPositiveInteger('BRIDGE_DEAD_LETTER_MAX_AGE_MS', 7 * 24 * 60 * 60 * 1000)
    }
  }
};
