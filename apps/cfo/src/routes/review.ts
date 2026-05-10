import { z } from 'zod';
import type { Env } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';
import { maybeLearnRuleFromManualClassification } from '../lib/learned-rules';
import { backfillUnclassifiedReviewQueue } from '../lib/review-queue';
import { getNextInterviewItem } from '../lib/review-interview';

// ── GET /review ───────────────────────────────────────────────────────────────
export async function handleListReview(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  await backfillUnclassifiedReviewQueue(env, userId);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? 'pending';
  const categoryTax = url.searchParams.get('category_tax');
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  ?? '50'), 200);
  const offset = parseInt(url.searchParams.get('offset') ?? '0');

  const q = url.searchParams.get('q')?.trim();
  const SORT_COLS: Record<string, string> = {
    posted_date:   't.posted_date',
    amount:        't.amount',
    description:   't.description',
    merchant_name: 't.merchant_name',
    account_name:  'a.name',
    created_at:    'rq.created_at',
  };
  const sortCol = SORT_COLS[url.searchParams.get('sort_by') ?? ''] ?? 'rq.created_at';
  const sortDir = url.searchParams.get('sort_dir') === 'asc' ? 'ASC' : 'DESC';

  const conditions = ['rq.user_id = ?', 'rq.status = ?'];
  const values: unknown[] = [userId, status];

  if (categoryTax === '__uncategorized__') {
    conditions.push('COALESCE(rq.suggested_category_tax, c.category_tax) IS NULL');
  } else if (categoryTax) {
    conditions.push('COALESCE(rq.suggested_category_tax, c.category_tax) = ?');
    values.push(categoryTax);
  }

  if (q) {
    conditions.push('(LOWER(t.description) LIKE ? OR LOWER(t.merchant_name) LIKE ?)');
    const pattern = `%${q.toLowerCase()}%`;
    values.push(pattern, pattern);
  }

  const fromClause = `FROM review_queue rq
       JOIN transactions t ON t.id = rq.transaction_id
       LEFT JOIN accounts a ON a.id = t.account_id
       LEFT JOIN classifications c ON c.transaction_id = t.id`;
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const [items, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT rq.*, t.posted_date, t.amount, t.merchant_name, t.description,
              a.name AS account_name, a.owner_tag, a.type AS account_type, a.subtype AS account_subtype,
              c.entity AS current_entity, c.category_tax AS current_category_tax, c.confidence AS current_confidence
       ${fromClause}
       ${whereClause}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
    ).bind(...values, limit, offset).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total
       ${fromClause}
       ${whereClause}`,
    ).bind(...values).first<{ total: number }>(),
  ]);

  return jsonOk({ items: items.results, total: countRow?.total ?? 0, limit, offset });
}

// ── GET /review/next ─────────────────────────────────────────────────────────
// Interview mode — returns a single pending item with full context
// (historical precedent, matching rules, similar merchants) so a model or
// human can make a confident call without running multiple follow-up
// queries. See lib/review-interview.ts for the enrichment logic.
export async function handleNextReviewItem(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const item = await getNextInterviewItem(env, userId);
  if (!item) {
    return jsonOk({ empty: true, message: 'Review queue is empty — nothing to interview.' });
  }
  return jsonOk(item);
}

// ── PATCH /review/:id ─────────────────────────────────────────────────────────
const ResolveSchema = z.object({
  action: z.enum(['accept', 'classify', 'skip', 'reopen']),
  entity: z.enum(['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal']).optional(),
  category_tax: z.string().optional(),
  category_budget: z.string().optional(),
  expense_type: z.enum(['recurring', 'one_time']).nullable().optional(),
  cut_status: z.enum(['flagged', 'complete']).nullable().optional(),
});

const BulkResolveSchema = ResolveSchema.extend({
  review_ids: z.array(z.string().min(1)).max(1000).optional(),
  apply_to_filtered: z.boolean().optional(),
  status: z.enum(['pending', 'resolved', 'skipped']).optional(),
  filter_category_tax: z.string().optional(),
}).superRefine((data, ctx) => {
  if ((!data.review_ids || data.review_ids.length === 0) && !data.apply_to_filtered) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide review_ids or set apply_to_filtered=true',
      path: ['review_ids'],
    });
  }
});

type ReviewItem = {
  id: string;
  transaction_id: string;
  status: string;
  reason: string;
  is_locked?: number;
};

async function resolveReviewItem(
  env: Env,
  userId: string,
  item: ReviewItem,
  action: 'accept' | 'classify' | 'skip' | 'reopen',
  entity?: 'elyse_coaching' | 'jeremy_coaching' | 'airbnb_activity' | 'family_personal',
  category_tax?: string,
  category_budget?: string,
  expense_type?: 'recurring' | 'one_time' | null,
  cut_status?: 'flagged' | 'complete' | null,
): Promise<'pending' | 'resolved' | 'skipped'> {
  if (action === 'reopen') {
    if (item.status === 'pending') throw new Error('Review item is already pending');

    await env.DB.prepare(
      `UPDATE review_queue
       SET status='pending', resolved_by=NULL, resolved_at=NULL
       WHERE id=?`,
    ).bind(item.id).run();

    await env.DB.prepare(
      `UPDATE classifications
       SET review_required=1
       WHERE transaction_id=?`,
    ).bind(item.transaction_id).run();

    return 'pending';
  }

  if (item.status !== 'pending') throw new Error('Review item must be reopened before it can be changed');

  if (action === 'classify') {
    const isTransfer = category_tax === 'transfer';
    if (!isTransfer && (!entity || !category_tax)) throw new Error('entity and category_tax required for classify action');
    if (item.is_locked) throw new Error('This transaction is locked in a filing snapshot');

    const existing = await env.DB.prepare(
      'SELECT entity, category_tax, category_budget, confidence, method FROM classifications WHERE transaction_id = ?',
    ).bind(item.transaction_id).first<{ entity: string; category_tax: string; category_budget: string; confidence: number; method: string }>();

    if (existing) {
      await env.DB.prepare(
        `INSERT INTO classification_history
           (id, transaction_id, entity, category_tax, category_budget, confidence, method, changed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'user')`,
      ).bind(
        crypto.randomUUID(), item.transaction_id,
        existing.entity, existing.category_tax, existing.category_budget, existing.confidence, existing.method,
      ).run();
    }

    await env.DB.prepare(
      `INSERT INTO classifications
         (id, transaction_id, entity, category_tax, category_budget, expense_type, cut_status, confidence, method, reason_codes, review_required, classified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 'manual', '["manual_review"]', 0, 'user')
       ON CONFLICT(transaction_id) DO UPDATE SET
         entity=excluded.entity, category_tax=excluded.category_tax,
         category_budget=excluded.category_budget, expense_type=excluded.expense_type,
         cut_status=excluded.cut_status,
         confidence=1.0,
         method='manual', review_required=0, classified_by='user',
         classified_at=datetime('now')`,
    ).bind(crypto.randomUUID(), item.transaction_id, entity ?? null, category_tax, category_budget ?? null, expense_type ?? null, cut_status ?? null).run();

    if (entity) {
      await maybeLearnRuleFromManualClassification(env, userId, item.transaction_id, {
        entity,
        category_tax,
        category_budget: category_budget ?? null,
      });
    }
  }

  if (action === 'accept') {
    const existing = await env.DB.prepare(
      'SELECT id, is_locked FROM classifications WHERE transaction_id = ?',
    ).bind(item.transaction_id).first<{ id: string; is_locked: number }>();

    if (!existing) throw new Error('This review item must be classified before it can be accepted');
    if (existing.is_locked) throw new Error('This transaction is locked in a filing snapshot');

    await env.DB.prepare(
      'UPDATE classifications SET review_required=0 WHERE transaction_id=?',
    ).bind(item.transaction_id).run();
  }

  const newStatus = action === 'skip' ? 'skipped' : 'resolved';
  await env.DB.prepare(
    `UPDATE review_queue SET status=?, resolved_by='user', resolved_at=datetime('now') WHERE id=?`,
  ).bind(newStatus, item.id).run();

  return newStatus;
}

export async function handleResolveReview(request: Request, env: Env, reviewId: string): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = ResolveSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const item = await env.DB.prepare(
    `SELECT rq.id, rq.transaction_id, rq.status, rq.reason, COALESCE(c.is_locked, 0) AS is_locked
     FROM review_queue rq
     LEFT JOIN classifications c ON c.transaction_id = rq.transaction_id
     WHERE rq.id = ? AND rq.user_id = ?`,
  ).bind(reviewId, userId).first<ReviewItem>();

  if (!item) return jsonError('Review item not found', 404);

  const { action, entity, category_tax, category_budget, expense_type, cut_status } = parsed.data;
  try {
    const newStatus = await resolveReviewItem(env, userId, item, action, entity, category_tax, category_budget, expense_type, cut_status);
    return jsonOk({ status: newStatus, transaction_id: item.transaction_id });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err));
  }
}

export async function handleBulkResolveReview(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = BulkResolveSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const { action, entity, category_tax, category_budget, expense_type, cut_status, review_ids, apply_to_filtered, status, filter_category_tax: filterCategoryTax } = parsed.data;
  const effectiveStatus = status ?? 'pending';

  let items: ReviewItem[] = [];

  if (review_ids?.length) {
    const placeholders = review_ids.map(() => '?').join(', ');
    const rows = await env.DB.prepare(
      `SELECT rq.id, rq.transaction_id, rq.status, rq.reason, COALESCE(c.is_locked, 0) AS is_locked
       FROM review_queue rq
       LEFT JOIN classifications c ON c.transaction_id = rq.transaction_id
       WHERE rq.user_id = ?
         AND rq.id IN (${placeholders})`,
    ).bind(userId, ...review_ids).all<ReviewItem>();
    items = rows.results;
  } else if (apply_to_filtered) {
    const conditions = ['rq.user_id = ?', 'rq.status = ?'];
    const values: unknown[] = [userId, effectiveStatus];

    if (filterCategoryTax === '__uncategorized__') {
      conditions.push('COALESCE(rq.suggested_category_tax, c.category_tax) IS NULL');
    } else if (filterCategoryTax) {
      conditions.push('COALESCE(rq.suggested_category_tax, c.category_tax) = ?');
      values.push(filterCategoryTax);
    }

    const rows = await env.DB.prepare(
      `SELECT rq.id, rq.transaction_id, rq.status, rq.reason, COALESCE(c.is_locked, 0) AS is_locked
       FROM review_queue rq
       JOIN transactions t ON t.id = rq.transaction_id
       LEFT JOIN classifications c ON c.transaction_id = rq.transaction_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY rq.created_at DESC
       LIMIT 1000`,
    ).bind(...values).all<ReviewItem>();
    items = rows.results;
  }

  if (!items.length) return jsonError('No review items found', 404);

  const results: Array<{ review_id: string; transaction_id: string; status?: string; error?: string }> = [];
  let updated = 0;

  for (const item of items) {
    try {
      const newStatus = await resolveReviewItem(env, userId, item, action, entity, category_tax, category_budget, expense_type, cut_status);
      results.push({ review_id: item.id, transaction_id: item.transaction_id, status: newStatus });
      updated += 1;
    } catch (err) {
      results.push({
        review_id: item.id,
        transaction_id: item.transaction_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return jsonOk({
    action,
    requested: items.length,
    updated,
    failed: items.length - updated,
    results,
  });
}
