/**
 * Nightly Amazon email sync — called from the same 0 9 * * * cron as the
 * Teller sync. For every user with a gmail_enrollment, fetches order
 * confirmation and shipment emails from Gmail, parses them, and runs the
 * same match-and-reclassify pipeline as the manual CSV import.
 *
 * amazon_email_processed acts as a dedup table: we record the Gmail message
 * ID after first processing so reruns skip already-seen emails without
 * re-fetching the full message.
 */

import type { Env } from '../types';
import { refreshAccessToken, searchMessages, getMessage } from './gmail';
import { parseAmazonEmail } from './amazon-email';
import { processAmazonOrders } from '../routes/amazon';

export interface AmazonEmailSyncSummary {
  started_at: string;
  finished_at: string;
  users_considered: number;
  users_synced: number;
  users_failed: number;
  per_user: Array<{
    user_id: string;
    status: 'ok' | 'error';
    emails_found?: number;
    emails_processed?: number;
    orders_stored?: number;
    orders_matched?: number;
    error?: string;
  }>;
}

interface GmailEnrollment {
  id: string;
  user_id: string;
  refresh_token: string;
  last_synced_at: string | null;
}

export async function runNightlyAmazonEmailSync(env: Env): Promise<AmazonEmailSyncSummary> {
  const startedAt = new Date().toISOString();

  const enrollments = await env.DB.prepare(
    `SELECT id, user_id, refresh_token, last_synced_at FROM gmail_enrollments ORDER BY user_id`,
  ).all<GmailEnrollment>();

  const summary: AmazonEmailSyncSummary = {
    started_at: startedAt,
    finished_at: startedAt,
    users_considered: enrollments.results.length,
    users_synced: 0,
    users_failed: 0,
    per_user: [],
  };

  for (const enrollment of enrollments.results) {
    const { user_id: userId } = enrollment;
    try {
      const result = await syncAmazonEmailsForUser(env, enrollment);
      summary.users_synced++;
      summary.per_user.push({ user_id: userId, status: 'ok', ...result });
    } catch (err) {
      summary.users_failed++;
      summary.per_user.push({ user_id: userId, status: 'error', error: String(err) });
      console.error('[amazon-email-sync] user failed', { userId, error: String(err) });
    }
  }

  summary.finished_at = new Date().toISOString();
  console.log('[amazon-email-sync] summary', summary);
  return summary;
}

export async function syncAmazonEmailsForUser(
  env: Env,
  enrollment: GmailEnrollment,
): Promise<{ emails_found: number; emails_processed: number; orders_stored: number; orders_matched: number }> {
  const accessToken = await refreshAccessToken(env, enrollment.refresh_token);

  // Search back to last sync + a 2-day buffer, or 90 days on first run.
  const sinceDays = enrollment.last_synced_at
    ? Math.ceil((Date.now() - new Date(enrollment.last_synced_at).getTime()) / 86_400_000) + 2
    : 90;

  const query = `from:(auto-confirm@amazon.com OR shipment-tracking@amazon.com) newer_than:${sinceDays}d`;
  const messageRefs = await searchMessages(accessToken, query);

  const importId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO imports (id, user_id, source, status, transactions_found)
     VALUES (?, ?, 'amazon', 'running', ?)`,
  ).bind(importId, enrollment.user_id, messageRefs.length).run();

  let emailsProcessed = 0;
  let ordersStored = 0;
  let ordersMatched = 0;

  try {
    for (const ref of messageRefs) {
      // Skip messages we've already ingested.
      const already = await env.DB.prepare(
        `SELECT id FROM amazon_email_processed WHERE gmail_message_id = ?`,
      ).bind(ref.id).first();
      if (already) continue;

      const message = await getMessage(accessToken, ref.id);
      const parsed = parseAmazonEmail(message);

      // Record as processed regardless of parse outcome to prevent infinite retries.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO amazon_email_processed (id, user_id, gmail_message_id, order_id)
         VALUES (?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), enrollment.user_id, ref.id, parsed?.orderId ?? null).run();

      // Skip emails that parse but lack a total (e.g. shipment notifications for orders
      // we already imported from the confirmation email).
      if (!parsed || parsed.totalAmount === null) continue;
      emailsProcessed++;

      const orderKey = [
        parsed.orderId,
        parsed.shipmentDate ?? parsed.orderDate ?? 'unknown-date',
        parsed.totalAmount.toFixed(2),
      ].join('|');

      const result = await processAmazonOrders(env, enrollment.user_id, importId, [{
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

    await env.DB.prepare(
      `UPDATE gmail_enrollments SET last_synced_at=datetime('now') WHERE id=?`,
    ).bind(enrollment.id).run();
  } catch (err) {
    await env.DB.prepare(
      `UPDATE imports SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`,
    ).bind(String(err), importId).run();
    throw err;
  }

  return {
    emails_found: messageRefs.length,
    emails_processed: emailsProcessed,
    orders_stored: ordersStored,
    orders_matched: ordersMatched,
  };
}
