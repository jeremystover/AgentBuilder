import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';
import { VENDORS } from '../lib/email-sync';

export async function handleHealth(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    await sql`SELECT 1`;

    // Email sync stats are best-effort — don't fail health if the table
    // hasn't been migrated yet.
    let email_sync = null;
    try {
      const rows = await sql<Array<{
        vendor: string;
        last_processed_at: string | null;
        unresolved_failures: string;
      }>>`
        SELECT vendor,
               MAX(processed_at) AS last_processed_at,
               COUNT(*) FILTER (WHERE parse_success = false) AS unresolved_failures
        FROM email_processed
        GROUP BY vendor
      `;
      const byVendor = new Map(rows.map(r => [r.vendor, r]));
      email_sync = VENDORS.map(v => ({
        vendor: v,
        last_processed_at: byVendor.get(v)?.last_processed_at ?? null,
        unresolved_failures: Number(byVendor.get(v)?.unresolved_failures ?? 0),
      }));
    } catch {
      // table not yet present
    }

    return jsonOk({
      status: 'ok',
      app: 'cfo',
      db: 'connected',
      email_sync,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return jsonError(`db connection failed: ${String(err)}`, 503);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
