// Nightly price calculator.
//
// Rules, simple by design:
//   * For each night from check-in (inclusive) to checkout (exclusive),
//     use the rate_override price if one exists for that unit + date,
//     otherwise fall back to unit.base_price.
//   * Cleaning fee is added once per booking.
//   * min_nights is enforced: shorter stays are rejected.
//   * A unit with no base_price configured can't be quoted.
//
// Returns integer cents because every downstream payment processor
// (Stripe, Square) wants integer minor units.

import type { Env, Unit } from "./types";

export interface Quote {
  unit_id: number;
  start_date: string;
  end_date: string;
  nights: number;
  nightly_total_cents: number;
  cleaning_fee_cents: number;
  amount_cents: number;
  currency: string;
  per_night: Array<{ date: string; cents: number }>;
}

function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  for (let d = a; d < b; d = new Date(d.getTime() + 86400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export async function quoteBooking(
  env: Env,
  unit_id: number,
  start_date: string,
  end_date: string
): Promise<Quote> {
  const unit = await env.DB.prepare("SELECT * FROM units WHERE id = ?")
    .bind(unit_id).first<Unit>();
  if (!unit) throw new Error("unit not found");
  if (unit.base_price == null) throw new Error("unit has no base_price");

  const dates = dateRange(start_date, end_date);
  if (dates.length === 0) throw new Error("end_date must be after start_date");
  if (unit.min_nights && dates.length < unit.min_nights) {
    throw new Error(`minimum stay is ${unit.min_nights} nights`);
  }

  // Pull any per-date overrides at once.
  const placeholders = dates.map(() => "?").join(",");
  const overrides = await env.DB.prepare(
    `SELECT date, price, blocked FROM rate_overrides
      WHERE unit_id = ? AND date IN (${placeholders})`
  ).bind(unit_id, ...dates).all<{ date: string; price: number | null; blocked: number }>();
  const byDate = new Map<string, { price: number | null; blocked: number }>();
  for (const r of overrides.results) byDate.set(r.date, r);

  const per_night: Array<{ date: string; cents: number }> = [];
  let nightlyTotal = 0;
  for (const d of dates) {
    const o = byDate.get(d);
    if (o?.blocked) throw new Error(`date ${d} is blocked`);
    const nightly = o?.price ?? unit.base_price;
    const cents = toCents(nightly);
    per_night.push({ date: d, cents });
    nightlyTotal += cents;
  }
  const cleaning = toCents(unit.cleaning_fee ?? 0);

  return {
    unit_id,
    start_date,
    end_date,
    nights: dates.length,
    nightly_total_cents: nightlyTotal,
    cleaning_fee_cents: cleaning,
    amount_cents: nightlyTotal + cleaning,
    currency: (env.DEFAULT_CURRENCY ?? "USD").toUpperCase(),
    per_night,
  };
}
