import { createDashboardApi } from './dashboard-api.js';

const state = {
  mappings: [],
  whatsappGroups: [],
  signalGroups: [],
  activity: [],
  pollTimer: null,
  pollInFlight: false,
  groupsOpen: false,
  activityOpen: false,
  editorDirection: 'both',
  editorAutoName: true,
  savingMapping: false,
  messageTimer: null,
  pendingProviders: new Set()
};

const dashboardApi = createDashboardApi({
  onUnauthorized: () => {
    stopPolling();
    window.location.replace('/login');
  }
});
const api = dashboardApi.request;

const elements = {
  startupView: document.getElementById('startup-view'),
  startupMessage: document.getElementById('startup-message'),
  startupRetryButton: document.getElementById('startup-retry-button'),
  dashboardView: document.getElementById('dashboard-view'),
  logoutButton: document.getElementById('logout-button'),
  refreshButton: document.getElementById('refresh-button'),
  globalMessage: document.getElementById('global-message'),
  whatsappLogoutButton: document.getElementById('whatsapp-logout-button'),
  signalRefreshButton: document.getElementById('signal-refresh-button'),
  signalLogoutButton: document.getElementById('signal-logout-button'),
  mappingForm: document.getElementById('mapping-form'),
  mappingId: document.getElementById('mapping-id'),
  mappingName: document.getElementById('mapping-name'),
  whatsappGroup: document.getElementById('whatsapp-group'),
  signalGroup: document.getElementById('signal-group'),
  directionControl: document.getElementById('direction-control'),
  toggleMedia: document.getElementById('toggle-media'),
  toggleSender: document.getElementById('toggle-sender'),
  toggleActive: document.getElementById('toggle-active'),
  mappingResetButton: document.getElementById('mapping-reset-button'),
  mappingSubmitButton: document.getElementById('mapping-submit-button'),
  mappingError: document.getElementById('mapping-error'),
  editorTitle: document.getElementById('editor-title'),
  editorSubtitle: document.getElementById('editor-subtitle'),
  editorState: document.getElementById('editor-state'),
  previewWhatsapp: document.getElementById('preview-whatsapp'),
  previewSignal: document.getElementById('preview-signal'),
  previewDirection: document.getElementById('preview-direction'),
  previewOptions: document.getElementById('preview-options'),
  mappingsList: document.getElementById('mappings-list'),
  whatsappGroupsList: document.getElementById('whatsapp-groups-list'),
  signalGroupsList: document.getElementById('signal-groups-list'),
  activityList: document.getElementById('activity-list'),
  whatsappStatusPill: document.getElementById('whatsapp-status-pill'),
  whatsappSummaryPill: document.getElementById('whatsapp-summary-pill'),
  whatsappStatusText: document.getElementById('whatsapp-status-text'),
  whatsappQrWrap: document.getElementById('whatsapp-qr-wrap'),
  whatsappQr: document.getElementById('whatsapp-qr'),
  signalStatusPill: document.getElementById('signal-status-pill'),
  signalSummaryPill: document.getElementById('signal-summary-pill'),
  signalStatusText: document.getElementById('signal-status-text'),
  signalQrWrap: document.getElementById('signal-qr-wrap'),
  signalQr: document.getElementById('signal-qr'),
  groupsToggle: document.getElementById('groups-toggle'),
  groupsPanel: document.getElementById('groups-panel'),
  activityToggle: document.getElementById('activity-toggle'),
  activityPanel: document.getElementById('activity-panel')
};

function showMessage(text, type = 'info', { hideAfter = 0 } = {}) {
  if (state.messageTimer) {
    window.clearTimeout(state.messageTimer);
    state.messageTimer = null;
  }

  if (!text) {
    elements.globalMessage.className = 'banner hidden';
    elements.globalMessage.textContent = '';
    return;
  }

  elements.globalMessage.className = `banner banner-${type}`;
  elements.globalMessage.textContent = text;
  elements.globalMessage.setAttribute('role', type === 'error' ? 'alert' : 'status');
  elements.globalMessage.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

  if (hideAfter) {
    const displayedText = text;
    state.messageTimer = window.setTimeout(() => {
      if (elements.globalMessage.textContent === displayedText) showMessage('');
    }, hideAfter);
  }
}

function setButtonPending(button, pending, pendingText) {
  if (pending) {
    button.dataset.idleText = button.textContent;
    button.textContent = pendingText;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    return;
  }

  button.textContent = button.dataset.idleText || button.textContent;
  delete button.dataset.idleText;
  button.disabled = false;
  button.removeAttribute('aria-busy');
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTimestamp(value) {
  if (!value) {
    return 'Not connected yet';
  }

  return new Date(value).toLocaleString();
}

function providerDescription(providerState) {
  if (providerState?.lastError) {
    return providerState.lastError;
  }

  if (providerState?.qrCodeDataUrl) {
    return 'Waiting for device pairing.';
  }

  if (providerState?.status === 'ready') {
    const connectedText = providerState.connectedAt ? `Connected ${formatTimestamp(providerState.connectedAt)}` : 'Connected';
    return providerState.mode ? `${connectedText} • ${providerState.mode}` : connectedText;
  }

  return `Status: ${(providerState?.status || 'unknown').replaceAll('_', ' ')}`;
}

function renderProvider(providerName, providerState) {
  const prefix = providerName === 'whatsapp' ? 'whatsapp' : 'signal';
  const pill = elements[`${prefix}StatusPill`];
  const summaryPill = elements[`${prefix}SummaryPill`];
  const text = elements[`${prefix}StatusText`];
  const qr = elements[`${prefix}Qr`];
  const qrWrap = elements[`${prefix}QrWrap`];
  const status = providerState?.status || 'unknown';
  const statusText = status.replaceAll('_', ' ');
  const pillClass = `pill pill-${status}`;

  pill.textContent = statusText;
  pill.className = pillClass;
  summaryPill.textContent = statusText;
  summaryPill.className = pillClass;
  text.textContent = providerDescription(providerState);

  if (providerState?.qrCodeDataUrl) {
    qr.src = providerState.qrCodeDataUrl;
    qrWrap.classList.remove('hidden');
  } else {
    qr.removeAttribute('src');
    qrWrap.classList.add('hidden');
  }

  const logoutButton = providerName === 'whatsapp'
    ? elements.whatsappLogoutButton
    : elements.signalLogoutButton;
  logoutButton.disabled = state.pendingProviders.has(providerName)
    || !['ready', 'authenticated'].includes(status);

  if (providerName === 'signal') {
    elements.signalRefreshButton.classList.toggle('hidden', status === 'ready');
  }
}

function editingMapping() {
  const mappingId = Number(elements.mappingId.value);
  return state.mappings.find((mapping) => mapping.id === mappingId);
}

function renderGroupOptions(selectedValues = {}) {
  const currentWhatsappValue = selectedValues.whatsapp ?? elements.whatsappGroup.value;
  const currentSignalValue = selectedValues.signal ?? elements.signalGroup.value;
  const mapping = editingMapping();

  const makeOptions = (groups, currentValue, unavailableName) => {
    if (groups.length === 0) {
      const emptyOption = '<option value="">No groups available</option>';
      if (!currentValue) return emptyOption;
      return `${emptyOption}<option value="${escapeHtml(currentValue)}">${escapeHtml(unavailableName || currentValue)} (unavailable)</option>`;
    }

    const options = ['<option value="">Select a group</option>'];
    for (const group of groups) {
      const count = group.participantCount || group.memberCount;
      const countText = count ? ` (${count})` : '';
      options.push(`<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}${countText}</option>`);
    }
    if (currentValue && !groups.some((group) => group.id === currentValue)) {
      options.push(`<option value="${escapeHtml(currentValue)}">${escapeHtml(unavailableName || currentValue)} (unavailable)</option>`);
    }
    return options.join('');
  };

  elements.whatsappGroup.innerHTML = makeOptions(
    state.whatsappGroups,
    currentWhatsappValue,
    mapping?.whatsappGroupName
  );
  elements.signalGroup.innerHTML = makeOptions(
    state.signalGroups,
    currentSignalValue,
    mapping?.signalGroupName
  );
  elements.whatsappGroup.value = currentWhatsappValue;
  elements.signalGroup.value = currentSignalValue;
}

function renderGroupList(container, groups, key) {
  if (groups.length === 0) {
    container.innerHTML = '<p class="form-note">No groups available.</p>';
    return;
  }

  container.innerHTML = groups.map((group) => `
    <article class="group-item">
      <strong>${escapeHtml(group.name)}</strong>
      <p class="group-id">${escapeHtml(group[key])}</p>
    </article>
  `).join('');
}

function renderMappings() {
  if (state.mappings.length === 0) {
    elements.mappingsList.innerHTML = '<p class="form-note">No mappings configured.</p>';
    return;
  }

  elements.mappingsList.innerHTML = state.mappings.map((mapping) => `
    <article class="mapping-card ${mapping.active ? '' : 'mapping-card-inactive'}" data-mapping-id="${mapping.id}">
      <div class="mapping-head">
        <div>
          <div class="mapping-title">${escapeHtml(mapping.name)}</div>
          <p class="mapping-meta">${escapeHtml(mapping.whatsappGroupName || mapping.whatsappGroupId)} ↔ ${escapeHtml(mapping.signalGroupName || mapping.signalGroupId)}</p>
        </div>
        <span class="pill ${mapping.active ? 'pill-ready' : 'pill-disconnected'}">${mapping.active ? 'active' : 'paused'}</span>
      </div>
      <div class="mapping-flags">
        <span class="flag ${mapping.syncWhatsappToSignal ? 'flag-on' : ''}">WA → Signal</span>
        <span class="flag ${mapping.syncSignalToWhatsapp ? 'flag-on' : ''}">Signal → WA</span>
        <span class="flag ${mapping.syncMedia ? 'flag-on' : ''}">Media</span>
        <span class="flag ${mapping.prependSender ? 'flag-on' : ''}">Sender label</span>
      </div>
      <div class="mapping-actions">
        <button class="button" data-action="edit" data-id="${mapping.id}" ${state.savingMapping ? 'disabled' : ''}>Edit</button>
        <button class="button button-subtle" data-action="delete" data-id="${mapping.id}" ${state.savingMapping ? 'disabled' : ''}>Delete</button>
      </div>
    </article>
  `).join('');
}

function renderActivity() {
  if (!state.activityOpen) {
    return;
  }

  if (state.activity.length === 0) {
    elements.activityList.innerHTML = '<p class="form-note">No recent events.</p>';
    return;
  }

  elements.activityList.innerHTML = state.activity.map((entry) => `
    <article class="activity-item">
      <div>
        <strong>${escapeHtml(entry.message)}</strong>
        <p class="activity-meta">${new Date(entry.createdAt).toLocaleString()} • ${escapeHtml(entry.eventType)}</p>
      </div>
      <span class="pill ${entry.level === 'error' ? 'pill-error' : 'pill-ready'}">${escapeHtml(entry.level)}</span>
    </article>
  `).join('');
}

function renderDisclosureState() {
  elements.groupsPanel.classList.toggle('hidden', !state.groupsOpen);
  elements.activityPanel.classList.toggle('hidden', !state.activityOpen);
  elements.groupsToggle.textContent = state.groupsOpen ? 'Hide groups' : 'Show groups';
  elements.activityToggle.textContent = state.activityOpen ? 'Hide activity' : 'Show activity';
  elements.groupsToggle.setAttribute('aria-expanded', String(state.groupsOpen));
  elements.activityToggle.setAttribute('aria-expanded', String(state.activityOpen));
}

function renderAll(data) {
  state.mappings = data.mappings || [];
  state.whatsappGroups = data.groups?.whatsapp || [];
  state.signalGroups = data.groups?.signal || [];
  state.activity = data.activity || state.activity;

  renderProvider('whatsapp', data.providers?.whatsapp);
  renderProvider('signal', data.providers?.signal);
  renderGroupOptions();
  renderMappings();
  renderDisclosureState();

  if (state.groupsOpen) {
    renderGroupList(elements.whatsappGroupsList, state.whatsappGroups, 'id');
    renderGroupList(elements.signalGroupsList, state.signalGroups, 'internalId');
  }

  renderActivity();
}

function resetMappingForm() {
  elements.mappingId.value = '';
  elements.mappingForm.reset();
  renderGroupOptions({ whatsapp: '', signal: '' });
  state.editorAutoName = true;
  setDirection('both');
  setOption(elements.toggleMedia, true);
  setOption(elements.toggleSender, true);
  setOption(elements.toggleActive, true);
  elements.mappingError.textContent = '';
  syncEditor();
}

function optionEnabled(element) {
  return element.getAttribute('aria-checked') === 'true';
}

function setOption(element, enabled) {
  element.setAttribute('aria-checked', String(enabled));
  element.classList.toggle('is-on', enabled);
}

function setDirection(direction) {
  state.editorDirection = direction;
  for (const button of elements.directionControl.querySelectorAll('[data-direction]')) {
    const selected = button.dataset.direction === direction;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function selectedGroup(select, groups) {
  const availableGroup = groups.find((group) => group.id === select.value);
  if (availableGroup) return availableGroup;

  const mapping = editingMapping();
  if (select === elements.whatsappGroup && mapping?.whatsappGroupId === select.value) {
    return { id: mapping.whatsappGroupId, name: mapping.whatsappGroupName || mapping.whatsappGroupId };
  }
  if (select === elements.signalGroup && mapping?.signalGroupId === select.value) {
    return {
      id: mapping.signalGroupId,
      internalId: mapping.signalGroupInternalId,
      name: mapping.signalGroupName || mapping.signalGroupId
    };
  }
  return undefined;
}

function syncEditor({ generateName = false } = {}) {
  const whatsappGroup = selectedGroup(elements.whatsappGroup, state.whatsappGroups);
  const signalGroup = selectedGroup(elements.signalGroup, state.signalGroups);

  if (generateName && state.editorAutoName && whatsappGroup && signalGroup) {
    elements.mappingName.value = `${whatsappGroup.name} ↔ ${signalGroup.name}`;
  }

  const editing = Boolean(elements.mappingId.value);
  elements.editorTitle.textContent = editing ? 'Edit mapping' : 'New mapping';
  elements.editorSubtitle.textContent = editing
    ? 'Changes apply as soon as you save.'
    : 'Connect one WhatsApp group with one Signal group.';
  elements.editorState.textContent = editing ? `Mapping #${elements.mappingId.value}` : 'Draft';
  if (elements.mappingSubmitButton.getAttribute('aria-busy') !== 'true') {
    elements.mappingSubmitButton.textContent = editing ? 'Save changes' : 'Create mapping';
  }
  elements.mappingResetButton.textContent = editing ? 'Cancel' : 'Clear';

  elements.previewWhatsapp.textContent = whatsappGroup?.name || 'Choose WhatsApp group';
  elements.previewSignal.textContent = signalGroup?.name || 'Choose Signal group';
  const directionSymbols = { both: '↔', 'wa-to-signal': '→', 'signal-to-wa': '←' };
  elements.previewDirection.textContent = directionSymbols[state.editorDirection];

  const options = [];
  if (optionEnabled(elements.toggleMedia)) options.push('Attachments');
  if (optionEnabled(elements.toggleSender)) options.push('Sender labels');
  options.push(optionEnabled(elements.toggleActive) ? 'Active' : 'Paused');
  elements.previewOptions.textContent = options.join(' · ');
}

function buildMappingPayload() {
  const whatsappGroup = selectedGroup(elements.whatsappGroup, state.whatsappGroups);
  const signalGroup = selectedGroup(elements.signalGroup, state.signalGroups);

  return {
    name: elements.mappingName.value,
    whatsappGroupId: whatsappGroup?.id,
    whatsappGroupName: whatsappGroup?.name,
    signalGroupId: signalGroup?.id,
    signalGroupInternalId: signalGroup?.internalId,
    signalGroupName: signalGroup?.name,
    syncWhatsappToSignal: ['both', 'wa-to-signal'].includes(state.editorDirection),
    syncSignalToWhatsapp: ['both', 'signal-to-wa'].includes(state.editorDirection),
    syncMedia: optionEnabled(elements.toggleMedia),
    prependSender: optionEnabled(elements.toggleSender),
    active: optionEnabled(elements.toggleActive)
  };
}

async function loadBootstrap() {
  const result = await dashboardApi.latest('bootstrap', () => api('/api/bootstrap'));
  if (!result.stale) renderAll(result.value);
}

async function refreshStatuses() {
  const result = await dashboardApi.latest('providers', () => api('/api/providers/status'));
  if (result.stale) return;
  renderProvider('whatsapp', result.value.whatsapp);
  renderProvider('signal', result.value.signal);
}

async function refreshGroups() {
  const result = await dashboardApi.latest('groups', () => Promise.all([
    api('/api/groups/whatsapp'), api('/api/groups/signal')
  ]));
  if (result.stale) return;
  const [whatsapp, signal] = result.value;

  state.whatsappGroups = whatsapp.groups || [];
  state.signalGroups = signal.groups || [];
  renderGroupOptions();

  if (state.groupsOpen) {
    renderGroupList(elements.whatsappGroupsList, state.whatsappGroups, 'id');
    renderGroupList(elements.signalGroupsList, state.signalGroups, 'internalId');
  }
}

async function refreshMappings() {
  const result = await dashboardApi.latest('mappings', () => api('/api/mappings'));
  if (result.stale) return;
  state.mappings = result.value.mappings || [];
  renderMappings();
}

async function refreshActivity() {
  if (!state.activityOpen) {
    return;
  }

  const result = await dashboardApi.latest('activity', () => api('/api/activity'));
  if (result.stale) return;
  state.activity = result.value.activity || [];
  renderActivity();
}

async function handleSession() {
  elements.startupView.setAttribute('role', 'status');
  elements.startupView.setAttribute('aria-live', 'polite');
  elements.startupView.setAttribute('aria-busy', 'true');
  elements.startupMessage.textContent = 'Loading dashboard...';
  elements.startupRetryButton.classList.add('hidden');
  elements.startupRetryButton.disabled = true;
  const authenticated = await dashboardApi.establishSession();
  if (!authenticated) return;
  await loadBootstrap();
  elements.startupView.classList.add('hidden');
  elements.dashboardView.classList.remove('hidden');
  startPolling();
}

async function bootstrapDashboard() {
  try {
    await handleSession();
  } catch (error) {
    elements.startupView.classList.remove('hidden');
    elements.startupView.setAttribute('role', 'alert');
    elements.startupView.setAttribute('aria-live', 'assertive');
    elements.startupView.setAttribute('aria-busy', 'false');
    elements.startupMessage.textContent = `Dashboard could not load. ${error.message}`;
    elements.startupRetryButton.classList.remove('hidden');
    elements.startupRetryButton.disabled = false;
  }
}

function startPolling() {
  stopPolling();
  let tick = 0;

  state.pollTimer = setInterval(() => {
    if (document.hidden || state.pollInFlight) return;

    tick += 1;
    state.pollInFlight = true;
    Promise.all([
      refreshStatuses(),
      tick % 6 === 0 ? refreshGroups() : Promise.resolve(),
      tick % 3 === 0 ? refreshMappings() : Promise.resolve(),
      state.activityOpen ? refreshActivity() : Promise.resolve()
    ])
      .catch((error) => showMessage(`Background refresh failed. ${error.message}`, 'error'))
      .finally(() => { state.pollInFlight = false; });
  }, 10000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

elements.logoutButton.addEventListener('click', async () => {
  setButtonPending(elements.logoutButton, true, 'Signing out...');
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (_) {
    // best effort logout
  }

  dashboardApi.clearSession();
  stopPolling();
  resetMappingForm();
  window.location.replace('/login');
});

elements.refreshButton.addEventListener('click', async () => {
  setButtonPending(elements.refreshButton, true, 'Refreshing...');
  try {
    await Promise.all([
      refreshStatuses(),
      refreshMappings(),
      refreshGroups(),
      state.activityOpen ? refreshActivity() : Promise.resolve()
    ]);
    showMessage('Dashboard data is up to date.', 'info', { hideAfter: 2000 });
  } catch (error) {
    showMessage(`Dashboard refresh failed. ${error.message}`, 'error');
  } finally {
    setButtonPending(elements.refreshButton, false);
  }
});

elements.signalRefreshButton.addEventListener('click', async () => {
  setButtonPending(elements.signalRefreshButton, true, 'Requesting QR...');
  try {
    await api('/api/providers/signal/refresh', { method: 'POST' });
    dashboardApi.invalidate('providers');
    showMessage('Signal QR refresh requested.', 'success');
  } catch (error) {
    showMessage(`Signal QR refresh failed. ${error.message}`, 'error');
    return;
  } finally {
    setButtonPending(elements.signalRefreshButton, false);
  }

  try {
    await refreshStatuses();
  } catch (error) {
    showMessage(`Signal QR refresh was requested, but its latest status is unavailable. ${error.message}`, 'warning');
  }
});

async function logoutProvider(provider) {
  const label = provider === 'whatsapp' ? 'WhatsApp' : 'Signal';
  const explanation = provider === 'signal'
    ? 'This removes only the bridge device. Your Signal account will not be deleted.'
    : 'You will need to scan a new QR code before bridging resumes.';

  if (!window.confirm(`Disconnect ${label}?\n\n${explanation}`)) return;

  const button = provider === 'whatsapp' ? elements.whatsappLogoutButton : elements.signalLogoutButton;
  let providerState;
  let failed = false;
  state.pendingProviders.add(provider);
  setButtonPending(button, true, 'Disconnecting...');

  try {
    const result = await api(`/api/providers/${provider}/logout`, { method: 'POST' });
    dashboardApi.invalidate('providers', 'groups');
    providerState = result[provider];
    renderProvider(provider, providerState);
    showMessage(`${label} disconnected. Scan the new QR code to reconnect.`, 'success');
  } catch (error) {
    showMessage(`${label} could not be disconnected. ${error.message}`, 'error');
    failed = true;
  } finally {
    state.pendingProviders.delete(provider);
    setButtonPending(button, false);
    if (providerState) renderProvider(provider, providerState);
  }

  if (failed) {
    await refreshStatuses().catch(() => {});
    return;
  }

  try {
    await refreshGroups();
  } catch (error) {
    showMessage(`${label} was disconnected, but the group lists could not be refreshed. ${error.message}`, 'warning');
  }
}

elements.whatsappLogoutButton.addEventListener('click', () => logoutProvider('whatsapp'));
elements.signalLogoutButton.addEventListener('click', () => logoutProvider('signal'));

elements.groupsToggle.addEventListener('click', async () => {
  state.groupsOpen = !state.groupsOpen;
  renderDisclosureState();

  if (state.groupsOpen) {
    setButtonPending(elements.groupsToggle, true, 'Loading groups...');
    try {
      await refreshGroups();
    } catch (error) {
      showMessage(`Groups could not be loaded. ${error.message}`, 'error');
    } finally {
      setButtonPending(elements.groupsToggle, false);
    }
  }
});

elements.activityToggle.addEventListener('click', async () => {
  state.activityOpen = !state.activityOpen;
  renderDisclosureState();

  if (state.activityOpen) {
    setButtonPending(elements.activityToggle, true, 'Loading activity...');
    try {
      await refreshActivity();
    } catch (error) {
      showMessage(`Activity could not be loaded. ${error.message}`, 'error');
    } finally {
      setButtonPending(elements.activityToggle, false);
    }
  }
});

elements.mappingResetButton.addEventListener('click', () => {
  resetMappingForm();
});

elements.directionControl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-direction]');
  if (!button) return;
  setDirection(button.dataset.direction);
  syncEditor();
});

for (const toggle of [elements.toggleMedia, elements.toggleSender, elements.toggleActive]) {
  toggle.addEventListener('click', () => {
    setOption(toggle, !optionEnabled(toggle));
    syncEditor();
  });
}

elements.whatsappGroup.addEventListener('change', () => syncEditor({ generateName: true }));
elements.signalGroup.addEventListener('change', () => syncEditor({ generateName: true }));
elements.mappingName.addEventListener('input', () => {
  state.editorAutoName = elements.mappingName.value.trim() === '';
  if (state.editorAutoName) syncEditor({ generateName: true });
});

elements.mappingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.mappingError.textContent = '';

  const mappingId = elements.mappingId.value;
  const successText = mappingId ? 'Mapping updated.' : 'Mapping created.';
  setButtonPending(elements.mappingSubmitButton, true, 'Saving mapping...');
  state.savingMapping = true;
  elements.mappingResetButton.disabled = true;
  renderMappings();

  try {
    const payload = buildMappingPayload();

    if (mappingId) {
      await api(`/api/mappings/${mappingId}`, { method: 'PUT', body: payload });
    } else {
      await api('/api/mappings', { method: 'POST', body: payload });
    }
    dashboardApi.invalidate('mappings', 'groups');
  } catch (error) {
    elements.mappingError.textContent = `Mapping could not be saved. ${error.message}`;
    setButtonPending(elements.mappingSubmitButton, false);
    state.savingMapping = false;
    elements.mappingResetButton.disabled = false;
    renderMappings();
    return;
  }

  setButtonPending(elements.mappingSubmitButton, false);
  state.savingMapping = false;
  elements.mappingResetButton.disabled = false;
  renderMappings();
  resetMappingForm();
  showMessage(successText, 'success');

  try {
    await Promise.all([refreshMappings(), refreshGroups()]);
  } catch (error) {
    showMessage(`${successText} The dashboard lists could not be refreshed. ${error.message}`, 'warning');
  }
});

function directionForMapping(mapping) {
  if (mapping.syncWhatsappToSignal && mapping.syncSignalToWhatsapp) return 'both';
  if (mapping.syncWhatsappToSignal) return 'wa-to-signal';
  return 'signal-to-wa';
}

elements.mappingsList.addEventListener('click', async (event) => {
  if (state.savingMapping) return;
  const button = event.target.closest('button[data-action]');
  if (!button) {
    return;
  }

  const mapping = state.mappings.find((item) => item.id === Number(button.dataset.id));
  if (!mapping) {
    return;
  }

  if (button.dataset.action === 'edit') {
    elements.mappingId.value = String(mapping.id);
    elements.mappingName.value = mapping.name;
    renderGroupOptions({
      whatsapp: mapping.whatsappGroupId,
      signal: mapping.signalGroupId
    });
    state.editorAutoName = false;
    setDirection(directionForMapping(mapping));
    setOption(elements.toggleMedia, Boolean(mapping.syncMedia));
    setOption(elements.toggleSender, Boolean(mapping.prependSender));
    setOption(elements.toggleActive, Boolean(mapping.active));
    elements.mappingError.textContent = '';
    syncEditor();
    document.querySelector('.editor-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (button.dataset.action === 'delete' && window.confirm(`Delete mapping "${mapping.name}"?`)) {
    setButtonPending(button, true, 'Deleting...');
    try {
      await api(`/api/mappings/${mapping.id}`, { method: 'DELETE' });
      dashboardApi.invalidate('mappings');
      showMessage('Mapping deleted.', 'success');
    } catch (error) {
      showMessage(`Mapping could not be deleted. ${error.message}`, 'error');
      setButtonPending(button, false);
      return;
    }

    if (elements.mappingId.value === String(mapping.id)) {
      resetMappingForm();
    }

    try {
      await refreshMappings();
    } catch (error) {
      showMessage(`Mapping was deleted, but the mapping list could not be refreshed. ${error.message}`, 'warning');
    }
  }
});

elements.startupRetryButton.addEventListener('click', bootstrapDashboard);
bootstrapDashboard();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && dashboardApi.hasSession()) {
    refreshStatuses().catch((error) => showMessage(`Provider status could not be refreshed. ${error.message}`, 'error'));
  }
});
