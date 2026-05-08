import type { Env } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';

// ── GET /reports/schedule-c ───────────────────────────────────────────────────
// Returns Schedule C worksheet: categories with line totals + transaction drill-down.
export async function handleScheduleC(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const year = url.searchParams.get('year') ?? new Date().getFullYear().toString();
  const entity = url.searchParams.get('entity') ?? 'elyse_coaching';

  if (entity !== 'elyse_coaching' && entity !== 'jeremy_coaching') {
    return jsonError('entity must be elyse_coaching or jeremy_coaching');
  }

  const coaSlug = entity;
  const dateFrom = `${year}-01-01`;
  const dateTo   = `${year}-12-31`;

  const totals = await env.DB.prepare(
    `SELECT c.category_tax, coa.name AS category_name, coa.form_line,
            SUM(t.amount) AS total_amount, COUNT(*) AS transaction_count
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     LEFT JOIN chart_of_accounts coa ON coa.code = c.category_tax
       AND coa.business_entity_id = (
         SELECT id FROM business_entities WHERE user_id = ? AND slug = ? LIMIT 1
       )
     WHERE t.user_id = ? AND c.entity = ?
       AND t.posted_date BETWEEN ? AND ?
       AND c.review_required = 0
       AND c.category_tax != 'transfer'
     GROUP BY c.category_tax
     ORDER BY coa.form_line`,
  ).bind(userId, coaSlug, userId, entity, dateFrom, dateTo).all<{
    category_tax: string; category_name: string; form_line: string;
    total_amount: number; transaction_count: number;
  }>();

  const income = totals.results.filter(r => r.category_tax === 'income');
  const expenses = totals.results
    .filter(r => r.category_tax !== 'income')
    .map(r => ({ ...r, total_amount: -r.total_amount }));
  const totalIncome  = income.reduce((s, r) => s + r.total_amount, 0);
  const totalExpense = expenses.reduce((s, r) => s + r.total_amount, 0);
  const netProfit    = totalIncome - totalExpense;

  const unreviewedRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     WHERE t.user_id = ? AND c.entity = ?
       AND t.posted_date BETWEEN ? AND ? AND c.review_required = 1`,
  ).bind(userId, entity, dateFrom, dateTo).first<{ cnt: number }>();

  return jsonOk({
    tax_year: year,
    entity,
    schedule: 'C',
    income: { categories: income, total: totalIncome },
    expenses: { categories: expenses, total: totalExpense },
    net_profit: netProfit,
    pending_review: unreviewedRow?.cnt ?? 0,
  });
}

// ── GET /reports/schedule-e (Whitford House) ─────────────────────────────────
export async function handleScheduleE(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const year = url.searchParams.get('year') ?? new Date().getFullYear().toString();

  const dateFrom = `${year}-01-01`;
  const dateTo   = `${year}-12-31`;

  const totals = await env.DB.prepare(
    `SELECT c.category_tax, coa.name AS category_name, coa.form_line,
            SUM(t.amount) AS total_amount, COUNT(*) AS transaction_count
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     LEFT JOIN chart_of_accounts coa ON coa.code = c.category_tax
       AND coa.business_entity_id = (
         SELECT id FROM business_entities WHERE user_id = ? AND slug = 'airbnb' LIMIT 1
       )
     WHERE t.user_id = ? AND c.entity = 'airbnb_activity'
       AND t.posted_date BETWEEN ? AND ?
       AND c.review_required = 0
     GROUP BY c.category_tax
     ORDER BY coa.form_line`,
  ).bind(userId, userId, dateFrom, dateTo).all<{
    category_tax: string; category_name: string; form_line: string;
    total_amount: number; transaction_count: number;
  }>();

  // Same sign-flip as Schedule C — expenses are negative in the DB and
  // Schedule E wants positive figures. Keeping the two handlers in
  // lockstep so the shape of their output matches.
  const income = totals.results.filter(r => r.category_tax === 'rental_income');
  const expenses = totals.results
    .filter(r => r.category_tax !== 'rental_income')
    .map(r => ({ ...r, total_amount: -r.total_amount }));
  const totalIncome  = income.reduce((s, r) => s + r.total_amount, 0);
  const totalExpense = expenses.reduce((s, r) => s + r.total_amount, 0);
  const netProfit    = totalIncome - totalExpense;

  const unreviewedRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     WHERE t.user_id = ? AND c.entity = 'airbnb_activity'
       AND t.posted_date BETWEEN ? AND ? AND c.review_required = 1`,
  ).bind(userId, dateFrom, dateTo).first<{ cnt: number }>();

  return jsonOk({
    tax_year: year,
    entity: 'airbnb_activity',
    schedule: 'E',
    income: { categories: income, total: totalIncome },
    expenses: { categories: expenses, total: totalExpense },
    net_profit: netProfit,
    pending_review: unreviewedRow?.cnt ?? 0,
  });
}

// ── GET /reports/summary ──────────────────────────────────────────────────────
export async function handleSummary(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const year = url.searchParams.get('year') ?? new Date().getFullYear().toString();
  const dateFrom = `${year}-01-01`;
  const dateTo   = `${year}-12-31`;

  const [byEntity, byMonth, reviewStats] = await Promise.all([
    env.DB.prepare(
      `SELECT c.entity, SUM(t.amount) AS total, COUNT(*) AS count
       FROM transactions t
       JOIN classifications c ON c.transaction_id = t.id
       WHERE t.user_id = ? AND t.posted_date BETWEEN ? AND ?
       GROUP BY c.entity`,
    ).bind(userId, dateFrom, dateTo).all(),
    env.DB.prepare(
      `SELECT substr(t.posted_date, 1, 7) AS month, c.entity, SUM(t.amount) AS total
       FROM transactions t
       JOIN classifications c ON c.transaction_id = t.id
       WHERE t.user_id = ? AND t.posted_date BETWEEN ? AND ?
       GROUP BY month, c.entity
       ORDER BY month`,
    ).bind(userId, dateFrom, dateTo).all(),
    env.DB.prepare(
      `SELECT rq.status, COUNT(*) AS count
       FROM review_queue rq
       JOIN transactions t ON t.id = rq.transaction_id
       WHERE rq.user_id = ?
         AND t.posted_date BETWEEN ? AND ?
       GROUP BY rq.status`,
    ).bind(userId, dateFrom, dateTo).all(),
  ]);

  return jsonOk({
    tax_year: year,
    by_entity: byEntity.results,
    by_month: byMonth.results,
    review_queue: reviewStats.results,
  });
}

// ── GET /reports/export ───────────────────────────────────────────────────────
// Returns CSV of all classified transactions for the given year.
export async function handleExport(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const year = url.searchParams.get('year') ?? new Date().getFullYear().toString();
  const entity = url.searchParams.get('entity');
  const dateFrom = `${year}-01-01`;
  const dateTo   = `${year}-12-31`;

  let query = `SELECT t.posted_date, t.merchant_name, t.description, t.amount, t.currency,
                      a.name AS account_name, a.subtype AS account_subtype,
                      c.entity, c.category_tax, c.category_budget, c.confidence, c.method,
                      c.review_required
               FROM transactions t
               LEFT JOIN classifications c ON c.transaction_id = t.id
               LEFT JOIN accounts a ON a.id = t.account_id
               WHERE t.user_id = ? AND t.posted_date BETWEEN ? AND ?`;
  const vals: unknown[] = [userId, dateFrom, dateTo];

  if (entity) { query += ' AND c.entity = ?'; vals.push(entity); }
  query += ' ORDER BY t.posted_date, c.entity';

  const rows = await env.DB.prepare(query).bind(...vals).all<Record<string, unknown>>();

  if (!rows.results.length) return jsonError('No transactions found for the given filters', 404);

  const headers = Object.keys(rows.results[0]);
  const csvLines = [
    headers.join(','),
    ...rows.results.map(row =>
      headers.map(h => {
        const v = row[h] ?? '';
        const s = String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','),
    ),
  ];

  const csv = csvLines.join('\n');
  const filename = `tax-prep-${year}${entity ? `-${entity}` : ''}.csv`;

  // Store in R2 for retrieval
  const r2Key = `exports/${userId}/${filename}`;
  await env.BUCKET.put(r2Key, csv, { httpMetadata: { contentType: 'text/csv' } });

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// ── POST /reports/snapshot ────────────────────────────────────────────────────
// Creates an immutable R2-backed filing snapshot for a given tax year.
export async function handleSnapshot(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: { year?: number; name?: string } = {};
  try { body = await request.json() as typeof body; }
  catch { /* optional */ }

  const year = body.year ?? new Date().getFullYear();
  const name = body.name ?? `Tax Year ${year} Snapshot`;

  const dateFrom = `${year}-01-01`;
  const dateTo   = `${year}-12-31`;

  const transactions = await env.DB.prepare(
    `SELECT t.*, c.entity, c.category_tax, c.category_budget, c.confidence, c.method,
            c.reason_codes, c.is_locked
     FROM transactions t
     LEFT JOIN classifications c ON c.transaction_id = t.id
     WHERE t.user_id = ? AND t.posted_date BETWEEN ? AND ?
     ORDER BY t.posted_date`,
  ).bind(userId, dateFrom, dateTo).all();

  const snapshot = {
    created_at: new Date().toISOString(),
    tax_year: year,
    name,
    transactions: transactions.results,
    total: transactions.results.length,
  };

  const r2Key = `snapshots/${userId}/${year}-${Date.now()}.json`;
  await env.BUCKET.put(r2Key, JSON.stringify(snapshot), {
    httpMetadata: { contentType: 'application/json' },
  });

  await env.DB.prepare(
    `INSERT INTO filing_snapshots (id, user_id, tax_year, name, r2_key) VALUES (?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), userId, year, name, r2Key).run();

  // Lock all included classified transactions
  await env.DB.prepare(
    `UPDATE classifications SET is_locked=1
     WHERE transaction_id IN (
       SELECT id FROM transactions WHERE user_id=? AND posted_date BETWEEN ? AND ?
     )`,
  ).bind(userId, dateFrom, dateTo).run();

  return jsonOk({ snapshot: { r2_key: r2Key, tax_year: year, name, total: transactions.results.length } }, 201);
}
