/**
 * Review-queue endpoints. The review queue lives on raw_transactions
 * (Phase 1c review-fields columns added in migration 0004). Approval
 * INSERTs into the transactions ledger and marks the raw row 'processed'
 * with raw_payload nulled (data hygiene per CLAUDE.md).
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db, pgArr, withDb, type Sql } from '../lib/db';

const ALLOWED_SORT_COLS = new Set(['date', 'amount', 'description', 'ingest_at']);

interface ReviewFilters {
  status: 'staged' | 'waiting';
  q?: string;
  date_from?: string;
  date_to?: string;
  entity_ids: string[];
  category_ids: string[];
  account_ids: string[];
  confidence?: 'high' | 'medium' | 'low' | 'rule';
}

function parseFilters(url: URL): ReviewFilters {
  const status = url.searchParams.get('status') === 'waiting' ? 'waiting' : 'staged';
  return {
    status,
    q: url.searchParams.get('q') ?? undefined,
    date_from: url.searchParams.get('date_from') ?? undefined,
    date_to: url.searchParams.get('date_to') ?? undefined,
    entity_ids: url.searchParams.getAll('entity_id'),
    category_ids: url.searchParams.getAll('category_id'),
    account_ids: url.searchParams.getAll('account_id'),
    confidence: (url.searchParams.get('confidence') ?? undefined) as ReviewFilters['confidence'],
  };
}

function whereClauses(sql: Sql, f: ReviewFilters): ReturnType<Sql> {
  const parts: ReturnType<Sql>[] = [sql`r.source = 'teller'`, sql`r.status = ${f.status}`];
  if (f.q) {
    const pattern = `%${f.q}%`;
    parts.push(sql`(r.description ILIKE ${pattern} OR r.merchant ILIKE ${pattern})`);
  }
  if (f.date_from) parts.push(sql`r.date >= ${f.date_from}`);
  if (f.date_to) parts.push(sql`r.date <= ${f.date_to}`);
  if (f.entity_ids.length) parts.push(sql`r.entity_id = ANY(${pgArr(f.entity_ids)}::text[])`);
  if (f.category_ids.length) parts.push(sql`r.category_id = ANY(${pgArr(f.category_ids)}::text[])`);
  if (f.account_ids.length) parts.push(sql`r.account_id = ANY(${pgArr(f.account_ids)}::text[])`);
  if (f.confidence === 'high') parts.push(sql`r.ai_confidence >= 0.9`);
  if (f.confidence === 'medium') parts.push(sql`r.ai_confidence >= 0.7 AND r.ai_confidence < 0.9`);
  if (f.confidence === 'low') parts.push(sql`r.ai_confidence IS NOT NULL AND r.ai_confidence < 0.7`);
  if (f.confidence === 'rule') parts.push(sql`r.classification_method = 'rule'`);

  // Combine with AND
  let combined = parts[0]!;
  for (let i = 1; i < parts.length; i++) combined = sql`${combined} AND ${parts[i]!}`;
  return combined;
}

export async function handleListReview(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const f = parseFilters(url);
  const sortByRaw = url.searchParams.get('sort_by') ?? 'date';
  const sortBy = ALLOWED_SORT_COLS.has(sortByRaw) ? sortByRaw : 'date';
  const sortDir = url.searchParams.get('sort_dir') === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? '50')));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));

  try {
    return await withDb(env, async (sql) => {
      const where = whereClauses(sql, f);

      const totalRows = await sql<Array<{ total: string }>>`
        SELECT COUNT(*)::text AS total FROM raw_transactions r WHERE ${where}
      `;
      const total = Number(totalRows[0]?.total ?? 0);

      const rows = await sql<Array<{
        id: string; date: string; amount: string; description: string; merchant: string | null;
        account_id: string | null; account_name: string | null; account_type: string | null;
        entity_id: string | null; category_id: string | null; category_slug: string | null;
        classification_method: string | null; ai_confidence: string | null; ai_notes: string | null;
        human_notes: string | null; is_transfer: boolean; is_reimbursable: boolean;
        status: string; waiting_for: string | null; supplement_json: unknown;
      }>>`
        SELECT
          r.id, to_char(r.date, 'YYYY-MM-DD') AS date, r.amount::text AS amount, r.description, r.merchant,
          r.account_id, a.name AS account_name, a.type AS account_type,
          r.entity_id, r.category_id, c.slug AS category_slug,
          r.classification_method, r.ai_confidence::text AS ai_confidence, r.ai_notes,
          r.human_notes, r.is_transfer, r.is_reimbursable,
          r.status, r.waiting_for, r.supplement_json
        FROM raw_transactions r
        LEFT JOIN gather_accounts a ON a.id = r.account_id
        LEFT JOIN categories c ON c.id = r.category_id
        WHERE ${where}
        ORDER BY ${sql.unsafe(`r.${sortBy} ${sortDir}, r.id ${sortDir}`)}
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
    });
  } catch (err) {
    return jsonError(`list review failed: ${err instanceof Error ? err.stack : JSON.stringify(err)}`, 500);
  }
}

export async function handleGetReview(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT
        r.id, to_char(r.date, 'YYYY-MM-DD') AS date, r.amount::text AS amount, r.description, r.merchant,
        r.account_id, a.name AS account_name, a.type AS account_type,
        r.entity_id, r.category_id, c.slug AS category_slug,
        r.classification_method, r.ai_confidence::text AS ai_confidence, r.ai_notes,
        r.human_notes, r.is_transfer, r.is_reimbursable,
        r.status, r.waiting_for, r.supplement_json
      FROM raw_transactions r
      LEFT JOIN gather_accounts a ON a.id = r.account_id
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) return jsonError('not found', 404);
    const row = rows[0]!;
    return jsonOk({
      ...row,
      amount: Number(row.amount),
      ai_confidence: row.ai_confidence === null ? null : Number(row.ai_confidence),
    });
  } catch (err) {
    return jsonError(`get review failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface UpdateBody {
  entity_id?: string | null;
  category_id?: string | null;
  classification_method?: 'rule' | 'ai' | 'manual' | 'historical';
  human_notes?: string | null;
  is_transfer?: boolean;
  is_reimbursable?: boolean;
}

export async function handleUpdateReview(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as UpdateBody | null;
  if (!body) return jsonError('invalid body', 400);

  const sql = db(env);
  try {
    if ('entity_id' in body) await sql`UPDATE raw_transactions SET entity_id = ${body.entity_id ?? null} WHERE id = ${id}`;
    if ('category_id' in body) {
      await sql`UPDATE raw_transactions SET category_id = ${body.category_id ?? null} WHERE id = ${id}`;
      if (body.category_id) {
        const method = body.classification_method ?? 'manual';
        await sql`UPDATE raw_transactions SET classification_method = ${method} WHERE id = ${id}`;
      }
    }
    if ('human_notes' in body) await sql`UPDATE raw_transactions SET human_notes = ${body.human_notes ?? null} WHERE id = ${id}`;
    if ('is_transfer' in body) await sql`UPDATE raw_transactions SET is_transfer = ${body.is_transfer ?? false} WHERE id = ${id}`;
    if ('is_reimbursable' in body) await sql`UPDATE raw_transactions SET is_reimbursable = ${body.is_reimbursable ?? false} WHERE id = ${id}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update review failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleApproveReview(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const result = await approveOne(sql, id);
    if (!result) return jsonError('not found', 404);
    return jsonOk(result);
  } catch (err) {
    return jsonError(`approve failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface ApproveResult {
  transaction_id: string;
  raw_id: string;
}

async function approveOne(sql: Sql, id: string): Promise<ApproveResult | null> {
  // Read the raw row, INSERT into transactions, mark raw 'processed' and null its raw_payload.
  const inserted = await sql<Array<{ transaction_id: string; raw_id: string }>>`
    WITH src AS (
      SELECT id, account_id, date, amount, description, merchant,
             entity_id, category_id, classification_method,
             ai_confidence, ai_notes, human_notes, is_transfer, is_reimbursable
      FROM raw_transactions WHERE id = ${id}
    ),
    ins AS (
      INSERT INTO transactions
        (raw_id, account_id, date, amount, description, merchant,
         entity_id, category_id, classification_method,
         ai_confidence, ai_notes, human_notes,
         is_transfer, is_reimbursable, status, approved_at)
      SELECT id, account_id, date, amount, description, merchant,
             entity_id, category_id, classification_method,
             ai_confidence, ai_notes, human_notes,
             is_transfer, is_reimbursable, 'approved', now()
      FROM src
      RETURNING id AS transaction_id, raw_id
    ),
    upd AS (
      UPDATE raw_transactions
      SET status = 'processed', raw_payload = NULL
      WHERE id = ${id}
      RETURNING id
    )
    SELECT transaction_id, raw_id FROM ins
  `;
  return inserted[0] ?? null;
}

interface BulkBody {
  action: 'set_entity' | 'set_category' | 'set_transfer' | 'set_reimbursable' | 'approve';
  entity_id?: string;
  category_id?: string;
  is_transfer?: boolean;
  is_reimbursable?: boolean;
  ids?: string[];
  apply_to_filtered?: boolean;
  filters?: Record<string, string | string[]>;
}

export async function handleBulkReview(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as BulkBody | null;
  if (!body) return jsonError('invalid body', 400);

  const sql = db(env);
  try {
    let ids: string[] = body.ids ?? [];
    if (body.apply_to_filtered) {
      const url = new URL('http://x/?' + new URLSearchParams(toFlatParams(body.filters ?? {})).toString());
      const f = parseFilters(url);
      const where = whereClauses(sql, f);
      const rows = await sql<Array<{ id: string }>>`SELECT id FROM raw_transactions WHERE ${where}`;
      ids = rows.map(r => r.id);
    }
    if (ids.length === 0) return jsonOk({ updated: 0 });

    let updated = 0;
    switch (body.action) {
      case 'set_entity':
        if (!body.entity_id) return jsonError('entity_id required', 400);
        await sql`UPDATE raw_transactions SET entity_id = ${body.entity_id} WHERE id = ANY(${pgArr(ids)}::text[])`;
        updated = ids.length;
        break;
      case 'set_category':
        if (!body.category_id) return jsonError('category_id required', 400);
        await sql`UPDATE raw_transactions SET category_id = ${body.category_id}, classification_method = 'manual' WHERE id = ANY(${pgArr(ids)}::text[])`;
        updated = ids.length;
        break;
      case 'set_transfer':
        await sql`UPDATE raw_transactions SET is_transfer = ${body.is_transfer ?? true} WHERE id = ANY(${pgArr(ids)}::text[])`;
        updated = ids.length;
        break;
      case 'set_reimbursable':
        await sql`UPDATE raw_transactions SET is_reimbursable = ${body.is_reimbursable ?? true} WHERE id = ANY(${pgArr(ids)}::text[])`;
        updated = ids.length;
        break;
      case 'approve':
        for (const id of ids) {
          const res = await approveOne(sql, id);
          if (res) updated++;
        }
        break;
      default:
        return jsonError(`unknown action: ${body.action}`, 400);
    }

    return jsonOk({ updated });
  } catch (err) {
    return jsonError(`bulk review failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

function toFlatParams(input: Record<string, string | string[]>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(input)) {
    if (Array.isArray(v)) for (const item of v) out.push([k, item]);
    else if (v != null) out.push([k, v]);
  }
  return out;
}

export async function handleAdvanceWaiting(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    await sql`UPDATE raw_transactions SET status = 'staged', waiting_for = NULL WHERE id = ${id} AND status = 'waiting'`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`advance failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Interview-style endpoint: return the single oldest pending row + a few
 * similar past approved transactions for context. Used by the review_next
 * MCP tool.
 */
export async function handleReviewNext(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const entitySlug = url.searchParams.get('entity_slug') ?? undefined;
  const minConfidence = url.searchParams.get('min_confidence');
  const minConf = minConfidence ? Number(minConfidence) : null;

  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT
        r.id, to_char(r.date, 'YYYY-MM-DD') AS date, r.amount::text AS amount, r.description, r.merchant,
        r.account_id, a.name AS account_name, a.type AS account_type,
        r.entity_id, en.slug AS entity_slug, en.name AS entity_name,
        r.category_id, c.slug AS category_slug, c.name AS category_name,
        r.classification_method, r.ai_confidence::text AS ai_confidence, r.ai_notes,
        r.human_notes, r.is_transfer, r.is_reimbursable,
        r.supplement_json
      FROM raw_transactions r
      LEFT JOIN gather_accounts a ON a.id = r.account_id
      LEFT JOIN entities en ON en.id = r.entity_id
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.source = 'teller'
        AND r.status = 'staged'
        ${entitySlug ? sql`AND en.slug = ${entitySlug}` : sql``}
        ${minConf !== null && Number.isFinite(minConf) ? sql`AND (r.ai_confidence IS NULL OR r.ai_confidence < ${minConf})` : sql``}
      ORDER BY r.date ASC, r.id ASC
      LIMIT 1
    `;
    if (rows.length === 0) return jsonOk({ row: null, similar: [] });
    const row = rows[0]!;
    const amount = Number(row.amount);

    // Similar past transactions: same merchant or near-amount in transactions.
    const merchant = (row.merchant ?? row.description) as string | null;
    const similar = await sql<Array<Record<string, unknown>>>`
      SELECT to_char(t.date, 'YYYY-MM-DD') AS date, t.amount::text AS amount, t.description, t.merchant,
             en.name AS entity_name, c.name AS category_name, c.slug AS category_slug
      FROM transactions t
      LEFT JOIN entities en ON en.id = t.entity_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.status = 'approved'
        AND (
          (${merchant} IS NOT NULL AND t.merchant ILIKE ${merchant})
          OR ABS(t.amount - ${amount}) < 0.01
        )
      ORDER BY t.approved_at DESC
      LIMIT 5
    `;

    return jsonOk({
      row: {
        ...row,
        amount,
        ai_confidence: row.ai_confidence === null ? null : Number(row.ai_confidence),
      },
      similar: similar.map(s => ({ ...s, amount: Number(s.amount) })),
    });
  } catch (err) {
    return jsonError(`review next failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleReviewStatus(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{
      pending_review: string; waiting: string; approved_30d: string; approved_today: string;
    }>>`
      SELECT
        (SELECT COUNT(*) FROM raw_transactions WHERE status = 'staged')::text AS pending_review,
        (SELECT COUNT(*) FROM raw_transactions WHERE status = 'waiting')::text AS waiting,
        (SELECT COUNT(*) FROM transactions WHERE status = 'approved' AND approved_at >= now() - interval '30 days')::text AS approved_30d,
        (SELECT COUNT(*) FROM transactions WHERE status = 'approved' AND approved_at >= now() - interval '1 day')::text AS approved_today
    `;
    const c = rows[0]!;
    return jsonOk({
      pending_review: Number(c.pending_review),
      waiting: Number(c.waiting),
      approved_30d: Number(c.approved_30d),
      approved_today: Number(c.approved_today),
    });
  } catch (err) {
    return jsonError(`review status failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
