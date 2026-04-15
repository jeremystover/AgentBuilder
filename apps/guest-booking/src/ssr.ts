// Server-side rendered HTML for the public booking pages.
//
// These pages embed Schema.org VacationRental JSON-LD so Google can
// index listings without running client-side JavaScript.  The rendered
// HTML is still hydrated by /book.js at runtime for interactive bits
// (date picker, live quote, Stripe/Square checkout), but the content
// and structured data are present in the initial HTML response.

import type { Env, Unit, Property, Review } from "./types";
import {
  buildVacationRentalLd,
  buildLodgingBusinessLd,
  buildBreadcrumbLd,
  aggregateReviews,
  type SeoContext,
} from "./seo";

function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function seoContext(env: Env, reqUrl: string): SeoContext {
  return {
    baseUrl: env.PUBLIC_BASE_URL ?? new URL(reqUrl).origin,
    brandName: "The Whitford House",
  };
}

function renderJsonLd(obj: unknown): string {
  // Escape `<` so a stray `</script>` inside a string can't break out.
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

interface ShellOpts {
  title: string;
  description: string;
  canonical: string;
  ogImage?: string;
  jsonLd: unknown[];
  body: string;
  noindex?: boolean;
}

function documentShell(opts: ShellOpts): string {
  const { title, description, canonical, ogImage, jsonLd, body, noindex } = opts;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="robots" content="${noindex ? "noindex,nofollow" : "index,follow,max-image-preview:large"}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="The Whitford House" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  ${ogImage ? `<meta property="og:image" content="${esc(ogImage)}" />` : ""}
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="stylesheet" href="/book.css" />
  ${jsonLd.map(renderJsonLd).join("\n  ")}
</head>
<body class="public">
  <header class="public-header">
    <div class="brand"><a href="/book">The Whitford House</a></div>
    <nav><a href="https://www.thewhitfordhouse.com">Home</a></nav>
  </header>
  <main id="root">
${body}
  </main>
  <footer class="public-footer">
    <span>© The Whitford House · <a href="https://www.thewhitfordhouse.com">thewhitfordhouse.com</a></span>
  </footer>
  <script src="/book.js" type="module"></script>
</body>
</html>`;
}

async function loadBookableUnits(env: Env): Promise<{
  units: Unit[];
  properties: Map<number, Property>;
  photosByUnit: Map<number, Array<{ id: number }>>;
  reviewsByProperty: Map<number, Review[]>;
}> {
  const units = await env.DB.prepare(
    `SELECT * FROM units WHERE base_price IS NOT NULL ORDER BY property_id, id`
  ).all<Unit>();
  const props = await env.DB.prepare(`SELECT * FROM properties`).all<Property>();
  const properties = new Map(props.results.map(p => [p.id, p]));
  const photos = await env.DB.prepare(
    `SELECT id, unit_id FROM photos ORDER BY sort_order, id`
  ).all<{ id: number; unit_id: number }>();
  const photosByUnit = new Map<number, Array<{ id: number }>>();
  for (const p of photos.results) {
    if (!photosByUnit.has(p.unit_id)) photosByUnit.set(p.unit_id, []);
    photosByUnit.get(p.unit_id)!.push({ id: p.id });
  }
  const reviews = await env.DB.prepare(
    `SELECT * FROM reviews WHERE published = 1 ORDER BY created_at DESC`
  ).all<Review>();
  const reviewsByProperty = new Map<number, Review[]>();
  for (const r of reviews.results) {
    if (!reviewsByProperty.has(r.property_id)) reviewsByProperty.set(r.property_id, []);
    reviewsByProperty.get(r.property_id)!.push(r);
  }
  return { units: units.results, properties, photosByUnit, reviewsByProperty };
}

async function loadPropertyReviews(env: Env, propertyId: number): Promise<Review[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM reviews WHERE property_id = ? AND published = 1 ORDER BY created_at DESC`
  ).bind(propertyId).all<Review>();
  return res.results;
}

function starBar(value: number): string {
  const full = Math.round(value);
  const stars = "★★★★★".slice(0, full) + "☆☆☆☆☆".slice(0, 5 - full);
  return stars;
}

function renderReviews(reviews: Review[]): string {
  if (reviews.length === 0) return "";
  const agg = aggregateReviews(reviews);
  const header = agg
    ? `<div class="reviews-header">
        <span class="rating">${starBar(agg.ratingValue)}</span>
        <strong>${agg.ratingValue.toFixed(1)}</strong>
        <span class="muted">· ${agg.reviewCount} review${agg.reviewCount === 1 ? "" : "s"}</span>
      </div>`
    : "";
  const cards = reviews.slice(0, 6).map(r => `
    <article class="review">
      <header>
        <span class="rating">${starBar(r.rating)}</span>
        <strong>${esc(r.author_name)}</strong>
        ${r.stay_date ? `<span class="muted">· stayed ${esc(r.stay_date)}</span>` : ""}
        ${r.source && r.source !== "direct" ? `<span class="tag">${esc(r.source)}</span>` : ""}
      </header>
      ${r.title ? `<h4>${esc(r.title)}</h4>` : ""}
      ${r.body ? `<p>${esc(r.body)}</p>` : ""}
    </article>`).join("");
  return `<section class="public-panel reviews">
    <h2>Guest reviews</h2>
    ${header}
    <div class="review-grid">${cards}</div>
  </section>`;
}

function unitCard(u: Unit, photo: { id: number } | undefined): string {
  const meta: string[] = [];
  if (u.bedrooms) meta.push(`${u.bedrooms} BR`);
  if (u.sleeps) meta.push(`sleeps ${u.sleeps}`);
  const metaStr = meta.join(" · ");
  const price = u.base_price != null ? `$${u.base_price}/night` : "";
  const img = photo
    ? `<img class="ph" src="/photos/${photo.id}" alt="${esc(u.name)}" loading="lazy" />`
    : `<div class="ph"></div>`;
  return `<a class="unit-card" href="/book/unit/${u.id}">
  ${img}
  <h3>${esc(u.name)}</h3>
  <p>${esc(metaStr)}${metaStr && price ? " · " : ""}<span class="price">${esc(price)}</span></p>
</a>`;
}

// ---------- List page ----------
export async function renderBookList(env: Env, reqUrl: string): Promise<Response> {
  const ctx = seoContext(env, reqUrl);
  const { units, properties, photosByUnit, reviewsByProperty } = await loadBookableUnits(env);
  const firstPhoto = (uid: number) => photosByUnit.get(uid)?.[0];

  const lodgingLd = buildLodgingBusinessLd(units, photosByUnit, properties, ctx, reviewsByProperty);
  const unitLds = units.map(u => {
    const prop = properties.get(u.property_id);
    if (!prop) return null;
    return buildVacationRentalLd(
      u,
      photosByUnit.get(u.id) ?? [],
      prop,
      ctx,
      reviewsByProperty.get(prop.id) ?? []
    );
  }).filter(Boolean);

  const ogImage = units[0] && firstPhoto(units[0].id)
    ? `${ctx.baseUrl}/photos/${firstPhoto(units[0].id)!.id}`
    : undefined;

  const cards = units.length
    ? units.map(u => unitCard(u, firstPhoto(u.id))).join("\n")
    : `<p class="muted">No bookable units yet.</p>`;

  const body = `<section id="list-view" class="public-panel">
  <h1>Book your stay at The Whitford House</h1>
  <p class="lede">Choose a unit, pick your dates, and check out. Your booking blocks the dates everywhere automatically — Airbnb, VRBO, Booking.com, and our own calendar.</p>
  <div class="unit-grid">
${cards}
  </div>
</section>`;

  const html = documentShell({
    title: "Book The Whitford House — direct reservations",
    description:
      "Book direct at The Whitford House. Guest house and whole-house or individual-room rentals in the main house. No booking fees.",
    canonical: `${ctx.baseUrl}/book`,
    ogImage,
    jsonLd: [lodgingLd, ...unitLds],
    body,
  });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

// ---------- Unit detail page ----------
function detailBody(unit: Unit, photos: Array<{ id: number }>, property: Property, reviews: Review[]): string {
  const imgs = photos.slice(0, 5);
  const photoHtml = imgs.length
    ? imgs.map((p, i) =>
        `<img class="ph${i === 0 ? " big" : ""}" src="/photos/${p.id}" alt="${esc(unit.name)}" loading="${i === 0 ? "eager" : "lazy"}" />`
      ).join("")
    : `<div class="ph big"></div>`;

  const metaBits: string[] = [];
  if (unit.bedrooms) metaBits.push(`${unit.bedrooms} bedrooms`);
  if (unit.bathrooms) metaBits.push(`${unit.bathrooms} baths`);
  if (unit.sleeps) metaBits.push(`sleeps ${unit.sleeps}`);
  if (unit.min_nights) metaBits.push(`${unit.min_nights}-night min`);
  if (unit.base_price != null) metaBits.push(`$${unit.base_price}/night`);

  const agg = aggregateReviews(reviews);
  const ratingBadge = agg
    ? `<p class="rating-line">
         <span class="rating">${starBar(agg.ratingValue)}</span>
         <strong>${agg.ratingValue.toFixed(1)}</strong>
         <span class="muted">· ${agg.reviewCount} review${agg.reviewCount === 1 ? "" : "s"}</span>
       </p>`
    : "";

  const mapLink = (property.latitude != null && property.longitude != null)
    ? `<p><a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/?q=${property.latitude},${property.longitude}">📍 View on map</a></p>`
    : "";

  return `<section id="detail-view" class="public-panel" data-unit-id="${unit.id}">
  <a class="link" href="/book">← All units</a>
  <div class="detail">
    <div class="detail-photos">${photoHtml}</div>
    <div class="detail-body">
      <h1>${esc(unit.name)}</h1>
      <p class="muted">${esc(metaBits.join(" · "))}</p>
      ${ratingBadge}
      <p>${esc(unit.description)}</p>
      ${mapLink}

      <div class="form-row">
        <div><label>Check-in</label><input type="date" id="startDate" /></div>
        <div><label>Check-out</label><input type="date" id="endDate" /></div>
      </div>
      <div class="form-row">
        <div><label>Adults</label><input type="number" id="adults" min="1" value="2" /></div>
        <div><label>Children</label><input type="number" id="children" min="0" value="0" /></div>
      </div>
      <div class="quote" id="quoteBox">Select dates to see a price.</div>

      <h2>Your information</h2>
      <div class="form-row">
        <div><label>Full name</label><input id="guestName" /></div>
        <div><label>Email</label><input id="guestEmail" type="email" /></div>
      </div>
      <label>Phone (optional)</label>
      <input id="guestPhone" type="tel" />
      <label>Notes for the host (optional)</label>
      <textarea id="notes" rows="3"></textarea>

      <h2>Pay</h2>
      <div class="actions">
        <button class="pay stripe" data-provider="stripe" disabled>Pay with Card (Stripe)</button>
        <button class="pay square" data-provider="square" disabled>Pay with Square</button>
      </div>
      <p class="muted small">Dates are held for 30 minutes while you complete checkout. If you don't pay, the hold expires and the dates are released automatically.</p>
      <p id="err" class="err" hidden></p>
    </div>
  </div>
</section>
${renderReviews(reviews)}`;
}

export async function renderBookUnit(env: Env, reqUrl: string, unitId: number): Promise<Response> {
  const ctx = seoContext(env, reqUrl);
  const unit = await env.DB.prepare("SELECT * FROM units WHERE id = ?")
    .bind(unitId).first<Unit>();
  if (!unit || unit.base_price == null) {
    return new Response("Not found", { status: 404 });
  }
  const property = await env.DB.prepare("SELECT * FROM properties WHERE id = ?")
    .bind(unit.property_id).first<Property>();
  if (!property) return new Response("Not found", { status: 404 });
  const photos = await env.DB.prepare(
    "SELECT id FROM photos WHERE unit_id = ? ORDER BY sort_order, id"
  ).bind(unitId).all<{ id: number }>();
  const photoList = photos.results;
  const reviews = await loadPropertyReviews(env, property.id);

  const vrLd = buildVacationRentalLd(unit, photoList, property, ctx, reviews);
  const crumbLd = buildBreadcrumbLd(unit, ctx);

  const canonical = `${ctx.baseUrl}/book/unit/${unit.id}`;
  const title = `${unit.name} — ${property.name} | The Whitford House`;

  const descBits: string[] = [];
  if (unit.bedrooms) descBits.push(`${unit.bedrooms} BR`);
  if (unit.bathrooms) descBits.push(`${unit.bathrooms} bath`);
  if (unit.sleeps) descBits.push(`sleeps ${unit.sleeps}`);
  const description = unit.description
    ?? `Book ${unit.name} at The Whitford House. ${descBits.join(", ")}.`;
  const ogImage = photoList[0] ? `${ctx.baseUrl}/photos/${photoList[0].id}` : undefined;

  const html = documentShell({
    title,
    description,
    canonical,
    ogImage,
    jsonLd: [vrLd, crumbLd],
    body: detailBody(unit, photoList, property, reviews),
  });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

// ---------- Success / cancel ----------
export function renderSuccessPage(env: Env, reqUrl: string, sessionId: string | null, bookingId: string | null): Response {
  const ctx = seoContext(env, reqUrl);
  const body = `<section class="public-panel" data-session="${esc(sessionId)}" data-booking="${esc(bookingId)}">
  <h1>Thanks — you're booked!</h1>
  <p id="successSummary">${sessionId || bookingId ? "Loading your booking…" : "Your booking has been received."}</p>
  <p>A confirmation is on its way to your email. We'll reach out with check-in details a few days before your arrival.</p>
  <p><a href="/book">← Back to all units</a></p>
</section>`;
  const html = documentShell({
    title: "Booking confirmed — The Whitford House",
    description: "Your booking at The Whitford House is confirmed.",
    canonical: `${ctx.baseUrl}/book/success`,
    jsonLd: [],
    body,
    noindex: true,
  });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export function renderCancelPage(env: Env, reqUrl: string): Response {
  const ctx = seoContext(env, reqUrl);
  const body = `<section class="public-panel">
  <h1>Checkout cancelled</h1>
  <p>No payment was taken and your dates are being released. You can <a href="/book">browse units again</a>.</p>
</section>`;
  const html = documentShell({
    title: "Checkout cancelled — The Whitford House",
    description: "Your checkout was cancelled.",
    canonical: `${ctx.baseUrl}/book/cancel`,
    jsonLd: [],
    body,
    noindex: true,
  });
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---------- Sitemap + robots ----------
export async function renderSitemap(env: Env, reqUrl: string): Promise<Response> {
  const ctx = seoContext(env, reqUrl);
  const units = await env.DB.prepare(
    "SELECT id FROM units WHERE base_price IS NOT NULL"
  ).all<{ id: number }>();
  const now = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${ctx.baseUrl}/book`, priority: "0.9" },
    ...units.results.map(u => ({
      loc: `${ctx.baseUrl}/book/unit/${u.id}`,
      priority: "0.8",
    })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join("\n")}
</urlset>`;
  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export function renderRobots(env: Env, reqUrl: string): Response {
  const base = env.PUBLIC_BASE_URL ?? new URL(reqUrl).origin;
  const txt = `User-agent: *
Allow: /book
Allow: /book/
Disallow: /api/
Disallow: /ical/
Disallow: /photos/

Sitemap: ${base}/sitemap.xml
`;
  return new Response(txt, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
