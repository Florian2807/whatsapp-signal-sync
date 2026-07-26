const express = require('express');
const { verifyPassword } = require('../lib/passwords');
const { createSessionPayload, requireAuth, requireCsrf } = require('../lib/auth');

function parseMappingPayload(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Mapping payload must be an object');
  }

  const text = (field, maxLength) => {
    if (typeof body[field] !== 'string') throw badRequest(`${field} must be a string`);
    const value = body[field].trim();
    if (value.length > maxLength) throw badRequest(`${field} is too long`);
    return value;
  };
  const flag = (field) => {
    if (typeof body[field] !== 'boolean') throw badRequest(`${field} must be a boolean`);
    return body[field];
  };

  return {
    name: text('name', 120),
    whatsappGroupId: text('whatsappGroupId', 512),
    whatsappGroupName: text('whatsappGroupName', 256),
    signalGroupId: text('signalGroupId', 512),
    signalGroupInternalId: text('signalGroupInternalId', 512),
    signalGroupName: text('signalGroupName', 256),
    syncWhatsappToSignal: flag('syncWhatsappToSignal'),
    syncSignalToWhatsapp: flag('syncSignalToWhatsapp'),
    syncMedia: flag('syncMedia'),
    prependSender: flag('prependSender'),
    active: flag('active')
  };
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function mappingId(value) {
  if (!/^[1-9]\d*$/.test(value)) throw badRequest('Mapping ID must be a positive integer');
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw badRequest('Mapping ID is out of range');
  return id;
}

function validateMapping(mapping) {
  if (!mapping.name) {
    return 'Mapping name is required';
  }

  if (!mapping.whatsappGroupId) {
    return 'WhatsApp group is required';
  }

  if (!mapping.signalGroupId || !mapping.signalGroupInternalId) {
    return 'Signal group is required';
  }

  if (!mapping.syncWhatsappToSignal && !mapping.syncSignalToWhatsapp) {
    return 'At least one sync direction must be enabled';
  }

  return null;
}

async function safeGroupList(service) {
  if (typeof service.getState === 'function' && service.getState().status !== 'ready') {
    return [];
  }

  try {
    return await service.listGroups();
  } catch (error) {
    console.error(`Group listing failed for ${service.getState?.().provider || 'unknown'}:`, error.message || error);
    return [];
  }
}

module.exports = function createApiRouter({ database, whatsappService, signalService, loginLimiter, cookieSecure }) {
  const router = express.Router();
  const dummyPasswordHash = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

  router.get('/session', (req, res) => {
    const user = req.session.user;
    res.json({
      authenticated: Boolean(user),
      user: user ? { username: user.username } : null,
      csrfToken: user?.csrfToken || null
    });
  });

  router.post('/auth/login', loginLimiter, async (req, res, next) => {
    try {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '');
      if (username.length > 128 || password.length > 256) {
        res.status(400).json({ error: 'Invalid login request' });
        return;
      }
      const user = database.getUserByUsername(username);

      const passwordMatches = await verifyPassword(password, user?.password_hash || dummyPasswordHash);
      if (!user || !passwordMatches) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }

      loginLimiter.reset(req);
      await new Promise((resolve, reject) => {
        req.session.regenerate((error) => error ? reject(error) : resolve());
      });
      req.session.user = createSessionPayload(username);
      res.json({ success: true, user: { username }, csrfToken: req.session.user.csrfToken });
    } catch (error) {
      next(error);
    }
  });

  // Everything below this point is private by default. Unsafe methods also
  // require the per-session CSRF token, even if a route forgets to add it.
  router.use(requireAuth);
  router.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }

    requireCsrf(req, res, next);
  });

  router.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('wa_signal_session', {
        httpOnly: true,
        sameSite: 'strict',
        secure: cookieSecure,
        path: '/'
      });
      res.json({ success: true });
    });
  });

  router.get('/bootstrap', asyncRoute(async (req, res) => {
    const [whatsappGroups, signalGroups] = await Promise.all([
      safeGroupList(whatsappService),
      safeGroupList(signalService)
    ]);

    res.json({
      providers: {
        whatsapp: whatsappService.getState(),
        signal: signalService.getState()
      },
      groups: {
        whatsapp: whatsappGroups,
        signal: signalGroups
      },
      mappings: database.listMappings()
    });
  }));

  router.get('/providers/status', (req, res) => {
    res.json({
      whatsapp: whatsappService.getState(),
      signal: signalService.getState()
    });
  });

  router.post('/providers/signal/refresh', asyncRoute(async (req, res) => {
    await signalService.forceQrRefresh();
    res.json({ success: true, signal: signalService.getState() });
  }));

  router.post('/providers/whatsapp/logout', asyncRoute(async (req, res) => {
    const whatsapp = await whatsappService.logout();
    database.addActivity({
        level: 'info',
        eventType: 'provider.logged_out',
        provider: 'whatsapp',
        sourceId: null,
        targetId: null,
        message: 'Logged out WhatsApp device',
        details: null
    });
    res.json({ success: true, whatsapp });
  }));

  router.post('/providers/signal/logout', asyncRoute(async (req, res) => {
    const signal = await signalService.logout();
    database.addActivity({
        level: 'info',
        eventType: 'provider.logged_out',
        provider: 'signal',
        sourceId: null,
        targetId: null,
        message: 'Unlinked Signal bridge device',
        details: null
    });
    res.json({ success: true, signal });
  }));

  router.get('/groups/whatsapp', asyncRoute(async (req, res) => {
    res.json({ groups: await safeGroupList(whatsappService) });
  }));

  router.get('/groups/signal', asyncRoute(async (req, res) => {
    res.json({ groups: await safeGroupList(signalService) });
  }));

  router.get('/mappings', (req, res) => {
    res.json({ mappings: database.listMappings() });
  });

  router.post('/mappings', (req, res) => {
    try {
      const mapping = parseMappingPayload(req.body);
      const validationError = validateMapping(mapping);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const created = database.createMapping(mapping);
      database.addActivity({
        level: 'info',
        eventType: 'mapping.created',
        provider: 'dashboard',
        sourceId: created.whatsappGroupId,
        targetId: created.signalGroupId,
        message: `Created mapping "${created.name}"`,
        details: { mappingId: created.id }
      });
      res.status(201).json({ success: true, mapping: created });
    } catch (error) {
      if (String(error.message || '').includes('UNIQUE')) {
        res.status(409).json({ error: 'This WhatsApp and Signal group pair already exists' });
        return;
      }

      throw error;
    }
  });

  router.put('/mappings/:id', (req, res) => {
    try {
      const mapping = parseMappingPayload(req.body);
      const validationError = validateMapping(mapping);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const updated = database.updateMapping(mappingId(req.params.id), mapping);
      if (!updated) {
        res.status(404).json({ error: 'Mapping not found' });
        return;
      }

      database.addActivity({
        level: 'info',
        eventType: 'mapping.updated',
        provider: 'dashboard',
        sourceId: updated.whatsappGroupId,
        targetId: updated.signalGroupId,
        message: `Updated mapping "${updated.name}"`,
        details: { mappingId: updated.id }
      });
      res.json({ success: true, mapping: updated });
    } catch (error) {
      if (String(error.message || '').includes('UNIQUE')) {
        res.status(409).json({ error: 'This WhatsApp and Signal group pair already exists' });
        return;
      }

      throw error;
    }
  });

  router.delete('/mappings/:id', (req, res) => {
    const existing = database.getMappingById(mappingId(req.params.id));
    if (!existing) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    database.deleteMapping(existing.id);
    database.addActivity({
      level: 'info',
      eventType: 'mapping.deleted',
      provider: 'dashboard',
      sourceId: existing.whatsappGroupId,
      targetId: existing.signalGroupId,
      message: `Deleted mapping "${existing.name}"`,
      details: { mappingId: existing.id }
    });
    res.json({ success: true });
  });

  router.get('/activity', (req, res) => {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 100;
    res.json({ activity: database.listActivity(limit) });
  });

  router.use((req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  router.use((error, req, res, next) => {
    const status = error.statusCode || 500;
    if (status >= 500) {
      console.error('API request failed:', error);
    }
    res.status(status).json({
      error: status >= 500 ? 'Unexpected server error' : error.message || 'Request failed'
    });
  });

  return router;
};
