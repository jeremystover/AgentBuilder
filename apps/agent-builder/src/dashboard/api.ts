/**
 * Dashboard JSON API.
 *
 * GET  /dashboard/api/agents                  → registry view (with cron + tool metadata)
 * GET  /dashboard/api/crons                   → cron jobs flattened across the fleet, with last-run + next-run
 * GET  /dashboard/api/crons/runs?agent=&trigger=&limit=
 *                                             → most recent cron_runs rows
 * GET  /dashboard/api/crons/errors?limit=     → most recent cron_errors rows
 * GET  /dashboard/api/d1                      → list of bound databases with table summaries
 * GET  /dashboard/api/d1/:name/tables         → list tables + row counts for one D1
 * GET  /dashboard/api/d1/:name/table/:t?limit=&offset=&order=
 *                                             → paged rows from one table (read-only)
 *
 * No mutating endpoints. No SELECTs accepted from the client beyond the
 * fixed shapes above — agent D1s often hold credentials, so we keep the
 * surface tight on purpose.
 */

import type { Env } from '../../worker-configuration';
import { REGISTRY, type CronEntry } from './registry-data';
import { nextRunFromCron } from './cron-parser';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ── Fleet D1 binding map ────────────────────────────────────────────────────
//
// Names match the d1.database_name in agents.json + the wrangler.toml binding.
// Add a new line here when wiring a new agent's D1 into the dashboard.
interface D1Binding {
  name: string;
  agentId: string;
  binding: keyof Env;
}

const D1_BINDINGS: D1Binding[] = [
  { name: 'agentbuilder-core', agentId: 'agent-builder', binding: 'DB' },
  { name: 'cfo-db', agentId: 'cfo', binding: 'DB_CFO' },
  { name: 'chief-of-staff-db', agentId: 'chief-of-staff', binding: 'DB_CHIEF_OF_STAFF' },
  { name: 'guest-booking-db', agentId: 'guest-booking', binding: 'DB_GUEST_BOOKING' },
  { name: 'graphic-designer-db', agentId: 'graphic-designer', binding: 'DB_GRAPHIC_DESIGNER' },
  { name: 'research-agent-db', agentId: 'research-agent', binding: 'DB_RESEARCH_AGENT' },
];

function getD1(env: Env, name: string): D1Database | null {
  const entry = D1_BINDINGS.find((b) => b.name === name);
  if (!entry) return null;
  const db = env[entry.binding] as D1Database | undefined;
  return db ?? null;
}

// ── Agents ────────────────────────────────────────────────────────────────

function agentSummary(a: import('./registry-data').AgentEntry) {
  return {
    id: a.id,
    name: a.name,
    purpose: a.purpose,
    owner: a.owner,
    status: a.status,
    kind: a.kind,
    version: a.version,
    lastDeployed: a.lastDeployed ?? null,
    skills: a.skills,
    tools: a.tools.map((t) => ({
      name: t,
      description: a.toolDescriptions?.[t] ?? '',
    })),
    cloudflare: a.cloudflare,
    routing: a.routing,
    crons: a.crons ?? [],
    secrets: a.secrets ?? [],
  };
}

async function getAgents(env: Env): Promise<Response> {
  const summaries = REGISTRY.agents.map(agentSummary);
  let runCounts: Record<string, number> = {};
  let errorCounts: Record<string, number> = {};
  try {
    const runs = await env.DB.prepare(
      'SELECT agent_id, COUNT(*) AS n FROM cron_runs GROUP BY agent_id',
    ).all<{ agent_id: string; n: number }>();
    for (const row of runs.results ?? []) runCounts[row.agent_id] = row.n;
    const errors = await env.DB.prepare(
      "SELECT agent_id, COUNT(*) AS n FROM cron_runs WHERE status = 'error' GROUP BY agent_id",
    ).all<{ agent_id: string; n: number }>();
    for (const row of errors.results ?? []) errorCounts[row.agent_id] = row.n;
  } catch {
    runCounts = {};
    errorCounts = {};
  }
  const agents = summaries.map((a) => ({
    ...a,
    cronRunCount: runCounts[a.id] ?? 0,
    cronErrorCount: errorCounts[a.id] ?? 0,
  }));
  return json({ agents, updatedAt: REGISTRY.updatedAt });
}

// ── Crons ─────────────────────────────────────────────────────────────────

interface CronRunRow {
  run_id: string;
  agent_id: string;
  trigger: string;
  cron_expr: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  status: string;
  summary: string;
  error_summary: string;
}

async function getCrons(env: Env): Promise<Response> {
  type CronJob = CronEntry & {
    agentId: string;
    agentName: string;
    nextRun: string | null;
    lastRun: CronRunRow | null;
    last7d: { ok: number; error: number };
  };

  const jobs: CronJob[] = [];
  for (const a of REGISTRY.agents) {
    for (const c of a.crons ?? []) {
      jobs.push({
        ...c,
        agentId: a.id,
        agentName: a.name,
        nextRun: nextRunFromCron(c.schedule, new Date()),
        lastRun: null,
        last7d: { ok: 0, error: 0 },
      });
    }
  }

  // Fetch last run + 7-day status counts per (agent, trigger).
  try {
    const lastRunRows = await env.DB.prepare(
      `SELECT * FROM cron_runs r1
       WHERE started_at = (
         SELECT MAX(started_at) FROM cron_runs r2
         WHERE r2.agent_id = r1.agent_id AND r2.trigger = r1.trigger
       )`,
    ).all<CronRunRow>();
    const lastByKey = new Map<string, CronRunRow>();
    for (const row of lastRunRows.results ?? []) {
      lastByKey.set(`${row.agent_id}::${row.trigger}`, row);
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentCounts = await env.DB.prepare(
      `SELECT agent_id, trigger, status, COUNT(*) AS n
       FROM cron_runs
       WHERE started_at >= ?
       GROUP BY agent_id, trigger, status`,
    )
      .bind(sevenDaysAgo)
      .all<{ agent_id: string; trigger: string; status: string; n: number }>();
    const countsByKey = new Map<string, { ok: number; error: number }>();
    for (const row of recentCounts.results ?? []) {
      const key = `${row.agent_id}::${row.trigger}`;
      const cur = countsByKey.get(key) ?? { ok: 0, error: 0 };
      if (row.status === 'ok') cur.ok = row.n;
      else if (row.status === 'error') cur.error = row.n;
      countsByKey.set(key, cur);
    }

    for (const j of jobs) {
      const key = `${j.agentId}::${j.trigger}`;
      j.lastRun = lastByKey.get(key) ?? null;
      j.last7d = countsByKey.get(key) ?? { ok: 0, error: 0 };
    }
  } catch {
    // table missing — leave defaults
  }

  return json({ jobs });
}

async function getCronRuns(env: Env, url: URL): Promise<Response> {
  const agent = url.searchParams.get('agent') ?? '';
  const trigger = url.searchParams.get('trigger') ?? '';
  const limit = clamp(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1, 500);
  try {
    let stmt;
    if (agent && trigger) {
      stmt = env.DB.prepare(
        `SELECT * FROM cron_runs WHERE agent_id = ? AND trigger = ? ORDER BY started_at DESC LIMIT ?`,
      ).bind(agent, trigger, limit);
    } else if (agent) {
      stmt = env.DB.prepare(
        `SELECT * FROM cron_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?`,
      ).bind(agent, limit);
    } else {
      stmt = env.DB.prepare(
        `SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?`,
      ).bind(limit);
    }
    const rs = await stmt.all<CronRunRow>();
    return json({ runs: rs.results ?? [] });
  } catch (err) {
    return json({ runs: [], error: errMsg(err) });
  }
}

async function getCronErrors(env: Env, url: URL): Promise<Response> {
  const limit = clamp(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1, 500);
  const agent = url.searchParams.get('agent') ?? '';
  try {
    let stmt;
    if (agent) {
      stmt = env.DB.prepare(
        `SELECT * FROM cron_errors WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).bind(agent, limit);
    } else {
      stmt = env.DB.prepare(
        `SELECT * FROM cron_errors ORDER BY created_at DESC LIMIT ?`,
      ).bind(limit);
    }
    const rs = await stmt.all();
    return json({ errors: rs.results ?? [] });
  } catch (err) {
    return json({ errors: [], error: errMsg(err) });
  }
}

// ── D1 browser ────────────────────────────────────────────────────────────

async function getD1List(env: Env): Promise<Response> {
  const out: Array<{
    name: string;
    agentId: string;
    bound: boolean;
    tableCount: number | null;
    error?: string;
  }> = [];
  for (const b of D1_BINDINGS) {
    const db = env[b.binding] as D1Database | undefined;
    if (!db) {
      out.push({ name: b.name, agentId: b.agentId, bound: false, tableCount: null });
      continue;
    }
    try {
      const rs = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
        )
        .first<{ n: number }>();
      out.push({
        name: b.name,
        agentId: b.agentId,
        bound: true,
        tableCount: rs?.n ?? 0,
      });
    } catch (err) {
      out.push({
        name: b.name,
        agentId: b.agentId,
        bound: true,
        tableCount: null,
        error: errMsg(err),
      });
    }
  }
  return json({ databases: out });
}

async function getD1Tables(env: Env, name: string): Promise<Response> {
  const db = getD1(env, name);
  if (!db) return json({ error: 'database not found or not bound' }, 404);
  try {
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all<{ name: string }>();
    const out: Array<{ name: string; rowCount: number | null; columns: string[]; error?: string }> = [];
    for (const row of tables.results ?? []) {
      const tableName = row.name;
      try {
        const safeName = quoteIdent(tableName);
        const count = await db
          .prepare(`SELECT COUNT(*) AS n FROM ${safeName}`)
          .first<{ n: number }>();
        const cols = await db.prepare(`PRAGMA table_info(${safeName})`).all<{ name: string }>();
        out.push({
          name: tableName,
          rowCount: count?.n ?? 0,
          columns: (cols.results ?? []).map((c) => c.name),
        });
      } catch (err) {
        out.push({ name: tableName, rowCount: null, columns: [], error: errMsg(err) });
      }
    }
    return json({ database: name, tables: out });
  } catch (err) {
    return json({ error: errMsg(err) }, 500);
  }
}

async function getD1TableRows(
  env: Env,
  name: string,
  tableName: string,
  url: URL,
): Promise<Response> {
  const db = getD1(env, name);
  if (!db) return json({ error: 'database not found or not bound' }, 404);

  // Validate the table exists in sqlite_master before quoting it into the
  // SELECT — defense in depth on top of identifier quoting.
  const tableRow = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .bind(tableName)
    .first<{ name: string }>();
  if (!tableRow) return json({ error: 'table not found' }, 404);

  const limit = clamp(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1, 500);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const orderRaw = url.searchParams.get('order') ?? '';
  const safeName = quoteIdent(tableName);

  let orderClause = '';
  if (orderRaw) {
    const parts = orderRaw.split(/\s+/);
    const colName = parts[0] ?? '';
    const dir = (parts[1] ?? 'ASC').toUpperCase();
    const cols = await db.prepare(`PRAGMA table_info(${safeName})`).all<{ name: string }>();
    const known = new Set((cols.results ?? []).map((c) => c.name));
    if (known.has(colName) && (dir === 'ASC' || dir === 'DESC')) {
      orderClause = ` ORDER BY ${quoteIdent(colName)} ${dir}`;
    }
  }

  try {
    const total = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${safeName}`)
      .first<{ n: number }>();
    const rs = await db
      .prepare(`SELECT * FROM ${safeName}${orderClause} LIMIT ? OFFSET ?`)
      .bind(limit, offset)
      .all();
    return json({
      database: name,
      table: tableName,
      total: total?.n ?? 0,
      offset,
      limit,
      rows: rs.results ?? [],
      columns: rs.results?.[0] ? Object.keys(rs.results[0] as Record<string, unknown>) : [],
    });
  } catch (err) {
    return json({ error: errMsg(err) }, 500);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Quote a SQLite identifier by wrapping in double-quotes and escaping
 * embedded double-quotes. Combined with sqlite_master existence checks
 * upstream, this prevents identifier-injection.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ── Router ────────────────────────────────────────────────────────────────

export async function handleDashboardApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (request.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405);
  }

  if (path === '/dashboard/api/agents') return getAgents(env);
  if (path === '/dashboard/api/crons') return getCrons(env);
  if (path === '/dashboard/api/crons/runs') return getCronRuns(env, url);
  if (path === '/dashboard/api/crons/errors') return getCronErrors(env, url);
  if (path === '/dashboard/api/d1') return getD1List(env);

  // /dashboard/api/d1/:name/tables
  let m = path.match(/^\/dashboard\/api\/d1\/([^/]+)\/tables$/);
  if (m) return getD1Tables(env, decodeURIComponent(m[1]!));

  // /dashboard/api/d1/:name/table/:table
  m = path.match(/^\/dashboard\/api\/d1\/([^/]+)\/table\/(.+)$/);
  if (m) return getD1TableRows(env, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), url);

  return json({ error: 'not found' }, 404);
}
