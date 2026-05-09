import { z } from 'zod';
import type { Env, Entity } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';

// ── GET /accounts ─────────────────────────────────────────────────────────────
export async function handleListAccounts(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const accounts = await env.DB.prepare(
    `SELECT a.*,
            COALESCE(pi.institution_name, te.institution_name) AS institution_name,
            CASE
              WHEN a.teller_account_id IS NOT NULL THEN 'teller'
              WHEN a.plaid_account_id IS NOT NULL THEN 'plaid'
              ELSE 'manual'
            END AS provider
     FROM accounts a
     LEFT JOIN plaid_items pi ON pi.id = a.plaid_item_id
     LEFT JOIN teller_enrollments te ON te.id = a.teller_enrollment_id
     WHERE a.user_id = ? AND a.is_active = 1
     ORDER BY COALESCE(pi.institution_name, te.institution_name), a.name`,
  ).bind(userId).all();
  return jsonOk({ accounts: accounts.results });
}

// ── PATCH /accounts/:id ───────────────────────────────────────────────────────
const ENTITY_VALUES: [Entity, ...Entity[]] = ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'];

const UpdateAccountSchema = z.object({
  owner_tag: z.enum(ENTITY_VALUES).nullable().optional(),
  name: z.string().min(1).optional(),
  is_active: z.boolean().optional(),
});

export async function handleUpdateAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = UpdateAccountSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const existing = await env.DB.prepare(
    'SELECT id, name FROM accounts WHERE id = ? AND user_id = ?',
  ).bind(accountId, userId).first<{ id: string; name: string }>();
  if (!existing) return jsonError('Account not found', 404);

  const { owner_tag, name, is_active } = parsed.data;
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (owner_tag !== undefined) { sets.push('owner_tag = ?'); vals.push(owner_tag); }
  if (name !== undefined)      { sets.push('name = ?');      vals.push(name); }
  if (is_active !== undefined) { sets.push('is_active = ?'); vals.push(is_active ? 1 : 0); }

  if (!sets.length) return jsonError('No fields to update');

  vals.push(accountId);
  await env.DB.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();

  // Keep a low-priority account_id rule in sync with the owner_tag so all
  // transactions from this account are deterministically tagged to the right
  // entity. Priority 1 is the floor — any user/learned rule wins over it.
  if (owner_tag !== undefined) {
    const accountName = name ?? existing.name;
    if (owner_tag) {
      const existingRule = await env.DB.prepare(
        `SELECT id FROM rules WHERE user_id = ? AND match_field = 'account_id' AND match_operator = 'equals' AND match_value = ?`,
      ).bind(userId, accountId).first<{ id: string }>();

      if (existingRule) {
        await env.DB.prepare(
          'UPDATE rules SET entity = ?, name = ?, is_active = 1 WHERE id = ?',
        ).bind(owner_tag, `Account default: ${accountName}`, existingRule.id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO rules (id, user_id, name, match_field, match_operator, match_value, entity, category_tax, category_budget, priority, is_active)
           VALUES (?, ?, ?, 'account_id', 'equals', ?, ?, NULL, NULL, 1, 1)`,
        ).bind(crypto.randomUUID(), userId, `Account default: ${accountName}`, accountId, owner_tag).run();
      }
    } else {
      await env.DB.prepare(
        `DELETE FROM rules WHERE user_id = ? AND match_field = 'account_id' AND match_operator = 'equals' AND match_value = ?`,
      ).bind(userId, accountId).run();
    }
  }

  const updated = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(accountId).first();
  return jsonOk({ account: updated });
}
