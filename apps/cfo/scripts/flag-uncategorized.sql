-- Flag transactions with neither a budget nor a tax category as needing review.
-- Safe to re-run: the INSERT uses ON CONFLICT to upsert existing review_queue rows.
-- Skips locked classifications (is_locked = 1).

-- Step 1: mark classifications as needing human review
UPDATE classifications
SET review_required = 1
WHERE category_budget IS NULL
  AND category_tax IS NULL
  AND is_locked = 0;

-- Step 2: upsert a pending/unclassified entry in review_queue for each affected transaction
INSERT INTO review_queue (id, transaction_id, user_id, reason, status, details, created_at)
SELECT
  lower(hex(randomblob(16))),
  c.transaction_id,
  t.user_id,
  'unclassified',
  'pending',
  'No budget or tax category set',
  datetime('now')
FROM classifications c
JOIN transactions t ON t.id = c.transaction_id
WHERE c.category_budget IS NULL
  AND c.category_tax IS NULL
  AND c.is_locked = 0
ON CONFLICT(transaction_id) DO UPDATE SET
  status   = 'pending',
  reason   = 'unclassified',
  details  = 'No budget or tax category set',
  resolved_at  = NULL,
  resolved_by  = NULL;
