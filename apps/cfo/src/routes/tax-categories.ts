/**
 * Tax category routes.
 *
 * - GET    /tax/categories       — list (seeds from constants on first read per user)
 * - POST   /tax/categories       — create a new category
 * - PATCH  /tax/categories/:slug — rename / toggle active / update form_line
 */

import { z } from 'zod';
import type { Env } from '../types';
import { getUserId, jsonError, jsonOk, SCHEDULE_C_CATEGORIES, AIRBNB_CATEGORIES } from '../types';

const GroupSchema = z.enum(['schedule_c', 'schedule_e']);

const CreateSchema = z.object({
  slug:           z.string().min(1).max(64).regex(/^[a-z0-9_]+$/, 'Use lowercase_with_underscores'),
  name:           z.string().min(1).max(120),
  form_line:      z.string().max(32).optional(),
  category_group: GroupSchema,
});

const UpdateSchema = z.object({
  name:      z.string().min(1).max(120).optional(),
  form_line: z.string().max(32).nullable().optional(),
  is_active: z.boolean().optional(),
});

async function ensureDefaultTaxCategories(env: Env, userId: string): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM tax_categories WHERE user_id = ?`,
  ).bind(userId).first<{ total: number }>();

  if ((existing?.total ?? 0) > 0) return;

  const scheduleC = Object.entries(SCHEDULE_C_CATEGORIES).map(([slug, { name, form_line }]) => ({
    slug, name, form_line, category_group: 'schedule_c' as const,
  }));
  const scheduleE = Object.entries(AIRBNB_CATEGORIES).map(([slug, { name, form_line }]) => ({
    slug, name, form_line, category_group: 'schedule_e' as const,
  }));

  for (const row of [...scheduleC, ...scheduleE]) {
    await env.DB.prepare(
      `INSERT INTO tax_categories (id, user_id, slug, name, form_line, category_group, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_id, slug) DO NOTHING`,
    ).bind(crypto.randomUUID(), userId, row.slug, row.name, row.form_line, row.category_group).run();
  }
}

// ── GET /tax/categories ───────────────────────────────────────────────────────
export async function handleListTaxCategories(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  await ensureDefaultTaxCategories(env, userId);

  const rows = await env.DB.prepare(
    `SELECT id, slug, name, form_line, category_group, is_active, created_at
     FROM tax_categories
     WHERE user_id = ?
     ORDER BY category_group ASC, is_active DESC, name ASC`,
  ).bind(userId).all();

  return jsonOk({ categories: rows.results });
}

// ── POST /tax/categories ──────────────────────────────────────────────────────
export async function handleCreateTaxCategory(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO tax_categories (id, user_id, slug, name, form_line, category_group, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).bind(id, userId, parsed.data.slug, parsed.data.name, parsed.data.form_line ?? null, parsed.data.category_group).run();
  } catch (err) {
    const msg = String(err);
    if (msg.includes('UNIQUE')) return jsonError(`Category "${parsed.data.slug}" already exists`, 409);
    throw err;
  }

  return jsonOk({ id, ...parsed.data, is_active: true }, 201);
}

// ── PATCH /tax/categories/:slug ───────────────────────────────────────────────
export async function handleUpdateTaxCategory(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (parsed.data.name !== undefined) {
    updates.push('name = ?');
    values.push(parsed.data.name);
  }
  if (parsed.data.form_line !== undefined) {
    updates.push('form_line = ?');
    values.push(parsed.data.form_line);
  }
  if (parsed.data.is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(parsed.data.is_active ? 1 : 0);
  }

  if (!updates.length) return jsonError('No fields to update');

  values.push(userId, slug);
  const result = await env.DB.prepare(
    `UPDATE tax_categories SET ${updates.join(', ')} WHERE user_id = ? AND slug = ?`,
  ).bind(...values).run();

  if (!result.meta.changes) return jsonError('Category not found', 404);

  return jsonOk({ slug, updated: parsed.data });
}
