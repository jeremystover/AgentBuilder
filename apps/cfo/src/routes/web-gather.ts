/**
 * Gather-page status + manual sync triggers. Sync triggers reuse the
 * existing per-source runners.
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';
import { VENDORS, runEmailSync } from '../lib/email-sync';
import { runTellerSync } from './teller';
import { getTellerConnectConfig } from '../lib/teller';
import type { VendorHint } from '../lib/email-matchers/match';

export async function handleGatherStatus(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const enrollments = await sql<Array<{
      enrollment_id: string; institution_name: string | null; last_synced_at: string | null;
      account_count: string;
    }>>`
      SELECT te.enrollment_id, te.institution_name, te.last_synced_at,
             (SELECT COUNT(*)::text FROM gather_accounts ga WHERE ga.teller_enrollment_id = te.enrollment_id AND ga.is_active = true) AS account_count
      FROM teller_enrollments te
      ORDER BY te.institution_name NULLS LAST
    `;

    let email: Array<{ vendor: string; last_processed_at: string | null; unresolved_failures: number }> = [];
    try {
      const rows = await sql<Array<{ vendor: string; last_processed_at: string | null; unresolved_failures: string }>>`
        SELECT vendor, MAX(processed_at) AS last_processed_at,
               COUNT(*) FILTER (WHERE parse_success = false) AS unresolved_failures
        FROM email_processed
        GROUP BY vendor
      `;
      const byVendor = new Map(rows.map(r => [r.vendor, r]));
      email = VENDORS.map(v => ({
        vendor: v,
        last_processed_at: byVendor.get(v)?.last_processed_at ?? null,
        unresolved_failures: Number(byVendor.get(v)?.unresolved_failures ?? 0),
      }));
    } catch { /* table not present */ }

    const recentLog = await sql<Array<{
      id: string; source: string; started_at: string; completed_at: string | null;
      status: string; transactions_found: number; transactions_new: number; error_message: string | null;
    }>>`
      SELECT id, source, started_at, completed_at, status,
             transactions_found, transactions_new, error_message
      FROM sync_log
      ORDER BY started_at DESC
      LIMIT 20
    `;

    let connectConfig = null;
    try { connectConfig = getTellerConnectConfig(env); } catch { /* not configured */ }

    return jsonOk({
      teller: {
        enrollments: enrollments.map(e => ({
          ...e,
          account_count: Number(e.account_count),
        })),
        connect_config: connectConfig,
      },
      email,
      recent_log: recentLog,
    });
  } catch (err) {
    return jsonError(`gather status failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export function handleGatherSync(_req: Request, env: Env, ctx: ExecutionContext, source: string): Response {
  if (source === 'teller') {
    ctx.waitUntil(runTellerSync(env));
    return jsonOk({ source: 'teller', status: 'started' });
  }
  if (source === 'email') {
    ctx.waitUntil(runEmailSync(env));
    return jsonOk({ source: 'email', status: 'started' });
  }
  if (source.startsWith('email:')) {
    const vendor = source.slice('email:'.length) as VendorHint;
    if (!(VENDORS as readonly string[]).includes(vendor)) return jsonError(`unknown vendor: ${vendor}`, 400);
    ctx.waitUntil(runEmailSync(env, [vendor]));
    return jsonOk({ source, status: 'started' });
  }
  return jsonError(`unknown source: ${source}`, 400);
}

/**
 * SSE streaming endpoint. Runs the sync inline (not waitUntil) so progress
 * events can be streamed to the client in real time. The open response body
 * keeps the Worker alive for the duration of the sync.
 */
export function handleGatherSyncStream(_req: Request, env: Env, source: string): Response {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const send = (event: object): void => {
    const payload = JSON.stringify(Object.assign({ source }, event));
    writer.write(enc.encode(`data: ${payload}\n\n`)).catch(() => {});
  };

  (async () => {
    try {
      if (source === 'teller') {
        await runTellerSync(env, {}, send);
      } else if (source === 'email') {
        await runEmailSync(env, undefined, send);
      } else if (source.startsWith('email:')) {
        const vendor = source.slice('email:'.length) as VendorHint;
        if (!(VENDORS as readonly string[]).includes(vendor)) {
          send({ type: 'fatal', message: `unknown vendor: ${vendor}` });
          return;
        }
        await runEmailSync(env, [vendor], send);
      } else {
        send({ type: 'fatal', message: `unknown source: ${source}` });
        return;
      }
      send({ type: 'done' });
    } catch (err) {
      send({
        type: 'fatal',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}
