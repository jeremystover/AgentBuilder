// Public booking page hydration.
//
// The booking pages (/book, /book/unit/:id, /book/success, /book/cancel)
// are server-rendered by the Worker with full content and JSON-LD
// structured data already baked in.  This script just attaches
// interactive behavior to whichever page the user is currently on:
//
//   * /book/unit/:id - live price quote + Stripe/Square checkout
//   * /book/success  - load and display the confirmed booking summary
//
// No client-side routing: the list view is static HTML and each unit
// card is a real <a> tag that navigates to the SSR detail route.

const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function money(cents, currency) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
  }).format((cents || 0) / 100);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------- Detail page hydration ----------
let currentQuote = null;
let currentUnitId = null;

function hydrateDetail() {
  const panel = document.getElementById("detail-view");
  if (!panel) return false;
  currentUnitId = Number(panel.dataset.unitId);

  // Default to tomorrow + 2 nights.
  const tomorrow = new Date(Date.now() + 86400_000);
  const three    = new Date(Date.now() + 3 * 86400_000);
  if ($("#startDate")) $("#startDate").value = tomorrow.toISOString().slice(0, 10);
  if ($("#endDate"))   $("#endDate").value   = three.toISOString().slice(0, 10);

  ["startDate", "endDate"].forEach(id => {
    const el = $(`#${id}`);
    if (el) el.addEventListener("change", refreshQuote);
  });
  $$("button.pay").forEach(b =>
    b.addEventListener("click", () => checkout(b.dataset.provider))
  );
  refreshQuote();
  return true;
}

async function refreshQuote() {
  const start_date = $("#startDate").value;
  const end_date   = $("#endDate").value;
  const box = $("#quoteBox");
  if (!start_date || !end_date || end_date <= start_date) {
    box.classList.remove("bad");
    box.textContent = "Select valid dates to see a price.";
    currentQuote = null;
    setPayEnabled(false);
    return;
  }
  try {
    const q = await api("/public/quote", {
      method: "POST",
      body: JSON.stringify({ unit_id: currentUnitId, start_date, end_date }),
    });
    if (!q.available) {
      box.classList.add("bad");
      box.innerHTML = "Sorry — those dates are not available.";
      currentQuote = null;
      setPayEnabled(false);
      return;
    }
    box.classList.remove("bad");
    const rows = [
      `<tr><td class="label">${q.nights} night${q.nights === 1 ? "" : "s"}</td><td align="right">${money(q.nightly_total_cents, q.currency)}</td></tr>`,
    ];
    if (q.cleaning_fee_cents) {
      rows.push(`<tr><td class="label">Cleaning</td><td align="right">${money(q.cleaning_fee_cents, q.currency)}</td></tr>`);
    }
    rows.push(`<tr class="total"><td>Total</td><td align="right">${money(q.amount_cents, q.currency)}</td></tr>`);
    box.innerHTML = `<table>${rows.join("")}</table>`;
    currentQuote = q;
    setPayEnabled(true);
  } catch (e) {
    box.classList.add("bad");
    box.textContent = e.message;
    currentQuote = null;
    setPayEnabled(false);
  }
}

function setPayEnabled(on) {
  $$("button.pay").forEach(b => b.disabled = !on);
}

async function checkout(provider) {
  const err = $("#err"); err.hidden = true;
  if (!currentQuote) return;

  const body = {
    unit_id: currentUnitId,
    start_date: $("#startDate").value,
    end_date: $("#endDate").value,
    provider,
    guest_name:  $("#guestName").value.trim(),
    guest_email: $("#guestEmail").value.trim(),
    guest_phone: $("#guestPhone").value.trim() || undefined,
    adults:   Number($("#adults").value)   || undefined,
    children: Number($("#children").value) || undefined,
    notes:    $("#notes").value.trim() || undefined,
  };
  if (!body.guest_name || !body.guest_email) {
    err.textContent = "Please enter your name and email.";
    err.hidden = false;
    return;
  }
  setPayEnabled(false);
  try {
    const res = await api("/public/checkout", {
      method: "POST", body: JSON.stringify(body),
    });
    window.location.href = res.url;
  } catch (e) {
    err.textContent = e.message === "dates_unavailable"
      ? "Those dates were just taken. Please pick different dates."
      : e.message;
    err.hidden = false;
    setPayEnabled(true);
  }
}

// ---------- Success page hydration ----------
async function hydrateSuccess() {
  const wrap = document.querySelector("[data-session], [data-booking]");
  if (!wrap) return false;
  const sid = wrap.dataset.session;
  const bid = wrap.dataset.booking;
  const summary = $("#successSummary");
  try {
    let b;
    if (sid) {
      b = await api(`/public/booking-by-session/${encodeURIComponent(sid)}`);
    } else if (bid) {
      b = await api(`/public/booking/${encodeURIComponent(bid)}`);
    } else {
      return true;
    }
    if (summary) {
      summary.textContent =
        `Booked: ${b.unit_name} from ${b.start_date} to ${b.end_date} — ${money(b.amount_cents, b.currency)}.`;
    }
  } catch {
    if (summary) summary.textContent = "Your booking has been received.";
  }
  return true;
}

// Dispatch based on which SSR page we landed on.
if (!hydrateDetail()) hydrateSuccess();
