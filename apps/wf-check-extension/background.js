/**
 * WF Check Extractor — background service worker
 *
 * Handles UPLOAD_CHECK messages from the content script.
 * Posts captured check images to the CFO agent's /check-images endpoint.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'UPLOAD_CHECK') return;

  uploadCheck(msg)
    .then(result => sendResponse({ ok: true, result }))
    .catch(err => sendResponse({ ok: false, error: err.message }));

  return true; // keep channel open for async response
});

async function uploadCheck({ cfoUrl, apiKey, accountId, check }) {
  const url = cfoUrl.replace(/\/$/, '') + '/check-images';

  const body = {
    check_number: check.checkNumber,
    date: check.date,
    amount: check.amount,
    description: check.description,
    account_id: accountId,
    image_front: check.imageFront,
    image_back: check.imageBack,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error('CFO API ' + resp.status + ': ' + text.slice(0, 200));
  }

  return resp.json();
}
