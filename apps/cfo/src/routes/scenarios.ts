/**
 * Scenarios module — Phase 5 surface (Account Setup + Historical View).
 *
 *   GET    /api/web/scenario-accounts
 *   POST   /api/web/scenario-accounts
 *   GET    /api/web/scenario-accounts/:id
 *   PUT    /api/web/scenario-accounts/:id
 *   DELETE /api/web/scenario-accounts/:id
 *
 *   GET    /api/web/scenario-accounts/:id/rate-schedule
 *   PUT    /api/web/scenario-accounts/:id/rate-schedule
 *   GET    /api/web/scenario-accounts/:id/balance-history
 *   POST   /api/web/scenario-accounts/:id/balance-history
 *   PUT    /api/web/scenario-accounts/:id/balance-history/:entryId
 *   DELETE /api/web/scenario-accounts/:id/balance-history/:entryId
 *   GET    /api/web/scenario-accounts/:id/rate-comparison?from=&to=
 *
 * The Phase 6 projection engine will extend this file with /api/web/scenarios
 * endpoints.
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';
import {
  validateAccountTypeConfig, inferAssetOrLiability,
  type AccountType,
} from '../lib/account-config-validation';
import { calculateActualRate, getConfiguredRateAtDate } from '../lib/account-analytics';

// ── Accounts CRUD ────────────────────────────────────────────────────────────

interface AccountBody {
  name: string;
  type: AccountType;
  entity_id?: string | null;
  current_balance?: number | null;
  teller_account_id?: string | null;
  is_active?: boolean;
  notes?: string | null;
  config?: Record<string, unknown>;
}

export async function handleListScenarioAccounts(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT
        sa.id, sa.name, sa.type, sa.asset_or_liability,
        sa.entity_id, sa.is_active, sa.notes, sa.teller_account_id,
        sa.current_balance::text AS current_balance,
        e.name AS entity_name,
        atc.config_json AS config,
        (SELECT abh.balance::text FROM account_balance_history abh
          WHERE abh.account_id = sa.id ORDER BY abh.recorded_date DESC LIMIT 1) AS latest_balance,
        (SELECT to_char(abh.recorded_date, 'YYYY-MM-DD') FROM account_balance_history abh
          WHERE abh.account_id = sa.id ORDER BY abh.recorded_date DESC LIMIT 1) AS latest_balance_date,
        (SELECT ars.base_rate::text FROM account_rate_schedule ars
          WHERE ars.account_id = sa.id AND ars.effective_date <= CURRENT_DATE
          ORDER BY ars.effective_date DESC LIMIT 1) AS current_rate
      FROM scenario_accounts sa
      LEFT JOIN entities e ON e.id = sa.entity_id
      LEFT JOIN account_type_config atc ON atc.account_id = sa.id
      WHERE sa.is_active = true
      ORDER BY sa.asset_or_liability, sa.name
    `;
    return jsonOk({
      accounts: rows.map(r => ({
        ...r,
        current_balance: r.current_balance == null ? null : Number(r.current_balance),
        latest_balance:  r.latest_balance == null ? null : Number(r.latest_balance),
        current_rate:    r.current_rate == null ? null : Number(r.current_rate),
      })),
    });
  } catch (err) {
    return jsonError(`list accounts failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleGetScenarioAccount(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT sa.id, sa.name, sa.type, sa.asset_or_liability,
             sa.entity_id, sa.is_active, sa.notes, sa.teller_account_id,
             sa.current_balance::text AS current_balance,
             atc.config_json AS config
      FROM scenario_accounts sa
      LEFT JOIN account_type_config atc ON atc.account_id = sa.id
      WHERE sa.id = ${id}
    `;
    if (rows.length === 0) return jsonError('account not found', 404);
    const r = rows[0]!;
    return jsonOk({
      ...r,
      current_balance: r.current_balance == null ? null : Number(r.current_balance),
    });
  } catch (err) {
    return jsonError(`get account failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleCreateScenarioAccount(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as AccountBody | null;
  if (!body?.name || !body.type) return jsonError('name and type required', 400);
  const config = body.config ?? {};
  const errors = validateAccountTypeConfig(body.type, config);
  if (errors.length > 0) return jsonError(`invalid config: ${errors.map(e => e.message).join('; ')}`, 400);

  const sql = db(env);
  try {
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO scenario_accounts
        (name, type, asset_or_liability, entity_id, current_balance, teller_account_id, is_active, notes)
      VALUES
        (${body.name}, ${body.type}, ${inferAssetOrLiability(body.type)},
         ${body.entity_id ?? null}, ${body.current_balance ?? null},
         ${body.teller_account_id ?? null},
         ${body.is_active ?? true}, ${body.notes ?? null})
      RETURNING id
    `;
    const id = inserted[0]!.id;
    await sql`
      INSERT INTO account_type_config (account_id, config_json)
      VALUES (${id}, ${JSON.stringify(config)}::jsonb)
    `;
    return jsonOk({ id });
  } catch (err) {
    return jsonError(`create account failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdateScenarioAccount(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as Partial<AccountBody> | null;
  if (!body) return jsonError('invalid body', 400);

  if (body.config !== undefined && body.type) {
    const errors = validateAccountTypeConfig(body.type, body.config);
    if (errors.length > 0) return jsonError(`invalid config: ${errors.map(e => e.message).join('; ')}`, 400);
  }

  const sql = db(env);
  try {
    if ('name' in body)              await sql`UPDATE scenario_accounts SET name = ${body.name ?? ''},                       updated_at = now() WHERE id = ${id}`;
    if ('type' in body)              await sql`UPDATE scenario_accounts SET type = ${body.type ?? 'other_asset'},
                                                                            asset_or_liability = ${inferAssetOrLiability(body.type ?? 'other_asset')},
                                                                            updated_at = now() WHERE id = ${id}`;
    if ('entity_id' in body)         await sql`UPDATE scenario_accounts SET entity_id = ${body.entity_id ?? null},           updated_at = now() WHERE id = ${id}`;
    if ('current_balance' in body)   await sql`UPDATE scenario_accounts SET current_balance = ${body.current_balance ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('teller_account_id' in body) await sql`UPDATE scenario_accounts SET teller_account_id = ${body.teller_account_id ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('is_active' in body)         await sql`UPDATE scenario_accounts SET is_active = ${body.is_active ?? true},          updated_at = now() WHERE id = ${id}`;
    if ('notes' in body)             await sql`UPDATE scenario_accounts SET notes = ${body.notes ?? null},                   updated_at = now() WHERE id = ${id}`;
    if (body.config !== undefined) {
      await sql`
        INSERT INTO account_type_config (account_id, config_json)
        VALUES (${id}, ${JSON.stringify(body.config)}::jsonb)
        ON CONFLICT (account_id) DO UPDATE SET config_json = EXCLUDED.config_json
      `;
    }
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update account failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleArchiveScenarioAccount(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    await sql`UPDATE scenario_accounts SET is_active = false, updated_at = now() WHERE id = ${id}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`archive account failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Rate schedule ────────────────────────────────────────────────────────────

export async function handleGetRateSchedule(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string; base_rate: string; effective_date: string; notes: string | null }>>`
      SELECT id, base_rate::text AS base_rate,
             to_char(effective_date, 'YYYY-MM-DD') AS effective_date,
             notes
      FROM account_rate_schedule
      WHERE account_id = ${id}
      ORDER BY effective_date
    `;
    return jsonOk({
      entries: rows.map(r => ({ ...r, base_rate: Number(r.base_rate) })),
    });
  } catch (err) {
    return jsonError(`get rate schedule failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface RateScheduleEntryBody { base_rate: number; effective_date: string; notes?: string | null }

export async function handleReplaceRateSchedule(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as { entries?: RateScheduleEntryBody[] } | null;
  const entries = body?.entries ?? [];
  if (!Array.isArray(entries)) return jsonError('entries must be an array', 400);
  const sql = db(env);
  try {
    await sql`DELETE FROM account_rate_schedule WHERE account_id = ${id}`;
    for (const e of entries) {
      await sql`
        INSERT INTO account_rate_schedule (account_id, base_rate, effective_date, notes)
        VALUES (${id}, ${e.base_rate}, ${e.effective_date}, ${e.notes ?? null})
      `;
    }
    return jsonOk({ ok: true, count: entries.length });
  } catch (err) {
    return jsonError(`replace rate schedule failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Balance history ──────────────────────────────────────────────────────────

export async function handleListBalanceHistory(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string; balance: string; recorded_date: string; source: string; notes: string | null }>>`
      SELECT id, balance::text AS balance,
             to_char(recorded_date, 'YYYY-MM-DD') AS recorded_date,
             source, notes
      FROM account_balance_history
      WHERE account_id = ${id}
      ORDER BY recorded_date DESC
    `;
    return jsonOk({
      entries: rows.map(r => ({ ...r, balance: Number(r.balance) })),
    });
  } catch (err) {
    return jsonError(`list balance history failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface BalanceEntryBody { balance: number; recorded_date: string; source?: string; notes?: string | null }

export async function handleCreateBalanceEntry(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as BalanceEntryBody | null;
  if (!body || typeof body.balance !== 'number' || !body.recorded_date) {
    return jsonError('balance and recorded_date required', 400);
  }
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO account_balance_history (account_id, balance, recorded_date, source, notes)
      VALUES (${id}, ${body.balance}, ${body.recorded_date}, ${body.source ?? 'manual'}, ${body.notes ?? null})
      RETURNING id
    `;
    return jsonOk({ id: rows[0]!.id });
  } catch (err) {
    return jsonError(`create balance entry failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdateBalanceEntry(
  req: Request, env: Env, _id: string, entryId: string,
): Promise<Response> {
  const body = await req.json().catch(() => null) as Partial<BalanceEntryBody> | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    if ('balance' in body)       await sql`UPDATE account_balance_history SET balance = ${body.balance ?? 0} WHERE id = ${entryId}`;
    if ('recorded_date' in body) await sql`UPDATE account_balance_history SET recorded_date = ${body.recorded_date ?? null} WHERE id = ${entryId}`;
    if ('notes' in body)         await sql`UPDATE account_balance_history SET notes = ${body.notes ?? null} WHERE id = ${entryId}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update balance entry failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleDeleteBalanceEntry(
  _req: Request, env: Env, _id: string, entryId: string,
): Promise<Response> {
  const sql = db(env);
  try {
    await sql`DELETE FROM account_balance_history WHERE id = ${entryId}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`delete balance entry failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Rate comparison ──────────────────────────────────────────────────────────

export async function handleRateComparison(req: Request, env: Env, id: string): Promise<Response> {
  const url = new URL(req.url);
  const fromStr = url.searchParams.get('from');
  const toStr   = url.searchParams.get('to');
  if (!fromStr || !toStr) return jsonError('from and to query params required', 400);
  const from = new Date(`${fromStr}T00:00:00Z`);
  const to   = new Date(`${toStr}T00:00:00Z`);
  if (isNaN(+from) || isNaN(+to) || to.getTime() <= from.getTime()) {
    return jsonError('invalid date range', 400);
  }
  const sql = db(env);
  try {
    // Closest balance on/before each anchor.
    const startRows = await sql<Array<{ balance: string; recorded_date: string }>>`
      SELECT balance::text AS balance, to_char(recorded_date, 'YYYY-MM-DD') AS recorded_date
      FROM account_balance_history
      WHERE account_id = ${id} AND recorded_date <= ${fromStr}
      ORDER BY recorded_date DESC LIMIT 1
    `;
    const endRows = await sql<Array<{ balance: string; recorded_date: string }>>`
      SELECT balance::text AS balance, to_char(recorded_date, 'YYYY-MM-DD') AS recorded_date
      FROM account_balance_history
      WHERE account_id = ${id} AND recorded_date <= ${toStr}
      ORDER BY recorded_date DESC LIMIT 1
    `;
    const startBal = startRows[0] ? Number(startRows[0].balance) : null;
    const endBal   = endRows[0] ? Number(endRows[0].balance) : null;

    const rateRows = await sql<Array<{ base_rate: string; effective_date: string }>>`
      SELECT base_rate::text AS base_rate, to_char(effective_date, 'YYYY-MM-DD') AS effective_date
      FROM account_rate_schedule
      WHERE account_id = ${id}
      ORDER BY effective_date
    `;
    const schedule = rateRows.map(r => ({ base_rate: Number(r.base_rate), effective_date: r.effective_date }));

    const actualStartDate = startRows[0] ? new Date(`${startRows[0].recorded_date}T00:00:00Z`) : from;
    const actualEndDate   = endRows[0]   ? new Date(`${endRows[0].recorded_date}T00:00:00Z`)   : to;
    const actualRate = (startBal != null && endBal != null)
      ? calculateActualRate(startBal, endBal, actualStartDate, actualEndDate)
      : null;
    const configuredAtStart = getConfiguredRateAtDate(schedule, actualStartDate);
    const configuredAtEnd   = getConfiguredRateAtDate(schedule, actualEndDate);

    return jsonOk({
      from: actualStartDate.toISOString().slice(0, 10),
      to:   actualEndDate.toISOString().slice(0, 10),
      start_balance: startBal,
      end_balance:   endBal,
      actual_rate:        actualRate,
      configured_rate_at_start: configuredAtStart,
      configured_rate_at_end:   configuredAtEnd,
    });
  } catch (err) {
    return jsonError(`rate comparison failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
