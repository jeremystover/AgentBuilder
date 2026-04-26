/**
 * SMS inbound handler. Twilio POSTs application/x-www-form-urlencoded
 * here whenever the user replies. We:
 *
 *   1. Verify X-Twilio-Signature (rejects spam + spoofs).
 *   2. Dedup by MessageSid (Twilio retries on 5xx).
 *   3. Look up the sms_person by From phone.
 *   4. Parse the reply: 1=confirm, 2=reroute, 3/PAUSE=pause-for-today,
 *      STOP=Twilio-mandated unsubscribe, MORE=send next.
 *   5. Apply the action (write classification, mark review_queue
 *      resolved, record sms_outcomes, etc.) and return TwiML for the
 *      response message in the same HTTP turn.
 *
 * Phase B will replace the "I didn't catch that" branch with a Claude
 * tool-call to extract the user's intended category from free text.
 */

import type { Env } from '../types';
import { verifyTwilioSignature, twimlMessage, twimlEmpty } from './twilio';
import { localNow } from './pacific-time';
import { resolveReviewQueueItem } from './review-queue';

interface PersonRow {
  user_id: string;
  person: 'jeremy' | 'elyse';
  phone_e164: string;
  timezone: string;
  paused_until_date: string | null;
  opted_in_at: string | null;
}

interface OpenSessionRow {
  id: string;
  user_id: string;
  person: 'jeremy' | 'elyse';
  transaction_id: string;
  suggested_entity: string | null;
  suggested_category_tax: string | null;
  suggested_category_budget: string | null;
  suggested_confidence: number | null;
  suggested_method: string | null;
  sent_at: string;
}

const PRAISE = [
  "Nice — that's locked in.",
  "Got it. Thank you!",
  "Boom — categorized.",
  "Perfect, saved.",
];

function pickPraise(): string {
  return PRAISE[Math.floor(Math.random() * PRAISE.length)]!;
}

export async function handleSmsInbound(request: Request, env: Env): Promise<Response> {
  if (!env.TWILIO_AUTH_TOKEN) {
    console.error('[sms/inbound] TWILIO_AUTH_TOKEN not configured');
    return new Response('twilio not configured', { status: 503 });
  }

  // Twilio sends form-encoded bodies. Parse once, also keep raw for storage.
  const rawBody = await request.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v;

  const signature = request.headers.get('x-twilio-signature') ?? '';
  // Twilio signs the public-facing URL. If the worker is behind a custom
  // domain, this is the request URL as-received by the worker (Cloudflare
  // preserves the original Host).
  const valid = await verifyTwilioSignature({
    authToken: env.TWILIO_AUTH_TOKEN,
    url: request.url,
    params,
    signatureHeader: signature,
  });
  if (!valid) {
    return new Response('invalid signature', { status: 403 });
  }

  const from = params['From'] ?? '';
  const body = (params['Body'] ?? '').trim();
  const sid = params['MessageSid'] ?? '';

  if (!from) return twimlEmpty();

  // Dedup — Twilio retries on 5xx. The unique index on twilio_sid would
  // reject the second insert, but checking up front lets us return a
  // clean 200 instead of an error.
  if (sid) {
    const dup = await env.DB.prepare(
      'SELECT 1 FROM sms_messages WHERE twilio_sid = ?',
    ).bind(sid).first();
    if (dup) return twimlEmpty();
  }

  const person = await env.DB.prepare(
    `SELECT user_id, person, phone_e164, timezone, paused_until_date, opted_in_at
     FROM sms_persons WHERE phone_e164 = ?`,
  ).bind(from).first<PersonRow>();
  if (!person) {
    return twimlMessage("I don't recognize this number. Ask Jeremy to add you to the CFO.");
  }

  // Always log the inbound first so we have a record even if processing fails.
  await env.DB.prepare(
    `INSERT INTO sms_messages
       (id, session_id, user_id, person, direction, body, twilio_sid, twilio_payload)
     VALUES (?, NULL, ?, ?, 'inbound', ?, ?, ?)`,
  ).bind(
    `smsg_${crypto.randomUUID()}`,
    person.user_id, person.person, body, sid || null,
    JSON.stringify(params).slice(0, 4096),
  ).run();

  const upper = body.toUpperCase();
  const session = await loadOpenSession(env, person);

  // STOP is reserved by Twilio + carriers — must result in real unsubscribe.
  if (upper === 'STOP' || upper === 'UNSUBSCRIBE' || upper === 'CANCEL' || upper === 'QUIT') {
    await env.DB.prepare(
      `UPDATE sms_persons SET opted_in_at = NULL, updated_at = datetime('now')
       WHERE user_id = ? AND person = ?`,
    ).bind(person.user_id, person.person).run();
    if (session) await closeSession(env, session.id, 'unsubscribed');
    return twimlMessage("Unsubscribed. Reply START to resume.");
  }

  if (upper === 'START' || upper === 'UNSTOP') {
    await env.DB.prepare(
      `UPDATE sms_persons SET opted_in_at = COALESCE(opted_in_at, datetime('now')),
                              paused_until_date = NULL,
                              updated_at = datetime('now')
       WHERE user_id = ? AND person = ?`,
    ).bind(person.user_id, person.person).run();
    return twimlMessage("Welcome back! I'll send you the next transaction at the next scheduled slot.");
  }

  if (upper === 'PAUSE' || body === '3') {
    const today = localNow(person.timezone).dateKey;
    await env.DB.prepare(
      `UPDATE sms_persons SET paused_until_date = ?, updated_at = datetime('now')
       WHERE user_id = ? AND person = ?`,
    ).bind(today, person.user_id, person.person).run();
    if (session) await closeSession(env, session.id, 'paused');
    return twimlMessage("Paused for today. Talk tomorrow!");
  }

  if (!session) {
    return twimlMessage("No open question right now — I'll text you next time there's something to categorize.");
  }

  if (body === '1') {
    if (!session.suggested_entity || !session.suggested_category_tax) {
      return twimlMessage("I don't have a suggestion saved for this one — describe it in your own words?");
    }
    await applyConfirmedClassification(env, session);
    return twimlMessage(`${pickPraise()} Reply MORE for the next one, or come back later.`);
  }

  if (body === '2') {
    await rerouteToJeremy(env, session);
    return twimlMessage("Got it — sending that one to Jeremy.");
  }

  if (upper === 'MORE') {
    return await sendNextAsTwiml(env, person);
  }

  // Free-text — Phase B will Claude-parse this and propose a category.
  return twimlMessage("I didn't catch that. Reply 1 (yes), 2 (send to Jeremy), or PAUSE (off for today).");
}

// ── Session lookup ─────────────────────────────────────────────────────────

async function loadOpenSession(env: Env, person: PersonRow): Promise<OpenSessionRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, person, transaction_id,
            suggested_entity, suggested_category_tax, suggested_category_budget,
            suggested_confidence, suggested_method, sent_at
     FROM sms_sessions
     WHERE user_id = ? AND person = ? AND status = 'awaiting_reply'
     ORDER BY sent_at DESC LIMIT 1`,
  ).bind(person.user_id, person.person).first<OpenSessionRow>();
  return row ?? null;
}

async function closeSession(env: Env, sessionId: string, status: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sms_sessions SET status = ?, responded_at = datetime('now'), closed_at = datetime('now')
     WHERE id = ?`,
  ).bind(status, sessionId).run();
}

// ── Action handlers ────────────────────────────────────────────────────────

async function applyConfirmedClassification(env: Env, session: OpenSessionRow): Promise<void> {
  const reasonCodes = JSON.stringify([`sms:confirmed:${session.suggested_method}`]);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO classifications
       (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes,
        review_required, classified_by)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, 0, ?)`,
  ).bind(
    crypto.randomUUID(), session.transaction_id,
    session.suggested_entity, session.suggested_category_tax, session.suggested_category_budget,
    session.suggested_confidence ?? 1.0, reasonCodes, `sms:${session.person}`,
  ).run();

  await resolveReviewQueueItem(env, session.transaction_id, `sms:${session.person}`);

  await env.DB.prepare(
    `INSERT INTO sms_outcomes
       (id, session_id, transaction_id, user_id, person, action,
        category_tax, category_budget, entity, source, confidence, latency_seconds)
     VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, 'preset', ?,
             CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER))`,
  ).bind(
    crypto.randomUUID(), session.id, session.transaction_id, session.user_id, session.person,
    session.suggested_category_tax, session.suggested_category_budget, session.suggested_entity,
    session.suggested_confidence ?? 1.0, session.sent_at,
  ).run();

  await closeSession(env, session.id, 'confirmed');
}

async function rerouteToJeremy(env: Env, session: OpenSessionRow): Promise<void> {
  // Idempotent — INSERT OR REPLACE keeps the most recent override.
  await env.DB.prepare(
    `INSERT OR REPLACE INTO sms_routing_overrides
       (transaction_id, user_id, target_person, source_person)
     VALUES (?, ?, 'jeremy', ?)`,
  ).bind(session.transaction_id, session.user_id, session.person).run();

  await env.DB.prepare(
    `INSERT INTO sms_outcomes
       (id, session_id, transaction_id, user_id, person, action, source, latency_seconds)
     VALUES (?, ?, ?, ?, ?, 'rerouted', 'preset',
             CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER))`,
  ).bind(
    crypto.randomUUID(), session.id, session.transaction_id, session.user_id, session.person, session.sent_at,
  ).run();

  await closeSession(env, session.id, 'rerouted');
}

// ── MORE — send the next eligible transaction inline as TwiML ─────────────
// Phase A: this bypasses the slot-time check so the user can drain the
// queue at their own pace mid-session. Still respects pause + the open-
// session rule (after we close the just-confirmed one).

async function sendNextAsTwiml(env: Env, person: PersonRow): Promise<Response> {
  if (person.paused_until_date) {
    const today = localNow(person.timezone).dateKey;
    if (person.paused_until_date >= today) {
      return twimlMessage("You're paused for today — text START tomorrow if you want more.");
    }
  }
  // Reuse the dispatcher's selection + suggestion logic. We import lazily
  // to keep this module's import graph small.
  const { pickAndOpenSession } = await import('./sms-dispatcher-shared');
  const result = await pickAndOpenSession(env, person.user_id, person.person);
  if (!result) {
    return twimlMessage("All caught up — nothing left in your queue. 🎉");
  }
  return twimlMessage(result.message);
}
