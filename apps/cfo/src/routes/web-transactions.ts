/**
 * Approved transactions list + edit endpoints. Field edits update the
 * transactions ledger row in place. Re-opening (status='pending_review')
 * re-stages the originating raw_transactions row — carrying the latest
 * edits forward — and deletes the ledger row, so the item reappears in
 * the review queue.
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db, type Sql } from '../lib/db';

const ALLOWED_SORT = new Set(['date', 'amount', 'description', 'approved_at']);

function transactionsWhere(sql: Sql, url: URL): ReturnType<Sql> {
  const parts: ReturnType<Sql>[] = [sql`t.status = 'approved'`];
  const q = url.searchParams.get('q');
  if (q) {
    const pattern = `%${q}%`;
    parts.push(sql`(t.description ILIKE ${pattern} OR t.merchant ILIKE ${pattern})`);
  }
  const dateFrom = url.searchParams.get('date_from');
  if (dateFrom) parts.push(sql`t.date >= ${dateFrom}`);
  const dateTo = url.searchParams.get('date_to');
  if (dateTo) parts.push(sql`t.date <= ${dateTo}`);
  const entity = url.searchParams.get('entity_id');
  if (entity) parts.push(sql`t.entity_id = ${entity}`);
  const cat = url.searchParams.get('category_id');
  if (cat) parts.push(sql`t.category_id = ${cat}`);
  const acct = url.searchParams.get('account_id');
  if (acct) parts.push(sql`t.account_id = ${acct}`);

  let combined = parts[0]!;
  for (let i = 1; i < parts.length; i++) combined = sql`${combined} AND ${parts[i]!}`;
  return combined;
}

export async function handleListTransactions(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const sortByRaw = url.searchParams.get('sort_by') ?? 'date';
  const sortBy = ALLOWED_SORT.has(sortByRaw) ? sortByRaw : 'date';
  const sortDir = url.searchParams.get('sort_dir') === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? '50')));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));

  const sql = db(env);
  try {
    const where = transactionsWhere(sql, url);
    const totalRows = await sql<Array<{ total: string }>>`SELECT COUNT(*)::text AS total FROM transactions t WHERE ${where}`;
    const total = Number(totalRows[0]?.total ?? 0);

    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT
        t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.amount::text AS amount, t.description, t.merchant,
        t.account_id, a.name AS account_name, a.type AS account_type,
        t.entity_id, e.name AS entity_name,
        t.category_id, c.name AS category_name, c.slug AS category_slug,
        t.classification_method, t.ai_confidence::text AS ai_confidence, t.ai_notes,
        t.human_notes, t.is_transfer, t.is_reimbursable,
        t.status, t.approved_at
      FROM transactions t
      LEFT JOIN gather_accounts a ON a.id = t.account_id
      LEFT JOIN entities e ON e.id = t.entity_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE ${where}
      ORDER BY ${sql.unsafe(`t.${sortBy} ${sortDir}, t.id ${sortDir}`)}
      LIMIT ${limit} OFFSET ${offset}
    `;

    return jsonOk({
      rows: rows.map(r => ({
        ...r,
        amount: Number(r.amount),
        ai_confidence: r.ai_confidence === null ? null : Number(r.ai_confidence),
      })),
      total,
      offset,
      limit,
    });
  } catch (err) {
    return jsonError(`list transactions failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface EditTransactionBody {
  entity_id?: string | null;
  category_id?: string | null;
  human_notes?: string | null;
  is_transfer?: boolean;
  is_reimbursable?: boolean;
  status?: 'pending_review' | 'approved' | 'excluded';
}

interface PeriodWindow { from: string; to: string }

function resolvePeriod(period: string, customFrom?: string, customTo?: string): PeriodWindow {
  const today = new Date();
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const startOfMonth = (offset: number) => {
    const d = new Date(today.getUTCFullYear(), today.getUTCMonth() + offset, 1);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1));
  };
  const endOfMonth = (offset: number) => {
    const d = new Date(today.getUTCFullYear(), today.getUTCMonth() + offset + 1, 0);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  };
  const startOfQuarter = (offset: number) => {
    const baseMonth = Math.floor(today.getUTCMonth() / 3) * 3 + offset * 3;
    return new Date(Date.UTC(today.getUTCFullYear(), baseMonth, 1));
  };
  const endOfQuarter = (offset: number) => {
    const baseMonth = Math.floor(today.getUTCMonth() / 3) * 3 + offset * 3 + 3;
    return new Date(Date.UTC(today.getUTCFullYear(), baseMonth, 0));
  };
  const trailing = (days: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  };
  switch (period) {
    case 'this_month':    return { from: toIso(startOfMonth(0)),   to: toIso(today) };
    case 'last_month':    return { from: toIso(startOfMonth(-1)),  to: toIso(endOfMonth(-1)) };
    case 'this_quarter':  return { from: toIso(startOfQuarter(0)), to: toIso(today) };
    case 'last_quarter':  return { from: toIso(startOfQuarter(-1)),to: toIso(endOfQuarter(-1)) };
    case 'ytd':           return { from: `${today.getUTCFullYear()}-01-01`, to: toIso(today) };
    case 'trailing_30d':  return { from: toIso(trailing(30)), to: toIso(today) };
    case 'trailing_90d':  return { from: toIso(trailing(90)), to: toIso(today) };
    case 'custom':        return { from: customFrom ?? '1970-01-01', to: customTo ?? toIso(today) };
    default:              return { from: toIso(trailing(30)), to: toIso(today) };
  }
}

export async function handleTransactionsSummary(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const period = url.searchParams.get('period') ?? 'trailing_30d';
  const { from, to } = resolvePeriod(period, url.searchParams.get('date_from') ?? undefined, url.searchParams.get('date_to') ?? undefined);
  const entityId = url.searchParams.get('entity_id');

  const sql = db(env);
  try {
    const rows = await sql<Array<{
      entity_id: string | null; entity_name: string | null; entity_type: string | null;
      category_id: string | null; category_name: string | null; category_slug: string | null;
      total: string; tx_count: string;
    }>>`
      SELECT t.entity_id, en.name AS entity_name, en.type AS entity_type,
             t.category_id, c.name AS category_name, c.slug AS category_slug,
             SUM(t.amount)::text AS total, COUNT(*)::text AS tx_count
      FROM transactions t
      LEFT JOIN entities en ON en.id = t.entity_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.status = 'approved'
        AND t.date BETWEEN ${from} AND ${to}
        ${entityId ? sql`AND t.entity_id = ${entityId}` : sql``}
      GROUP BY t.entity_id, en.name, en.type, t.category_id, c.name, c.slug
      ORDER BY en.name NULLS LAST, c.name NULLS LAST
    `;

    return jsonOk({
      period: { from, to },
      rows: rows.map(r => ({
        ...r,
        total: Number(r.total),
        tx_count: Number(r.tx_count),
      })),
    });
  } catch (err) {
    return jsonError(`transactions summary failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdateTransaction(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as EditTransactionBody | null;
  if (!body) return jsonError('invalid body', 400);

  const sql = db(env);
  try {
    if ('entity_id' in body) await sql`UPDATE transactions SET entity_id = ${body.entity_id ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('category_id' in body) await sql`UPDATE transactions SET category_id = ${body.category_id ?? null}, classification_method = 'manual', updated_at = now() WHERE id = ${id}`;
    if ('human_notes' in body) await sql`UPDATE transactions SET human_notes = ${body.human_notes ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('is_transfer' in body) await sql`UPDATE transactions SET is_transfer = ${body.is_transfer ?? false}, updated_at = now() WHERE id = ${id}`;
    if ('is_reimbursable' in body) await sql`UPDATE transactions SET is_reimbursable = ${body.is_reimbursable ?? false}, updated_at = now() WHERE id = ${id}`;
    if (body.status === 'pending_review') {
      const reopened = await reopenToReview(sql, id);
      if (!reopened) return jsonError('cannot re-open: transaction has no originating review row', 409);
      return jsonOk({ ok: true, reopened: true });
    }
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update transaction failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Re-open an approved transaction: re-stage its originating raw_transactions
 * row (carrying the latest classification edits forward) and delete the
 * ledger row, so the item reappears in the review queue. Returns false if
 * the transaction has no raw_id to re-stage.
 */
async function reopenToReview(sql: Sql, id: string): Promise<boolean> {
  const restaged = await sql<Array<{ id: string }>>`
    UPDATE raw_transactions r
    SET status = 'staged', waiting_for = NULL,
        entity_id = t.entity_id, category_id = t.category_id,
        classification_method = t.classification_method,
        ai_confidence = t.ai_confidence, ai_notes = t.ai_notes,
        human_notes = t.human_notes,
        is_transfer = t.is_transfer, is_reimbursable = t.is_reimbursable,
        expense_flag = t.expense_flag
    FROM transactions t
    WHERE t.id = ${id} AND r.id = t.raw_id
    RETURNING r.id
  `;
  if (restaged.length === 0) return false;
  await sql`DELETE FROM transactions WHERE id = ${id}`;
  return true;
}
