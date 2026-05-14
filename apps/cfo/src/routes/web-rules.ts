import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';

interface CreateRuleBody {
  name: string;
  match_json: Record<string, unknown>;
  entity_id?: string | null;
  category_id?: string | null;
  created_by?: 'system' | 'user';
}

export async function handleListRules(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rules = await sql<Array<{
      id: string; name: string; match_json: unknown; entity_id: string | null; category_id: string | null;
      is_active: boolean; match_count: number;
    }>>`
      SELECT id, name, match_json, entity_id, category_id, is_active, match_count
      FROM rules
      WHERE is_active = true
      ORDER BY name
    `;
    return jsonOk({ rules });
  } catch (err) {
    return jsonError(`list rules failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleCreateRule(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as CreateRuleBody | null;
  if (!body || !body.name || !body.match_json) return jsonError('name and match_json required', 400);

  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO rules (name, match_json, entity_id, category_id, created_by)
      VALUES (${body.name}, ${JSON.stringify(body.match_json)}::jsonb,
              ${body.entity_id ?? null}, ${body.category_id ?? null},
              ${body.created_by ?? 'user'})
      RETURNING id
    `;
    return jsonOk({ id: rows[0]!.id });
  } catch (err) {
    return jsonError(`create rule failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
