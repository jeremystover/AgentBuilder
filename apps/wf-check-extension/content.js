/**
 * WF Check Extractor — content script
 *
 * Runs on Wells Fargo account-detail pages. Communicated with by popup.js
 * via a named port ("wf-extraction"). Receives START message, iterates
 * every [data-testid="view-check-button"] on the page, clicks each one,
 * waits for the check image modal, captures the image, then sends
 * captured data back through the port.
 */

(function () {
  'use strict';

  if (window.__wfCheckExtensionLoaded) return;
  window.__wfCheckExtensionLoaded = true;

  // ── Utilities ─────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Poll until selector matches inside root, or timeout.
   */
  function waitForElement(selector, root, timeout) {
    root = root || document;
    timeout = timeout || 15000;
    return new Promise((resolve, reject) => {
      const el = root.querySelector(selector);
      if (el) return resolve(el);

      const obs = new MutationObserver(() => {
        const found = root.querySelector(selector);
        if (found) { obs.disconnect(); clearTimeout(timer); resolve(found); }
      });
      obs.observe(root.nodeType === Node.DOCUMENT_NODE ? root.body || root : root,
                  { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        reject(new Error('Timeout waiting for: ' + selector));
      }, timeout);
    });
  }

  /**
   * Wait until an <img> element is fully loaded (complete + non-zero size).
   */
  function waitForImageLoad(img, timeout) {
    timeout = timeout || 10000;
    if (img.complete && img.naturalWidth > 0) return Promise.resolve(img);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Image load timeout')), timeout);
      img.addEventListener('load', () => { clearTimeout(timer); resolve(img); }, { once: true });
      img.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Image load error')); }, { once: true });
    });
  }

  // ── Metadata extraction ───────────────────────────────────────────────────

  /**
   * Walk up from the "View Check" button to find the transaction row and
   * extract check number, date, and amount.
   */
  function extractRowMeta(button) {
    let el = button.parentElement;
    for (let i = 0; i < 20 && el; i++) {
      const text = el.textContent || '';
      const checkMatch = text.match(/CHECK\s+#?\s*(\d+)/i);
      if (checkMatch) {
        const checkNumber = checkMatch[1];
        // Date: MM/DD/YYYY
        const dateMatch = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
        // Amount: leading minus or dollar sign followed by digits
        const amountMatch = text.match(/([-−]?\$?[\d,]+\.\d{2})/);
        return {
          description: 'CHECK #' + checkNumber,
          checkNumber,
          date: dateMatch ? dateMatch[1] : null,
          amount: amountMatch ? amountMatch[1] : null,
        };
      }
      el = el.parentElement;
    }
    return { description: null, checkNumber: null, date: null, amount: null };
  }

  // ── Image capture ─────────────────────────────────────────────────────────

  /**
   * Convert an <img> element's src to a base64 data URL.
   * Tries fetch(credentials:'include') first so WF auth cookies are sent.
   * Falls back to canvas if fetch fails (e.g. opaque response).
   */
  async function imgToDataUrl(img) {
    // Ensure the image is loaded
    await waitForImageLoad(img);

    // Try fetch — works for same-origin and CORS-permitted images
    if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:')) {
      try {
        const resp = await fetch(img.src, { credentials: 'include' });
        if (resp.ok) {
          const blob = await resp.blob();
          return await blobToDataUrl(blob);
        }
      } catch (_) { /* fall through */ }
    }

    // Blob URL — fetch directly (accessible in page context)
    if (img.src && img.src.startsWith('blob:')) {
      try {
        const resp = await fetch(img.src);
        if (resp.ok) {
          const blob = await resp.blob();
          return await blobToDataUrl(blob);
        }
      } catch (_) { /* fall through */ }
    }

    // Canvas fallback — may throw SecurityError for cross-origin tainted images
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

  // ── Modal interaction ─────────────────────────────────────────────────────

  /**
   * Wait for any dialog/modal element to appear after clicking View Check.
   */
  async function waitForModal() {
    // WF uses various dialog patterns; try all common ones
    const selectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[class*="Modal__"]',
      '[class*="modal"]',
      '[class*="Dialog"]',
    ].join(', ');

    return waitForElement(selectors, document, 12000);
  }

  /**
   * Wait for .check-img-content to appear inside (or near) the modal,
   * then collect all <img> elements.
   */
  async function captureImagesFromModal(modal) {
    // check-img-content may be inside the modal or appended elsewhere
    let container;
    try {
      container = await waitForElement('.check-img-content', modal, 12000);
    } catch {
      // Try the whole document in case it's a portal
      container = await waitForElement('.check-img-content', document, 5000);
    }

    // Wait a beat for images to render
    await sleep(800);

    const imgs = Array.from(container.querySelectorAll('img'));
    if (imgs.length === 0) {
      // Some implementations use background-image; try to get the first img anywhere in the modal
      const anyImg = modal.querySelector('img');
      if (anyImg) imgs.push(anyImg);
    }

    const dataUrls = [];
    for (const img of imgs) {
      try {
        const dataUrl = await imgToDataUrl(img);
        if (dataUrl) dataUrls.push(dataUrl);
      } catch (e) {
        console.warn('[WFCheck] Image capture failed:', e.message);
      }
    }
    return dataUrls;
  }

  /**
   * Close the check image modal.
   */
  function closeModal() {
    // Prefer a close/dismiss button with accessible attributes
    const closeBtn = document.querySelector(
      '[aria-label*="close" i], [aria-label*="dismiss" i], ' +
      '[data-testid*="close"], [data-testid*="dismiss"], ' +
      'button[class*="close" i], button[class*="Close"]'
    );
    if (closeBtn instanceof HTMLElement) {
      closeBtn.click();
      return;
    }
    // Escape key
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
    );
  }

  // ── Main extraction loop ──────────────────────────────────────────────────

  async function runExtraction(config, port) {
    const buttons = Array.from(document.querySelectorAll('[data-testid="view-check-button"]'));
    const total = buttons.length;

    if (total === 0) {
      port.postMessage({ type: 'done', total: 0, results: [] });
      return;
    }

    port.postMessage({ type: 'start', total });

    const results = [];

    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      const meta = extractRowMeta(button);
      const current = i + 1;

      port.postMessage({ type: 'progress', current, total, checkNumber: meta.checkNumber });

      let images = [];
      let error = null;

      try {
        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(400);
        button.click();

        const modal = await waitForModal();
        images = await captureImagesFromModal(modal);

        port.postMessage({ type: 'captured', current, total, checkNumber: meta.checkNumber, imageCount: images.length });
      } catch (e) {
        error = e.message;
        port.postMessage({ type: 'error', current, total, checkNumber: meta.checkNumber, error: e.message });
      } finally {
        closeModal();
        await sleep(1200); // Let modal fully close before next click
      }

      const result = { ...meta, images, error };
      results.push(result);

      // If CFO upload is configured, send to background
      if (config.cfoUrl && images.length > 0) {
        chrome.runtime.sendMessage({
          type: 'UPLOAD_CHECK',
          cfoUrl: config.cfoUrl,
          apiKey: config.apiKey || null,
          accountId: config.accountId || null,
          check: {
            checkNumber: meta.checkNumber,
            date: meta.date,
            amount: meta.amount,
            description: meta.description,
            imageFront: images[0] || null,
            imageBack: images[1] || null,
          },
        });
      }
    }

    port.postMessage({ type: 'done', total, results });
  }

  // ── One-shot message listener (ping for count) ────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'WF_PING') {
      sendResponse({ count: document.querySelectorAll('[data-testid="view-check-button"]').length });
      return true;
    }
  });

  // ── Port listener ─────────────────────────────────────────────────────────

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'wf-extraction') return;

    port.onMessage.addListener((msg) => {
      if (msg.type !== 'START') return;
      runExtraction(msg, port).catch((err) => {
        try { port.postMessage({ type: 'fatal', error: err.message }); } catch {}
      });
    });
  });

})();
