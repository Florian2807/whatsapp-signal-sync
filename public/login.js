const form = document.getElementById('login-form');
const username = document.getElementById('login-username');
const password = document.getElementById('login-password');
const button = document.getElementById('login-button');
const errorMessage = document.getElementById('login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.textContent = '';
  button.disabled = true;
  button.textContent = 'Signing in...';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: username.value, password: password.value }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || 'Sign in failed');
    }

    password.value = '';
    window.location.replace('/');
  } catch (error) {
    errorMessage.textContent = controller.signal.aborted
      ? 'Sign in timed out. Check the connection and try again.'
      : error.message;
    button.disabled = false;
    button.textContent = 'Sign in';
  } finally {
    window.clearTimeout(timeout);
  }
});
