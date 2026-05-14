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
import { runProjection, DEFAULT_RULES, type AllocationRules } from '../lib/projection-engine';

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

// ── Scenario CRUD ────────────────────────────────────────────────────────────

interface ScenarioBody {
  name: string;
  start_date: string;
  end_date: string;
  plan_id?: string | null;
  account_ids?: string[];
  allocation_rules?: AllocationRules;
}

export async function handleListScenarios(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT s.id, s.name, s.status, s.plan_id,
             to_char(s.start_date, 'YYYY-MM-DD') AS start_date,
             to_char(s.end_date,   'YYYY-MM-DD') AS end_date,
             to_char(s.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
             s.account_ids_json, s.allocation_rules_json,
             (SELECT to_char(ss.run_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM scenario_snapshots ss
              WHERE ss.scenario_id = s.id ORDER BY ss.run_at DESC LIMIT 1) AS last_run_at,
             (SELECT ss.id FROM scenario_snapshots ss
              WHERE ss.scenario_id = s.id ORDER BY ss.run_at DESC LIMIT 1) AS latest_snapshot_id,
             p.name AS plan_name,
             (SELECT (spr.net_worth)::text FROM scenario_snapshots ss
              JOIN scenario_period_results spr ON spr.snapshot_id = ss.id
              WHERE ss.scenario_id = s.id
              ORDER BY ss.run_at DESC, spr.period_date DESC LIMIT 1) AS end_state_net_worth
      FROM scenarios s
      LEFT JOIN plans p ON p.id = s.plan_id
      ORDER BY s.updated_at DESC
    `;
    return jsonOk({
      scenarios: rows.map(r => ({
        ...r,
        end_state_net_worth: r.end_state_net_worth == null ? null : Number(r.end_state_net_worth),
      })),
    });
  } catch (err) {
    return jsonError(`list scenarios failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleCreateScenario(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as ScenarioBody | null;
  if (!body?.name || !body.start_date || !body.end_date) {
    return jsonError('name, start_date, end_date required', 400);
  }
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO scenarios (name, start_date, end_date, plan_id, account_ids_json, allocation_rules_json, status)
      VALUES (
        ${body.name}, ${body.start_date}, ${body.end_date},
        ${body.plan_id ?? null},
        ${JSON.stringify(body.account_ids ?? [])}::jsonb,
        ${JSON.stringify(body.allocation_rules ?? DEFAULT_RULES)}::jsonb,
        'draft'
      )
      RETURNING id
    `;
    return jsonOk({ id: rows[0]!.id });
  } catch (err) {
    return jsonError(`create scenario failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleGetScenario(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, name, status, plan_id,
             to_char(start_date, 'YYYY-MM-DD') AS start_date,
             to_char(end_date,   'YYYY-MM-DD') AS end_date,
             account_ids_json, allocation_rules_json
      FROM scenarios WHERE id = ${id}
    `;
    if (rows.length === 0) return jsonError('scenario not found', 404);
    return jsonOk(rows[0]);
  } catch (err) {
    return jsonError(`get scenario failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdateScenario(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as Partial<ScenarioBody> | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    if ('name' in body)             await sql`UPDATE scenarios SET name = ${body.name ?? ''}, updated_at = now() WHERE id = ${id}`;
    if ('start_date' in body)       await sql`UPDATE scenarios SET start_date = ${body.start_date ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('end_date' in body)         await sql`UPDATE scenarios SET end_date = ${body.end_date ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('plan_id' in body)          await sql`UPDATE scenarios SET plan_id = ${body.plan_id ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('account_ids' in body)      await sql`UPDATE scenarios SET account_ids_json = ${JSON.stringify(body.account_ids ?? [])}::jsonb, updated_at = now() WHERE id = ${id}`;
    if ('allocation_rules' in body) await sql`UPDATE scenarios SET allocation_rules_json = ${JSON.stringify(body.allocation_rules ?? DEFAULT_RULES)}::jsonb, updated_at = now() WHERE id = ${id}`;
    // Mark stale: any edit invalidates the prior run.
    await sql`UPDATE scenarios SET status = 'stale' WHERE id = ${id} AND status = 'complete'`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update scenario failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleDeleteScenario(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    await sql`DELETE FROM scenarios WHERE id = ${id}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`delete scenario failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Run + status ─────────────────────────────────────────────────────────────

export async function handleRunScenario(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string; status: string }>>`SELECT id, status FROM scenarios WHERE id = ${id}`;
    if (rows.length === 0) return jsonError('scenario not found', 404);

    const jobRows = await sql<Array<{ id: string }>>`
      INSERT INTO scenario_jobs (scenario_id, status) VALUES (${id}, 'queued') RETURNING id
    `;
    const jobId = jobRows[0]!.id;
    await sql`UPDATE scenarios SET status = 'running', updated_at = now() WHERE id = ${id}`;

    // Hand off to the queue consumer.
    await env.SCENARIO_QUEUE.send({ scenario_id: id, job_id: jobId } satisfies ScenarioJobMessage);

    return jsonOk({ job_id: jobId, status: 'queued' });
  } catch (err) {
    return jsonError(`run scenario failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleScenarioStatus(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const scenarioRows = await sql<Array<{ status: string }>>`SELECT status FROM scenarios WHERE id = ${id}`;
    if (scenarioRows.length === 0) return jsonError('scenario not found', 404);
    const jobRows = await sql<Array<{
      id: string; status: string; error_message: string | null; progress_note: string | null;
      completed_at: string | null;
    }>>`
      SELECT id, status, error_message, progress_note,
             to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS completed_at
      FROM scenario_jobs WHERE scenario_id = ${id}
      ORDER BY queued_at DESC LIMIT 1
    `;
    const snapshotRows = await sql<Array<{ id: string }>>`
      SELECT id FROM scenario_snapshots WHERE scenario_id = ${id}
      ORDER BY run_at DESC LIMIT 1
    `;
    return jsonOk({
      scenario_status: scenarioRows[0]!.status,
      job: jobRows[0] ?? null,
      latest_snapshot_id: snapshotRows[0]?.id ?? null,
    });
  } catch (err) {
    return jsonError(`status failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleGetSnapshot(_req: Request, env: Env, scenarioId: string, snapshotId: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, scenario_id, pass, status,
             to_char(run_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS run_at,
             inputs_json, results_json
      FROM scenario_snapshots WHERE id = ${snapshotId} AND scenario_id = ${scenarioId}
    `;
    if (rows.length === 0) return jsonError('snapshot not found', 404);
    const periodRows = await sql<Array<Record<string, unknown>>>`
      SELECT to_char(period_date, 'YYYY-MM-DD') AS period_date, period_type,
             gross_income::text       AS gross_income,
             total_expenses::text     AS total_expenses,
             net_cash_pretax::text    AS net_cash_pretax,
             estimated_tax::text      AS estimated_tax,
             net_cash_aftertax::text  AS net_cash_aftertax,
             total_asset_value::text  AS total_asset_value,
             total_liability_value::text AS total_liability_value,
             net_worth::text          AS net_worth,
             account_balances_json
      FROM scenario_period_results WHERE snapshot_id = ${snapshotId}
      ORDER BY period_date
    `;
    const flagRows = await sql<Array<Record<string, unknown>>>`
      SELECT to_char(period_date, 'YYYY-MM-DD') AS period_date, flag_type, description, severity
      FROM scenario_flags WHERE snapshot_id = ${snapshotId}
      ORDER BY period_date
    `;
    const decisionRows = await sql<Array<Record<string, unknown>>>`
      SELECT to_char(period_date, 'YYYY-MM-DD') AS period_date, decision_type,
             pass1_action, pass2_action,
             net_worth_impact::text AS net_worth_impact,
             rationale, flagged_for_review
      FROM allocation_decisions WHERE snapshot_id = ${snapshotId}
      ORDER BY period_date
    `;
    return jsonOk({
      snapshot: rows[0],
      periods: periodRows.map(p => ({
        ...p,
        gross_income: Number(p.gross_income),
        total_expenses: Number(p.total_expenses),
        net_cash_pretax: Number(p.net_cash_pretax),
        estimated_tax: Number(p.estimated_tax),
        net_cash_aftertax: Number(p.net_cash_aftertax),
        total_asset_value: Number(p.total_asset_value),
        total_liability_value: Number(p.total_liability_value),
        net_worth: Number(p.net_worth),
      })),
      flags: flagRows,
      decisions: decisionRows.map(d => ({
        ...d,
        net_worth_impact: d.net_worth_impact == null ? 0 : Number(d.net_worth_impact),
      })),
    });
  } catch (err) {
    return jsonError(`get snapshot failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Queue consumer plumbing ──────────────────────────────────────────────────

export interface ScenarioJobMessage { scenario_id: string; job_id: string }

/**
 * Runs the projection (off the request path) and writes one atomic
 * snapshot. Called from the Queue consumer handler in src/index.ts.
 */
export async function runAndSaveProjection(env: Env, msg: ScenarioJobMessage): Promise<void> {
  const sql = db(env);
  try {
    await sql`UPDATE scenario_jobs SET status = 'running', started_at = now() WHERE id = ${msg.job_id}`;

    const scenarioRows = await sql<Array<{
      id: string; name: string; plan_id: string | null;
      start_date: string; end_date: string;
      account_ids_json: string[] | null; allocation_rules_json: AllocationRules | null;
    }>>`
      SELECT id, name, plan_id,
             to_char(start_date, 'YYYY-MM-DD') AS start_date,
             to_char(end_date,   'YYYY-MM-DD') AS end_date,
             account_ids_json, allocation_rules_json
      FROM scenarios WHERE id = ${msg.scenario_id}
    `;
    if (scenarioRows.length === 0) throw new Error(`scenario ${msg.scenario_id} not found`);
    const scenario = scenarioRows[0]!;
    if (!scenario.plan_id) throw new Error('scenario has no plan_id');

    const accountIds = scenario.account_ids_json ?? [];
    const rules = scenario.allocation_rules_json ?? DEFAULT_RULES;

    const projection = await runProjection(sql, {
      scenarioId:  scenario.id,
      snapshotId:  '',
      planId:      scenario.plan_id,
      accountIds,
      startDate:   new Date(`${scenario.start_date}T00:00:00Z`),
      endDate:     new Date(`${scenario.end_date}T00:00:00Z`),
      allocationRules: rules,
      filingStatus: 'married_filing_jointly',
    });

    // Single atomic write: snapshot + all rows.
    await sql.begin(async tx => {
      const inputs = {
        plan_id: scenario.plan_id,
        account_ids: accountIds,
        start_date: scenario.start_date,
        end_date:   scenario.end_date,
        allocation_rules: rules,
      };
      const summary = {
        period_count: projection.periods.length,
        flag_count:   projection.flags.length,
        end_state_net_worth: projection.periods[projection.periods.length - 1]?.net_worth ?? 0,
      };
      const snapshotRows = await tx<Array<{ id: string }>>`
        INSERT INTO scenario_snapshots (scenario_id, inputs_json, results_json, pass, status)
        VALUES (${msg.scenario_id}, ${JSON.stringify(inputs)}::jsonb, ${JSON.stringify(summary)}::jsonb, 1, 'complete')
        RETURNING id
      `;
      const snapshotId = snapshotRows[0]!.id;

      for (const p of projection.periods) {
        await tx`
          INSERT INTO scenario_period_results
            (snapshot_id, period_date, period_type, gross_income, total_expenses,
             net_cash_pretax, estimated_tax, net_cash_aftertax,
             total_asset_value, total_liability_value, net_worth, account_balances_json)
          VALUES
            (${snapshotId}, ${p.period_date}, ${p.period_type},
             ${p.gross_income}, ${p.total_expenses},
             ${p.net_cash_pretax}, ${p.estimated_tax}, ${p.net_cash_aftertax},
             ${p.total_asset_value}, ${p.total_liability_value}, ${p.net_worth},
             ${JSON.stringify(p.account_balances)}::jsonb)
        `;
      }
      for (const f of projection.flags) {
        await tx`
          INSERT INTO scenario_flags (snapshot_id, period_date, flag_type, description, severity)
          VALUES (${snapshotId}, ${f.period_date}, ${f.flag_type}, ${f.description}, ${f.severity})
        `;
      }
      for (const d of projection.decisions) {
        await tx`
          INSERT INTO allocation_decisions
            (snapshot_id, period_date, decision_type, pass1_action, net_worth_impact, rationale, flagged_for_review)
          VALUES
            (${snapshotId}, ${d.period_date}, ${d.decision_type}, ${d.pass1_action},
             ${d.net_worth_impact}, ${d.rationale}, ${d.flagged_for_review})
        `;
      }
      await tx`UPDATE scenarios SET status = 'complete', updated_at = now() WHERE id = ${msg.scenario_id}`;
      await tx`
        UPDATE scenario_jobs
        SET status = 'complete', completed_at = now(), progress_note = ${`Wrote ${projection.periods.length} period results, ${projection.flags.length} flags`}
        WHERE id = ${msg.job_id}
      `;
    });
  } catch (err) {
    await sql`
      UPDATE scenario_jobs SET status = 'failed', completed_at = now(), error_message = ${String(err)}
      WHERE id = ${msg.job_id}
    `;
    await sql`UPDATE scenarios SET status = 'failed', updated_at = now() WHERE id = ${msg.scenario_id}`;
    throw err;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
