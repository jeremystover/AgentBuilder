/**
 * Cash-flow forecasting — turn a plan into period-by-period income,
 * expenses, net, and one-time items.
 *
 * Heavy lifting lives in plan-resolver.ts. This module wraps it in a
 * bucketed view and folds in one-time items.
 *
 * The system has no explicit income flag on categories, so we infer
 * direction from the category's slug/name. Coaching revenue, rental
 * income, salary, dividends, interest, royalties are treated as
 * income; everything else is an expense.
 */

import type { Sql } from './db';
import { resolvePlan } from './plan-resolver';

export interface ForecastOneTime {
  id: string;
  name: string;
  type: 'expense' | 'income';
  amount: number;
  date: string;
  category_id: string | null;
}

export interface ForecastPeriod {
  period_start: string;
  period_end:   string;
  label: string;
  period_type: 'month' | 'year';
  total_income:   number;
  total_expenses: number;
  net:            number;
  one_time_items: ForecastOneTime[];
}

const INCOME_PATTERN = /income|salary|wage|rent|dividend|interest|revenue|royalty|coaching/i;

export function isIncomeSlugOrName(slug: string | null, name: string | null): boolean {
  return INCOME_PATTERN.test(`${slug ?? ''} ${name ?? ''}`);
}

export async function generateForecast(
  sql: Sql,
  planId: string,
  from: Date,
  to: Date,
  periodType: 'monthly' | 'annual',
): Promise<ForecastPeriod[]> {
  if (to.getTime() < from.getTime()) return [];

  const categories = await sql<Array<{ id: string; name: string; slug: string }>>`
    SELECT id, name, slug FROM categories
  `;
  const categoryById = new Map(categories.map(c => [c.id, c] as const));

  const oneTimeRows = await sql<Array<{
    id: string; name: string; type: 'expense' | 'income';
    item_date: string; amount: string; category_id: string | null;
  }>>`
    SELECT id, name, type,
           to_char(item_date, 'YYYY-MM-DD') AS item_date,
           amount::text AS amount,
           category_id
    FROM plan_one_time_items
    WHERE plan_id = ${planId}
      AND item_date BETWEEN ${iso(from)} AND ${iso(to)}
    ORDER BY item_date
  `;

  const buckets = generateBuckets(from, to, periodType);
  const out: ForecastPeriod[] = [];

  for (const bucket of buckets) {
    const resolved = await resolvePlan(sql, planId, bucket.start);
    let income = 0;
    let expense = 0;

    for (const [catId, amt] of resolved.entries()) {
      const cat = categoryById.get(catId);
      const isIncome = isIncomeSlugOrName(cat?.slug ?? null, cat?.name ?? null);
      const periodAmount = scaleMonthly(amt.monthly_amount, bucket.start, bucket.end, periodType);
      if (isIncome) income += periodAmount;
      else expense += periodAmount;
    }

    const items: ForecastOneTime[] = [];
    for (const row of oneTimeRows) {
      const d = new Date(`${row.item_date}T00:00:00Z`);
      if (d.getTime() >= bucket.start.getTime() && d.getTime() <= bucket.end.getTime()) {
        const amount = Number(row.amount);
        items.push({
          id: row.id, name: row.name, type: row.type, amount,
          date: row.item_date, category_id: row.category_id,
        });
        if (row.type === 'income') income += amount;
        else expense += amount;
      }
    }

    out.push({
      period_start: iso(bucket.start),
      period_end:   iso(bucket.end),
      label: bucket.label,
      period_type: periodType === 'monthly' ? 'month' : 'year',
      total_income:   round(income),
      total_expenses: round(expense),
      net:            round(income - expense),
      one_time_items: items,
    });
  }

  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function round(n: number): number { return Math.round(n * 100) / 100; }

function generateBuckets(
  from: Date, to: Date, periodType: 'monthly' | 'annual',
): Array<{ start: Date; end: Date; label: string }> {
  const out: Array<{ start: Date; end: Date; label: string }> = [];
  if (periodType === 'monthly') {
    let y = from.getUTCFullYear(); let m = from.getUTCMonth();
    while (true) {
      const start = new Date(Date.UTC(y, m, 1));
      if (start.getTime() > to.getTime()) break;
      const end = new Date(Date.UTC(y, m + 1, 0));
      const bucketStart = start.getTime() < from.getTime() ? from : start;
      const bucketEnd   = end.getTime() > to.getTime() ? to : end;
      out.push({ start: bucketStart, end: bucketEnd, label: `${MONTH[m]} ${y}` });
      m++; if (m === 12) { m = 0; y++; }
    }
    return out;
  }
  let y = from.getUTCFullYear();
  while (true) {
    const start = new Date(Date.UTC(y, 0, 1));
    if (start.getTime() > to.getTime()) break;
    const end = new Date(Date.UTC(y, 11, 31));
    const bucketStart = start.getTime() < from.getTime() ? from : start;
    const bucketEnd   = end.getTime() > to.getTime() ? to : end;
    out.push({ start: bucketStart, end: bucketEnd, label: String(y) });
    y++;
  }
  return out;
}

const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function scaleMonthly(
  monthlyAmount: number, start: Date, end: Date, periodType: 'monthly' | 'annual',
): number {
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (periodType === 'monthly') {
    const monthDays = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    if (start.getUTCDate() === 1 && days === monthDays) return monthlyAmount;
    return (monthlyAmount / monthDays) * days;
  }
  // annual bucket: 12 months unless partial
  if (days >= 365) return monthlyAmount * 12;
  return (monthlyAmount / 30) * days;
}
