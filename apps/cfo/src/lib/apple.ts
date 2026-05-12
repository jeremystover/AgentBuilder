import type { Env, Transaction, AppleContext } from '../types';
import type { AppleEmailReceipt } from './apple-email';
import { handleClassifySingle } from '../routes/classify';

function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function looksLikeApple(tx: Transaction): boolean {
  const haystack = `${tx.merchant_name ?? ''} ${tx.description}`.toLowerCase();
  return haystack.includes('apple');
}

// Match a parsed Apple receipt to an APPLE.COM/BILL credit card transaction.
// Apple charges are near-instant so ±2 days is sufficient. Amount must match
// exactly (< $0.01 tolerance). Apple charges are expenses → stored as negative.
export async function matchAppleReceipt(
  env: Env,
  userId: string,
  receipt: AppleEmailReceipt,
): Promise<{ transactionId: string; score: number } | null> {
  const dateFrom = shiftIsoDate(receipt.date, -2);
  const dateTo = shiftIsoDate(receipt.date, 5); // receipts arrive day-of; cards post up to 4 days later
  // Match on absolute value — credit card purchases are stored as positive
  // (increasing the balance owed), unlike bank account debits which are negative.
  const absAmount = receipt.totalAmount;

  const candidates = await env.DB.prepare(
    `SELECT t.*
     FROM transactions t
     LEFT JOIN apple_email_matches am ON am.transaction_id = t.id
     WHERE t.user_id = ?
       AND am.id IS NULL
       AND ABS(ABS(t.amount) - ?) < 0.01
       AND t.posted_date BETWEEN ? AND ?
       AND t.is_pending = 0
     ORDER BY t.posted_date ASC`,
  ).bind(userId, absAmount, dateFrom, dateTo).all<Transaction>();

  let best: { transactionId: string; score: number } | null = null;

  for (const candidate of candidates.results) {
    let score = 50;
    if (looksLikeApple(candidate)) score += 40;
    if (candidate.posted_date === receipt.date) score += 10;

    if (!best || score > best.score) {
      best = { transactionId: candidate.id, score };
    }
  }

  return best && best.score >= 50 ? best : null;
}

export async function storeAppleMatch(
  env: Env,
  userId: string,
  receipt: AppleEmailReceipt,
  transactionId: string,
): Promise<{ reclassified: boolean }> {
  await env.DB.prepare(
    `INSERT INTO apple_email_matches
       (id, user_id, transaction_id, receipt_id, items_json, total_amount, receipt_date, gmail_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), userId, transactionId,
    receipt.receiptId,
    JSON.stringify(receipt.items),
    receipt.totalAmount,
    receipt.date,
    receipt.gmailMessageId,
  ).run();

  const classification = await env.DB.prepare(
    `SELECT method, is_locked FROM classifications WHERE transaction_id = ?`,
  ).bind(transactionId).first<{ method: string | null; is_locked: number }>();

  if (classification?.is_locked || classification?.method === 'manual' || classification?.method === 'historical') {
    return { reclassified: false };
  }

  if (classification) {
    await env.DB.prepare('DELETE FROM classifications WHERE transaction_id = ?').bind(transactionId).run();
  }

  const resp = await handleClassifySingle(
    new Request('https://internal/classify', { headers: { 'x-user-id': userId } }),
    env,
    transactionId,
  );
  return { reclassified: resp.ok };
}

export async function loadAppleContext(env: Env, txId: string): Promise<AppleContext | null> {
  const row = await env.DB.prepare(
    `SELECT receipt_id, items_json, total_amount, receipt_date
     FROM apple_email_matches
     WHERE transaction_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(txId).first<{
    receipt_id: string | null;
    items_json: string;
    total_amount: number;
    receipt_date: string | null;
  }>();

  if (!row) return null;

  let items: AppleContext['items'] = [];
  try {
    items = JSON.parse(row.items_json);
  } catch { /* malformed JSON — treat as empty */ }

  return {
    receipt_id: row.receipt_id,
    items,
    total_amount: row.total_amount,
    date: row.receipt_date,
  };
}
