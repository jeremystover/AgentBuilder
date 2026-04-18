/**
 * P&L (profit & loss) routes — light bookkeeping per entity.
 *
 * Three endpoints:
 *   - GET /pnl              — income statement for a single entity
 *   - GET /pnl/all          — all four entities (elyse_coaching,
 *                             jeremy_coaching, airbnb_activity,
 *                             family_personal) side by side
 *   - GET /pnl/trend        — monthly totals for an entity across N months
 *
 * Sign convention: the DB stores expenses as NEGATIVE and income as
 * POSITIVE (Teller-native; Chase/Venmo importers normalize to match).
 * We group by sign, then drill down by category_tax for a readable
 * income statement. `net_income = income + expenses` (expenses are
 * already negative, so adding gives you the right answer).
 *
 * Period resolution is shared with `/budget/status` via lib/budget.ts —
 * same preset names, same `{start,end,days,label}` shape.
 */

import type { Env } from '../types';
import { getUserId, jsonError, jsonOk } from '../types';
import { resolvePeriod, type ResolvedPeriod } from '../lib/budget';

const ENTITIES = ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'] as const;
type Entity = typeof ENTITIES[number];

interface CategoryLine {
  category_tax: string | null;
  category_name: string | null;
  total: number;
  tx_count: number;
}

interface EntityPnL {
  entity: Entity;
  period: ResolvedPeriod;
  income: {
    total: number;
    categories: CategoryLine[];
  };
  expenses: {
    /** Positive dollar amount (sign flipped from DB for readability). */
    total: number;
    categories: CategoryLine[];
  };
  net_income: number;
  tx_count: number;
  pending_review: number;
}

function isEntity(value: unknown): value is Entity {
  return typeof value === 'string' && (ENTITIES as readonly string[]).includes(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Core aggregator: pulls category totals for an entity in a period and
 * groups them into income / expenses by sign.
 *
 * Only counts classified, non-review-required transactions so numbers
 * match what the user has already confirmed. Unreviewed count is
 * returned separately so the caller can surface "N items still need
 * review" alongside the totals.
 */
async function computeEntityPnL(
  env: Env,
  userId: string,
  entity: Entity,
  period: ResolvedPeriod,
): Promise<EntityPnL> {
  // Category totals, scoped to this entity and to the entity's chart of
  // accounts if one exists. LEFT JOIN so family_personal (no COA) still
  // returns rows with null category_name.
  const coaSlug =
    entity === 'elyse_coaching'   ? 'elyse_coaching'  :
    entity === 'jeremy_coaching'  ? 'jeremy_coaching'  :
    entity === 'airbnb_activity'  ? 'airbnb'           :
    null;

  const totals = await env.DB.prepare(
    `SELECT c.category_tax,
            coa.name AS category_name,
            SUM(t.amount) AS total,
            COUNT(*) AS tx_count
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     LEFT JOIN chart_of_accounts coa
       ON coa.code = c.category_tax
      AND coa.business_entity_id = (
        SELECT id FROM business_entities WHERE user_id = ? AND slug = ? LIMIT 1
      )
     WHERE t.user_id = ?
       AND c.entity = ?
       AND c.review_required = 0
       AND t.posted_date BETWEEN ? AND ?
     GROUP BY c.category_tax, coa.name
     ORDER BY total DESC`,
  ).bind(userId, coaSlug, userId, entity, period.start, period.end)
   .all<{ category_tax: string | null; category_name: string | null; total: number; tx_count: number }>();

  const incomeCats: CategoryLine[] = [];
  const expenseCats: CategoryLine[] = [];
  let incomeTotal = 0;
  let expenseTotal = 0; // accumulates as negative, flipped at the end
  let txCount = 0;

  for (const row of totals.results) {
    txCount += row.tx_count;
    if (row.total >= 0) {
      incomeCats.push({
        category_tax: row.category_tax,
        category_name: row.category_name,
        total: round2(row.total),
        tx_count: row.tx_count,
      });
      incomeTotal += row.total;
    } else {
      expenseCats.push({
        category_tax: row.category_tax,
        category_name: row.category_name,
        total: round2(-row.total), // flip to positive dollars for readability
        tx_count: row.tx_count,
      });
      expenseTotal += row.total;
    }
  }

  // Re-sort expenses by magnitude (descending) since we flipped signs.
  expenseCats.sort((a, b) => b.total - a.total);
  // Income already sorted descending by raw total (which is positive).

  // Count still-pending classifications inside the period so the caller
  // can show "$X confirmed so far, Y transactions still need review".
  const pendingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     WHERE t.user_id = ?
       AND c.entity = ?
       AND c.review_required = 1
       AND t.posted_date BETWEEN ? AND ?`,
  ).bind(userId, entity, period.start, period.end).first<{ cnt: number }>();

  return {
    entity,
    period,
    income:   { total: round2(incomeTotal),  categories: incomeCats },
    expenses: { total: round2(-expenseTotal), categories: expenseCats },
    net_income: round2(incomeTotal + expenseTotal), // expenses are negative
    tx_count: txCount,
    pending_review: pendingRow?.cnt ?? 0,
  };
}

// ── GET /pnl ──────────────────────────────────────────────────────────────────
// Query params:
//   ?entity=elyse_coaching|jeremy_coaching|airbnb_activity|family_personal   (required)
//   ?preset=this_month|last_month|ytd|trailing_30d|...          (default this_month)
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD                            (overrides preset)
export async function handlePnL(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);

  const entity = url.searchParams.get('entity');
  if (!isEntity(entity)) {
    return jsonError(
      `entity query param must be one of: ${ENTITIES.join(', ')}`,
    );
  }

  let period;
  try {
    period = resolvePeriod({
      preset: url.searchParams.get('preset') ?? undefined,
      start: url.searchParams.get('start') ?? undefined,
      end: url.searchParams.get('end') ?? undefined,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err));
  }

  const pnl = await computeEntityPnL(env, userId, entity, period);
  return jsonOk(pnl);
}

// ── GET /pnl/all ──────────────────────────────────────────────────────────────
// Returns the P&L for all three entities at once, plus a consolidated line.
// Useful for "how did I do this month?" at a glance.
export async function handlePnLAll(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);

  let period;
  try {
    period = resolvePeriod({
      preset: url.searchParams.get('preset') ?? undefined,
      start: url.searchParams.get('start') ?? undefined,
      end: url.searchParams.get('end') ?? undefined,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err));
  }

  const entities = await Promise.all(
    ENTITIES.map((e) => computeEntityPnL(env, userId, e, period)),
  );

  const consolidated = {
    income:     round2(entities.reduce((s, e) => s + e.income.total, 0)),
    expenses:   round2(entities.reduce((s, e) => s + e.expenses.total, 0)),
    net_income: round2(entities.reduce((s, e) => s + e.net_income, 0)),
    tx_count:   entities.reduce((s, e) => s + e.tx_count, 0),
    pending_review: entities.reduce((s, e) => s + e.pending_review, 0),
  };

  return jsonOk({
    period: { start: period.start, end: period.end, days: period.days, label: period.label },
    entities,
    consolidated,
  });
}

// ── GET /pnl/trend ────────────────────────────────────────────────────────────
// Monthly income/expense/net for an entity, most recent `months` (default 6).
// Always month-bucketed regardless of whether the current month is partial.
export async function handlePnLTrend(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);

  const entity = url.searchParams.get('entity');
  if (!isEntity(entity)) {
    return jsonError(
      `entity query param must be one of: ${ENTITIES.join(', ')}`,
    );
  }

  const monthsRaw = parseInt(url.searchParams.get('months') ?? '6', 10);
  const months = Number.isFinite(monthsRaw) ? Math.max(1, Math.min(36, monthsRaw)) : 6;

  // Compute window: from the first day of (current month - months + 1)
  // through today. Monthly buckets via substr(posted_date, 1, 7).
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const startDate = new Date(Date.UTC(y, m - (months - 1), 1));
  const endDate = new Date(Date.UTC(y, m + 1, 0)); // end of current month
  const start = startDate.toISOString().slice(0, 10);
  const end = endDate.toISOString().slice(0, 10);

  // Pull monthly aggregates already split by sign so we don't post-process
  // a huge result set in JS.
  const rows = await env.DB.prepare(
    `SELECT substr(t.posted_date, 1, 7) AS month,
            SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END) AS income,
            SUM(CASE WHEN t.amount <  0 THEN -t.amount ELSE 0 END) AS expenses,
            SUM(t.amount) AS net_income,
            COUNT(*) AS tx_count
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     WHERE t.user_id = ?
       AND c.entity = ?
       AND c.review_required = 0
       AND t.posted_date BETWEEN ? AND ?
     GROUP BY month
     ORDER BY month`,
  ).bind(userId, entity, start, end)
   .all<{ month: string; income: number; expenses: number; net_income: number; tx_count: number }>();

  // Fill in zero-rows for months with no activity so the caller gets a
  // dense series suitable for plotting / "what's my run rate" reasoning.
  const byMonth = new Map<string, { income: number; expenses: number; net_income: number; tx_count: number }>();
  for (const r of rows.results) {
    byMonth.set(r.month, {
      income: round2(r.income ?? 0),
      expenses: round2(r.expenses ?? 0),
      net_income: round2(r.net_income ?? 0),
      tx_count: r.tx_count ?? 0,
    });
  }

  const series: Array<{ month: string; income: number; expenses: number; net_income: number; tx_count: number }> = [];
  for (let i = 0; i < months; i++) {
    const monthDate = new Date(Date.UTC(y, m - (months - 1) + i, 1));
    const key = monthDate.toISOString().slice(0, 7);
    series.push({
      month: key,
      ...(byMonth.get(key) ?? { income: 0, expenses: 0, net_income: 0, tx_count: 0 }),
    });
  }

  const avg = (sel: (r: { income: number; expenses: number; net_income: number }) => number) =>
    round2(series.reduce((s, r) => s + sel(r), 0) / Math.max(1, series.length));

  return jsonOk({
    entity,
    months,
    window: { start, end },
    series,
    averages: {
      monthly_income:   avg((r) => r.income),
      monthly_expenses: avg((r) => r.expenses),
      monthly_net:      avg((r) => r.net_income),
    },
  });
}
