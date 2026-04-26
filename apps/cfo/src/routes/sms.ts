/**
 * SMS settings + manual cron trigger.
 *
 *   GET  /api/web/sms/settings          → list opted-in persons
 *   PUT  /api/web/sms/settings          → upsert {person, phone_e164, ...}
 *   DELETE /api/web/sms/settings/:person → opt out (soft — clears opted_in_at)
 *   POST /cron/sms/dispatch              → manual trigger of the cron path,
 *                                          for local testing & one-off runs.
 *
 * The Twilio inbound webhook (/sms/inbound) is wired directly in index.ts
 * because it needs to bypass cookie auth (Twilio doesn't carry cookies)
 * and verify HMAC instead.
 */

import { z } from 'zod';
import type { Env } from '../types';
import { jsonError, jsonOk, getUserId } from '../types';
import { runDispatch } from '../lib/sms-dispatcher';

const PHONE_E164 = /^\+[1-9]\d{6,14}$/;

const SettingsSchema = z.object({
  person: z.enum(['jeremy', 'elyse']),
  phone_e164: z.string().regex(PHONE_E164, 'phone must be E.164, e.g. +14155551234'),
  timezone: z.string().min(1).optional(),
  preferred_send_slots: z
    .array(z.object({
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    }))
    .optional(),
  preferred_batch_size: z.number().int().min(1).max(10).optional(),
  opted_in: z.boolean().optional(),
});

export async function handleListSmsSettings(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const rows = await env.DB.prepare(
    `SELECT user_id, person, phone_e164, timezone, preferred_send_slots,
            preferred_batch_size, opted_in_at, paused_until_date,
            created_at, updated_at
     FROM sms_persons WHERE user_id = ?`,
  ).bind(userId).all();
  return jsonOk({ persons: rows.results });
}

export async function handleUpsertSmsSettings(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('invalid JSON body'); }

  const parsed = SettingsSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const input = parsed.data;
  const optedInAt = input.opted_in === false ? null : new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO sms_persons
       (user_id, person, phone_e164, timezone, preferred_send_slots,
        preferred_batch_size, opted_in_at, updated_at)
     VALUES (?, ?, ?, COALESCE(?, 'America/Los_Angeles'),
             COALESCE(?, '[{"hour":8,"minute":0},{"hour":12,"minute":30},{"hour":18,"minute":30}]'),
             COALESCE(?, 1), ?, datetime('now'))
     ON CONFLICT(user_id, person) DO UPDATE SET
       phone_e164             = excluded.phone_e164,
       timezone               = COALESCE(excluded.timezone, sms_persons.timezone),
       preferred_send_slots   = COALESCE(excluded.preferred_send_slots, sms_persons.preferred_send_slots),
       preferred_batch_size   = COALESCE(excluded.preferred_batch_size, sms_persons.preferred_batch_size),
       opted_in_at            = ?,
       updated_at             = datetime('now')`,
  ).bind(
    userId, input.person, input.phone_e164, input.timezone ?? null,
    input.preferred_send_slots ? JSON.stringify(input.preferred_send_slots) : null,
    input.preferred_batch_size ?? null,
    optedInAt, optedInAt,
  ).run();

  return jsonOk({ ok: true });
}

export async function handleDeleteSmsPerson(
  request: Request,
  env: Env,
  person: string,
): Promise<Response> {
  if (person !== 'jeremy' && person !== 'elyse') return jsonError('invalid person');
  const userId = getUserId(request);
  await env.DB.prepare(
    `UPDATE sms_persons SET opted_in_at = NULL, updated_at = datetime('now')
     WHERE user_id = ? AND person = ?`,
  ).bind(userId, person).run();
  return jsonOk({ ok: true });
}

export async function handleManualDispatch(_request: Request, env: Env): Promise<Response> {
  const summary = await runDispatch(env);
  return jsonOk(summary);
}
