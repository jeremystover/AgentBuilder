/**
 * Budget routes.
 *
 * - GET    /budget/categories       — list categories (seeds from FAMILY_CATEGORIES on first read)
 * - POST   /budget/categories       — create a new category
 * - PATCH  /budget/categories/:slug — rename / deactivate
 * - GET    /budget/targets          — list the active target per category
 * - PUT    /budget/targets          — upsert target for a category
 * - DELETE /budget/targets/:id      — remove a target
 * - GET    /budget/status           — spend vs. target for a period (pro-rated)
 */

import { z } from 'zod';
import type { Env } from '../types';
import { getUserId, jsonError, jsonOk } from '../types';
import {
  ensureDefaultBudgetCategories,
  prorateTarget,
  resolvePeriod,
  type Cadence,
} from '../lib/budget';

const CadenceSchema = z.enum(['weekly', 'monthly', 'annual']);

const CreateCategorySchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/, 'Use lowercase_with_underscores'),
  name: z.string().min(1).max(120),
  parent_slug: z.string().min(1).max(64).optional(),
});

const UpdateCategorySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parent_slug: z.string().min(1).max(64).nullable().optional(),
  is_active: z.boolean().optional(),
});

const UpsertTargetSchema = z.object({
  category_slug: z.string().min(1),
  cadence: CadenceSchema,
  amount: z.number().nonnegative(),
  effective_from: z.string().optional(),
  effective_to: z.string().nullable().optional(),
  notes: z.string().optional(),
});

// ── GET /budget/categories ────────────────────────────────────────────────────
export async function handleListBudgetCategories(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  await ensureDefaultBudgetCategories(env, userId);

  const rows = await env.DB.prepare(
    `SELECT id, slug, name, parent_slug, is_active, created_at
     FROM budget_categories
     WHERE user_id = ?
     ORDER BY is_active DESC, name ASC`,
  ).bind(userId).all();

  return jsonOk({ categories: rows.results });
}

// ── POST /budget/categories ───────────────────────────────────────────────────
export async function handleCreateBudgetCategory(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = CreateCategorySchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO budget_categories (id, user_id, slug, name, parent_slug, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).bind(id, userId, parsed.data.slug, parsed.data.name, parsed.data.parent_slug ?? null).run();
  } catch (err) {
    const msg = String(err);
    if (msg.includes('UNIQUE')) return jsonError(`Category "${parsed.data.slug}" already exists`, 409);
    throw err;
  }

  return jsonOk({ id, ...parsed.data, is_active: true }, 201);
}

// ── PATCH /budget/categories/:slug ────────────────────────────────────────────
export async function handleUpdateBudgetCategory(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = UpdateCategorySchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (parsed.data.name !== undefined) {
    updates.push('name = ?');
    values.push(parsed.data.name);
  }
  if (parsed.data.parent_slug !== undefined) {
    updates.push('parent_slug = ?');
    values.push(parsed.data.parent_slug);
  }
  if (parsed.data.is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(parsed.data.is_active ? 1 : 0);
  }

  if (!updates.length) return jsonError('No fields to update');

  values.push(userId, slug);
  const result = await env.DB.prepare(
    `UPDATE budget_categories SET ${updates.join(', ')} WHERE user_id = ? AND slug = ?`,
  ).bind(...values).run();

  if (!result.meta.changes) return jsonError('Category not found', 404);

  return jsonOk({ slug, updated: parsed.data });
}

// ── GET /budget/targets ───────────────────────────────────────────────────────
export async function handleListBudgetTargets(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const rows = await env.DB.prepare(
    `SELECT bt.id, bt.category_slug, bt.cadence, bt.amount,
            bt.effective_from, bt.effective_to, bt.notes,
            bc.name AS category_name
     FROM budget_targets bt
     LEFT JOIN budget_categories bc
       ON bc.user_id = bt.user_id AND bc.slug = bt.category_slug
     WHERE bt.user_id = ?
       AND (bt.effective_to IS NULL OR bt.effective_to >= date('now'))
     ORDER BY bc.name, bt.effective_from DESC`,
  ).bind(userId).all();

  return jsonOk({ targets: rows.results });
}

// ── PUT /budget/targets ───────────────────────────────────────────────────────
// Upsert. If an active (effective_to IS NULL) target exists for the category,
// close it with yesterday's effective_to and insert a new one. Keeps history.
export async function handleUpsertBudgetTarget(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = UpsertTargetSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const { category_slug, cadence, amount, effective_from, effective_to, notes } = parsed.data;

  // Make sure the category exists (create a bare entry if not — less
  // friction for the interview flow when the user invents a new bucket).
  const existing = await env.DB.prepare(
    `SELECT id FROM budget_categories WHERE user_id = ? AND slug = ?`,
  ).bind(userId, category_slug).first();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO budget_categories (id, user_id, slug, name, is_active)
       VALUES (?, ?, ?, ?, 1)`,
    ).bind(crypto.randomUUID(), userId, category_slug, category_slug).run();
  }

  // Close any open-ended prior target for this category.
  await env.DB.prepare(
    `UPDATE budget_targets
     SET effective_to = date('now', '-1 day')
     WHERE user_id = ? AND category_slug = ? AND effective_to IS NULL`,
  ).bind(userId, category_slug).run();

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO budget_targets
       (id, user_id, category_slug, cadence, amount, effective_from, effective_to, notes)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?)`,
  ).bind(
    id,
    userId,
    category_slug,
    cadence,
    amount,
    effective_from ?? null,
    effective_to ?? null,
    notes ?? null,
  ).run();

  return jsonOk({ id, category_slug, cadence, amount }, 201);
}

// ── DELETE /budget/targets/:id ────────────────────────────────────────────────
export async function handleDeleteBudgetTarget(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const userId = getUserId(request);
  const result = await env.DB.prepare(
    `DELETE FROM budget_targets WHERE id = ? AND user_id = ?`,
  ).bind(id, userId).run();
  if (!result.meta.changes) return jsonError('Target not found', 404);
  return jsonOk({ deleted: id });
}

// ── GET /budget/status ────────────────────────────────────────────────────────
// Query params:
//   ?preset=this_month|this_week|last_month|ytd|trailing_30d|trailing_90d
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   (overrides preset)
//   ?category_slug=groceries            (filter to a single category)
export async function handleBudgetStatus(request: Request, env: Env): Promise<Response> {
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

  const categorySlug = url.searchParams.get('category_slug');

  // Pull the active target per category as of the period midpoint. Simple
  // approximation — if you change targets mid-period we'll still give a
  // reasonable number.
  const targetConds = ['user_id = ?', `effective_from <= ?`, `(effective_to IS NULL OR effective_to >= ?)`];
  const targetVals: unknown[] = [userId, period.end, period.start];
  if (categorySlug) {
    targetConds.push('category_slug = ?');
    targetVals.push(categorySlug);
  }
  const targets = await env.DB.prepare(
    `SELECT category_slug, cadence, amount
     FROM budget_targets
     WHERE ${targetConds.join(' AND ')}`,
  ).bind(...targetVals).all<{ category_slug: string; cadence: Cadence; amount: number }>();

  // Pull spend per budget category inside the period. `amount > 0` is an
  // expense in this codebase (positive = debit).
  const spendConds = [
    't.user_id = ?',
    't.amount > 0',
    't.posted_date BETWEEN ? AND ?',
  ];
  const spendVals: unknown[] = [userId, period.start, period.end];
  if (categorySlug) {
    spendConds.push('c.category_budget = ?');
    spendVals.push(categorySlug);
  }

  const spendRows = await env.DB.prepare(
    `SELECT c.category_budget AS category_slug,
            SUM(t.amount) AS spent,
            COUNT(*) AS tx_count
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     WHERE ${spendConds.join(' AND ')}
       AND c.category_budget IS NOT NULL
     GROUP BY c.category_budget`,
  ).bind(...spendVals).all<{ category_slug: string; spent: number; tx_count: number }>();

  // Join categories (for names), targets (for pro-rating), and spend.
  const categoryRows = await env.DB.prepare(
    `SELECT slug, name FROM budget_categories WHERE user_id = ? AND is_active = 1`,
  ).bind(userId).all<{ slug: string; name: string }>();
  const nameBySlug = new Map(categoryRows.results.map(r => [r.slug, r.name]));

  const targetBySlug = new Map<string, { cadence: Cadence; amount: number }>();
  for (const t of targets.results) targetBySlug.set(t.category_slug, { cadence: t.cadence, amount: t.amount });

  const spendBySlug = new Map<string, { spent: number; tx_count: number }>();
  for (const s of spendRows.results) spendBySlug.set(s.category_slug, { spent: s.spent, tx_count: s.tx_count });

  const slugs = new Set<string>([...targetBySlug.keys(), ...spendBySlug.keys()]);
  if (categorySlug) {
    // Ensure the filter still shows up even with no data.
    slugs.add(categorySlug);
  }

  const lines = [...slugs].map(slug => {
    const target = targetBySlug.get(slug);
    const spent = spendBySlug.get(slug)?.spent ?? 0;
    const txCount = spendBySlug.get(slug)?.tx_count ?? 0;
    const proratedTarget = target ? prorateTarget(target.amount, target.cadence, period.days) : null;
    const remaining = proratedTarget == null ? null : proratedTarget - spent;
    const percentUsed = proratedTarget && proratedTarget > 0 ? (spent / proratedTarget) * 100 : null;

    return {
      category_slug: slug,
      category_name: nameBySlug.get(slug) ?? slug,
      target: target
        ? {
            native_amount: target.amount,
            native_cadence: target.cadence,
            prorated_amount: Math.round(proratedTarget! * 100) / 100,
          }
        : null,
      spent: Math.round(spent * 100) / 100,
      tx_count: txCount,
      remaining: remaining == null ? null : Math.round(remaining * 100) / 100,
      percent_used: percentUsed == null ? null : Math.round(percentUsed * 10) / 10,
      status:
        proratedTarget == null
          ? 'no_target'
          : spent > proratedTarget
            ? 'over'
            : spent > proratedTarget * 0.9
              ? 'near'
              : 'under',
    };
  });

  lines.sort((a, b) => (b.percent_used ?? -1) - (a.percent_used ?? -1));

  return jsonOk({
    period: { start: period.start, end: period.end, days: period.days, label: period.label },
    categories: lines,
  });
}
