/**
 * Gmail sync routes.
 *
 * Auth is env-var-based (GOOGLE_OAUTH_REFRESH_TOKEN) — the same fleet-wide
 * credential the chief-of-staff uses. No in-app OAuth flow is needed.
 */

import type { Env } from '../types';
import { jsonError, jsonOk, getUserId } from '../types';
import { runNightlyEmailSync } from '../lib/nightly-email-sync';

// GET /gmail/status
// Returns whether the Gmail integration is configured and when it last ran.
export async function handleGmailStatus(request: Request, env: Env): Promise<Response> {
  const configured = !!env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const userId = getUserId(request);

  const state = configured
    ? await env.DB.prepare(
        `SELECT amazon_last_synced_at, venmo_last_synced_at FROM email_sync_state WHERE user_id = ?`,
      ).bind(userId).first<{ amazon_last_synced_at: string | null; venmo_last_synced_at: string | null }>()
    : null;

  return jsonOk({
    configured,
    amazon_last_synced_at: state?.amazon_last_synced_at ?? null,
    venmo_last_synced_at: state?.venmo_last_synced_at ?? null,
    setup_hint: configured
      ? null
      : 'Set GOOGLE_OAUTH_REFRESH_TOKEN via `wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN`. Reuse the same token as the chief-of-staff.',
  });
}

// POST /gmail/sync[?days=N] — manually trigger the nightly email sync.
// Pass ?days=365 to backfill older emails beyond the default 90-day window.
export async function handleGmailSync(request: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    return jsonError(
      'GOOGLE_OAUTH_REFRESH_TOKEN is not configured. Run: wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN',
      503,
    );
  }
  const daysParam = new URL(request.url).searchParams.get('days');
  const lookbackDays = daysParam ? Math.min(Math.max(parseInt(daysParam, 10), 1), 3650) : undefined;
  const result = await runNightlyEmailSync(env, lookbackDays);
  return jsonOk(result);
}
