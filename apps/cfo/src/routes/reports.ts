/**
 * Reporting REST endpoints. Generation runs synchronously — the data
 * volumes here are small enough (single-family bookkeeping) that batch
 * Sheets writes finish in seconds.
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';
import { getReportConfig, generateReport, type ReportConfig } from '../lib/report-generator';
import { publishReport } from '../lib/google-sheets';

interface ConfigBody {
  name: string;
  entity_ids?: string[];
  category_ids?: string[];
  category_mode?: 'tax' | 'budget' | 'all';
  include_transactions?: boolean;
  drive_folder_id?: string | null;
  notes?: string | null;
}

export async function handleListReportConfigs(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const configs = await sql<Array<ReportConfig & { updated_at: string }>>`
      SELECT id, name, entity_ids, category_ids, category_mode,
             include_transactions, drive_folder_id, notes, updated_at
      FROM report_configs
      WHERE is_active = true
      ORDER BY name
    `;
    // Attach last run summary.
    const lastRuns = await sql<Array<{ config_id: string; generated_at: string; drive_link: string | null; status: string }>>`
      SELECT DISTINCT ON (config_id) config_id, generated_at, drive_link, status
      FROM report_runs
      ORDER BY config_id, generated_at DESC
    `;
    const byConfig = new Map(lastRuns.map(r => [r.config_id, r]));
    return jsonOk({
      configs: configs.map(c => ({
        ...c,
        last_run: byConfig.get(c.id) ?? null,
      })),
    });
  } catch (err) {
    return jsonError(`list configs failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleCreateReportConfig(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as ConfigBody | null;
  if (!body?.name) return jsonError('name required', 400);
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO report_configs (name, entity_ids, category_ids, category_mode, include_transactions, drive_folder_id, notes)
      VALUES (${body.name},
              ${body.entity_ids ?? []},
              ${body.category_ids ?? []},
              ${body.category_mode ?? 'all'},
              ${body.include_transactions ?? true},
              ${body.drive_folder_id ?? null},
              ${body.notes ?? null})
      RETURNING id
    `;
    return jsonOk({ id: rows[0]!.id });
  } catch (err) {
    return jsonError(`create config failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdateReportConfig(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as Partial<ConfigBody> & { is_active?: boolean } | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    if ('name' in body) await sql`UPDATE report_configs SET name = ${body.name ?? ''}, updated_at = now() WHERE id = ${id}`;
    if ('entity_ids' in body) await sql`UPDATE report_configs SET entity_ids = ${body.entity_ids ?? []}, updated_at = now() WHERE id = ${id}`;
    if ('category_ids' in body) await sql`UPDATE report_configs SET category_ids = ${body.category_ids ?? []}, updated_at = now() WHERE id = ${id}`;
    if ('category_mode' in body) await sql`UPDATE report_configs SET category_mode = ${body.category_mode ?? 'all'}, updated_at = now() WHERE id = ${id}`;
    if ('include_transactions' in body) await sql`UPDATE report_configs SET include_transactions = ${body.include_transactions ?? true}, updated_at = now() WHERE id = ${id}`;
    if ('drive_folder_id' in body) await sql`UPDATE report_configs SET drive_folder_id = ${body.drive_folder_id ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('notes' in body) await sql`UPDATE report_configs SET notes = ${body.notes ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('is_active' in body) await sql`UPDATE report_configs SET is_active = ${body.is_active ?? true}, updated_at = now() WHERE id = ${id}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update config failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleListReportRuns(_req: Request, env: Env, configId: string): Promise<Response> {
  const sql = db(env);
  try {
    const runs = await sql<Array<{
      id: string; date_from: string; date_to: string; generated_at: string;
      drive_link: string | null; file_name: string | null; status: string;
      error_message: string | null; transaction_count: number | null;
      unreviewed_warning_count: number | null;
    }>>`
      SELECT id, to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to,
             generated_at, drive_link, file_name, status, error_message,
             transaction_count, unreviewed_warning_count
      FROM report_runs
      WHERE config_id = ${configId}
      ORDER BY generated_at DESC
      LIMIT 50
    `;
    return jsonOk({ runs });
  } catch (err) {
    return jsonError(`list runs failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleGetReportRun(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, config_id, to_char(date_from, 'YYYY-MM-DD') AS date_from,
             to_char(date_to, 'YYYY-MM-DD') AS date_to,
             generated_at, drive_link, file_name, status, error_message,
             transaction_count, unreviewed_warning_count
      FROM report_runs WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) return jsonError('not found', 404);
    return jsonOk(rows[0]!);
  } catch (err) {
    return jsonError(`get run failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface GenerateBody {
  date_from?: string;
  date_to?: string;
  period?: 'last_month' | 'last_quarter' | 'last_year' | 'ytd' | 'custom';
}

function resolvePeriod(period: GenerateBody['period'], customFrom?: string, customTo?: string): { from: string; to: string; label: string } {
  const today = new Date();
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  switch (period) {
    case 'last_month': {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
      return { from: toIso(start), to: toIso(end), label: `${start.toLocaleString('en-US', { month: 'short' })} ${start.getUTCFullYear()}` };
    }
    case 'last_quarter': {
      const q = Math.floor(today.getUTCMonth() / 3);
      const start = new Date(Date.UTC(today.getUTCFullYear(), (q - 1) * 3, 1));
      const end = new Date(Date.UTC(today.getUTCFullYear(), q * 3, 0));
      return { from: toIso(start), to: toIso(end), label: `Q${q === 0 ? 4 : q} ${q === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear()}` };
    }
    case 'last_year': {
      const y = today.getUTCFullYear() - 1;
      return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
    }
    case 'ytd':
      return { from: `${today.getUTCFullYear()}-01-01`, to: toIso(today), label: `YTD ${today.getUTCFullYear()}` };
    case 'custom':
    default: {
      const from = customFrom ?? `${today.getUTCFullYear()}-01-01`;
      const to = customTo ?? toIso(today);
      return { from, to, label: `${from} to ${to}` };
    }
  }
}

export async function handleGenerateReport(req: Request, env: Env, configId: string): Promise<Response> {
  const body = await req.json().catch(() => ({})) as GenerateBody;
  const { from, to, label } = resolvePeriod(body.period, body.date_from, body.date_to);

  const config = await getReportConfig(env, configId);
  if (!config) return jsonError('config not found', 404);

  const sql = db(env);
  let runId: string | null = null;
  try {
    const insertRows = await sql<Array<{ id: string }>>`
      INSERT INTO report_runs (config_id, date_from, date_to, status)
      VALUES (${configId}, ${from}, ${to}, 'running')
      RETURNING id
    `;
    runId = insertRows[0]!.id;

    const report = await generateReport(env, config, from, to);
    const fileName = `${config.name} — ${label} — Generated ${new Date().toISOString().slice(0, 10)}`;
    const published = await publishReport(env, report, {
      fileName,
      folderId: config.drive_folder_id,
      includeTransactions: config.include_transactions,
    });
    const txCount = report.sections.reduce((s, sec) => s + sec.lines.reduce((n, l) => n + (l.transactions?.length ?? 0), 0), 0);

    await sql`
      UPDATE report_runs
      SET status = 'complete', drive_link = ${published.spreadsheetUrl},
          file_name = ${published.fileName},
          transaction_count = ${txCount},
          unreviewed_warning_count = ${report.unreviewed_warning_count}
      WHERE id = ${runId}
    `;

    return jsonOk({
      run_id: runId,
      drive_link: published.spreadsheetUrl,
      file_name: published.fileName,
      transaction_count: txCount,
      unreviewed_warning_count: report.unreviewed_warning_count,
      report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (runId) {
      await sql`UPDATE report_runs SET status = 'failed', error_message = ${message} WHERE id = ${runId}`.catch(() => {});
    }
    return jsonError(`generate failed: ${message}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
