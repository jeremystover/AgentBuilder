/**
 * Bank Check Extractor — popup orchestrator
 *
 * State machine:
 *
 *   needs-setup    →  view-setup       (no CFO URL / API key saved)
 *   needs-account  →  view-account     (CFO connected, accounts loaded, no pick yet)
 *   main           →  view-main        (everything configured)
 *     ↳  extract-area or needs-train-area depending on recipe + probe
 *     ↳  view-train (1..4 substeps) for training
 *     ↳  view-settings for settings
 */

// ── Storage helpers ────────────────────────────────────────────────────

async function getSettings() {
  const s = await chrome.storage.local.get(['settings']);
  return s.settings || {};
}
async function setSettings(patch) {
  const s = await getSettings();
  const next = { ...s, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
async function getRecipes() {
  const s = await chrome.storage.local.get(['recipes']);
  return s.recipes || {};
}
async function saveRecipe(domain, recipe) {
  const all = await getRecipes();
  all[domain] = recipe;
  await chrome.storage.local.set({ recipes: all });
}
async function deleteRecipe(domain) {
  const all = await getRecipes();
  delete all[domain];
  await chrome.storage.local.set({ recipes: all });
}

function domainFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.split('.').slice(-2).join('.');
  } catch { return null; }
}

// ── Tab + content-script helpers ──────────────────────────────────────

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function ensureInjected(tabId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'ENSURE_INJECTED', tabId }, (resp) => {
      if (!resp?.ok) reject(new Error(resp?.error || 'injection failed'));
      else resolve();
    });
  });
}
async function bgFetch(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('no response from background'));
      if (!resp.ok) return reject(new Error(resp.error || 'background error'));
      resolve(resp);
    });
  });
}
async function csFetch(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('content script returned nothing'));
      if (!resp.ok) return reject(new Error(resp.error || 'content script error'));
      resolve(resp);
    });
  });
}

// ── View switching ────────────────────────────────────────────────────

const VIEWS = ['view-setup', 'view-account', 'view-main', 'view-train', 'view-settings'];
function show(viewId) {
  for (const v of VIEWS) document.getElementById(v).classList.toggle('hidden', v !== viewId);
}
function setHidden(id, hidden) { document.getElementById(id).classList.toggle('hidden', hidden); }
function el(id) { return document.getElementById(id); }

function log(msg, cls) {
  const div = document.createElement('div');
  div.className = cls || 'log-info';
  div.textContent = msg;
  el('extract-log').appendChild(div);
  el('extract-log').scrollTop = el('extract-log').scrollHeight;
}

// ── Initial routing ───────────────────────────────────────────────────

async function init() {
  const settings = await getSettings();
  if (!settings.cfoUrl || !settings.apiKey) { show('view-setup'); return; }
  if (!settings.accountId) {
    await loadAccountsView();
    return;
  }
  await renderMainView();
}

// ── Setup view ────────────────────────────────────────────────────────

el('setup-save').addEventListener('click', async () => {
  const cfoUrl = el('cfo-url').value.trim();
  const apiKey = el('api-key').value.trim();
  if (!cfoUrl) return showSetupError('CFO URL is required');
  if (!apiKey) return showSetupError('API key is required');
  await setSettings({ cfoUrl, apiKey });
  setHidden('setup-error', true);
  try {
    await loadAccountsView();
  } catch (e) {
    showSetupError(e.message);
  }
});

function showSetupError(msg) {
  const e = el('setup-error'); e.textContent = msg; e.classList.remove('hidden');
}

// ── Account view ──────────────────────────────────────────────────────

async function loadAccountsView() {
  show('view-account');
  const sel = el('account-select');
  sel.innerHTML = '<option>Loading accounts…</option>';
  let accounts = [];
  try {
    const r = await bgFetch('FETCH_ACCOUNTS', {});
    accounts = r.accounts;
  } catch (e) {
    sel.innerHTML = '';
    const opt = document.createElement('option');
    opt.textContent = 'Failed: ' + e.message;
    sel.appendChild(opt);
    return;
  }
  sel.innerHTML = '';
  if (accounts.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No accounts found — set them up in CFO first';
    sel.appendChild(opt);
    return;
  }
  for (const a of accounts) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.institution ? a.institution + ' · ' : ''}${a.name}`;
    sel.appendChild(opt);
  }
  // Preselect last-used if available
  const settings = await getSettings();
  if (settings.accountId && accounts.find(a => a.id === settings.accountId)) {
    sel.value = settings.accountId;
  }
}

el('account-save').addEventListener('click', async () => {
  const accountId = el('account-select').value;
  if (!accountId) return;
  // Cache the friendly name for display in main view
  const text = el('account-select').selectedOptions[0]?.textContent || '';
  await setSettings({ accountId, accountLabel: text });
  await renderMainView();
});

el('change-account').addEventListener('click', async () => {
  await loadAccountsView();
});

// ── Main view ─────────────────────────────────────────────────────────

let currentTabId = null;
let currentDomain = null;
let currentRecipe = null;

async function renderMainView() {
  show('view-main');
  const settings = await getSettings();
  el('account-name').textContent = settings.accountLabel || settings.accountId || '—';

  const tab = await activeTab();
  if (!tab || !tab.url || !tab.url.startsWith('http')) {
    el('recipe-domain').textContent = '(no http page)';
    el('recipe-summary').textContent = 'Open your bank tab and click the extension again.';
    el('recipe-pill').textContent = 'inactive';
    el('recipe-pill').className = 'status-pill pill-warn';
    setHidden('extract-area', true);
    setHidden('needs-train-area', true);
    return;
  }

  currentTabId = tab.id;
  currentDomain = domainFromUrl(tab.url);
  el('recipe-domain').textContent = currentDomain;

  // If an extraction is mid-run (popup was closed and reopened), resync to it.
  const { extraction } = await chrome.storage.local.get('extraction');
  if (extraction && extraction.running) {
    el('extract-log').innerHTML = '';
    renderedCaptureCount = 0;
    renderExtraction(extraction);
  }

  try {
    await ensureInjected(tab.id);
  } catch (e) {
    el('recipe-summary').textContent = 'Could not inject on this page: ' + e.message;
    el('recipe-pill').textContent = 'blocked';
    el('recipe-pill').className = 'status-pill pill-err';
    return;
  }

  const recipes = await getRecipes();
  currentRecipe = recipes[currentDomain] || null;

  if (!currentRecipe) {
    el('recipe-summary').textContent = 'No recipe saved for this site yet.';
    el('recipe-pill').textContent = 'not trained';
    el('recipe-pill').className = 'status-pill pill-warn';
    setHidden('extract-area', true);
    setHidden('needs-train-area', false);
    return;
  }

  // Probe — does the saved recipe still work?
  try {
    const r = await csFetch(currentTabId, { type: 'PROBE', recipe: currentRecipe });
    const { rowMatches, viewButtonMatches, accountDetailOk } = r.probe;
    if (accountDetailOk) {
      el('recipe-summary').textContent = `${rowMatches} row(s), ${viewButtonMatches} View Check button(s) detected.`;
      el('recipe-pill').textContent = 'ready';
      el('recipe-pill').className = 'status-pill pill-ok';
      setHidden('extract-area', false);
      setHidden('needs-train-area', true);
    } else {
      el('recipe-summary').textContent = 'Saved selectors no longer match this page. Retraining recommended.';
      el('recipe-pill').textContent = 'stale';
      el('recipe-pill').className = 'status-pill pill-err';
      setHidden('extract-area', true);
      setHidden('needs-train-area', false);
    }
  } catch (e) {
    el('recipe-summary').textContent = 'Probe failed: ' + e.message;
    el('recipe-pill').textContent = 'error';
    el('recipe-pill').className = 'status-pill pill-err';
  }
}

el('extract-btn').addEventListener('click', () => runExtract());
el('retrain-btn').addEventListener('click', () => startTraining());
el('start-train-btn').addEventListener('click', () => startTraining());
el('settings-btn').addEventListener('click', () => openSettings());
el('settings-btn-2').addEventListener('click', () => openSettings());

// ── Train wizard ──────────────────────────────────────────────────────

let trainState = null;

function startTraining() {
  trainState = { accountDetail: null, checkModal: null };
  show('view-train');
  el('train-step-title').textContent = 'Training — step 1 of 4';
  setHidden('train-step-1', false);
  setHidden('train-step-2', true);
  setHidden('train-step-3', true);
  setHidden('train-step-4', true);
}

el('train-capture-page').addEventListener('click', async () => {
  setHidden('train-step-1-error', true);
  el('train-capture-page').disabled = true;
  el('train-capture-page').textContent = 'Analyzing page…';
  try {
    const tab = await activeTab();
    await ensureInjected(tab.id);
    const cap = await csFetch(tab.id, { type: 'CAPTURE_DOM' });
    const r = await bgFetch('ANALYZE_PAGE', { purpose: 'account-detail-page', url: cap.url, html: cap.html });
    trainState.accountDetail = r.selectors;
    // Highlight on page
    const counts = await csFetch(tab.id, {
      type: 'HIGHLIGHT',
      selectors: { primary: r.selectors.rowSelector },
    });
    // Render summary
    const ul = el('train-selector-summary');
    ul.innerHTML = '';
    ul.appendChild(li(`Check rows: <code>${escape(r.selectors.rowSelector)}</code> — matched ${counts.counts.primary}`));
    ul.appendChild(li(`View-check button: <code>${escape(r.selectors.viewCheckButtonSelector)}</code>`));
    ul.appendChild(li(`Check #: <code>${escape(r.selectors.checkNumberSelector)}</code>`));
    ul.appendChild(li(`Date: <code>${escape(r.selectors.dateSelector)}</code>`));
    ul.appendChild(li(`Amount: <code>${escape(r.selectors.amountSelector)}</code>`));
    if (r.selectors.notes) ul.appendChild(li(`<em>${escape(r.selectors.notes)}</em>`));
    setHidden('train-step-1', true);
    setHidden('train-step-2', false);
    el('train-step-title').textContent = 'Training — step 2 of 4';
  } catch (e) {
    showError('train-step-1-error', e.message);
  } finally {
    el('train-capture-page').disabled = false;
    el('train-capture-page').textContent = "I'm on the page — capture it";
  }
});

el('train-recapture').addEventListener('click', async () => {
  const tab = await activeTab();
  await csFetch(tab.id, { type: 'CLEAR_HIGHLIGHT' });
  setHidden('train-step-2', true);
  setHidden('train-step-1', false);
});

el('train-confirm-rows').addEventListener('click', async () => {
  const tab = await activeTab();
  await csFetch(tab.id, { type: 'CLEAR_HIGHLIGHT' });
  setHidden('train-step-2', true);
  setHidden('train-step-3', false);
  el('train-step-title').textContent = 'Training — step 3 of 4';
  armModalCapture();
});

async function armModalCapture() {
  setHidden('train-step-3-error', true);
  el('train-step-3-status').textContent = 'Waiting for you to click View Check (30s)…';
  try {
    const tab = await activeTab();
    // ARM_MODAL_CAPTURE waits up to 30s for a modal to appear, then returns its HTML
    const cap = await csFetch(tab.id, { type: 'ARM_MODAL_CAPTURE' });
    el('train-step-3-status').textContent = 'Modal captured — analyzing…';
    const r = await bgFetch('ANALYZE_PAGE', { purpose: 'check-modal', url: cap.url, html: cap.html });
    trainState.checkModal = r.selectors;
    const ul = el('train-modal-summary');
    ul.innerHTML = '';
    ul.appendChild(li(`Modal: <code>${escape(r.selectors.modalSelector)}</code>`));
    ul.appendChild(li(`Front image: <code>${escape(r.selectors.frontImageSelector)}</code>`));
    ul.appendChild(li(`Back image: <code>${escape(r.selectors.backImageSelector || '—')}</code>`));
    ul.appendChild(li(`Back toggle: <code>${escape(r.selectors.backImageToggleSelector || '—')}</code>`));
    ul.appendChild(li(`Close button: <code>${escape(r.selectors.closeSelector || '—')}</code>`));
    if (r.selectors.notes) ul.appendChild(li(`<em>${escape(r.selectors.notes)}</em>`));
    setHidden('train-step-3', true);
    setHidden('train-step-4', false);
    el('train-step-title').textContent = 'Training — step 4 of 4';
  } catch (e) {
    showError('train-step-3-error', e.message);
    el('train-step-3-status').textContent = '';
  }
}

el('train-cancel-modal').addEventListener('click', () => {
  setHidden('train-step-3', true);
  renderMainView();
});

el('train-redo-modal').addEventListener('click', () => {
  setHidden('train-step-4', true);
  setHidden('train-step-3', false);
  el('train-step-title').textContent = 'Training — step 3 of 4';
  armModalCapture();
});

el('train-finish').addEventListener('click', async () => {
  setHidden('train-step-4-error', true);
  try {
    const recipe = {
      version: 1,
      domain: currentDomain,
      learnedAt: new Date().toISOString(),
      accountDetail: trainState.accountDetail,
      checkModal: trainState.checkModal,
    };
    await saveRecipe(currentDomain, recipe);
    currentRecipe = recipe;
    await renderMainView();
  } catch (e) {
    showError('train-step-4-error', e.message);
  }
});

// ── Extract ───────────────────────────────────────────────────────────
//
// Extraction runs entirely in the content script and survives the popup
// closing. The popup just kicks it off (one-shot START_EXTRACT message)
// and renders progress from chrome.storage.local.extraction — which it
// re-reads on open and watches via storage.onChanged.

let renderedCaptureCount = 0;

async function runExtract() {
  show('view-main');
  setHidden('extract-progress', false);
  el('progress-fill').style.width = '0%';
  el('extract-log').innerHTML = '';
  renderedCaptureCount = 0;

  if (!currentTabId || !currentRecipe) {
    el('progress-text').textContent = 'No recipe — train first.';
    return;
  }

  // Clear any stale progress from a previous run before starting.
  await chrome.storage.local.remove('extraction');
  el('progress-text').textContent = 'Starting…';

  try {
    await ensureInjected(currentTabId);
    const resp = await csFetch(currentTabId, { type: 'START_EXTRACT', recipe: currentRecipe });
    if (resp.alreadyRunning) {
      log('An extraction is already running on this tab.', 'log-info');
    }
  } catch (e) {
    el('progress-text').textContent = 'Failed to start: ' + e.message;
    log('Failed to start: ' + e.message, 'log-err');
    return;
  }

  el('progress-text').textContent =
    'Running — you can close this popup; extraction keeps going in the tab.';
  void renderExtractionFromStorage();
}

async function renderExtractionFromStorage() {
  const { extraction } = await chrome.storage.local.get('extraction');
  renderExtraction(extraction);
}

function renderExtraction(state) {
  if (!state) return;
  setHidden('extract-progress', false);

  if (state.total > 0) {
    el('progress-fill').style.width = `${Math.round((state.current / state.total) * 100)}%`;
  }

  // Append capture log entries we haven't shown yet.
  const caps = state.captures || [];
  for (let i = renderedCaptureCount; i < caps.length; i++) {
    const c = caps[i];
    if (c.status === 'ok') {
      log(`✓ CHECK #${c.checkNumber || '?'} captured${c.hasBack ? ' (front+back)' : ' (front)'}` +
          `${c.retried ? ' [retry]' : ''}`, 'log-ok');
    } else {
      log(`✗ CHECK #${c.checkNumber || '?'}: ${c.error || 'no image'}` +
          `${c.retried ? ' [retry failed]' : ''}`, 'log-err');
    }
  }
  renderedCaptureCount = caps.length;

  if (state.fatal) {
    el('progress-text').textContent = 'Stopped: ' + state.fatal;
    return;
  }
  if (state.done) {
    const ok = caps.filter(c => c.status === 'ok').length;
    el('progress-fill').style.width = '100%';
    el('progress-text').textContent =
      `Done — ${ok}/${state.total} captured. Uploads finish in the background; check the CFO app.`;
  } else if (state.retrying) {
    el('progress-text').textContent =
      `Retrying failed checks — CHECK #${state.currentCheck || '?'}…`;
  } else {
    el('progress-text').textContent =
      `Processing ${state.current} / ${state.total} — CHECK #${state.currentCheck || '?'} ` +
      `(safe to close this popup)`;
  }
}

// Live progress updates while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extraction) {
    renderExtraction(changes.extraction.newValue);
  }
});

// Upload outcomes broadcast by the background worker (only seen while the
// popup is open — uploads still complete regardless).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPLOAD_RESULT') {
    if (msg.ok) {
      log(`↑ Uploaded CHECK #${msg.checkNumber || '?'} → CFO will analyze it.`, 'log-ok');
    } else {
      log(`↑✗ Upload failed for #${msg.checkNumber || '?'}: ${msg.error}`, 'log-err');
    }
  }
});

// ── Settings view ─────────────────────────────────────────────────────

async function openSettings() {
  const s = await getSettings();
  el('settings-cfo-url').value = s.cfoUrl || '';
  el('settings-api-key').value = s.apiKey || '';
  show('view-settings');
}

el('settings-save').addEventListener('click', async () => {
  await setSettings({
    cfoUrl: el('settings-cfo-url').value.trim(),
    apiKey: el('settings-api-key').value.trim(),
  });
  await renderMainView();
});

el('settings-back').addEventListener('click', () => renderMainView());

el('wipe-recipe').addEventListener('click', async () => {
  if (!currentDomain) return;
  await deleteRecipe(currentDomain);
  await renderMainView();
});

// ── Helpers ───────────────────────────────────────────────────────────

function li(html) { const x = document.createElement('li'); x.innerHTML = html; return x; }
function escape(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function showError(id, msg) {
  const e = el(id); e.textContent = msg; e.classList.remove('hidden');
}

// ── Go ───────────────────────────────────────────────────────────────

init();
