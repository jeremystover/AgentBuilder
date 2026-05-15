import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db, type Sql } from '../lib/db';
import {
  getTellerConnectConfig,
  listAccounts,
  listTransactions,
  type TellerAccount,
  type TellerEnrollmentPayload,
  type TellerTransaction,
} from '../lib/teller';
import { cleanDescription, computeDedupHash } from '../lib/dedup';

const DEFAULT_SYNC_WINDOW_DAYS = 90;

interface ReconnectRequiredError {
  kind: 'reconnect_required';
  enrollment_id: string;
  institution_name: string | null;
  message: string;
}

interface SyncResult {
  enrollment_id: string;
  institution_name: string | null;
  transactions_found: number;
  transactions_new: number;
  reconnect_required?: boolean;
  error?: string;
}

function isDisconnected(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('enrollment.disconnected');
}

function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Enroll ────────────────────────────────────────────────────────────────────

export async function handleTellerEnroll(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as Partial<TellerEnrollmentPayload> | null;
  if (!body?.access_token || !body.enrollment_id) {
    return jsonError('access_token and enrollment_id are required', 400);
  }

  const sql = db(env);
  try {
    const enrollmentRowId = `enr_${body.enrollment_id}`;
    await sql`
      INSERT INTO teller_enrollments (id, enrollment_id, access_token, institution_id, institution_name)
      VALUES (${enrollmentRowId}, ${body.enrollment_id}, ${body.access_token},
              ${body.institution_id ?? null}, ${body.institution_name ?? null})
      ON CONFLICT (enrollment_id) DO UPDATE SET
        access_token     = EXCLUDED.access_token,
        institution_id   = EXCLUDED.institution_id,
        institution_name = EXCLUDED.institution_name
    `;

    // Fetch accounts and upsert into gather_accounts.
    const accounts = await listAccounts(env, body.access_token);
    for (const acct of accounts) {
      await upsertGatherAccount(sql, acct, body.enrollment_id);
    }

    return jsonOk({
      enrollment_id: body.enrollment_id,
      accounts: accounts.length,
      connect_config: getTellerConnectConfig(env),
    });
  } catch (err) {
    return jsonError(`teller enroll failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function upsertGatherAccount(sql: Sql, acct: TellerAccount, enrollmentId: string): Promise<void> {
  const id = `acct_${acct.id}`;
  const type = mapTellerType(acct.type, acct.subtype);
  await sql`
    INSERT INTO gather_accounts
      (id, name, institution, type, source, teller_account_id, teller_enrollment_id, last_synced_at)
    VALUES
      (${id}, ${acct.name}, ${acct.institution.name}, ${type}, 'teller',
       ${acct.id}, ${enrollmentId}, NULL)
    ON CONFLICT (teller_account_id) DO UPDATE SET
      name                 = EXCLUDED.name,
      institution          = EXCLUDED.institution,
      type                 = EXCLUDED.type,
      teller_enrollment_id = EXCLUDED.teller_enrollment_id,
      updated_at           = now()
  `;
}

function mapTellerType(type: string, subtype: string | null): string {
  const t = (type ?? '').toLowerCase();
  const s = (subtype ?? '').toLowerCase();
  if (t === 'credit' || s === 'credit_card') return 'credit';
  if (t === 'depository' && s === 'savings') return 'savings';
  if (t === 'depository') return 'checking';
  if (t === 'investment') return 'investment';
  if (t === 'loan') return 'loan';
  return 'other';
}

// ── List accounts ─────────────────────────────────────────────────────────────

export async function handleTellerListAccounts(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{
      id: string;
      name: string;
      institution: string | null;
      type: string;
      teller_account_id: string | null;
      teller_enrollment_id: string | null;
      last_synced_at: string | null;
      is_active: boolean;
    }>>`
      SELECT id, name, institution, type, teller_account_id, teller_enrollment_id,
             last_synced_at, is_active
      FROM gather_accounts
      WHERE source = 'teller'
      ORDER BY institution NULLS LAST, name
    `;
    return jsonOk({ accounts: rows });
  } catch (err) {
    return jsonError(`teller list accounts failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Delete enrollment ─────────────────────────────────────────────────────────

export async function handleTellerDeleteEnrollment(_req: Request, env: Env, enrollmentId: string): Promise<Response> {
  const sql = db(env);
  try {
    await sql`UPDATE gather_accounts SET is_active = false WHERE teller_enrollment_id = ${enrollmentId}`;
    const deleted = await sql`DELETE FROM teller_enrollments WHERE enrollment_id = ${enrollmentId} RETURNING enrollment_id`;
    return jsonOk({ deleted: deleted.length });
  } catch (err) {
    return jsonError(`teller delete failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export async function handleTellerSync(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { account_ids?: string[]; days?: number } | undefined;
  try {
    const out = await runTellerSync(env, body ?? {});
    return jsonOk(out);
  } catch (err) {
    return jsonError(`teller sync failed: ${String(err)}`, 500);
  }
}

export interface RunTellerSyncOpts {
  account_ids?: string[];
  days?: number;
}

export interface RunTellerSyncResult {
  results: SyncResult[];
  reconnect_required: ReconnectRequiredError[];
}

export async function runTellerSync(
  env: Env,
  opts: RunTellerSyncOpts = {},
  onProgress?: (event: object) => void,
): Promise<RunTellerSyncResult> {
  const accountIdsFilter = new Set(opts.account_ids ?? []);
  const days = opts.days ?? DEFAULT_SYNC_WINDOW_DAYS;
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = shiftIsoDate(endDate, -days);

  const sql = db(env);
  const results: SyncResult[] = [];
  const reconnectRequired: ReconnectRequiredError[] = [];

  try {
    const enrollments = await sql<Array<{
      id: string;
      enrollment_id: string;
      access_token: string;
      institution_name: string | null;
    }>>`SELECT id, enrollment_id, access_token, institution_name FROM teller_enrollments`;

    // Pre-count total accounts for progress reporting
    const countRows = await sql<Array<{ c: string }>>`
      SELECT COUNT(*) AS c FROM gather_accounts
      WHERE is_active = true AND teller_account_id IS NOT NULL
    `;
    const total = Number(countRows[0]?.c ?? 0);
    console.log(`[teller-sync] enrollments=${enrollments.length} total_active_accounts=${total}`);
    onProgress?.({ type: 'start', total });

    let accountIdx = 0;
    for (const enr of enrollments) {
      const accounts = await sql<Array<{ id: string; teller_account_id: string | null; name: string }>>`
        SELECT id, teller_account_id, name
        FROM gather_accounts
        WHERE teller_enrollment_id = ${enr.enrollment_id}
          AND is_active = true
          AND teller_account_id IS NOT NULL
      `;
      console.log(`[teller-sync] enrollment=${enr.enrollment_id} institution=${enr.institution_name} accounts=${accounts.length}`);

      for (const acct of accounts) {
        if (!acct.teller_account_id) continue;
        if (accountIdsFilter.size > 0 && !accountIdsFilter.has(acct.id)) continue;

        const idx = accountIdx++;
        onProgress?.({ type: 'account_start', index: idx, total, institution: enr.institution_name, name: acct.name });

        const syncId = await startSyncLog(sql, acct.id);
        try {
          const txs = await listTransactions(env, enr.access_token, acct.teller_account_id, {
            startDate,
            endDate,
          });
          const { found, added } = await ingestTellerTransactions(sql, acct.id, txs);
          await completeSyncLog(sql, syncId, found, added);
          await sql`UPDATE gather_accounts SET last_synced_at = now() WHERE id = ${acct.id}`;
          onProgress?.({ type: 'account_ok', index: idx, total, institution: enr.institution_name, name: acct.name, found, added });
          results.push({
            enrollment_id: enr.enrollment_id,
            institution_name: enr.institution_name,
            transactions_found: found,
            transactions_new: added,
          });
        } catch (err) {
          await failSyncLog(sql, syncId, String(err));
          onProgress?.({
            type: 'account_err',
            index: idx,
            total,
            institution: enr.institution_name,
            name: acct.name,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          if (isDisconnected(err)) {
            reconnectRequired.push({
              kind: 'reconnect_required',
              enrollment_id: enr.enrollment_id,
              institution_name: enr.institution_name,
              message: 'Bank re-enrollment required: MFA was requested by the institution.',
            });
            results.push({
              enrollment_id: enr.enrollment_id,
              institution_name: enr.institution_name,
              transactions_found: 0,
              transactions_new: 0,
              reconnect_required: true,
              error: String(err),
            });
            break; // Skip remaining accounts in this enrollment
          }
          results.push({
            enrollment_id: enr.enrollment_id,
            institution_name: enr.institution_name,
            transactions_found: 0,
            transactions_new: 0,
            error: String(err),
          });
        }
      }

      await sql`UPDATE teller_enrollments SET last_synced_at = now() WHERE enrollment_id = ${enr.enrollment_id}`;
    }

    return { results, reconnect_required: reconnectRequired };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function startSyncLog(sql: Sql, accountId: string): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO sync_log (source, account_id, status)
    VALUES ('teller', ${accountId}, 'running')
    RETURNING id
  `;
  return rows[0]!.id;
}

async function completeSyncLog(sql: Sql, id: string, found: number, added: number): Promise<void> {
  await sql`
    UPDATE sync_log
    SET status = 'completed',
        completed_at = now(),
        transactions_found = ${found},
        transactions_new = ${added}
    WHERE id = ${id}
  `;
}

async function failSyncLog(sql: Sql, id: string, message: string): Promise<void> {
  await sql`
    UPDATE sync_log
    SET status = 'failed',
        completed_at = now(),
        error_message = ${message}
    WHERE id = ${id}
  `;
}

/**
 * Stage Teller transactions into raw_transactions. Returns counts.
 *
 * Two algorithms preserved from the old CFO:
 *
 * 1. Pending → posted reconciliation. When a new posted transaction
 *    arrives, look for a pending row on the same account within ±10 days
 *    with matching amount and cleaned description. If found, promote it
 *    in place rather than inserting a duplicate.
 *
 * 2. Duplicate skip via UNIQUE (source, external_id) and dedup_hash.
 */
async function ingestTellerTransactions(
  sql: Sql,
  accountId: string,
  txs: TellerTransaction[],
): Promise<{ found: number; added: number }> {
  if (txs.length === 0) return { found: 0, added: 0 };

  // Load existing pending raw rows for this account once for in-memory matching.
  const pending = await sql<Array<{
    id: string;
    external_id: string | null;
    amount: string;
    description: string;
    date: string;
  }>>`
    SELECT id, external_id, amount::text, description, to_char(date, 'YYYY-MM-DD') AS date
    FROM raw_transactions
    WHERE account_id = ${accountId}
      AND source = 'teller'
      AND status = 'waiting'
  `;
  const pendingList = pending.map(p => ({
    id: p.id,
    external_id: p.external_id,
    amount: Number(p.amount),
    description_clean: cleanDescription(p.description),
    date: p.date,
  }));

  let added = 0;
  for (const tx of txs) {
    const amount = Number(tx.amount);
    const descClean = cleanDescription(tx.description);
    const merchant = tx.details?.counterparty?.name ?? null;
    const dedupHash = await computeDedupHash(accountId, tx.date, amount, tx.description);
    const isPosted = tx.status === 'posted';

    if (isPosted) {
      // Algorithm 1: pending → posted reconciliation
      const lo = shiftIsoDate(tx.date, -10);
      const hi = shiftIsoDate(tx.date, 10);
      const matchIdx = pendingList.findIndex(
        p => p.amount === amount && p.description_clean === descClean && p.date >= lo && p.date <= hi,
      );
      if (matchIdx !== -1) {
        const match = pendingList[matchIdx]!;
        pendingList.splice(matchIdx, 1);
        await sql`
          UPDATE raw_transactions
          SET external_id = ${tx.id},
              date        = ${tx.date},
              amount      = ${amount},
              description = ${tx.description},
              merchant    = ${merchant},
              raw_payload = ${JSON.stringify(tx)}::jsonb,
              dedup_hash  = ${dedupHash},
              status      = 'staged'
          WHERE id = ${match.id}
        `;
        continue;
      }
    }

    // New row — insert, skipping conflicts on (source, external_id) or dedup_hash.
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO raw_transactions
        (account_id, source, external_id, date, amount, description, merchant,
         raw_payload, dedup_hash, status)
      VALUES
        (${accountId}, 'teller', ${tx.id}, ${tx.date}, ${amount}, ${tx.description},
         ${merchant}, ${JSON.stringify(tx)}::jsonb, ${dedupHash},
         ${isPosted ? 'staged' : 'waiting'})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (rows.length > 0) added++;
  }

  return { found: txs.length, added };
}
