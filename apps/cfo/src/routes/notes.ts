/**
 * /api/web/notes — captured chat-reply snippets and follow-up tasks.
 *
 * Cookie-authed via the kit's requireApiAuth (gated in index.ts).
 * Single table, polymorphic on `kind` ('note'|'task'). Tasks have a
 * status workflow (open/done); notes ignore status entirely.
 *
 * Lightweight by design — the full 1.0 of "captured ideas" is in the
 * research-agent Lab. CFO notes are deliberately a thin capture
 * surface so the chat can offload "remember this for later" without
 * inventing a heavyweight workflow.
 */

import { z } from 'zod';
import type { Env } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';

const KindSchema = z.enum(['note', 'task']);
const StatusSchema = z.enum(['open', 'done']);

const CreateSchema = z.object({
  kind: KindSchema,
  title: z.string().min(1).max(200),
  body: z.string().max(8000).optional(),
  tax_year: z.number().int().min(2000).max(2100).optional(),
  source_chat_message_id: z.string().max(200).optional(),
});

const UpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(8000).optional(),
  status: StatusSchema.optional(),
  tax_year: z.number().int().min(2000).max(2100).nullable().optional(),
});

interface NoteRow {
  id: string;
  user_id: string;
  kind: 'note' | 'task';
  title: string;
  body: string;
  status: 'open' | 'done';
  tax_year: number | null;
  source_chat_message_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── GET /api/web/notes ────────────────────────────────────────────────────
// Optional filters: ?kind=note|task and ?status=open|done.
export async function handleListNotes(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const status = url.searchParams.get('status');

  const conds = ['user_id = ?'];
  const vals: unknown[] = [userId];
  if (kind) {
    if (KindSchema.safeParse(kind).success === false) return jsonError('invalid kind');
    conds.push('kind = ?');
    vals.push(kind);
  }
  if (status) {
    if (StatusSchema.safeParse(status).success === false) return jsonError('invalid status');
    conds.push('status = ?');
    vals.push(status);
  }

  const rows = await env.DB.prepare(
    `SELECT * FROM cfo_notes
     WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT 200`,
  ).bind(...vals).all<NoteRow>();
  return jsonOk({ notes: rows.results });
}

// ── POST /api/web/notes ───────────────────────────────────────────────────
export async function handleCreateNote(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('invalid JSON'); }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const input = parsed.data;
  const id = `note_${crypto.randomUUID()}`;

  await env.DB.prepare(
    `INSERT INTO cfo_notes
       (id, user_id, kind, title, body, status, tax_year, source_chat_message_id)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).bind(
    id, userId, input.kind, input.title, input.body ?? '',
    input.tax_year ?? null, input.source_chat_message_id ?? null,
  ).run();

  const row = await env.DB.prepare('SELECT * FROM cfo_notes WHERE id = ?').bind(id).first<NoteRow>();
  return jsonOk({ note: row });
}

// ── PATCH /api/web/notes/:id ──────────────────────────────────────────────
export async function handleUpdateNote(request: Request, env: Env, id: string): Promise<Response> {
  const userId = getUserId(request);
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('invalid JSON'); }

  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const patch = parsed.data;

  const existing = await env.DB.prepare(
    'SELECT id FROM cfo_notes WHERE id = ? AND user_id = ?',
  ).bind(id, userId).first();
  if (!existing) return jsonError('note not found', 404);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined)    { sets.push('title = ?');    vals.push(patch.title); }
  if (patch.body !== undefined)     { sets.push('body = ?');     vals.push(patch.body); }
  if (patch.status !== undefined)   { sets.push('status = ?');   vals.push(patch.status); }
  if (patch.tax_year !== undefined) { sets.push('tax_year = ?'); vals.push(patch.tax_year); }
  if (sets.length === 0) return jsonError('no fields to update');

  sets.push("updated_at = datetime('now')");
  await env.DB.prepare(
    `UPDATE cfo_notes SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
  ).bind(...vals, id, userId).run();

  const row = await env.DB.prepare('SELECT * FROM cfo_notes WHERE id = ?').bind(id).first<NoteRow>();
  return jsonOk({ note: row });
}

// ── DELETE /api/web/notes/:id ─────────────────────────────────────────────
export async function handleDeleteNote(request: Request, env: Env, id: string): Promise<Response> {
  const userId = getUserId(request);
  const result = await env.DB.prepare(
    'DELETE FROM cfo_notes WHERE id = ? AND user_id = ?',
  ).bind(id, userId).run();
  if ((result.meta?.changes ?? 0) === 0) return jsonError('note not found', 404);
  return jsonOk({ ok: true });
}
