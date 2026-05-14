/**
 * Approved transactions list + edit endpoints. Editing approved
 * transactions sets status='pending_review' which moves them out of this
 * view and back into the review queue (in `transactions`, not back to
 * raw_transactions).
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db, type Sql } from '../lib/db';

const ALLOWED_SORT = new Set(['date', 'amount', 'description', 'approved_at']);

function transactionsWhere(sql: Sql, url: URL): ReturnType<Sql> {
  const parts: ReturnType<Sql>[] = [sql`status = 'approved'`];
  const q = url.searchParams.get('q');
  if (q) {
    const pattern = `%${q}%`;
    parts.push(sql`(description ILIKE ${pattern} OR merchant ILIKE ${pattern})`);
  }
  const dateFrom = url.searchParams.get('date_from');
  if (dateFrom) parts.push(sql`date >= ${dateFrom}`);
  const dateTo = url.searchParams.get('date_to');
  if (dateTo) parts.push(sql`date <= ${dateTo}`);
  const entity = url.searchParams.get('entity_id');
  if (entity) parts.push(sql`entity_id = ${entity}`);
  const cat = url.searchParams.get('category_id');
  if (cat) parts.push(sql`category_id = ${cat}`);
  const acct = url.searchParams.get('account_id');
  if (acct) parts.push(sql`account_id = ${acct}`);

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
    const totalRows = await sql<Array<{ total: string }>>`SELECT COUNT(*)::text AS total FROM transactions WHERE ${where}`;
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
      await sql`UPDATE transactions SET status = 'pending_review', approved_at = NULL, updated_at = now() WHERE id = ${id}`;
    }
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update transaction failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
