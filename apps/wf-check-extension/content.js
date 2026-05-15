/**
 * Bank Check Extractor — content script
 *
 * Injected on demand by the popup (chrome.scripting.executeScript). The
 * popup tells this script what to do via chrome.tabs.sendMessage and
 * chrome.tabs.connect; this script never runs autonomously.
 *
 * Capabilities:
 *
 *   PROBE                Count how many rows + view-check buttons match the
 *                        saved recipe. Used to detect "recipe still works."
 *
 *   CAPTURE_DOM          Return a sanitized snapshot of document.body (for
 *                        learning the account-detail page).
 *
 *   ARM_MODAL_CAPTURE    Wait for the next modal/dialog to appear, capture
 *                        its sanitized HTML, return it. The user will click
 *                        the View Check button manually while this listener
 *                        is armed.
 *
 *   HIGHLIGHT            Paint colored outlines around elements matching
 *                        given selectors. Used during train confirmation.
 *
 *   CLEAR_HIGHLIGHT      Remove all painted outlines.
 *
 *   EXTRACT              (via port) Walk the recipe and capture every check
 *                        image on the page. Streams progress + images back
 *                        to the popup via the port.
 */

(function () {
  'use strict';

  if (window.__bankCheckExtractor) return;
  window.__bankCheckExtractor = true;

  // ── Utilities ──────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function waitForElement(selector, root, timeoutMs) {
    root = root || document;
    timeoutMs = timeoutMs || 12000;
    return new Promise((resolve, reject) => {
      const existing = root.querySelector(selector);
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const found = root.querySelector(selector);
        if (found) { obs.disconnect(); clearTimeout(timer); resolve(found); }
      });
      const target = root.nodeType === Node.DOCUMENT_NODE ? root.body || root : root;
      obs.observe(target, { childList: true, subtree: true });
      const timer = setTimeout(() => { obs.disconnect(); reject(new Error('timeout: ' + selector)); }, timeoutMs);
    });
  }

  function waitForImageLoaded(img, timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    if (img.complete && img.naturalWidth > 0) return Promise.resolve(img);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('img load timeout')), timeoutMs);
      img.addEventListener('load', () => { clearTimeout(t); resolve(img); }, { once: true });
      img.addEventListener('error', () => { clearTimeout(t); reject(new Error('img load error')); }, { once: true });
    });
  }

  // ── Sanitizer ──────────────────────────────────────────────────────────

  /**
   * Sanitize a DOM subtree for upload to /analyze-page.
   *
   * Goals:
   *   1. Preserve structure (tag names, hierarchy, class/id/role/aria/data attrs)
   *      so an LLM can infer CSS selectors.
   *   2. Strip text that looks like account numbers, balances, dollar amounts,
   *      payee names — anything identifiable. Keep short label text like
   *      "View Check", "Front", "Back" so the LLM can anchor on it.
   *   3. Cap output size.
   *
   * Returns the sanitized HTML string.
   */
  function sanitizeForUpload(root, maxBytes) {
    maxBytes = maxBytes || 180_000;
    const clone = root.cloneNode(true);

    // Drop tags that are noise for selector inference
    const drop = clone.querySelectorAll('script, style, noscript, svg, link, meta, iframe');
    for (const el of drop) el.remove();

    walkSanitize(clone);

    let html = clone.outerHTML || clone.innerHTML || '';

    // Trim if oversized — naive approach: cut from the end. Better than
    // shipping 5MB of HTML over the wire.
    if (html.length > maxBytes) {
      html = html.slice(0, maxBytes) + '\n<!-- TRUNCATED -->';
    }
    return html;
  }

  /** Attrs we keep verbatim — useful for selector inference, not sensitive. */
  const KEEP_ATTRS = new Set([
    'class', 'id', 'role', 'type', 'name', 'rel', 'for', 'tabindex',
  ]);
  /** Prefixes we keep (data-*, aria-*). */
  const KEEP_PREFIXES = ['data-', 'aria-'];

  function walkSanitize(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // Strip attrs we don't allowlist
      const attrs = Array.from(node.attributes || []);
      for (const a of attrs) {
        const name = a.name.toLowerCase();
        const keep = KEEP_ATTRS.has(name) || KEEP_PREFIXES.some(p => name.startsWith(p));
        if (!keep) {
          node.removeAttribute(a.name);
        } else if (name === 'aria-label' || name.startsWith('data-')) {
          // Sanitize text-bearing attrs
          node.setAttribute(a.name, sanitizeString(a.value));
        }
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      node.nodeValue = sanitizeString(node.nodeValue || '');
    }
    // Recurse — Array.from to allow mutation during walk
    if (node.childNodes && node.childNodes.length) {
      for (const child of Array.from(node.childNodes)) walkSanitize(child);
    }
  }

  /**
   * Replace digit runs (>=4 chars) and dollar-shaped strings with Xs of the
   * same length. Leaves short alpha tokens alone so labels survive.
   */
  function sanitizeString(s) {
    if (!s) return s;
    return s
      // dollar amounts like $1,234.56 or -$50.00
      .replace(/[-−]?\$?\d{1,3}(?:,\d{3})*\.\d{2}/g, m => 'X'.repeat(m.length))
      // long digit runs (account numbers, dates, etc.)
      .replace(/\d{4,}/g, m => 'X'.repeat(m.length))
      // dates MM/DD/YYYY or M/D/YY (replace just the digits)
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, m => m.replace(/\d/g, 'X'));
  }

  // ── Highlighter ────────────────────────────────────────────────────────

  const HIGHLIGHT_CLASS = '__bce_highlight';
  const HIGHLIGHT_STYLES = document.createElement('style');
  HIGHLIGHT_STYLES.textContent = `
    .__bce_highlight {
      outline: 3px solid #e11d48 !important;
      outline-offset: 2px !important;
      background-color: rgba(225, 29, 72, 0.08) !important;
      transition: outline 0.15s, background-color 0.15s !important;
    }
    .__bce_highlight_secondary {
      outline: 2px dashed #0ea5e9 !important;
      outline-offset: 1px !important;
    }
  `;

  function highlight(selectors) {
    clearHighlight();
    document.head.appendChild(HIGHLIGHT_STYLES);
    const counts = {};
    for (const [label, sel] of Object.entries(selectors)) {
      if (!sel) { counts[label] = 0; continue; }
      let matches = [];
      try { matches = Array.from(document.querySelectorAll(sel)); } catch { matches = []; }
      counts[label] = matches.length;
      const cls = label === 'primary' ? HIGHLIGHT_CLASS : '__bce_highlight_secondary';
      for (const el of matches) el.classList.add(cls);
    }
    return counts;
  }

  function clearHighlight() {
    for (const el of document.querySelectorAll('.' + HIGHLIGHT_CLASS + ', .__bce_highlight_secondary')) {
      el.classList.remove(HIGHLIGHT_CLASS, '__bce_highlight_secondary');
    }
  }

  // ── Image capture ──────────────────────────────────────────────────────

  async function imgToDataUrl(img) {
    await waitForImageLoaded(img);
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
      try {
        const resp = await fetch(img.src, { credentials: 'include' });
        if (resp.ok) return await blobToDataUrl(await resp.blob());
      } catch (_) { /* fall through */ }
    }
    if (img.src && img.src.startsWith('blob:')) {
      try {
        const resp = await fetch(img.src);
        if (resp.ok) return await blobToDataUrl(await resp.blob());
      } catch (_) { /* fall through */ }
    }
    // Canvas fallback (may taint if cross-origin)
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 800;
    canvas.height = img.naturalHeight || 400;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ── Probe ──────────────────────────────────────────────────────────────

  function probe(recipe) {
    const result = { rowMatches: 0, viewButtonMatches: 0, accountDetailOk: false };
    if (!recipe || !recipe.accountDetail) return result;
    const { rowSelector, viewCheckButtonSelector } = recipe.accountDetail;
    try {
      const rows = rowSelector ? document.querySelectorAll(rowSelector) : [];
      result.rowMatches = rows.length;
      let viewButtonHits = 0;
      for (const r of rows) {
        if (viewCheckButtonSelector && r.querySelector(viewCheckButtonSelector)) viewButtonHits++;
      }
      result.viewButtonMatches = viewButtonHits;
      result.accountDetailOk = rows.length > 0 && viewButtonHits > 0;
    } catch (_) { /* invalid selectors → 0 */ }
    return result;
  }

  // ── Modal capture (training step) ─────────────────────────────────────

  /**
   * Watch the DOM for a new dialog/modal to appear, then return its
   * sanitized outerHTML. Times out after 30s.
   */
  function captureNextModal() {
    const dialogSelectors = '[role="dialog"], [aria-modal="true"], dialog, [class*="modal" i]:not(body):not(html)';
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(dialogSelectors);
      if (existing) {
        setTimeout(() => resolve(sanitizeForUpload(existing)), 600);
        return;
      }
      let resolved = false;
      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const dlg = node.matches?.(dialogSelectors) ? node : node.querySelector?.(dialogSelectors);
            if (dlg) {
              resolved = true;
              obs.disconnect();
              // Give the modal contents a moment to populate (esp. images)
              setTimeout(() => resolve(sanitizeForUpload(dlg)), 1200);
              clearTimeout(timer);
              return;
            }
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        if (!resolved) { obs.disconnect(); reject(new Error('no modal appeared within 30s')); }
      }, 30000);
    });
  }

  // ── Row metadata extraction ────────────────────────────────────────────

  function extractFromRow(row, recipe) {
    const ad = recipe.accountDetail;
    const out = { checkNumber: null, date: null, amount: null, description: null };

    const fetchText = (selector) => {
      if (!selector) return null;
      try {
        const el = row.querySelector(selector);
        if (!el) return null;
        return (el.textContent || '').trim();
      } catch { return null; }
    };

    const checkText = fetchText(ad.checkNumberSelector);
    if (checkText) {
      const m = checkText.match(/(\d+)/);
      if (m) out.checkNumber = m[1];
    }

    const dateText = fetchText(ad.dateSelector);
    if (dateText) {
      const m = dateText.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b|\b(\d{4}-\d{2}-\d{2})\b/);
      if (m) out.date = m[1] || m[2];
    }

    const amountText = fetchText(ad.amountSelector);
    if (amountText) {
      const m = amountText.match(/[-−]?\$?[\d,]+\.\d{2}/);
      if (m) out.amount = m[0];
    }

    out.description = out.checkNumber ? `CHECK #${out.checkNumber}` : null;
    return out;
  }

  // ── Extract (replay) ──────────────────────────────────────────────────

  async function runExtract(recipe, port) {
    const ad = recipe.accountDetail;
    const cm = recipe.checkModal;
    if (!ad?.rowSelector || !ad?.viewCheckButtonSelector || !cm?.modalSelector || !cm?.frontImageSelector) {
      port.postMessage({ type: 'fatal', error: 'recipe incomplete — please retrain' });
      return;
    }

    let rows;
    try { rows = Array.from(document.querySelectorAll(ad.rowSelector)); }
    catch (e) { port.postMessage({ type: 'fatal', error: 'row selector invalid: ' + e.message }); return; }

    const total = rows.length;
    port.postMessage({ type: 'start', total });
    if (total === 0) { port.postMessage({ type: 'done', captures: [] }); return; }

    const captures = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const meta = extractFromRow(row, recipe);
      const current = i + 1;
      port.postMessage({ type: 'progress', current, total, checkNumber: meta.checkNumber });

      let imageFront = null;
      let imageBack = null;
      let error = null;

      try {
        const button = row.querySelector(ad.viewCheckButtonSelector);
        if (!button) throw new Error('view-check button not found inside row');

        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300);
        button.click();

        const modal = await waitForElement(cm.modalSelector, document, 12000);
        await sleep(500);

        const frontImg = modal.querySelector(cm.frontImageSelector);
        if (frontImg) imageFront = await imgToDataUrl(frontImg);

        if (cm.backImageSelector) {
          if (cm.backImageToggleSelector) {
            const toggle = modal.querySelector(cm.backImageToggleSelector);
            if (toggle) { toggle.click(); await sleep(700); }
          }
          const backImg = modal.querySelector(cm.backImageSelector);
          if (backImg) imageBack = await imgToDataUrl(backImg);
        }
      } catch (e) {
        error = e.message;
      } finally {
        // Close modal
        if (cm.closeSelector) {
          try { document.querySelector(cm.closeSelector)?.click(); } catch {}
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        await sleep(900);
      }

      const cap = { ...meta, imageFront, imageBack, error };
      captures.push(cap);

      if (imageFront) {
        port.postMessage({
          type: 'captured', current, total, checkNumber: meta.checkNumber,
          hasBack: !!imageBack,
        });
      } else {
        port.postMessage({
          type: 'capture_error', current, total, checkNumber: meta.checkNumber,
          error: error || 'no image extracted',
        });
      }

      // Upload immediately so the popup doesn't have to buffer N images
      chrome.runtime.sendMessage({
        type: 'UPLOAD_CHECK',
        check: {
          checkNumber: meta.checkNumber,
          date: meta.date,
          amount: meta.amount,
          description: meta.description,
          imageFront,
          imageBack,
        },
      });
    }

    port.postMessage({ type: 'done', captures: captures.map(c => ({
      checkNumber: c.checkNumber, date: c.date, amount: c.amount,
      error: c.error, hasFront: !!c.imageFront, hasBack: !!c.imageBack,
    })) });
  }

  // ── Message wiring ────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === 'PROBE') {
          sendResponse({ ok: true, probe: probe(msg.recipe) });
        } else if (msg.type === 'CAPTURE_DOM') {
          const html = sanitizeForUpload(document.body);
          sendResponse({ ok: true, html, url: location.href });
        } else if (msg.type === 'ARM_MODAL_CAPTURE') {
          const html = await captureNextModal();
          sendResponse({ ok: true, html, url: location.href });
        } else if (msg.type === 'HIGHLIGHT') {
          const counts = highlight(msg.selectors || {});
          sendResponse({ ok: true, counts });
        } else if (msg.type === 'CLEAR_HIGHLIGHT') {
          clearHighlight();
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'unknown message type: ' + msg.type });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // keep channel open for async sendResponse
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'bce-extract') return;
    port.onMessage.addListener((msg) => {
      if (msg.type !== 'EXTRACT') return;
      runExtract(msg.recipe, port).catch(err => {
        try { port.postMessage({ type: 'fatal', error: err.message }); } catch {}
      });
    });
  });
})();
