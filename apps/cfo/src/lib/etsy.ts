import type { Env, Transaction, EtsyContext } from '../types';
import type { EtsyEmailReceipt } from './etsy-email';
import { handleClassifySingle } from '../routes/classify';

function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function looksLikeEtsy(tx: Transaction): boolean {
  return `${tx.merchant_name ?? ''} ${tx.description}`.toLowerCase().includes('etsy');
}

export async function matchEtsyReceipt(
  env: Env,
  userId: string,
  receipt: EtsyEmailReceipt,
): Promise<{ transactionId: string; score: number } | null> {
  const dateFrom = shiftIsoDate(receipt.date, -2);
  const dateTo = shiftIsoDate(receipt.date, 5);

  // Credit card purchases are stored as positive; match on absolute value.
  const candidates = await env.DB.prepare(
    `SELECT t.*
     FROM transactions t
     LEFT JOIN etsy_email_matches em ON em.transaction_id = t.id
     WHERE t.user_id = ?
       AND em.id IS NULL
       AND ABS(ABS(t.amount) - ?) < 0.01
       AND t.posted_date BETWEEN ? AND ?
       AND t.is_pending = 0
     ORDER BY t.posted_date ASC`,
  ).bind(userId, receipt.totalAmount, dateFrom, dateTo).all<Transaction>();

  let best: { transactionId: string; score: number } | null = null;

  for (const candidate of candidates.results) {
    let score = 50;
    if (looksLikeEtsy(candidate)) score += 40;
    if (candidate.posted_date === receipt.date) score += 10;
    if (!best || score > best.score) best = { transactionId: candidate.id, score };
  }

  return best && best.score >= 50 ? best : null;
}

export async function storeEtsyMatch(
  env: Env,
  userId: string,
  receipt: EtsyEmailReceipt,
  transactionId: string,
): Promise<{ reclassified: boolean }> {
  await env.DB.prepare(
    `INSERT INTO etsy_email_matches
       (id, user_id, transaction_id, order_id, items_json, shop_name, total_amount, receipt_date, gmail_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), userId, transactionId,
    receipt.orderId,
    JSON.stringify(receipt.items),
    receipt.shopName,
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

export async function loadEtsyContext(env: Env, txId: string): Promise<EtsyContext | null> {
  const row = await env.DB.prepare(
    `SELECT order_id, items_json, shop_name, total_amount, receipt_date
     FROM etsy_email_matches
     WHERE transaction_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(txId).first<{
    order_id: string | null;
    items_json: string;
    shop_name: string | null;
    total_amount: number;
    receipt_date: string | null;
  }>();

  if (!row) return null;

  let items: EtsyContext['items'] = [];
  try { items = JSON.parse(row.items_json); } catch { /* ignore */ }

  return {
    order_id: row.order_id,
    shop_name: row.shop_name,
    items,
    total_amount: row.total_amount,
    date: row.receipt_date,
  };
}
