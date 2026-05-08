/**
 * Nightly Teller sync — invoked by the Cloudflare Cron Trigger. Iterates
 * every user with a Teller enrollment and syncs a rolling 90-day window
 * per account. Runs independently of the tax-year workflow so a missing
 * or closed workflow doesn't silently pause the sync.
 *
 * Kept as a library function (not a route handler) so we can call it from
 * both the cron and a maintenance REST endpoint (POST /cron/nightly-sync)
 * without synthesizing a Request.
 */

import type { Env } from '../types';
import { syncTellerTransactionsForUser } from '../routes/teller';

export interface NightlySyncSummary {
  started_at: string;
  finished_at: string;
  users_considered: number;
  users_synced: number;
  users_failed: number;
  per_user: Array<{
    user_id: string;
    status: 'ok' | 'error';
    transactions_imported?: number;
    duplicates_skipped?: number;
    accounts_synced?: number;
    error?: string;
  }>;
}

export async function runNightlyTellerSync(env: Env): Promise<NightlySyncSummary> {
  const startedAt = new Date().toISOString();
  const users = await env.DB.prepare(
    `SELECT DISTINCT user_id
     FROM teller_enrollments
     ORDER BY user_id`,
  ).all<{ user_id: string }>();

  const summary: NightlySyncSummary = {
    started_at: startedAt,
    finished_at: startedAt,
    users_considered: users.results.length,
    users_synced: 0,
    users_failed: 0,
    per_user: [],
  };

  for (const row of users.results) {
    const userId = row.user_id;
    try {
      // Pass null dates so Teller returns all available history.
      // Deduplication in upsertTellerTransaction prevents re-importing.
      const result = await syncTellerTransactionsForUser(env, userId, null, null);

      summary.users_synced += 1;
      summary.per_user.push({
        user_id: userId,
        status: 'ok',
        transactions_imported: result.transactions_imported,
        duplicates_skipped: result.duplicates_skipped,
        accounts_synced: result.account_ids_synced?.length ?? 0,
      });
    } catch (err) {
      summary.users_failed += 1;
      summary.per_user.push({
        user_id: userId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      console.error('[nightly-sync] user failed', { userId, error: String(err) });
    }
  }

  summary.finished_at = new Date().toISOString();
  console.log('[nightly-sync] summary', summary);
  return summary;
}
