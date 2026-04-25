/**
 * web/spa-app.js — the SPA delivered at /app/app.js.
 *
 * Vanilla JS, no build step. Hash-based routing. Each page calls its
 * /api/* endpoint and renders into #app. A right-side chat sidebar is
 * mounted on every page and posts to /api/chat.
 *
 * This file is delivered as a literal-string export. Keep it self-contained
 * — no imports from the Worker side at runtime.
 */

export const SPA_APP_JS = String.raw`
// ── tiny DOM helpers ────────────────────────────────────────────────────────
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

// ── API client ──────────────────────────────────────────────────────────────
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

// ── Toast ───────────────────────────────────────────────────────────────────
function toast(msg, kind = "info") {
  const tone = kind === "err" ? "bg-rose-600" : kind === "ok" ? "bg-emerald-600" : "bg-slate-800";
  const t = el("div", { class: \`fixed bottom-6 right-6 z-50 \${tone} text-white text-sm px-4 py-2 rounded-lg shadow-lg\` }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

// ── Modal ───────────────────────────────────────────────────────────────────
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

// ── Voice input (Web Speech API) ────────────────────────────────────────────
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
      textarea.value = (baseline + (final ? "\n" + final : "") + (interim ? " " + interim : "")).trim();
    };
    rec.onend = () => { listening = false; button.classList.remove("bg-rose-600", "text-white"); button.textContent = "🎤"; };
    rec.start();
    listening = true;
    button.classList.add("bg-rose-600", "text-white");
    button.textContent = "● rec";
  });
}

// ── App shell + routing ─────────────────────────────────────────────────────
const NAV = [
  { hash: "#/today",    label: "Today" },
  { hash: "#/week",     label: "This Week" },
  { hash: "#/projects", label: "Projects" },
  { hash: "#/people",   label: "People" },
  { hash: "#/triage",   label: "Triage" },
];

function renderShell() {
  const root = document.getElementById("app");
  root.innerHTML = "";
  const wrap = el("div", { class: "min-h-screen flex" });
  const main = el("main", { class: "flex-1 min-w-0", id: "main" });
  const aside = el("aside", { class: "w-[380px] shrink-0 border-l border-slate-200 bg-white/70 backdrop-blur sticky top-0 h-screen", id: "chat" });
  wrap.append(buildNav(), main, aside);
  root.appendChild(wrap);
  mountChatSidebar(aside);
  return main;
}

function buildNav() {
  const nav = el("nav", { class: "w-56 shrink-0 border-r border-slate-200 px-4 py-6 sticky top-0 h-screen flex flex-col" });
  nav.appendChild(el("a", {
    href: "#/today",
    class: "flex items-center gap-2 mb-8 text-2xl font-serif font-semibold tracking-tight",
  }, el("span", { class: "text-3xl" }, "✦"), "Chief"));
  for (const item of NAV) {
    const a = el("a", {
      href: item.hash,
      "data-hash": item.hash,
      class: "block px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 hover:text-ink transition",
    }, item.label);
    nav.appendChild(a);
  }
  const bottom = el("div", { class: "mt-auto pt-6 border-t border-slate-200 text-xs text-slate-400" });
  bottom.appendChild(el("a", { href: "/app/logout", class: "hover:text-slate-700" }, "Sign out"));
  nav.appendChild(bottom);
  return nav;
}

function highlightNav() {
  const hash = location.hash || "#/today";
  document.querySelectorAll("[data-hash]").forEach((a) => {
    const active = hash.startsWith(a.dataset.hash);
    a.classList.toggle("bg-ink",        active);
    a.classList.toggle("text-white",    active);
    a.classList.toggle("text-slate-600", !active);
    a.classList.toggle("hover:bg-slate-100", !active);
  });
}

async function route() {
  const hash = location.hash || "#/today";
  const main = renderShell();
  highlightNav();
  main.innerHTML = '<div class="p-10 text-slate-400">Loading…</div>';
  try {
    if (hash === "#/today") return await window.pageToday(main);
    if (hash === "#/week")  return await window.pageWeek(main);
    if (hash === "#/projects") return await window.pageProjects(main);
    if (hash.startsWith("#/projects/")) return await window.pageProjectDetail(main, decodeURIComponent(hash.slice("#/projects/".length)));
    if (hash === "#/people") return await window.pagePeople(main);
    if (hash.startsWith("#/people/")) return await window.pagePersonDetail(main, decodeURIComponent(hash.slice("#/people/".length)));
    if (hash === "#/triage") return await window.pageTriage(main);
    location.hash = "#/today";
  } catch (e) {
    main.innerHTML = "";
    main.appendChild(el("div", { class: "p-10 text-rose-600" }, "Error: " + e.message));
  }
}

window.addEventListener("hashchange", route);

// Expose helpers + route() so the pages chunks (concatenated below) can use them.
window.__cos = { $, el, fmtDate, fmtTime, isOverdue, api, toast, openModal, attachVoice, route };
`;
