/**
 * Shared selection + session-opening logic, used by:
 *   - the cron dispatcher (sms-dispatcher.ts) for scheduled sends
 *   - the inbound MORE handler (sms-inbound.ts) for in-session drain
 *
 * Returns the rendered SMS body so the caller decides how to send it
 * (Twilio API call vs TwiML inline). When called from the inbound
 * handler we skip the Twilio API call — the body goes back as TwiML in
 * the same HTTP turn.
 */

import type { Env, Transaction, Rule } from '../types';
import { applyRules } from './rules';

export interface PickedSession {
  session_id: string;
  transaction_id: string;
  message: string;
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

interface Suggestion {
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
 * Returns null if there are no eligible transactions left.
 */
export async function pickAndOpenSession(
  env: Env,
  userId: string,
  person: 'jeremy' | 'elyse',
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
  const sessionId = `sms_${crypto.randomUUID()}`;
  const message = renderInitialMessage(tx, suggestion);

  await env.DB.prepare(
    `INSERT INTO sms_sessions
       (id, user_id, person, transaction_id,
        suggested_entity, suggested_category_tax, suggested_category_budget,
        suggested_confidence, suggested_method, status, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_reply', datetime('now'))`,
  ).bind(
    sessionId, userId, person, tx.id,
    suggestion.entity, suggestion.category_tax, suggestion.category_budget,
    suggestion.confidence, suggestion.method,
  ).run();

  return { session_id: sessionId, transaction_id: tx.id, message };
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

export function renderInitialMessage(tx: CandidateTx, suggestion: Suggestion): string {
  const merchant = tx.merchant_name?.trim() || tx.description.slice(0, 40);
  const amt = `$${Math.abs(tx.amount).toFixed(2)}`;
  const date = tx.posted_date.slice(5); // MM-DD
  const guess = humanizeCategory(suggestion);
  if (guess) {
    return [
      `Can you help me categorize this transaction?`,
      `${merchant} · ${amt} · ${date}`,
      `I think it's ${guess} — is that right?`,
      `Reply 1 for yes, 2 to send to Jeremy instead, or describe what it is.`,
      `PAUSE (or 3) to pause for today.`,
    ].join('\n');
  }
  return [
    `Can you help me categorize this transaction?`,
    `${merchant} · ${amt} · ${date}`,
    `What category is this? Reply with a description.`,
    `Or 2 to send to Jeremy instead. PAUSE (or 3) to pause for today.`,
  ].join('\n');
}

function humanizeCategory(s: Suggestion): string | null {
  if (s.method === 'fallback' || (!s.category_tax && !s.category_budget)) return null;
  const slug = s.category_budget ?? s.category_tax;
  if (!slug) return null;
  return slug.replace(/_/g, ' ');
}
