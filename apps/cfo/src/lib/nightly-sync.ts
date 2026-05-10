/**
 * Nightly sync — invoked by the Cloudflare Cron Trigger. Runs Teller sync
 * for all users with Teller enrollments, then Plaid sync for all users with
 * Plaid items. Both use their own deduplication so re-running is safe.
 *
 * Kept as a library function (not a route handler) so we can call it from
 * both the cron and a maintenance REST endpoint (POST /cron/nightly-sync)
 * without synthesizing a Request.
 */

import type { Env } from '../types';
import { syncTellerTransactionsForUser } from '../routes/teller';
import { syncPlaidTransactionsForUser } from '../routes/plaid';
import { isPlaidConfigured } from './plaid';

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

  const [tellerUsers, plaidUsers] = await Promise.all([
    env.DB.prepare(
      `SELECT DISTINCT user_id FROM teller_enrollments ORDER BY user_id`,
    ).all<{ user_id: string }>(),
    isPlaidConfigured(env)
      ? env.DB.prepare(
          `SELECT DISTINCT user_id FROM plaid_items ORDER BY user_id`,
        ).all<{ user_id: string }>()
      : Promise.resolve({ results: [] as { user_id: string }[] }),
  ]);

  const allUserIds = new Set([
    ...tellerUsers.results.map(r => r.user_id),
    ...plaidUsers.results.map(r => r.user_id),
  ]);

  const summary: NightlySyncSummary = {
    started_at: startedAt,
    finished_at: startedAt,
    users_considered: allUserIds.size,
    users_synced: 0,
    users_failed: 0,
    per_user: [],
  };

  const tellerUserSet = new Set(tellerUsers.results.map(r => r.user_id));
  const plaidUserSet = new Set(plaidUsers.results.map(r => r.user_id));

  for (const userId of allUserIds) {
    let imported = 0;
    let dupes = 0;
    let accountsSynced = 0;
    let failed = false;
    let errorMsg: string | undefined;

    if (tellerUserSet.has(userId)) {
      try {
        const result = await syncTellerTransactionsForUser(env, userId, null, null);
        imported += result.transactions_imported;
        dupes += result.duplicates_skipped;
        accountsSynced += result.account_ids_synced?.length ?? 0;
      } catch (err) {
        failed = true;
        errorMsg = `Teller: ${err instanceof Error ? err.message : String(err)}`;
        console.error('[nightly-sync] Teller failed', { userId, error: String(err) });
      }
    }

    if (plaidUserSet.has(userId)) {
      try {
        const result = await syncPlaidTransactionsForUser(env, userId);
        imported += result.transactions_imported;
        dupes += result.duplicates_skipped;
        accountsSynced += result.account_ids_synced?.length ?? 0;
      } catch (err) {
        failed = true;
        const plaidErr = `Plaid: ${err instanceof Error ? err.message : String(err)}`;
        errorMsg = errorMsg ? `${errorMsg}; ${plaidErr}` : plaidErr;
        console.error('[nightly-sync] Plaid failed', { userId, error: String(err) });
      }
    }

    if (failed) {
      summary.users_failed += 1;
      summary.per_user.push({ user_id: userId, status: 'error', error: errorMsg });
    } else {
      summary.users_synced += 1;
      summary.per_user.push({
        user_id: userId,
        status: 'ok',
        transactions_imported: imported,
        duplicates_skipped: dupes,
        accounts_synced: accountsSynced,
      });
    }
  }

  summary.finished_at = new Date().toISOString();
  console.log('[nightly-sync] summary', summary);
  return summary;
}
