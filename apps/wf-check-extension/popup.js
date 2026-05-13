/**
 * WF Check Extractor — popup script
 */

const WF_HOST = 'connect.secure.wellsfargo.com/accounts/inquiry/accountdetails';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const wrongPageEl     = document.getElementById('wrong-page');
const mainEl          = document.getElementById('main');
const countBadgeEl    = document.getElementById('count-badge');
const countLabelNumEl = document.getElementById('count-label-num');
const extractBtn      = document.getElementById('extract-btn');
const cfoUrlInput     = document.getElementById('cfo-url');
const apiKeyInput     = document.getElementById('api-key');
const accountIdInput  = document.getElementById('account-id');
const progressWrapEl  = document.getElementById('progress-wrap');
const progressFillEl  = document.getElementById('progress-fill');
const statusTextEl    = document.getElementById('status-text');
const logEl           = document.getElementById('log');
const resultsSectionEl = document.getElementById('results-section');
const resultsListEl   = document.getElementById('results-list');

// ── State ─────────────────────────────────────────────────────────────────────

let activeTab = null;
let isRunning = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendLog(text, cls) {
  const div = document.createElement('div');
  div.className = 'log-item ' + (cls || 'log-info');
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function setCount(n) {
  countBadgeEl.textContent = String(n);
  countLabelNumEl.textContent = String(n);
  extractBtn.disabled = n === 0 || isRunning;
}

function setProgress(pct, text) {
  progressFillEl.style.width = pct + '%';
  statusTextEl.textContent = text;
}

function addResult(checkNumber, payee, amount) {
  const div = document.createElement('div');
  div.className = 'result-item';

  const left = document.createElement('div');
  left.className = 'result-check';
  left.textContent = 'CHECK #' + (checkNumber || '?') + (amount ? '  ' + amount : '');

  const right = document.createElement('div');
  if (payee) {
    right.className = 'result-payee';
    right.textContent = payee;
  } else {
    right.className = 'result-unknown';
    right.textContent = '—';
  }

  div.appendChild(left);
  div.appendChild(right);
  resultsListEl.appendChild(div);
  resultsSectionEl.style.display = 'block';
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Load saved settings
  const { cfoUrl, apiKey, accountId } = await chrome.storage.local.get(['cfoUrl', 'apiKey', 'accountId']);
  if (cfoUrl)    cfoUrlInput.value    = cfoUrl;
  if (apiKey)    apiKeyInput.value    = apiKey;
  if (accountId) accountIdInput.value = accountId;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!tab || !tab.url || !tab.url.includes(WF_HOST)) {
    wrongPageEl.style.display = 'block';
    return;
  }

  mainEl.style.display = 'block';

  // Ask content script how many check buttons are on the page
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'WF_PING' });
    setCount(resp && resp.count != null ? resp.count : 0);
  } catch {
    // Content script may not have loaded yet (page still rendering)
    statusTextEl.textContent = 'Page still loading — reload if buttons do not appear.';
    setCount(0);
  }
}

// Content script also handles a lightweight ping to return the check count
// before a full extraction (no port needed for this).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WF_COUNT_RESPONSE') setCount(msg.count);
});

// ── Extract button ────────────────────────────────────────────────────────────

extractBtn.addEventListener('click', async () => {
  if (isRunning || !activeTab) return;

  const cfoUrl   = cfoUrlInput.value.trim();
  const apiKey   = apiKeyInput.value.trim();
  const accountId = accountIdInput.value.trim();

  // Persist settings
  await chrome.storage.local.set({ cfoUrl, apiKey, accountId });

  isRunning = true;
  extractBtn.disabled = true;
  progressWrapEl.style.display = 'block';
  logEl.innerHTML = '';
  resultsListEl.innerHTML = '';
  resultsSectionEl.style.display = 'none';

  setProgress(0, 'Connecting to page…');

  // Open a port to the content script
  let port;
  try {
    port = chrome.tabs.connect(activeTab.id, { name: 'wf-extraction' });
  } catch (e) {
    appendLog('Failed to connect to page: ' + e.message, 'log-err');
    isRunning = false;
    extractBtn.disabled = false;
    return;
  }

  port.onDisconnect.addListener(() => {
    if (isRunning) {
      appendLog('Connection lost — extraction may be incomplete.', 'log-err');
      isRunning = false;
      extractBtn.disabled = false;
    }
  });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'start':
        setProgress(0, 'Processing ' + msg.total + ' checks…');
        appendLog('Starting extraction of ' + msg.total + ' checks…');
        break;

      case 'progress':
        setProgress(
          Math.round((msg.current / msg.total) * 100),
          'Processing ' + msg.current + ' / ' + msg.total + ' — CHECK #' + (msg.checkNumber || '?'),
        );
        break;

      case 'captured':
        appendLog(
          '✓ CHECK #' + (msg.checkNumber || '?') + ' — ' + msg.imageCount + ' image(s) captured',
          'log-ok',
        );
        break;

      case 'error':
        appendLog('✗ CHECK #' + (msg.checkNumber || '?') + ': ' + msg.error, 'log-err');
        break;

      case 'done': {
        const successCount = msg.results.filter(r => r.images && r.images.length > 0).length;
        setProgress(100, 'Done — ' + successCount + ' of ' + msg.total + ' captures succeeded.');
        appendLog(
          'Extraction complete. ' + successCount + '/' + msg.total + ' images captured' +
          (cfoUrl ? ', uploading to CFO…' : '.'),
        );

        // Show results list (payees populated asynchronously by the background worker)
        // We show what we know now; the payee is filled in once OCR completes.
        for (const r of msg.results) {
          if (r.images && r.images.length > 0) {
            addResult(r.checkNumber, null, r.amount);
          }
        }

        isRunning = false;
        extractBtn.disabled = false;
        break;
      }

      case 'fatal':
        appendLog('Fatal error: ' + msg.error, 'log-err');
        setProgress(0, 'Extraction failed.');
        isRunning = false;
        extractBtn.disabled = false;
        break;
    }
  });

  // Kick off extraction
  port.postMessage({ type: 'START', cfoUrl, apiKey, accountId });
});

// Also handle pings from content script for count updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WF_CHECK_RESULT' && msg.checkNumber) {
    // Update an existing result row with payee once OCR completes
    const items = resultsListEl.querySelectorAll('.result-item');
    for (const item of items) {
      if (item.querySelector('.result-check')?.textContent?.includes('#' + msg.checkNumber)) {
        const payeeEl = item.querySelector('.result-payee, .result-unknown');
        if (payeeEl && msg.payee) {
          payeeEl.className = 'result-payee';
          payeeEl.textContent = msg.payee;
        }
      }
    }
  }
});

init();
