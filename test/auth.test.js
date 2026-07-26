const assert = require('node:assert/strict');
const test = require('node:test');
const { createLoginLimiter, requireCsrf, requireSameOrigin } = require('../src/lib/auth');

function response() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    set(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

test('login limiter blocks repeated attempts and can reset a successful client', () => {
  const limiter = createLoginLimiter({ windowMs: 60000, maxAttempts: 2 });
  const req = { ip: '127.0.0.1' };
  assert.doesNotThrow(() => limiter(req, response(), () => {}));
  assert.doesNotThrow(() => limiter(req, response(), () => {}));

  const blocked = response();
  limiter(req, blocked, () => assert.fail('blocked request called next'));
  assert.equal(blocked.statusCode, 429);

  limiter.reset(req);
  let allowed = false;
  limiter(req, response(), () => { allowed = true; });
  assert.equal(allowed, true);
});

test('CSRF middleware requires the session token', () => {
  const req = {
    session: { user: { csrfToken: 'a'.repeat(48) } },
    get: (name) => name === 'x-csrf-token' ? 'a'.repeat(48) : undefined
  };
  let allowed = false;
  requireCsrf(req, response(), () => { allowed = true; });
  assert.equal(allowed, true);

  const denied = response();
  requireCsrf({ ...req, get: () => 'wrong' }, denied, () => {});
  assert.equal(denied.statusCode, 403);
});

test('origin guard rejects unsafe cross-origin requests', () => {
  const guard = requireSameOrigin('https://bridge.example');
  const denied = response();
  guard({ method: 'POST', get: () => 'https://attacker.example' }, denied, () => {});
  assert.equal(denied.statusCode, 403);

  let allowed = false;
  guard({ method: 'POST', get: () => 'https://bridge.example' }, response(), () => { allowed = true; });
  assert.equal(allowed, true);
});
