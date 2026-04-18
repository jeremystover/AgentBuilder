import { z } from 'zod';
import type { Env, Entity } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';
import { readBookkeepingNotes, saveBookkeepingNotes } from '../lib/bookkeeping-notes';
import { maybeLearnRuleFromManualClassification } from '../lib/learned-rules';
import { backfillUnclassifiedReviewQueue } from '../lib/review-queue';

const VALID_ENTITIES: Entity[] = ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'];
const BATCH_SIZE = 20;
const HIGH_CONFIDENCE_THRESHOLD = 0.80;

type Phase = 'income_confident' | 'income_uncertain' | 'expense_confident' | 'expense_uncertain';

const ENTITY_DISPLAY: Record<Entity, string> = {
  elyse_coaching: "Elyse's Coaching",
  jeremy_coaching: "Jeremy's Coaching",
  airbnb_activity: 'Whitford House Airbnb',
  family_personal: 'Family / Personal',
};

function isValidEntity(value: string): value is Entity {
  return VALID_ENTITIES.includes(value as Entity);
}

function isValidPhase(value: string): value is Phase {
  return ['income_confident', 'income_uncertain', 'expense_confident', 'expense_uncertain'].includes(value);
}

interface BookkeepingTransaction {
  line: number;
  transaction_id: string;
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
  review_id: string | null;
  suggested_entity: string | null;
  suggested_category_tax: string | null;
}

// ── GET /bookkeeping/session ──────────────────────────────────────────────────
// Start or resume a bookkeeping session. Returns an overview of what needs
// attention for the given entity, along with stored notes.
export async function handleBookkeepingSession(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const entity = url.searchParams.get('entity');

  if (!entity || !isValidEntity(entity)) {
    return jsonError(`entity must be one of: ${VALID_ENTITIES.join(', ')}`);
  }

  await backfillUnclassifiedReviewQueue(env, userId);

  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN t.amount > 0 AND COALESCE(c.confidence, rq.confidence, 0) >= ? THEN 1 ELSE 0 END) AS income_confident,
       SUM(CASE WHEN t.amount > 0 AND COALESCE(c.confidence, rq.confidence, 0) < ? THEN 1 ELSE 0 END) AS income_uncertain,
       SUM(CASE WHEN t.amount <= 0 AND COALESCE(c.confidence, rq.confidence, 0) >= ? THEN 1 ELSE 0 END) AS expense_confident,
       SUM(CASE WHEN t.amount <= 0 AND COALESCE(c.confidence, rq.confidence, 0) < ? THEN 1 ELSE 0 END) AS expense_uncertain
     FROM transactions t
     LEFT JOIN classifications c ON c.transaction_id = t.id
     LEFT JOIN review_queue rq ON rq.transaction_id = t.id
     WHERE t.user_id = ?
       AND t.is_pending = 0
       AND (
         (c.entity = ? AND c.review_required = 1)
         OR (c.id IS NULL AND rq.suggested_entity = ?)
         OR (c.id IS NULL AND rq.suggested_entity IS NULL)
       )`,
  ).bind(
    HIGH_CONFIDENCE_THRESHOLD, HIGH_CONFIDENCE_THRESHOLD,
    HIGH_CONFIDENCE_THRESHOLD, HIGH_CONFIDENCE_THRESHOLD,
    userId, entity, entity,
  ).first<{
    income_confident: number;
    income_uncertain: number;
    expense_confident: number;
    expense_uncertain: number;
  }>();

  const notes = await readBookkeepingNotes(env, userId, entity);

  return jsonOk({
    entity,
    display_name: ENTITY_DISPLAY[entity],
    phases: {
      income_confident: counts?.income_confident ?? 0,
      income_uncertain: counts?.income_uncertain ?? 0,
      expense_confident: counts?.expense_confident ?? 0,
      expense_uncertain: counts?.expense_uncertain ?? 0,
    },
    total_pending: (counts?.income_confident ?? 0) + (counts?.income_uncertain ?? 0) +
                   (counts?.expense_confident ?? 0) + (counts?.expense_uncertain ?? 0),
    notes: notes || null,
    next_phase: determineNextPhase(counts),
    batch_size: BATCH_SIZE,
  });
}

function determineNextPhase(counts: {
  income_confident: number;
  income_uncertain: number;
  expense_confident: number;
  expense_uncertain: number;
} | null): Phase | null {
  if (!counts) return null;
  if (counts.income_confident > 0) return 'income_confident';
  if (counts.income_uncertain > 0) return 'income_uncertain';
  if (counts.expense_confident > 0) return 'expense_confident';
  if (counts.expense_uncertain > 0) return 'expense_uncertain';
  return null;
}

// ── GET /bookkeeping/batch ────────────────────────────────────────────────────
// Fetch a batch of transactions for a specific phase.
export async function handleBookkeepingBatch(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const entity = url.searchParams.get('entity');
  const phase = url.searchParams.get('phase');
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  if (!entity || !isValidEntity(entity)) {
    return jsonError(`entity must be one of: ${VALID_ENTITIES.join(', ')}`);
  }
  if (!phase || !isValidPhase(phase)) {
    return jsonError('phase must be one of: income_confident, income_uncertain, expense_confident, expense_uncertain');
  }

  await backfillUnclassifiedReviewQueue(env, userId);

  const isIncome = phase.startsWith('income');
  const isConfident = phase.endsWith('confident');
  const amountCondition = isIncome ? 't.amount > 0' : 't.amount <= 0';
  const confidenceCondition = isConfident
    ? `COALESCE(c.confidence, rq.confidence, 0) >= ${HIGH_CONFIDENCE_THRESHOLD}`
    : `COALESCE(c.confidence, rq.confidence, 0) < ${HIGH_CONFIDENCE_THRESHOLD}`;

  const rows = await env.DB.prepare(
    `SELECT
       t.id AS transaction_id,
       t.posted_date, t.amount, t.merchant_name, t.description,
       a.name AS account_name, a.owner_tag AS account_owner,
       c.entity AS current_entity, c.category_tax AS current_category_tax,
       c.category_budget AS current_category_budget,
       c.confidence AS current_confidence, c.method AS current_method,
       rq.id AS review_id,
       rq.suggested_entity, rq.suggested_category_tax
     FROM transactions t
     LEFT JOIN classifications c ON c.transaction_id = t.id
     LEFT JOIN review_queue rq ON rq.transaction_id = t.id
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ?
       AND t.is_pending = 0
       AND ${amountCondition}
       AND ${confidenceCondition}
       AND (
         (c.entity = ? AND c.review_required = 1)
         OR (c.id IS NULL AND rq.suggested_entity = ?)
         OR (c.id IS NULL AND rq.suggested_entity IS NULL)
       )
     ORDER BY COALESCE(c.confidence, rq.confidence, 0) DESC, t.posted_date DESC
     LIMIT ? OFFSET ?`,
  ).bind(userId, entity, entity, BATCH_SIZE, offset).all<{
    transaction_id: string;
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
    review_id: string | null;
    suggested_entity: string | null;
    suggested_category_tax: string | null;
  }>();

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM transactions t
     LEFT JOIN classifications c ON c.transaction_id = t.id
     LEFT JOIN review_queue rq ON rq.transaction_id = t.id
     WHERE t.user_id = ?
       AND t.is_pending = 0
       AND ${amountCondition}
       AND ${confidenceCondition}
       AND (
         (c.entity = ? AND c.review_required = 1)
         OR (c.id IS NULL AND rq.suggested_entity = ?)
         OR (c.id IS NULL AND rq.suggested_entity IS NULL)
       )`,
  ).bind(userId, entity, entity).first<{ total: number }>();

  const transactions: BookkeepingTransaction[] = rows.results.map((row, idx) => ({
    line: offset + idx + 1,
    ...row,
  }));

  return jsonOk({
    entity,
    display_name: ENTITY_DISPLAY[entity],
    phase,
    offset,
    batch_size: BATCH_SIZE,
    total_in_phase: totalRow?.total ?? 0,
    has_more: offset + BATCH_SIZE < (totalRow?.total ?? 0),
    transactions,
  });
}

// ── POST /bookkeeping/commit ──────────────────────────────────────────────────
// Commit a batch of bookkeeping decisions.

const DecisionSchema = z.object({
  transaction_id: z.string().min(1),
  action: z.enum(['classify', 'accept', 'skip']),
  entity: z.enum(['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal']).optional(),
  category_tax: z.string().optional(),
  category_budget: z.string().optional(),
});

const CommitSchema = z.object({
  decisions: z.array(DecisionSchema).min(1).max(100),
});

export async function handleBookkeepingCommit(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const parsed = CommitSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  let classified = 0;
  let accepted = 0;
  let skipped = 0;
  let errors = 0;

  for (const decision of parsed.data.decisions) {
    try {
      if (decision.action === 'skip') {
        skipped++;
        continue;
      }

      if (decision.action === 'classify') {
        if (!decision.entity || !decision.category_tax) {
          errors++;
          continue;
        }

        const existing = await env.DB.prepare(
          'SELECT entity, category_tax, category_budget, confidence, method, is_locked FROM classifications WHERE transaction_id = ?',
        ).bind(decision.transaction_id).first<{
          entity: string; category_tax: string; category_budget: string;
          confidence: number; method: string; is_locked: number;
        }>();

        if (existing?.is_locked) { errors++; continue; }

        if (existing) {
          await env.DB.prepare(
            `INSERT INTO classification_history
               (id, transaction_id, entity, category_tax, category_budget, confidence, method, changed_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'bookkeeping')`,
          ).bind(
            crypto.randomUUID(), decision.transaction_id,
            existing.entity, existing.category_tax, existing.category_budget,
            existing.confidence, existing.method,
          ).run();
        }

        await env.DB.prepare(
          `INSERT INTO classifications
             (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes, review_required, classified_by)
           VALUES (?, ?, ?, ?, ?, 1.0, 'manual', '["bookkeeping_session"]', 0, 'user')
           ON CONFLICT(transaction_id) DO UPDATE SET
             entity=excluded.entity, category_tax=excluded.category_tax,
             category_budget=excluded.category_budget, confidence=1.0,
             method='manual', review_required=0, classified_by='user',
             classified_at=datetime('now')`,
        ).bind(
          crypto.randomUUID(), decision.transaction_id,
          decision.entity, decision.category_tax, decision.category_budget ?? null,
        ).run();

        await env.DB.prepare(
          `UPDATE review_queue SET status='resolved', resolved_by='bookkeeping', resolved_at=datetime('now')
           WHERE transaction_id = ? AND status = 'pending'`,
        ).bind(decision.transaction_id).run();

        await maybeLearnRuleFromManualClassification(env, userId, decision.transaction_id, {
          entity: decision.entity,
          category_tax: decision.category_tax,
          category_budget: decision.category_budget ?? null,
        });

        classified++;
      }

      if (decision.action === 'accept') {
        const existing = await env.DB.prepare(
          'SELECT id, is_locked FROM classifications WHERE transaction_id = ?',
        ).bind(decision.transaction_id).first<{ id: string; is_locked: number }>();

        if (!existing) { errors++; continue; }
        if (existing.is_locked) { errors++; continue; }

        await env.DB.prepare(
          'UPDATE classifications SET review_required=0 WHERE transaction_id=?',
        ).bind(decision.transaction_id).run();

        await env.DB.prepare(
          `UPDATE review_queue SET status='resolved', resolved_by='bookkeeping', resolved_at=datetime('now')
           WHERE transaction_id = ? AND status = 'pending'`,
        ).bind(decision.transaction_id).run();

        accepted++;
      }
    } catch {
      errors++;
    }
  }

  return jsonOk({
    total: parsed.data.decisions.length,
    classified,
    accepted,
    skipped,
    errors,
  });
}

// ── GET /bookkeeping/notes ────────────────────────────────────────────────────
export async function handleGetBookkeepingNotes(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  const url = new URL(request.url);
  const entity = url.searchParams.get('entity');

  if (!entity || !isValidEntity(entity)) {
    return jsonError(`entity must be one of: ${VALID_ENTITIES.join(', ')}`);
  }

  const notes = await readBookkeepingNotes(env, userId, entity);
  return jsonOk({
    entity,
    display_name: ENTITY_DISPLAY[entity],
    notes: notes || null,
  });
}

// ── PUT /bookkeeping/notes ────────────────────────────────────────────────────
export async function handleSaveBookkeepingNotes(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON'); }

  const schema = z.object({
    entity: z.enum(['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal']),
    notes: z.string(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  await saveBookkeepingNotes(env, userId, parsed.data.entity, parsed.data.notes);
  return jsonOk({ saved: true, entity: parsed.data.entity });
}
