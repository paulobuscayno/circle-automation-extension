const DEFAULT_SETTINGS = {
  messageTemplate: 'Hi {{first_name}}, great to have you in the community! Looking forward to connecting.',
  minDelayMs: 3500,
  maxDelayMs: 8000,
  maxPerSession: 50,
  maxPerDay: 150,
  testMode: true,
  selectors: {
    memberLinkFragment: '/members/',
    dmTextareaPlaceholder: 'type a message',
    connectNotePlaceholder: 'add a personal note',
    sendRequestButtonText: 'Send request',
    connectButtonText: 'Connect',
    messageButtonText: 'Message',
    pendingButtonText: 'Pending',
    viewProfileButtonText: 'View profile',
    dmSendButtonSelector: '',
  },
};

let activatedTabId = null;
let saveTimer = null;

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function targetTabId() {
  if (activatedTabId) {
    try {
      await chrome.tabs.get(activatedTabId);
      return activatedTabId;
    } catch {
      activatedTabId = null;
    }
  }
  const tab = await getActiveTab();
  return tab ? tab.id : null;
}

function sendToContent(msg) {
  return new Promise(async (resolve) => {
    const tabId = await targetTabId();
    if (!tabId) return resolve(null);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}

// Grants the one-time site permission (Chrome requires a user gesture for this; it rides
// along on whichever button the user actually clicked) and injects content.js if needed.
// Resolves immediately with no prompt if access was already granted.
async function ensureActivated() {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: 'No active tab.' };
  const origin = originOf(tab.url);
  if (!origin || origin.startsWith('chrome')) {
    return { ok: false, error: 'Open your community members page in this tab first.' };
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ACTIVATE_ON_TAB', tabId: tab.id, origin }, (resp) => {
      if (resp && resp.ok) activatedTabId = tab.id;
      resolve(resp || { ok: false, error: 'Activation failed.' });
    });
  });
}

// Tries the message; if there's no content script there to answer, activates and retries once.
async function sendToContentAuto(msg) {
  let resp = await sendToContent(msg);
  if (resp) return resp;
  const act = await ensureActivated();
  if (!act.ok) {
    appendLog(act.error);
    return null;
  }
  return sendToContent(msg);
}

function appendLog(text) {
  const el = document.getElementById('log');
  const line = document.createElement('div');
  line.textContent = text;
  el.prepend(line);
  while (el.children.length > 80) el.removeChild(el.lastChild);
}

const STATUS_LABELS = {
  idle: 'Idle',
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  finished: 'Finished',
};

function renderStatus(resp) {
  if (!resp || !resp.runState) return;
  const { runState, totalMembers } = resp;
  const status = runState.status || (runState.isRunning ? 'running' : 'idle');

  document.getElementById('statusDot').className = 'dot ' + status;
  document.getElementById('statusText').textContent = STATUS_LABELS[status] || status;
  document.getElementById('statusHint').textContent =
    status === 'running' ? 'Working on one member at a time...' : '';

  const processed = runState.processedIds.length;
  document.getElementById('statProgress').textContent = totalMembers ? `${processed}/${totalMembers}` : String(processed);
  document.getElementById('statSuccess').textContent = runState.stats.success;
  document.getElementById('statSkipped').textContent = runState.stats.skipped;
  document.getElementById('statFailed').textContent = runState.stats.failed;
  document.getElementById('retryBtn').disabled = !(runState.failedIds && runState.failedIds.length);
}

async function refreshStatus() {
  const resp = await sendToContent({ type: 'GET_STATUS' });
  if (resp) renderStatus(resp);
}

// -------- settings form --------
async function loadSettingsIntoForm() {
  const data = await chrome.storage.local.get(['settings']);
  const s = {
    ...DEFAULT_SETTINGS,
    ...(data.settings || {}),
    selectors: { ...DEFAULT_SETTINGS.selectors, ...((data.settings || {}).selectors || {}) },
  };
  document.getElementById('template').value = s.messageTemplate;
  document.getElementById('minDelay').value = s.minDelayMs / 1000;
  document.getElementById('maxDelay').value = s.maxDelayMs / 1000;
  document.getElementById('maxPerSession').value = s.maxPerSession;
  document.getElementById('maxPerDay').value = s.maxPerDay;
  document.getElementById('testMode').checked = s.testMode;
  for (const key of Object.keys(DEFAULT_SETTINGS.selectors)) {
    const el = document.getElementById('sel_' + key);
    if (el) el.value = s.selectors[key];
  }
}

function readFormSettings() {
  const selectors = {};
  for (const key of Object.keys(DEFAULT_SETTINGS.selectors)) {
    const el = document.getElementById('sel_' + key);
    selectors[key] = el ? el.value : DEFAULT_SETTINGS.selectors[key];
  }
  return {
    messageTemplate: document.getElementById('template').value,
    minDelayMs: Math.max(500, Number(document.getElementById('minDelay').value) * 1000),
    maxDelayMs: Math.max(500, Number(document.getElementById('maxDelay').value) * 1000),
    maxPerSession: Math.max(1, Number(document.getElementById('maxPerSession').value)),
    maxPerDay: Math.max(1, Number(document.getElementById('maxPerDay').value)),
    testMode: document.getElementById('testMode').checked,
    selectors,
  };
}

async function saveSettings() {
  const settings = readFormSettings();
  await chrome.storage.local.set({ settings });
  await sendToContent({ type: 'SETTINGS_UPDATED' });
}

function saveSettingsDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 500);
}

// -------- actions --------
async function highlight() {
  const resp = await sendToContentAuto({ type: 'HIGHLIGHT' });
  if (!resp) return;
  appendLog(`Highlighted ${resp.count} detected member card(s) in red for a few seconds.`);
}

async function previewNext() {
  await saveSettings();
  const resp = await sendToContentAuto({ type: 'PREVIEW_NEXT' });
  const box = document.getElementById('previewBox');
  if (!resp || !resp.ok) {
    box.hidden = true;
    if (resp) appendLog('Preview failed: ' + resp.error);
    return;
  }
  box.hidden = false;
  box.textContent = `Next: ${resp.name} (${resp.action})\n\n"${resp.message}"`;
}

async function start() {
  const settings = readFormSettings();
  if (!settings.testMode) {
    const ok = confirm(
      'Test mode is OFF. This will send real messages/connection requests to real members starting now. Continue?'
    );
    if (!ok) return;
  }
  await saveSettings();
  const resp = await sendToContentAuto({ type: 'START' });
  if (!resp) return;
  refreshStatus();
}

async function pause() {
  const resp = await sendToContentAuto({ type: 'PAUSE_TOGGLE' });
  if (!resp) return;
  refreshStatus();
}

async function stop() {
  const resp = await sendToContentAuto({ type: 'STOP' });
  if (!resp) return;
  refreshStatus();
}

async function retryFailed() {
  const resp = await sendToContentAuto({ type: 'RETRY_FAILED' });
  if (!resp) return;
  appendLog(`${resp.count} failed member(s) re-queued. Click Start to retry.`);
  refreshStatus();
}

async function resetProgress() {
  if (!confirm('This clears all progress and allows everyone to be messaged again. Continue?')) return;
  const resp = await sendToContentAuto({ type: 'RESET_PROGRESS' });
  if (!resp) return;
  appendLog('Progress reset.');
  refreshStatus();
}

function toCsv(rows) {
  const headers = ['ts', 'id', 'name', 'action', 'status', 'error'];
  const escape = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => escape(r[h])).join(','));
  return lines.join('\r\n');
}

async function exportCsv() {
  const resp = await sendToContentAuto({ type: 'GET_RESULTS_CSV' });
  if (!resp || !resp.ok) return;
  if (!resp.log.length) { appendLog('No results logged yet.'); return; }
  const csv = toCsv(resp.log);
  const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  chrome.downloads.download({ url, filename: `circle-outreach-results-${Date.now()}.csv`, saveAs: true }, () => {
    if (chrome.runtime.lastError) appendLog('Export failed: ' + chrome.runtime.lastError.message);
    else appendLog('Exported results CSV.');
  });
}

// -------- live updates pushed from the content script --------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_PUSH') {
    renderStatus(msg);
  } else if (msg.type === 'LOG') {
    appendLog(msg.message);
  }
});

async function init() {
  await loadSettingsIntoForm();
  await refreshStatus();

  document.getElementById('template').addEventListener('input', saveSettingsDebounced);
  for (const id of ['minDelay', 'maxDelay', 'maxPerSession', 'maxPerDay', 'testMode']) {
    document.getElementById(id).addEventListener('change', saveSettings);
  }
  for (const key of Object.keys(DEFAULT_SETTINGS.selectors)) {
    const el = document.getElementById('sel_' + key);
    if (el) el.addEventListener('change', saveSettings);
  }

  document.getElementById('startBtn').addEventListener('click', start);
  document.getElementById('pauseBtn').addEventListener('click', pause);
  document.getElementById('stopBtn').addEventListener('click', stop);
  document.getElementById('highlightBtn').addEventListener('click', highlight);
  document.getElementById('previewBtn').addEventListener('click', previewNext);
  document.getElementById('retryBtn').addEventListener('click', retryFailed);
  document.getElementById('resetBtn').addEventListener('click', resetProgress);
  document.getElementById('exportBtn').addEventListener('click', exportCsv);

  setInterval(refreshStatus, 2000);
}

init();
