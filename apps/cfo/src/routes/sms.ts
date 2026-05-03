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

// ── GET /api/web/sms/stats ─────────────────────────────────────────────────
// Response/resolution rates per variant, per slot, per person. Surface-only
// — no auto-optimization yet. Operator decides whether to retire a variant
// (by zeroing weight in lib/sms-variants.ts and redeploying).
//
// Query params (all optional):
//   ?since=YYYY-MM-DD     — earliest sent_at to consider; default: all time
//   ?person=jeremy|elyse  — filter to a single person

interface VariantRow {
  variant_id: string | null;
  person: string;
  sends: number;
  responses: number;
  resolutions: number;
  avg_latency_seconds: number | null;
}

interface SlotRow {
  person: string;
  slot_hour: number;
  sends: number;
  responses: number;
  resolutions: number;
}

export async function handleSmsStats(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const personFilter = url.searchParams.get('person');

  const sinceClause = since ? `AND s.sent_at >= ?` : '';
  const personClause = personFilter ? `AND s.person = ?` : '';

  const sinceBinds: unknown[] = since ? [since] : [];
  const personBinds: unknown[] = personFilter ? [personFilter] : [];

  // ── Per-variant aggregation ────────────────────────────────────────────
  // sends    — sessions opened
  // responses — sessions with a non-null responded_at (any reply)
  // resolutions — outcomes count where action IN ('confirmed','free_text')
  // avg_latency — mean latency_seconds across resolution outcomes
  const variantRes = await env.DB.prepare(
    `SELECT s.variant_id, s.person,
            COUNT(*) AS sends,
            SUM(CASE WHEN s.responded_at IS NOT NULL THEN 1 ELSE 0 END) AS responses,
            (SELECT COUNT(*) FROM sms_outcomes o
             WHERE o.session_id = s.id
               AND o.action IN ('confirmed','free_text')) AS resolutions_subq,
            (SELECT AVG(o.latency_seconds) FROM sms_outcomes o
             WHERE o.session_id = s.id
               AND o.action IN ('confirmed','free_text')) AS avg_latency_subq
     FROM sms_sessions s
     WHERE s.user_id = ? ${sinceClause} ${personClause}
     GROUP BY s.variant_id, s.person`,
  ).bind(userId, ...sinceBinds, ...personBinds).all<{
    variant_id: string | null;
    person: string;
    sends: number;
    responses: number;
    resolutions_subq: number;
    avg_latency_subq: number | null;
  }>();

  const variants: VariantRow[] = variantRes.results.map((r) => ({
    variant_id: r.variant_id,
    person: r.person,
    sends: r.sends,
    responses: r.responses,
    resolutions: r.resolutions_subq,
    avg_latency_seconds: r.avg_latency_subq,
  }));

  // ── Per-slot aggregation (UTC hour of sent_at, mapped through the
  // person's timezone). For the v1 endpoint we approximate with the
  // session's local-time hour by using the person's timezone offset at
  // sent_at — D1 doesn't have full TZ support, so we group by raw UTC
  // hour and let the consumer remap. Two callers right now (test +
  // hypothetical UI) so this is fine.
  const slotRes = await env.DB.prepare(
    `SELECT s.person,
            CAST(strftime('%H', s.sent_at) AS INTEGER) AS slot_hour,
            COUNT(*) AS sends,
            SUM(CASE WHEN s.responded_at IS NOT NULL THEN 1 ELSE 0 END) AS responses,
            (SELECT COUNT(*) FROM sms_outcomes o
             WHERE o.session_id = s.id
               AND o.action IN ('confirmed','free_text')) AS resolutions
     FROM sms_sessions s
     WHERE s.user_id = ? ${sinceClause} ${personClause}
     GROUP BY s.person, slot_hour
     ORDER BY s.person, slot_hour`,
  ).bind(userId, ...sinceBinds, ...personBinds).all<SlotRow>();

  return jsonOk({
    since: since ?? null,
    person: personFilter ?? null,
    variants,
    slots_utc: slotRes.results,
    note:
      "slots_utc is keyed on UTC hour. Consumers should map to local time " +
      "via the person's timezone (sms_persons.timezone).",
  });
}
