/**
 * Income tracking routes.
 *
 * - GET    /income/status    — per-entity income vs. target for a period
 * - GET    /income/targets   — list active income targets
 * - PUT    /income/targets   — upsert income target for an entity
 * - DELETE /income/targets/:id
 */

import { z } from 'zod';
import type { Env, Entity } from '../types';
import { getUserId, jsonError, jsonOk } from '../types';
import { prorateTarget, resolvePeriod, type Cadence } from '../lib/budget';

const ENTITIES: Entity[] = ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'];
const CadenceSchema = z.enum(['weekly', 'monthly', 'annual']);

const UpsertTargetSchema = z.object({
  entity: z.enum(['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal']),
  cadence: CadenceSchema,
  amount: z.number().nonnegative(),
  effective_from: z.string().optional(),
  notes: z.string().optional(),
});

interface EntityRow {
  entity: Entity;
  actual_income: number;
  actual_expense: number;
  tx_count_income: number;
  tx_count_expense: number;
}

interface TargetRow {
  id: string;
  entity: Entity;
  cadence: Cadence;
  amount: number;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
}

// ── GET /income/status ────────────────────────────────────────────────────────
export async function handleIncomeStatus(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);

  const period = resolvePeriod({
    preset: url.searchParams.get('preset') ?? undefined,
    start:  url.searchParams.get('start')  ?? undefined,
    end:    url.searchParams.get('end')    ?? undefined,
  });

  const [activityResult, targetsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT c.entity,
              SUM(CASE WHEN t.amount > 0 THEN t.amount  ELSE 0 END)  AS actual_income,
              SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END)  AS actual_expense,
              COUNT(CASE WHEN t.amount > 0 THEN 1 END)               AS tx_count_income,
              COUNT(CASE WHEN t.amount < 0 THEN 1 END)               AS tx_count_expense
       FROM transactions t
       JOIN classifications c ON c.transaction_id = t.id
       WHERE t.user_id = ?
         AND t.posted_date >= ?
         AND t.posted_date <= ?
         AND t.is_pending = 0
         AND c.entity IS NOT NULL
         AND COALESCE(c.category_tax, '') != 'transfer'
       GROUP BY c.entity`,
    ).bind(userId, period.start, period.end).all<EntityRow>(),

    env.DB.prepare(
      `SELECT * FROM income_targets
       WHERE user_id = ?
         AND (effective_to IS NULL OR effective_to >= date('now'))`,
    ).bind(userId).all<TargetRow>(),
  ]);

  const activityByEntity = new Map(activityResult.results.map(r => [r.entity, r]));
  const targetByEntity   = new Map(targetsResult.results.map(r => [r.entity, r]));

  const entities = ENTITIES.map(entity => {
    const activity = activityByEntity.get(entity);
    const target   = targetByEntity.get(entity);

    const actual_income  = activity?.actual_income  ?? 0;
    const actual_expense = activity?.actual_expense ?? 0;
    const net = actual_income - actual_expense;

    let proratedTarget: number | null = null;
    if (target) {
      proratedTarget = prorateTarget(target.amount, target.cadence as Cadence, period.days);
    }

    const pct_of_target = proratedTarget && proratedTarget > 0
      ? (actual_income / proratedTarget) * 100
      : null;

    const status =
      !target           ? 'no_target' :
      pct_of_target! >= 100 ? 'on_track' :
      pct_of_target! >= 70  ? 'near'     : 'under';

    return {
      entity,
      target: target ? {
        native_amount:   target.amount,
        native_cadence:  target.cadence,
        prorated_amount: proratedTarget!,
      } : null,
      actual_income,
      actual_expense,
      net,
      pct_of_target,
      status,
      tx_count_income:  activity?.tx_count_income  ?? 0,
      tx_count_expense: activity?.tx_count_expense ?? 0,
    };
  });

  return jsonOk({ period, entities });
}

// ── GET /income/targets ───────────────────────────────────────────────────────
export async function handleListIncomeTargets(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const rows = await env.DB.prepare(
    `SELECT * FROM income_targets
     WHERE user_id = ?
       AND (effective_to IS NULL OR effective_to >= date('now'))
     ORDER BY entity`,
  ).bind(userId).all<TargetRow>();
  return jsonOk({ targets: rows.results });
}

// ── PUT /income/targets ───────────────────────────────────────────────────────
export async function handleUpsertIncomeTarget(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = UpsertTargetSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const { entity, cadence, amount, effective_from, notes } = parsed.data;
  const fromDate = effective_from ?? new Date().toISOString().slice(0, 10);

  // Close the existing active target for this entity (if any)
  await env.DB.prepare(
    `UPDATE income_targets
     SET effective_to = ?
     WHERE user_id = ? AND entity = ? AND effective_to IS NULL`,
  ).bind(fromDate, userId, entity).run();

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO income_targets (id, user_id, entity, cadence, amount, effective_from, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, userId, entity, cadence, amount, fromDate, notes ?? null).run();

  const target = await env.DB.prepare(
    'SELECT * FROM income_targets WHERE id = ?',
  ).bind(id).first();

  return jsonOk({ target });
}

// ── DELETE /income/targets/:id ────────────────────────────────────────────────
export async function handleDeleteIncomeTarget(request: Request, env: Env, targetId: string): Promise<Response> {
  const userId = getUserId(request);
  const existing = await env.DB.prepare(
    'SELECT id FROM income_targets WHERE id = ? AND user_id = ?',
  ).bind(targetId, userId).first();
  if (!existing) return jsonError('Target not found', 404);

  await env.DB.prepare('DELETE FROM income_targets WHERE id = ?').bind(targetId).run();
  return jsonOk({ deleted: targetId });
}
