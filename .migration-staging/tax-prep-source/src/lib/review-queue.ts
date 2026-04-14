import type { Env } from '../types';

export async function upsertReviewQueue(
  env: Env,
  txId: string,
  userId: string,
  reason: string,
  entity: string | null,
  category: string | null,
  confidence: number | null,
  details: string | null = null,
  needsInput: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO review_queue (
       id, transaction_id, user_id, reason, suggested_entity, suggested_category_tax, confidence, details, needs_input
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       reason=excluded.reason, suggested_entity=excluded.suggested_entity,
       suggested_category_tax=excluded.suggested_category_tax, confidence=excluded.confidence,
       details=excluded.details, needs_input=excluded.needs_input,
       status='pending'`,
  ).bind(
    crypto.randomUUID(),
    txId,
    userId,
    reason,
    entity,
    category,
    confidence,
    details,
    needsInput,
  ).run();
}

export async function resolveReviewQueueItem(
  env: Env,
  txId: string,
  resolvedBy: string,
  status = 'resolved',
): Promise<void> {
  await env.DB.prepare(
    `UPDATE review_queue
     SET status = ?, resolved_by = ?, resolved_at = datetime('now')
     WHERE transaction_id = ? AND status = 'pending'`,
  ).bind(status, resolvedBy, txId).run();
}

export async function ensureUnclassifiedReviewQueue(
  env: Env,
  txId: string,
  userId: string,
): Promise<void> {
  const tx = await env.DB.prepare(
    `SELECT t.id
     FROM transactions t
     LEFT JOIN classifications c ON c.transaction_id = t.id
     WHERE t.id = ?
       AND t.user_id = ?
       AND t.is_pending = 0
       AND c.id IS NULL`,
  ).bind(txId, userId).first<{ id: string }>();

  if (!tx) return;

  await upsertReviewQueue(
    env,
    txId,
    userId,
    'unclassified',
    null,
    null,
    null,
    'No rule match or saved classification exists for this transaction yet.',
    'A clearer merchant name, notes, or a manual classification for a similar transaction would help future matches.',
  );
}

export async function backfillUnclassifiedReviewQueue(env: Env, userId: string): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT t.id
     FROM transactions t
     LEFT JOIN classifications c ON c.transaction_id = t.id
     LEFT JOIN review_queue rq ON rq.transaction_id = t.id
     WHERE t.user_id = ?
       AND t.is_pending = 0
       AND c.id IS NULL
       AND rq.id IS NULL`,
  ).bind(userId).all<{ id: string }>();

  for (const row of rows.results) {
    await upsertReviewQueue(
      env,
      row.id,
      userId,
      'unclassified',
      null,
      null,
      null,
      'No rule match or saved classification exists for this transaction yet.',
      'A clearer merchant name, notes, or a manual classification for a similar transaction would help future matches.',
    );
  }
}
