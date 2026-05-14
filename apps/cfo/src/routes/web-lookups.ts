/**
 * Lookup endpoints for UI dropdowns: entities, categories, accounts.
 * Read-only.
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';

export async function handleListEntities(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const entities = await sql<Array<{
      id: string; name: string; type: string; slug: string;
    }>>`
      SELECT id, name, type, slug
      FROM entities
      WHERE is_active = true
      ORDER BY type, name
    `;
    return jsonOk({ entities });
  } catch (err) {
    return jsonError(`list entities failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleListCategories(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const categories = await sql<Array<{
      id: string; name: string; slug: string; entity_type: string; category_set: string; description: string | null;
    }>>`
      SELECT id, name, slug, entity_type, category_set, description
      FROM categories
      WHERE is_active = true
      ORDER BY sort_order, name
    `;
    return jsonOk({ categories });
  } catch (err) {
    return jsonError(`list categories failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleListAccounts(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const accounts = await sql<Array<{
      id: string; name: string; institution: string | null; type: string; source: string;
      entity_id: string | null; is_active: boolean; last_synced_at: string | null;
    }>>`
      SELECT id, name, institution, type, source, entity_id, is_active, last_synced_at
      FROM gather_accounts
      ORDER BY institution NULLS LAST, name
    `;
    return jsonOk({ accounts });
  } catch (err) {
    return jsonError(`list accounts failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleUpdateAccount(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as
    | { entity_id?: string | null; is_active?: boolean }
    | null;
  if (!body) return jsonError('invalid body', 400);

  const sql = db(env);
  try {
    if (body.entity_id !== undefined) {
      await sql`UPDATE gather_accounts SET entity_id = ${body.entity_id ?? null}, updated_at = now() WHERE id = ${id}`;
    }
    if (body.is_active !== undefined) {
      await sql`UPDATE gather_accounts SET is_active = ${body.is_active}, updated_at = now() WHERE id = ${id}`;
    }
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update account failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
