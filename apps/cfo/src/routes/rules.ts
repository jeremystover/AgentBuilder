import { z } from 'zod';
import type { Env } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';
import { parseCsv } from '../lib/dedup';
import { mapCategory } from './tiller';

const RuleSchema = z.object({
  name:           z.string().min(1),
  match_field:    z.enum(['merchant_name', 'description', 'account_id', 'amount']),
  match_operator: z.enum(['contains', 'equals', 'starts_with', 'ends_with', 'regex']),
  match_value:    z.string().min(1),
  entity:         z.enum(['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal']),
  category_tax:   z.string().optional(),
  category_budget:z.string().optional(),
  priority:       z.number().int().default(0),
  is_active:      z.boolean().default(true),
});

// ── GET /rules ────────────────────────────────────────────────────────────────
export async function handleListRules(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const rules = await env.DB.prepare(
    'SELECT * FROM rules WHERE user_id = ? ORDER BY priority DESC, created_at',
  ).bind(userId).all();
  return jsonOk({ rules: rules.results });
}

// ── POST /rules ───────────────────────────────────────────────────────────────
export async function handleCreateRule(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = RuleSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const { name, match_field, match_operator, match_value, entity, category_tax, category_budget, priority, is_active } = parsed.data;
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, name, match_field, match_operator, match_value, entity, category_tax, category_budget, priority, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, userId, name, match_field, match_operator, match_value, entity, category_tax ?? null, category_budget ?? null, priority, is_active ? 1 : 0).run();

  const rule = await env.DB.prepare('SELECT * FROM rules WHERE id = ?').bind(id).first();
  return jsonOk({ rule }, 201);
}

// ── PUT /rules/:id ────────────────────────────────────────────────────────────
export async function handleUpdateRule(request: Request, env: Env, ruleId: string): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = RuleSchema.partial().safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const existing = await env.DB.prepare(
    'SELECT id FROM rules WHERE id = ? AND user_id = ?',
  ).bind(ruleId, userId).first();
  if (!existing) return jsonError('Rule not found', 404);

  const sets: string[] = [];
  const vals: unknown[] = [];

  for (const [key, val] of Object.entries(parsed.data)) {
    if (val !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(key === 'is_active' ? (val ? 1 : 0) : val);
    }
  }

  if (!sets.length) return jsonError('No fields to update');
  vals.push(ruleId);

  await env.DB.prepare(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();

  const rule = await env.DB.prepare('SELECT * FROM rules WHERE id = ?').bind(ruleId).first();
  return jsonOk({ rule });
}

// ── POST /rules/import-autocat ────────────────────────────────────────────────
export async function handleAutoCatImport(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return jsonError('Expected multipart/form-data with a "file" field'); }

  const fileField = formData.get('file');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!fileField || typeof (fileField as any).text !== 'function') {
    return jsonError('"file" field is required');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const csvText = await (fileField as any).text() as string;
  const rows = parseCsv(csvText);
  if (!rows.length) return jsonError('CSV is empty or has no data rows');

  // Verify AutoCat format (headers after normalization: category, description_contains, ...)
  const firstRow = rows[0];
  const keys = Object.keys(firstRow);
  if (!keys.includes('category') || !keys.includes('description_contains')) {
    return jsonError('File does not appear to be a Tiller AutoCat export. Expected columns: Category, Description Contains.');
  }

  let created = 0;
  let skipped = 0;
  let skippedTransfers = 0;
  const warnings: string[] = [];

  for (const row of rows) {
    const rawCategory    = (row['category'] ?? '').trim();
    const descContains   = (row['description_contains'] ?? '').trim();
    const acctContains   = (row['account_contains'] ?? '').trim();
    const instContains   = (row['institution_contains'] ?? '').trim();

    if (!rawCategory) { skipped++; continue; }

    if (!descContains) {
      // Account/institution matching not yet supported
      if (acctContains || instContains) {
        const note = `"${rawCategory}" skipped — only has Account/Institution match (not supported)`;
        if (!warnings.includes(note)) warnings.push(note);
      }
      skipped++;
      continue;
    }

    const mapping = mapCategory(rawCategory);
    if (!mapping) { skippedTransfers++; continue; }

    // Skip duplicates (same description contains value already exists)
    const existing = await env.DB.prepare(
      `SELECT id FROM rules WHERE user_id = ? AND match_field = 'description' AND match_operator = 'contains' AND lower(match_value) = lower(?)`,
    ).bind(userId, descContains).first();
    if (existing) { skipped++; continue; }

    const id = crypto.randomUUID();
    const name = `${descContains} → ${rawCategory}`;
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, name, match_field, match_operator, match_value, entity, category_tax, category_budget, priority, is_active)
       VALUES (?, ?, ?, 'description', 'contains', ?, ?, ?, null, 50, 1)`,
    ).bind(id, userId, name, descContains, mapping.entity, mapping.category_tax).run();

    created++;
  }

  return jsonOk({
    total_rows: rows.length,
    rules_created: created,
    skipped,
    skipped_transfers: skippedTransfers,
    warnings: warnings.slice(0, 15),
    message: created > 0
      ? `Created ${created} rules from AutoCat. Use the review queue's classify button to apply them.`
      : 'No new rules created (all rows skipped or already exist).',
  }, 201);
}

// ── DELETE /rules/:id ─────────────────────────────────────────────────────────
export async function handleDeleteRule(request: Request, env: Env, ruleId: string): Promise<Response> {
  const userId = getUserId(request);

  const existing = await env.DB.prepare(
    'SELECT id FROM rules WHERE id = ? AND user_id = ?',
  ).bind(ruleId, userId).first();
  if (!existing) return jsonError('Rule not found', 404);

  await env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(ruleId).run();
  return jsonOk({ deleted: ruleId });
}
