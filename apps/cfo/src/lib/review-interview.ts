/**
 * "Interview mode" helper — pulls one pending review item and enriches it
 * with everything a model (or a human) needs to make a good call without
 * scrolling through history:
 *
 *   1. The transaction itself (merchant, description, amount, date, account)
 *   2. The current AI suggestion, if any (entity + category + confidence)
 *   3. Historical precedent: how the *user* has previously classified the
 *      same merchant, newest first
 *   4. Active learned/user rules that match this merchant
 *   5. A small pool of "similar merchants" — other merchants sharing a
 *      leading token — as a soft hint for unfamiliar names
 *
 * The learning loop itself already lives in lib/learned-rules.ts — every
 * time `handleResolveReview` fires a `classify` action, it calls
 * `maybeLearnRuleFromManualClassification`, which promotes a merchant →
 * (entity, category) rule after 3+ consistent manual decisions. This
 * helper is the "read side" of that loop: it surfaces the precedent so
 * the model can lean on it, and as the user keeps answering, the
 * suggestions get sharper without any extra plumbing.
 */

import type { Env } from '../types';
import { backfillUnclassifiedReviewQueue } from './review-queue';

export interface InterviewItem {
  review_id: string;
  transaction_id: string;
  reason: string;
  transaction: {
    posted_date: string;
    amount: number;
    merchant_name: string | null;
    description: string;
    account_name: string | null;
    account_owner: string | null;
  };
  current_suggestion: {
    entity: string | null;
    category_tax: string | null;
    category_budget: string | null;
    confidence: number | null;
    method: string | null;
  };
  historical_precedent: Array<{
    posted_date: string;
    amount: number;
    description: string;
    entity: string;
    category_tax: string | null;
    category_budget: string | null;
    method: string;
  }>;
  matching_rules: Array<{
    id: string;
    name: string;
    match_field: string;
    match_operator: string;
    match_value: string;
    entity: string;
    category_tax: string | null;
    category_budget: string | null;
  }>;
  similar_merchants: Array<{
    merchant_name: string;
    entity: string;
    category_tax: string | null;
    count: number;
  }>;
  queue_remaining: number;
}

const PRECEDENT_LIMIT = 8;
const SIMILAR_LIMIT = 5;

/**
 * Extract a coarse "signature" token for fuzzy similar-merchant lookup.
 * Strips punctuation and trailing digits so "Amazon.com*123AB" and
 * "AMZN Mktp US" both map to `amazon`.
 */
function leadToken(merchant: string | null | undefined): string | null {
  if (!merchant) return null;
  const cleaned = merchant
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const first = cleaned.split(' ')[0];
  if (!first || first.length < 3) return null;
  return first;
}

export async function getNextInterviewItem(
  env: Env,
  userId: string,
): Promise<InterviewItem | null> {
  await backfillUnclassifiedReviewQueue(env, userId);

  const row = await env.DB.prepare(
    `SELECT rq.id AS review_id,
            rq.transaction_id,
            rq.reason,
            t.posted_date, t.amount, t.merchant_name, t.description,
            a.name AS account_name, a.owner_tag AS account_owner,
            c.entity AS current_entity,
            c.category_tax AS current_category_tax,
            c.category_budget AS current_category_budget,
            c.confidence AS current_confidence,
            c.method AS current_method
     FROM review_queue rq
     JOIN transactions t ON t.id = rq.transaction_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN classifications c ON c.transaction_id = t.id
     WHERE rq.user_id = ? AND rq.status = 'pending'
     ORDER BY rq.created_at ASC
     LIMIT 1`,
  ).bind(userId).first<{
    review_id: string;
    transaction_id: string;
    reason: string;
    posted_date: string;
    amount: number;
    merchant_name: string | null;
    description: string;
    account_name: string | null;
    account_owner: string | null;
    current_entity: string | null;
    current_category_tax: string | null;
    current_category_budget: string | null;
    current_confidence: number | null;
    current_method: string | null;
  }>();

  if (!row) return null;

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM review_queue WHERE user_id = ? AND status = 'pending'`,
  ).bind(userId).first<{ total: number }>();

  const merchant = (row.merchant_name ?? '').trim();

  const historical = merchant
    ? await env.DB.prepare(
        `SELECT t.posted_date, t.amount, t.description,
                c.entity, c.category_tax, c.category_budget, c.method
         FROM transactions t
         JOIN classifications c ON c.transaction_id = t.id
         WHERE t.user_id = ?
           AND t.id != ?
           AND lower(trim(COALESCE(t.merchant_name, ''))) = lower(?)
         ORDER BY t.posted_date DESC
         LIMIT ?`,
      ).bind(userId, row.transaction_id, merchant, PRECEDENT_LIMIT).all<{
        posted_date: string;
        amount: number;
        description: string;
        entity: string;
        category_tax: string | null;
        category_budget: string | null;
        method: string;
      }>()
    : { results: [] };

  const matchingRules = merchant
    ? await env.DB.prepare(
        `SELECT id, name, match_field, match_operator, match_value,
                entity, category_tax, category_budget
         FROM rules
         WHERE user_id = ?
           AND is_active = 1
           AND match_field = 'merchant_name'
           AND (
             (match_operator = 'equals'   AND lower(match_value) = lower(?))
             OR (match_operator = 'contains' AND instr(lower(?), lower(match_value)) > 0)
           )
         ORDER BY priority DESC
         LIMIT 10`,
      ).bind(userId, merchant, merchant).all<{
        id: string;
        name: string;
        match_field: string;
        match_operator: string;
        match_value: string;
        entity: string;
        category_tax: string | null;
        category_budget: string | null;
      }>()
    : { results: [] };

  const token = leadToken(merchant);
  const similar = token
    ? await env.DB.prepare(
        `SELECT t.merchant_name,
                c.entity,
                c.category_tax,
                COUNT(*) AS count
         FROM transactions t
         JOIN classifications c ON c.transaction_id = t.id
         WHERE t.user_id = ?
           AND t.merchant_name IS NOT NULL
           AND lower(trim(t.merchant_name)) != lower(?)
           AND lower(trim(t.merchant_name)) LIKE ?
         GROUP BY t.merchant_name, c.entity, c.category_tax
         ORDER BY count DESC
         LIMIT ?`,
      ).bind(userId, merchant, `${token}%`, SIMILAR_LIMIT).all<{
        merchant_name: string;
        entity: string;
        category_tax: string | null;
        count: number;
      }>()
    : { results: [] };

  return {
    review_id: row.review_id,
    transaction_id: row.transaction_id,
    reason: row.reason,
    transaction: {
      posted_date: row.posted_date,
      amount: row.amount,
      merchant_name: row.merchant_name,
      description: row.description,
      account_name: row.account_name,
      account_owner: row.account_owner,
    },
    current_suggestion: {
      entity: row.current_entity,
      category_tax: row.current_category_tax,
      category_budget: row.current_category_budget,
      confidence: row.current_confidence,
      method: row.current_method,
    },
    historical_precedent: historical.results,
    matching_rules: matchingRules.results,
    similar_merchants: similar.results,
    queue_remaining: totalRow?.total ?? 0,
  };
}
