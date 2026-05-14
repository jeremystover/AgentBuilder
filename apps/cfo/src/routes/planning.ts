/**
 * Planning module REST surface (Module 3).
 *
 *   GET    /api/web/plans                                       list plans
 *   POST   /api/web/plans                                       create plan
 *   GET    /api/web/plans/:id                                   plan detail
 *   PUT    /api/web/plans/:id                                   update metadata
 *   DELETE /api/web/plans/:id                                   archive (soft delete)
 *   POST   /api/web/plans/:id/duplicate                         clone as sibling
 *   POST   /api/web/plans/:id/extend                            create child modification
 *   GET    /api/web/plans/:id/resolve?asOf=YYYY-MM-DD           resolved amounts
 *   GET    /api/web/plans/:id/forecast?from=&to=&period=        cash flow forecast
 *   PUT    /api/web/plans/:id/set-active                        set as active plan
 *   GET    /api/web/plans/:id/categories                        amount rows
 *   PUT    /api/web/plans/:id/categories/:catId                 upsert amount
 *   GET    /api/web/plans/:id/categories/:catId/suggest         historical avg
 *   GET    /api/web/plans/:id/one-time-items                    list items
 *   POST   /api/web/plans/:id/one-time-items                    create item
 *   PUT    /api/web/plans/:id/one-time-items/:itemId            update item
 *   DELETE /api/web/plans/:id/one-time-items/:itemId            delete item
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db, pgArr } from '../lib/db';
import { resolvePlan } from '../lib/plan-resolver';
import { generateForecast } from '../lib/forecast';

// ── Plans CRUD ───────────────────────────────────────────────────────────────

interface PlanBody {
  name: string;
  type?: 'foundation' | 'modification';
  parent_plan_id?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  status?: 'draft' | 'active' | 'archived';
  notes?: string | null;
}

export async function handleListPlans(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, name, type, parent_plan_id, status, is_active,
             to_char(start_date, 'YYYY-MM-DD') AS start_date,
             to_char(end_date,   'YYYY-MM-DD') AS end_date,
             notes,
             to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
      FROM plans
      WHERE status <> 'archived'
      ORDER BY type, name
    `;
    return jsonOk({ plans: rows });
  } catch (err) {
    return jsonError(`list plans failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleCreatePlan(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as PlanBody | null;
  if (!body?.name) return jsonError('name required', 400);
  const type = body.type ?? 'foundation';
  if (type === 'modification' && !body.parent_plan_id) {
    return jsonError('parent_plan_id required for modification plans', 400);
  }
  if (type === 'foundation' && body.parent_plan_id) {
    return jsonError('foundation plans cannot have a parent', 400);
  }
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO plans (name, type, parent_plan_id, start_date, end_date, status, notes)
      VALUES (${body.name},
              ${type},
              ${body.parent_plan_id ?? null},
              ${body.start_date ?? null},
              ${body.end_date ?? null},
              ${body.status ?? 'draft'},
              ${body.notes ?? null})
      RETURNING id
    `;
    return jsonOk({ id: rows[0]!.id });
  } catch (err) {
    return jsonError(`create plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleGetPlan(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, name, type, parent_plan_id, status, is_active,
             to_char(start_date, 'YYYY-MM-DD') AS start_date,
             to_char(end_date,   'YYYY-MM-DD') AS end_date,
             notes
      FROM plans WHERE id = ${id}
    `;
    if (rows.length === 0) return jsonError('plan not found', 404);
    return jsonOk(rows[0]);
  } catch (err) {
    return jsonError(`get plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdatePlan(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as Partial<PlanBody> | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    if ('name' in body)       await sql`UPDATE plans SET name = ${body.name ?? ''}, updated_at = now() WHERE id = ${id}`;
    if ('start_date' in body) await sql`UPDATE plans SET start_date = ${body.start_date ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('end_date' in body)   await sql`UPDATE plans SET end_date = ${body.end_date ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('status' in body)     await sql`UPDATE plans SET status = ${body.status ?? 'draft'}, updated_at = now() WHERE id = ${id}`;
    if ('notes' in body)      await sql`UPDATE plans SET notes = ${body.notes ?? null}, updated_at = now() WHERE id = ${id}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleArchivePlan(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    await sql`UPDATE plans SET status = 'archived', is_active = false, updated_at = now() WHERE id = ${id}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`archive plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Duplicate / Extend ───────────────────────────────────────────────────────

export async function handleDuplicatePlan(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const orig = await sql<Array<{ name: string; type: 'foundation' | 'modification'; parent_plan_id: string | null }>>`
      SELECT name, type, parent_plan_id FROM plans WHERE id = ${id}
    `;
    if (orig.length === 0) return jsonError('plan not found', 404);
    const src = orig[0]!;
    const created = await sql<Array<{ id: string }>>`
      INSERT INTO plans (name, type, parent_plan_id, status)
      VALUES (${'Copy of ' + src.name}, ${src.type}, ${src.parent_plan_id}, 'draft')
      RETURNING id
    `;
    const newId = created[0]!.id;
    // Copy category amounts (one new row per source row).
    const amounts = await sql<Array<{ id: string; category_id: string; amount: string | null; period_type: string; override_type: string; base_rate_pct: string | null; base_rate_start: string | null }>>`
      SELECT id, category_id, amount::text AS amount, period_type, override_type,
             base_rate_pct::text AS base_rate_pct,
             to_char(base_rate_start, 'YYYY-MM-DD') AS base_rate_start
      FROM plan_category_amounts WHERE plan_id = ${id}
    `;
    for (const a of amounts) {
      const inserted = await sql<Array<{ id: string }>>`
        INSERT INTO plan_category_amounts (plan_id, category_id, amount, period_type, override_type, base_rate_pct, base_rate_start)
        VALUES (${newId}, ${a.category_id}, ${a.amount}, ${a.period_type}, ${a.override_type}, ${a.base_rate_pct}, ${a.base_rate_start})
        RETURNING id
      `;
      const newAmountId = inserted[0]!.id;
      await sql`
        INSERT INTO plan_category_changes (plan_category_amount_id, effective_date, delta_amount, notes)
        SELECT ${newAmountId}, effective_date, delta_amount, notes
        FROM plan_category_changes WHERE plan_category_amount_id = ${a.id}
      `;
    }
    await sql`
      INSERT INTO plan_one_time_items (plan_id, name, type, item_date, amount, category_id, notes)
      SELECT ${newId}, name, type, item_date, amount, category_id, notes
      FROM plan_one_time_items WHERE plan_id = ${id}
    `;
    return jsonOk({ id: newId });
  } catch (err) {
    return jsonError(`duplicate plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleExtendPlan(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const orig = await sql<Array<{ name: string }>>`SELECT name FROM plans WHERE id = ${id}`;
    if (orig.length === 0) return jsonError('plan not found', 404);
    const created = await sql<Array<{ id: string }>>`
      INSERT INTO plans (name, type, parent_plan_id, status)
      VALUES (${orig[0]!.name + ' — Modified'}, 'modification', ${id}, 'draft')
      RETURNING id
    `;
    return jsonOk({ id: created[0]!.id });
  } catch (err) {
    return jsonError(`extend plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Active plan ──────────────────────────────────────────────────────────────

export async function handleSetActivePlanV2(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    // Clear current active, then set this one. Done atomically via a CTE
    // so the unique index never sees two true rows.
    await sql`
      WITH cleared AS (
        UPDATE plans SET is_active = false WHERE is_active = true AND id <> ${id}
      )
      UPDATE plans SET is_active = true, status = 'active', updated_at = now() WHERE id = ${id}
    `;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`set active plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Resolve + forecast ───────────────────────────────────────────────────────

export async function handleResolvePlan(req: Request, env: Env, id: string): Promise<Response> {
  const url = new URL(req.url);
  const asOfStr = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
  const asOf = new Date(`${asOfStr}T00:00:00Z`);
  if (isNaN(+asOf)) return jsonError('invalid asOf', 400);
  const sql = db(env);
  try {
    const map = await resolvePlan(sql, id, asOf);
    const rows = [...map.values()];
    return jsonOk({ as_of: asOfStr, categories: rows });
  } catch (err) {
    return jsonError(`resolve plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleForecastPlan(req: Request, env: Env, id: string): Promise<Response> {
  const url = new URL(req.url);
  const todayIso = new Date().toISOString().slice(0, 10);
  const fromStr  = url.searchParams.get('from') ?? todayIso;
  const toStr    = url.searchParams.get('to');
  const horizonMonths = Number(url.searchParams.get('horizon_months') ?? '12');
  const periodType   = url.searchParams.get('period_type') === 'annual' ? 'annual' : 'monthly';

  const from = new Date(`${fromStr}T00:00:00Z`);
  let to: Date;
  if (toStr) to = new Date(`${toStr}T00:00:00Z`);
  else {
    to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + horizonMonths);
  }
  if (isNaN(+from) || isNaN(+to)) return jsonError('invalid date range', 400);

  const sql = db(env);
  try {
    const periods = await generateForecast(sql, id, from, to, periodType);
    return jsonOk({ plan_id: id, period_type: periodType, periods });
  } catch (err) {
    return jsonError(`forecast failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Category amounts ─────────────────────────────────────────────────────────

export async function handleListPlanCategories(_req: Request, env: Env, planId: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT pca.id, pca.plan_id, pca.category_id,
             c.name AS category_name, c.slug AS category_slug,
             pca.amount::text AS amount,
             pca.period_type, pca.override_type,
             pca.base_rate_pct::text AS base_rate_pct,
             to_char(pca.base_rate_start, 'YYYY-MM-DD') AS base_rate_start
      FROM plan_category_amounts pca
      JOIN categories c ON c.id = pca.category_id
      WHERE pca.plan_id = ${planId}
      ORDER BY c.name
    `;
    const ids = rows.map(r => r.id as string);
    const changes = ids.length === 0 ? [] : await sql<Array<Record<string, unknown>>>`
      SELECT id, plan_category_amount_id,
             to_char(effective_date, 'YYYY-MM-DD') AS effective_date,
             delta_amount::text AS delta_amount,
             notes
      FROM plan_category_changes
      WHERE plan_category_amount_id = ANY(${pgArr(ids)}::text[])
      ORDER BY effective_date
    `;
    const changesById = new Map<string, unknown[]>();
    for (const c of changes) {
      const k = c.plan_category_amount_id as string;
      const arr = changesById.get(k) ?? [];
      arr.push(c);
      changesById.set(k, arr);
    }
    return jsonOk({
      amounts: rows.map(r => ({
        ...r,
        amount: r.amount == null ? null : Number(r.amount),
        base_rate_pct: r.base_rate_pct == null ? null : Number(r.base_rate_pct),
        changes: (changesById.get(r.id as string) ?? []).map(c => {
          const cc = c as Record<string, unknown>;
          return { ...cc, delta_amount: Number(cc.delta_amount) };
        }),
      })),
    });
  } catch (err) {
    return jsonError(`list plan categories failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface UpsertCategoryBody {
  amount?: number | null;
  period_type?: 'monthly' | 'annual';
  override_type?: 'inherited' | 'delta' | 'fixed';
  base_rate_pct?: number | null;
  base_rate_start?: string | null;
  changes?: Array<{ effective_date: string; delta_amount: number; notes?: string | null }>;
}

export async function handleUpsertPlanCategory(
  req: Request, env: Env, planId: string, catId: string,
): Promise<Response> {
  const body = await req.json().catch(() => null) as UpsertCategoryBody | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO plan_category_amounts (plan_id, category_id, amount, period_type, override_type, base_rate_pct, base_rate_start)
      VALUES (${planId}, ${catId},
              ${body.amount ?? null},
              ${body.period_type ?? 'monthly'},
              ${body.override_type ?? 'inherited'},
              ${body.base_rate_pct ?? null},
              ${body.base_rate_start ?? null})
      ON CONFLICT (plan_id, category_id) DO UPDATE SET
        amount          = EXCLUDED.amount,
        period_type     = EXCLUDED.period_type,
        override_type   = EXCLUDED.override_type,
        base_rate_pct   = EXCLUDED.base_rate_pct,
        base_rate_start = EXCLUDED.base_rate_start
      RETURNING id
    `;
    const amountId = rows[0]!.id;
    if (Array.isArray(body.changes)) {
      await sql`DELETE FROM plan_category_changes WHERE plan_category_amount_id = ${amountId}`;
      for (const ch of body.changes) {
        await sql`
          INSERT INTO plan_category_changes (plan_category_amount_id, effective_date, delta_amount, notes)
          VALUES (${amountId}, ${ch.effective_date}, ${ch.delta_amount}, ${ch.notes ?? null})
        `;
      }
    }
    return jsonOk({ id: amountId });
  } catch (err) {
    return jsonError(`upsert plan category failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleSuggestPlanCategory(
  req: Request, env: Env, _planId: string, catId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const months = Math.max(1, Number(url.searchParams.get('months') ?? '12'));
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months, 1));
  const to   = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  const sql = db(env);
  try {
    const rows = await sql<Array<{ total: string; ct: string }>>`
      SELECT COALESCE(SUM(amount), 0)::text AS total,
             COUNT(*)::text                 AS ct
      FROM transactions
      WHERE status = 'approved'
        AND category_id = ${catId}
        AND date BETWEEN ${iso(from)} AND ${iso(to)}
    `;
    const total = Number(rows[0]?.total ?? 0);
    const count = Number(rows[0]?.ct ?? 0);
    return jsonOk({
      lookback_months: months,
      transaction_count: count,
      average_monthly: total / months,
      average_annual:  (total / months) * 12,
    });
  } catch (err) {
    return jsonError(`suggest failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── One-time items ───────────────────────────────────────────────────────────

interface OneTimeBody {
  name: string;
  type: 'expense' | 'income';
  item_date: string;
  amount: number;
  category_id?: string | null;
  notes?: string | null;
}

export async function handleListOneTimeItems(_req: Request, env: Env, planId: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, plan_id, name, type,
             to_char(item_date, 'YYYY-MM-DD') AS item_date,
             amount::text AS amount,
             category_id, notes
      FROM plan_one_time_items
      WHERE plan_id = ${planId}
      ORDER BY item_date
    `;
    return jsonOk({
      items: rows.map(r => ({ ...r, amount: Number(r.amount) })),
    });
  } catch (err) {
    return jsonError(`list one-time items failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleCreateOneTimeItem(req: Request, env: Env, planId: string): Promise<Response> {
  const body = await req.json().catch(() => null) as OneTimeBody | null;
  if (!body?.name || !body.type || !body.item_date) return jsonError('name, type, item_date required', 400);
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO plan_one_time_items (plan_id, name, type, item_date, amount, category_id, notes)
      VALUES (${planId}, ${body.name}, ${body.type}, ${body.item_date}, ${body.amount}, ${body.category_id ?? null}, ${body.notes ?? null})
      RETURNING id
    `;
    return jsonOk({ id: rows[0]!.id });
  } catch (err) {
    return jsonError(`create one-time item failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdateOneTimeItem(
  req: Request, env: Env, _planId: string, itemId: string,
): Promise<Response> {
  const body = await req.json().catch(() => null) as Partial<OneTimeBody> | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    if ('name' in body)        await sql`UPDATE plan_one_time_items SET name = ${body.name ?? ''} WHERE id = ${itemId}`;
    if ('type' in body)        await sql`UPDATE plan_one_time_items SET type = ${body.type ?? 'expense'} WHERE id = ${itemId}`;
    if ('item_date' in body)   await sql`UPDATE plan_one_time_items SET item_date = ${body.item_date ?? null} WHERE id = ${itemId}`;
    if ('amount' in body)      await sql`UPDATE plan_one_time_items SET amount = ${body.amount ?? 0} WHERE id = ${itemId}`;
    if ('category_id' in body) await sql`UPDATE plan_one_time_items SET category_id = ${body.category_id ?? null} WHERE id = ${itemId}`;
    if ('notes' in body)       await sql`UPDATE plan_one_time_items SET notes = ${body.notes ?? null} WHERE id = ${itemId}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update one-time item failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleDeleteOneTimeItem(
  _req: Request, env: Env, _planId: string, itemId: string,
): Promise<Response> {
  const sql = db(env);
  try {
    await sql`DELETE FROM plan_one_time_items WHERE id = ${itemId}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`delete one-time item failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function iso(d: Date): string { return d.toISOString().slice(0, 10); }
