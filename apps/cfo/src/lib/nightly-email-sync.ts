/**
 * Nightly email sync — runs as part of the 0 9 * * * cron.
 *
 * Pulls three categories of emails from the personal Gmail account
 * (using GOOGLE_OAUTH_REFRESH_TOKEN) and enriches matching bank transactions:
 *
 *   Amazon — order confirmation emails → match to credit card charge,
 *            store product names + shipping address for AI classification.
 *
 *   Venmo  — payment emails → match to ACH bank transaction,
 *            store counterparty + memo for AI classification.
 *
 *   Apple  — purchase receipt emails → match to APPLE.COM/BILL credit card
 *            charge, store item names for AI classification.
 *
 * All pipelines share a single access-token refresh and write their
 * last-run time to email_sync_state so reruns search a tight window.
 * The *_email_processed tables act as dedup: already-seen message IDs
 * are skipped without re-fetching the full message.
 */

import type { Env } from '../types';
import { getEnvAccessToken, searchMessages, getMessage } from './gmail';
import { parseAmazonEmail } from './amazon-email';
import { parseVenmoEmail } from './venmo-email';
import { parseAppleEmail } from './apple-email';
import { processAmazonOrders } from '../routes/amazon';
import { matchVenmoPayment, storeVenmoMatch } from './venmo';
import { matchAppleReceipt, storeAppleMatch } from './apple';

export interface NightlyEmailSyncSummary {
  started_at: string;
  finished_at: string;
  skipped: boolean;
  amazon: {
    emails_found: number;
    emails_processed: number;
    orders_stored: number;
    orders_matched: number;
  };
  venmo: {
    emails_found: number;
    emails_processed: number;
    payments_matched: number;
    payments_reclassified: number;
  };
  apple: {
    emails_found: number;
    emails_processed: number;
    receipts_matched: number;
    receipts_reclassified: number;
  };
}

// lookbackDays overrides the since-last-sync window — useful for one-time backfills.
export async function runNightlyEmailSync(env: Env, lookbackDays?: number): Promise<NightlyEmailSyncSummary> {
  const startedAt = new Date().toISOString();
  const empty = {
    started_at: startedAt,
    finished_at: startedAt,
    skipped: false,
    amazon: { emails_found: 0, emails_processed: 0, orders_stored: 0, orders_matched: 0 },
    venmo: { emails_found: 0, emails_processed: 0, payments_matched: 0, payments_reclassified: 0 },
    apple: { emails_found: 0, emails_processed: 0, receipts_matched: 0, receipts_reclassified: 0 },
  };

  if (!env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    console.log('[email-sync] GOOGLE_OAUTH_REFRESH_TOKEN not configured — skipping');
    return { ...empty, skipped: true };
  }

  const userId = env.WEB_UI_USER_ID ?? 'default';
  const accessToken = await getEnvAccessToken(env);

  // Ensure sync-state row exists so we can read/write last-synced timestamps.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO email_sync_state (user_id) VALUES (?)`,
  ).bind(userId).run();

  const state = await env.DB.prepare(
    `SELECT amazon_last_synced_at, venmo_last_synced_at, apple_last_synced_at FROM email_sync_state WHERE user_id = ?`,
  ).bind(userId).first<{
    amazon_last_synced_at: string | null;
    venmo_last_synced_at: string | null;
    apple_last_synced_at: string | null;
  }>();

  const [amazonResult, venmoResult, appleResult] = await Promise.all([
    syncAmazonEmails(env, userId, accessToken, state?.amazon_last_synced_at ?? null, lookbackDays),
    syncVenmoEmails(env, userId, accessToken, state?.venmo_last_synced_at ?? null, lookbackDays),
    syncAppleEmails(env, userId, accessToken, state?.apple_last_synced_at ?? null, lookbackDays),
  ]);

  await env.DB.prepare(
    `UPDATE email_sync_state
     SET amazon_last_synced_at = datetime('now'),
         venmo_last_synced_at = datetime('now'),
         apple_last_synced_at = datetime('now')
     WHERE user_id = ?`,
  ).bind(userId).run();

  const summary: NightlyEmailSyncSummary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    skipped: false,
    amazon: amazonResult,
    venmo: venmoResult,
    apple: appleResult,
  };

  console.log('[email-sync] summary', summary);
  return summary;
}

// ── Amazon ────────────────────────────────────────────────────────────────────

async function syncAmazonEmails(
  env: Env,
  userId: string,
  accessToken: string,
  lastSyncedAt: string | null,
  lookbackDays?: number,
) {
  const sinceDays = lookbackDays ?? (lastSyncedAt
    ? Math.ceil((Date.now() - new Date(lastSyncedAt).getTime()) / 86_400_000) + 2
    : 90);

  const query = `from:(auto-confirm@amazon.com OR shipment-tracking@amazon.com) newer_than:${sinceDays}d`;
  const refs = await searchMessages(accessToken, query);

  const importId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO imports (id, user_id, source, status, transactions_found)
     VALUES (?, ?, 'amazon', 'running', ?)`,
  ).bind(importId, userId, refs.length).run();

  let emailsProcessed = 0, ordersStored = 0, ordersMatched = 0;

  try {
    for (const ref of refs) {
      const already = await env.DB.prepare(
        `SELECT id FROM amazon_email_processed WHERE gmail_message_id = ?`,
      ).bind(ref.id).first();
      if (already) continue;

      const message = await getMessage(accessToken, ref.id);
      const parsed = parseAmazonEmail(message);

      await env.DB.prepare(
        `INSERT OR IGNORE INTO amazon_email_processed (id, user_id, gmail_message_id, order_id)
         VALUES (?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), userId, ref.id, parsed?.orderId ?? null).run();

      if (!parsed || parsed.totalAmount === null) continue;
      emailsProcessed++;

      const orderKey = [
        parsed.orderId,
        parsed.shipmentDate ?? parsed.orderDate ?? 'unknown-date',
        parsed.totalAmount.toFixed(2),
      ].join('|');

      const result = await processAmazonOrders(env, userId, importId, [{
        orderKey,
        orderId: parsed.orderId,
        orderDate: parsed.orderDate,
        shipmentDate: parsed.shipmentDate,
        totalAmount: parsed.totalAmount,
        quantityTotal: 1,
        productNames: parsed.productNames,
        sellerNames: parsed.sellerNames,
        orderStatus: parsed.orderStatus,
        paymentInstrumentType: parsed.paymentInstrumentType,
        shipTo: parsed.shipTo,
        shippingAddress: parsed.shippingAddress,
      }]);

      ordersStored += result.stored;
      ordersMatched += result.matched;
    }

    await env.DB.prepare(
      `UPDATE imports SET status='completed', transactions_imported=?, completed_at=datetime('now') WHERE id=?`,
    ).bind(ordersStored, importId).run();
  } catch (err) {
    await env.DB.prepare(
      `UPDATE imports SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`,
    ).bind(String(err), importId).run();
    throw err;
  }

  return { emails_found: refs.length, emails_processed: emailsProcessed, orders_stored: ordersStored, orders_matched: ordersMatched };
}

// ── Venmo ─────────────────────────────────────────────────────────────────────

async function syncVenmoEmails(
  env: Env,
  userId: string,
  accessToken: string,
  lastSyncedAt: string | null,
  lookbackDays?: number,
) {
  const sinceDays = lookbackDays ?? (lastSyncedAt
    ? Math.ceil((Date.now() - new Date(lastSyncedAt).getTime()) / 86_400_000) + 2
    : 90);

  const query = `from:venmo@venmo.com newer_than:${sinceDays}d`;
  const refs = await searchMessages(accessToken, query);

  let emailsProcessed = 0, paymentsMatched = 0, paymentsReclassified = 0;

  for (const ref of refs) {
    const already = await env.DB.prepare(
      `SELECT id FROM venmo_email_processed WHERE gmail_message_id = ?`,
    ).bind(ref.id).first();
    if (already) continue;

    const message = await getMessage(accessToken, ref.id);
    const parsed = parseVenmoEmail(message);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO venmo_email_processed (id, user_id, gmail_message_id)
       VALUES (?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, ref.id).run();

    if (!parsed) continue;
    emailsProcessed++;

    const match = await matchVenmoPayment(env, userId, parsed);
    if (!match) continue;

    paymentsMatched++;
    const { reclassified } = await storeVenmoMatch(env, userId, parsed, match.transactionId);
    if (reclassified) paymentsReclassified++;
  }

  return { emails_found: refs.length, emails_processed: emailsProcessed, payments_matched: paymentsMatched, payments_reclassified: paymentsReclassified };
}

// ── Apple ─────────────────────────────────────────────────────────────────────

async function syncAppleEmails(
  env: Env,
  userId: string,
  accessToken: string,
  lastSyncedAt: string | null,
  lookbackDays?: number,
) {
  const sinceDays = lookbackDays ?? (lastSyncedAt
    ? Math.ceil((Date.now() - new Date(lastSyncedAt).getTime()) / 86_400_000) + 2
    : 90);

  const query = `from:no_reply@email.apple.com subject:receipt newer_than:${sinceDays}d`;
  const refs = await searchMessages(accessToken, query);

  let emailsProcessed = 0, receiptsMatched = 0, receiptsReclassified = 0;

  for (const ref of refs) {
    const already = await env.DB.prepare(
      `SELECT id FROM apple_email_processed WHERE gmail_message_id = ?`,
    ).bind(ref.id).first();
    if (already) continue;

    const message = await getMessage(accessToken, ref.id);
    const parsed = parseAppleEmail(message);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO apple_email_processed (id, user_id, gmail_message_id, receipt_id)
       VALUES (?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, ref.id, parsed?.receiptId ?? null).run();

    if (!parsed) continue;
    emailsProcessed++;

    const match = await matchAppleReceipt(env, userId, parsed);
    if (!match) continue;

    receiptsMatched++;
    const { reclassified } = await storeAppleMatch(env, userId, parsed, match.transactionId);
    if (reclassified) receiptsReclassified++;
  }

  return { emails_found: refs.length, emails_processed: emailsProcessed, receipts_matched: receiptsMatched, receipts_reclassified: receiptsReclassified };
}
