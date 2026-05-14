/**
 * Plan resolution — walks a foundation → modification chain and produces
 * the effective per-category amounts at a given date.
 *
 * Chain rules:
 *   1. Load every ancestor (foundation first, descendants last).
 *   2. Foundation rows seed the running value for each category.
 *   3. For each later modification, per-category override_type controls
 *      what happens:
 *        - 'inherited': passthrough
 *        - 'delta':     running_value += row.amount
 *        - 'fixed':     running_value  = row.amount
 *   4. After the chain is resolved, apply the row's time-based pieces
 *      (fixed-rate compounding + scheduled discrete deltas) for the
 *      `asOf` date — these come from the *defining* row (the row at
 *      `source_plan_id`, not later ones).
 *
 * Output values are normalized to a `monthly_amount` field so callers
 * (Spending engine, Forecast engine) can compare apples to apples.
 */

import type { Sql } from './db';

export interface ResolvedCategoryAmount {
  category_id: string;
  amount: number;                     // effective amount in source row's period units
  period_type: 'monthly' | 'annual';
  monthly_amount: number;             // amount normalized to monthly
  source_plan_id: string;             // plan that set the current value
  override_type: 'foundation' | 'delta' | 'fixed' | 'inherited';
  adjusted_for_rate: boolean;
  adjusted_for_changes: boolean;
}

interface PlanRow { id: string; type: 'foundation' | 'modification'; parent_plan_id: string | null }
interface AmountRow {
  id: string;
  plan_id: string;
  category_id: string;
  amount: string | null;
  period_type: 'monthly' | 'annual';
  override_type: 'inherited' | 'delta' | 'fixed';
  base_rate_pct: string | null;
  base_rate_start: string | null;
}
interface ChangeRow {
  plan_category_amount_id: string;
  effective_date: string;       // YYYY-MM-DD
  delta_amount: string;
}

export async function resolvePlan(
  sql: Sql,
  planId: string,
  asOf: Date,
): Promise<Map<string, ResolvedCategoryAmount>> {
  const chain = await loadChain(sql, planId);
  if (chain.length === 0) return new Map();

  const planIds = chain.map(p => p.id);

  const amountRows = await sql<AmountRow[]>`
    SELECT id, plan_id, category_id,
           amount::text   AS amount,
           period_type, override_type,
           base_rate_pct::text   AS base_rate_pct,
           to_char(base_rate_start, 'YYYY-MM-DD') AS base_rate_start
    FROM plan_category_amounts
    WHERE plan_id = ANY(${planIds})
  `;
  const changeRows = amountRows.length === 0
    ? []
    : await sql<ChangeRow[]>`
        SELECT plan_category_amount_id,
               to_char(effective_date, 'YYYY-MM-DD') AS effective_date,
               delta_amount::text AS delta_amount
        FROM plan_category_changes
        WHERE plan_category_amount_id = ANY(${amountRows.map(a => a.id)})
        ORDER BY effective_date
      `;
  const changesByAmount = new Map<string, ChangeRow[]>();
  for (const c of changeRows) {
    const arr = changesByAmount.get(c.plan_category_amount_id) ?? [];
    arr.push(c);
    changesByAmount.set(c.plan_category_amount_id, arr);
  }

  // Bucket rows by plan, indexed by category for O(1) lookup.
  const rowsByPlan = new Map<string, Map<string, AmountRow>>();
  for (const planRow of chain) rowsByPlan.set(planRow.id, new Map());
  for (const row of amountRows) {
    rowsByPlan.get(row.plan_id)!.set(row.category_id, row);
  }

  // Categories ever seen on this chain.
  const allCategoryIds = new Set<string>(amountRows.map(r => r.category_id));

  const result = new Map<string, ResolvedCategoryAmount>();

  for (const categoryId of allCategoryIds) {
    let value: number | null = null;
    let periodType: 'monthly' | 'annual' = 'monthly';
    let sourcePlanId = chain[0]!.id;
    let sourceRow: AmountRow | null = null;
    let overrideType: 'foundation' | 'delta' | 'fixed' | 'inherited' = 'foundation';

    for (const planRow of chain) {
      const row = rowsByPlan.get(planRow.id)?.get(categoryId);
      if (!row) continue;
      const rowAmount = row.amount == null ? null : Number(row.amount);

      if (planRow.type === 'foundation') {
        if (rowAmount != null) {
          value = rowAmount;
          periodType = row.period_type;
          sourcePlanId = planRow.id;
          sourceRow = row;
          overrideType = 'foundation';
        }
        continue;
      }

      // Modification semantics
      if (row.override_type === 'fixed' && rowAmount != null) {
        value = rowAmount;
        periodType = row.period_type;
        sourcePlanId = planRow.id;
        sourceRow = row;
        overrideType = 'fixed';
      } else if (row.override_type === 'delta' && rowAmount != null) {
        value = (value ?? 0) + rowAmount;
        sourcePlanId = planRow.id;
        sourceRow = row;
        overrideType = 'delta';
      }
      // 'inherited' → no change
    }

    if (value == null) continue; // never set on the chain → skip

    // Apply time-based adjustments from the source row.
    const baseAmount = value;
    let adjusted = baseAmount;
    let adjustedForRate = false;
    let adjustedForChanges = false;

    if (sourceRow?.base_rate_pct && sourceRow.base_rate_start) {
      const rate = Number(sourceRow.base_rate_pct);
      const start = new Date(`${sourceRow.base_rate_start}T00:00:00Z`);
      if (!isNaN(+start) && asOf.getTime() > start.getTime() && rate !== 0) {
        const years = (asOf.getTime() - start.getTime()) / (365.25 * 86_400_000);
        adjusted = adjusted * Math.pow(1 + rate, years);
        adjustedForRate = true;
      }
    }

    if (sourceRow) {
      const changes = changesByAmount.get(sourceRow.id) ?? [];
      for (const ch of changes) {
        if (new Date(`${ch.effective_date}T00:00:00Z`).getTime() <= asOf.getTime()) {
          adjusted += Number(ch.delta_amount);
          adjustedForChanges = true;
        }
      }
    }

    result.set(categoryId, {
      category_id: categoryId,
      amount: adjusted,
      period_type: periodType,
      monthly_amount: periodType === 'annual' ? adjusted / 12 : adjusted,
      source_plan_id: sourcePlanId,
      override_type: overrideType,
      adjusted_for_rate: adjustedForRate,
      adjusted_for_changes: adjustedForChanges,
    });
  }

  return result;
}

/**
 * Load `planId` plus every ancestor in foundation-first order.
 * Uses a recursive CTE so a deeply chained modification still costs
 * one round-trip.
 */
async function loadChain(sql: Sql, planId: string): Promise<PlanRow[]> {
  const rows = await sql<Array<PlanRow & { depth: number }>>`
    WITH RECURSIVE chain AS (
      SELECT id, type, parent_plan_id, 0 AS depth
      FROM plans WHERE id = ${planId}
      UNION ALL
      SELECT p.id, p.type, p.parent_plan_id, chain.depth + 1
      FROM plans p
      JOIN chain ON chain.parent_plan_id = p.id
    )
    SELECT id, type, parent_plan_id, depth FROM chain
  `;
  // Foundation has highest depth; we want it first.
  rows.sort((a, b) => b.depth - a.depth);
  return rows;
}
