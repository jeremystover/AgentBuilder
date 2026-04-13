// Unit availability / conflict engine.
//
// Booking on ANY unit (atomic or composite) is expanded into occupancy
// across its atomic members.  To determine whether a *target unit* is
// available we check whether any of its atomic members are occupied by
// some other booking for the overlapping date range.
//
// This lets us sell a room individually, as part of a 3BR, or as the
// full 4BR house while guaranteeing no physical double-booking.

import type { Env } from "./types";

export interface DateRange { start: string; end: string; } // end exclusive

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Return the set of atomic unit ids a given unit occupies. */
export async function atomicMembersOf(env: Env, unitId: number): Promise<number[]> {
  const unit = await env.DB.prepare("SELECT kind FROM units WHERE id = ?")
    .bind(unitId)
    .first<{ kind: string }>();
  if (!unit) return [];
  if (unit.kind === "atomic") return [unitId];
  const rows = await env.DB.prepare(
    "SELECT atomic_unit_id AS id FROM unit_components WHERE composite_unit_id = ?"
  ).bind(unitId).all<{ id: number }>();
  return rows.results.map(r => r.id);
}

/** Inverse lookup: every unit (atomic or composite) that contains a given atomic. */
export async function unitsContainingAtomic(env: Env, atomicId: number): Promise<number[]> {
  const ids = new Set<number>([atomicId]);
  const rows = await env.DB.prepare(
    "SELECT composite_unit_id AS id FROM unit_components WHERE atomic_unit_id = ?"
  ).bind(atomicId).all<{ id: number }>();
  for (const r of rows.results) ids.add(r.id);
  return [...ids];
}

/**
 * Fetch all bookings (non-cancelled) that intersect the given range for
 * any atomic member of the given unit - i.e. every booking that would
 * physically block `unitId`.
 */
export async function conflictsForUnit(
  env: Env,
  unitId: number,
  range: DateRange,
  excludeBookingId?: number
): Promise<Array<{ id: number; unit_id: number; start_date: string; end_date: string; source_platform: string }>> {
  const atomics = await atomicMembersOf(env, unitId);
  if (atomics.length === 0) return [];
  // Every unit whose atomic members overlap with ours would also be
  // counted as blocking.  Build the full blocker unit set.
  const blockers = new Set<number>();
  for (const a of atomics) for (const u of await unitsContainingAtomic(env, a)) blockers.add(u);

  const placeholders = [...blockers].map(() => "?").join(",");
  const sql = `
    SELECT id, unit_id, start_date, end_date, source_platform
      FROM bookings
     WHERE status != 'cancelled'
       AND (status != 'hold' OR hold_expires_at IS NULL OR hold_expires_at > datetime('now'))
       AND unit_id IN (${placeholders})
       AND start_date < ?
       AND end_date > ?
       ${excludeBookingId ? "AND id != ?" : ""}
     ORDER BY start_date`;
  const binds: unknown[] = [...blockers, range.end, range.start];
  if (excludeBookingId) binds.push(excludeBookingId);
  const res = await env.DB.prepare(sql).bind(...binds).all<{
    id: number; unit_id: number; start_date: string; end_date: string; source_platform: string;
  }>();
  return res.results;
}

/** Is the given unit fully available for the requested range? */
export async function isUnitAvailable(env: Env, unitId: number, range: DateRange): Promise<boolean> {
  const c = await conflictsForUnit(env, unitId, range);
  return c.length === 0;
}

/**
 * Build the list of "blocked" date ranges for a given unit - this is what
 * we serialize into the outgoing iCal feed for each listing.  It's the
 * union of every booking on any unit whose atomic members overlap ours,
 * plus manual rate_overrides.blocked = 1 entries.
 */
export async function blockedRangesForUnit(
  env: Env,
  unitId: number,
  horizonDays = 540
): Promise<Array<{ uid: string; start: string; end: string; summary: string; description: string }>> {
  const atomics = await atomicMembersOf(env, unitId);
  if (atomics.length === 0) return [];
  const blockers = new Set<number>();
  for (const a of atomics) for (const u of await unitsContainingAtomic(env, a)) blockers.add(u);

  const today = new Date(); today.setUTCHours(0,0,0,0);
  const horizon = new Date(today.getTime() + horizonDays * 86400_000);
  const todayStr = today.toISOString().slice(0,10);
  const horizonStr = horizon.toISOString().slice(0,10);

  const placeholders = [...blockers].map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT id, unit_id, start_date, end_date, source_platform, guest_name
      FROM bookings
     WHERE status != 'cancelled'
       AND (status != 'hold' OR hold_expires_at IS NULL OR hold_expires_at > datetime('now'))
       AND unit_id IN (${placeholders})
       AND end_date > ?
       AND start_date < ?`
  ).bind(...blockers, todayStr, horizonStr).all<{
    id: number; unit_id: number; start_date: string; end_date: string;
    source_platform: string; guest_name: string | null;
  }>();

  return rows.results.map(b => ({
    uid: `bsm-${b.id}@booking-sync`,
    start: b.start_date,
    end: b.end_date,
    // We intentionally avoid leaking guest PII into the outgoing feed.
    // Platforms only need to know the dates are unavailable.
    summary: "Blocked",
    description: `Synced from ${b.source_platform}`,
  }));
}
