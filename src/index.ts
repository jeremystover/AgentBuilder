// Booking Sync Manager - Cloudflare Worker entry point.
//
// Responsibilities:
//  * Serve the web UI (static files from /public via the assets binding).
//  * Expose a small JSON REST API for properties, units, listings,
//    bookings, photos and calendar sync.
//  * Serve per-listing outbound iCal feeds at /ical/:token.ics so that
//    Airbnb / VRBO / Booking.com can import our availability.
//  * Run a scheduled handler that pulls every active listing's iCal
//    feed so inbound bookings block the other channels.

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Listing, Unit, Booking, Photo, Property, Platform } from "./types";
import { buildICal } from "./ical";
import { blockedRangesForUnit, conflictsForUnit, isUnitAvailable } from "./availability";
import { pullAll, pullListing, createDirectBooking } from "./sync";
import { quoteBooking } from "./pricing";
import {
  createStripeCheckoutSession,
  verifyStripeSignature,
  handleStripeEvent,
} from "./payments/stripe";
import {
  createSquarePaymentLink,
  verifySquareSignature,
  handleSquareEvent,
} from "./payments/square";
import {
  renderBookList,
  renderBookUnit,
  renderSuccessPage,
  renderCancelPage,
  renderSitemap,
  renderRobots,
} from "./ssr";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();
app.use("/api/*", cors());

// ---------- Auth ----------
// Admin endpoints require x-admin-token.  Everything under
// /api/public/ (guest booking flow) and /api/webhooks/ (payment
// callbacks, authenticated via HMAC) is unauthenticated.
app.use("/api/*", async (c, next) => {
  const p = c.req.path;
  if (p.startsWith("/api/public/")) return next();
  if (p.startsWith("/api/webhooks/")) return next();
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return next(); // allow in dev when no token is configured
  const got = c.req.header("x-admin-token");
  if (got !== expected) return c.json({ error: "unauthorized" }, 401);
  await next();
});

// ---------- Health ----------
app.get("/api/health", (c) => c.json({ ok: true, app: c.env.APP_NAME }));

// ---------- Properties ----------
app.get("/api/properties", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM properties ORDER BY id").all<Property>();
  return c.json(rows.results);
});
app.post("/api/properties", async (c) => {
  const body = await c.req.json<Partial<Property>>();
  const res = await c.env.DB.prepare(
    `INSERT INTO properties
       (name, address, locality, region, postal_code, country,
        latitude, longitude, timezone, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    body.name ?? "Untitled",
    body.address ?? null,
    body.locality ?? null,
    body.region ?? null,
    body.postal_code ?? null,
    body.country ?? "US",
    body.latitude ?? null,
    body.longitude ?? null,
    body.timezone ?? "UTC",
    body.description ?? null,
  ).run();
  return c.json({ id: res.meta.last_row_id });
});
app.put("/api/properties/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Partial<Property>>();
  await c.env.DB.prepare(
    `UPDATE properties SET
       name        = COALESCE(?, name),
       address     = COALESCE(?, address),
       locality    = COALESCE(?, locality),
       region      = COALESCE(?, region),
       postal_code = COALESCE(?, postal_code),
       country     = COALESCE(?, country),
       latitude    = COALESCE(?, latitude),
       longitude   = COALESCE(?, longitude),
       timezone    = COALESCE(?, timezone),
       description = COALESCE(?, description)
     WHERE id = ?`
  ).bind(
    body.name ?? null,
    body.address ?? null,
    body.locality ?? null,
    body.region ?? null,
    body.postal_code ?? null,
    body.country ?? null,
    body.latitude ?? null,
    body.longitude ?? null,
    body.timezone ?? null,
    body.description ?? null,
    id,
  ).run();
  return c.json({ ok: true });
});
app.delete("/api/properties/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM properties WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------- Units ----------
app.get("/api/units", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM units ORDER BY property_id, id").all<Unit>();
  const comps = await c.env.DB.prepare(
    "SELECT composite_unit_id, atomic_unit_id FROM unit_components"
  ).all<{ composite_unit_id: number; atomic_unit_id: number }>();
  const byComposite = new Map<number, number[]>();
  for (const r of comps.results) {
    if (!byComposite.has(r.composite_unit_id)) byComposite.set(r.composite_unit_id, []);
    byComposite.get(r.composite_unit_id)!.push(r.atomic_unit_id);
  }
  return c.json(rows.results.map(u => ({ ...u, components: byComposite.get(u.id) ?? [] })));
});

app.post("/api/units", async (c) => {
  const body = await c.req.json<Partial<Unit> & { components?: number[] }>();
  const res = await c.env.DB.prepare(
    `INSERT INTO units (property_id, name, kind, sleeps, bedrooms, bathrooms, base_price, cleaning_fee, min_nights, description, amenities_json, house_rules)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    body.property_id!, body.name ?? "Unit", body.kind ?? "atomic",
    body.sleeps ?? null, body.bedrooms ?? null, body.bathrooms ?? null,
    body.base_price ?? null, body.cleaning_fee ?? null, body.min_nights ?? 1,
    body.description ?? null, body.amenities_json ?? null, body.house_rules ?? null
  ).run();
  const id = Number(res.meta.last_row_id);
  if (body.kind === "composite" && body.components) {
    for (const atomicId of body.components) {
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO unit_components (composite_unit_id, atomic_unit_id) VALUES (?, ?)"
      ).bind(id, atomicId).run();
    }
  }
  return c.json({ id });
});

app.put("/api/units/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Partial<Unit> & { components?: number[] }>();
  await c.env.DB.prepare(
    `UPDATE units SET
       name = COALESCE(?, name),
       sleeps = COALESCE(?, sleeps),
       bedrooms = COALESCE(?, bedrooms),
       bathrooms = COALESCE(?, bathrooms),
       base_price = COALESCE(?, base_price),
       cleaning_fee = COALESCE(?, cleaning_fee),
       min_nights = COALESCE(?, min_nights),
       description = COALESCE(?, description),
       amenities_json = COALESCE(?, amenities_json),
       house_rules = COALESCE(?, house_rules)
     WHERE id = ?`
  ).bind(
    body.name ?? null, body.sleeps ?? null, body.bedrooms ?? null, body.bathrooms ?? null,
    body.base_price ?? null, body.cleaning_fee ?? null, body.min_nights ?? null,
    body.description ?? null, body.amenities_json ?? null, body.house_rules ?? null, id
  ).run();
  if (Array.isArray(body.components)) {
    await c.env.DB.prepare("DELETE FROM unit_components WHERE composite_unit_id = ?").bind(id).run();
    for (const atomicId of body.components) {
      await c.env.DB.prepare(
        "INSERT INTO unit_components (composite_unit_id, atomic_unit_id) VALUES (?, ?)"
      ).bind(id, atomicId).run();
    }
  }
  return c.json({ ok: true });
});

app.delete("/api/units/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM units WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------- Listings ----------
app.get("/api/listings", async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT l.*, p.slug AS platform_slug, p.display_name AS platform_name, u.name AS unit_name
      FROM listings l
      JOIN platforms p ON p.id = l.platform_id
      JOIN units u ON u.id = l.unit_id
     ORDER BY u.id, p.id`).all();
  return c.json(rows.results);
});
app.post("/api/listings", async (c) => {
  const body = await c.req.json<Partial<Listing>>();
  const token = crypto.randomUUID();
  const res = await c.env.DB.prepare(
    `INSERT INTO listings (unit_id, platform_id, external_id, title, ical_import_url, export_token, overrides_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    body.unit_id!, body.platform_id!, body.external_id ?? null, body.title ?? null,
    body.ical_import_url ?? null, token, body.overrides_json ?? null
  ).run();
  return c.json({ id: res.meta.last_row_id, export_token: token });
});
app.put("/api/listings/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Partial<Listing>>();
  await c.env.DB.prepare(
    `UPDATE listings SET
       external_id = COALESCE(?, external_id),
       title = COALESCE(?, title),
       status = COALESCE(?, status),
       ical_import_url = COALESCE(?, ical_import_url),
       overrides_json = COALESCE(?, overrides_json)
     WHERE id = ?`
  ).bind(
    body.external_id ?? null, body.title ?? null, body.status ?? null,
    body.ical_import_url ?? null, body.overrides_json ?? null, id
  ).run();
  return c.json({ ok: true });
});
app.delete("/api/listings/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM listings WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

app.post("/api/listings/:id/pull", async (c) => {
  const id = Number(c.req.param("id"));
  const listing = await c.env.DB.prepare("SELECT * FROM listings WHERE id = ?").bind(id).first<Listing>();
  if (!listing) return c.json({ error: "not found" }, 404);
  try {
    const result = await pullListing(c.env, listing);
    return c.json({ ok: true, ...result });
  } catch (e: unknown) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.post("/api/sync/pull-all", async (c) => {
  await pullAll(c.env);
  return c.json({ ok: true });
});

// ---------- Bookings ----------
app.get("/api/bookings", async (c) => {
  const unit = c.req.query("unit_id");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const clauses: string[] = ["1=1"];
  const binds: unknown[] = [];
  if (unit) { clauses.push("unit_id = ?"); binds.push(Number(unit)); }
  if (from) { clauses.push("end_date > ?"); binds.push(from); }
  if (to)   { clauses.push("start_date < ?"); binds.push(to); }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM bookings WHERE ${clauses.join(" AND ")} ORDER BY start_date`
  ).bind(...binds).all<Booking>();
  return c.json(rows.results);
});

app.post("/api/bookings", async (c) => {
  const body = await c.req.json<{
    unit_id: number; start_date: string; end_date: string;
    guest_name?: string; guest_email?: string; guest_phone?: string;
    adults?: number; children?: number; total_amount?: number;
    currency?: string; notes?: string; force?: boolean;
  }>();
  if (!body.force) {
    const conflicts = await conflictsForUnit(c.env, body.unit_id, { start: body.start_date, end: body.end_date });
    if (conflicts.length) return c.json({ error: "conflict", conflicts }, 409);
  }
  const id = await createDirectBooking(c.env, body);
  return c.json({ id });
});

app.delete("/api/bookings/:id", async (c) => {
  await c.env.DB.prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?")
    .bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

app.get("/api/availability", async (c) => {
  const unit_id = Number(c.req.query("unit_id"));
  const start = c.req.query("start")!;
  const end = c.req.query("end")!;
  const available = await isUnitAvailable(c.env, unit_id, { start, end });
  return c.json({ available });
});

// ---------- Reviews ----------
app.get("/api/reviews", async (c) => {
  const property_id = c.req.query("property_id");
  const clauses = ["1=1"]; const binds: unknown[] = [];
  if (property_id) { clauses.push("property_id = ?"); binds.push(Number(property_id)); }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM reviews WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`
  ).bind(...binds).all();
  return c.json(rows.results);
});

app.post("/api/reviews", async (c) => {
  const body = await c.req.json<{
    property_id: number;
    author_name: string;
    rating: number;
    title?: string;
    body?: string;
    source?: string;
    external_id?: string;
    stay_date?: string;
    booking_id?: number;
    published?: number;
  }>();
  if (body.rating < 1 || body.rating > 5) return c.json({ error: "rating out of range" }, 400);
  const res = await c.env.DB.prepare(
    `INSERT INTO reviews
       (property_id, booking_id, author_name, rating, title, body,
        source, external_id, stay_date, published)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    body.property_id,
    body.booking_id ?? null,
    body.author_name,
    body.rating,
    body.title ?? null,
    body.body ?? null,
    body.source ?? "direct",
    body.external_id ?? null,
    body.stay_date ?? null,
    body.published ?? 1,
  ).run();
  return c.json({ id: res.meta.last_row_id });
});

app.put("/api/reviews/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Partial<{
    author_name: string; rating: number; title: string; body: string;
    source: string; stay_date: string; published: number;
  }>>();
  await c.env.DB.prepare(
    `UPDATE reviews SET
       author_name = COALESCE(?, author_name),
       rating      = COALESCE(?, rating),
       title       = COALESCE(?, title),
       body        = COALESCE(?, body),
       source      = COALESCE(?, source),
       stay_date   = COALESCE(?, stay_date),
       published   = COALESCE(?, published)
     WHERE id = ?`
  ).bind(
    body.author_name ?? null,
    body.rating ?? null,
    body.title ?? null,
    body.body ?? null,
    body.source ?? null,
    body.stay_date ?? null,
    body.published ?? null,
    id,
  ).run();
  return c.json({ ok: true });
});

app.delete("/api/reviews/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM reviews WHERE id = ?")
    .bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------- Photos (R2) ----------
app.get("/api/units/:id/photos", async (c) => {
  const unit_id = Number(c.req.param("id"));
  const rows = await c.env.DB.prepare(
    "SELECT * FROM photos WHERE unit_id = ? ORDER BY sort_order, id"
  ).bind(unit_id).all<Photo>();
  return c.json(rows.results);
});

app.post("/api/units/:id/photos", async (c) => {
  const unit_id = Number(c.req.param("id"));
  const contentType = c.req.header("content-type") ?? "application/octet-stream";
  const caption = c.req.header("x-caption") ?? null;
  const bytes = await c.req.arrayBuffer();
  const key = `units/${unit_id}/${crypto.randomUUID()}`;
  await c.env.PHOTOS.put(key, bytes, { httpMetadata: { contentType } });
  const res = await c.env.DB.prepare(
    `INSERT INTO photos (unit_id, r2_key, caption, content_type, size_bytes)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(unit_id, key, caption, contentType, bytes.byteLength).run();
  return c.json({ id: res.meta.last_row_id, r2_key: key });
});

app.delete("/api/photos/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT r2_key FROM photos WHERE id = ?").bind(id).first<{ r2_key: string }>();
  if (row) {
    await c.env.PHOTOS.delete(row.r2_key);
    await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
  }
  return c.json({ ok: true });
});

app.get("/photos/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT r2_key, content_type FROM photos WHERE id = ?")
    .bind(id).first<{ r2_key: string; content_type: string | null }>();
  if (!row) return c.notFound();
  const obj = await c.env.PHOTOS.get(row.r2_key);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      "content-type": row.content_type ?? "application/octet-stream",
      "cache-control": "public, max-age=300",
    },
  });
});

// ---------- Platforms ----------
app.get("/api/platforms", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, slug, display_name, adapter FROM platforms ORDER BY id").all<Platform>();
  return c.json(rows.results);
});
app.post("/api/platforms", async (c) => {
  const body = await c.req.json<Partial<Platform>>();
  const res = await c.env.DB.prepare(
    "INSERT INTO platforms (slug, display_name, adapter) VALUES (?, ?, ?)"
  ).bind(body.slug!, body.display_name!, body.adapter ?? "ical").run();
  return c.json({ id: res.meta.last_row_id });
});

// ---------- Outbound iCal feed (public, token-gated) ----------
app.get("/ical/:token.ics", async (c) => {
  const token = c.req.param("token");
  const listing = await c.env.DB.prepare(
    `SELECT l.*, u.name AS unit_name
       FROM listings l JOIN units u ON u.id = l.unit_id
      WHERE l.export_token = ?`
  ).bind(token).first<Listing & { unit_name: string }>();
  if (!listing) return c.notFound();
  const events = await blockedRangesForUnit(c.env, listing.unit_id);
  const body = buildICal(`Booking Sync - ${listing.unit_name}`, events);
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
});

// ---------- Sync log ----------
app.get("/api/sync-log", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM sync_log ORDER BY id DESC LIMIT 100"
  ).all();
  return c.json(rows.results);
});

// =========================================================================
// PUBLIC BOOKING FLOW (no admin token)
// =========================================================================
//
// Used by the guest-facing booking page at /book.html.
//
//   GET  /api/public/units                 -> bookable units with photos
//   GET  /api/public/units/:id             -> single unit + photos
//   POST /api/public/quote                 -> price quote
//   POST /api/public/checkout              -> create hold + payment URL
//   POST /api/webhooks/stripe              -> Stripe event handler
//   POST /api/webhooks/square              -> Square event handler

app.get("/api/public/units", async (c) => {
  // Return only units that have a price configured.
  const units = await c.env.DB.prepare(
    `SELECT u.*, p.name AS property_name, p.timezone AS property_tz
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.base_price IS NOT NULL
      ORDER BY u.property_id, u.id`
  ).all<Unit & { property_name: string; property_tz: string }>();
  const photos = await c.env.DB.prepare(
    "SELECT id, unit_id, caption FROM photos ORDER BY sort_order, id"
  ).all<{ id: number; unit_id: number; caption: string | null }>();
  const byUnit = new Map<number, typeof photos.results>();
  for (const p of photos.results) {
    if (!byUnit.has(p.unit_id)) byUnit.set(p.unit_id, []);
    byUnit.get(p.unit_id)!.push(p);
  }
  return c.json(units.results.map(u => ({
    ...u, photos: byUnit.get(u.id) ?? [],
  })));
});

app.get("/api/public/units/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const unit = await c.env.DB.prepare(
    `SELECT u.*, p.name AS property_name FROM units u
       JOIN properties p ON p.id = u.property_id WHERE u.id = ?`
  ).bind(id).first();
  if (!unit) return c.notFound();
  const photos = await c.env.DB.prepare(
    "SELECT id, caption FROM photos WHERE unit_id = ? ORDER BY sort_order, id"
  ).bind(id).all();
  return c.json({ ...unit, photos: photos.results });
});

app.post("/api/public/quote", async (c) => {
  const body = await c.req.json<{ unit_id: number; start_date: string; end_date: string }>();
  try {
    const quote = await quoteBooking(c.env, body.unit_id, body.start_date, body.end_date);
    const available = await isUnitAvailable(c.env, body.unit_id, {
      start: body.start_date, end: body.end_date,
    });
    return c.json({ ...quote, available });
  } catch (e: unknown) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.post("/api/public/checkout", async (c) => {
  const body = await c.req.json<{
    unit_id: number;
    start_date: string;
    end_date: string;
    provider: "stripe" | "square";
    guest_name: string;
    guest_email: string;
    guest_phone?: string;
    adults?: number;
    children?: number;
    notes?: string;
  }>();

  // 1. Re-quote + re-check availability server-side so the client
  //    can't fabricate a price or sneak past a conflict.
  const conflicts = await conflictsForUnit(c.env, body.unit_id, {
    start: body.start_date, end: body.end_date,
  });
  if (conflicts.length) return c.json({ error: "dates_unavailable" }, 409);

  let quote;
  try { quote = await quoteBooking(c.env, body.unit_id, body.start_date, body.end_date); }
  catch (e: unknown) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }

  // 2. Create a 'hold' booking that expires in 30 minutes.  This holds
  //    the dates against other booking attempts and gets promoted to
  //    'confirmed' by the payment webhook.  It appears in our outbound
  //    iCal feeds immediately so the other channels also block the
  //    dates during checkout.
  const uid = `direct-${crypto.randomUUID()}`;
  const holdExpires = new Date(Date.now() + 30 * 60_000).toISOString().replace("T", " ").slice(0, 19);
  const unitRow = await c.env.DB.prepare("SELECT name FROM units WHERE id = ?")
    .bind(body.unit_id).first<{ name: string }>();
  const unitName = unitRow?.name ?? `Unit ${body.unit_id}`;

  const ins = await c.env.DB.prepare(
    `INSERT INTO bookings
       (unit_id, source_platform, external_uid, status,
        start_date, end_date, guest_name, guest_email, guest_phone,
        adults, children, total_amount, currency, notes,
        hold_expires_at, payment_provider, payment_status,
        amount_cents, nights)
     VALUES (?, 'direct', ?, 'hold', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(
    body.unit_id, uid,
    body.start_date, body.end_date,
    body.guest_name, body.guest_email, body.guest_phone ?? null,
    body.adults ?? null, body.children ?? null,
    quote.amount_cents / 100, quote.currency, body.notes ?? null,
    holdExpires, body.provider,
    quote.amount_cents, quote.nights,
  ).run();
  const bookingId = Number(ins.meta.last_row_id);

  // 3. Create a payment session with the chosen provider.
  const base = c.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin;
  const description = `${unitName} - ${body.start_date} to ${body.end_date} (${quote.nights} nights)`;

  try {
    if (body.provider === "stripe") {
      const session = await createStripeCheckoutSession(c.env, {
        booking_id: bookingId,
        amount_cents: quote.amount_cents,
        currency: quote.currency,
        description,
        guest_email: body.guest_email,
        success_url: `${base}/book/success?session={CHECKOUT_SESSION_ID}&booking=${bookingId}`,
        cancel_url:  `${base}/book/cancel?booking=${bookingId}`,
      });
      await c.env.DB.prepare(
        "UPDATE bookings SET payment_session_id = ? WHERE id = ?"
      ).bind(session.id, bookingId).run();
      return c.json({ booking_id: bookingId, url: session.url });
    }
    if (body.provider === "square") {
      const link = await createSquarePaymentLink(c.env, {
        booking_id: bookingId,
        amount_cents: quote.amount_cents,
        currency: quote.currency,
        description,
        guest_email: body.guest_email,
        redirect_url: `${base}/book/success?booking=${bookingId}`,
      });
      await c.env.DB.prepare(
        "UPDATE bookings SET payment_session_id = ? WHERE id = ?"
      ).bind(link.order_id, bookingId).run();
      return c.json({ booking_id: bookingId, url: link.url });
    }
    return c.json({ error: "unknown provider" }, 400);
  } catch (e: unknown) {
    // Roll back the hold - the guest never got a chance to pay.
    await c.env.DB.prepare(
      "UPDATE bookings SET status = 'cancelled', payment_status = 'failed' WHERE id = ?"
    ).bind(bookingId).run();
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// Lookup a booking by payment session id (used by the success page).
app.get("/api/public/booking-by-session/:sid", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT b.id, b.status, b.payment_status, b.start_date, b.end_date,
            b.amount_cents, b.currency, u.name AS unit_name
       FROM bookings b JOIN units u ON u.id = b.unit_id
      WHERE b.payment_session_id = ?`
  ).bind(c.req.param("sid")).first();
  if (!row) return c.notFound();
  return c.json(row);
});

// Lookup a booking by its internal id.  Square redirects back to the
// success page without a session id in the URL, so the success page
// falls back to looking up by booking id.  Returns only non-sensitive
// fields.
app.get("/api/public/booking/:id", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT b.id, b.status, b.payment_status, b.start_date, b.end_date,
            b.amount_cents, b.currency, u.name AS unit_name
       FROM bookings b JOIN units u ON u.id = b.unit_id
      WHERE b.id = ?`
  ).bind(Number(c.req.param("id"))).first();
  if (!row) return c.notFound();
  return c.json(row);
});

// ---------- Webhooks ----------
app.post("/api/webhooks/stripe", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("stripe-signature") ?? null;
  const ok = await verifyStripeSignature(c.env, raw, sig);
  if (!ok) return c.json({ error: "bad signature" }, 400);
  const event = JSON.parse(raw);
  try { await handleStripeEvent(c.env, event); }
  catch (e: unknown) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return c.json({ received: true });
});

app.post("/api/webhooks/square", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-square-hmacsha256-signature") ?? null;
  const url = new URL(c.req.url).toString();
  const ok = await verifySquareSignature(c.env, raw, url, sig);
  if (!ok) return c.json({ error: "bad signature" }, 400);
  const event = JSON.parse(raw);
  try { await handleSquareEvent(c.env, event); }
  catch (e: unknown) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return c.json({ received: true });
});

// =========================================================================
// SEO-friendly booking pages (server-rendered with JSON-LD)
// =========================================================================
//
// These routes render full HTML documents with Schema.org VacationRental
// structured data baked in, so Google rich results can pick up the
// listings without running JavaScript.  /book.js still hydrates the
// interactive form on the detail page.
app.get("/book", async (c) => renderBookList(c.env, c.req.url));
app.get("/book/unit/:id", async (c) =>
  renderBookUnit(c.env, c.req.url, Number(c.req.param("id"))));
app.get("/book/success", async (c) =>
  renderSuccessPage(c.env, c.req.url,
    c.req.query("session") ?? null,
    c.req.query("booking") ?? null));
app.get("/book/cancel", async (c) => renderCancelPage(c.env, c.req.url));
app.get("/sitemap.xml", async (c) => renderSitemap(c.env, c.req.url));
app.get("/robots.txt", async (c) => renderRobots(c.env, c.req.url));

// Legacy: the first cut of the app served the booking SPA at
// /book.html.  Redirect to the canonical /book URL so search engines
// don't see duplicate content.
app.get("/book.html", (c) => c.redirect("/book", 301));

// ---------- Static UI fallback ----------
// The Assets binding serves /public.  With run_worker_first = true the
// Worker sees every request first; anything not handled above is
// delegated here.
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

async function expireStaleHolds(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE bookings
        SET status = 'cancelled', payment_status = 'expired', updated_at = datetime('now')
      WHERE status = 'hold'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at < datetime('now')`
  ).run();
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await expireStaleHolds(env);
      await pullAll(env);
    })());
  },
} satisfies ExportedHandler<Env>;
