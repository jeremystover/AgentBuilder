/**
 * Spending report engine — Module 4.
 *
 * Given a date range, plan selection, entity filter, and category /
 * category-group selection, produces:
 *   - per-period actuals from approved transactions
 *   - per-period planned amounts (pro-rated) from selected plan(s)
 *   - per-period projected actuals (future buckets only)
 *   - delta (single-plan only)
 *   - unreviewed-transaction count over the same date range
 *
 * Categories and aggregated groups appear as sibling rows (groups have
 * `is_group=true` and the category_id field holds the group id; their
 * member categories are queried as a single aggregate).
 */

import { type Sql, pgArr } from './db';
import { generatePeriods, prorateAmount, type PeriodType } from './prorate';
import { resolvePlan } from './plan-resolver';

export interface PlanMeta {
  id: string;
  name: string;
  is_active: boolean;
  status: string;
}

export interface Period {
  start: string;  // YYYY-MM-DD
  end:   string;  // YYYY-MM-DD
  label: string;
  is_future: boolean;
}

export interface CategoryRow {
  category_id: string;
  category_name: string;
  is_group: boolean;
  member_ids: string[];          // categories that compose this row
  periods: Array<{
    actual:    number | null;    // null if future
    planned:   number;           // pro-rated plan amount (primary plan)
    plans:     number[];         // per-plan pro-rated amount, in plan order
    delta:     number | null;    // null if multi-plan or future
    projected: number | null;    // null if past
  }>;
  total_actual:  number;
  total_planned: number;
  total_delta:   number | null;
}

export interface SummaryCards {
  total_spent:           number;
  total_planned_to_date: number | null;
  delta_to_date:         number | null;
  delta_to_date_pct:     number | null;
  projected_end_total:   number | null;
  plan_end_total:        number | null;
  projected_delta:       number | null;
}

export interface SpendingReport {
  date_range: { from: string; to: string };
  period_type: PeriodType;
  periods:  Period[];
  categories: CategoryRow[];
  summary:  SummaryCards;
  unreviewed_count: number;
  plans:    PlanMeta[];
}

interface BuildParams {
  planIds:     string[];
  dateFrom:    Date;
  dateTo:      Date;
  entityIds:   string[];
  categoryIds: string[];
  groupIds:    string[];
  periodType:  PeriodType;
  today?:      Date;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function buildSpendingReport(sql: Sql, params: BuildParams): Promise<SpendingReport> {
  const today = params.today ?? new Date();
  const periods = generatePeriods(params.dateFrom, params.dateTo, params.periodType, today);

  // ── Resolve groups → member category lists, build the row skeleton. ─────
  const groupRows = params.groupIds.length === 0
    ? []
    : await sql<Array<{ id: string; name: string; member_id: string }>>`
        SELECT g.id, g.name, m.category_id AS member_id
        FROM category_groups g
        LEFT JOIN category_group_members m ON m.group_id = g.id
        WHERE g.id = ANY(${pgArr(params.groupIds)}::text[])
        ORDER BY g.name, m.category_id
      `;
  const groupNameById = new Map<string, string>();
  const groupMembers = new Map<string, string[]>();
  for (const row of groupRows) {
    groupNameById.set(row.id, row.name);
    if (!groupMembers.has(row.id)) groupMembers.set(row.id, []);
    if (row.member_id) groupMembers.get(row.id)!.push(row.member_id);
  }

  const catRows = params.categoryIds.length === 0
    ? []
    : await sql<Array<{ id: string; name: string }>>`
        SELECT id, name FROM categories WHERE id = ANY(${pgArr(params.categoryIds)}::text[]) ORDER BY name
      `;

  // Track every category id referenced (for filtering transaction queries).
  const allCategoryIds = new Set<string>();
  for (const c of catRows) allCategoryIds.add(c.id);
  for (const members of groupMembers.values()) for (const id of members) allCategoryIds.add(id);

  // ── Load plan rows (used in both header + per-row math). ────────────────
  const plans = params.planIds.length === 0
    ? []
    : await sql<Array<{ id: string; name: string; status: string; is_active: boolean }>>`
        SELECT id, name, status, is_active FROM plans WHERE id = ANY(${pgArr(params.planIds)}::text[])
      `;
  const planMeta: PlanMeta[] = params.planIds.map(id => {
    const found = plans.find(p => p.id === id);
    return {
      id,
      name: found?.name ?? 'Unknown plan',
      status: found?.status ?? 'unknown',
      is_active: found?.is_active ?? false,
    };
  });

  // Resolve each plan's effective amounts as of the report's start date.
  // Mid-range adjustments are intentionally not re-resolved per bucket —
  // for sharper resolution use a shorter range.
  const planAmountByPlanCat = new Map<string, Map<string, { amount: number; periodType: PeriodType }>>();
  for (const planId of params.planIds) {
    const resolved = await resolvePlan(sql, planId, params.dateFrom);
    const inner = new Map<string, { amount: number; periodType: PeriodType }>();
    for (const [catId, row] of resolved.entries()) {
      if (!allCategoryIds.has(catId)) continue;
      inner.set(catId, { amount: row.amount, periodType: row.period_type });
    }
    planAmountByPlanCat.set(planId, inner);
  }

  // ── Pull actuals: GROUP BY (category, period bucket). ───────────────────
  const txRows = allCategoryIds.size === 0
    ? []
    : await sql<Array<{ category_id: string; period_start: string; total: string }>>`
        SELECT
          t.category_id,
          to_char(
            ${params.periodType === 'monthly'
              ? sql`date_trunc('month', t.date)`
              : sql`date_trunc('year',  t.date)`},
            'YYYY-MM-DD') AS period_start,
          SUM(t.amount)::text AS total
        FROM transactions t
        WHERE t.status = 'approved'
          AND t.date BETWEEN ${iso(params.dateFrom)} AND ${iso(params.dateTo)}
          AND t.category_id = ANY(${pgArr([...allCategoryIds])}::text[])
          ${params.entityIds.length > 0 ? sql`AND t.entity_id = ANY(${pgArr(params.entityIds)}::text[])` : sql``}
        GROUP BY t.category_id, period_start
      `;
  // actualByCatBucket[categoryId][bucketStartISO] = number
  const actualByCatBucket = new Map<string, Map<string, number>>();
  for (const row of txRows) {
    const cat = actualByCatBucket.get(row.category_id) ?? new Map<string, number>();
    cat.set(row.period_start, Number(row.total));
    actualByCatBucket.set(row.category_id, cat);
  }

  // ── Unreviewed alert: raw_transactions in range, status != processed,
  //    and not yet approved. We mirror Module 2's notion of "not yet
  //    reviewed" as raw rows whose status is staged or waiting. ─────────
  const unreviewedRows = await sql<Array<{ ct: string }>>`
    SELECT COUNT(*)::text AS ct
    FROM raw_transactions
    WHERE date BETWEEN ${iso(params.dateFrom)} AND ${iso(params.dateTo)}
      AND status IN ('staged', 'waiting')
  `;
  const unreviewedCount = Number(unreviewedRows[0]?.ct ?? 0);

  // ── Build rows ──────────────────────────────────────────────────────────
  const primaryPlanId = params.planIds[0];
  const rows: CategoryRow[] = [];

  for (const cat of catRows) {
    rows.push(buildRow({
      id: cat.id, name: cat.name, isGroup: false, members: [cat.id],
      periods, params, planAmountByPlanCat, actualByCatBucket, today, primaryPlanId,
    }));
  }
  for (const [gid, name] of groupNameById.entries()) {
    rows.push(buildRow({
      id: gid, name, isGroup: true, members: groupMembers.get(gid) ?? [],
      periods, params, planAmountByPlanCat, actualByCatBucket, today, primaryPlanId,
    }));
  }

  // ── Summary cards ───────────────────────────────────────────────────────
  const summary = buildSummary(rows, periods, params.planIds.length, today);

  return {
    date_range: { from: iso(params.dateFrom), to: iso(params.dateTo) },
    period_type: params.periodType,
    periods: periods.map(p => ({
      start: iso(p.start), end: iso(p.end), label: p.label, is_future: p.isFuture,
    })),
    categories: rows,
    summary,
    unreviewed_count: unreviewedCount,
    plans: planMeta,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface BuildRowInput {
  id: string;
  name: string;
  isGroup: boolean;
  members: string[];
  periods: ReturnType<typeof generatePeriods>;
  params: BuildParams;
  planAmountByPlanCat: Map<string, Map<string, { amount: number; periodType: PeriodType }>>;
  actualByCatBucket: Map<string, Map<string, number>>;
  today: Date;
  primaryPlanId: string | undefined;
}

function buildRow(input: BuildRowInput): CategoryRow {
  const { id, name, isGroup, members, periods, params } = input;
  const periodCells: CategoryRow['periods'] = [];

  // Sum actuals up to "today" so we can compute the projection rate once.
  const actualToDate = sumActualsToDate(input);
  const daysElapsed = Math.max(1, Math.ceil(
    (startOfDay(input.today).getTime() - startOfDay(params.dateFrom).getTime()) / 86_400_000,
  ));
  const dailyRate = actualToDate / daysElapsed;

  for (const period of periods) {
    const bucketKey = isoMonthStart(period.start, params.periodType);
    // Actual = sum of members' totals for this bucket (past periods only).
    let actual: number | null = null;
    if (!period.isFuture) {
      let sum = 0;
      for (const mid of members) {
        sum += input.actualByCatBucket.get(mid)?.get(bucketKey) ?? 0;
      }
      actual = sum;
    }

    // Planned per plan, pro-rated.
    const plans: number[] = params.planIds.map(planId => {
      const planForCat = input.planAmountByPlanCat.get(planId);
      if (!planForCat) return 0;
      let total = 0;
      for (const mid of members) {
        const def = planForCat.get(mid);
        if (!def) continue;
        total += prorateAmount(def.amount, def.periodType, period.start, period.end, params.periodType);
      }
      return total;
    });
    const planned = plans[0] ?? 0;

    // Delta is only meaningful for single-plan past periods.
    const isSinglePlan = params.planIds.length === 1;
    const delta = isSinglePlan && !period.isFuture ? (actual ?? 0) - planned : null;

    // Projection for future buckets = daily rate × bucket days.
    let projected: number | null = null;
    if (period.isFuture) {
      const days = Math.round(
        (startOfDay(period.end).getTime() - startOfDay(period.start).getTime()) / 86_400_000,
      ) + 1;
      projected = dailyRate * days;
    }

    periodCells.push({ actual, planned, plans, delta, projected });
  }

  const total_actual  = periodCells.reduce((s, c) => s + (c.actual ?? 0), 0);
  const total_planned = periodCells.reduce((s, c) => s + c.planned, 0);
  const total_delta = params.planIds.length === 1 ? total_actual - total_planned : null;

  return {
    category_id: id,
    category_name: name,
    is_group: isGroup,
    member_ids: members,
    periods: periodCells,
    total_actual,
    total_planned,
    total_delta,
  };
}

function sumActualsToDate(input: BuildRowInput): number {
  const todayStart = startOfDay(input.today);
  let sum = 0;
  for (const period of input.periods) {
    if (period.isFuture) continue;
    const bucketKey = isoMonthStart(period.start, input.params.periodType);
    for (const mid of input.members) {
      if (period.start.getTime() <= todayStart.getTime()) {
        sum += input.actualByCatBucket.get(mid)?.get(bucketKey) ?? 0;
      }
    }
  }
  return sum;
}

function buildSummary(
  rows: CategoryRow[],
  periods: ReturnType<typeof generatePeriods>,
  planCount: number,
  today: Date,
): SummaryCards {
  const todayStart = startOfDay(today);

  let totalSpent = 0;
  let plannedToDate = 0;
  let projectedEnd = 0;
  let planEnd = 0;

  for (const row of rows) {
    for (let i = 0; i < periods.length; i++) {
      const period = periods[i]!;
      const cell = row.periods[i]!;
      const isPast = !period.isFuture;
      const isCurrent = period.start.getTime() <= todayStart.getTime() && period.end.getTime() >= todayStart.getTime();

      if (isPast || isCurrent) {
        totalSpent += cell.actual ?? 0;
      }
      // "To date" plan slice: prorate the bucket's planned amount by the
      // fraction of days elapsed.
      const daysTotal = bucketDays(period.start, period.end);
      let daysElapsedInBucket: number;
      if (period.isFuture) daysElapsedInBucket = 0;
      else if (period.end.getTime() <= todayStart.getTime()) daysElapsedInBucket = daysTotal;
      else daysElapsedInBucket = Math.max(0, Math.min(daysTotal, Math.round((todayStart.getTime() - period.start.getTime()) / 86_400_000) + 1));
      plannedToDate += cell.planned * (daysElapsedInBucket / daysTotal);

      projectedEnd += period.isFuture ? (cell.projected ?? 0) : (cell.actual ?? 0);
      planEnd += cell.planned;
    }
  }

  const isMulti = planCount > 1;
  const totalPlannedSummary    = isMulti ? null : plannedToDate;
  const deltaSummary           = isMulti ? null : totalSpent - plannedToDate;
  const deltaPct               = isMulti || plannedToDate === 0 ? null : ((totalSpent - plannedToDate) / plannedToDate);
  const projectedEndTotal      = projectedEnd;
  const planEndTotalSummary    = isMulti ? null : planEnd;
  const projectedDeltaSummary  = isMulti ? null : projectedEnd - planEnd;

  return {
    total_spent: totalSpent,
    total_planned_to_date: totalPlannedSummary,
    delta_to_date: deltaSummary,
    delta_to_date_pct: deltaPct,
    projected_end_total: projectedEndTotal,
    plan_end_total: planEndTotalSummary,
    projected_delta: projectedDeltaSummary,
  };
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoMonthStart(start: Date, periodType: PeriodType): string {
  if (periodType === 'monthly') {
    const y = start.getUTCFullYear();
    const m = String(start.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }
  return `${start.getUTCFullYear()}-01-01`;
}

function bucketDays(start: Date, end: Date): number {
  return Math.round((startOfDay(end).getTime() - startOfDay(start).getTime()) / 86_400_000) + 1;
}
