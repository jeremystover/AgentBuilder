import type { Env } from '../types';

export interface ActiveTaxYearWorkflow {
  id: string;
  tax_year: number;
  is_active: number;
  created_at: string;
  started_at: string;
}

export interface TaxYearChecklistItem {
  id: string;
  item_key: string;
  label: string;
  source_type: 'teller' | 'csv' | 'amazon';
  provider: string | null;
  account_name: string | null;
  account_id: string | null;
  completed_at: string | null;
  sort_order: number;
}

export interface TaxYearChecklistTemplateItem {
  item_key: string;
  label: string;
  source_type: 'teller' | 'csv' | 'amazon';
  provider?: string | null;
  account_name?: string | null;
  create_manual_account?: boolean;
  manual_account_subtype?: string | null;
  sort_order?: number;
}

export function getTaxYearDateRange(taxYear: number): { dateFrom: string; dateTo: string } {
  return {
    dateFrom: `${taxYear}-01-01`,
    dateTo: `${taxYear}-12-31`,
  };
}

export async function getActiveTaxYearWorkflow(
  env: Env,
  userId: string,
): Promise<ActiveTaxYearWorkflow | null> {
  return env.DB.prepare(
    `SELECT id, tax_year, is_active, created_at, started_at
     FROM tax_year_workflows
     WHERE user_id = ? AND is_active = 1
     ORDER BY tax_year DESC
     LIMIT 1`,
  ).bind(userId).first<ActiveTaxYearWorkflow>();
}

export async function getActiveTaxYearOrThrow(env: Env, userId: string): Promise<ActiveTaxYearWorkflow> {
  const workflow = await getActiveTaxYearWorkflow(env, userId);
  if (!workflow) {
    throw new Error('Create a tax year first to start importing transactions.');
  }
  return workflow;
}

export async function reconcileChecklistAccountLinks(
  env: Env,
  userId: string,
  workflowId: string,
): Promise<void> {
  const items = await env.DB.prepare(
    `SELECT id, provider, account_name
     FROM tax_year_checklist_items
     WHERE user_id = ?
       AND tax_year_workflow_id = ?
       AND account_id IS NULL
       AND account_name IS NOT NULL`,
  ).bind(userId, workflowId).all<{ id: string; provider: string | null; account_name: string }>();

  for (const item of items.results) {
    const account = await env.DB.prepare(
      `SELECT id
       FROM accounts
       WHERE user_id = ?
         AND lower(name) = lower(?)
         AND is_active = 1
         AND (
           ? IS NULL
           OR (? = 'teller' AND teller_account_id IS NOT NULL)
           OR (? = 'manual' AND teller_account_id IS NULL AND plaid_account_id IS NULL)
         )
       ORDER BY created_at ASC
       LIMIT 1`,
    ).bind(userId, item.account_name, item.provider, item.provider, item.provider).first<{ id: string }>();

    if (!account) continue;

    await env.DB.prepare(
      'UPDATE tax_year_checklist_items SET account_id = ? WHERE id = ?',
    ).bind(account.id, item.id).run();
  }
}

export async function markChecklistItemsCompleteForAccounts(
  env: Env,
  userId: string,
  workflowId: string,
  accountIds: string[],
): Promise<void> {
  if (!accountIds.length) return;
  const placeholders = accountIds.map(() => '?').join(', ');
  await env.DB.prepare(
    `UPDATE tax_year_checklist_items
     SET completed_at = COALESCE(completed_at, datetime('now'))
     WHERE user_id = ?
       AND tax_year_workflow_id = ?
       AND account_id IN (${placeholders})`,
  ).bind(userId, workflowId, ...accountIds).run();
}

export async function markChecklistItemCompleteByKey(
  env: Env,
  userId: string,
  workflowId: string,
  itemKey: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tax_year_checklist_items
     SET completed_at = COALESCE(completed_at, datetime('now'))
     WHERE user_id = ?
       AND tax_year_workflow_id = ?
       AND item_key = ?`,
  ).bind(userId, workflowId, itemKey).run();
}

export async function loadActiveTaxYearSummary(env: Env, userId: string): Promise<{
  workflow: ActiveTaxYearWorkflow | null;
  checklist_items: Array<TaxYearChecklistItem & { is_completed: boolean }>;
  progress: {
    total_items: number;
    completed_items: number;
    pending_items: number;
    pending_review_count: number;
    transactions_in_year: number;
  };
  steps: {
    import_accounts_ready: boolean;
    import_accounts_complete: boolean;
    classify_unlocked: boolean;
    reports_unlocked: boolean;
  };
}> {
  const workflow = await getActiveTaxYearWorkflow(env, userId);
  if (!workflow) {
    return {
      workflow: null,
      checklist_items: [],
      progress: {
        total_items: 0,
        completed_items: 0,
        pending_items: 0,
        pending_review_count: 0,
        transactions_in_year: 0,
      },
      steps: {
        import_accounts_ready: false,
        import_accounts_complete: false,
        classify_unlocked: false,
        reports_unlocked: false,
      },
    };
  }

  await reconcileChecklistAccountLinks(env, userId, workflow.id);
  const { dateFrom, dateTo } = getTaxYearDateRange(workflow.tax_year);

  const [items, pendingReviewRow, txCountRow] = await Promise.all([
    env.DB.prepare(
      `SELECT id, item_key, label, source_type, provider, account_name, account_id, completed_at, sort_order
       FROM tax_year_checklist_items
       WHERE user_id = ? AND tax_year_workflow_id = ?
       ORDER BY sort_order ASC, label ASC`,
    ).bind(userId, workflow.id).all<TaxYearChecklistItem>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM review_queue rq
       JOIN transactions t ON t.id = rq.transaction_id
       WHERE rq.user_id = ?
         AND rq.status = 'pending'
         AND t.posted_date BETWEEN ? AND ?`,
    ).bind(userId, dateFrom, dateTo).first<{ total: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM transactions
       WHERE user_id = ?
         AND posted_date BETWEEN ? AND ?`,
    ).bind(userId, dateFrom, dateTo).first<{ total: number }>(),
  ]);

  const checklistItems = items.results.map(item => ({
    ...item,
    is_completed: Boolean(item.completed_at),
  }));
  const totalItems = checklistItems.length;
  const completedItems = checklistItems.filter(item => item.is_completed).length;
  const pendingReviewCount = pendingReviewRow?.total ?? 0;
  const transactionsInYear = txCountRow?.total ?? 0;
  const importAccountsComplete = totalItems > 0 && completedItems === totalItems;

  return {
    workflow,
    checklist_items: checklistItems,
    progress: {
      total_items: totalItems,
      completed_items: completedItems,
      pending_items: Math.max(0, totalItems - completedItems),
      pending_review_count: pendingReviewCount,
      transactions_in_year: transactionsInYear,
    },
    steps: {
      import_accounts_ready: true,
      import_accounts_complete: importAccountsComplete,
      classify_unlocked: importAccountsComplete,
      reports_unlocked: importAccountsComplete && pendingReviewCount === 0 && transactionsInYear > 0,
    },
  };
}
