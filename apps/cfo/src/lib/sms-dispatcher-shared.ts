/**
 * Shared selection + session-opening logic, used by:
 *   - the cron dispatcher (sms-dispatcher.ts) for scheduled sends
 *   - the inbound MORE handler (sms-inbound.ts) for in-session drain
 *
 * Returns the rendered SMS body so the caller decides how to send it
 * (Twilio API call vs TwiML inline). When called from the inbound
 * handler we skip the Twilio API call — the body goes back as TwiML in
 * the same HTTP turn.
 *
 * Two modes:
 *   - single: pickAndOpenSession — one transaction, used for the first
 *     daily prompt per the spec ("only send one in the initial message").
 *   - batch:  pickAndOpenBatchSession — three labeled A/B/C, used after
 *     the user opts in via MORE (Phase B).
 */

import type { Env, Transaction, Rule } from '../types';
import { applyRules } from './rules';
import { localNow } from './pacific-time';
import { pickVariant, renderInitialByTone, renderBatchByTone, type Variant } from './sms-variants';

export interface PickedSession {
  session_id: string;
  transaction_id: string;
  message: string;
  variant_id: string;
}

interface CandidateTx {
  id: string;
  posted_date: string;
  amount: number;
  merchant_name: string | null;
  description: string;
  account_id: string | null;
  account_name: string | null;
  owner_tag: string | null;
}

export interface Suggestion {
  entity: string;
  category_tax: string | null;
  category_budget: string | null;
  confidence: number;
  method: 'rule' | 'ai' | 'historical' | 'fallback';
}

/**
 * Pick the next eligible transaction for `person`, compute a suggestion,
 * persist a new awaiting_reply session, and return the rendered SMS.
 * Caller is responsible for actually sending the SMS (or returning it
 * as TwiML).
 *
 * `timezone` is used solely for variant selection — same person + same
 * local date = same variant all day, satisfying the spec's "day-to-day"
 * A/B framing.
 *
 * Returns null if there are no eligible transactions left.
 */
export async function pickAndOpenSession(
  env: Env,
  userId: string,
  person: 'jeremy' | 'elyse',
  timezone: string = 'America/Los_Angeles',
): Promise<PickedSession | null> {
  // Skip if we already have an open session — a single user shouldn't
  // get parallel prompts. (The cron path also checks this; the MORE
  // path closes the prior session before calling us.)
  const open = await env.DB.prepare(
    `SELECT 1 FROM sms_sessions
     WHERE user_id = ? AND person = ? AND status = 'awaiting_reply' LIMIT 1`,
  ).bind(userId, person).first();
  if (open) return null;

  const tx = await pickNextTransaction(env, userId, person);
  if (!tx) return null;

  const suggestion = await computeSuggestion(env, userId, tx);
  const variant = pickVariant(person, localNow(timezone).dateKey);
  const sessionId = `sms_${crypto.randomUUID()}`;
  const message = renderInitialMessage(tx, suggestion, variant);

  await env.DB.prepare(
    `INSERT INTO sms_sessions
       (id, user_id, person, transaction_id,
        suggested_entity, suggested_category_tax, suggested_category_budget,
        suggested_confidence, suggested_method, variant_id, status, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_reply', datetime('now'))`,
  ).bind(
    sessionId, userId, person, tx.id,
    suggestion.entity, suggestion.category_tax, suggestion.category_budget,
    suggestion.confidence, suggestion.method, variant.id,
  ).run();

  return { session_id: sessionId, transaction_id: tx.id, message, variant_id: variant.id };
}

export async function pickNextTransaction(
  env: Env,
  userId: string,
  person: 'jeremy' | 'elyse',
): Promise<CandidateTx | null> {
  const row = await env.DB.prepare(
    `SELECT t.id, t.posted_date, t.amount, t.merchant_name, t.description,
            t.account_id, a.name AS account_name, a.owner_tag
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN classifications c ON c.transaction_id = t.id
     LEFT JOIN sms_routing_overrides r ON r.transaction_id = t.id
     WHERE t.user_id = ?
       AND c.id IS NULL
       AND t.is_pending = 0
       AND (
         LOWER(COALESCE(r.target_person, a.owner_tag)) = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM sms_sessions s
         WHERE s.transaction_id = t.id AND s.status = 'awaiting_reply'
       )
     ORDER BY t.posted_date ASC, t.id ASC
     LIMIT 1`,
  ).bind(userId, person).first<CandidateTx>();
  return row ?? null;
}

export async function computeSuggestion(
  env: Env,
  userId: string,
  tx: CandidateTx,
): Promise<Suggestion> {
  const rulesResult = await env.DB.prepare(
    'SELECT * FROM rules WHERE user_id = ? AND is_active = 1 ORDER BY priority DESC',
  ).bind(userId).all<Rule>();
  const ruleMatch = applyRules(tx as unknown as Transaction, rulesResult.results);
  if (ruleMatch) {
    return {
      entity: ruleMatch.entity,
      category_tax: ruleMatch.category_tax,
      category_budget: ruleMatch.category_budget,
      confidence: 1.0,
      method: 'rule',
    };
  }

  if (tx.merchant_name) {
    const history = await env.DB.prepare(
      `SELECT c.entity, c.category_tax, c.category_budget, COUNT(*) AS cnt
       FROM transactions t2
       JOIN classifications c ON c.transaction_id = t2.id
       WHERE t2.user_id = ?
         AND LOWER(t2.merchant_name) = LOWER(?)
         AND c.review_required = 0
       GROUP BY c.entity, c.category_tax, c.category_budget
       ORDER BY cnt DESC LIMIT 1`,
    ).bind(userId, tx.merchant_name).first<{
      entity: string; category_tax: string | null; category_budget: string | null; cnt: number;
    }>();
    if (history && history.cnt >= 2) {
      return {
        entity: history.entity,
        category_tax: history.category_tax,
        category_budget: history.category_budget,
        confidence: Math.min(0.5 + history.cnt * 0.1, 0.9),
        method: 'historical',
      };
    }
  }

  return { entity: 'family_personal', category_tax: null, category_budget: null, confidence: 0, method: 'fallback' };
}

export function renderInitialMessage(tx: CandidateTx, suggestion: Suggestion, variant: Variant): string {
  return renderInitialByTone(variant.tone, {
    merchant: tx.merchant_name?.trim() || tx.description.slice(0, 40),
    amount_str: `$${Math.abs(tx.amount).toFixed(2)}`,
    date: tx.posted_date.slice(5), // MM-DD
    guess: humanizeCategory(suggestion),
  });
}

export function humanizeCategory(s: Suggestion): string | null {
  if (s.method === 'fallback' || (!s.category_tax && !s.category_budget)) return null;
  const slug = s.category_budget ?? s.category_tax;
  if (!slug) return null;
  return slug.replace(/_/g, ' ');
}

// ── Batch (Phase B) ────────────────────────────────────────────────────────

export interface BatchItem {
  label: 'A' | 'B' | 'C';
  transaction_id: string;
  merchant: string | null;
  amount: number;
  date: string;
  description: string;
  account_owner: string | null;
  suggested_entity: string;
  suggested_category_tax: string | null;
  suggested_category_budget: string | null;
  suggested_confidence: number;
  suggested_method: 'rule' | 'ai' | 'historical' | 'fallback';
}

/**
 * Open a batch session (3 labeled transactions). Falls back to a single-
 * item session if there are fewer than 3 eligible transactions left.
 */
export async function pickAndOpenBatchSession(
  env: Env,
  userId: string,
  person: 'jeremy' | 'elyse',
  timezone: string = 'America/Los_Angeles',
): Promise<PickedSession | null> {
  const open = await env.DB.prepare(
    `SELECT 1 FROM sms_sessions
     WHERE user_id = ? AND person = ? AND status = 'awaiting_reply' LIMIT 1`,
  ).bind(userId, person).first();
  if (open) return null;

  // Pick up to 3 distinct transactions oldest-first, applying the same
  // owner_tag + reroute logic as pickNextTransaction.
  const rows = await env.DB.prepare(
    `SELECT t.id, t.posted_date, t.amount, t.merchant_name, t.description,
            t.account_id, a.name AS account_name, a.owner_tag
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN classifications c ON c.transaction_id = t.id
     LEFT JOIN sms_routing_overrides r ON r.transaction_id = t.id
     WHERE t.user_id = ?
       AND c.id IS NULL
       AND t.is_pending = 0
       AND (
         LOWER(COALESCE(r.target_person, a.owner_tag)) = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM sms_sessions s
         WHERE s.transaction_id = t.id AND s.status = 'awaiting_reply'
       )
     ORDER BY t.posted_date ASC, t.id ASC
     LIMIT 3`,
  ).bind(userId, person).all<CandidateTx>();

  if (rows.results.length === 0) return null;
  if (rows.results.length < 3) {
    // Not enough for a batch — fall back to single mode so the user
    // doesn't get a half-empty 3-pack.
    return pickAndOpenSession(env, userId, person, timezone);
  }

  const labels: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C'];
  const items: BatchItem[] = [];
  for (let i = 0; i < 3; i++) {
    const tx = rows.results[i]!;
    const sug = await computeSuggestion(env, userId, tx);
    items.push({
      label: labels[i]!,
      transaction_id: tx.id,
      merchant: tx.merchant_name,
      amount: tx.amount,
      date: tx.posted_date,
      description: tx.description,
      account_owner: tx.owner_tag,
      suggested_entity: sug.entity,
      suggested_category_tax: sug.category_tax,
      suggested_category_budget: sug.category_budget,
      suggested_confidence: sug.confidence,
      suggested_method: sug.method,
    });
  }

  const variant = pickVariant(person, localNow(timezone).dateKey);
  const sessionId = `sms_${crypto.randomUUID()}`;
  const message = renderBatchMessage(items, variant);
  const primary = items[0]!;

  await env.DB.prepare(
    `INSERT INTO sms_sessions
       (id, user_id, person, transaction_id,
        suggested_entity, suggested_category_tax, suggested_category_budget,
        suggested_confidence, suggested_method, variant_id, status, sent_at, batch_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_reply', datetime('now'), ?)`,
  ).bind(
    sessionId, userId, person, primary.transaction_id,
    primary.suggested_entity, primary.suggested_category_tax, primary.suggested_category_budget,
    primary.suggested_confidence, primary.suggested_method, variant.id,
    JSON.stringify(items),
  ).run();

  return { session_id: sessionId, transaction_id: primary.transaction_id, message, variant_id: variant.id };
}

function renderBatchMessage(items: BatchItem[], variant: Variant): string {
  return renderBatchByTone(variant.tone, items, (it) => ({
    merchant: it.merchant?.trim() || it.description.slice(0, 30),
    amount_str: `$${Math.abs(it.amount).toFixed(2)}`,
    date: it.date.slice(5),
    guess: humanizeCategory({
      entity: it.suggested_entity,
      category_tax: it.suggested_category_tax,
      category_budget: it.suggested_category_budget,
      confidence: it.suggested_confidence,
      method: it.suggested_method,
    }),
  }));
}

export function parseBatchJson(raw: string | null): BatchItem[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as BatchItem[];
  } catch {
    return null;
  }
}

