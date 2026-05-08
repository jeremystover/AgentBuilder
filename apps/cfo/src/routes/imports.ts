import type { Env } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';
import { computeDedupHash, cleanDescription, parseCsv } from '../lib/dedup';
import { ensureUnclassifiedReviewQueue } from '../lib/review-queue';

// ── GET /imports ──────────────────────────────────────────────────────────────
export async function handleListImports(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const imports = await env.DB.prepare(
    `SELECT i.*, a.name AS account_name FROM imports i
     LEFT JOIN accounts a ON a.id = i.account_id
     WHERE i.user_id = ?
     ORDER BY i.created_at DESC LIMIT 50`,
  ).bind(userId).all();
  return jsonOk({ imports: imports.results });
}

// ── DELETE /imports ───────────────────────────────────────────────────────────
export async function handleDeleteAllImports(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  const importedCountRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM transactions
     WHERE user_id = ? AND import_id IS NOT NULL`,
  ).bind(userId).first<{ total: number }>();

  const lockedCountRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     WHERE t.user_id = ?
       AND t.import_id IS NOT NULL
       AND c.is_locked = 1`,
  ).bind(userId).first<{ total: number }>();

  const importedCount = importedCountRow?.total ?? 0;
  const lockedCount = lockedCountRow?.total ?? 0;

  if (importedCount === 0) {
    return jsonOk({
      transactions_deleted: 0,
      imports_deleted: 0,
      locked_transactions_skipped: 0,
    });
  }

  const deleteTransactionsResult = await env.DB.prepare(
    `DELETE FROM transactions
     WHERE user_id = ?
       AND import_id IS NOT NULL
       AND id NOT IN (
         SELECT transaction_id
         FROM classifications
         WHERE is_locked = 1
       )`,
  ).bind(userId).run();

  const deleteImportsResult = await env.DB.prepare(
    `DELETE FROM imports
     WHERE user_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM transactions t
         WHERE t.import_id = imports.id
       )`,
  ).bind(userId).run();

  return jsonOk({
    transactions_deleted: Number(deleteTransactionsResult.meta.changes ?? 0),
    imports_deleted: Number(deleteImportsResult.meta.changes ?? 0),
    locked_transactions_skipped: lockedCount,
  });
}

// ── DELETE /imports/:id ───────────────────────────────────────────────────────
export async function handleDeleteImport(request: Request, env: Env, importId: string): Promise<Response> {
  const userId = getUserId(request);

  const imp = await env.DB.prepare(
    'SELECT id FROM imports WHERE id = ? AND user_id = ?',
  ).bind(importId, userId).first<{ id: string }>();

  if (!imp) return jsonError('Import not found', 404);

  const lockedCountRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     WHERE t.user_id = ?
       AND t.import_id = ?
       AND c.is_locked = 1`,
  ).bind(userId, importId).first<{ total: number }>();

  const deleteTransactionsResult = await env.DB.prepare(
    `DELETE FROM transactions
     WHERE user_id = ?
       AND import_id = ?
       AND id NOT IN (
         SELECT transaction_id
         FROM classifications
         WHERE is_locked = 1
       )`,
  ).bind(userId, importId).run();

  const deleteImportResult = await env.DB.prepare(
    `DELETE FROM imports
     WHERE id = ?
       AND user_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM transactions
         WHERE import_id = ?
       )`,
  ).bind(importId, userId, importId).run();

  return jsonOk({
    transactions_deleted: Number(deleteTransactionsResult.meta.changes ?? 0),
    import_deleted: Number(deleteImportResult.meta.changes ?? 0) > 0,
    locked_transactions_skipped: lockedCountRow?.total ?? 0,
  });
}

// ── POST /imports/csv ─────────────────────────────────────────────────────────
// Accepts a multipart form upload with fields:
//   file     — the CSV file
//   format   — "generic" | "venmo" | "chase" | "amex" | "bofa" (optional, auto-detected)
//   account_id — existing account id to associate rows with (optional)
//
// Generic CSV must have columns (case-insensitive): date, amount, description
// Venmo CSV: Date, Amount (total), Description, From, To
// Chase CSV:  Transaction Date, Amount, Description
export async function handleCsvImport(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return jsonError('Expected multipart/form-data with a "file" field'); }

  const fileField = formData.get('file');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!fileField || typeof (fileField as any).text !== 'function') return jsonError('"file" field is required');

  const format    = (formData.get('format') as string | null) ?? 'auto';
  const accountId = (formData.get('account_id') as string | null) ?? null;

  if (accountId) {
    const acct = await env.DB.prepare(
      'SELECT id FROM accounts WHERE id = ? AND user_id = ?',
    ).bind(accountId, userId).first();
    if (!acct) return jsonError('Account not found or does not belong to this user', 404);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const csvText = await (fileField as any).text() as string;
  const rows = parseCsv(csvText);
  if (!rows.length) return jsonError('CSV file is empty or has no data rows');

  const importId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO imports (id, user_id, source, account_id, status, transactions_found)
     VALUES (?, ?, 'csv', ?, 'running', ?)`,
  ).bind(importId, userId, accountId, rows.length).run();

  const detectedFormat = format === 'auto' ? detectFormat(rows[0]) : format;
  const accountName = await lookupAccountName(env, userId, accountId);

  let imported = 0;
  let dupes = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    try {
      const parsed = parseRow(rows[i], detectedFormat, { accountName });
      if (!parsed) { errors.push(`Row ${i + 2}: could not parse`); continue; }

      const descClean = cleanDescription(parsed.description);
      const dedupHash = await computeDedupHash(
        accountId ?? `csv-${userId}`,
        parsed.date, parsed.amount, parsed.description,
      );

      const txId = crypto.randomUUID();
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO transactions
           (id, user_id, account_id, import_id, posted_date, amount, currency,
            merchant_name, description, description_clean, dedup_hash)
         VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?)`,
      ).bind(txId, userId, accountId, importId, parsed.date, parsed.amount,
        parsed.merchant ?? null, parsed.description, descClean, dedupHash).run();

      if (result.meta.changes > 0) {
        imported++;
        await ensureUnclassifiedReviewQueue(env, txId, userId);
      } else dupes++;
    } catch (err) {
      errors.push(`Row ${i + 2}: ${String(err)}`);
    }
  }

  await env.DB.prepare(
    `UPDATE imports SET status='completed', transactions_imported=?, completed_at=datetime('now') WHERE id=?`,
  ).bind(imported, importId).run();

  return jsonOk({
    import_id: importId,
    format: detectedFormat,
    rows_parsed: rows.length,
    transactions_imported: imported,
    duplicates_skipped: dupes,
    errors: errors.slice(0, 10),
    message: imported > 0 ? 'Imported transactions are now queued for review.' : 'No new transactions imported.',
  }, 201);
}

// ── Format detection ──────────────────────────────────────────────────────────
function detectFormat(headers: Record<string, string>): string {
  const keys = Object.keys(headers).join(' ');
  if (keys.includes('transaction_date')) return 'chase';
  if (keys.includes('from') && keys.includes('to') && keys.includes('amount__total_')) return 'venmo';
  if (keys.includes('transaction_date') && keys.includes('posted_date')) return 'amex';
  return 'generic';
}

interface ParsedRow {
  date: string;
  amount: number;
  description: string;
  merchant?: string;
}

async function lookupAccountName(env: Env, userId: string, accountId: string | null): Promise<string | null> {
  if (!accountId) return null;
  const account = await env.DB.prepare(
    'SELECT name FROM accounts WHERE id = ? AND user_id = ?',
  ).bind(accountId, userId).first<{ name: string }>();
  return account?.name ?? null;
}

function parseSignedCurrency(rawValue: string): { amount: number; hadExplicitSign: boolean } {
  const cleaned = rawValue.trim();
  const hadExplicitSign = /^[+-]/.test(cleaned);
  const normalized = cleaned.replace(/[,$\s]/g, '');
  return {
    amount: parseFloat(normalized),
    hadExplicitSign,
  };
}

function inferVenmoDirection(row: Record<string, string>, accountName: string | null): number {
  const type = (row['type'] ?? '').trim().toLowerCase();
  const from = (row['from'] ?? '').trim().toLowerCase();
  const to = (row['to'] ?? '').trim().toLowerCase();
  const normalizedAccountName = (accountName ?? '').trim().toLowerCase();

  if (normalizedAccountName) {
    if (from === normalizedAccountName && to !== normalizedAccountName) return -1;
    if (to === normalizedAccountName && from !== normalizedAccountName) return 1;
  }

  if (type.includes('charge') || type.includes('cashout') || type.includes('transfer')) return 1;
  if (type.includes('payment') || type.includes('merchant')) return -1;
  return -1;
}

function parseRow(
  row: Record<string, string>,
  format: string,
  context: { accountName: string | null },
): ParsedRow | null {
  switch (format) {
    case 'chase': {
      const date = normalizeDate(row['transaction_date'] ?? row['date'] ?? '');
      const amount = parseFloat((row['amount'] ?? '0').replace(/[,$]/g, ''));
      const description = row['description'] ?? '';
      if (!date || isNaN(amount) || !description) return null;
      return { date, amount: -amount, description }; // Chase: positive = expense
    }
    case 'venmo': {
      const date = normalizeDate(row['datetime'] ?? row['date'] ?? '');
      const signed = parseSignedCurrency(row['amount__total_'] ?? row['amount'] ?? '');
      const direction = signed.hadExplicitSign ? 1 : inferVenmoDirection(row, context.accountName);
      const amount = signed.amount * direction;
      const description = row['note'] ?? row['description'] ?? '';
      const merchant = row['to'] || row['from'] || undefined;
      if (!date || isNaN(amount) || !description) return null;
      return { date, amount, description, merchant };
    }
    case 'amex': {
      const date = normalizeDate(row['date'] ?? row['transaction_date'] ?? '');
      const amount = parseFloat((row['amount'] ?? '0').replace(/[,$]/g, ''));
      const description = row['description'] ?? '';
      if (!date || isNaN(amount) || !description) return null;
      return { date, amount, description };
    }
    default: { // generic
      const dateKey  = Object.keys(row).find(k => /date/i.test(k)) ?? '';
      const amtKey   = Object.keys(row).find(k => /amount|debit|credit/i.test(k)) ?? '';
      const descKey  = Object.keys(row).find(k => /desc|memo|narr|name/i.test(k)) ?? '';
      const date = normalizeDate(row[dateKey] ?? '');
      const amount = parseFloat((row[amtKey] ?? '0').replace(/[,$]/g, ''));
      const description = row[descKey] ?? '';
      if (!date || isNaN(amount) || !description) return null;
      return { date, amount, description };
    }
  }
}

function normalizeDate(raw: string): string {
  // Support M/D/YYYY, YYYY-MM-DD, MM/DD/YYYY, etc.
  const cleaned = raw.trim();
  const mdy = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  const iso = cleaned.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return '';
}
