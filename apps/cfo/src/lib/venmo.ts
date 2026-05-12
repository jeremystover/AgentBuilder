import type { Env, Transaction, VenmoContext } from '../types';
import type { VenmoEmailPayment } from './venmo-email';
import { handleClassifySingle } from '../routes/classify';

function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function looksLikeVenmo(tx: Transaction): boolean {
  const haystack = `${tx.merchant_name ?? ''} ${tx.description}`.toLowerCase();
  return haystack.includes('venmo');
}

// Match a parsed Venmo payment to an existing bank transaction.
// Venmo ACH transfers typically settle within 1 business day, so we search
// ±2 days. Amount must match exactly (< $0.01 tolerance).
export async function matchVenmoPayment(
  env: Env,
  userId: string,
  payment: VenmoEmailPayment,
): Promise<{ transactionId: string; score: number } | null> {
  const dateFrom = shiftIsoDate(payment.date, -2);
  const dateTo = shiftIsoDate(payment.date, 2);

  // Venmo expenses are stored as negative; income as positive.
  const expectedAmount = payment.direction === 'received' ? payment.amount : -payment.amount;

  const candidates = await env.DB.prepare(
    `SELECT t.*
     FROM transactions t
     LEFT JOIN venmo_email_matches vm ON vm.transaction_id = t.id
     WHERE t.user_id = ?
       AND vm.id IS NULL
       AND ABS(t.amount - ?) < 0.01
       AND t.posted_date BETWEEN ? AND ?
       AND t.is_pending = 0
     ORDER BY t.posted_date ASC`,
  ).bind(userId, expectedAmount, dateFrom, dateTo).all<Transaction>();

  let best: { transactionId: string; score: number } | null = null;

  for (const candidate of candidates.results) {
    let score = 50;
    // Bonus for Venmo in merchant/description
    if (looksLikeVenmo(candidate)) score += 30;
    // Bonus for exact date match
    if (candidate.posted_date === payment.date) score += 20;

    if (!best || score > best.score) {
      best = { transactionId: candidate.id, score };
    }
  }

  return best && best.score >= 60 ? best : null;
}

// Store a Venmo match and optionally trigger reclassification.
export async function storeVenmoMatch(
  env: Env,
  userId: string,
  payment: VenmoEmailPayment,
  transactionId: string,
): Promise<{ reclassified: boolean }> {
  await env.DB.prepare(
    `INSERT INTO venmo_email_matches
       (id, user_id, transaction_id, counterparty, memo, direction,
        venmo_amount, venmo_date, gmail_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), userId, transactionId,
    payment.counterparty, payment.memo, payment.direction,
    payment.amount, payment.date, payment.gmailMessageId,
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

  const directionLabel = payment.direction === 'received' ? 'received from' : 'sent to';
  const note = [
    `Venmo payment matched`,
    `${directionLabel} ${payment.counterparty}`,
    payment.memo ? `"${payment.memo}"` : null,
    `$${payment.amount.toFixed(2)}`,
  ].filter(Boolean).join(' · ');

  const resp = await handleClassifySingle(
    new Request('https://internal/classify', { headers: { 'x-user-id': userId } }),
    env,
    transactionId,
    note,
  );
  return { reclassified: resp.ok };
}

// Load Venmo context for the AI classifier (mirrors loadAmazonContext).
export async function loadVenmoContext(env: Env, txId: string): Promise<VenmoContext | null> {
  const row = await env.DB.prepare(
    `SELECT counterparty, memo, direction, venmo_amount, venmo_date
     FROM venmo_email_matches
     WHERE transaction_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(txId).first<{
    counterparty: string | null;
    memo: string | null;
    direction: string;
    venmo_amount: number;
    venmo_date: string | null;
  }>();

  if (!row) return null;

  return {
    counterparty: row.counterparty,
    memo: row.memo,
    direction: row.direction as VenmoContext['direction'],
    amount: row.venmo_amount,
    date: row.venmo_date,
  };
}
