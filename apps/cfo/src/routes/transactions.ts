import { z } from 'zod';
import type { Env, Entity } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';
import { maybeLearnRuleFromManualClassification } from '../lib/learned-rules';

// ── GET /transactions ─────────────────────────────────────────────────────────
// Query params: entity, category_tax, account_id, date_from, date_to,
//               review_required, limit (default 100), offset (default 0)
export async function handleListTransactions(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const p = url.searchParams;

  const conditions = ['t.user_id = ?'];
  const vals: unknown[] = [userId];

  if (p.get('entity'))          { conditions.push('c.entity = ?');           vals.push(p.get('entity')); }
  if (p.get('category_tax'))    { conditions.push('c.category_tax = ?');     vals.push(p.get('category_tax')); }
  if (p.get('category_budget')) { conditions.push('c.category_budget = ?'); vals.push(p.get('category_budget')); }
  if (p.get('account_id'))      { conditions.push('t.account_id = ?');       vals.push(p.get('account_id')); }
  if (p.get('date_from'))       { conditions.push('t.posted_date >= ?');     vals.push(p.get('date_from')); }
  if (p.get('date_to'))         { conditions.push('t.posted_date <= ?');     vals.push(p.get('date_to')); }
  if (p.get('review_required')) { conditions.push('c.review_required = ?'); vals.push(p.get('review_required') === 'true' ? 1 : 0); }
  if (p.get('unclassified') === 'true') { conditions.push('c.id IS NULL'); }

  const q = p.get('q')?.trim();
  if (q) {
    conditions.push('(LOWER(t.description) LIKE ? OR LOWER(t.merchant_name) LIKE ?)');
    const pattern = `%${q.toLowerCase()}%`;
    vals.push(pattern, pattern);
  }

  const SORT_COLS: Record<string, string> = {
    posted_date:   't.posted_date',
    amount:        't.amount',
    description:   't.description',
    merchant_name: 't.merchant_name',
    account_name:  'a.name',
    category_tax:  'c.category_tax',
  };
  const sortCol = SORT_COLS[p.get('sort_by') ?? ''] ?? 't.posted_date';
  const sortDir = p.get('sort_dir') === 'asc' ? 'ASC' : 'DESC';

  const limit  = Math.min(parseInt(p.get('limit')  ?? '100'), 500);
  const offset = parseInt(p.get('offset') ?? '0');

  const where = conditions.join(' AND ');

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT t.*, c.entity, c.category_tax, c.category_budget, c.expense_type, c.confidence,
              c.method, c.reason_codes, c.review_required, c.is_locked,
              a.name AS account_name, a.owner_tag, a.type AS account_type
       FROM transactions t
       LEFT JOIN classifications c ON c.transaction_id = t.id
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
    ).bind(...vals, limit, offset).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM transactions t
       LEFT JOIN classifications c ON c.transaction_id = t.id
       WHERE ${where}`,
    ).bind(...vals).first<{ total: number }>(),
  ]);

  return jsonOk({
    transactions: rows.results,
    total: countRow?.total ?? 0,
    limit,
    offset,
  });
}

// ── GET /transactions/:id ─────────────────────────────────────────────────────
export async function handleGetTransaction(request: Request, env: Env, txId: string): Promise<Response> {
  const userId = getUserId(request);

  const [tx, splits, history, attachments, amazon] = await Promise.all([
    env.DB.prepare(
      `SELECT t.*, c.entity, c.category_tax, c.category_budget, c.expense_type, c.confidence,
              c.method, c.reason_codes, c.review_required, c.is_locked,
              a.name AS account_name, a.owner_tag, a.type AS account_type
       FROM transactions t
       LEFT JOIN classifications c ON c.transaction_id = t.id
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.id = ? AND t.user_id = ?`,
    ).bind(txId, userId).first(),
    env.DB.prepare('SELECT * FROM transaction_splits WHERE transaction_id = ?').bind(txId).all(),
    env.DB.prepare('SELECT * FROM classification_history WHERE transaction_id = ? ORDER BY changed_at DESC').bind(txId).all(),
    env.DB.prepare('SELECT id, filename, content_type, size_bytes, note, created_at FROM attachments WHERE transaction_id = ?').bind(txId).all(),
    env.DB.prepare(
      `SELECT ao.order_id, ao.order_date, ao.shipment_date, ao.total_amount, ao.product_names,
              ao.seller_names, ao.ship_to, ao.shipping_address, atm.match_score, atm.match_method
       FROM amazon_transaction_matches atm
       JOIN amazon_orders ao ON ao.id = atm.amazon_order_id
       WHERE atm.transaction_id = ?`,
    ).bind(txId).all(),
  ]);

  if (!tx) return jsonError('Transaction not found', 404);

  return jsonOk({
    transaction: tx,
    splits: splits.results,
    history: history.results,
    attachments: attachments.results,
    amazon_matches: amazon.results,
  });
}

// ── DELETE /transactions/:id ─────────────────────────────────────────────────
export async function handleDeleteTransaction(request: Request, env: Env, txId: string): Promise<Response> {
  const userId = getUserId(request);

  const tx = await env.DB.prepare(
    `SELECT t.id, t.import_id, COALESCE(c.is_locked, 0) AS is_locked
     FROM transactions t
     LEFT JOIN classifications c ON c.transaction_id = t.id
     WHERE t.id = ? AND t.user_id = ?`,
  ).bind(txId, userId).first<{ id: string; import_id: string | null; is_locked: number }>();

  if (!tx) return jsonError('Transaction not found', 404);
  if (tx.is_locked) return jsonError('This transaction is locked in a filing snapshot', 403);

  await env.DB.prepare(
    'DELETE FROM transactions WHERE id = ? AND user_id = ?',
  ).bind(txId, userId).run();

  if (tx.import_id) {
    await env.DB.prepare(
      `DELETE FROM imports
       WHERE id = ?
         AND user_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM transactions
           WHERE import_id = ?
         )`,
    ).bind(tx.import_id, userId, tx.import_id).run();
  }

  return jsonOk({ deleted: true, transaction_id: txId });
}

// ── PATCH /transactions/:id/classify ─────────────────────────────────────────
const ClassifySchema = z.object({
  entity: z.enum(['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal']).optional(),
  category_tax: z.string().min(1),
  category_budget: z.string().optional(),
  expense_type: z.enum(['recurring', 'one_time']).nullable().optional(),
  note: z.string().optional(),
});

export async function handleManualClassify(request: Request, env: Env, txId: string): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = ClassifySchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const tx = await env.DB.prepare(
    'SELECT id FROM transactions WHERE id = ? AND user_id = ?',
  ).bind(txId, userId).first();
  if (!tx) return jsonError('Transaction not found', 404);

  const existing = await env.DB.prepare(
    'SELECT * FROM classifications WHERE transaction_id = ?',
  ).bind(txId).first<{ entity: string; category_tax: string; is_locked: number }>();

  if (existing?.is_locked) return jsonError('This transaction is locked in a filing snapshot', 403);

  // Log history if reclassifying
  if (existing) {
    await env.DB.prepare(
      `INSERT INTO classification_history
         (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes, changed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    ).bind(
      crypto.randomUUID(), txId,
      existing.entity, existing.category_tax, null, null, null, null,
    ).run();
  }

  const { entity = null, category_tax, category_budget, expense_type } = parsed.data;
  const classId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO classifications
       (id, transaction_id, entity, category_tax, category_budget, expense_type, confidence, method, review_required, classified_by)
     VALUES (?, ?, ?, ?, ?, ?, 1.0, 'manual', 0, 'user')
     ON CONFLICT(transaction_id) DO UPDATE SET
       entity=excluded.entity, category_tax=excluded.category_tax,
       category_budget=excluded.category_budget, expense_type=excluded.expense_type,
       confidence=1.0,
       method='manual', review_required=0, classified_by='user',
       classified_at=datetime('now')`,
  ).bind(classId, txId, entity, category_tax, category_budget ?? null, expense_type ?? null).run();

  if (entity) {
    await maybeLearnRuleFromManualClassification(env, userId, txId, {
      entity,
      category_tax,
      category_budget: category_budget ?? null,
    });
  }

  // Resolve any open review queue item
  await env.DB.prepare(
    `UPDATE review_queue SET status='resolved', resolved_by='user', resolved_at=datetime('now')
     WHERE transaction_id = ? AND status = 'pending'`,
  ).bind(txId).run();

  const updated = await env.DB.prepare(
    `SELECT t.*, c.entity, c.category_tax, c.category_budget, c.expense_type, c.confidence, c.method
     FROM transactions t JOIN classifications c ON c.transaction_id = t.id
     WHERE t.id = ?`,
  ).bind(txId).first();

  return jsonOk({ transaction: updated });
}

// ── POST /transactions/:id/split ──────────────────────────────────────────────
const SplitItemSchema = z.object({
  entity: z.enum(['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal']),
  category_tax: z.string().optional(),
  amount: z.number(),
  note: z.string().optional(),
});

export async function handleSplitTransaction(request: Request, env: Env, txId: string): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const splits = z.array(SplitItemSchema).safeParse(body);
  if (!splits.success) return jsonError(splits.error.message);

  const tx = await env.DB.prepare(
    'SELECT id, amount FROM transactions WHERE id = ? AND user_id = ?',
  ).bind(txId, userId).first<{ id: string; amount: number }>();
  if (!tx) return jsonError('Transaction not found', 404);

  const totalSplit = splits.data.reduce((sum, s) => sum + Math.abs(s.amount), 0);
  if (Math.abs(totalSplit - Math.abs(tx.amount)) > 0.02) {
    return jsonError(`Split amounts ($${totalSplit.toFixed(2)}) must equal transaction amount ($${Math.abs(tx.amount).toFixed(2)})`);
  }

  // Clear old splits
  await env.DB.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').bind(txId).run();

  for (const split of splits.data) {
    await env.DB.prepare(
      `INSERT INTO transaction_splits (id, transaction_id, entity, category_tax, amount, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), txId, split.entity, split.category_tax ?? null, split.amount, split.note ?? null).run();
  }

  // Mark classification as manual with review resolved
  await env.DB.prepare(
    `INSERT INTO classifications
       (id, transaction_id, entity, category_tax, confidence, method, review_required, classified_by, reason_codes)
     VALUES (?, ?, 'family_personal', 'split', 1.0, 'manual', 0, 'user', '["split_transaction"]')
     ON CONFLICT(transaction_id) DO UPDATE SET
       method='manual', review_required=0, classified_by='user', reason_codes='["split_transaction"]',
       classified_at=datetime('now')`,
  ).bind(crypto.randomUUID(), txId).run();

  await env.DB.prepare(
    `UPDATE review_queue SET status='resolved', resolved_by='user', resolved_at=datetime('now')
     WHERE transaction_id = ? AND status = 'pending'`,
  ).bind(txId).run();

  const savedSplits = await env.DB.prepare(
    'SELECT * FROM transaction_splits WHERE transaction_id = ?',
  ).bind(txId).all();

  return jsonOk({ splits: savedSplits.results });
}
