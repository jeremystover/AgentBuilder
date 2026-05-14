import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';
import { VENDORS } from '../lib/email-sync';

export async function handleSnapshot(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const counts = await sql<Array<{
      pending_review: string;
      waiting: string;
      approved_30d: string;
    }>>`
      SELECT
        (SELECT COUNT(*) FROM raw_transactions WHERE status = 'staged')::text AS pending_review,
        (SELECT COUNT(*) FROM raw_transactions WHERE status = 'waiting')::text AS waiting,
        (SELECT COUNT(*) FROM transactions WHERE status = 'approved' AND approved_at >= now() - interval '30 days')::text AS approved_30d
    `;
    const c = counts[0]!;

    const recentSyncs = await sql<Array<{
      source: string; started_at: string; completed_at: string | null; status: string; transactions_new: number;
    }>>`
      SELECT source, started_at, completed_at, status, transactions_new
      FROM sync_log
      ORDER BY started_at DESC
      LIMIT 10
    `;

    let emailSync: Array<{ vendor: string; last_processed_at: string | null; unresolved_failures: number }> = [];
    try {
      const rows = await sql<Array<{ vendor: string; last_processed_at: string | null; unresolved_failures: string }>>`
        SELECT vendor, MAX(processed_at) AS last_processed_at,
               COUNT(*) FILTER (WHERE parse_success = false) AS unresolved_failures
        FROM email_processed
        GROUP BY vendor
      `;
      const byVendor = new Map(rows.map(r => [r.vendor, r]));
      emailSync = VENDORS.map(v => ({
        vendor: v,
        last_processed_at: byVendor.get(v)?.last_processed_at ?? null,
        unresolved_failures: Number(byVendor.get(v)?.unresolved_failures ?? 0),
      }));
    } catch { /* table may not be migrated yet */ }

    return jsonOk({
      pending_review_count: Number(c.pending_review),
      waiting_count: Number(c.waiting),
      approved_30d_count: Number(c.approved_30d),
      recent_syncs: recentSyncs,
      email_sync: emailSync,
    });
  } catch (err) {
    return jsonError(`snapshot failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
