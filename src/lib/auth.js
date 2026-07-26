const crypto = require('crypto');

function createSessionPayload(username) {
  return {
    username,
    csrfToken: crypto.randomBytes(24).toString('hex')
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  next();
}

function requireCsrf(req, res, next) {
  const sessionToken = req.session.user?.csrfToken;
  const headerToken = req.get('x-csrf-token');

  const valid = sessionToken
    && headerToken
    && sessionToken.length === headerToken.length
    && crypto.timingSafeEqual(Buffer.from(sessionToken), Buffer.from(headerToken));

  if (!valid) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return;
  }

  next();
}

function requireSameOrigin(allowedOrigin) {
  const expectedOrigin = new URL(allowedOrigin).origin;

  return function sameOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }

    if (req.get('origin') !== expectedOrigin) {
      res.status(403).json({ error: 'Invalid request origin' });
      return;
    }

    next();
  };
}

function createLoginLimiter({ windowMs = 15 * 60 * 1000, maxAttempts = 10 } = {}) {
  const attempts = new Map();
  let requestsSinceCleanup = 0;

  function loginLimiter(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    req.loginRateLimitKey = key;
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup >= 100) {
      for (const [storedKey, entry] of attempts) {
        if (entry.resetAt <= now) attempts.delete(storedKey);
      }
      requestsSinceCleanup = 0;
    }

    const current = attempts.get(key);

    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (current.count >= maxAttempts) {
      const retryAfterSeconds = Math.ceil((current.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      return;
    }

    current.count += 1;
    next();
  }

  loginLimiter.reset = (req) => attempts.delete(req.loginRateLimitKey);
  return loginLimiter;
}

module.exports = {
  createLoginLimiter,
  createSessionPayload,
  requireAuth,
  requireCsrf,
  requireSameOrigin
};
