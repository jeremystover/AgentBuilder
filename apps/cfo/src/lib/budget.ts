/**
 * Budget helpers: seeding, period resolution, and pro-rated target math.
 *
 * The goal is "how am I doing" comparisons that stay meaningful across
 * mismatched cadences — if you budget $600/month for groceries and ask
 * for a weekly status, we scale the target to `600 * (7 / 30.4375)`
 * rather than comparing a weekly spend to a monthly cap.
 */

import type { Env } from '../types';
import { FAMILY_CATEGORIES } from '../types';

export type Cadence = 'weekly' | 'monthly' | 'annual';

export interface ResolvedPeriod {
  start: string; // ISO date (YYYY-MM-DD)
  end: string;   // ISO date, inclusive
  days: number;
  label: string;
}

// Average days per period, used for pro-rating across mismatched cadences.
// 365.25 / 12 ≈ 30.4375 captures leap years without special-casing February.
export const DAYS_PER_PERIOD: Record<Cadence, number> = {
  weekly: 7,
  monthly: 365.25 / 12,
  annual: 365.25,
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysBetweenInclusive(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Resolve a period descriptor into concrete start/end dates.
 * Accepts:
 *   - { preset: 'this_week' | 'this_month' | 'last_month' | 'ytd' | 'trailing_30d' | 'trailing_90d' }
 *   - { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
 * Default if nothing passed: this_month.
 */
export function resolvePeriod(
  period: { preset?: string; start?: string; end?: string } | undefined,
  now: Date = new Date(),
): ResolvedPeriod {
  if (period?.start && period?.end) {
    const startDate = parseDateOrNull(period.start);
    const endDate = parseDateOrNull(period.end);
    if (!startDate || !endDate || startDate > endDate) {
      throw new Error(`Invalid period range: ${period.start}..${period.end}`);
    }
    return {
      start: period.start,
      end: period.end,
      days: daysBetweenInclusive(startDate, endDate),
      label: `${period.start}..${period.end}`,
    };
  }

  const preset = period?.preset ?? 'this_month';
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDay = now.getUTCDate();
  const today = new Date(Date.UTC(utcYear, utcMonth, utcDay));

  switch (preset) {
    case 'this_week': {
      // ISO-ish: week starts Monday.
      const dow = (today.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - dow);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
      return { start: isoDate(start), end: isoDate(end), days: 7, label: 'this_week' };
    }
    case 'this_month': {
      const start = new Date(Date.UTC(utcYear, utcMonth, 1));
      const end = new Date(Date.UTC(utcYear, utcMonth + 1, 0));
      return { start: isoDate(start), end: isoDate(end), days: daysBetweenInclusive(start, end), label: 'this_month' };
    }
    case 'last_month': {
      const start = new Date(Date.UTC(utcYear, utcMonth - 1, 1));
      const end = new Date(Date.UTC(utcYear, utcMonth, 0));
      return { start: isoDate(start), end: isoDate(end), days: daysBetweenInclusive(start, end), label: 'last_month' };
    }
    case 'ytd': {
      const start = new Date(Date.UTC(utcYear, 0, 1));
      return { start: isoDate(start), end: isoDate(today), days: daysBetweenInclusive(start, today), label: 'ytd' };
    }
    case 'trailing_30d': {
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - 29);
      return { start: isoDate(start), end: isoDate(today), days: 30, label: 'trailing_30d' };
    }
    case 'trailing_90d': {
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - 89);
      return { start: isoDate(start), end: isoDate(today), days: 90, label: 'trailing_90d' };
    }
    default:
      throw new Error(`Unknown period preset: ${preset}`);
  }
}

/**
 * Scale a target amount from its native cadence to a given period length.
 * Example: $600/month target + 7-day period → $600 * (7 / 30.4375) ≈ $138.
 */
export function prorateTarget(amount: number, cadence: Cadence, periodDays: number): number {
  return (amount * periodDays) / DAYS_PER_PERIOD[cadence];
}

/**
 * Seed budget_categories with FAMILY_CATEGORIES defaults if the user has
 * no categories yet. Idempotent — no-op on subsequent calls.
 */
export async function ensureDefaultBudgetCategories(env: Env, userId: string): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM budget_categories WHERE user_id = ?`,
  ).bind(userId).first<{ total: number }>();

  if ((existing?.total ?? 0) > 0) return;

  for (const [slug, name] of Object.entries(FAMILY_CATEGORIES)) {
    await env.DB.prepare(
      `INSERT INTO budget_categories (id, user_id, slug, name, is_active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(user_id, slug) DO NOTHING`,
    ).bind(crypto.randomUUID(), userId, slug, name).run();
  }
}
