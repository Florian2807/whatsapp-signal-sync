const DEFAULT_TIMEOUT_MS = 15000;

export function createDashboardApi({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onUnauthorized = () => window.location.replace('/login')
} = {}) {
  let csrfToken = null;
  let redirecting = false;
  const requestVersions = new Map();

  async function request(path, options = {}) {
    const method = options.method || 'GET';
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
          ...(options.headers || {})
        },
        credentials: 'same-origin',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));

      if (response.status === 401) {
        csrfToken = null;
        if (!redirecting) {
          redirecting = true;
          onUnauthorized();
        }
        throw new Error('Your session expired. Sign in again to continue.');
      }

      if (!response.ok) {
        throw new Error(payload.error || 'The server could not complete this request.');
      }

      return payload;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('The request timed out. Check the connection and try again.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function establishSession() {
    const session = await request('/api/session');
    if (!session.authenticated) {
      if (!redirecting) {
        redirecting = true;
        onUnauthorized();
      }
      return false;
    }

    csrfToken = session.csrfToken;
    return true;
  }

  async function latest(key, operation) {
    const version = (requestVersions.get(key) || 0) + 1;
    requestVersions.set(key, version);

    try {
      const value = await operation();
      return requestVersions.get(key) === version ? { value, stale: false } : { stale: true };
    } catch (error) {
      if (requestVersions.get(key) !== version) {
        return { stale: true };
      }
      throw error;
    }
  }

  function invalidate(...keys) {
    for (const key of keys) {
      requestVersions.set(key, (requestVersions.get(key) || 0) + 1);
    }
  }

  function clearSession() {
    csrfToken = null;
  }

  function hasSession() {
    return Boolean(csrfToken);
  }

  return { request, establishSession, latest, invalidate, clearSession, hasSession };
}
