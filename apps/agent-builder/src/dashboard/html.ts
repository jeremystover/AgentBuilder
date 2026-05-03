/**
 * Dashboard HTML + client JS, served as one document.
 *
 * Vanilla mode per AGENTS.md rule 9 — no build step, Tailwind via CDN,
 * paper theme. The client JS calls /dashboard/api/* and renders into the
 * three tab containers below.
 */

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=Inter:wght@400;500;600&display=swap';

export function loginPage(opts: { error?: string } = {}): string {
  const err = opts.error ? escapeHtml(opts.error) : '';
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AgentBuilder · Sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="${FONTS_HREF}"/>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: Inter, ui-sans-serif, system-ui; background: #fbfaf6; color: #1f2433; }
  h1 { font-family: 'Source Serif 4', Georgia, serif; letter-spacing: -0.01em; }
</style>
</head>
<body class="min-h-screen flex items-center justify-center px-4">
  <div class="w-full max-w-sm">
    <div class="text-center mb-8">
      <div class="text-5xl mb-3">⌬</div>
      <h1 class="text-3xl font-semibold">AgentBuilder</h1>
      <p class="text-sm text-slate-500 mt-2">Fleet dashboard</p>
    </div>
    <form method="POST" action="/dashboard/login" class="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200 p-6 space-y-4">
      ${err ? `<div class="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-700">${err}</div>` : ''}
      <label class="block">
        <span class="text-xs uppercase tracking-wide text-slate-500">Password</span>
        <input type="password" name="password" autofocus required
          class="mt-1 block w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none"/>
      </label>
      <button type="submit"
        class="w-full rounded-lg bg-slate-800 text-white py-2.5 text-sm font-medium hover:bg-slate-700 transition">
        Continue
      </button>
    </form>
  </div>
</body></html>`;
}

export function dashboardPage(): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AgentBuilder Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="${FONTS_HREF}"/>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: Inter, ui-sans-serif, system-ui; background: #fbfaf6; color: #1f2433; }
  h1, h2, h3 { font-family: 'Source Serif 4', Georgia, serif; letter-spacing: -0.01em; }
  .pill { display: inline-flex; align-items: center; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 500; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; }
  table.tbl { width: 100%; border-collapse: collapse; }
  table.tbl th, table.tbl td { padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; border-bottom: 1px solid #e5e7eb; font-size: 0.85rem; }
  table.tbl th { font-weight: 600; color: #475569; background: #f8fafc; position: sticky; top: 0; }
  .tab-active { background: #1f2433; color: white; }
  details > summary { cursor: pointer; list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
</style>
</head>
<body class="min-h-screen">
<header class="bg-white border-b border-slate-200">
  <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <span class="text-2xl">⌬</span>
      <h1 class="text-xl font-semibold">AgentBuilder Fleet</h1>
    </div>
    <div class="flex items-center gap-2">
      <button id="refresh-btn" class="text-sm px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 transition">Refresh</button>
      <a href="/dashboard/logout" class="text-sm text-slate-500 hover:text-slate-800">Sign out</a>
    </div>
  </div>
  <nav class="max-w-7xl mx-auto px-4 pb-2 flex gap-1">
    <button data-tab="agents" class="tab-btn px-4 py-1.5 rounded-md text-sm font-medium tab-active">Agents</button>
    <button data-tab="crons" class="tab-btn px-4 py-1.5 rounded-md text-sm font-medium hover:bg-slate-100">Scheduled jobs</button>
    <button data-tab="d1" class="tab-btn px-4 py-1.5 rounded-md text-sm font-medium hover:bg-slate-100">D1 browser</button>
  </nav>
</header>

<main class="max-w-7xl mx-auto px-4 py-6">
  <div id="tab-agents" class="tab-pane"></div>
  <div id="tab-crons" class="tab-pane hidden"></div>
  <div id="tab-d1" class="tab-pane hidden"></div>
</main>

<script>
${CLIENT_JS}
</script>
</body></html>`;
}

const CLIENT_JS = String.raw`
"use strict";

// ── Utilities ─────────────────────────────────────────────────────────────

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const k in (attrs || {})) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children || [])) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function statusPill(status) {
  const map = {
    active:     "bg-emerald-100 text-emerald-700",
    draft:      "bg-amber-100 text-amber-700",
    deprecated: "bg-slate-200 text-slate-600",
    ok:         "bg-emerald-100 text-emerald-700",
    error:      "bg-rose-100 text-rose-700",
  };
  return el("span", { class: "pill " + (map[status] || "bg-slate-100 text-slate-600") }, status || "—");
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const diff = (now - d) / 1000;
  const past = diff >= 0;
  const a = Math.abs(diff);
  let rel;
  if (a < 60) rel = Math.round(a) + "s";
  else if (a < 3600) rel = Math.round(a / 60) + "m";
  else if (a < 86400) rel = Math.round(a / 3600) + "h";
  else rel = Math.round(a / 86400) + "d";
  return (past ? rel + " ago" : "in " + rel);
}

function fmtAbs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\..+/, " UTC");
}

function fmtMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

async function fetchJson(url) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(url + " → " + r.status);
  return await r.json();
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// ── Tab switching ─────────────────────────────────────────────────────────

const tabs = ["agents", "crons", "d1"];
function showTab(name) {
  for (const t of tabs) {
    document.getElementById("tab-" + t).classList.toggle("hidden", t !== name);
  }
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("tab-active", btn.dataset.tab === name);
  }
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  loadTab(name);
}
document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
document.getElementById("refresh-btn").addEventListener("click", () => loadTab(currentTab(), true));
function currentTab() { return location.hash.slice(1) || "agents"; }
const initialTab = tabs.includes(currentTab()) ? currentTab() : "agents";

// ── Agents tab ────────────────────────────────────────────────────────────

const cache = { agents: null, crons: null, d1: null };

async function loadTab(name, force) {
  if (force) cache[name] = null;
  if (name === "agents") return renderAgents();
  if (name === "crons") return renderCrons();
  if (name === "d1") return renderD1();
}

async function renderAgents() {
  const root = document.getElementById("tab-agents");
  clear(root);
  root.appendChild(el("div", { class: "text-sm text-slate-500 mb-4" }, "Loading…"));
  try {
    if (!cache.agents) cache.agents = await fetchJson("/dashboard/api/agents");
    const data = cache.agents;
    clear(root);

    const summary = el("div", { class: "mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3" }, [
      statCard("Agents", data.agents.length),
      statCard("Active", data.agents.filter((a) => a.status === "active").length),
      statCard("Draft", data.agents.filter((a) => a.status === "draft").length),
      statCard("Updated", fmtTime(data.updatedAt)),
    ]);
    root.appendChild(summary);

    const grid = el("div", { class: "grid grid-cols-1 lg:grid-cols-2 gap-4" });
    for (const a of data.agents) grid.appendChild(agentCard(a));
    root.appendChild(grid);
  } catch (err) {
    clear(root);
    root.appendChild(el("div", { class: "text-rose-700" }, "Failed to load: " + err.message));
  }
}

function statCard(label, value) {
  return el("div", { class: "bg-white rounded-lg ring-1 ring-slate-200 px-4 py-3" }, [
    el("div", { class: "text-xs uppercase tracking-wide text-slate-500" }, label),
    el("div", { class: "text-xl font-semibold mt-0.5" }, String(value)),
  ]);
}

function agentCard(a) {
  const cf = a.cloudflare || {};
  const headerRow = el("div", { class: "flex items-start justify-between gap-3" }, [
    el("div", {}, [
      el("div", { class: "flex items-center gap-2" }, [
        el("h3", { class: "text-lg font-semibold" }, a.name),
        statusPill(a.status),
        el("span", { class: "pill bg-slate-100 text-slate-600" }, a.kind),
      ]),
      el("div", { class: "text-xs text-slate-500 mono mt-0.5" }, a.id + " · v" + a.version + (a.lastDeployed ? " · deployed " + fmtTime(a.lastDeployed) : "")),
    ]),
    el("div", { class: "text-right text-xs" }, [
      a.cronRunCount > 0 ? el("div", {}, [el("span", { class: "font-semibold" }, String(a.cronRunCount)), " cron runs"]) : null,
      a.cronErrorCount > 0 ? el("div", { class: "text-rose-700" }, [el("span", { class: "font-semibold" }, String(a.cronErrorCount)), " errors"]) : null,
    ]),
  ]);
  const purpose = el("p", { class: "text-sm text-slate-700 mt-2" }, a.purpose);

  const tools = el("details", { class: "mt-3" }, [
    el("summary", { class: "text-xs uppercase tracking-wide text-slate-500 hover:text-slate-800" }, "Tools (" + (a.tools.length) + ")"),
    el("ul", { class: "mt-2 space-y-1" }, a.tools.map((t) => el("li", { class: "text-sm" }, [
      el("span", { class: "mono font-medium" }, t.name),
      t.description ? el("span", { class: "text-slate-500" }, " — " + t.description) : el("span", { class: "text-slate-400 italic" }, " — (no description)"),
    ]))),
  ]);

  const meta = el("details", { class: "mt-2" }, [
    el("summary", { class: "text-xs uppercase tracking-wide text-slate-500 hover:text-slate-800" }, "Bindings"),
    el("div", { class: "mt-2 text-xs space-y-0.5" }, [
      cf.workerName ? el("div", {}, "worker: " + cf.workerName) : null,
      cf.d1?.length ? el("div", {}, "d1: " + cf.d1.join(", ")) : null,
      cf.kv?.length ? el("div", {}, "kv: " + cf.kv.join(", ")) : null,
      cf.r2?.length ? el("div", {}, "r2: " + cf.r2.join(", ")) : null,
      cf.queues?.length ? el("div", {}, "queues: " + cf.queues.join(", ")) : null,
      cf.durableObjects?.length ? el("div", {}, "durable objects: " + cf.durableObjects.join(", ")) : null,
    ].filter(Boolean)),
  ]);

  const crons = (a.crons && a.crons.length)
    ? el("details", { class: "mt-2" }, [
        el("summary", { class: "text-xs uppercase tracking-wide text-slate-500 hover:text-slate-800" }, "Crons (" + a.crons.length + ")"),
        el("ul", { class: "mt-2 text-sm space-y-1" }, a.crons.map((c) => el("li", {}, [
          el("span", { class: "mono" }, c.schedule),
          el("span", { class: "text-slate-500" }, " · "),
          el("span", { class: "font-medium" }, c.trigger),
          c.description ? el("div", { class: "text-xs text-slate-500 ml-1" }, c.description) : null,
        ]))),
      ])
    : null;

  return el("div", { class: "bg-white rounded-lg ring-1 ring-slate-200 p-4" }, [
    headerRow, purpose, tools, meta, crons,
  ].filter(Boolean));
}

// ── Crons tab ─────────────────────────────────────────────────────────────

async function renderCrons() {
  const root = document.getElementById("tab-crons");
  clear(root);
  root.appendChild(el("div", { class: "text-sm text-slate-500 mb-4" }, "Loading…"));
  try {
    if (!cache.crons) cache.crons = await fetchJson("/dashboard/api/crons");
    const { jobs } = cache.crons;
    clear(root);

    const errCount = jobs.reduce((n, j) => n + j.last7d.error, 0);
    const okCount = jobs.reduce((n, j) => n + j.last7d.ok, 0);
    const summary = el("div", { class: "mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3" }, [
      statCard("Scheduled jobs", jobs.length),
      statCard("Last 7d ok", okCount),
      statCard("Last 7d errors", errCount),
      statCard("Agents w/ crons", new Set(jobs.map((j) => j.agentId)).size),
    ]);
    root.appendChild(summary);

    if (errCount > 0) {
      const errBanner = el("div", { class: "mb-4 rounded-md bg-rose-50 ring-1 ring-rose-200 px-4 py-2 text-sm text-rose-800" },
        errCount + " cron run(s) failed in the last 7 days. Click a row to inspect."
      );
      root.appendChild(errBanner);
    }

    // Sort: failures first, then by next run time
    jobs.sort((a, b) => {
      if ((b.last7d.error > 0) !== (a.last7d.error > 0)) return (b.last7d.error > 0) ? 1 : -1;
      return (a.nextRun || "").localeCompare(b.nextRun || "");
    });

    const wrap = el("div", { class: "bg-white rounded-lg ring-1 ring-slate-200 overflow-hidden" }, [
      el("table", { class: "tbl" }, [
        el("thead", {}, el("tr", {}, [
          el("th", {}, "Agent"),
          el("th", {}, "Trigger"),
          el("th", {}, "Schedule"),
          el("th", {}, "Last run"),
          el("th", {}, "Next run"),
          el("th", {}, "7d ok / err"),
          el("th", {}, ""),
        ])),
        el("tbody", {}, jobs.map(cronRow)),
      ]),
    ]);
    root.appendChild(wrap);
  } catch (err) {
    clear(root);
    root.appendChild(el("div", { class: "text-rose-700" }, "Failed to load: " + err.message));
  }
}

function cronRow(j) {
  const last = j.lastRun;
  const lastCell = last
    ? el("div", {}, [
        statusPill(last.status),
        el("span", { class: "ml-2 mono text-xs" }, fmtTime(last.started_at)),
        el("div", { class: "text-xs text-slate-500" }, fmtAbs(last.started_at) + " · " + fmtMs(last.duration_ms)),
      ])
    : el("span", { class: "text-slate-400 italic" }, "never");

  const next = j.nextRun
    ? el("div", {}, [
        el("span", { class: "mono text-xs" }, fmtTime(j.nextRun)),
        el("div", { class: "text-xs text-slate-500" }, fmtAbs(j.nextRun)),
      ])
    : el("span", { class: "text-slate-400 italic" }, "—");

  const counts = el("div", { class: "text-sm" }, [
    el("span", { class: "text-emerald-700" }, String(j.last7d.ok)),
    el("span", { class: "text-slate-400" }, " / "),
    el("span", { class: j.last7d.error ? "text-rose-700 font-semibold" : "text-slate-400" }, String(j.last7d.error)),
  ]);

  const detailsBtn = el("button", {
    class: "text-xs px-2 py-1 rounded ring-1 ring-slate-200 hover:bg-slate-50",
    onclick: () => openCronDrawer(j),
  }, "history");

  return el("tr", {}, [
    el("td", {}, [el("div", { class: "font-medium" }, j.agentName), el("div", { class: "text-xs text-slate-500 mono" }, j.agentId)]),
    el("td", {}, [
      el("div", { class: "font-medium" }, j.trigger),
      j.description ? el("div", { class: "text-xs text-slate-500" }, j.description) : null,
    ].filter(Boolean)),
    el("td", { class: "mono text-xs" }, j.schedule),
    el("td", {}, lastCell),
    el("td", {}, next),
    el("td", {}, counts),
    el("td", {}, detailsBtn),
  ]);
}

async function openCronDrawer(j) {
  const overlay = el("div", { class: "fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4", onclick: (e) => { if (e.target === overlay) document.body.removeChild(overlay); } });
  const panel = el("div", { class: "bg-white rounded-lg ring-1 ring-slate-200 max-w-3xl w-full max-h-[85vh] overflow-y-auto" });
  const head = el("div", { class: "px-4 py-3 border-b border-slate-200 flex items-center justify-between" }, [
    el("div", {}, [
      el("div", { class: "font-semibold" }, j.agentName + " · " + j.trigger),
      el("div", { class: "text-xs text-slate-500 mono" }, j.schedule + (j.description ? " · " + j.description : "")),
    ]),
    el("button", { class: "text-slate-500 hover:text-slate-900 text-2xl leading-none", onclick: () => document.body.removeChild(overlay) }, "×"),
  ]);
  const body = el("div", { class: "p-4" }, [el("div", { class: "text-sm text-slate-500" }, "Loading…")]);
  panel.appendChild(head);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  try {
    const url = "/dashboard/api/crons/runs?agent=" + encodeURIComponent(j.agentId) + "&trigger=" + encodeURIComponent(j.trigger) + "&limit=50";
    const data = await fetchJson(url);
    clear(body);
    if (!data.runs.length) {
      body.appendChild(el("div", { class: "text-sm text-slate-500 italic" }, "No runs recorded yet — wait for the next scheduled execution or run the trigger manually."));
      return;
    }
    body.appendChild(el("table", { class: "tbl" }, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "When"),
        el("th", {}, "Status"),
        el("th", {}, "Duration"),
        el("th", {}, "Summary / error"),
      ])),
      el("tbody", {}, data.runs.map((r) => el("tr", {}, [
        el("td", { class: "mono text-xs whitespace-nowrap" }, [
          fmtTime(r.started_at),
          el("div", { class: "text-slate-500" }, fmtAbs(r.started_at)),
        ]),
        el("td", {}, statusPill(r.status)),
        el("td", { class: "text-xs whitespace-nowrap" }, fmtMs(r.duration_ms)),
        el("td", { class: "text-xs" }, [
          r.error_summary ? el("div", { class: "text-rose-700" }, r.error_summary) : null,
          r.summary ? el("div", { class: "text-slate-600 mono" }, r.summary.length > 200 ? r.summary.slice(0, 200) + "…" : r.summary) : null,
        ].filter(Boolean)),
      ]))),
    ]));
  } catch (err) {
    clear(body);
    body.appendChild(el("div", { class: "text-rose-700 text-sm" }, "Failed to load: " + err.message));
  }
}

// ── D1 tab ────────────────────────────────────────────────────────────────

async function renderD1() {
  const root = document.getElementById("tab-d1");
  clear(root);
  root.appendChild(el("div", { class: "text-sm text-slate-500 mb-4" }, "Loading…"));
  try {
    if (!cache.d1) cache.d1 = await fetchJson("/dashboard/api/d1");
    const { databases } = cache.d1;
    clear(root);

    const list = el("div", { class: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6" });
    for (const db of databases) {
      const card = el("button", {
        class: "text-left bg-white rounded-lg ring-1 ring-slate-200 p-4 hover:ring-indigo-400 transition disabled:opacity-50 disabled:cursor-not-allowed",
        disabled: !db.bound || db.error,
        onclick: () => loadD1Tables(db.name),
      }, [
        el("div", { class: "flex items-center justify-between" }, [
          el("div", { class: "font-mono text-sm font-semibold" }, db.name),
          db.bound ? statusPill("ok") : el("span", { class: "pill bg-slate-100 text-slate-500" }, "unbound"),
        ]),
        el("div", { class: "text-xs text-slate-500 mt-1" }, "agent: " + db.agentId),
        db.error
          ? el("div", { class: "text-xs text-rose-700 mt-1" }, db.error)
          : el("div", { class: "text-sm mt-1" }, db.tableCount === null ? "—" : db.tableCount + " table(s)"),
      ]);
      list.appendChild(card);
    }
    root.appendChild(list);

    const detail = el("div", { id: "d1-detail" });
    root.appendChild(detail);
  } catch (err) {
    clear(root);
    root.appendChild(el("div", { class: "text-rose-700" }, "Failed to load: " + err.message));
  }
}

async function loadD1Tables(dbName) {
  const detail = document.getElementById("d1-detail");
  clear(detail);
  detail.appendChild(el("div", { class: "text-sm text-slate-500" }, "Loading tables…"));
  try {
    const data = await fetchJson("/dashboard/api/d1/" + encodeURIComponent(dbName) + "/tables");
    clear(detail);
    detail.appendChild(el("h2", { class: "text-lg font-semibold mb-3" }, dbName));
    if (!data.tables.length) {
      detail.appendChild(el("div", { class: "text-sm text-slate-500" }, "No tables in this database."));
      return;
    }
    const grid = el("div", { class: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 mb-6" });
    for (const t of data.tables) {
      const c = el("button", {
        class: "text-left bg-white rounded-lg ring-1 ring-slate-200 px-3 py-2 hover:ring-indigo-400 transition",
        onclick: () => loadD1Table(dbName, t.name),
      }, [
        el("div", { class: "font-mono text-sm font-medium" }, t.name),
        el("div", { class: "text-xs text-slate-500" }, t.rowCount === null ? (t.error || "—") : (t.rowCount + " rows · " + t.columns.length + " cols")),
      ]);
      grid.appendChild(c);
    }
    detail.appendChild(grid);
    detail.appendChild(el("div", { id: "d1-rows" }));
  } catch (err) {
    clear(detail);
    detail.appendChild(el("div", { class: "text-rose-700" }, "Failed to load: " + err.message));
  }
}

const pageState = {};

async function loadD1Table(dbName, tableName, offset) {
  const target = document.getElementById("d1-rows");
  if (!target) return;
  const off = offset || 0;
  pageState[dbName + "::" + tableName] = off;
  clear(target);
  target.appendChild(el("div", { class: "text-sm text-slate-500" }, "Loading rows…"));
  try {
    const url = "/dashboard/api/d1/" + encodeURIComponent(dbName) + "/table/" + encodeURIComponent(tableName) + "?limit=50&offset=" + off;
    const data = await fetchJson(url);
    clear(target);
    target.appendChild(el("h3", { class: "text-md font-semibold mb-2 mono" }, tableName));
    target.appendChild(el("div", { class: "text-xs text-slate-500 mb-2" }, data.total + " rows total · showing " + (off + 1) + "–" + Math.min(off + 50, data.total)));
    if (!data.rows.length) {
      target.appendChild(el("div", { class: "text-sm text-slate-500 italic" }, "(empty)"));
      return;
    }
    const cols = data.columns;
    const wrap = el("div", { class: "bg-white rounded-lg ring-1 ring-slate-200 overflow-x-auto" }, [
      el("table", { class: "tbl mono", style: "font-size: 0.78rem;" }, [
        el("thead", {}, el("tr", {}, cols.map((c) => el("th", {}, c)))),
        el("tbody", {}, data.rows.map((row) => el("tr", {}, cols.map((c) => el("td", {}, formatCell(row[c])))))),
      ]),
    ]);
    target.appendChild(wrap);

    const nav = el("div", { class: "flex items-center gap-2 mt-3" }, [
      el("button", {
        class: "text-xs px-3 py-1 rounded ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50",
        disabled: off === 0,
        onclick: () => loadD1Table(dbName, tableName, Math.max(0, off - 50)),
      }, "← prev"),
      el("button", {
        class: "text-xs px-3 py-1 rounded ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50",
        disabled: off + 50 >= data.total,
        onclick: () => loadD1Table(dbName, tableName, off + 50),
      }, "next →"),
    ]);
    target.appendChild(nav);
  } catch (err) {
    clear(target);
    target.appendChild(el("div", { class: "text-rose-700" }, "Failed to load: " + err.message));
  }
}

function formatCell(v) {
  if (v === null || v === undefined) return el("span", { class: "text-slate-400 italic" }, "null");
  if (typeof v === "string") {
    if (v.length > 200) return v.slice(0, 200) + "…";
    return v;
  }
  return String(v);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

showTab(initialTab);
window.addEventListener("hashchange", () => {
  const t = currentTab();
  if (tabs.includes(t)) showTab(t);
});
`;

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
