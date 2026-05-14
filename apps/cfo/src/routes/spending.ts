/**
 * Spending module REST surface.
 *
 *   GET    /api/web/spending/report            → run a SpendingReport
 *   GET    /api/web/spending/views             → list saved views
 *   POST   /api/web/spending/views             → save a new view
 *   PUT    /api/web/spending/views/:id         → update a view
 *   DELETE /api/web/spending/views/:id         → delete a view
 *   GET    /api/web/spending/groups            → list category groups
 *   POST   /api/web/spending/groups            → create a group
 *   PUT    /api/web/spending/groups/:id        → rename / set members
 *   DELETE /api/web/spending/groups/:id        → delete a group
 *   GET    /api/web/spending/plans             → list selectable plans
 *   GET    /api/web/plans/active               → get current active plan id
 *   PUT    /api/web/plans/active               → set the active plan id
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';
import { buildSpendingReport } from '../lib/spending-engine';

// ── Report ───────────────────────────────────────────────────────────────────

function parseList(url: URL, key: string): string[] {
  const all = url.searchParams.getAll(key);
  if (all.length === 0) return [];
  // Allow comma-separated as a single value too.
  return all.flatMap(v => v.split(',')).map(s => s.trim()).filter(Boolean);
}

export async function handleSpendingReport(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const dateFromStr = url.searchParams.get('date_from');
  const dateToStr   = url.searchParams.get('date_to');
  if (!dateFromStr || !dateToStr) return jsonError('date_from and date_to required', 400);

  const dateFrom = new Date(`${dateFromStr}T00:00:00Z`);
  const dateTo   = new Date(`${dateToStr}T00:00:00Z`);
  if (isNaN(+dateFrom) || isNaN(+dateTo)) return jsonError('invalid date format', 400);

  const periodType = url.searchParams.get('period_type') === 'annual' ? 'annual' : 'monthly';
  const planIds     = parseList(url, 'plan_ids');
  const entityIds   = parseList(url, 'entity_ids');
  const categoryIds = parseList(url, 'category_ids');
  const groupIds    = parseList(url, 'group_ids');

  const sql = db(env);
  try {
    const report = await buildSpendingReport(sql, {
      planIds, dateFrom, dateTo, entityIds, categoryIds, groupIds, periodType,
    });
    return jsonOk(report);
  } catch (err) {
    return jsonError(`spending report failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Saved views ──────────────────────────────────────────────────────────────

interface ViewBody {
  name: string;
  plan_ids?: string[];
  date_preset?: string | null;
  date_from?: string | null;
  date_to?:   string | null;
  entity_ids?: string[];
  category_ids?: string[];
  group_ids?: string[];
  period_type?: 'monthly' | 'annual';
}

export async function handleListViews(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, name, plan_ids, date_preset,
             to_char(date_from, 'YYYY-MM-DD') AS date_from,
             to_char(date_to,   'YYYY-MM-DD') AS date_to,
             entity_ids, category_ids, group_ids, period_type,
             created_at, updated_at
      FROM spending_views
      ORDER BY name
    `;
    return jsonOk({ views: rows });
  } catch (err) {
    return jsonError(`list views failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleCreateView(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as ViewBody | null;
  if (!body?.name) return jsonError('name required', 400);
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO spending_views (
        name, plan_ids, date_preset, date_from, date_to,
        entity_ids, category_ids, group_ids, period_type
      ) VALUES (
        ${body.name},
        ${body.plan_ids ?? []},
        ${body.date_preset ?? null},
        ${body.date_from ?? null},
        ${body.date_to ?? null},
        ${body.entity_ids ?? []},
        ${body.category_ids ?? []},
        ${body.group_ids ?? []},
        ${body.period_type ?? 'monthly'}
      ) RETURNING id
    `;
    return jsonOk({ id: rows[0]!.id });
  } catch (err) {
    return jsonError(`create view failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdateView(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as Partial<ViewBody> | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    if ('name' in body) await sql`UPDATE spending_views SET name = ${body.name ?? ''}, updated_at = now() WHERE id = ${id}`;
    if ('plan_ids' in body) await sql`UPDATE spending_views SET plan_ids = ${body.plan_ids ?? []}, updated_at = now() WHERE id = ${id}`;
    if ('date_preset' in body) await sql`UPDATE spending_views SET date_preset = ${body.date_preset ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('date_from' in body) await sql`UPDATE spending_views SET date_from = ${body.date_from ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('date_to' in body) await sql`UPDATE spending_views SET date_to = ${body.date_to ?? null}, updated_at = now() WHERE id = ${id}`;
    if ('entity_ids' in body) await sql`UPDATE spending_views SET entity_ids = ${body.entity_ids ?? []}, updated_at = now() WHERE id = ${id}`;
    if ('category_ids' in body) await sql`UPDATE spending_views SET category_ids = ${body.category_ids ?? []}, updated_at = now() WHERE id = ${id}`;
    if ('group_ids' in body) await sql`UPDATE spending_views SET group_ids = ${body.group_ids ?? []}, updated_at = now() WHERE id = ${id}`;
    if ('period_type' in body) await sql`UPDATE spending_views SET period_type = ${body.period_type ?? 'monthly'}, updated_at = now() WHERE id = ${id}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update view failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleDeleteView(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    await sql`DELETE FROM spending_views WHERE id = ${id}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`delete view failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Category groups ──────────────────────────────────────────────────────────

interface GroupBody { name: string; category_ids?: string[] }

export async function handleListGroups(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string; name: string; member_ids: string[] }>>`
      SELECT g.id, g.name,
             COALESCE(array_agg(m.category_id) FILTER (WHERE m.category_id IS NOT NULL),
                      ARRAY[]::text[]) AS member_ids
      FROM category_groups g
      LEFT JOIN category_group_members m ON m.group_id = g.id
      GROUP BY g.id, g.name
      ORDER BY g.name
    `;
    return jsonOk({ groups: rows });
  } catch (err) {
    return jsonError(`list groups failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleCreateGroup(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as GroupBody | null;
  if (!body?.name) return jsonError('name required', 400);
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO category_groups (name) VALUES (${body.name}) RETURNING id
    `;
    const gid = rows[0]!.id;
    const members = body.category_ids ?? [];
    if (members.length > 0) {
      await sql`
        INSERT INTO category_group_members ${sql(members.map(cid => ({ group_id: gid, category_id: cid })))}
      `;
    }
    return jsonOk({ id: gid });
  } catch (err) {
    return jsonError(`create group failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdateGroup(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as Partial<GroupBody> | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    if ('name' in body) await sql`UPDATE category_groups SET name = ${body.name ?? ''} WHERE id = ${id}`;
    if (Array.isArray(body.category_ids)) {
      await sql`DELETE FROM category_group_members WHERE group_id = ${id}`;
      if (body.category_ids.length > 0) {
        await sql`
          INSERT INTO category_group_members ${sql(body.category_ids.map(cid => ({ group_id: id, category_id: cid })))}
        `;
      }
    }
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update group failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleDeleteGroup(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    await sql`DELETE FROM category_groups WHERE id = ${id}`;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`delete group failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Plans (read-only here; Phase 4 will build the editor) ──────────────────

export async function handleListPlans(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT p.id, p.name, p.type, p.parent_plan_id, p.status,
             to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
             to_char(p.end_date,   'YYYY-MM-DD') AS end_date,
             (ps.active_plan_id = p.id) AS is_active
      FROM plans p
      LEFT JOIN plan_settings ps ON ps.id = 'singleton'
      WHERE p.status IN ('draft', 'active')
      ORDER BY p.name
    `;
    return jsonOk({ plans: rows });
  } catch (err) {
    return jsonError(`list plans failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleGetActivePlan(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{ active_plan_id: string | null }>>`
      SELECT active_plan_id FROM plan_settings WHERE id = 'singleton'
    `;
    return jsonOk({ active_plan_id: rows[0]?.active_plan_id ?? null });
  } catch (err) {
    return jsonError(`get active plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleSetActivePlan(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as { plan_id: string | null } | null;
  if (!body || !('plan_id' in body)) return jsonError('plan_id required', 400);
  const sql = db(env);
  try {
    await sql`
      UPDATE plan_settings
      SET active_plan_id = ${body.plan_id ?? null}, updated_at = now()
      WHERE id = 'singleton'
    `;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`set active plan failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
