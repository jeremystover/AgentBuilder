/**
 * Vanilla SPA pages for shopping-price-tracker.
 *
 * Concatenated to SPA_CORE_JS at /app/app.js. Defines window.NAV,
 * window.ROUTES, the page handlers, and a custom right-rail that shows
 * the latest digest run instead of a chat box (this agent doesn't have
 * an in-UI conversational mode).
 */

export const SPA_PAGES_JS = `
// $, el, api, toast, fmtDate are already top-level from SPA_CORE_JS
// (concatenated above); re-declaring them here would shadow & throw.
const C = window.__cos;

window.AGENT_BRAND = { mark: "$", label: "Tracker" };
window.NAV = [
  { hash: "#/", label: "Dashboard" },
  { hash: "#/new", label: "Add item" },
  { hash: "#/digest", label: "Digests" },
  { hash: "#/settings", label: "Settings" },
];
window.ROUTES = [
  { pattern: /^#\\/$/,                  handler: "pageDashboard" },
  { pattern: /^#\\/new$/,               handler: "pageNew" },
  { pattern: /^#\\/items\\/([^/]+)$/,   handler: "pageItem" },
  { pattern: /^#\\/digest$/,            handler: "pageDigest" },
  { pattern: /^#\\/digest\\/([^/]+)$/,  handler: "pageDigestRun" },
  { pattern: /^#\\/settings$/,          handler: "pageSettings" },
];

const fmtMoney = (cents, currency) => {
  if (cents === null || cents === undefined) return "—";
  const n = Number(cents) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(n);
  } catch {
    return "$" + n.toFixed(2);
  }
};

const fmtDateTime = (s) => {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const titleHeader = (text, ...children) => {
  return el("div", { class: "px-8 pt-8 pb-4 flex items-center justify-between gap-4 border-b border-slate-200" },
    el("h1", { class: "text-2xl font-serif font-semibold" }, text),
    el("div", { class: "flex items-center gap-2" }, ...children),
  );
};

// ── Right rail: digest preview instead of chat ─────────────────────────────────
window.mountChatSidebar = async (aside) => {
  aside.innerHTML = "";
  const head = el("div", { class: "px-5 pt-5 pb-3 border-b border-slate-200" },
    el("div", { class: "text-sm font-semibold uppercase tracking-wide text-slate-500" }, "Latest digest"),
  );
  const body = el("div", { class: "flex-1 overflow-y-auto scrollbar-thin px-5 py-4 text-sm space-y-3" });
  const refreshBtn = el("button", {
    class: "w-full rounded-lg bg-ink text-white py-2 text-sm font-medium hover:bg-slate-700",
    onclick: async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Refreshing…";
      try {
        const out = await api("/app/api/refresh-all", { method: "POST" });
        toast(\`Refreshed \${out.processed || 0} items\`, "ok");
      } catch (e) { toast(e.message, "err"); }
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh all now";
    },
  }, "Refresh all now");
  const foot = el("div", { class: "px-5 py-4 border-t border-slate-200" }, refreshBtn);
  aside.classList.add("flex", "flex-col");
  aside.append(head, body, foot);
  try {
    const data = await api("/app/api/digests?limit=1");
    const run = data.runs?.[0];
    if (!run) {
      body.appendChild(el("div", { class: "text-slate-400" }, "No digests yet."));
      return;
    }
    body.append(
      el("div", { class: "text-xs text-slate-500" }, fmtDateTime(run.ran_at) + " · " + run.email_status),
      el("div", { class: "text-sm whitespace-pre-wrap" }, run.summary_md || "(empty)"),
      el("a", {
        href: "#/digest/" + run.id,
        class: "text-xs text-indigo-700 hover:underline",
      }, "Open full digest →"),
    );
  } catch (e) {
    body.appendChild(el("div", { class: "text-rose-600" }, e.message));
  }
};

// ── /#/ Dashboard ──────────────────────────────────────────────────────────────
window.pageDashboard = async (main) => {
  main.innerHTML = "";
  const header = titleHeader("Tracked items",
    el("a", {
      href: "#/new",
      class: "rounded-lg bg-ink text-white px-3 py-2 text-sm font-medium hover:bg-slate-700",
    }, "Add item"),
  );
  const grid = el("div", { class: "p-8 grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3" });
  main.append(header, grid);

  let data;
  try {
    data = await api("/app/api/items");
  } catch (e) {
    grid.appendChild(el("div", { class: "text-rose-600" }, e.message));
    return;
  }
  if (data.items.length === 0) {
    grid.appendChild(el("div", { class: "col-span-full text-slate-500" }, "No tracked items yet. Add one to start daily price tracking."));
    return;
  }

  for (const item of data.items) {
    grid.appendChild(renderItemCard(item));
  }
};

function renderItemCard(item) {
  const card = el("a", {
    href: "#/items/" + item.id,
    class: "block bg-white rounded-2xl ring-1 ring-slate-200 p-5 hover:ring-indigo-300 transition no-underline",
  });
  const tagline = item.kind === "flight" && item.flight
    ? \`\${item.flight.origin} → \${item.flight.destination}\`
    : item.model_number || "";
  card.append(
    el("div", { class: "flex items-start justify-between gap-3" },
      el("div", { class: "min-w-0" },
        el("div", { class: "font-semibold text-ink truncate" }, item.title),
        tagline ? el("div", { class: "text-xs text-slate-500 mt-0.5 truncate" }, tagline) : null,
      ),
      el("div", { class: "shrink-0 text-right" },
        el("div", { class: "font-semibold text-lg" }, fmtMoney(item.latest_observation?.price_cents, item.currency)),
        el("div", { class: "text-xs text-slate-400" }, item.latest_observation?.source || "—"),
      ),
    ),
    el("div", { class: "mt-3 flex flex-wrap gap-2 text-xs" },
      item.target_price_cents !== null
        ? el("span", { class: "rounded-full bg-slate-100 text-slate-700 px-2 py-0.5" }, "target " + fmtMoney(item.target_price_cents, item.currency))
        : null,
      el("span", { class: "rounded-full bg-slate-100 text-slate-500 px-2 py-0.5 capitalize" }, item.priority),
      el("span", { class: "rounded-full bg-slate-100 text-slate-500 px-2 py-0.5 capitalize" }, item.status),
    ),
    el("div", { class: "mt-3 text-xs text-slate-400" }, "watch_urls: " + (item.watch_urls?.length || 0)),
  );
  return card;
}

// ── /#/new — add item ──────────────────────────────────────────────────────────
window.pageNew = async (main) => {
  main.innerHTML = "";
  const header = titleHeader("Add tracked item");
  const form = el("form", { class: "p-8 max-w-2xl space-y-6" });

  const kindRadio = (val, label) => {
    const id = "kind_" + val;
    return el("label", { class: "flex items-center gap-2 cursor-pointer" },
      el("input", { type: "radio", name: "kind", value: val, id, ...(val === "product" ? { checked: true } : {}) }),
      el("span", {}, label),
    );
  };
  form.appendChild(el("div", { class: "flex gap-6" }, kindRadio("product", "Product"), kindRadio("flight", "Flight")));

  const productSection = el("div", { class: "space-y-4" },
    field("Title", "title", "Sony WH-1000XM5 wireless headphones"),
    field("Model number", "model_number", "WH1000XM5/B"),
    field("Notes (optional)", "notes", "color preference, any specs"),
    field("Target price (USD, optional)", "target_price_usd", "280", { type: "number", step: "0.01" }),
    field("Max price (USD, optional)", "max_price_usd", "350", { type: "number", step: "0.01" }),
  );
  const flightSection = el("div", { class: "space-y-4 hidden" },
    el("div", { class: "grid grid-cols-2 gap-4" },
      field("Origin (IATA)", "origin", "JFK"),
      field("Destination (IATA)", "destination", "LIS"),
    ),
    el("div", { class: "grid grid-cols-2 gap-4" },
      field("Earliest depart", "depart_start", "", { type: "date" }),
      field("Latest depart", "depart_end", "", { type: "date" }),
    ),
    el("div", { class: "grid grid-cols-2 gap-4" },
      field("Earliest return", "return_start", "", { type: "date" }),
      field("Latest return", "return_end", "", { type: "date" }),
    ),
    el("div", { class: "grid grid-cols-3 gap-4" },
      field("Cabin", "cabin", "economy", { type: "select", options: ["economy", "premium_economy", "business", "first"] }),
      field("Pax", "pax", "1", { type: "number", min: "1", max: "9" }),
      field("Max stops", "max_stops", "", { type: "number", min: "0", max: "3" }),
    ),
    field("Target total price (USD, optional)", "target_price_usd", "700", { type: "number", step: "0.01" }),
    field("Notes (optional)", "notes", "preferred airlines, layover preferences"),
  );

  form.append(productSection, flightSection);

  form.appendChild(field("Priority", "priority", "normal", { type: "select", options: ["low", "normal", "high"] }));

  const submit = el("button", {
    type: "submit",
    class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
  }, "Add and discover URLs");
  form.appendChild(el("div", {}, submit));

  form.addEventListener("change", (e) => {
    if (e.target.name === "kind") {
      const isFlight = e.target.value === "flight";
      productSection.classList.toggle("hidden", isFlight);
      flightSection.classList.toggle("hidden", !isFlight);
      submit.textContent = isFlight ? "Add and search flights" : "Add and discover URLs";
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true; submit.textContent = "Adding…";
    try {
      const fd = new FormData(form);
      const kind = fd.get("kind");
      const body = { kind, priority: fd.get("priority") || "normal" };
      const ifNum = (v) => (v === "" || v === null) ? undefined : Number(v);
      if (kind === "product") {
        body.title = String(fd.get("title") || "").trim();
        body.model_number = String(fd.get("model_number") || "").trim();
        body.notes = String(fd.get("notes") || "");
        body.target_price_usd = ifNum(fd.get("target_price_usd"));
        body.max_price_usd = ifNum(fd.get("max_price_usd"));
      } else {
        body.origin = String(fd.get("origin") || "").trim();
        body.destination = String(fd.get("destination") || "").trim();
        body.depart_start = String(fd.get("depart_start") || "");
        body.depart_end = String(fd.get("depart_end") || "");
        body.return_start = String(fd.get("return_start") || "") || null;
        body.return_end = String(fd.get("return_end") || "") || null;
        body.cabin = String(fd.get("cabin") || "economy");
        body.pax = ifNum(fd.get("pax")) ?? 1;
        body.max_stops = ifNum(fd.get("max_stops"));
        body.target_price_usd = ifNum(fd.get("target_price_usd"));
        body.notes = String(fd.get("notes") || "");
        body.title = body.origin + " → " + body.destination;
      }
      const out = await api("/app/api/items", { method: "POST", body });
      toast("Added.", "ok");
      location.hash = "#/items/" + out.item.id;
    } catch (err) {
      toast(err.message, "err");
      submit.disabled = false;
      submit.textContent = "Add and discover URLs";
    }
  });

  main.append(header, form);
};

function field(label, name, placeholder, opts = {}) {
  const wrap = el("label", { class: "block" });
  wrap.appendChild(el("span", { class: "text-xs uppercase tracking-wide text-slate-500" }, label));
  let input;
  if (opts.type === "select") {
    input = el("select", { name, class: "mt-1 block w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none" },
      ...((opts.options || []).map((v) => el("option", { value: v, ...(v === placeholder ? { selected: true } : {}) }, v))),
    );
  } else {
    const attrs = { type: opts.type || "text", name, placeholder, class: "mt-1 block w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none" };
    if (opts.step) attrs.step = opts.step;
    if (opts.min)  attrs.min  = opts.min;
    if (opts.max)  attrs.max  = opts.max;
    input = el("input", attrs);
  }
  wrap.appendChild(input);
  return wrap;
}

// ── /#/items/:id — detail ──────────────────────────────────────────────────────
window.pageItem = async (main, itemId) => {
  main.innerHTML = "";
  let data;
  try {
    data = await api("/app/api/items/" + encodeURIComponent(itemId) + "?days=30");
  } catch (e) {
    main.appendChild(el("div", { class: "p-10 text-rose-600" }, e.message));
    return;
  }
  const { item, observations, flight } = data;

  const header = titleHeader(item.title,
    el("button", {
      class: "rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm hover:bg-slate-50",
      onclick: async () => {
        try {
          const out = await api("/app/api/items/" + encodeURIComponent(item.id) + "/refresh", { method: "POST" });
          toast("Got " + (out.observation_count || 0) + " new observation(s)", "ok");
          window.pageItem(main, item.id);
        } catch (e) { toast(e.message, "err"); }
      },
    }, "Refresh now"),
    el("button", {
      class: "rounded-lg ring-1 ring-rose-200 text-rose-700 px-3 py-2 text-sm hover:bg-rose-50",
      onclick: async () => {
        if (!confirm("Archive this item?")) return;
        try {
          await api("/app/api/items/" + encodeURIComponent(item.id), { method: "DELETE" });
          toast("Archived", "ok");
          location.hash = "#/";
        } catch (e) { toast(e.message, "err"); }
      },
    }, "Archive"),
  );

  const meta = el("div", { class: "px-8 py-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm" },
    metaCard("Best today", fmtMoney(observations[0]?.price_cents, item.currency), observations[0]?.source || ""),
    metaCard("Target", fmtMoney(item.target_price_cents, item.currency)),
    metaCard("Max", fmtMoney(item.max_price_cents, item.currency)),
    metaCard("Watch URLs", String(item.watch_urls?.length || 0)),
  );

  const chartWrap = el("div", { class: "mx-8 my-2 bg-white rounded-2xl ring-1 ring-slate-200 p-5" });
  const canvas = document.createElement("canvas");
  canvas.height = 220;
  chartWrap.append(el("div", { class: "text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3" }, "Price history (30d)"), canvas);

  const flightInfo = flight
    ? el("div", { class: "mx-8 my-4 bg-white rounded-2xl ring-1 ring-slate-200 p-5 text-sm" },
        el("div", { class: "font-semibold mb-2" }, "Flight constraints"),
        el("div", { class: "grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-slate-600" },
          el("div", {}, "Origin: " + flight.origin),
          el("div", {}, "Destination: " + flight.destination),
          el("div", {}, "Depart: " + flight.depart_start + " – " + flight.depart_end),
          el("div", {}, "Return: " + (flight.return_start ? (flight.return_start + " – " + flight.return_end) : "one-way")),
          el("div", {}, "Cabin: " + flight.cabin),
          el("div", {}, "Pax: " + flight.pax),
          el("div", {}, "Max stops: " + (flight.max_stops ?? "any")),
        ),
      )
    : null;

  const tableWrap = el("div", { class: "mx-8 my-4 bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden" });
  tableWrap.appendChild(el("div", { class: "text-sm font-semibold text-slate-500 uppercase tracking-wide px-5 pt-4" }, "Recent observations"));
  const tbl = el("table", { class: "w-full text-sm mt-3" });
  tbl.appendChild(el("thead", { class: "text-xs text-slate-500 uppercase tracking-wide" },
    el("tr", {},
      el("th", { class: "text-left px-5 py-2" }, "When"),
      el("th", { class: "text-left px-2 py-2" }, "Source"),
      el("th", { class: "text-left px-2 py-2" }, "Title"),
      el("th", { class: "text-right px-5 py-2" }, "Price"),
    ),
  ));
  const tbody = el("tbody", {});
  for (const o of observations.slice(0, 50)) {
    tbody.appendChild(el("tr", { class: "border-t border-slate-100" },
      el("td", { class: "px-5 py-2 text-xs text-slate-500" }, fmtDateTime(o.observed_at)),
      el("td", { class: "px-2 py-2 text-xs" }, o.source),
      el("td", { class: "px-2 py-2 text-xs truncate max-w-[280px]" },
        o.listing_url
          ? el("a", { href: o.listing_url, target: "_blank", rel: "noopener", class: "text-indigo-700 hover:underline" }, o.listing_title || o.listing_url)
          : (o.listing_title || "")
      ),
      el("td", { class: "px-5 py-2 text-right font-medium" }, fmtMoney(o.price_cents, o.currency)),
    ));
  }
  tbl.appendChild(tbody);
  tableWrap.appendChild(tbl);

  main.append(header, meta, chartWrap);
  if (flightInfo) main.appendChild(flightInfo);
  main.appendChild(tableWrap);

  // Lazy-load Chart.js from CDN, then plot.
  loadChartJs().then(() => {
    if (!window.Chart || observations.length === 0) return;
    const points = [...observations].reverse().map((o) => ({ x: o.observed_at, y: o.price_cents / 100 }));
    new window.Chart(canvas, {
      type: "line",
      data: {
        datasets: [{
          label: "Price (USD)",
          data: points,
          borderColor: "#3730a3",
          backgroundColor: "rgba(55, 48, 163, 0.08)",
          tension: 0.25,
          fill: true,
          pointRadius: 2,
        }],
      },
      options: {
        responsive: true,
        animation: false,
        scales: {
          x: { type: "time", time: { unit: "day" } },
          y: { beginAtZero: false },
        },
        plugins: { legend: { display: false } },
      },
    });
  });
};

function metaCard(label, value, sub) {
  return el("div", { class: "bg-white rounded-2xl ring-1 ring-slate-200 px-4 py-3" },
    el("div", { class: "text-xs uppercase tracking-wide text-slate-500" }, label),
    el("div", { class: "text-lg font-semibold mt-1" }, value),
    sub ? el("div", { class: "text-xs text-slate-400 mt-0.5" }, sub) : null,
  );
}

let _chartLoadPromise = null;
function loadChartJs() {
  if (_chartLoadPromise) return _chartLoadPromise;
  _chartLoadPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js";
    s.onload = () => {
      const adapter = document.createElement("script");
      adapter.src = "https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js";
      adapter.onload = () => resolve();
      document.head.appendChild(adapter);
    };
    document.head.appendChild(s);
  });
  return _chartLoadPromise;
}

// ── /#/digest — list ───────────────────────────────────────────────────────────
window.pageDigest = async (main) => {
  main.innerHTML = "";
  const header = titleHeader("Digest history");
  const list = el("div", { class: "p-8 space-y-3" });
  main.append(header, list);
  try {
    const data = await api("/app/api/digests");
    if (data.runs.length === 0) {
      list.appendChild(el("div", { class: "text-slate-500" }, "No digests yet."));
      return;
    }
    for (const run of data.runs) {
      list.appendChild(el("a", {
        href: "#/digest/" + run.id,
        class: "block bg-white rounded-2xl ring-1 ring-slate-200 p-4 hover:ring-indigo-300",
      },
        el("div", { class: "flex justify-between items-baseline" },
          el("div", { class: "font-medium" }, fmtDateTime(run.ran_at)),
          el("div", { class: "text-xs text-slate-500" }, run.email_status + " · " + run.item_count + " items"),
        ),
        run.email_error ? el("div", { class: "text-xs text-rose-600 mt-1" }, run.email_error) : null,
      ));
    }
  } catch (e) {
    list.appendChild(el("div", { class: "text-rose-600" }, e.message));
  }
};

// ── /#/digest/:id — full HTML preview ──────────────────────────────────────────
window.pageDigestRun = async (main, runId) => {
  main.innerHTML = "";
  const header = titleHeader("Digest preview",
    el("a", { href: "#/digest", class: "text-sm text-indigo-700 hover:underline" }, "← back"),
  );
  const wrap = el("div", { class: "p-8" });
  main.append(header, wrap);
  try {
    const data = await api("/app/api/digests/" + encodeURIComponent(runId));
    wrap.appendChild(el("div", { class: "text-xs text-slate-500 mb-4" },
      fmtDateTime(data.run.ran_at) + " · " + data.run.email_status,
    ));
    const frame = el("div", { class: "bg-white rounded-2xl ring-1 ring-slate-200 p-6 prose max-w-none" });
    frame.innerHTML = data.run.summary_html || "<em>no html</em>";
    wrap.appendChild(frame);
  } catch (e) {
    wrap.appendChild(el("div", { class: "text-rose-600" }, e.message));
  }
};

// ── /#/settings — recipients ───────────────────────────────────────────────────
window.pageSettings = async (main) => {
  main.innerHTML = "";
  const header = titleHeader("Settings");
  const wrap = el("div", { class: "p-8 max-w-xl space-y-8" });
  main.append(header, wrap);

  const recSection = el("section", {},
    el("h2", { class: "text-lg font-serif font-semibold mb-3" }, "Digest recipients"),
  );
  const list = el("div", { class: "space-y-2" });
  recSection.appendChild(list);

  const addRow = el("form", { class: "flex gap-2 mt-4" });
  const input = el("input", {
    type: "email",
    name: "email",
    placeholder: "you@example.com",
    required: true,
    class: "flex-1 rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none",
  });
  const addBtn = el("button", { class: "rounded-lg bg-ink text-white px-3 py-2 text-sm font-medium hover:bg-slate-700" }, "Add");
  addRow.append(input, addBtn);
  addRow.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!email) return;
    try {
      await api("/app/api/recipients", { method: "POST", body: { email } });
      input.value = "";
      await refreshList();
    } catch (err) { toast(err.message, "err"); }
  });
  recSection.appendChild(addRow);

  async function refreshList() {
    list.innerHTML = "";
    try {
      const data = await api("/app/api/recipients");
      if (data.recipients.length === 0) {
        list.appendChild(el("div", { class: "text-slate-500 text-sm" }, "No recipients. Add one above to receive daily digests."));
        return;
      }
      for (const r of data.recipients) {
        list.appendChild(el("div", { class: "flex justify-between items-center bg-white ring-1 ring-slate-200 rounded-lg px-3 py-2" },
          el("span", { class: "text-sm" }, r.email),
          el("button", {
            class: "text-xs text-rose-600 hover:underline",
            onclick: async () => {
              try {
                await api("/app/api/recipients?email=" + encodeURIComponent(r.email), { method: "DELETE" });
                await refreshList();
              } catch (err) { toast(err.message, "err"); }
            },
          }, "Remove"),
        ));
      }
    } catch (e) {
      list.appendChild(el("div", { class: "text-rose-600" }, e.message));
    }
  }
  await refreshList();

  wrap.appendChild(recSection);

  const cron = el("section", {},
    el("h2", { class: "text-lg font-serif font-semibold mb-3" }, "Schedule"),
    el("div", { class: "text-sm text-slate-600 space-y-1" },
      el("div", {}, "Daily digest: 12:00 UTC"),
      el("div", {}, "Priority refresh (high-priority items only): every 4 hours"),
    ),
  );
  wrap.appendChild(cron);
};

// Boot the SPA.
if (document.readyState !== "loading") C.route();
else document.addEventListener("DOMContentLoaded", () => C.route());
`;
