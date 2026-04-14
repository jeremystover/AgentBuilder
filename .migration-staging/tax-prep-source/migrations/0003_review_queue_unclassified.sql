PRAGMA foreign_keys=off;

CREATE TABLE review_queue_new (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('low_confidence', 'no_match', 'conflict', 'flagged', 'unclassified')),
  suggested_entity TEXT,
  suggested_category_tax TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'skipped')),
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO review_queue_new (
  id, transaction_id, user_id, reason, suggested_entity, suggested_category_tax,
  confidence, status, resolved_at, resolved_by, created_at
)
SELECT
  id, transaction_id, user_id, reason, suggested_entity, suggested_category_tax,
  confidence, status, resolved_at, resolved_by, created_at
FROM review_queue;

DROP TABLE review_queue;
ALTER TABLE review_queue_new RENAME TO review_queue;

CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(user_id, status);

PRAGMA foreign_keys=on;
