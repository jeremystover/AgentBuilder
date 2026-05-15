/**
 * Bank Check Extractor — background service worker
 *
 * Responsibilities:
 *   1. Talk to the CFO server (the popup could do this directly, but keeping
 *      it here means the popup can close mid-upload without aborting).
 *   2. Inject the content script on demand (popup asks via ENSURE_INJECTED).
 *
 * All API calls expect settings { cfoUrl, apiKey } in chrome.storage.local.
 */

// ── Settings helpers ──────────────────────────────────────────────────────

async function getSettings() {
  const s = await chrome.storage.local.get(['settings']);
  return s.settings || {};
}

async function apiFetch(path, opts) {
  const { cfoUrl, apiKey } = await getSettings();
  if (!cfoUrl) throw new Error('CFO URL not configured');
  const url = cfoUrl.replace(/\/$/, '') + path;
  const headers = { 'Content-Type': 'application/json', ...(opts?.headers || {}) };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const resp = await fetch(url, { ...opts, headers });
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!resp.ok) {
    const errMsg = (body && body.error) || text || resp.statusText;
    throw new Error(`${resp.status}: ${String(errMsg).slice(0, 300)}`);
  }
  return body;
}

function broadcastUploadResult(ok, checkNumber, error, id) {
  chrome.runtime.sendMessage({
    type: 'UPLOAD_RESULT',
    ok,
    checkNumber: checkNumber || null,
    error: error || null,
    id: id || null,
  }).catch(() => { /* no popup open — ignore */ });
}

// ── Cross-origin image fetch + JPEG normalization ─────────────────────────

/**
 * Re-encode arbitrary image bytes to a JPEG data URL. The bitmap is built
 * from a same-origin Blob, so the OffscreenCanvas is never tainted. Falls
 * back to passing the original bytes through if the format can't be decoded.
 */
async function normalizeToJpegDataUrl(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return await blobToBase64DataUrl(jpeg);
  } catch (_) {
    return await blobToBase64DataUrl(blob);
  }
}

async function blobToBase64DataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
}

// ── Message router ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'ENSURE_INJECTED') {
        await chrome.scripting.executeScript({
          target: { tabId: msg.tabId },
          files: ['content.js'],
        });
        sendResponse({ ok: true });
      } else if (msg.type === 'FETCH_ACCOUNTS') {
        const r = await apiFetch('/api/extension/v1/accounts', { method: 'GET' });
        sendResponse({ ok: true, accounts: r.accounts || [] });
      } else if (msg.type === 'FETCH_IMAGE') {
        try {
          const resp = await fetch(msg.url, { credentials: 'include' });
          if (!resp.ok) {
            sendResponse({ ok: false, error: `image fetch HTTP ${resp.status}` });
            return;
          }
          const blob = await resp.blob();
          if (!blob || blob.size === 0) {
            sendResponse({ ok: false, error: 'empty image response' });
            return;
          }
          const dataUrl = await normalizeToJpegDataUrl(blob);
          sendResponse({ ok: true, dataUrl });
        } catch (imgErr) {
          sendResponse({ ok: false, error: `image fetch failed: ${imgErr.message || imgErr}` });
        }
      } else if (msg.type === 'ANALYZE_PAGE') {
        const r = await apiFetch('/api/extension/v1/analyze-page', {
          method: 'POST',
          body: JSON.stringify({ purpose: msg.purpose, url: msg.url, html: msg.html }),
        });
        sendResponse({ ok: true, selectors: r.selectors, purpose: r.purpose });
      } else if (msg.type === 'UPLOAD_CHECK') {
        const { accountId } = await getSettings();
        const check = msg.check || {};
        if (!accountId) {
          broadcastUploadResult(false, check.checkNumber, 'no account selected — open the extension and pick one');
          sendResponse({ ok: false, error: 'no account selected' });
          return;
        }
        if (!check.imageFront) {
          broadcastUploadResult(false, check.checkNumber, 'no front image to upload');
          sendResponse({ ok: false, error: 'no front image' });
          return;
        }
        try {
          const r = await apiFetch('/api/extension/v1/check-images', {
            method: 'POST',
            body: JSON.stringify({
              account_id: accountId,
              check_number: check.checkNumber,
              date: check.date,
              amount: check.amount,
              description: check.description,
              image_front: check.imageFront,
              image_back: check.imageBack || null,
            }),
          });
          broadcastUploadResult(true, check.checkNumber, null, r.id);
          sendResponse({ ok: true, id: r.id, status: r.status });
        } catch (uploadErr) {
          broadcastUploadResult(false, check.checkNumber, uploadErr.message);
          sendResponse({ ok: false, error: uploadErr.message });
        }
      } else {
        sendResponse({ ok: false, error: 'unknown background message: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // async response
});
