// Booking Sync Manager - single-page admin UI.
// Vanilla JS module, no build step. Works when served by the Worker
// (wrangler Assets binding) in both dev and prod.

const tokenInput = document.getElementById("adminToken");
tokenInput.value = localStorage.getItem("adminToken") || "";
tokenInput.addEventListener("change", () => {
  localStorage.setItem("adminToken", tokenInput.value);
});

async function api(path, opts = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});
  if (tokenInput.value) headers["x-admin-token"] = tokenInput.value;
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------- Router ----------
const routes = {
  "dashboard":  renderDashboard,
  "calendar":   renderCalendar,
  "properties": renderProperties,
  "units":      renderUnits,
  "listings":   renderListings,
  "bookings":   renderBookings,
  "reviews":    renderReviews,
  "photos":     renderPhotos,
  "sync-log":   renderSyncLog,
};
function currentRoute() {
  const h = location.hash.replace(/^#\//, "") || "dashboard";
  return h.split("/")[0];
}
function navigate() {
  const route = currentRoute();
  document.querySelectorAll("nav a").forEach(a => {
    a.classList.toggle("active", a.dataset.nav === route);
  });
  const fn = routes[route] || renderDashboard;
  fn().catch(err => {
    document.getElementById("view").innerHTML =
      `<section class="panel"><h1>Error</h1><pre>${escapeHtml(err.message)}</pre></section>`;
  });
}
window.addEventListener("hashchange", navigate);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function view() { return document.getElementById("view"); }

// ---------- Dashboard ----------
async function renderDashboard() {
  const node = document.getElementById("tpl-dashboard").content.cloneNode(true);
  view().replaceChildren(node);
  try {
    const [props, units, listings, bookings] = await Promise.all([
      api("/properties"), api("/units"), api("/listings"), api("/bookings"),
    ]);
    view().querySelector('[data-stat="properties"]').textContent = props.length;
    view().querySelector('[data-stat="units"]').textContent = units.length;
    view().querySelector('[data-stat="listings"]').textContent = listings.length;
    view().querySelector('[data-stat="bookings"]').textContent =
      bookings.filter(b => b.status !== "cancelled").length;
  } catch (e) {
    // Non-blocking: show count placeholders.
    console.error(e);
  }
  view().querySelector("#pullAll").addEventListener("click", async (ev) => {
    ev.target.disabled = true; ev.target.textContent = "Pulling…";
    try { await api("/sync/pull-all", { method: "POST" }); ev.target.textContent = "Done"; }
    catch (e) { alert(e.message); ev.target.textContent = "Retry"; }
    ev.target.disabled = false;
  });
}

// ---------- Units ----------
async function renderUnits() {
  const [props, units] = await Promise.all([api("/properties"), api("/units")]);
  const propMap = Object.fromEntries(props.map(p => [p.id, p]));
  view().innerHTML = `
    <section class="panel">
      <h1>Units</h1>
      <table><thead><tr>
        <th>ID</th><th>Property</th><th>Name</th><th>Kind</th><th>Beds</th>
        <th>Sleeps</th><th>Price</th><th>Components</th><th></th>
      </tr></thead><tbody>
      ${units.map(u => `
        <tr data-id="${u.id}">
          <td>${u.id}</td>
          <td>${escapeHtml(propMap[u.property_id]?.name || "")}</td>
          <td><input data-f="name" value="${escapeHtml(u.name)}" /></td>
          <td>${u.kind}</td>
          <td><input data-f="bedrooms" type="number" value="${u.bedrooms ?? ""}" /></td>
          <td><input data-f="sleeps" type="number" value="${u.sleeps ?? ""}" /></td>
          <td><input data-f="base_price" type="number" value="${u.base_price ?? ""}" /></td>
          <td>${(u.components || []).join(", ") || "-"}</td>
          <td>
            <button data-save>Save</button>
            <button class="danger" data-delete>Delete</button>
          </td>
        </tr>`).join("")}
      </tbody></table>
      <h2>New atomic unit</h2>
      <div class="form-row three">
        <div><label>Property</label>
          <select id="newProp">${props.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}</select>
        </div>
        <div><label>Name</label><input id="newName" /></div>
        <div><label>Sleeps</label><input id="newSleeps" type="number" /></div>
      </div>
      <div class="actions"><button id="addUnit">Add atomic unit</button></div>
    </section>`;
  view().querySelectorAll("tr[data-id]").forEach(tr => {
    const id = tr.dataset.id;
    tr.querySelector("[data-save]").addEventListener("click", async () => {
      const body = {};
      tr.querySelectorAll("input[data-f]").forEach(i => {
        const v = i.value === "" ? null : (i.type === "number" ? Number(i.value) : i.value);
        body[i.dataset.f] = v;
      });
      await api(`/units/${id}`, { method: "PUT", body: JSON.stringify(body) });
    });
    tr.querySelector("[data-delete]").addEventListener("click", async () => {
      if (!confirm("Delete unit?")) return;
      await api(`/units/${id}`, { method: "DELETE" });
      renderUnits();
    });
  });
  view().querySelector("#addUnit").addEventListener("click", async () => {
    await api("/units", { method: "POST", body: JSON.stringify({
      property_id: Number(view().querySelector("#newProp").value),
      name: view().querySelector("#newName").value,
      kind: "atomic",
      sleeps: Number(view().querySelector("#newSleeps").value) || null,
    })});
    renderUnits();
  });
}

// ---------- Listings ----------
async function renderListings() {
  const [listings, platforms, units] = await Promise.all([
    api("/listings"), api("/platforms"), api("/units"),
  ]);
  const unitMap = Object.fromEntries(units.map(u => [u.id, u]));
  const origin = location.origin;
  view().innerHTML = `
    <section class="panel">
      <h1>Listings</h1>
      <p class="hint">Paste each listing's <b>Import URL</b> from the other platform's calendar export page, then copy our <b>Export URL</b> into that platform as an imported calendar. Cron pulls every 10 minutes.</p>
      <table><thead><tr>
        <th>Unit</th><th>Platform</th><th>Status</th>
        <th>Import URL (pull from platform)</th>
        <th>Export URL (give to platform)</th>
        <th>Last pulled</th><th></th>
      </tr></thead><tbody>
      ${listings.map(l => `
        <tr data-id="${l.id}">
          <td>${escapeHtml(unitMap[l.unit_id]?.name || l.unit_id)}</td>
          <td><span class="tag platform-${l.platform_slug}">${escapeHtml(l.platform_name)}</span></td>
          <td>
            <select data-f="status">
              ${["active","paused","archived"].map(s => `<option ${s === l.status ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </td>
          <td><input data-f="ical_import_url" type="url" value="${escapeHtml(l.ical_import_url || "")}" placeholder="https://..." /></td>
          <td><code>${origin}/ical/${l.export_token}.ics</code></td>
          <td>${l.last_pulled_at || "-"}${l.last_error ? `<div class="tag" style="color:var(--danger)">${escapeHtml(l.last_error)}</div>` : ""}</td>
          <td>
            <button data-save>Save</button>
            <button class="secondary" data-pull>Pull</button>
          </td>
        </tr>`).join("")}
      </tbody></table>
    </section>`;
  view().querySelectorAll("tr[data-id]").forEach(tr => {
    const id = tr.dataset.id;
    tr.querySelector("[data-save]").addEventListener("click", async () => {
      const body = {};
      tr.querySelectorAll("[data-f]").forEach(i => body[i.dataset.f] = i.value || null);
      await api(`/listings/${id}`, { method: "PUT", body: JSON.stringify(body) });
    });
    tr.querySelector("[data-pull]").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "…";
      try { await api(`/listings/${id}/pull`, { method: "POST" }); renderListings(); }
      catch (err) { alert(err.message); e.target.disabled = false; e.target.textContent = "Pull"; }
    });
  });
}

// ---------- Bookings ----------
async function renderBookings() {
  const [bookings, units] = await Promise.all([api("/bookings"), api("/units")]);
  const unitMap = Object.fromEntries(units.map(u => [u.id, u]));
  view().innerHTML = `
    <section class="panel">
      <h1>Bookings</h1>
      <h2>New direct booking</h2>
      <div class="form-row three">
        <div><label>Unit</label>
          <select id="bUnit">${units.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("")}</select>
        </div>
        <div><label>Check-in</label><input type="date" id="bStart" /></div>
        <div><label>Check-out</label><input type="date" id="bEnd" /></div>
      </div>
      <div class="form-row three">
        <div><label>Guest name</label><input id="bName" /></div>
        <div><label>Email</label><input id="bEmail" type="email" /></div>
        <div><label>Total</label><input id="bTotal" type="number" /></div>
      </div>
      <div class="actions"><button id="addBooking">Create booking</button></div>
    </section>
    <section class="panel">
      <h2>All bookings</h2>
      <table><thead><tr>
        <th>Unit</th><th>Source</th><th>Start</th><th>End</th>
        <th>Guest</th><th>Status</th><th></th>
      </tr></thead><tbody>
      ${bookings.map(b => `
        <tr data-id="${b.id}">
          <td>${escapeHtml(unitMap[b.unit_id]?.name || b.unit_id)}</td>
          <td><span class="tag platform-${b.source_platform}">${b.source_platform}</span></td>
          <td>${b.start_date}</td><td>${b.end_date}</td>
          <td>${escapeHtml(b.guest_name || "-")}</td>
          <td>${b.status}</td>
          <td><button class="danger" data-cancel>Cancel</button></td>
        </tr>`).join("")}
      </tbody></table>
    </section>`;
  view().querySelector("#addBooking").addEventListener("click", async () => {
    const body = {
      unit_id: Number(view().querySelector("#bUnit").value),
      start_date: view().querySelector("#bStart").value,
      end_date: view().querySelector("#bEnd").value,
      guest_name: view().querySelector("#bName").value || undefined,
      guest_email: view().querySelector("#bEmail").value || undefined,
      total_amount: Number(view().querySelector("#bTotal").value) || undefined,
    };
    try {
      await api("/bookings", { method: "POST", body: JSON.stringify(body) });
      renderBookings();
    } catch (e) {
      if (e.message === "conflict" && confirm("Dates conflict with existing bookings. Force?")) {
        body.force = true;
        await api("/bookings", { method: "POST", body: JSON.stringify(body) });
        renderBookings();
      } else {
        alert(e.message);
      }
    }
  });
  view().querySelectorAll("[data-cancel]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      await api(`/bookings/${id}`, { method: "DELETE" });
      renderBookings();
    });
  });
}

// ---------- Calendar ----------
async function renderCalendar() {
  const [units, bookings] = await Promise.all([api("/units"), api("/bookings")]);
  const days = 60;
  const today = new Date(); today.setHours(0,0,0,0);
  const dayStrs = Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getTime() + i * 86400_000);
    return d.toISOString().slice(0, 10);
  });

  // Build atomic occupancy map, then derive per-unit blocking by checking
  // whether any atomic member is occupied.
  const unitComponents = Object.fromEntries(units.map(u => [u.id, u.components && u.components.length ? u.components : [u.id]]));
  const occupancy = new Map(); // atomicId -> Set<dateStr>
  for (const b of bookings) {
    if (b.status === "cancelled") continue;
    const atomics = unitComponents[b.unit_id] || [b.unit_id];
    let cur = new Date(b.start_date);
    const end = new Date(b.end_date);
    while (cur < end) {
      const s = cur.toISOString().slice(0, 10);
      for (const a of atomics) {
        if (!occupancy.has(a)) occupancy.set(a, new Set());
        occupancy.get(a).add(s);
      }
      cur = new Date(cur.getTime() + 86400_000);
    }
  }

  const rows = units.map(u => {
    const atomics = unitComponents[u.id];
    const cells = dayStrs.map(ds => {
      const blocked = atomics.some(a => occupancy.get(a)?.has(ds));
      const isToday = ds === dayStrs[0];
      return `<div class="cal-day ${blocked ? "booked" : ""} ${isToday ? "today" : ""}" title="${ds}">${ds.slice(8,10)}</div>`;
    }).join("");
    return `<div class="cal-row">
      <div class="cal-unit">${escapeHtml(u.name)} <div class="tag">${u.kind}</div></div>
      <div class="cal-days">${cells}</div>
    </div>`;
  }).join("");

  view().innerHTML = `
    <section class="panel">
      <h1>Calendar (next ${days} days)</h1>
      <div class="calendar">${rows}</div>
      <p class="hint">Red cells mean at least one atomic room the unit occupies is booked - whether the booking came from Airbnb, VRBO, Booking.com, or was a direct booking on a different configuration.</p>
    </section>`;
}

// ---------- Photos ----------
async function renderPhotos() {
  const units = await api("/units");
  view().innerHTML = `
    <section class="panel">
      <h1>Photos</h1>
      <label>Unit</label>
      <select id="photoUnit">${units.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("")}</select>
      <div class="actions">
        <input type="file" id="photoFile" accept="image/*" multiple />
        <button id="photoUpload">Upload</button>
      </div>
      <div class="photo-grid" id="photoGrid"></div>
    </section>`;
  const sel = view().querySelector("#photoUnit");
  const grid = view().querySelector("#photoGrid");
  async function loadGrid() {
    const photos = await api(`/units/${sel.value}/photos`);
    grid.innerHTML = photos.map(p => `
      <figure data-id="${p.id}">
        <img src="/photos/${p.id}" alt="" />
        <figcaption>${escapeHtml(p.caption || "")} <button class="danger" data-delete>Delete</button></figcaption>
      </figure>`).join("");
    grid.querySelectorAll("[data-delete]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.closest("figure").dataset.id;
        await api(`/photos/${id}`, { method: "DELETE" });
        loadGrid();
      });
    });
  }
  sel.addEventListener("change", loadGrid);
  view().querySelector("#photoUpload").addEventListener("click", async () => {
    const files = view().querySelector("#photoFile").files;
    for (const f of files) {
      const headers = { "content-type": f.type || "application/octet-stream" };
      if (tokenInput.value) headers["x-admin-token"] = tokenInput.value;
      await fetch(`/api/units/${sel.value}/photos`, { method: "POST", body: f, headers });
    }
    loadGrid();
  });
  loadGrid();
}

// ---------- Properties ----------
async function renderProperties() {
  const props = await api("/properties");
  view().innerHTML = `
    <section class="panel">
      <h1>Properties</h1>
      <p class="hint">Addresses and map coordinates power the JSON-LD structured data on /book pages, so Google can place your listings on the map.</p>
      <table><thead><tr>
        <th>Name</th><th>Street</th><th>City</th><th>State</th><th>Zip</th>
        <th>Lat</th><th>Lng</th><th>Timezone</th><th></th>
      </tr></thead><tbody>
      ${props.map(p => `
        <tr data-id="${p.id}">
          <td><input data-f="name" value="${escapeHtml(p.name)}" /></td>
          <td><input data-f="address" value="${escapeHtml(p.address || "")}" /></td>
          <td><input data-f="locality" value="${escapeHtml(p.locality || "")}" /></td>
          <td><input data-f="region" value="${escapeHtml(p.region || "")}" /></td>
          <td><input data-f="postal_code" value="${escapeHtml(p.postal_code || "")}" /></td>
          <td><input data-f="latitude" type="number" step="any" value="${p.latitude ?? ""}" /></td>
          <td><input data-f="longitude" type="number" step="any" value="${p.longitude ?? ""}" /></td>
          <td><input data-f="timezone" value="${escapeHtml(p.timezone || "")}" /></td>
          <td>
            <button data-save>Save</button>
            ${p.latitude && p.longitude
              ? `<a class="tag" target="_blank" href="https://www.google.com/maps/?q=${p.latitude},${p.longitude}">Map</a>`
              : ""}
          </td>
        </tr>`).join("")}
      </tbody></table>
      <h2>New property</h2>
      <div class="form-row three">
        <div><label>Name</label><input id="newPropName" /></div>
        <div><label>City</label><input id="newPropCity" /></div>
        <div><label>State</label><input id="newPropRegion" /></div>
      </div>
      <div class="actions"><button id="addProperty">Add property</button></div>
    </section>`;

  view().querySelectorAll("tr[data-id]").forEach(tr => {
    const id = tr.dataset.id;
    tr.querySelector("[data-save]").addEventListener("click", async () => {
      const body = {};
      tr.querySelectorAll("input[data-f]").forEach(i => {
        const v = i.value === "" ? null : (i.type === "number" ? Number(i.value) : i.value);
        body[i.dataset.f] = v;
      });
      await api(`/properties/${id}`, { method: "PUT", body: JSON.stringify(body) });
    });
  });
  view().querySelector("#addProperty").addEventListener("click", async () => {
    await api("/properties", { method: "POST", body: JSON.stringify({
      name: view().querySelector("#newPropName").value,
      locality: view().querySelector("#newPropCity").value,
      region: view().querySelector("#newPropRegion").value,
    })});
    renderProperties();
  });
}

// ---------- Reviews ----------
async function renderReviews() {
  const [props, reviews] = await Promise.all([
    api("/properties"),
    api("/reviews"),
  ]);
  const propMap = Object.fromEntries(props.map(p => [p.id, p]));
  view().innerHTML = `
    <section class="panel">
      <h1>Reviews</h1>
      <p class="hint">Reviews show on every unit's /book/unit/:id page and feed the aggregate star rating in Schema.org JSON-LD for Google rich results.</p>
      <h2>Add review</h2>
      <div class="form-row three">
        <div><label>Property</label>
          <select id="rvProp">${props.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}</select>
        </div>
        <div><label>Guest name</label><input id="rvAuthor" /></div>
        <div><label>Rating (1-5)</label><input id="rvRating" type="number" min="1" max="5" value="5" /></div>
      </div>
      <div class="form-row three">
        <div><label>Title</label><input id="rvTitle" /></div>
        <div><label>Stay date</label><input id="rvStay" type="date" /></div>
        <div><label>Source</label>
          <select id="rvSource">
            <option>direct</option><option>airbnb</option><option>vrbo</option>
            <option>booking</option><option>google</option><option>manual</option>
          </select>
        </div>
      </div>
      <label>Review body</label>
      <textarea id="rvBody" rows="3"></textarea>
      <div class="actions"><button id="addReview">Add review</button></div>
    </section>
    <section class="panel">
      <h2>All reviews</h2>
      <table><thead><tr>
        <th>When</th><th>Property</th><th>Rating</th><th>Author</th>
        <th>Title / body</th><th>Source</th><th>Published</th><th></th>
      </tr></thead><tbody>
      ${reviews.map(r => `
        <tr data-id="${r.id}">
          <td>${r.stay_date || r.created_at.slice(0,10)}</td>
          <td>${escapeHtml(propMap[r.property_id]?.name || "")}</td>
          <td><input data-f="rating" type="number" min="1" max="5" value="${r.rating}" /></td>
          <td><input data-f="author_name" value="${escapeHtml(r.author_name)}" /></td>
          <td>
            <input data-f="title" value="${escapeHtml(r.title || "")}" placeholder="title" />
            <textarea data-f="body" rows="2">${escapeHtml(r.body || "")}</textarea>
          </td>
          <td><span class="tag platform-${r.source}">${r.source}</span></td>
          <td><input data-f="published" type="checkbox" ${r.published ? "checked" : ""} /></td>
          <td>
            <button data-save>Save</button>
            <button class="danger" data-delete>Delete</button>
          </td>
        </tr>`).join("")}
      </tbody></table>
    </section>`;

  view().querySelector("#addReview").addEventListener("click", async () => {
    await api("/reviews", { method: "POST", body: JSON.stringify({
      property_id: Number(view().querySelector("#rvProp").value),
      author_name: view().querySelector("#rvAuthor").value,
      rating:      Number(view().querySelector("#rvRating").value),
      title:       view().querySelector("#rvTitle").value || undefined,
      body:        view().querySelector("#rvBody").value || undefined,
      stay_date:   view().querySelector("#rvStay").value || undefined,
      source:      view().querySelector("#rvSource").value,
    })});
    renderReviews();
  });
  view().querySelectorAll("tr[data-id]").forEach(tr => {
    const id = tr.dataset.id;
    tr.querySelector("[data-save]").addEventListener("click", async () => {
      const body = {};
      tr.querySelectorAll("[data-f]").forEach(i => {
        if (i.type === "checkbox") body[i.dataset.f] = i.checked ? 1 : 0;
        else if (i.type === "number") body[i.dataset.f] = i.value === "" ? null : Number(i.value);
        else body[i.dataset.f] = i.value || null;
      });
      await api(`/reviews/${id}`, { method: "PUT", body: JSON.stringify(body) });
    });
    tr.querySelector("[data-delete]").addEventListener("click", async () => {
      if (!confirm("Delete review?")) return;
      await api(`/reviews/${id}`, { method: "DELETE" });
      renderReviews();
    });
  });
}

// ---------- Sync log ----------
async function renderSyncLog() {
  const rows = await api("/sync-log");
  view().innerHTML = `
    <section class="panel">
      <h1>Sync log</h1>
      <table><thead><tr>
        <th>When</th><th>Listing</th><th>Direction</th><th>Status</th>
        <th>Added</th><th>Updated</th><th>Message</th>
      </tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td>${r.created_at}</td><td>${r.listing_id ?? "-"}</td>
        <td>${r.direction}</td>
        <td style="color:${r.status === "ok" ? "var(--ok)" : "var(--danger)"}">${r.status}</td>
        <td>${r.bookings_added}</td><td>${r.bookings_updated}</td>
        <td>${escapeHtml(r.message || "")}</td>
      </tr>`).join("")}
      </tbody></table>
    </section>`;
}

navigate();
