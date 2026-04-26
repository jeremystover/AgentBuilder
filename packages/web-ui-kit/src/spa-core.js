/**
 * web-ui-kit/spa-core — the invariant SPA bundle.
 *
 * Exported as a literal string. Agents serve a concatenation of
 * SPA_CORE_JS + their own page-renderer JS at /app/app.js. The core sets
 * up:
 *
 *   window.__cos = { $, el, fmtDate, fmtTime, isOverdue, api, toast,
 *                    openModal, attachVoice, route }
 *
 * It also defines:
 *   - renderShell()      mounts nav + main + chat sidebar slots
 *   - buildNav(items)    given an array of {hash,label} renders the side nav
 *   - mountChatSidebar   default chat sidebar that POSTs to /api/chat
 *   - route() entry      dispatches by location.hash to window.page<X>
 *
 * Agent-specific JS must:
 *   1. Set window.NAV = [{hash, label}, ...]   before route() runs
 *   2. Define window.pageToday, window.pageWeek, etc. matching the hashes
 *   3. Call window.__cos.route() once on DOMContentLoaded (the agent JS
 *      tail does this — see template).
 */

export const SPA_CORE_JS = `
const $  = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, "");
    else if (v === false || v == null) {}
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};
const fmtDate = (s) => {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const fmtTime = (s) => {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};
const isOverdue = (iso) => iso && new Date(iso) < new Date(new Date().setHours(0, 0, 0, 0));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) {
    location.href = "/app/login";
    throw new Error("unauthorized");
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || ("HTTP " + res.status));
  return data;
}

function toast(msg, kind = "info") {
  const tone = kind === "err" ? "bg-rose-600" : kind === "ok" ? "bg-emerald-600" : "bg-slate-800";
  const t = el("div", { class: \`fixed bottom-6 right-6 z-50 \${tone} text-white text-sm px-4 py-2 rounded-lg shadow-lg\` }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

function openModal(content) {
  const overlay = el("div", {
    class: "fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-sm flex items-center justify-center px-4",
    onclick: (e) => { if (e.target === overlay) close(); },
  });
  const close = () => overlay.remove();
  const card = el("div", { class: "bg-white rounded-2xl shadow-xl w-full max-w-lg ring-1 ring-slate-200 p-6 relative" });
  card.appendChild(el("button", {
    class: "absolute top-3 right-3 text-slate-400 hover:text-slate-700 text-xl leading-none",
    onclick: close,
  }, "×"));
  card.appendChild(content);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  return { close };
}

function attachVoice(button, textarea) {
  const Sr = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Sr) {
    button.disabled = true;
    button.title = "Voice not supported in this browser";
    button.classList.add("opacity-30", "cursor-not-allowed");
    return;
  }
  let rec, listening = false;
  button.addEventListener("click", () => {
    if (listening) { rec?.stop(); return; }
    rec = new Sr();
    rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || "en-US";
    let baseline = textarea.value;
    rec.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const tr = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += tr; else interim += tr;
      }
      textarea.value = (baseline + (final ? "\\n" + final : "") + (interim ? " " + interim : "")).trim();
    };
    rec.onend = () => { listening = false; button.classList.remove("bg-rose-600", "text-white"); button.textContent = "🎤"; };
    rec.start();
    listening = true;
    button.classList.add("bg-rose-600", "text-white");
    button.textContent = "● rec";
  });
}

// ── Mobile drawers ──────────────────────────────────────────────────────────
//
// The persistent layout is nav + main + chat. On viewports too narrow to
// fit all three (anything below ~1280px), one or both rails collapse and
// re-open as a drawer triggered from the mobile top bar:
//
//   < md   (mobile, < 768px):  both nav and chat hidden by default,
//                              top bar visible with hamburger + chat icons
//   md..lg (tablet, 768..1024): nav visible, chat hidden + drawer toggle
//   >= lg  (desktop, >= 1024):  nav and chat both visible (current shell)
//
// The drawers are rendered on demand into document.body and removed on
// close. They reuse buildNav() / mountChatSidebar() so behavior stays in
// sync with the persistent rails — no duplicated config.

function openDrawer({ side, content, hideAtBreakpoint }) {
  const overlay = el("div", {
    class: \`fixed inset-0 z-40 bg-slate-900/40 \${hideAtBreakpoint}\`,
  });
  const drawer = el("aside", {
    class: [
      "fixed inset-y-0 z-50 max-w-[85vw] bg-paper border-slate-200 flex flex-col shadow-xl overflow-hidden",
      side === "left" ? "left-0 border-r w-72" : "right-0 border-l w-[380px]",
      hideAtBreakpoint,
    ].join(" "),
  });
  drawer.append(content);
  const close = () => { overlay.remove(); drawer.remove(); };
  overlay.addEventListener("click", close);
  // Close on link click so navigation actually feels like navigation —
  // otherwise the drawer hangs over the next page after the hash route
  // resolves.
  drawer.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("a[href]")) close();
  });
  document.body.append(overlay, drawer);
  return { close };
}

function buildMobileBar() {
  const brand = window.AGENT_BRAND || { mark: "✦", label: "Agent" };
  const bar = el("header", {
    class: "md:hidden fixed top-0 left-0 right-0 z-30 h-14 px-3 bg-paper/95 backdrop-blur border-b border-slate-200 flex items-center justify-between",
  });
  const navBtn = el("button", {
    class: "p-2 -ml-2 text-slate-600 hover:text-ink",
    "aria-label": "Open menu",
    onclick: () => openDrawer({ side: "left", hideAtBreakpoint: "md:hidden", content: buildNav({ inDrawer: true }) }),
  });
  navBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  const brandEl = el("div", { class: "flex items-center gap-1.5 font-serif font-semibold text-lg" },
    el("span", { class: "text-xl" }, brand.mark),
    brand.label,
  );
  const chatBtn = el("button", {
    class: "p-2 -mr-2 text-slate-600 hover:text-ink",
    "aria-label": "Open chat",
    onclick: () => {
      const aside = el("div", { class: "flex-1 flex flex-col" });
      (window.mountChatSidebar || defaultMountChatSidebar)(aside);
      openDrawer({ side: "right", hideAtBreakpoint: "lg:hidden", content: aside });
    },
  });
  chatBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  bar.append(navBtn, brandEl, chatBtn);
  return bar;
}

function buildTabletChatToggle() {
  // Floating action button visible only on tablet (md..lg) where the
  // persistent chat aside is hidden but there's no mobile top bar.
  const btn = el("button", {
    class: "hidden md:flex lg:hidden fixed bottom-6 right-6 z-30 w-12 h-12 rounded-full bg-ink text-white shadow-lg items-center justify-center hover:bg-slate-700",
    "aria-label": "Open chat",
    onclick: () => {
      const aside = el("div", { class: "flex-1 flex flex-col" });
      (window.mountChatSidebar || defaultMountChatSidebar)(aside);
      openDrawer({ side: "right", hideAtBreakpoint: "lg:hidden", content: aside });
    },
  });
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  return btn;
}

function ensureMobileChrome() {
  // The mobile top bar and tablet chat-toggle are appended directly to
  // document.body (not #app), so they survive renderShell's innerHTML
  // wipe between route changes. Dedupe by id to prevent stacking.
  if (!document.getElementById("__cos_mobile_bar")) {
    const bar = buildMobileBar();
    bar.id = "__cos_mobile_bar";
    document.body.appendChild(bar);
  }
  if (!document.getElementById("__cos_tablet_toggle")) {
    const btn = buildTabletChatToggle();
    btn.id = "__cos_tablet_toggle";
    document.body.appendChild(btn);
  }
}

function renderShell() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  const wrap = el("div", { class: "min-h-screen flex" });
  // Persistent nav — visible on md+, hidden on mobile (mobile uses drawer)
  const nav = buildNav();
  nav.classList.add("hidden", "md:flex");
  // Persistent chat aside — visible on lg+, hidden on smaller (drawer)
  const aside = el("aside", {
    class: "w-[380px] shrink-0 border-l border-slate-200 bg-white/70 backdrop-blur sticky top-0 h-screen hidden lg:flex flex-col",
    id: "chat",
  });
  // Main column — pads top on mobile to clear the fixed mobile bar
  const main = el("main", { class: "flex-1 min-w-0 pt-14 md:pt-0", id: "main" });
  wrap.append(nav, main, aside);
  root.appendChild(wrap);
  ensureMobileChrome();
  (window.mountChatSidebar || defaultMountChatSidebar)(aside);
  return main;
}

function buildNav(opts = {}) {
  const items = window.NAV || [];
  const brand = window.AGENT_BRAND || { mark: "✦", label: "Agent" };
  // Default = persistent rail (sticky inside flex parent). When the drawer
  // calls this with { inDrawer: true } we skip 'sticky' / 'h-screen' since
  // the drawer host already positions it fixed with full height.
  const cls = opts.inDrawer
    ? "w-full h-full px-4 py-6 flex flex-col"
    : "w-56 shrink-0 border-r border-slate-200 px-4 py-6 sticky top-0 h-screen flex-col";
  const nav = el("nav", { class: cls });
  const home = items[0]?.hash || "#/";
  nav.appendChild(el("a", {
    href: home,
    class: "flex items-center gap-2 mb-8 text-2xl font-serif font-semibold tracking-tight",
  }, el("span", { class: "text-3xl" }, brand.mark), brand.label));
  for (const item of items) {
    const attrs = {
      href: item.hash,
      "data-hash": item.hash,
      class: "block px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 hover:text-ink transition",
    };
    if (item.target) {
      attrs.target = item.target;
      attrs.rel = "noopener";
    }
    nav.appendChild(el("a", attrs, item.label));
  }
  const bottom = el("div", { class: "mt-auto pt-6 border-t border-slate-200 text-xs text-slate-400" });
  bottom.appendChild(el("a", { href: "/app/logout", class: "hover:text-slate-700" }, "Sign out"));
  nav.appendChild(bottom);
  return nav;
}

function highlightNav() {
  const hash = location.hash || (window.NAV?.[0]?.hash) || "#/";
  document.querySelectorAll("[data-hash]").forEach((a) => {
    const active = hash.startsWith(a.dataset.hash);
    a.classList.toggle("bg-ink",         active);
    a.classList.toggle("text-white",     active);
    a.classList.toggle("text-slate-600", !active);
    a.classList.toggle("hover:bg-slate-100", !active);
  });
}

async function route() {
  const items = window.NAV || [];
  const hash = location.hash || items[0]?.hash || "#/";
  const main = renderShell();
  highlightNav();
  main.innerHTML = '<div class="p-10 text-slate-400">Loading…</div>';
  try {
    const routes = window.ROUTES || [];
    for (const r of routes) {
      const m = hash.match(r.pattern);
      if (m) {
        const fn = window[r.handler];
        if (typeof fn !== "function") throw new Error("Route handler missing: " + r.handler);
        return await fn(main, ...m.slice(1).map(decodeURIComponent));
      }
    }
    if (items.length) location.hash = items[0].hash;
  } catch (e) {
    main.innerHTML = "";
    main.appendChild(el("div", { class: "p-10 text-rose-600" }, "Error: " + e.message));
  }
}

function defaultMountChatSidebar(aside) {
  aside.innerHTML = "";
  const head = el("div", { class: "px-5 pt-5 pb-3 border-b border-slate-200" },
    el("div", { class: "flex items-center justify-between" },
      el("div", { class: "text-sm font-semibold uppercase tracking-wide text-slate-500" }, "Chat"),
      el("button", { class: "text-xs text-slate-400 hover:text-ink",
        onclick: () => { history.length = 0; transcript.innerHTML = ""; } }, "Clear"),
    ),
  );
  const transcript = el("div", { class: "flex-1 overflow-y-auto scrollbar-thin px-5 py-4 space-y-3 text-sm" });
  const ta = el("textarea", { rows: 2, placeholder: "Ask…",
    class: "flex-1 rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none" });
  const voice = el("button", { class: "rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm hover:bg-slate-50" }, "🎤");
  attachVoice(voice, ta);
  const send = el("button", { class: "rounded-lg bg-ink text-white px-3 py-2 text-sm font-medium hover:bg-slate-700" }, "↑");
  const inputRow = el("div", { class: "px-5 py-4 border-t border-slate-200 flex gap-2 items-end" }, ta, voice, send);

  let history = [];
  async function submit() {
    const msg = ta.value.trim(); if (!msg) return;
    ta.value = "";
    transcript.appendChild(el("div", { class: "flex justify-end" },
      el("div", { class: "bg-ink text-white rounded-2xl rounded-br-sm px-3 py-2 max-w-[85%] whitespace-pre-wrap" }, msg)));
    transcript.scrollTop = transcript.scrollHeight;
    const pending = el("div", { class: "text-slate-400 italic" }, "Thinking…");
    transcript.appendChild(pending);
    try {
      const data = await api("/api/chat", { method: "POST", body: { message: msg, history,
        pageContext: { hash: location.hash } } });
      pending.remove();
      history = data.messages || history;
      transcript.appendChild(el("div", {},
        el("div", { class: "bg-white ring-1 ring-slate-200 rounded-2xl rounded-bl-sm px-3 py-2 max-w-[95%] whitespace-pre-wrap" },
          data.reply || "(no reply)")));
      transcript.scrollTop = transcript.scrollHeight;
    } catch (err) {
      pending.remove();
      transcript.appendChild(el("div", { class: "text-rose-600" }, "Error: " + err.message));
    }
  }
  send.addEventListener("click", submit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });
  aside.classList.add("flex", "flex-col");
  aside.append(head, transcript, inputRow);
}

window.addEventListener("hashchange", route);
function fillChatInput(text) {
  const ta = document.querySelector("#chat textarea");
  if (!ta) return false;
  ta.value = text;
  ta.focus();
  return true;
}
window.__cos = { $, el, fmtDate, fmtTime, isOverdue, api, toast, openModal, attachVoice, route, fillChatInput };
window.fillChatInput = fillChatInput;

document.addEventListener("DOMContentLoaded", () => {
  const items = window.NAV || [];
  if (!location.hash && items[0]) location.hash = items[0].hash;
  route();
});
if (document.readyState !== "loading") {
  const items = window.NAV || [];
  if (!location.hash && items[0]) location.hash = items[0].hash;
  route();
}
`;
