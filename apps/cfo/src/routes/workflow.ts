import { z } from 'zod';
import type { Env } from '../types';
import { getUserId, jsonError, jsonOk } from '../types';
import { loadActiveTaxYearSummary, reconcileChecklistAccountLinks, type TaxYearChecklistTemplateItem } from '../lib/tax-year';

const ChecklistItemSchema = z.object({
  item_key: z.string().min(1),
  label: z.string().min(1),
  source_type: z.enum(['teller', 'csv', 'amazon']),
  provider: z.string().min(1).nullable().optional(),
  account_name: z.string().min(1).nullable().optional(),
  create_manual_account: z.boolean().optional(),
  manual_account_subtype: z.string().min(1).nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
});

const CreateTaxYearSchema = z.object({
  tax_year: z.number().int().min(2000).max(2100),
  checklist_items: z.array(ChecklistItemSchema).min(1).max(50),
});

async function ensureManualAccount(
  env: Env,
  userId: string,
  item: TaxYearChecklistTemplateItem,
): Promise<string | null> {
  if (!item.account_name) return null;

  const existing = await env.DB.prepare(
    `SELECT id
     FROM accounts
     WHERE user_id = ?
       AND lower(name) = lower(?)
       AND teller_account_id IS NULL
       AND plaid_account_id IS NULL
     LIMIT 1`,
  ).bind(userId, item.account_name).first<{ id: string }>();

  if (existing) {
    await env.DB.prepare(
      `UPDATE accounts
       SET is_active = 1,
           type = COALESCE(type, 'manual'),
           subtype = COALESCE(subtype, ?)
       WHERE id = ?`,
    ).bind(item.manual_account_subtype ?? null, existing.id).run();
    return existing.id;
  }

  const accountId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO accounts
       (id, user_id, name, type, subtype, owner_tag, is_active)
     VALUES (?, ?, ?, 'manual', ?, NULL, 1)`,
  ).bind(accountId, userId, item.account_name, item.manual_account_subtype ?? null).run();

  return accountId;
}

export async function handleGetTaxYearWorkflow(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const summary = await loadActiveTaxYearSummary(env, userId);

  return jsonOk({
    recommended_tax_year: new Date().getFullYear() - 1,
    ...summary,
  });
}

export async function handleCreateTaxYearWorkflow(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = CreateTaxYearSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const { tax_year: taxYear, checklist_items: checklistItems } = parsed.data;

  await env.DB.prepare(
    `UPDATE tax_year_workflows
     SET is_active = 0
     WHERE user_id = ?`,
  ).bind(userId).run();

  const workflowId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO tax_year_workflows (id, user_id, tax_year, is_active, started_at)
     VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT(user_id, tax_year) DO UPDATE SET
       is_active = 1,
       started_at = datetime('now')`,
  ).bind(workflowId, userId, taxYear).run();

  const workflow = await env.DB.prepare(
    `SELECT id
     FROM tax_year_workflows
     WHERE user_id = ? AND tax_year = ?
     LIMIT 1`,
  ).bind(userId, taxYear).first<{ id: string }>();

  if (!workflow) return jsonError('Could not initialize tax year workflow', 500);

  await env.DB.prepare(
    'DELETE FROM tax_year_checklist_items WHERE tax_year_workflow_id = ?',
  ).bind(workflow.id).run();

  for (const [index, item] of checklistItems.entries()) {
    let accountId: string | null = null;

    if (item.create_manual_account) {
      accountId = await ensureManualAccount(env, userId, item);
    } else if (item.account_name) {
      const existingAccount = await env.DB.prepare(
        `SELECT id
         FROM accounts
         WHERE user_id = ?
           AND lower(name) = lower(?)
           AND is_active = 1
         LIMIT 1`,
      ).bind(userId, item.account_name).first<{ id: string }>();
      accountId = existingAccount?.id ?? null;
    }

    await env.DB.prepare(
      `INSERT INTO tax_year_checklist_items
         (id, tax_year_workflow_id, user_id, item_key, label, source_type, provider, account_name, account_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      workflow.id,
      userId,
      item.item_key,
      item.label,
      item.source_type,
      item.provider ?? null,
      item.account_name ?? null,
      accountId,
      item.sort_order ?? index,
    ).run();
  }

  await reconcileChecklistAccountLinks(env, userId, workflow.id);
  const summary = await loadActiveTaxYearSummary(env, userId);

  return jsonOk({
    ...summary,
    message: `Tax year ${taxYear} is ready. Step 1 is to import every account for the full year.`,
  }, 201);
}
