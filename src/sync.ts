// Sync engine.
//
// pullListing(listing)     - pull remote iCal, upsert bookings, log result
// pullAll(env)             - pull every active listing (used by cron)
// createDirectBooking(...) - create a booking in our own system, which
//                            will propagate to other platforms on the
//                            next outbound feed read (iCal) or via
//                            future API push.

import type { Env, Listing, Platform } from "./types";
import { adapterFor, type PulledBooking } from "./platforms";

async function log(
  env: Env,
  listingId: number | null,
  direction: "pull" | "push",
  status: "ok" | "error",
  message: string,
  added = 0,
  updated = 0
) {
  await env.DB.prepare(
    "INSERT INTO sync_log (listing_id, direction, status, message, bookings_added, bookings_updated) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(listingId, direction, status, message, added, updated).run();
}

async function getPlatform(env: Env, platformId: number): Promise<Platform | null> {
  return env.DB.prepare("SELECT * FROM platforms WHERE id = ?")
    .bind(platformId).first<Platform>();
}

async function upsertPulledBookings(
  env: Env,
  listing: Listing,
  platformSlug: string,
  pulled: PulledBooking[]
): Promise<{ added: number; updated: number }> {
  let added = 0, updated = 0;
  for (const b of pulled) {
    const existing = await env.DB.prepare(
      "SELECT id FROM bookings WHERE source_platform = ? AND external_uid = ?"
    ).bind(platformSlug, b.external_uid).first<{ id: number }>();

    if (existing) {
      await env.DB.prepare(
        `UPDATE bookings
            SET start_date = ?, end_date = ?, status = ?, notes = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).bind(b.start_date, b.end_date, b.status ?? "confirmed", b.summary ?? null, existing.id).run();
      updated++;
    } else {
      await env.DB.prepare(
        `INSERT INTO bookings
           (unit_id, listing_id, source_platform, external_uid, status,
            start_date, end_date, notes, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        listing.unit_id,
        listing.id,
        platformSlug,
        b.external_uid,
        b.status ?? "confirmed",
        b.start_date,
        b.end_date,
        b.summary ?? null,
        JSON.stringify(b),
      ).run();
      added++;
    }
  }
  return { added, updated };
}

export async function pullListing(env: Env, listing: Listing): Promise<{ added: number; updated: number }> {
  const platform = await getPlatform(env, listing.platform_id);
  if (!platform) throw new Error("platform not found");
  const adapter = adapterFor(platform.slug);

  try {
    const pulled = await adapter.pull(env, listing, platform);
    const result = await upsertPulledBookings(env, listing, platform.slug, pulled);
    await env.DB.prepare(
      "UPDATE listings SET last_pulled_at = datetime('now'), last_error = NULL WHERE id = ?"
    ).bind(listing.id).run();
    await log(env, listing.id, "pull", "ok", `pulled ${pulled.length}`, result.added, result.updated);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await env.DB.prepare(
      "UPDATE listings SET last_error = ? WHERE id = ?"
    ).bind(msg, listing.id).run();
    await log(env, listing.id, "pull", "error", msg);
    throw err;
  }
}

export async function pullAll(env: Env): Promise<void> {
  const res = await env.DB.prepare(
    `SELECT * FROM listings
      WHERE status = 'active'
        AND ical_import_url IS NOT NULL
        AND ical_import_url != ''`
  ).all<Listing>();
  for (const listing of res.results) {
    try { await pullListing(env, listing); }
    catch (e) { /* already logged */ }
  }
}

export interface DirectBookingInput {
  unit_id: number;
  start_date: string;
  end_date: string;
  guest_name?: string;
  guest_email?: string;
  guest_phone?: string;
  adults?: number;
  children?: number;
  total_amount?: number;
  currency?: string;
  notes?: string;
}

export async function createDirectBooking(env: Env, input: DirectBookingInput): Promise<number> {
  // Generate a stable UID for our outbound feed.
  const uid = `direct-${crypto.randomUUID()}`;
  const res = await env.DB.prepare(
    `INSERT INTO bookings
       (unit_id, listing_id, source_platform, external_uid, status,
        start_date, end_date, guest_name, guest_email, guest_phone,
        adults, children, total_amount, currency, notes)
     VALUES (?, NULL, 'direct', ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.unit_id, uid,
    input.start_date, input.end_date,
    input.guest_name ?? null, input.guest_email ?? null, input.guest_phone ?? null,
    input.adults ?? null, input.children ?? null,
    input.total_amount ?? null, input.currency ?? null,
    input.notes ?? null
  ).run();
  return Number(res.meta.last_row_id);
}
