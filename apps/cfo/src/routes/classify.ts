import type { Env, Transaction, Rule } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';
import { classifyBatch } from '../lib/claude';
import { applyRules } from '../lib/rules';
import { cleanDescription } from '../lib/dedup';
import { backfillUnclassifiedReviewQueue, resolveReviewQueueItem, upsertReviewQueue } from '../lib/review-queue';
import { buildAmazonSearchText, loadAmazonContext } from '../lib/amazon';

function buildAccountContext(tx: {
  account_name?: string | null;
  account_mask?: string | null;
  account_type?: string | null;
  account_subtype?: string | null;
  owner_tag?: string | null;
}): string {
  const parts = [
    tx.account_name,
    tx.account_mask ? `mask ${tx.account_mask}` : null,
    [tx.account_type, tx.account_subtype].filter(Boolean).join('/'),
    tx.owner_tag ? `owner ${tx.owner_tag}` : null,
  ].filter(Boolean);

  return parts.join(' | ') || 'unknown';
}

function summarizeReasonCodes(reasonCodes: string[] | undefined): string[] {
  const labels: Record<string, string> = {
    historical_precedent: 'matched against similar past classifications',
    split_candidate: 'looks split-purpose or mixed-use',
    business_tool: 'looks like a business tool or service',
    merchant_match: 'merchant name was the main signal',
    weak_merchant_match: 'merchant match was weak',
    amount_outlier: 'amount did not fit prior examples',
    ambiguous_merchant: 'merchant could fit multiple categories',
    insufficient_context: 'the transaction text did not provide much context',
  };

  return (reasonCodes ?? [])
    .slice(0, 3)
    .map(code => {
      const [prefix, suffix] = code.split(':', 2);
      if (prefix === 'merchant_match' && suffix) return `merchant matched "${suffix}"`;
      if (prefix === 'rule' && suffix) return `matched rule "${suffix}"`;
      return labels[code] ?? labels[prefix] ?? code.replace(/_/g, ' ');
    });
}

function buildNeedsInputHint(tx: Transaction, reasonCodes: string[] | undefined, error?: string): string {
  const hints: string[] = [];
  const description = (tx.description ?? '').trim();
  const merchant = (tx.merchant_name ?? '').trim();

  if (!merchant) hints.push('merchant name');
  if (!description || description.length < 12) hints.push('a more specific transaction description');
  if ((reasonCodes ?? []).some(code => code.includes('split'))) hints.push('whether this should be split across business and personal use');
  if ((reasonCodes ?? []).some(code => code.includes('ambiguous'))) hints.push('the intended business purpose');
  if (error) hints.push('a retry after the classifier service error is resolved');

  if (!hints.length) {
    return 'A manual classification for this merchant, or a short note about its purpose, would help future auto-classification.';
  }

  return `Helpful missing context: ${hints.join(', ')}.`;
}

function buildReviewDetails(tx: Transaction, result?: { confidence: number; reason_codes: string[] }, error?: string): {
  details: string;
  needsInput: string;
} {
  if (error) {
    const safeError = error.length > 160 ? `${error.slice(0, 157)}...` : error;
    return {
      details: `The AI classifier did not return a usable result for this transaction. ${safeError}`,
      needsInput: buildNeedsInputHint(tx, undefined, error),
    };
  }

  const summarized = summarizeReasonCodes(result?.reason_codes);
  const confidence = result ? `${Math.round(result.confidence * 100)}% confidence` : 'low confidence';
  const summary = summarized.length
    ? `${confidence}; ${summarized.join(', ')}.`
    : `${confidence}; the available transaction signals were not strong enough to auto-accept.`;

  return {
    details: `Held for review: ${summary}`,
    needsInput: buildNeedsInputHint(tx, result?.reason_codes),
  };
}

async function loadHistoricalExamples(env: Env, userId: string, tx: Transaction) {
  const merchantNeedle = cleanDescription(tx.merchant_name ?? tx.description ?? '')
    .replace(/[%_]/g, '')
    .slice(0, 40)
    .trim();
  const descriptionNeedle = (tx.description_clean ?? cleanDescription(`${tx.merchant_name ?? ''} ${tx.description ?? ''}`))
    .replace(/[%_]/g, '')
    .slice(0, 32)
    .trim();
  const amazonContext = await loadAmazonContext(env, tx.id);
  const amazonNeedle = buildAmazonSearchText(amazonContext)
    .replace(/[%_]/g, '')
    .slice(0, 32)
    .trim();

  if (!merchantNeedle && !descriptionNeedle && !amazonNeedle) return [];

  const similar = await env.DB.prepare(
    `SELECT t.merchant_name, t.description, c.entity, c.category_tax
     FROM transactions t
     JOIN classifications c ON c.transaction_id = t.id
     WHERE t.user_id = ?
       AND c.method != 'ai'
       AND (
         lower(COALESCE(t.merchant_name, '')) = ?
         OR lower(COALESCE(t.merchant_name, '')) LIKE ?
         OR COALESCE(t.description_clean, '') LIKE ?
         OR (? != '' AND t.description_clean LIKE ?)
       )
     ORDER BY
       CASE
         WHEN lower(COALESCE(t.merchant_name, '')) = ? THEN 0
         WHEN lower(COALESCE(t.merchant_name, '')) LIKE ? THEN 1
         ELSE 2
       END,
       t.posted_date DESC
     LIMIT 5`,
  ).bind(
    userId,
    merchantNeedle.toLowerCase(),
    merchantNeedle ? `%${merchantNeedle.toLowerCase()}%` : '',
    `%${descriptionNeedle}%`,
    amazonNeedle,
    `%${amazonNeedle}%`,
    merchantNeedle.toLowerCase(),
    merchantNeedle ? `%${merchantNeedle.toLowerCase()}%` : '',
  ).all<{ merchant_name: string | null; description: string; entity: string; category_tax: string }>();

  return similar.results.map(s => ({
    merchant: s.merchant_name ?? s.description,
    entity: s.entity,
    category_tax: s.category_tax,
  }));
}

// ── POST /classify/run ────────────────────────────────────────────────────────
// Runs the full classification pipeline on pending unclassified review items.
// Strategy: rules engine first → AI classifier with historical examples.
export async function handleRunClassification(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  await backfillUnclassifiedReviewQueue(env, userId);

  // Optional: caller may pass a list of transaction IDs to classify only those.
  let transactionIds: string[] | null = null;
  try {
    const body = await request.json() as { transaction_ids?: unknown };
    if (Array.isArray(body.transaction_ids) && body.transaction_ids.length > 0) {
      transactionIds = (body.transaction_ids as unknown[]).filter((id): id is string => typeof id === 'string');
    }
  } catch { /* empty body is fine */ }

  // Load all active rules for this user
  const rulesResult = await env.DB.prepare(
    'SELECT * FROM rules WHERE user_id = ? AND is_active = 1 ORDER BY priority DESC',
  ).bind(userId).all<Rule>();

  const rules = rulesResult.results;

  // Fetch pending unclassified items. If transaction_ids were supplied, restrict
  // to those; otherwise fall back to the 500-item default batch.
  const idClause = transactionIds
    ? `AND t.id IN (${transactionIds.map(() => '?').join(',')})`
    : '';
  const limitClause = transactionIds ? '' : 'LIMIT 500';
  const baseBinds: unknown[] = transactionIds ? [userId, ...transactionIds] : [userId];

  const unclassified = await env.DB.prepare(
    `SELECT t.*, a.name AS account_name, a.mask AS account_mask, a.type AS account_type, a.subtype AS account_subtype, a.owner_tag
     FROM review_queue rq
     JOIN transactions t ON t.id = rq.transaction_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN classifications c ON c.transaction_id = t.id
     WHERE rq.user_id = ?
       AND rq.status = 'pending'
       AND t.is_pending = 0
       AND (
         (rq.reason = 'unclassified' AND c.id IS NULL)
         OR trim(COALESCE(rq.suggested_category_tax, c.category_tax, '')) = ''
         OR lower(trim(COALESCE(rq.suggested_category_tax, c.category_tax, ''))) = 'unclassified'
       )
       ${idClause}
     ORDER BY rq.created_at ASC
     ${limitClause}`,
  ).bind(...baseBinds).all<Transaction & {
    account_name: string | null;
    account_mask: string | null;
    account_type: string | null;
    account_subtype: string | null;
    owner_tag: string | null;
  }>();

  if (!unclassified.results.length) {
    return jsonOk({
      message: 'No unclassified transactions found.',
      total_processed: 0,
      classified_by_rules: 0,
      classified_by_ai: 0,
      queued_for_review: 0,
      ai_errors: 0,
    });
  }

  let ruleHits = 0;
  let aiQueued = 0;
  let aiErrors = 0;
  const needsAI: typeof unclassified.results = [];

  // ── Pass 1: deterministic rules ─────────────────────────────────────────────
  for (const tx of unclassified.results) {
    const ruleMatch = applyRules(tx as Transaction, rules);
    if (ruleMatch) {
      const classId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO classifications
           (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes, review_required, classified_by)
         VALUES (?, ?, ?, ?, ?, 1.0, 'rule', ?, 0, 'system')`,
      ).bind(
        classId, tx.id, ruleMatch.entity, ruleMatch.category_tax, ruleMatch.category_budget,
        JSON.stringify([`rule:${ruleMatch.rule_name}`]),
      ).run();
      await resolveReviewQueueItem(env, tx.id, 'system');
      ruleHits++;
    } else {
      needsAI.push(tx);
    }
  }

  // ── Pass 2: AI classifier (with historical examples) ────────────────────────
  const batchItems = await Promise.all(
    needsAI.map(async tx => {
      const accountContext = buildAccountContext(tx);
      const historicalExamples = await loadHistoricalExamples(env, userId, tx as Transaction);
      const amazonContext = await loadAmazonContext(env, tx.id);

      return {
        transaction: tx as Transaction,
        accountContext,
        historicalExamples,
        amazonContext,
      };
    }),
  );

  await classifyBatch(env, batchItems, async (txId, result, error) => {
    const tx = needsAI.find(item => item.id === txId);
    if (!tx) return;

    if (!result) {
      aiErrors++;
      const reviewContext = buildReviewDetails(tx as Transaction, undefined, error ?? 'Unknown classifier error');
      await upsertReviewQueue(
        env,
        txId,
        userId,
        'no_match',
        null,
        null,
        null,
        reviewContext.details,
        reviewContext.needsInput,
      );
      return;
    }

    const classId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO classifications
         (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes, review_required, classified_by)
       VALUES (?, ?, ?, ?, ?, ?, 'ai', ?, ?, 'system')`,
    ).bind(
      classId, txId, result.entity ?? null, result.category_tax, result.category_budget ?? null,
      result.confidence, JSON.stringify(result.reason_codes), result.review_required ? 1 : 0,
    ).run();

    if (result.review_required) {
      const reviewContext = buildReviewDetails(tx as Transaction, result);
      await upsertReviewQueue(
        env, txId, userId,
        result.confidence < 0.7 ? 'low_confidence' : 'low_confidence',
        result.entity ?? null, result.category_tax, result.confidence,
        reviewContext.details, reviewContext.needsInput,
      );
      aiQueued++;
    } else {
      await resolveReviewQueueItem(env, txId, 'system');
    }
  });

  return jsonOk({
    total_processed: unclassified.results.length,
    classified_by_rules: ruleHits,
    classified_by_ai: needsAI.length - aiQueued - aiErrors,
    queued_for_review: aiQueued,
    ai_errors: aiErrors,
  });
}

// ── POST /classify/reapply-account-rules ─────────────────────────────────────
// Re-runs the full rules engine against every non-locked, non-manual
// classification for accounts that have an owner_tag set. Useful after
// assigning a business to an account for the first time.
export async function handleReapplyAccountRules(request: Request, env: Env): Promise<Response> {
  try {
    const userId = getUserId(request);

    const rulesResult = await env.DB.prepare(
      'SELECT * FROM rules WHERE user_id = ? AND is_active = 1 ORDER BY priority DESC',
    ).bind(userId).all<Rule>();
    const rules = rulesResult.results;

    // Transactions from tagged accounts where classification is not locked/manual.
    // account_owner_tag is included so we can fall back to the account entity when
    // no merchant/description rule matches — the expected behaviour after a direct
    // D1 owner_tag assignment that bypassed handleUpdateAccount (which would have
    // created the account_id rule automatically).
    const rows = await env.DB.prepare(
      `SELECT t.*, a.owner_tag AS account_owner_tag, c.id AS class_id, c.method, c.is_locked
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN classifications c ON c.transaction_id = t.id
       WHERE t.user_id = ?
         AND a.owner_tag IS NOT NULL
         AND t.is_pending = 0
         AND (c.id IS NULL OR (c.is_locked = 0 AND c.method != 'manual'))
       ORDER BY t.posted_date DESC`,
    ).bind(userId).all<Transaction & { account_owner_tag: string; class_id: string | null; method: string | null; is_locked: number | null }>();

    let reclassified = 0;
    let lastTxId = '(none)';
    let lastStep = 'query';

    for (const tx of rows.results) {
      lastTxId = tx.id;
      lastStep = 'applyRules';
      const ruleMatch = applyRules(tx as Transaction, rules);

      // Use the matched rule's entity, or fall back to the account's owner_tag so
      // that every transaction from a tagged account gets classified even when no
      // merchant/description rule matches.
      const entity = ruleMatch?.entity ?? tx.account_owner_tag;
      const categoryTax = ruleMatch?.category_tax ?? null;
      const categoryBudget = ruleMatch?.category_budget ?? null;
      const reasonCode = ruleMatch ? `rule:${ruleMatch.rule_name}` : `account_tag:${tx.account_owner_tag}`;

      const classId = tx.class_id ?? crypto.randomUUID();
      lastStep = `insert classifications (entity=${entity}, account_owner_tag=${tx.account_owner_tag})`;
      await env.DB.prepare(
        `INSERT OR REPLACE INTO classifications
           (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes, review_required, classified_by)
         VALUES (?, ?, ?, ?, ?, 1.0, 'rule', ?, 0, 'system')`,
      ).bind(
        classId, tx.id, entity, categoryTax, categoryBudget,
        JSON.stringify([reasonCode]),
      ).run();
      lastStep = 'resolveReviewQueueItem';
      await resolveReviewQueueItem(env, tx.id, 'system');
      reclassified++;
    }

    return jsonOk({
      total_eligible: rows.results.length,
      reclassified,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? '') : '';
    return jsonOk({ diagnostic_error: message, stack: stack.slice(0, 2000) });
  }
}

// ── POST /classify/transaction/:id ────────────────────────────────────────────
export async function handleClassifySingle(request: Request, env: Env, txId: string): Promise<Response> {
  const userId = getUserId(request);

  const tx = await env.DB.prepare(
    `SELECT t.*, a.name AS account_name, a.mask AS account_mask, a.type AS account_type, a.subtype AS account_subtype, a.owner_tag
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ? AND t.user_id = ?`,
  ).bind(txId, userId).first<Transaction & {
    account_name: string | null;
    account_mask: string | null;
    account_type: string | null;
    account_subtype: string | null;
    owner_tag: string | null;
  }>();

  if (!tx) return jsonError('Transaction not found', 404);

  const rulesResult = await env.DB.prepare(
    'SELECT * FROM rules WHERE user_id = ? AND is_active = 1 ORDER BY priority DESC',
  ).bind(userId).all<Rule>();

  const ruleMatch = applyRules(tx as Transaction, rulesResult.results);
  if (ruleMatch) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO classifications
         (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes, review_required, classified_by)
       VALUES (?, ?, ?, ?, ?, 1.0, 'rule', ?, 0, 'system')`,
    ).bind(
      crypto.randomUUID(), txId, ruleMatch.entity, ruleMatch.category_tax, ruleMatch.category_budget,
      JSON.stringify([`rule:${ruleMatch.rule_name}`]),
    ).run();
    return jsonOk({ method: 'rule', rule: ruleMatch.rule_name });
  }

  const { classifyTransaction } = await import('../lib/claude');
  const accountContext = buildAccountContext(tx);
  const historicalExamples = await loadHistoricalExamples(env, userId, tx as Transaction);
  const amazonContext = await loadAmazonContext(env, txId);

  const result = await classifyTransaction(
    env, tx as Transaction, accountContext,
    historicalExamples,
    amazonContext,
  );

  await env.DB.prepare(
    `INSERT OR REPLACE INTO classifications
       (id, transaction_id, entity, category_tax, category_budget, confidence, method, reason_codes, review_required, classified_by)
     VALUES (?, ?, ?, ?, ?, ?, 'ai', ?, ?, 'system')`,
  ).bind(
    crypto.randomUUID(), txId, result.entity ?? null, result.category_tax, result.category_budget ?? null,
    result.confidence, JSON.stringify(result.reason_codes), result.review_required ? 1 : 0,
  ).run();

  if (result.review_required) {
    const reviewContext = buildReviewDetails(tx as Transaction, result);
    await upsertReviewQueue(
      env,
      txId,
      userId,
      'low_confidence',
      result.entity ?? null,
      result.category_tax,
      result.confidence,
      reviewContext.details,
      reviewContext.needsInput,
    );
  } else {
    await resolveReviewQueueItem(env, txId, 'system');
  }

  return jsonOk({ method: 'ai', classification: result });
}
