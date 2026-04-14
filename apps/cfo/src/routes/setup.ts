import { z } from 'zod';
import type { Env } from '../types';
import { jsonOk, jsonError, SCHEDULE_C_CATEGORIES, AIRBNB_CATEGORIES, FAMILY_CATEGORIES } from '../types';

const SetupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

/**
 * POST /setup
 * Creates the default user + three business entities + default chart of accounts.
 * Safe to call multiple times (idempotent via UNIQUE constraints).
 */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON body'); }

  const parsed = SetupSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  const { email, name } = parsed.data;
  const userId = crypto.randomUUID();

  // ── Create user (idempotent) ──────────────────────────────────────────────
  await env.DB.prepare(
    `INSERT INTO users (id, email, name) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name=excluded.name, updated_at=datetime('now')`,
  ).bind(userId, email, name).run();

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<{ id: string; email: string; name: string }>();
  if (!user) return jsonError('Failed to create user', 500);

  // ── Create business entities ──────────────────────────────────────────────
  const entities = [
    { slug: 'coaching', name: 'Coaching Business', entity_type: 'schedule_c' },
    { slug: 'airbnb',   name: 'Whitford House',    entity_type: 'schedule_e' },
    { slug: 'family',   name: 'Family / Personal',  entity_type: 'personal'   },
  ];

  for (const e of entities) {
    const eid = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO business_entities (id, user_id, slug, name, entity_type)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, slug) DO UPDATE SET name=excluded.name`,
    ).bind(eid, user.id, e.slug, e.name, e.entity_type).run();
  }

  const entityRows = await env.DB.prepare(
    'SELECT * FROM business_entities WHERE user_id = ?',
  ).bind(user.id).all<{ id: string; slug: string }>();

  const entityMap = Object.fromEntries(entityRows.results.map(e => [e.slug, e.id]));

  // ── Seed chart of accounts ────────────────────────────────────────────────
  const coaInserts: Array<() => Promise<unknown>> = [];

  if (entityMap.coaching) {
    for (const [code, meta] of Object.entries(SCHEDULE_C_CATEGORIES)) {
      const cid = crypto.randomUUID();
      coaInserts.push(() =>
        env.DB.prepare(
          `INSERT INTO chart_of_accounts (id, business_entity_id, code, name, form_line, category_type)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(business_entity_id, code) DO NOTHING`,
        ).bind(cid, entityMap.coaching, code, meta.name, meta.form_line, code === 'income' ? 'income' : 'expense').run(),
      );
    }
  }

  if (entityMap.airbnb) {
    for (const [code, meta] of Object.entries(AIRBNB_CATEGORIES)) {
      const cid = crypto.randomUUID();
      coaInserts.push(() =>
        env.DB.prepare(
          `INSERT INTO chart_of_accounts (id, business_entity_id, code, name, form_line, category_type)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(business_entity_id, code) DO NOTHING`,
        ).bind(cid, entityMap.airbnb, code, meta.name, meta.form_line, code.endsWith('_income') ? 'income' : 'expense').run(),
      );
    }
  }

  if (entityMap.family) {
    for (const [code, label] of Object.entries(FAMILY_CATEGORIES)) {
      const cid = crypto.randomUUID();
      coaInserts.push(() =>
        env.DB.prepare(
          `INSERT INTO chart_of_accounts (id, business_entity_id, code, name, category_type, is_deductible)
           VALUES (?, ?, ?, ?, 'expense', ?)
           ON CONFLICT(business_entity_id, code) DO NOTHING`,
        ).bind(cid, entityMap.family, code, label, code === 'potentially_deductible' || code === 'charitable_giving' ? 1 : 0).run(),
      );
    }
  }

  for (const insert of coaInserts) await insert();

  return jsonOk({
    user: { id: user.id, email: user.email, name: user.name },
    entities: entityRows.results,
    message: 'Setup complete. Use the user id as X-User-Id header in subsequent requests.',
  }, 201);
}
