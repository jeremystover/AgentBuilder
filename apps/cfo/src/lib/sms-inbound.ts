/**
 * SMS inbound handler.
 *
 * Twilio POSTs application/x-www-form-urlencoded here whenever the user
 * replies. We:
 *
 *   1. Verify X-Twilio-Signature (rejects spam + spoofs).
 *   2. Dedup by MessageSid (Twilio retries on 5xx).
 *   3. Look up the sms_person by From phone.
 *   4. Parse the reply per session shape:
 *      - Single session: 1=confirm, 2=reroute, free-text → Claude
 *        intent parse + propose-confirm flow.
 *      - Batch session (Phase B; batch_json IS NOT NULL): 1=confirm-all,
 *        free-text → Claude batch parse → per-label outcomes.
 *      - Universal: 3/PAUSE=pause-for-today, STOP/UNSUBSCRIBE=Twilio-
 *        mandated unsubscribe, START=resume, MORE=send next batch.
 *   5. Apply the action (write classifications, mark review_queue
 *      resolved, record sms_outcomes) and return TwiML for the response
 *      message in the same HTTP turn.
 */

import type { Env } from '../types';
import { verifyTwilioSignature, twimlMessage, twimlEmpty } from './twilio';
import { localNow } from './pacific-time';
import { resolveReviewQueueItem } from './review-queue';
import {
  pickAndOpenSession,
  pickAndOpenBatchSession,
  parseBatchJson,
  humanizeCategory,
  type BatchItem,
  type Suggestion,
} from './sms-dispatcher-shared';
import { parseSmsIntent, parseSmsBatch, type SmsIntentResult, type SmsBatchAssignment } from './sms-claude';
import { praiseFor } from './sms-praise';

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
  batch_json: string | null;
  variant_id: string | null;
}

export async function handleSmsInbound(request: Request, env: Env): Promise<Response> {
  if (!env.TWILIO_AUTH_TOKEN) {
    console.error('[sms/inbound] TWILIO_AUTH_TOKEN not configured');
    return new Response('twilio not configured', { status: 503 });
  }

  const rawBody = await request.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v;

  const signature = request.headers.get('x-twilio-signature') ?? '';
  const valid = await verifyTwilioSignature({
    authToken: env.TWILIO_AUTH_TOKEN,
    url: request.url,
    params,
    signatureHeader: signature,
  });
  if (!valid) return new Response('invalid signature', { status: 403 });

  const from = params['From'] ?? '';
  const body = (params['Body'] ?? '').trim();
  const sid = params['MessageSid'] ?? '';

  if (!from) return twimlEmpty();

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

  // ── Universal keywords (apply regardless of session shape) ────────────
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
  if (upper === 'MORE') {
    return await sendNextBatchAsTwiml(env, person);
  }

  if (!session) {
    return twimlMessage("No open question right now — I'll text you next time there's something to categorize.");
  }

  // ── Batch session ─────────────────────────────────────────────────────
  const batch = parseBatchJson(session.batch_json);
  if (batch && batch.length > 0) {
    return await handleBatchReply(env, person, session, batch, body);
  }

  // ── Single session ────────────────────────────────────────────────────
  return await handleSingleReply(env, person, session, body);
}

// ── Single-reply branch ────────────────────────────────────────────────────

async function handleSingleReply(
  env: Env,
  person: PersonRow,
  session: OpenSessionRow,
  body: string,
): Promise<Response> {
  if (body === '1') {
    if (!session.suggested_entity || !session.suggested_category_tax) {
      return twimlMessage("I don't have a suggestion saved for this one — describe it in your own words?");
    }
    // If the user previously narrated a category and we updated the
    // session via Claude parse, suggested_method is 'free_text' — record
    // the outcome accordingly so stats can distinguish preset vs natural.
    const source = session.suggested_method === 'free_text' ? 'free_text' : 'preset';
    await applyConfirmedClassification(env, session, source);
    const praise = await praiseFor(env, session.user_id, session.person, person.timezone, session.variant_id);
    return twimlMessage(`${praise} Reply MORE for three more, or come back later.`);
  }

  if (body === '2') {
    await rerouteToJeremy(env, session);
    return twimlMessage("Got it — sending that one to Jeremy.");
  }

  // Free-text — Claude intent parse + propose-confirm flow.
  let parsed: SmsIntentResult;
  try {
    const ctx = await loadTransactionContext(env, session.transaction_id);
    parsed = await parseSmsIntent(env, { ...ctx, reply_text: body });
  } catch (err) {
    console.error('[sms/inbound] parseSmsIntent failed', err);
    return twimlMessage("I didn't catch that. Reply 1 (yes), 2 (send to Jeremy), or PAUSE.");
  }

  if (parsed.ambiguous || parsed.confidence < 0.6) {
    // Don't auto-update the suggestion — ask for clarification.
    return twimlMessage(
      `I'm not sure — did you mean ${friendly(parsed)}? Reply 1 to confirm, or describe more.`,
    );
  }

  // Update the session's suggestion with Claude's parse, then ask the
  // user to confirm. Reply "1" on the next message will use these values.
  await env.DB.prepare(
    `UPDATE sms_sessions
     SET suggested_entity = ?, suggested_category_tax = ?, suggested_category_budget = ?,
         suggested_confidence = ?, suggested_method = 'free_text'
     WHERE id = ?`,
  ).bind(
    parsed.entity,
    parsed.category_tax || null,
    parsed.category_budget || null,
    parsed.confidence,
    session.id,
  ).run();

  return twimlMessage(`Got it — sounds like ${friendly(parsed)}. Reply 1 to confirm, or describe again.`);
}

// ── Batch-reply branch ─────────────────────────────────────────────────────

async function handleBatchReply(
  env: Env,
  person: PersonRow,
  session: OpenSessionRow,
  items: BatchItem[],
  body: string,
): Promise<Response> {
  // "1" → confirm all (use each item's pre-computed suggestion).
  if (body === '1') {
    let resolved = 0;
    for (const item of items) {
      if (!item.suggested_entity || !item.suggested_category_tax) continue;
      await applyItemClassification(env, session, item, 'preset');
      resolved++;
    }
    if (resolved === 0) {
      return twimlMessage("Hmm — I don't have suggestions for any of those. Reply per item, e.g. 'A groceries, B office, C 2'.");
    }
    await closeSession(env, session.id, 'confirmed');
    const praise = await praiseFor(env, session.user_id, session.person, person.timezone, session.variant_id);
    return twimlMessage(`${praise} ${resolved} done. Reply MORE for three more.`);
  }

  // Otherwise — Claude batch parse.
  let assignments: SmsBatchAssignment[];
  try {
    assignments = await parseSmsBatch(
      env,
      items.map((it) => ({
        label: it.label,
        merchant: it.merchant,
        amount: it.amount,
        date: it.date,
        description: it.description,
        account_owner: it.account_owner,
      })),
      body,
    );
  } catch (err) {
    console.error('[sms/inbound] parseSmsBatch failed', err);
    return twimlMessage(
      "I couldn't parse that. Reply 1 to confirm all, or per item like 'A 1, B groceries, C 2'.",
    );
  }

  // Apply each assignment.
  const summary: string[] = [];
  let resolvedCount = 0;
  for (const item of items) {
    const a = assignments.find((x) => x.label === item.label);
    if (!a) continue;
    const result = await applyBatchAssignment(env, session, item, a);
    if (result) {
      summary.push(`${item.label}: ${result}`);
      if (a.action !== 'skip') resolvedCount++;
    }
  }

  // If anything was unresolved (skip / ambiguous), keep the session open
  // and ask for follow-up. If all 3 are resolved, close + praise.
  const unresolved = items.filter((it) => {
    const a = assignments.find((x) => x.label === it.label);
    return !a || a.action === 'skip' || a.ambiguous;
  });

  if (unresolved.length === 0) {
    await closeSession(env, session.id, 'confirmed');
    const praise = await praiseFor(env, session.user_id, session.person, person.timezone, session.variant_id);
    return twimlMessage(
      `${praise} ${resolvedCount} done — ${summary.join(', ')}. Reply MORE for three more.`,
    );
  }

  // Some items still need attention.
  const followups = unresolved.map((it) => `${it.label} (${shortLabel(it)})`).join(', ');
  return twimlMessage(
    `${summary.join(', ')}\nStill need: ${followups}. Reply per label or PAUSE.`,
  );
}

// ── Apply a single batch assignment, returns a short human label. ─────────

async function applyBatchAssignment(
  env: Env,
  session: OpenSessionRow,
  item: BatchItem,
  a: SmsBatchAssignment,
): Promise<string | null> {
  if (a.action === 'reroute') {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO sms_routing_overrides
         (transaction_id, user_id, target_person, source_person)
       VALUES (?, ?, 'jeremy', ?)`,
    ).bind(item.transaction_id, session.user_id, session.person).run();
    await env.DB.prepare(
      `INSERT INTO sms_outcomes
         (id, session_id, transaction_id, user_id, person, action, source, latency_seconds)
       VALUES (?, ?, ?, ?, ?, 'rerouted', 'preset',
               CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER))`,
    ).bind(
      crypto.randomUUID(), session.id, item.transaction_id, session.user_id, session.person, session.sent_at,
    ).run();
    return '→ Jeremy';
  }

  if (a.action === 'skip') return null;

  // Build the (entity, category_tax, category_budget) we'll save.
  let entity: string;
  let categoryTax: string | null;
  let categoryBudget: string | null;
  let confidence: number;
  let source: 'preset' | 'free_text';
  let action: 'confirmed' | 'free_text';

  if (a.action === 'confirm') {
    entity = item.suggested_entity;
    categoryTax = item.suggested_category_tax;
    categoryBudget = item.suggested_category_budget;
    confidence = item.suggested_confidence;
    source = 'preset';
    action = 'confirmed';
  } else {
    // set_category from Claude's parse.
    if (a.ambiguous || a.confidence < 0.6 || !a.entity) return null;
    entity = a.entity;
    categoryTax = a.category_tax || null;
    categoryBudget = a.category_budget || null;
    confidence = a.confidence;
    source = 'free_text';
    action = 'free_text';
  }

  const reasonCodes = JSON.stringify([`sms:batch:${a.action}:${item.suggested_method}`]);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO classifications
       (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes,
        review_required, classified_by)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, 0, ?)`,
  ).bind(
    crypto.randomUUID(), item.transaction_id, entity, categoryTax, categoryBudget,
    confidence, reasonCodes, `sms:${session.person}`,
  ).run();

  await resolveReviewQueueItem(env, item.transaction_id, `sms:${session.person}`);

  await env.DB.prepare(
    `INSERT INTO sms_outcomes
       (id, session_id, transaction_id, user_id, person, action,
        category_tax, category_budget, entity, source, confidence, latency_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER))`,
  ).bind(
    crypto.randomUUID(), session.id, item.transaction_id, session.user_id, session.person,
    action, categoryTax, categoryBudget, entity, source, confidence, session.sent_at,
  ).run();

  return friendlyShort({ entity, category_tax: categoryTax, category_budget: categoryBudget });
}

// ── Session lookup ─────────────────────────────────────────────────────────

async function loadOpenSession(env: Env, person: PersonRow): Promise<OpenSessionRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, person, transaction_id,
            suggested_entity, suggested_category_tax, suggested_category_budget,
            suggested_confidence, suggested_method, sent_at, batch_json, variant_id
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

// ── Single-session apply helpers (preserved from Phase A) ─────────────────

async function applyConfirmedClassification(
  env: Env,
  session: OpenSessionRow,
  source: 'preset' | 'free_text',
): Promise<void> {
  const action = source === 'free_text' ? 'free_text' : 'confirmed';
  const reasonCodes = JSON.stringify([`sms:${action}:${session.suggested_method}`]);
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER))`,
  ).bind(
    crypto.randomUUID(), session.id, session.transaction_id, session.user_id, session.person,
    action,
    session.suggested_category_tax, session.suggested_category_budget, session.suggested_entity,
    source, session.suggested_confidence ?? 1.0, session.sent_at,
  ).run();

  await closeSession(env, session.id, 'confirmed');
}

async function rerouteToJeremy(env: Env, session: OpenSessionRow): Promise<void> {
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

// ── Batch-item apply (used by handleBatchReply when "1" confirms all) ─────

async function applyItemClassification(
  env: Env,
  session: OpenSessionRow,
  item: BatchItem,
  source: 'preset' | 'free_text',
): Promise<void> {
  const action = source === 'free_text' ? 'free_text' : 'confirmed';
  const reasonCodes = JSON.stringify([`sms:batch:${action}:${item.suggested_method}`]);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO classifications
       (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes,
        review_required, classified_by)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, 0, ?)`,
  ).bind(
    crypto.randomUUID(), item.transaction_id, item.suggested_entity,
    item.suggested_category_tax, item.suggested_category_budget,
    item.suggested_confidence, reasonCodes, `sms:${session.person}`,
  ).run();

  await resolveReviewQueueItem(env, item.transaction_id, `sms:${session.person}`);

  await env.DB.prepare(
    `INSERT INTO sms_outcomes
       (id, session_id, transaction_id, user_id, person, action,
        category_tax, category_budget, entity, source, confidence, latency_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER))`,
  ).bind(
    crypto.randomUUID(), session.id, item.transaction_id, session.user_id, session.person,
    action, item.suggested_category_tax, item.suggested_category_budget, item.suggested_entity,
    source, item.suggested_confidence, session.sent_at,
  ).run();
}

// ── MORE — send a 3-pack (Phase B) inline as TwiML ────────────────────────

async function sendNextBatchAsTwiml(env: Env, person: PersonRow): Promise<Response> {
  if (person.paused_until_date) {
    const today = localNow(person.timezone).dateKey;
    if (person.paused_until_date >= today) {
      return twimlMessage("You're paused for today — text START tomorrow if you want more.");
    }
  }
  // Try a 3-pack; pickAndOpenBatchSession falls back to a single
  // automatically when there aren't 3 left.
  const result = await pickAndOpenBatchSession(env, person.user_id, person.person, person.timezone)
    ?? await pickAndOpenSession(env, person.user_id, person.person, person.timezone);
  if (!result) {
    return twimlMessage("All caught up — nothing left in your queue. 🎉");
  }
  return twimlMessage(result.message);
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function loadTransactionContext(env: Env, txId: string): Promise<{
  merchant: string | null;
  amount: number;
  date: string;
  description: string;
  account_owner: string | null;
}> {
  const row = await env.DB.prepare(
    `SELECT t.merchant_name, t.amount, t.posted_date, t.description, a.owner_tag
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ?`,
  ).bind(txId).first<{
    merchant_name: string | null;
    amount: number;
    posted_date: string;
    description: string;
    owner_tag: string | null;
  }>();
  return {
    merchant: row?.merchant_name ?? null,
    amount: row?.amount ?? 0,
    date: row?.posted_date ?? '',
    description: row?.description ?? '',
    account_owner: row?.owner_tag ?? null,
  };
}

function friendly(p: SmsIntentResult): string {
  return friendlyShort({
    entity: p.entity,
    category_tax: p.category_tax || null,
    category_budget: p.category_budget || null,
  });
}

function friendlyShort(p: { entity: string; category_tax: string | null; category_budget: string | null }): string {
  const cat = humanizeCategory({
    entity: p.entity,
    category_tax: p.category_tax,
    category_budget: p.category_budget,
    confidence: 1,
    method: 'rule',
  } as Suggestion);
  if (cat) return cat;
  return p.entity.replace(/_/g, ' ');
}

function shortLabel(item: BatchItem): string {
  return item.merchant?.trim() || item.description.slice(0, 20);
}
